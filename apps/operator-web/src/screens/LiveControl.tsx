import { useEffect, useMemo, useRef, useState } from "react";
import type { CommandResult, ObserverMode, PlayerState, Side } from "@matchframe/contracts";
import { api, describeError, seg } from "../api/index.ts";
import type { DirectorStatus, EventRecord, MapPackDetail, MatchRow, OperatorSnapshot, ReplaysResponse, TeamRow } from "../api/types.ts";
import { CandidateList, DecisionExplain, OpportunityList } from "../components/director.tsx";
import { useToast } from "../components/toasts.tsx";
import { ActionButton, Badge, Checkbox, Details, EmptyState, KV, Note, Panel } from "../components/ui.tsx";
import { capabilityGate } from "../lib/capabilities.ts";
import { phaseRemaining } from "../lib/clock.ts";
import { MODE_INFO, OBSERVER_MODE_INFO, OBSERVER_MODES } from "../lib/director.ts";
import { fmtClock, fmtMs, MISSING, shotLabel, shotTarget, titleCase } from "../lib/format.ts";
import { isTypingTarget, useApi } from "../lib/hooks.ts";
import { CONTROL_HEALTH_TEXT } from "../lib/ownership.ts";
import { makeNameOf, playersBySide, slotFromKey } from "../lib/players.ts";
import { Link } from "../router.tsx";
import { liveStore, useEngineNow, useLive, useNow, useSnapshot } from "../state/live.ts";
import { usePermission } from "../state/session.tsx";
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

/** Commands still awaiting transport or observed confirmation. */
export function isInFlight(status: string | null | undefined): boolean {
  return status === "pending" || status === "sent" || status === "transport_acknowledged";
}

function describeCommandResult(r: CommandResult | null | undefined, who: string): { tone: "ok" | "info" | "danger"; text: string } {
  if (!r) return { tone: "info", text: `No command was issued for ${who} (no valid POV candidate).` };
  const precision = r.precision.replace(/_/g, " ");
  if (r.status === "confirmed") return { tone: "ok", text: `POV ${who}: confirmed (${precision}).` };
  if (r.status === "failed" || r.status === "cancelled") return { tone: "danger", text: `POV ${who}: ${r.status}${r.failureReason ? ` — ${r.failureReason.replace(/_/g, " ")}` : ""}${r.detail ? ` (${r.detail})` : ""}.` };
  return { tone: "info", text: `POV ${who}: ${r.status.replace(/_/g, " ")} (${precision}) — waiting for observed confirmation.` };
}

