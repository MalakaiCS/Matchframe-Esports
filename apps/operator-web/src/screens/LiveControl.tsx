import { useEffect, useMemo, useRef, useState } from "react";
import type { CommandResult, DirectorMode, PlayerState, Side } from "@matchframe/contracts";
import { api, describeError, seg } from "../api/index.ts";
import type { ActionClass, DirectorStatus, EventRecord, MapPackDetail, MatchRow, OperatorSnapshot, ReplaysResponse, TeamRow } from "../api/types.ts";
import { CandidateList, DecisionExplain, OpportunityList } from "../components/director.tsx";
import { useToast } from "../components/toasts.tsx";
import { ActionButton, Badge, Button, Checkbox, EmptyState, KV, Note, Panel } from "../components/ui.tsx";
import { capabilityGate } from "../lib/capabilities.ts";
import { phaseRemaining } from "../lib/clock.ts";
import { ASSISTED_ACTIONS, DIRECTOR_MODES, MODE_INFO } from "../lib/director.ts";
import { fmtClock, fmtMs, MISSING, shotLabel, shotTarget, titleCase } from "../lib/format.ts";
import { isTypingTarget, useApi } from "../lib/hooks.ts";
import { CONTROL_HEALTH_TEXT } from "../lib/ownership.ts";
import { makeNameOf, playersBySide, slotFromKey } from "../lib/players.ts";
import { Link } from "../router.tsx";
import { liveStore, useEngineNow, useLive, useNow, useSnapshot } from "../state/live.ts";
import { usePermission } from "../state/session.tsx";
import { emergencyStop } from "../components/TopBar.tsx";
import type { PovRole } from "./live/RosterCard.tsx";
import { RosterCard } from "./live/RosterCard.tsx";
import { Timeline } from "./live/Timeline.tsx";

const PHASE_LABEL: Record<string, string> = {
  warmup: "Warmup",
  freezetime: "Freeze time",
  live: "Round live",
  bomb: "Bomb planted",
  defuse: "Defusing",
  over: "Round over",
  timeout_t: "T timeout",
  timeout_ct: "CT timeout",
  paused: "Paused",
  halftime: "Halftime",
  gameover: "Game over",
  unknown: "Phase unknown",
};

function describeCommandResult(r: CommandResult | null | undefined, who: string): { tone: "ok" | "info" | "danger"; text: string } {
  if (!r) return { tone: "info", text: `No command was issued for ${who} (no valid POV candidate).` };
  const precision = r.precision.replace(/_/g, " ");
  if (r.status === "confirmed") return { tone: "ok", text: `POV ${who}: confirmed (${precision}).` };
  if (r.status === "failed" || r.status === "cancelled") return { tone: "danger", text: `POV ${who}: ${r.status}${r.failureReason ? ` — ${r.failureReason.replace(/_/g, " ")}` : ""}${r.detail ? ` (${r.detail})` : ""}.` };
  return { tone: "info", text: `POV ${who}: ${r.status.replace(/_/g, " ")} (${precision}) — waiting for observed confirmation.` };
}

function useActiveMatch() {
  const active = useApi<{ key: string; value: string | null }>("/api/v1/settings/live.activeMatchId", { refreshMs: 15000 });
  const matchId = active.data?.value ?? null;
  const match = useApi<MatchRow>(matchId ? `/api/v1/matches/${seg(matchId)}` : null, { refreshMs: 15000 });
  const teams = useApi<TeamRow[]>(matchId ? "/api/v1/teams" : null);
  const events = useApi<EventRecord[]>(match.data?.eventId ? "/api/v1/events" : null);
  const team = (id: string | undefined) => teams.data?.find((t) => t.id === id) ?? null;
  return {
    error: active.error,
    match: match.data ?? null,
    teamA: team(match.data?.teamAId),
    teamB: team(match.data?.teamBId),
    event: events.data?.find((e) => e.id === match.data?.eventId) ?? null,
  };
}

