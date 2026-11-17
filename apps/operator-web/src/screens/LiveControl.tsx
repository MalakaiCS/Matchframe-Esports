import type { ReactNode } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { CommandResult, ObserverMode, PlayerState, Side } from "@matchframe/contracts";
import { api, describeError, seg } from "../api/index.ts";
import type { AutoReplayResponse, DirectorStatus, EventRecord, MapPackDetail, MatchRow, OperatorSnapshot, ReplaysResponse, TeamRow } from "../api/types.ts";
import { AutoDirectorCard } from "../components/AutoDirectorCard.tsx";
import { CandidateList, DecisionExplain, OpportunityList } from "../components/director.tsx";
import { useToast } from "../components/toasts.tsx";
import { ActionButton, Badge, Button, Checkbox, Details, EmptyState, KV, Note, Panel } from "../components/ui.tsx";
import { capabilityGate } from "../lib/capabilities.ts";
import { phaseRemaining } from "../lib/clock.ts";
import { MODE_INFO, OBSERVER_MODE_INFO, OBSERVER_MODES } from "../lib/director.ts";
import { fmtClock, fmtMs, MISSING, shotLabel, shotTarget, titleCase } from "../lib/format.ts";
import { isTypingTarget, useApi } from "../lib/hooks.ts";
import { shortcutLabel, TEAM_KEYS } from "../lib/replay-keys.ts";
import { CONTROL_HEALTH_TEXT } from "../lib/ownership.ts";
import { makeNameOf, playersBySide, slotFromKey } from "../lib/players.ts";
import { Link } from "../router.tsx";
import { liveStore, useEngineNow, useLive, useNow, useSnapshot } from "../state/live.ts";
import { usePermission } from "../state/session.tsx";
import type { PovRole } from "./live/RosterCard.tsx";
import { RosterCard } from "./live/RosterCard.tsx";
import { Hotkeys } from "./replays/AutoReplays.tsx";
import { MapIntroCard } from "./live/MapIntroCard.tsx";
import { TeamCommsCard } from "./live/TeamCommsCard.tsx";
import { Timeline } from "./live/Timeline.tsx";
import { perLocale, t } from "../i18n/index.ts";
import { T } from "../i18n/T.tsx";

const PHASE_LABEL: Record<string, string> = perLocale(() => ({
  warmup: "Warmup",
  freezetime: t("live.freezeTime"),
  live: t("live.roundLive"),
  bomb: t("live.bombPlanted"),
  defuse: "Defusing",
  over: t("live.roundOver"),
  timeout_t: t("live.tTimeout"),
  timeout_ct: t("live.ctTimeout"),
  paused: "Paused",
  halftime: "Halftime",
  gameover: t("live.gameOver"),
  unknown: t("live.phaseUnknown"),
}));

/** Commands still awaiting transport or observed confirmation. */
export function isInFlight(status: string | null | undefined): boolean {
  return status === "pending" || status === "sent" || status === "transport_acknowledged";
}

function describeCommandResult(r: CommandResult | null | undefined, who: string): { tone: "ok" | "info" | "danger"; text: string } {
  if (!r) return { tone: "info", text: t("live.noCommandWasIssuedFor", { who }) };
  const precision = r.precision.replace(/_/g, " ");
  if (r.status === "confirmed") return { tone: "ok", text: t("live.povWhoConfirmedPrecision", { who, precision }) };
  if (r.status === "failed" || r.status === "cancelled") return { tone: "danger", text: `POV ${who}: ${r.status}${r.failureReason ? ` — ${r.failureReason.replace(/_/g, " ")}` : ""}${r.detail ? ` (${r.detail})` : ""}.` };
  return { tone: "info", text: t("live.povWhoReplacePrecisionWaiting", { who, replace: r.status.replace(/_/g, " "), precision }) };
}