/** Waits (≤4 s) for the arbiter's observed result for a command and reports it. */
async function followConfirmation(commandId: string, who: string, push: (tone: "ok" | "info" | "warn" | "danger", title: string, body?: string) => void) {
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    const ev = liveStore.state.arbiterLog.find((e) => e.kind === "result" && e.detail.commandId === commandId && e.detail.status !== "transport_acknowledged" && e.detail.status !== "sent");
    if (ev) {
      const status = String(ev.detail.status);
      if (status === "confirmed") push("ok", `POV ${who}: confirmed by telemetry (${String(ev.detail.precision ?? "").replace(/_/g, " ")})`);
      else push("danger", `POV ${who}: ${status}`, ev.detail.failureReason ? String(ev.detail.failureReason).replace(/_/g, " ") : undefined);
      return;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  push("warn", `POV ${who}: no observed confirmation yet`, "Check the Point of view panel: the confirmed POV comes from source feedback.");
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
      <div className="mh-block mh-match">
        <span className="mh-label">{am.event?.name ?? "Match"}</span>
        <span className="mh-value">
          {am.match ? (
            <span title={`Series ${am.match.seriesScoreA} – ${am.match.seriesScoreB} (BO${am.match.format.bestOf})`}>
              {am.teamA?.name ?? "Team A"} vs {am.teamB?.name ?? "Team B"} <span className="muted">· {am.match.seriesScoreA}–{am.match.seriesScoreB}</span>
            </span>
          ) : (
            <Link to="/matches" title="Activate a match so HUDs show team names, logos and series">
              Activate a match
            </Link>
          )}
        </span>
      </div>
      <div className="mh-block" title={`${titleCase(s.mapPhase)} map phase`}>
        <span className="mh-label">Map</span>
        <span className="mh-value">{s.mapName ?? MISSING}</span>
      </div>
      <div className="mh-block mh-score">
        <span className="mh-label">Score</span>
        <span className="mh-value">
          <span className="side-ct">CT</span> <strong>{s.teams.CT.score ?? MISSING}</strong> – <strong>{s.teams.T.score ?? MISSING}</strong> <span className="side-t">T</span>
        </span>
      </div>
      <div className="mh-block">
        <span className="mh-label">Round {s.roundNumber ?? MISSING}</span>
        <span className="mh-value">
          {PHASE_LABEL[s.gamePhase] ?? s.gamePhase} <span className="mh-clock">{fmtClock(remaining)}</span>
          {s.paused ? <Badge tone="warn">PAUSED</Badge> : null}
          {s.bomb && (s.bomb.state === "planted" || s.bomb.state === "defusing") ? <Badge tone="danger">BOMB {s.bomb.state.toUpperCase()}{s.bomb.site ? ` ${s.bomb.site}` : ""}</Badge> : null}
        </span>
      </div>
      <div className="mh-block" title={`Observer camera mode: ${s.observer.cameraMode.replace("_", " ")}`}>
        <span className="mh-label">Observing</span>
        <span className="mh-value">{s.observer.observedSteamId ? nameOf(s.observer.observedSteamId) : <span className="muted">Nobody</span>}</span>
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
  const inFlight = isInFlight(p?.status);
  const pendingTarget = p ? (p.request.kind === "select_player" ? `POV · ${nameOf(p.request.steamId)}` : p.request.kind === "activate_static_camera" ? `Camera · ${p.request.camera.displayName}` : p.request.kind.replace(/_/g, " ")) : null;
  return (
    <>
      <div className="pov">
        <div className="pov-main">
          <span className="pov-label">On air</span>
          <span className="pov-value">{shotLabel(snap.currentShot, nameOf)}</span>
        </div>
        <div className="pov-side">
          <div>
            <span className="pov-label">Director wants</span> {shotLabel(snap.director?.desiredShot, nameOf)}
            {snap.director ? <span className="muted"> · {snap.director.action}</span> : null}
          </div>
          <div className={inFlight ? "pov-inflight" : undefined}>
            <span className="pov-label">{p && !inFlight ? "Last command" : "Pending"}</span> {pendingTarget ?? <span className="muted">Nothing</span>}
            {p ? <span className="muted"> · {p.status.replace(/_/g, " ")}</span> : null}
          </div>
        </div>
      </div>
      <Details summary="Details">
        <KV
          items={[
            ["On air", `confirmed by source feedback (${s.observer.evidence}) · camera ${s.observer.cameraMode.replace("_", " ")}`],
            ["Command", p ? `${p.status.replace(/_/g, " ")} · owner ${p.context.owner}${p.retries ? ` · retry ${p.retries}` : ""}` : "nothing in flight"],
            ["Director", snap.director ? `${snap.director.action} · ${snap.director.mode}` : "no decision"],
            [
              "Last arbiter event",
              lastResult ? `${lastResult.kind.replace(/_/g, " ")} ${String(lastResult.detail.status ?? lastResult.detail.reason ?? "")}${lastResult.detail.failureReason ? ` — ${String(lastResult.detail.failureReason).replace(/_/g, " ")}` : ""}` : "none since this console connected",
            ],
          ]}
        />
      </Details>
    </>
  );
}

function ActionsBar({ snap, cameras }: { snap: OperatorSnapshot; cameras: { id: string; displayName: string; validation: string }[] }) {
  const s = snap.state!;
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
    <div className="live-actions">
      <div className="row">
        <ActionButton
          variant="primary"
          action={() => api.post<{ decision: { action: string; desiredShot: string | null } | null }>("/api/v1/director/follow-action")}
          success={(r) => (r.decision ? `Follow action: ${r.decision.action} → ${shotLabel(r.decision.desiredShot, nameOf)}` : "Follow action requested")}
          disabledReason={directorReason}
        >
          Follow action
        </ActionButton>
        <ActionButton action={returnLive} success={(m) => m} disabledReason={programReason ?? cameraReason} title="Program back to Live and the observer back on a player POV">
          Return live
        </ActionButton>
      </div>
      <div className="ctl-row">
        <span className="ctl-label">Hold</span>
        {hold ? (
          <ActionButton variant="warn" action={() => api.post("/api/v1/director/release-hold")} success="Hold released" disabledReason={directorReason}>
            Release hold {holdLeft !== null ? `(${fmtMs(holdLeft)})` : "(until released)"}
          </ActionButton>
        ) : (
          <>
            <select aria-label="Hold duration" value={holdMs} onChange={(e) => setHoldMs(e.target.value)}>
              <option value="5000">5 s</option>
              <option value="10000">10 s</option>
              <option value="30000">30 s</option>
              <option value="60000">60 s</option>
              <option value="">Until released</option>
            </select>
            <ActionButton action={() => api.post("/api/v1/director/hold", { durationMs: holdMs ? Number(holdMs) : null })} success={`Holding ${holdMs ? `${Number(holdMs) / 1000} s` : "until released"}`} disabledReason={directorReason}>
              Hold
            </ActionButton>
          </>
        )}
      </div>
      <div className="ctl-row">
        <span className="ctl-label">Pin</span>
        <select aria-label="Pin target" value={pinTarget} onChange={(e) => setPinTarget(e.target.value)}>
          <option value="">Choose…</option>
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
          Pin
        </ActionButton>
        {pin ? (
          <ActionButton size="sm" variant="ghost" action={() => api.post("/api/v1/director/pin", { kind: "none" })} success="Pin cleared" disabledReason={directorReason}>
            Unpin {pinText}
          </ActionButton>
        ) : null}
      </div>
      <div className="ctl-row">
        <span className="ctl-label">Cinematic</span>
        <select aria-label="Cinematic camera" value={cinematicCam} onChange={(e) => setCinematicCam(e.target.value)} disabled={!gate.enabled}>
          <option value="">Director picks the camera</option>
          {cameras.map((c) => (
            <option key={c.id} value={c.id}>
              {c.displayName} ({c.validation})
            </option>
          ))}
        </select>
        <ActionButton action={() => api.post("/api/v1/director/request-cinematic", cinematicCam ? { cameraId: cinematicCam } : {})} success="Cinematic requested" disabledReason={directorReason ?? (gate.enabled ? null : gate.reason)} title={gate.reason ?? undefined}>
          Request
        </ActionButton>
      </div>
    </div>
  );
}