function MatchHeader({ snap }: { snap: OperatorSnapshot }) {
  const s = snap.state!;
  const engineNow = useEngineNow(250);
  const am = useActiveMatch();
  const running = !s.paused && s.gamePhase !== "paused" && s.gamePhase !== "timeout_ct" && s.gamePhase !== "timeout_t" && s.gamePhase !== "gameover";
  const remaining = phaseRemaining(s.phaseEndsInSec, s.phaseObservedAtMonotonicMs, engineNow, running);
  const nameOf = makeNameOf(s);
  return (
    <div className="match-header">
      <div className="mh-block">
        <span className="mh-label">Event / match</span>
        <span className="mh-value">
          {am.event?.name ?? <span className="muted">No event</span>} ·{" "}
          {am.match ? (
            `${am.teamA?.name ?? "Team A"} vs ${am.teamB?.name ?? "Team B"}`
          ) : (
            <Link to="/matches" title="Activate a match so HUDs show team names, logos and series">
              No active match — activate one
            </Link>
          )}
        </span>
      </div>
      <div className="mh-block">
        <span className="mh-label">Map</span>
        <span className="mh-value">
          {s.mapName ?? MISSING} {s.mapName === "de_synthetic" ? <Badge tone="sim">SYNTHETIC</Badge> : null}
        </span>
      </div>
      <div className="mh-block">
        <span className="mh-label">Series</span>
        <span className="mh-value">{am.match ? `${am.match.seriesScoreA} – ${am.match.seriesScoreB} (BO${am.match.format.bestOf})` : MISSING}</span>
      </div>
      <div className="mh-block mh-score">
        <span className="mh-label">Score</span>
        <span className="mh-value">
          <span className="side-ct">CT {s.teams.CT.name ?? ""}</span> <strong>{s.teams.CT.score ?? MISSING}</strong> – <strong>{s.teams.T.score ?? MISSING}</strong> <span className="side-t">{s.teams.T.name ?? ""} T</span>
        </span>
      </div>
      <div className="mh-block">
        <span className="mh-label">Round</span>
        <span className="mh-value">{s.roundNumber ?? MISSING}</span>
      </div>
      <div className="mh-block">
        <span className="mh-label">Phase</span>
        <span className="mh-value">
          {PHASE_LABEL[s.gamePhase] ?? s.gamePhase} <span className="mh-clock">{fmtClock(remaining)}</span>
          {s.paused ? <Badge tone="warn">PAUSED</Badge> : null}
          {s.bomb && (s.bomb.state === "planted" || s.bomb.state === "defusing") ? <Badge tone="danger">BOMB {s.bomb.state.toUpperCase()}{s.bomb.site ? ` ${s.bomb.site}` : ""}</Badge> : null}
        </span>
      </div>
      <div className="mh-block">
        <span className="mh-label">Observer</span>
        <span className="mh-value">
          {s.observer.observedSteamId ? nameOf(s.observer.observedSteamId) : "none"} <span className="muted">({s.observer.cameraMode.replace("_", " ")})</span>
        </span>
      </div>
    </div>
  );
}

