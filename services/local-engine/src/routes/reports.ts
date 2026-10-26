import { z } from "zod";
import type { Engine } from "../app.ts";
import { HttpError } from "../http/router.ts";
import type { Router } from "../http/router.ts";

/**
 * Metric catalogue: every statistic declares its definition, source and minimum data requirement.
 * Metrics the current source cannot compute reliably are reported as unavailable, never estimated.
 */
export const METRICS = [
  { key: "kills", label: "Kills", definition: "Cumulative kills reported by the source.", requires: "player match stats", gsi: true },
  { key: "deaths", label: "Deaths", definition: "Cumulative deaths reported by the source.", requires: "player match stats", gsi: true },
  { key: "assists", label: "Assists", definition: "Cumulative assists reported by the source.", requires: "player match stats", gsi: true },
  { key: "mvps", label: "MVPs", definition: "Round MVP count reported by the source.", requires: "player match stats", gsi: true },
  { key: "score", label: "Score", definition: "In-game scoreboard score.", requires: "player match stats", gsi: true },
  { key: "adr", label: "ADR", definition: "Average damage per round from validated per-hit damage.", requires: "exact damage events (authorized server events or parsed demo)", gsi: false },
  { key: "kast", label: "KAST", definition: "Rounds with kill, assist, survival or traded death.", requires: "ordered exact kill events with trade timing", gsi: false },
  { key: "utility_damage", label: "Utility damage", definition: "Damage dealt by grenades, attributed by exact events.", requires: "exact damage events with weapon", gsi: false },
  { key: "opening_duels", label: "Opening duels", definition: "First kill/death of each round.", requires: "ordered exact kill events", gsi: false },
] as const;

interface ShotSpan {
  shot: string | null;
  fromMs: number;
  toMs: number | null;
}