function ObserverModeSelect({ snap }: { snap: OperatorSnapshot }) {
  const directorReason = usePermission("director.control");
  const [busyMode, setBusyMode] = useState<ObserverMode | null>(null);
  const toast = useToast();
  const fullActionAvailable = snap.simulated || snap.cloud?.fullActionObserver !== false;
  const setMode = async (m: ObserverMode) => {
    setBusyMode(m);
    try {
      await api.post("/api/v1/director/observer-mode", { mode: m });
      toast.push("ok", `Observer: ${OBSERVER_MODE_INFO[m].label}`, m !== "off" && (snap.ownership.manualSticky || snap.ownership.owner !== "director") ? "The Observer moves the camera once it owns it: use Resume automation in the top bar." : undefined);
    } catch (e) {
      toast.push("danger", "Observer mode not changed", describeError(e));
    } finally {
      setBusyMode(null);
    }
  };
  const editorial = snap.mode !== "advisory" && snap.mode !== "automatic" && snap.mode !== "assisted" ? MODE_INFO[snap.mode] : null;
  return (
    <>
      <div className="mode-select" role="radiogroup" aria-label="Observer mode">
        {OBSERVER_MODES.map((m) => {
          const locked = m === "full_action" && !fullActionAvailable;
          return (
            <button
              key={m}
              role="radio"
              aria-checked={snap.observerMode === m}
              className={`mode-btn ${snap.observerMode === m ? "is-on" : ""}`}
              title={locked ? "Full Action Observer comes with the top plan. Upgrade on the website." : OBSERVER_MODE_INFO[m].hint}
              disabled={directorReason !== null || busyMode !== null || locked}
              onClick={() => void setMode(m)}
            >
              {OBSERVER_MODE_INFO[m].label}
              {OBSERVER_MODE_INFO[m].topPlan && locked ? <span className="mode-plan"> · Top plan</span> : null}
            </button>
          );
        })}
      </div>
      <p className="small muted mode-hint">
        {OBSERVER_MODE_INFO[snap.observerMode].hint}
        {editorial ? ` Editorial mode: ${editorial.label}.` : ""}
        {directorReason ? ` (${directorReason})` : ""}
      </p>
    </>
  );
}