function PovStatus({ snap }: { snap: OperatorSnapshot }) {
  const s = snap.state!;
  const nameOf = makeNameOf(s);
  const arbiterLog = useLive((st) => st.arbiterLog);
  const lastResult = [...arbiterLog].reverse().find((e) => e.kind === "result" || e.kind === "rejected" || e.kind === "external_change");
  const p = snap.pending;
  const pendingTarget = p ? (p.request.kind === "select_player" ? `POV · ${nameOf(p.request.steamId)}` : p.request.kind === "activate_static_camera" ? `Camera · ${p.request.camera.displayName}` : p.request.kind.replace(/_/g, " ")) : null;
  return (
    <div className="pov-grid">
      <div className="pov-cell pov-confirmed">
        <span className="pov-label">CONFIRMED on observer</span>
        <span className="pov-value">{shotLabel(snap.currentShot, nameOf)}</span>
        <span className="pov-meta">source feedback ({s.observer.evidence}) · {s.observer.cameraMode.replace("_", " ")}</span>
      </div>
      <div className={`pov-cell pov-pending ${p ? "is-active" : ""}`}>
        <span className="pov-label">PENDING command</span>
        <span className="pov-value">{pendingTarget ?? "none"}</span>
        <span className="pov-meta">{p ? `${p.status.replace(/_/g, " ")} · owner ${p.context.owner}${p.retries ? ` · retry ${p.retries}` : ""}` : "nothing in flight"}</span>
      </div>
      <div className="pov-cell pov-desired">
        <span className="pov-label">DIRECTOR wants</span>
        <span className="pov-value">{shotLabel(snap.director?.desiredShot, nameOf)}</span>
        <span className="pov-meta">{snap.director ? `${snap.director.action.toUpperCase()} · ${snap.director.mode}` : "no decision"}</span>
      </div>
      <div className="pov-last small">
        Last arbiter event:{" "}
        {lastResult ? (
          <>
            <strong>{lastResult.kind.replace(/_/g, " ")}</strong> {String(lastResult.detail.status ?? lastResult.detail.reason ?? "")} {lastResult.detail.failureReason ? `— ${String(lastResult.detail.failureReason).replace(/_/g, " ")}` : ""}
          </>
        ) : (
          <span className="muted">none since this console connected</span>
        )}
      </div>
    </div>
  );
}