export function registerReportRoutes(r: Router, e: Engine): void {
  r.get("/api/v1/stats/current", { permission: "state.read" }, () => {
    const s = e.session.state();
    const caps = e.session.capabilities();
    const exactKills = caps.exactKillEvents.support === "supported";
    const exactDamage = caps.exactDamageEvents.support === "supported";
    const available = (m: (typeof METRICS)[number]) => m.gsi || (m.key === "adr" || m.key === "utility_damage" ? exactDamage : exactKills);
    return {
      simulated: s?.simulated ?? false,
      map: s?.mapName ?? null,
      round: s?.roundNumber ?? null,
      metrics: METRICS.map((m) => ({ ...m, available: available(m), reason: available(m) ? null : `requires ${m.requires}` })),
      players: (s?.players ?? []).map((p) => ({
        steamId: p.steamId,
        name: p.name,
        side: p.side,
        teamId: p.teamId,
        kills: p.matchStats.kills,
        deaths: p.matchStats.deaths,
        assists: p.matchStats.assists,
        mvps: p.matchStats.mvps,
        score: p.matchStats.score,
        adr: null,
        kast: null,
      })),
      corrections: e.corrections.list().map((c) => c.data),
    };
  });

  r.get("/api/v1/stats/current.csv", { permission: "state.read" }, () => {
    const s = e.session.state();
    const esc = (v: unknown) => {
      const t = v === null || v === undefined ? "" : String(v);
      return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
    };
    const rows = [["steamId", "name", "side", "kills", "deaths", "assists", "mvps", "score"].join(",")];
    for (const p of s?.players ?? []) rows.push([p.steamId, p.name, p.side, p.matchStats.kills, p.matchStats.deaths, p.matchStats.assists, p.matchStats.mvps, p.matchStats.score].map(esc).join(","));
    return { body: rows.join("\n") + "\n", contentType: "text/csv; charset=utf-8", headers: { "content-disposition": `attachment; filename="matchframe-stats-${Date.now()}.csv"` } };
  });

  /** Broadcast report: director decisions, coverage/continuity, control, replays and sponsors. */
  r.get("/api/v1/reports/broadcast", { permission: "state.read" }, (req) => {
    const decisions = e.session.decisionLog;
    const events = e.session.recentEvents(2000);
    const arbiter = e.session.arbiter.log;
    const now = e.now();
    // Shot timeline from confirmed observer feedback.
    const spans: ShotSpan[] = [];
    for (const ev of events) {
      if (ev.kind !== "observer_changed") continue;
      const last = spans[spans.length - 1];
      if (last && last.toMs === null) last.toMs = ev.receivedAtMonotonicMs;
      spans.push({ shot: (ev.data.to as string | null) ?? null, fromMs: ev.receivedAtMonotonicMs, toMs: null });
    }
    const durations = spans.map((sp) => (sp.toMs ?? now) - sp.fromMs).filter((d) => d > 0).sort((a, b) => a - b);
    const minutes = decisions.length > 1 ? (decisions[decisions.length - 1]!.decidedAtMonotonicMs - decisions[0]!.decidedAtMonotonicMs) / 60000 : 0;
    const deaths = events.filter((ev) => ev.kind === "player_died");
    const onDeadPov = spans.filter((sp) => sp.shot && deaths.some((d) => d.data.steamId === sp.shot && d.receivedAtMonotonicMs < (sp.toMs ?? now) && d.receivedAtMonotonicMs > sp.fromMs)).length;
    const directorCmds = arbiter.filter((a) => a.kind === "command" && a.detail.owner === "director");
    const ids = new Set(directorCmds.map((a) => a.detail.commandId));
    const confirmed = arbiter.filter((a) => a.kind === "result" && a.detail.status === "confirmed" && ids.has(a.detail.commandId)).length;
    const failed = arbiter.filter((a) => a.kind === "result" && a.detail.status === "failed" && ids.has(a.detail.commandId)).length;
    const reasonCounts: Record<string, number> = {};
    for (const d of decisions) for (const rc of d.reasonCodes) reasonCounts[rc] = (reasonCounts[rc] ?? 0) + 1;
    const sponsorRows = e.db.all<{ sponsor_id: string; n: number; ms: number | null }>("SELECT sponsor_id, COUNT(*) AS n, SUM(duration_ms) AS ms FROM sponsor_deliveries WHERE acknowledged = 1 GROUP BY sponsor_id");
    const report = {
      generatedAt: new Date().toISOString(),
      simulated: e.simulationRunning,
      sessionId: e.session.sessionId,
      policyVersion: e.session.director.config.policyVersion,
      window: { decisions: decisions.length, minutes: Math.round(minutes * 100) / 100, note: "Bounded in-memory window (last 1,000 decisions / 2,000 events) for the current session." },
      director: {
        modeNow: e.session.director.currentMode,
        actions: decisions.reduce<Record<string, number>>((acc, d) => ((acc[d.action] = (acc[d.action] ?? 0) + 1), acc), {}),
        topReasons: Object.entries(reasonCounts)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 15),
        automatedCommands: directorCmds.length,
        automatedConfirmed: confirmed,
        automatedFailed: failed,
      },
      continuity: {
        shotChanges: spans.length,
        cutsPerMinute: minutes > 0 ? Math.round((spans.length / minutes) * 100) / 100 : null,
        medianShotMs: durations.length ? durations[Math.floor(durations.length / 2)] : null,
        p10ShotMs: durations.length ? durations[Math.floor(durations.length * 0.1)] : null,
        shotsThatOutlivedTheirPlayer: onDeadPov,
      },
      control: {
        manualTakeovers: arbiter.filter((a) => a.kind === "takeover").length,
        externalChanges: arbiter.filter((a) => a.kind === "external_change").length,
        emergencyStops: arbiter.filter((a) => a.kind === "emergency_stop").length,
      },
      program: { transitions: e.program.history.length, history: e.program.history.slice(-30) },
      replays: { items: e.replays.list().map((i) => ({ id: i.id, label: i.label, state: i.state, round: i.roundNumber })) },
      sponsors: sponsorRows.map((r2) => ({ sponsorId: r2.sponsor_id, name: e.sponsors.get(r2.sponsor_id)?.data.name ?? r2.sponsor_id, displays: r2.n, acknowledgedMs: r2.ms })),
      caveats: [
        "Important-action coverage needs labelled eligible events; it is computed offline by the evaluation workers, not from live logs.",
        ...(e.simulationRunning ? ["SIMULATION: synthetic data; not evidence of real broadcast quality."] : []),
      ],
    };
    if (req.query.get("format") === "html") {
      const rows = (o: Record<string, unknown>) => Object.entries(o).map(([k, v]) => `<tr><th>${k}</th><td>${typeof v === "object" ? `<pre>${JSON.stringify(v, null, 1)}</pre>` : String(v)}</td></tr>`).join("");
      const html = `<!doctype html><meta charset="utf-8"><title>Matchframe broadcast report</title><style>body{font:14px system-ui;background:#11141b;color:#e8ecf3;padding:24px}table{border-collapse:collapse;margin-bottom:18px}th,td{border:1px solid #2a3140;padding:6px 10px;text-align:left;vertical-align:top}th{color:#9aa4b5}pre{margin:0;white-space:pre-wrap}</style><h1>Broadcast report</h1><table>${rows(report as unknown as Record<string, unknown>)}</table>`;
      return { body: html, contentType: "text/html; charset=utf-8" };
    }
    return report;
  });

  // ---- player camera routing (stable player identity → mixer source) ---------------------
  const PlayerCamConfig = z.object({
    enabled: z.boolean().default(false),
    scene: z.string().nullable().default(null),
    sources: z.record(z.string(), z.string()).default({}),
    fallbackSource: z.string().nullable().default(null),
    delayMs: z.number().int().min(0).max(60000).default(0),
  });
  r.get("/api/v1/player-cams/config", { permission: "metadata.read" }, () => ({ config: PlayerCamConfig.parse(e.settings.get("playerCams", {})), status: e.playerCamStatus() }));
  r.put("/api/v1/player-cams/config", { permission: "program.control", body: PlayerCamConfig }, (req) => {
    for (const playerId of Object.keys(req.body.sources)) {
      const p = e.players.get(playerId);
      if (!p) throw new HttpError(400, `unknown player ${playerId}`, "bad_player");
      if (!p.data.cameraConsent) throw new HttpError(400, `${p.data.displayName} has not consented to camera use`, "no_consent");
    }
    e.settings.set("playerCams", req.body);
    e.audit.record(req.principal!.label, "player_cams.config", null, req.body);
    return { config: req.body };
  });
}