function DirectorPanel({ snap, threshold, nameOf }: { snap: OperatorSnapshot; threshold: number | null; nameOf: (id: string) => string }) {
  const d = snap.director;
  const now = useNow(500);
  const sequenceChangedAt = useLive((s) => s.sequenceChangedAt);
  const health = d ? CONTROL_HEALTH_TEXT[d.controlHealth] : null;
  const ageEst = snap.state ? liveStore.clock.ageOf(snap.state.time.receivedAtMonotonicMs, now) : null;
  const inputAge = d && typeof d.supportingFeatures.dataAgeMs === "number" ? d.supportingFeatures.dataAgeMs : null;
  const stale = snap.state?.sources[0]?.stale ?? false;
  return (
    <>
      <DecisionExplain decision={d} nameOf={nameOf} threshold={threshold} />
      <Details summary="Top candidates">
        <CandidateList candidates={snap.candidates} nameOf={nameOf} currentShot={snap.currentShot} />
      </Details>
      <Details summary="Decision details">
        <KV
          items={[
            ["Control", health ? <span key="h" title={health.hint}>{health.text}</span> : <span className="muted">no decision yet</span>],
            ["Input", `${stale ? "stale" : "fresh"} · decision input ${fmtMs(inputAge)} · data age ≈ ${fmtMs(ageEst)} · last packet ${sequenceChangedAt ? fmtMs(Math.max(0, now - sequenceChangedAt)) : MISSING} ago`],
            ["Policy / model", d ? `${d.policyVersion} · ${d.modelVersion ?? "no learned model (baseline policy)"}` : MISSING],
          ]}
        />
      </Details>
    </>
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
  return (
    <div className="dir-controls">
      <fieldset>
        <legend>Disable cinematics</legend>
        <Checkbox checked={c.cinematicsDisabled.round !== null} disabled={!!reason} onChange={(v) => void call("/api/v1/director/cinematics", { scope: "round", disabled: v }, v ? "Cinematics disabled for this round" : "Cinematics re-enabled for this round")} label="This round" />
        <Checkbox checked={c.cinematicsDisabled.map !== null} disabled={!!reason} onChange={(v) => void call("/api/v1/director/cinematics", { scope: "map", disabled: v }, v ? "Cinematics disabled for this map" : "Cinematics re-enabled for this map")} label="This map" />
        <Checkbox checked={c.cinematicsDisabled.match} disabled={!!reason} onChange={(v) => void call("/api/v1/director/cinematics", { scope: "match", disabled: v }, v ? "Cinematics disabled for the match" : "Cinematics re-enabled for the match")} label="Whole match" />
      </fieldset>
      <fieldset>
        <legend title="Restrict POV choices to one side (e.g. a team-specific stream)">Follow one side</legend>
        <div className="seg" role="radiogroup" aria-label="One-side profile">
          {([null, "CT", "T"] as (Side | null)[]).map((sd) => (
            <button key={String(sd)} role="radio" aria-checked={c.oneSide === sd} className={`seg-btn ${c.oneSide === sd ? "is-on" : ""}`} disabled={!!reason} onClick={() => void call("/api/v1/director/one-side", { side: sd }, sd ? `Following ${sd} side only` : "One-side profile off")}>
              {sd ?? "Both sides"}
            </button>
          ))}
        </div>
      </fieldset>
      <fieldset>
        <legend>Replays</legend>
        <Checkbox checked={c.autoReplaysDisabled} disabled={!!reason} onChange={(v) => void call("/api/v1/director/auto-replays", { disabled: v }, v ? "Automatic replay suggestions disabled" : "Automatic replay suggestions enabled")} label="Disable automatic replay suggestions" />
      </fieldset>
      {reason ? <p className="small muted">{reason}</p> : null}
    </div>
  );
}

const onOff = (v: boolean | null) => (v === null ? "?" : v ? "on" : "off");

function ProductionPanel({ snap }: { snap: OperatorSnapshot }) {
  const replays = useApi<ReplaysResponse>("/api/v1/replays", { refreshMs: 5000 });
  const prov = replays.data?.provider ?? null;
  const approved = replays.data?.items.filter((i) => i.state === "approved").length ?? 0;
  const src = snap.state?.sources ?? [];
  return (
    <>
      <KV
        items={[
          ["Program", <span key="p" title={`Owner: ${snap.program.owner.kind}`}>{titleCase(snap.program.mode.replace("_", " ").toLowerCase())}</span>],
          ["OBS", snap.obs.connected ? `${snap.obs.programScene ?? MISSING} (preview ${snap.obs.previewScene ?? MISSING})${snap.obs.studioMode ? " · studio mode" : ""}` : <Link key="o" to="/devices">Not connected — connect in Devices</Link>],
          ["Replays", prov ? <span key="r" title={prov.health.detail}>{prov.health.ok ? "Ready" : `Not ready — ${prov.health.detail}`} · {approved} approved</span> : replays.data ? <Link key="r" to="/replays">No replay provider set up</Link> : MISSING],
          ["Outputs", `Recording ${onOff(snap.obs.recording)} · streaming ${onOff(snap.obs.streaming)} · replay buffer ${onOff(snap.obs.replayBuffer)}`],
        ]}
      />
      <Details summary={`Telemetry sources (${src.length})`}>
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
                  <td>{x.stale ? "Stale" : x.connected ? "OK" : "Disconnected"}</td>
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
      </Details>
    </>
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
      if (r && isInFlight(r.status)) void followConfirmation(r.commandId, p.name, toast.push);
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

  if (!snap) return <div className="page"><h1 className="page-title">Live Control</h1><EmptyState title="Connecting to the engine…" /></div>;

  if (!snap.state) {
    return (
      <div className="page">
        <h1 className="page-title">Live Control</h1>
        <EmptyState
          title="No game data yet"
          action={
            <>
              <Link to="/setup" className="btn btn-primary btn-md">
                Open Setup
              </Link>{" "}
              <ActionButton action={() => api.post("/api/v1/simulation/start", { startOffsetSec: 25 })} success="Simulation started (labelled synthetic data)">
                Start simulation
              </ActionButton>
            </>
          }
        >
          Connect the CS2 observer client in Setup, or start the simulation to rehearse.
        </EmptyState>
      </div>
    );
  }

  const s = snap.state;
  const sides = playersBySide(s);
  const pendingSteam = snap.pending?.request.kind === "select_player" && isInFlight(snap.pending.status) ? snap.pending.request.steamId : null;
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
        <span className="roster-score">{s.teams[side].score ?? MISSING}</span>
      </h2>
      {sides[side].length === 0 ? <p className="muted small">No {side} players reported.</p> : null}
      {sides[side].map((p) => (
        <RosterCard key={p.steamId} p={p} roles={rolesOf(p)} onRequest={() => (cardReason ? toast.push("warn", "POV request unavailable", cardReason) : void request(p))} disabledReason={cardReason} busy={busy === p.steamId} />
      ))}
    </div>
  );

  return (
    <div className="page page-live">
      <h1 className="sr-only">Live Control</h1>
      <MatchHeader snap={snap} />
      {cardReason ? (
        <Note tone="warn" title="POV control unavailable">
          {cardReason}. Cards still show telemetry. <Link to="/setup">Open Setup</Link>
        </Note>
      ) : null}
      <div className="live-grid">
        {column("CT")}
        <div className="live-center">
          <Panel title="Camera" subtitle="Click a player, or press their number key, to switch POV">
            <PovStatus snap={snap} />
          </Panel>
          <Panel title="Observer">
            <ObserverModeSelect snap={snap} />
            <ActionsBar snap={snap} cameras={cameras} />
            <Details summary="Options">
              <DirectorControls snap={snap} />
            </Details>
          </Panel>
          <Panel title="Director">
            <DirectorPanel snap={snap} threshold={threshold} nameOf={nameOf} />
          </Panel>
        </div>
        {column("T")}
      </div>
      <div className="live-lower">
        <Panel title="Match timeline" className="panel-timeline">
          <Timeline nameOf={nameOf} />
        </Panel>
        <div className="stack">
          <Panel title="Utility">
            <OpportunityList opportunities={snap.opportunities} nameOf={nameOf} />
          </Panel>
          <Panel title="Production">
            <ProductionPanel snap={snap} />
          </Panel>
        </div>
      </div>
      {s.players.length > 0 && sides.none.length > 0 ? <p className="small muted">{sides.none.length} player(s) without a side: {sides.none.map((p) => p.name).join(", ")}</p> : null}
    </div>
  );
}