function ActionsBar({ snap, cameras }: { snap: OperatorSnapshot; cameras: { id: string; displayName: string; validation: string }[] }) {
  const s = snap.state!;
  const toast = useToast();
  const engineNow = useEngineNow(500);
  const directorReason = usePermission("director.control");
  const cameraReason = usePermission("camera.control");
  const programReason = usePermission("program.control");
  const [holdMs, setHoldMs] = useState<string>("10000");
  const [pinTarget, setPinTarget] = useState<string>("");
  const [cinematicCam, setCinematicCam] = useState<string>("");
  const gate = capabilityGate("staticCameraControl", snap.capabilities.staticCameraControl, { simulated: snap.simulated });
  const hold = snap.controls.hold;
  const holdLeft = hold && hold.until !== null && engineNow !== null ? Math.max(0, hold.until - engineNow) : null;
  const pin = snap.controls.pin;
  const nameOf = makeNameOf(s);
  const pinText = !pin ? null : pin.kind === "player" ? `player ${nameOf(pin.steamId)}` : pin.kind === "side" ? `side ${pin.side}` : pin.kind === "team" ? `team ${pin.teamId}` : `${pin.steamIds.length} players`;

  const returnLive = async () => {
    const out: string[] = [];
    if (snap.program.mode !== "LIVE") {
      const t = await api.post<{ to: string; confirmed: boolean; detail: string | null }>("/api/v1/program/return-live");
      out.push(`Program → ${t.to}${t.confirmed ? "" : " (mixer not confirmed)"}${t.detail ? `: ${t.detail}` : ""}`);
    }
    const shot = shotTarget(snap.currentShot);
    if (!shot || shot.kind !== "pov") {
      const r = await api.post<CommandResult | null>("/api/v1/observer/commands", { kind: "return_to_pov" });
      out.push(describeCommandResult(r, "best player").text);
    }
    return out.length ? out.join(" · ") : "Already live: program is LIVE and the observer is on a POV.";
  };

  return (
    <div className="actions-bar">
      <div className="action-group">
        <span className="action-group-label">Hold</span>
        {hold ? (
          <ActionButton variant="warn" action={() => api.post("/api/v1/director/release-hold")} success="Hold released" disabledReason={directorReason}>
            RELEASE HOLD {holdLeft !== null ? `(${fmtMs(holdLeft)})` : "(until released)"}
          </ActionButton>
        ) : (
          <>
            <select aria-label="Hold duration" value={holdMs} onChange={(e) => setHoldMs(e.target.value)}>
              <option value="5000">5 s</option>
              <option value="10000">10 s</option>
              <option value="30000">30 s</option>
              <option value="60000">60 s</option>
              <option value="">until released</option>
            </select>
            <ActionButton variant="primary" action={() => api.post("/api/v1/director/hold", { durationMs: holdMs ? Number(holdMs) : null })} success={`Holding ${holdMs ? `${Number(holdMs) / 1000} s` : "until released"}`} disabledReason={directorReason}>
              HOLD
            </ActionButton>
          </>
        )}
      </div>
      <div className="action-group">
        <span className="action-group-label">Pin</span>
        <select aria-label="Pin target" value={pinTarget} onChange={(e) => setPinTarget(e.target.value)}>
          <option value="">choose…</option>
          <optgroup label="Players">
            {s.players.map((p) => (
              <option key={p.steamId} value={`player:${p.steamId}`}>
                {p.name} ({p.side ?? "?"})
              </option>
            ))}
          </optgroup>
          <optgroup label="Sides">
            <option value="side:CT">CT side</option>
            <option value="side:T">T side</option>
          </optgroup>
        </select>
        <ActionButton
          action={() => {
            const [kind, val] = pinTarget.split(":");
            return api.post("/api/v1/director/pin", kind === "player" ? { kind: "player", steamId: val } : { kind: "side", side: val });
          }}
          success="Pin set"
          disabledReason={directorReason ?? (pinTarget ? null : "Choose a player or side to pin")}
        >
          PIN
        </ActionButton>
        {pin ? (
          <ActionButton size="sm" action={() => api.post("/api/v1/director/pin", { kind: "none" })} success="Pin cleared" disabledReason={directorReason}>
            Unpin {pinText}
          </ActionButton>
        ) : null}
      </div>
      <div className="action-group">
        <ActionButton
          variant="primary"
          action={() => api.post<{ decision: { action: string; desiredShot: string | null } | null }>("/api/v1/director/follow-action")}
          success={(r) => (r.decision ? `Follow action: ${r.decision.action} → ${shotLabel(r.decision.desiredShot, nameOf)}` : "Follow action requested")}
          disabledReason={directorReason}
        >
          FOLLOW ACTION
        </ActionButton>
      </div>
      <div className="action-group">
        <select aria-label="Cinematic camera" value={cinematicCam} onChange={(e) => setCinematicCam(e.target.value)} disabled={!gate.enabled}>
          <option value="">director picks camera</option>
          {cameras.map((c) => (
            <option key={c.id} value={c.id}>
              {c.displayName} ({c.validation})
            </option>
          ))}
        </select>
        <ActionButton action={() => api.post("/api/v1/director/request-cinematic", cinematicCam ? { cameraId: cinematicCam } : {})} success="Cinematic requested" disabledReason={directorReason ?? (gate.enabled ? null : gate.reason)}>
          REQUEST CINEMATIC
        </ActionButton>
      </div>
      <div className="action-group">
        <ActionButton variant="primary" action={returnLive} success={(m) => m} disabledReason={programReason ?? cameraReason}>
          RETURN LIVE
        </ActionButton>
      </div>
      <div className="action-group">
        <Button
          variant="danger"
          disabledReason={cameraReason}
          onClick={() =>
            emergencyStop()
              .then(() => toast.push("ok", "STOP AUTOMATION: emergency stop engaged"))
              .catch((e) => toast.push("danger", "STOP AUTOMATION failed", describeError(e)))
          }
        >
          STOP AUTOMATION
        </Button>
      </div>
      {gate.enabled && gate.reason ? <p className="small text-muted actions-note">{gate.reason}</p> : null}
    </div>
  );
}