/** Waits (≤4 s) for the arbiter's observed result for a command and reports it. */
async function followConfirmation(commandId: string, who: string, push: (tone: "ok" | "info" | "warn" | "danger", title: string, body?: string) => void) {
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    const ev = liveStore.state.arbiterLog.find((e) => e.kind === "result" && e.detail.commandId === commandId && e.detail.status !== "transport_acknowledged" && e.detail.status !== "sent");
    if (ev) {
      const status = String(ev.detail.status);
      if (status === "confirmed") push("ok", t("live.povWhoConfirmedByTelemetry", { who, replace: String(ev.detail.precision ?? "").replace(/_/g, " ") }));
      else push("danger", `POV ${who}: ${status}`, ev.detail.failureReason ? String(ev.detail.failureReason).replace(/_/g, " ") : undefined);
      return;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  push("warn", t("live.povWhoNoObservedConfirmation", { who }), t("live.checkThePointOfView"));
}

function useActiveMatch() {
  const active = useApi<{ key: string; value: string | null }>("/api/v1/settings/live.activeMatchId", { refreshMs: 15000 });
  const matchId = active.data?.value ?? null;
  const match = useApi<MatchRow>(matchId ? `/api/v1/matches/${seg(matchId)}` : null, { refreshMs: 15000 });
  const teams = useApi<TeamRow[]>(matchId ? "/api/v1/teams" : null);
  const events = useApi<EventRecord[]>(match.data?.eventId ? "/api/v1/events" : null);
  const team = (id: string | undefined) => teams.data?.find((tRow) => tRow.id === id) ?? null;
  return {
    error: active.error,
    match: match.data ?? null,
    teamA: team(match.data?.teamAId),
    teamB: team(match.data?.teamBId),
    event: events.data?.find((e) => e.id === match.data?.eventId) ?? null,
  };
}

interface SideTeamsView {
  CT: string | null;
  T: string | null;
  how: "roster" | "names" | "players" | "veto" | "assumed" | "swapped" | null;
  ctName: string | null;
  tName: string | null;
  canSwap: boolean;
}

const SIDE_TEAMS_HOW: Record<NonNullable<SideTeamsView["how"]>, string> = perLocale(() => ({
  roster: t("live.recognisedFromThePlayersSteamid64s"),
  names: t("live.recognisedFromCs2STeam"),
  players: t("live.recognisedFromAFewPlayers"),
  veto: t("live.fromTheVetoSStarting"),
  assumed: t("live.team1AssumedOnThe"),
  swapped: t("live.swappedByYou"),
}));

interface SavePlayersResult {
  applied: boolean;
  create: { name: string; steamId: string; team: string }[];
  move: { name: string; steamId: string; from: string | null; team: string }[];
  already: number;
}

/**
 * Which team the HUDs show on CT and T and how it was decided; Swap teams (also Ctrl+Shift+F11, a
 * global hotkey and the Stream Deck's teams_swap); Save players to teams, so the game data places
 * the teams by their players from then on.
 */
function SideTeamsLine() {
  const v = useApi<SideTeamsView>("/api/v1/live/side-teams", { refreshMs: 2000 });
  const reason = usePermission("program.control");
  const writeReason = usePermission("metadata.write");
  const d = v.data;
  if (!d || !d.how || (!d.CT && !d.T)) return null;
  const summary = (r: SavePlayersResult) =>
    r.create.length + r.move.length === 0 ? t("live.allAlreadyPlayersAreAlready", { already: r.already }) : `${t("live.playersSavedMoved", { count: r.create.length, moved: r.move.length })}${r.already ? t("live.alreadyAlreadyOnTheirTeam", { already: r.already }) : ""}.`;
  return (
    <div className="stack-sm">
      <div className="row small" role="status" aria-label={t("live.teamsOnScreen")}>
        <span><T k="live.onScreenCtStrongT" values={{ strong: <strong>{d.ctName ?? "?"}</strong>, strong2: <strong>{d.tName ?? "?"}</strong>, span: <span className="muted">({SIDE_TEAMS_HOW[d.how]})</span> }} tags={{ span: (c) => <span className="side-ct">{c}</span>, span2: (c) => <span className="side-t">{c}</span> }} /></span>
        {d.canSwap ? (
          <ActionButton size="sm" variant="ghost" action={async () => v.setData(await api.post<SideTeamsView>("/api/v1/live/side-teams/swap"))} success={t("live.teamsSwappedOnTheHuds")} disabledReason={reason}>{t("live.swapTeamsShortcutlabel", { shortcutLabel: shortcutLabel("F11") })}</ActionButton>
        ) : null}
        {d.CT && d.T && d.how !== "roster" ? (
          <ActionButton
            size="sm"
            variant="ghost"
            action={async () => summary(await api.post<SavePlayersResult>("/api/v1/live/side-teams/save-players", { apply: true }))}
            success={(m) => m}
            disabledReason={writeReason}
            confirm={{
              title: t("live.saveThesePlayersToTheir"),
              body: t("live.thePlayersNowOnCt", { v: d.ctName ?? t("live.theCtTeam"), v2: d.tName ?? t("live.theTTeam") }),
              confirmLabel: t("live.savePlayers"),
            }}
          >{t("live.savePlayersToTeams")}</ActionButton>
        ) : null}
      </div>
      <Details summary={t("live.swapTeamsHotkeyAndStream")}>
        <Hotkeys keys={TEAM_KEYS} label={t("live.teamHotkeys")} devices={t("live.theDeviceActionTeamsSwap")} />
      </Details>
    </div>
  );
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
        <span className="mh-label">{am.event?.name ?? t("live.match")}</span>
        <span className="mh-value">
          {am.match ? (
            <span title={t("live.seriesSeriesscoreaSeriesscorebBoBestof", { seriesScoreA: am.match.seriesScoreA, seriesScoreB: am.match.seriesScoreB, bestOf: am.match.format.bestOf })}><T k="live.vVsV2Span" values={{ v: am.teamA?.name ?? t("live.teamA"), v2: am.teamB?.name ?? t("live.teamB"), span: <span className="muted">· {am.match.seriesScoreA}–{am.match.seriesScoreB}</span> }} /></span>
          ) : (
            <Link to="/matches" title={t("live.activateAMatchSoHuds")}>{t("live.activateAMatch")}</Link>
          )}
        </span>
      </div>
      <div className="mh-block" title={t("live.mapphaseMapPhase", { mapPhase: titleCase(s.mapPhase) })}>
        <span className="mh-label">{t("live.map")}</span>
        <span className="mh-value">{s.mapName ?? MISSING}</span>
      </div>
      <div className="mh-block mh-score">
        <span className="mh-label">{t("live.score")}</span>
        <span className="mh-value">
          <span className="side-ct">CT</span> <strong>{s.teams.CT.score ?? MISSING}</strong> – <strong>{s.teams.T.score ?? MISSING}</strong> <span className="side-t">T</span>
        </span>
      </div>
      <div className="mh-block">
        <span className="mh-label">{t("live.roundV", { v: s.roundNumber ?? MISSING })}</span>
        <span className="mh-value">
          {PHASE_LABEL[s.gamePhase] ?? s.gamePhase} <span className="mh-clock">{fmtClock(remaining)}</span>
          {s.paused ? <Badge tone="warn">PAUSED</Badge> : null}
          {s.bomb && (s.bomb.state === "planted" || s.bomb.state === "defusing") ? <Badge tone="danger">BOMB {s.bomb.state.toUpperCase()}{s.bomb.site ? ` ${s.bomb.site}` : ""}</Badge> : null}
        </span>
      </div>
      <div className="mh-block" title={t("live.observerCameraModeReplace", { replace: s.observer.cameraMode.replace("_", " ") })}>
        <span className="mh-label">{t("live.observing")}</span>
        <span className="mh-value">{s.observer.observedSteamId ? nameOf(s.observer.observedSteamId) : <span className="muted">{t("live.nobody")}</span>}</span>
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
  const pendingTarget = p ? (p.request.kind === "select_player" ? `${p.request.view === "chase" ? "Chase" : "POV"} · ${nameOf(p.request.steamId)}` : p.request.kind === "activate_static_camera" ? `Camera · ${p.request.camera.displayName}` : p.request.kind.replace(/_/g, " ")) : null;
  return (
    <>
      <div className="pov">
        <div className="pov-main">
          <span className="pov-label">{t("live.onAir")}</span>
          <span className="pov-value">{shotLabel(snap.currentShot, nameOf)}</span>
        </div>
        <div className="pov-side">
          <div>
            <span className="pov-label">{t("live.directorWants")}</span> {shotLabel(snap.director?.desiredShot, nameOf)}
            {snap.director ? <span className="muted"> · {snap.director.action}</span> : null}
          </div>
          <div className={inFlight ? "pov-inflight" : undefined}>
            <span className="pov-label">{p && !inFlight ? t("live.lastCommand") : t("live.pending")}</span> {pendingTarget ?? <span className="muted">{t("live.nothing")}</span>}
            {p ? <span className="muted"> · {p.status.replace(/_/g, " ")}</span> : null}
          </div>
        </div>
      </div>
      <Details summary={t("common.details")}>
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
  const gate = capabilityGate("staticCameraControl", snap.capabilities.staticCameraControl, { simulated: snap.simulated, allowUnverified: true });
  const hold = snap.controls.hold;
  const holdLeft = hold && hold.until !== null && engineNow !== null ? Math.max(0, hold.until - engineNow) : null;
  const pin = snap.controls.pin;
  const nameOf = makeNameOf(s);
  const pinText = !pin ? null : pin.kind === "player" ? `player ${nameOf(pin.steamId)}` : pin.kind === "side" ? `side ${pin.side}` : pin.kind === "team" ? `team ${pin.teamId}` : `${pin.steamIds.length} players`;

  const returnLive = async () => {
    const out: string[] = [];
    if (snap.program.mode !== "LIVE") {
      const tRow = await api.post<{ to: string; confirmed: boolean; detail: string | null }>("/api/v1/program/return-live");
      out.push(`Program → ${tRow.to}${tRow.confirmed ? "" : t("live.mixerNotConfirmed")}${tRow.detail ? `: ${tRow.detail}` : ""}`);
    }
    const shot = shotTarget(snap.currentShot);
    if (!shot || shot.kind !== "pov") {
      const r = await api.post<CommandResult | null>("/api/v1/observer/commands", { kind: "return_to_pov" });
      out.push(describeCommandResult(r, t("live.bestPlayer")).text);
    }
    return out.length ? out.join(" · ") : t("live.alreadyLiveProgramIsLive");
  };

  return (
    <div className="live-actions">
      <div className="row">
        <ActionButton
          variant="primary"
          action={() => api.post<{ decision: { action: string; desiredShot: string | null } | null }>("/api/v1/director/follow-action")}
          success={(r) => (r.decision ? t("live.followActionActionDesiredshot", { action: r.decision.action, desiredShot: shotLabel(r.decision.desiredShot, nameOf) }) : t("live.followActionRequested"))}
          disabledReason={directorReason}
        >{t("live.followAction")}</ActionButton>
        <ActionButton action={returnLive} success={(m) => m} disabledReason={programReason ?? cameraReason} title={t("live.programBackToLiveAnd")}>{t("live.returnLive")}</ActionButton>
      </div>
      <div className="ctl-row">
        <span className="ctl-label">{t("live.hold")}</span>
        {hold ? (
          <ActionButton variant="warn" action={() => api.post("/api/v1/director/release-hold")} success={t("live.holdReleased")} disabledReason={directorReason}>{t("live.releaseHoldV", { v: holdLeft !== null ? `(${fmtMs(holdLeft)})` : t("live.untilReleased3") })}</ActionButton>
        ) : (
          <>
            <select aria-label={t("live.holdDuration")} value={holdMs} onChange={(e) => setHoldMs(e.target.value)}>
              <option value="5000">{t("live.text5S")}</option>
              <option value="10000">{t("live.text10S")}</option>
              <option value="30000">{t("live.text30S")}</option>
              <option value="60000">{t("live.text60S")}</option>
              <option value="">{t("live.untilReleased2")}</option>
            </select>
            <ActionButton action={() => api.post("/api/v1/director/hold", { durationMs: holdMs ? Number(holdMs) : null })} success={t("live.holdingV", { v: holdMs ? `${Number(holdMs) / 1000} s` : t("live.untilReleased") })} disabledReason={directorReason}>{t("live.hold")}</ActionButton>
          </>
        )}
      </div>
      <div className="ctl-row">
        <span className="ctl-label">{t("live.pin")}</span>
        <select aria-label={t("live.pinTarget")} value={pinTarget} onChange={(e) => setPinTarget(e.target.value)}>
          <option value="">{t("live.choose")}</option>
          <optgroup label={t("live.players")}>
            {s.players.map((p) => (
              <option key={p.steamId} value={`player:${p.steamId}`}>
                {p.name} ({p.side ?? "?"})
              </option>
            ))}
          </optgroup>
          <optgroup label={t("live.sides")}>
            <option value="side:CT">{t("live.ctSide")}</option>
            <option value="side:T">{t("live.tSide")}</option>
          </optgroup>
        </select>
        <ActionButton
          action={() => {
            const [kind, val] = pinTarget.split(":");
            return api.post("/api/v1/director/pin", kind === "player" ? { kind: "player", steamId: val } : { kind: "side", side: val });
          }}
          success={t("live.pinSet")}
          disabledReason={directorReason ?? (pinTarget ? null : t("live.chooseAPlayerOrSide"))}
        >{t("live.pin")}</ActionButton>
        {pin ? (
          <ActionButton size="sm" variant="ghost" action={() => api.post("/api/v1/director/pin", { kind: "none" })} success={t("live.pinCleared")} disabledReason={directorReason}>{t("live.unpinPintext", { pinText })}</ActionButton>
        ) : null}
      </div>
      <div className="ctl-row">
        <span className="ctl-label">{t("live.cinematic")}</span>
        <select aria-label={t("live.cinematicCamera")} value={cinematicCam} onChange={(e) => setCinematicCam(e.target.value)} disabled={!gate.enabled}>
          <option value="">{t("live.directorPicksTheCamera")}</option>
          {cameras.map((c) => (
            <option key={c.id} value={c.id}>
              {c.displayName} ({c.validation})
            </option>
          ))}
        </select>
        <ActionButton action={() => api.post("/api/v1/director/request-cinematic", cinematicCam ? { cameraId: cinematicCam } : {})} success={t("live.cinematicRequested")} disabledReason={directorReason ?? (gate.enabled ? null : gate.reason)} title={gate.reason ?? undefined}>{t("live.request")}</ActionButton>
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
      toast.push("ok", t("live.observerLabel", { label: OBSERVER_MODE_INFO[m].label }), m !== "off" && (snap.ownership.manualSticky || snap.ownership.owner !== "director") ? t("live.theObserverMovesTheCamera") : undefined);
    } catch (e) {
      toast.push("danger", t("live.observerModeNotChanged"), describeError(e));
    } finally {
      setBusyMode(null);
    }
  };
  const editorial = snap.mode !== "advisory" && snap.mode !== "automatic" && snap.mode !== "assisted" ? MODE_INFO[snap.mode] : null;
  return (
    <>
      <div className="mode-select" role="radiogroup" aria-label={t("live.observerMode")}>
        {OBSERVER_MODES.map((m) => {
          const locked = m === "full_action" && !fullActionAvailable;
          return (
            <button
              key={m}
              role="radio"
              aria-checked={snap.observerMode === m}
              className={`mode-btn ${snap.observerMode === m ? "is-on" : ""}`}
              title={locked ? t("live.fullActionObserverComesWith") : OBSERVER_MODE_INFO[m].hint}
              disabled={directorReason !== null || busyMode !== null || locked}
              onClick={() => void setMode(m)}
            >
              {OBSERVER_MODE_INFO[m].label}
              {OBSERVER_MODE_INFO[m].topPlan && locked ? <span className="mode-plan">{t("live.topPlan")}</span> : null}
            </button>
          );
        })}
      </div>
      <p className="small muted mode-hint">
        {OBSERVER_MODE_INFO[snap.observerMode].hint}
        {editorial ? t("live.editorialModeLabel", { label: editorial.label }) : ""}
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
      <Details summary={t("live.topCandidates")}>
        <CandidateList candidates={snap.candidates} nameOf={nameOf} currentShot={snap.currentShot} />
      </Details>
      <Details summary={t("live.decisionDetails")}>
        <KV
          items={[
            ["Control", health ? <span key="h" title={health.hint}>{health.text}</span> : <span className="muted">{t("live.noDecisionYet")}</span>],
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
      toast.push("danger", t("live.directorControlFailed"), describeError(e));
    }
  };
  return (
    <div className="dir-controls">
      <fieldset>
        <legend>{t("live.disableCinematics")}</legend>
        <Checkbox checked={c.cinematicsDisabled.round !== null} disabled={!!reason} onChange={(v) => void call("/api/v1/director/cinematics", { scope: "round", disabled: v }, v ? t("live.cinematicsDisabledForThisRound") : t("live.cinematicsReEnabledForThis2"))} label={t("live.thisRound")} />
        <Checkbox checked={c.cinematicsDisabled.map !== null} disabled={!!reason} onChange={(v) => void call("/api/v1/director/cinematics", { scope: "map", disabled: v }, v ? t("live.cinematicsDisabledForThisMap") : t("live.cinematicsReEnabledForThis"))} label={t("live.thisMap")} />
        <Checkbox checked={c.cinematicsDisabled.match} disabled={!!reason} onChange={(v) => void call("/api/v1/director/cinematics", { scope: "match", disabled: v }, v ? t("live.cinematicsDisabledForTheMatch") : t("live.cinematicsReEnabledForThe"))} label={t("live.wholeMatch")} />
      </fieldset>
      <fieldset>
        <legend title={t("live.restrictPovChoicesToOne")}>{t("live.followOneSide")}</legend>
        <div className="seg" role="radiogroup" aria-label={t("live.oneSideProfile")}>
          {([null, "CT", "T"] as (Side | null)[]).map((sd) => (
            <button key={String(sd)} role="radio" aria-checked={c.oneSide === sd} className={`seg-btn ${c.oneSide === sd ? "is-on" : ""}`} disabled={!!reason} onClick={() => void call("/api/v1/director/one-side", { side: sd }, sd ? t("live.followingSdSideOnly", { sd }) : t("live.oneSideProfileOff"))}>
              {sd ?? t("live.bothSides")}
            </button>
          ))}
        </div>
      </fieldset>
      <fieldset>
        <legend>{t("live.replays")}</legend>
        <Checkbox checked={c.autoReplaysDisabled} disabled={!!reason} onChange={(v) => void call("/api/v1/director/auto-replays", { disabled: v }, v ? t("live.automaticReplaySuggestionsDisabled") : t("live.automaticReplaySuggestionsEnabled"))} label={t("live.disableAutomaticReplaySuggestions")} />
      </fieldset>
      {reason ? <p className="small muted">{reason}</p> : null}
    </div>
  );
}

const onOff = (v: boolean | null) => (v === null ? "?" : v ? "on" : "off");

function ProductionPanel({ snap }: { snap: OperatorSnapshot }) {
  const replays = useApi<ReplaysResponse>("/api/v1/replays", { refreshMs: 5000 });
  // Early replays (ADR-083): the live round's decision as it builds, and why replays went back to live.
  const auto = useApi<AutoReplayResponse>(snap.state?.roundPhase === "live" ? "/api/v1/replays/auto" : null, { refreshMs: 1000 });
  const early = snap.state?.roundPhase === "live" ? (auto.data?.status.early ?? null) : null;
  const prov = replays.data?.provider ?? null;
  const approved = replays.data?.items.filter((i) => i.state === "approved").length ?? 0;
  const src = snap.state?.sources ?? [];
  return (
    <>
      <KV
        items={[
          ["Program", <span key="p" title={t("live.ownerKind", { kind: snap.program.owner.kind })}>{titleCase(snap.program.mode.replace("_", " ").toLowerCase())}</span>],
          ["OBS", snap.obs.connected ? `${snap.obs.programScene ?? MISSING} (preview ${snap.obs.previewScene ?? MISSING})${snap.obs.studioMode ? " · studio mode" : ""}` : <Link key="o" to="/settings/devices">{t("live.notConnectedConnectInSettings")}</Link>],
          ["Replays", prov ? <span key="r" title={prov.health.detail}>{t("live.vApprovedApproved", { v: prov.health.ok ? t("live.ready") : t("live.notReadyDetail", { detail: prov.health.detail }), approved })}</span> : replays.data ? <Link key="r" to="/replays">{t("live.noReplayProviderSetUp")}</Link> : MISSING],
          ["Outputs", `Recording ${onOff(snap.obs.recording)} · streaming ${onOff(snap.obs.streaming)} · replay buffer ${onOff(snap.obs.replayBuffer)}`],
          ...(early ? [["Early replays", early.state === "decided" || early.state === "on_air" ? <strong key="e">{early.detail}</strong> : early.detail] as [string, ReactNode]] : []),
        ]}
      />
      <Details summary={t("live.telemetrySourcesCount", { count: src.length })}>
        <table className="table table-compact">
          <thead>
            <tr>
              <th>{t("live.source")}</th>
              <th>{t("live.health")}</th>
              <th>{t("live.packets")}</th>
              <th>{t("live.rejected")}</th>
              <th>{t("live.gaps")}</th>
              <th>{t("live.interval")}</th>
              <th>{t("live.build")}</th>
            </tr>
          </thead>
          <tbody>
            {src.length === 0 ? (
              <tr>
                <td colSpan={7} className="muted">{t("live.noTelemetrySourceYet")}</td>
              </tr>
            ) : (
              src.map((x) => (
                <tr key={x.sourceId}>
                  <td>{x.sourceId}</td>
                  <td>{x.stale ? t("live.stale") : x.connected ? "OK" : t("live.disconnected")}</td>
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

  const request = async (p: PlayerState, chase = false) => {
    setBusy(p.steamId);
    try {
      const r = await api.post<CommandResult>("/api/v1/observer/commands", { kind: "select_player", steamId: p.steamId, ...(chase ? { view: "chase" } : {}) });
      const d = describeCommandResult(r, p.name);
      toast.push(d.tone === "danger" ? "danger" : d.tone === "ok" ? "ok" : "info", d.text);
      if (r && isInFlight(r.status)) void followConfirmation(r.commandId, p.name, toast.push);
    } catch (e) {
      toast.push("danger", t("live.povRequestForNameFailed", { name: p.name }), describeError(e));
    } finally {
      setBusy(null);
    }
  };

  const requestRef = useRef(request);
  requestRef.current = request;

  const selGate = snap ? capabilityGate("playerSelectionControl", snap.capabilities.playerSelectionControl, { simulated: snap.simulated, allowUnverified: true }) : null;
  const cardReason = cameraReason ?? (selGate && !selGate.enabled ? selGate.reason : null);

  // Observer number keys (GSI observer slots) request a POV, like the in-game spectator keys.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || isTypingTarget(e.target)) return;
      // Shift + number key: the chase view (Shift changes e.key on most layouts, not e.code).
      const slot = slotFromKey(e.shiftKey && /^Digit\d$/.test(e.code) ? e.code.slice(5) : e.key);
      if (slot === null) return;
      const st = liveStore.state.snapshot?.state;
      const p = st?.players.find((x) => x.observerKey === slot && !x.coach);
      if (!p) return;
      if (cardReason) {
        toast.push("warn", t("live.keyKeyPovRequestUnavailable", { key: e.key }), cardReason);
        return;
      }
      e.preventDefault();
      void requestRef.current(p, e.shiftKey);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [cardReason, toast, requestRef]);

  if (!snap) return <div className="page"><h1 className="page-title">{t("live.liveControl")}</h1><EmptyState title={t("live.connectingToTheEngine")} /></div>;

  if (!snap.state) {
    return (
      <div className="page">
        <h1 className="page-title">{t("live.liveControl")}</h1>
        <AutoDirectorCard compact />
        <EmptyState
          title={t("live.noGameDataYet")}
          action={
            <>
              <Link to="/settings/setup" className="btn btn-primary btn-md">{t("live.openSetup")}</Link>{" "}
              <ActionButton action={() => api.post("/api/v1/simulation/start", { startOffsetSec: 25 })} success={t("live.simulationStartedLabelledSyntheticData")}>{t("live.startSimulation")}</ActionButton>
            </>
          }
        >{t("live.connectTheCs2ObserverClient")}</EmptyState>
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
  // A coach listed with a team: left out of the HUDs and never spectated.
  const setCoach = (p: PlayerState, coach: boolean) =>
    void api.put(`/api/v1/live/players/${seg(p.steamId)}/coach`, { coach }).then(
      () => toast.push("ok", coach ? t("live.nameIsTheCoach", { name: p.name }) : t("live.nameIsAPlayer", { name: p.name }), coach ? t("live.leftOutOfTheHuds") : t("live.backInTheHuds")),
      (e: unknown) => toast.push("danger", t("live.notChanged"), describeError(e)),
    );

  const column = (side: "CT" | "T") => {
    const team = sides[side].filter((p) => !p.coach);
    const coaches = sides[side].filter((p) => p.coach);
    return (
      <div className={`roster-col side-${side}`}>
        <h2 className="roster-head">
          <span className={`side-tag side-${side}`}>{side}</span> {s.teams[side].name ?? t("live.sideSide", { side })}
          <span className="roster-score">{s.teams[side].score ?? MISSING}</span>
        </h2>
        {team.length === 0 ? <p className="muted small">{t("live.noSidePlayersReported", { side })}</p> : null}
        {team.map((p) => (
          <RosterCard key={p.steamId} p={p} roles={rolesOf(p)} onRequest={(chase) => (cardReason ? toast.push("warn", t("live.povRequestUnavailable"), cardReason) : void request(p, chase))} disabledReason={cardReason} busy={busy === p.steamId} />
        ))}
        {coaches.map((p) => (
          <p key={p.steamId} className="roster-coach small muted"><T k="live.coachNameButton" values={{ name: p.name, button: <Button size="sm" variant="ghost" onClick={() => setCoach(p, false)}>{t("live.notACoach")}</Button> }} /></p>
        ))}
        {team.length > 5 ? (
          <div className="roster-coach small">
            <span>{t("live.moreThanFivePlayersWhich")}</span>
            {team.map((p) => (
              <Button key={p.steamId} size="sm" variant="ghost" onClick={() => setCoach(p, true)}>
                {p.name}
              </Button>
            ))}
          </div>
        ) : null}
      </div>
    );
  };

  return (
    <div className="page page-live">
      <h1 className="sr-only">{t("live.liveControl")}</h1>
      <MatchHeader snap={snap} />
      <SideTeamsLine />
      {cardReason ? (
        <Note tone="warn" title={t("live.povControlUnavailable")}><T k="live.cardreasonCardsStillShowTelemetry" values={{ cardReason }} tags={{ link: (c) => <Link to="/settings/setup">{c}</Link> }} /></Note>
      ) : null}
      <div className="live-grid">
        {column("CT")}
        <div className="live-center">
          <AutoDirectorCard compact />
          <Panel title={t("live.camera")} subtitle={t("live.clickAPlayerOrPress")}>
            <PovStatus snap={snap} />
          </Panel>
          <Panel title={t("live.observer")}>
            <ObserverModeSelect snap={snap} />
            <ActionsBar snap={snap} cameras={cameras} />
            <Details summary={t("live.options")}>
              <DirectorControls snap={snap} />
            </Details>
          </Panel>
          <Panel title={t("live.director")}>
            <DirectorPanel snap={snap} threshold={threshold} nameOf={nameOf} />
          </Panel>
        </div>
        {column("T")}
      </div>
      <div className="live-lower">
        <Panel title={t("live.matchTimeline")} className="panel-timeline">
          <Timeline nameOf={nameOf} />
        </Panel>
        <div className="stack">
          <MapIntroCard />
          <TeamCommsCard />
          <Panel title={t("live.utility")}>
            <OpportunityList opportunities={snap.opportunities} nameOf={nameOf} />
          </Panel>
          <Panel title={t("live.production")}>
            <ProductionPanel snap={snap} />
          </Panel>
        </div>
      </div>
      {s.players.length > 0 && sides.none.length > 0 ? <p className="small muted">{t("live.countPlayerSWithoutA", { count: sides.none.length, join: sides.none.map((p) => p.name).join(", ") })}</p> : null}
    </div>
  );
}