function DirectorPanel({ snap, threshold }: { snap: OperatorSnapshot; threshold: number | null }) {
  const d = snap.director;
  const now = useNow(500);
  const sequenceChangedAt = useLive((s) => s.sequenceChangedAt);
  const directorReason = usePermission("director.control");
  const [busyMode, setBusyMode] = useState<DirectorMode | null>(null);
  const toast = useToast();
  const nameOf = makeNameOf(snap.state);
  const health = d ? CONTROL_HEALTH_TEXT[d.controlHealth] : null;
  const ageEst = snap.state ? liveStore.clock.ageOf(snap.state.time.receivedAtMonotonicMs, now) : null;
  const inputAge = d && typeof d.supportingFeatures.dataAgeMs === "number" ? d.supportingFeatures.dataAgeMs : null;
  const stale = snap.state?.sources[0]?.stale ?? false;
  const setMode = async (m: DirectorMode) => {
    setBusyMode(m);
    try {
      await api.post("/api/v1/director/mode", { mode: m });
      toast.push("ok", `Director mode: ${MODE_INFO[m].label}`, m === "automatic" && snap.ownership.manualSticky ? "Automatic mode still needs camera ownership: use Resume automation in the top bar." : undefined);
    } catch (e) {
      toast.push("danger", "Mode change failed", describeError(e));
    } finally {
      setBusyMode(null);
    }
  };
  return (
    <div className="director-panel">
      <div className="mode-select" role="radiogroup" aria-label="Director mode">
        {DIRECTOR_MODES.map((m) => (
          <button
            key={m}
            role="radio"
            aria-checked={snap.mode === m}
            className={`mode-btn ${snap.mode === m ? "is-on" : ""}`}
            title={MODE_INFO[m].hint}
            disabled={directorReason !== null || busyMode !== null}
            onClick={() => void setMode(m)}
          >
            {MODE_INFO[m].label}
          </button>
        ))}
      </div>
      <p className="small muted">
        {MODE_INFO[snap.mode].hint}
        {directorReason ? ` (${directorReason})` : ""}
      </p>
      <KV
        items={[
          ["Control health", health ? <Badge tone={health.tone} title={health.hint}>{health.text}</Badge> : <span className="muted">no decision yet</span>],
          [
            "Input freshness",
            <span key="f">
              {stale ? (
                <Badge tone="danger" icon="!">
                  STALE
                </Badge>
              ) : (
                <Badge tone="ok">FRESH</Badge>
              )}{" "}
              decision input {fmtMs(inputAge)} · data age ≈ {fmtMs(ageEst)} · last packet seen {sequenceChangedAt ? fmtMs(Math.max(0, now - sequenceChangedAt)) : MISSING} ago
            </span>,
          ],
          ["Policy / model", d ? `${d.policyVersion} · ${d.modelVersion ?? "no learned model (baseline policy)"}` : MISSING],
        ]}
      />
      <DecisionExplain decision={d} nameOf={nameOf} threshold={threshold} />
    </div>
  );
}

function DirectorControls({ snap }: { snap: OperatorSnapshot }) {
  const reason = usePermission("director.control");
  const c = snap.controls;
  const toast = useToast();
  const call = async (path: string, body: unknown, ok: string) => {
    try {
      await api.post(path, body);
      toast.push("ok", ok);
    } catch (e) {
      toast.push("danger", "Director control failed", describeError(e));
    }
  };
  const assisted = new Set<ActionClass>(c.assistedActions);
  const staticGate = capabilityGate("staticCameraControl", snap.capabilities.staticCameraControl, { simulated: snap.simulated });
  return (
    <div className="dir-controls">
      <fieldset>
        <legend>Disable cinematics</legend>
        <Checkbox checked={c.cinematicsDisabled.round !== null} disabled={!!reason} onChange={(v) => void call("/api/v1/director/cinematics", { scope: "round", disabled: v }, v ? "Cinematics disabled for this round" : "Cinematics re-enabled for this round")} label="This round" />
        <Checkbox checked={c.cinematicsDisabled.map !== null} disabled={!!reason} onChange={(v) => void call("/api/v1/director/cinematics", { scope: "map", disabled: v }, v ? "Cinematics disabled for this map" : "Cinematics re-enabled for this map")} label="This map" />
        <Checkbox checked={c.cinematicsDisabled.match} disabled={!!reason} onChange={(v) => void call("/api/v1/director/cinematics", { scope: "match", disabled: v }, v ? "Cinematics disabled for the match" : "Cinematics re-enabled for the match")} label="Whole match" />
      </fieldset>
      <fieldset>
        <legend>One-side profile</legend>
        <div className="seg" role="radiogroup" aria-label="One-side profile">
          {([null, "CT", "T"] as (Side | null)[]).map((sd) => (
            <button key={String(sd)} role="radio" aria-checked={c.oneSide === sd} className={`seg-btn ${c.oneSide === sd ? "is-on" : ""}`} disabled={!!reason} onClick={() => void call("/api/v1/director/one-side", { side: sd }, sd ? `Following ${sd} side only` : "One-side profile off")}>
              {sd ?? "Both sides"}
            </button>
          ))}
        </div>
        <span className="small muted">Restrict POV choices to one side (e.g. a team-specific stream).</span>
      </fieldset>
      <fieldset>
        <legend>Assisted mode executes</legend>
        {ASSISTED_ACTIONS.map((a) => (
          <Checkbox
            key={a.id}
            checked={assisted.has(a.id)}
            disabled={!!reason}
            hint={a.hint}
            onChange={(v) => {
              const next = new Set(assisted);
              if (v) next.add(a.id);
              else next.delete(a.id);
              void call("/api/v1/director/assisted-actions", { actions: [...next] }, `Assisted actions: ${[...next].join(", ") || "none"}`);
            }}
            label={
              <>
                {a.label}
                {a.id === "cinematic" && !staticGate.enabled ? <span className="small text-warn"> — {staticGate.reason}</span> : null}
              </>
            }
          />
        ))}
        {snap.mode !== "assisted" ? <span className="small muted">Only used in Assisted mode (current: {MODE_INFO[snap.mode].label}).</span> : null}
      </fieldset>
      <fieldset>
        <legend>Replays</legend>
        <Checkbox checked={c.autoReplaysDisabled} disabled={!!reason} onChange={(v) => void call("/api/v1/director/auto-replays", { disabled: v }, v ? "Automatic replay suggestions disabled" : "Automatic replay suggestions enabled")} label="Disable automatic replay suggestions" />
      </fieldset>
      {reason ? <p className="small text-warn">{reason}</p> : null}
    </div>
  );
}

function ProductionPanel({ snap }: { snap: OperatorSnapshot }) {
  const replays = useApi<ReplaysResponse>("/api/v1/replays", { refreshMs: 5000 });
  const prov = replays.data?.provider ?? null;
  const approved = replays.data?.items.filter((i) => i.state === "approved").length ?? 0;
  const src = snap.state?.sources ?? [];
  return (
    <div className="production">
      <KV
        items={[
          ["Program", <span key="p">{snap.program.mode.replace("_", " ")} <span className="muted">(owner {snap.program.owner.kind})</span></span>],
          ["OBS program / preview", snap.obs.connected ? `${snap.obs.programScene ?? MISSING} / ${snap.obs.previewScene ?? MISSING}${snap.obs.studioMode ? " (studio mode)" : ""}` : <Link key="o" to="/devices">OBS not connected — connect in Devices</Link>],
          [
            "Replay readiness",
            prov ? (
              <span key="r">
                {prov.health.ok ? <Badge tone="ok">READY</Badge> : <Badge tone="warn">NOT READY</Badge>} {prov.health.detail} · {approved} approved clip(s)
              </span>
            ) : replays.data ? (
              <Link key="r" to="/replays">No replay provider configured</Link>
            ) : (
              MISSING
            ),
          ],
          ["Outputs", `REC ${snap.obs.recording === null ? "?" : snap.obs.recording ? "ON" : "off"} · STREAM ${snap.obs.streaming === null ? "?" : snap.obs.streaming ? "ON" : "off"} · REPLAY BUFFER ${snap.obs.replayBuffer === null ? "?" : snap.obs.replayBuffer ? "ON" : "off"}`],
        ]}
      />
      <table className="table table-compact">
        <thead>
          <tr>
            <th>Source</th>
            <th>Health</th>
            <th>Packets</th>
            <th>Rejected</th>
            <th>Gaps</th>
            <th>Interval</th>
            <th>Build</th>
          </tr>
        </thead>
        <tbody>
          {src.length === 0 ? (
            <tr>
              <td colSpan={7} className="muted">
                No telemetry source yet.
              </td>
            </tr>
          ) : (
            src.map((x) => (
              <tr key={x.sourceId}>
                <td>{x.sourceId}</td>
                <td>{x.stale ? <Badge tone="danger">STALE</Badge> : x.connected ? <Badge tone="ok">OK</Badge> : <Badge tone="warn">DISCONNECTED</Badge>}</td>
                <td>{x.packetsReceived}</td>
                <td>{x.packetsRejected}</td>
                <td>{x.sequenceGaps}</td>
                <td>{fmtMs(x.meanIntervalMs)}</td>
                <td>{x.gameBuild ?? MISSING}</td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

export function LiveControlScreen() {
  const snap = useSnapshot();
  const toast = useToast();
  const cameraReason = usePermission("camera.control");
  const [busy, setBusy] = useState<string | null>(null);
  const status = useApi<DirectorStatus>("/api/v1/director/status", { refreshMs: 30000 });
  const mapName = snap?.state?.mapName ?? null;
  const mapPack = useApi<MapPackDetail>(mapName ? `/api/v1/maps/${seg(mapName)}` : null, { refreshMs: 30000 });
  const threshold = typeof status.data?.config.advantageThreshold === "number" ? status.data.config.advantageThreshold : null;
  const nameOf = useMemo(() => makeNameOf(snap?.state), [snap?.state]);

  const request = async (p: PlayerState) => {
    setBusy(p.steamId);
    try {
      const r = await api.post<CommandResult>("/api/v1/observer/commands", { kind: "select_player", steamId: p.steamId });
      const d = describeCommandResult(r, p.name);
      toast.push(d.tone === "danger" ? "danger" : d.tone === "ok" ? "ok" : "info", d.text);
    } catch (e) {
      toast.push("danger", `POV request for ${p.name} failed`, describeError(e));
    } finally {
      setBusy(null);
    }
  };

  const requestRef = useRef(request);
  requestRef.current = request;

  const selGate = snap ? capabilityGate("playerSelectionControl", snap.capabilities.playerSelectionControl, { simulated: snap.simulated }) : null;
  const cardReason = cameraReason ?? (selGate && !selGate.enabled ? selGate.reason : null);

  // Observer number keys (GSI observer slots) request a POV, like the in-game spectator keys.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || isTypingTarget(e.target)) return;
      const slot = slotFromKey(e.key);
      if (slot === null) return;
      const st = liveStore.state.snapshot?.state;
      const p = st?.players.find((x) => x.observerSlot === slot);
      if (!p) return;
      if (cardReason) {
        toast.push("warn", `Key ${e.key}: POV request unavailable`, cardReason);
        return;
      }
      e.preventDefault();
      void requestRef.current(p);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [cardReason, toast, requestRef]);

  if (!snap) return <div className="page"><h1 className="page-title">Live Control</h1><EmptyState title="Waiting for the engine">The console is connecting to the engine's live feed.</EmptyState></div>;

  if (!snap.state) {
    return (
      <div className="page">
        <h1 className="page-title">Live Control</h1>
        <EmptyState
          title="No telemetry yet"
          action={
            <>
              <Link to="/setup" className="btn btn-primary btn-md">
                Open Setup
              </Link>{" "}
              <ActionButton action={() => api.post("/api/v1/simulation/start", { startOffsetSec: 25 })} success="Simulation started (labelled synthetic data)">
                Start labelled simulation
              </ActionButton>
            </>
          }
        >
          Live Control fills in when the engine receives Game State Integration data from the CS2 observer client. Run Setup to write the GSI config and restart CS2 — or start the labelled simulation to rehearse.
        </EmptyState>
      </div>
    );
  }

  const s = snap.state;
  const sides = playersBySide(s);
  const pendingSteam = snap.pending?.request.kind === "select_player" ? snap.pending.request.steamId : null;
  const desired = shotTarget(snap.director?.desiredShot);
  const rolesOf = (p: PlayerState): PovRole[] => {
    const r: PovRole[] = [];
    if (s.observer.observedSteamId === p.steamId) r.push("confirmed");
    if (pendingSteam === p.steamId) r.push("pending");
    if (desired?.kind === "pov" && desired.target === p.steamId) r.push("desired");
    return r;
  };
  const cameras = (mapPack.data?.cameras ?? []).map((c) => ({ id: c.id, displayName: c.displayName, validation: c.validation }));

  const column = (side: "CT" | "T") => (
    <div className={`roster-col side-${side}`}>
      <h2 className="roster-head">
        <span className={`side-tag side-${side}`}>{side}</span> {s.teams[side].name ?? `${side} side`}
        <span className="muted"> · score {s.teams[side].score ?? MISSING}</span>
      </h2>
      {sides[side].length === 0 ? <p className="muted small">No {side} players reported.</p> : null}
      {sides[side].map((p) => (
        <RosterCard key={p.steamId} p={p} roles={rolesOf(p)} onRequest={() => (cardReason ? toast.push("warn", "POV request unavailable", cardReason) : void request(p))} disabledReason={cardReason} busy={busy === p.steamId} />
      ))}
    </div>
  );

  return (
    <div className="page page-live">
      <div className="page-head">
        <h1 className="page-title">Live Control</h1>
        {snap.simulated ? (
          <Note tone="sim" title="SIMULATION">
            Synthetic 5v5 on a synthetic map. Nothing here certifies real CS2 telemetry or camera control.
          </Note>
        ) : null}
      </div>
      <MatchHeader snap={snap} />
      {cardReason ? (
        <Note tone="warn" title="POV CONTROL UNAVAILABLE">
          {cardReason}. Cards still show telemetry. <Link to="/setup">Open Setup</Link>
        </Note>
      ) : (
        <p className="small muted live-hint">Click a card (or press the observer number key) to request that player's POV on the observer client. Cards show telemetry only — they are not video feeds.</p>
      )}
      <div className="live-grid">
        {column("CT")}
        <div className="live-center">
          <Panel title="Point of view" subtitle="Confirmed (from source feedback) is shown separately from pending and desired shots.">
            <PovStatus snap={snap} />
          </Panel>
          <Panel title="Operator actions">
            <ActionsBar snap={snap} cameras={cameras} />
          </Panel>
          <Panel title="Director" subtitle={`Policy ${snap.director?.policyVersion ?? MISSING}`}>
            <DirectorPanel snap={snap} threshold={threshold} />
          </Panel>
          <Panel title="Best candidates" subtitle="Top three valid shots with reasons">
            <CandidateList candidates={snap.candidates} nameOf={nameOf} currentShot={snap.currentShot} />
          </Panel>
        </div>
        {column("T")}
      </div>
      <div className="live-lower">
        <Panel title="Utility opportunities" subtitle="Confirmed vs predicted, time to effect, camera or fallback">
          <OpportunityList opportunities={snap.opportunities} nameOf={nameOf} />
        </Panel>
        <Panel title="Production" subtitle="Program, OBS, replay readiness and source health">
          <ProductionPanel snap={snap} />
        </Panel>
        <Panel title="Director controls">
          <DirectorControls snap={snap} />
        </Panel>
        <Panel title="Match timeline" subtitle="Derived events with evidence labels" className="panel-timeline">
          <Timeline nameOf={nameOf} />
        </Panel>
      </div>
      {s.players.length > 0 && sides.none.length > 0 ? <p className="small muted">{sides.none.length} player(s) without a side: {sides.none.map((p) => p.name).join(", ")}</p> : null}
      <p className="small muted">Phase/series values come from telemetry and the active match record. {titleCase(s.mapPhase)} map phase.</p>
    </div>
  );
}

