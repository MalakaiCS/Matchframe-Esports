import type { Logger } from "../logger.ts";
import type { MixBlock } from "./mixer.ts";
import type { SlotId, TeamComms } from "./service.ts";

/**
 * The public listen-in's one output-state controller (ADR-066). Every public action goes through
 * here, and only here moves the public gate (TeamComms.setPublicTeam):
 *
 * - **OFF:** closed. At startup, after End Listen-In, after Mute All Comms. Never saved open: a new
 *   controller (a restart) is always OFF.
 * - **BUFFERING — team:** a listen-in is held for a team whose delayed audio isn't complete at the
 *   playhead (a longer delay re-buffering after a delay change, or audio dropped by the memory cap):
 *   silent until it is, then on air again by itself (the operator's Listen In still stands; nothing
 *   was reset).
 * - **LISTENING IN — team:** that team's permitted, delayed voices are on air.
 * - **FAULT:** the listen-in was closed by a failure (its team's TeamSpeak source lost, the bridge or a
 *   slot reset, the public output stopped) or the public output can't carry comms. Silent. Only an
 *   explicit new Listen In opens it again; End Listen-In acknowledges it (OFF).
 *
 * Listen In refuses to open until the team's buffer holds the configured delay (never a fresh or
 * partial buffer, never undelayed audio). Teams are the match's team ids, never CT/T. Recording and
 * preview never call into this: they can't open the public gate.
 */

export type PublicState = "off" | "buffering" | "listening" | "fault";

export interface ListenInTeam {
  id: string;
  slot: SlotId;
  name: string;
  shortName: string | null;
  logoUrl: string | null;
  color: string | null;
}

export interface ListenInAction {
  teamId: string;
  slot: SlotId;
  /** "Listen In — Alpha Wolves". */
  label: string;
  ready: boolean;
  readyInMs: number | null;
  /** Why the button can't open the listen-in now (null: it can). */
  disabledReason: string | null;
}

export interface ListenInView {
  state: PublicState;
  /** The state in words (the console never shows it by colour alone): OFF, BUFFERING — TEAM, LISTENING IN — TEAM, FAULT. */
  label: string;
  /** What the state means now, in a sentence. */
  detail: string;
  /** The team the listen-in is for (null when closed). */
  team: ListenInTeam | null;
  /** The team heard on the public output this block (null while closed or switching through silence). */
  heardTeamId: string | null;
  /** Closed with Mute All Comms (and not opened since). */
  muted: boolean;
  fault: { reason: string; at: string } | null;
  since: string;
  actions: ListenInAction[];
  end: { disabledReason: string | null };
  muteAll: { disabledReason: string | null };
}

export class ListenInError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ListenInError";
  }
}

export interface ListenInDeps {
  comms: TeamComms;
  logger: Pick<Logger, "info" | "warn">;
  /** Why the public output can't carry comms now (its NDI sender isn't running), or null. */
  outputProblem: () => string | null;
  /** The public output failed (not just starting): FAULT even with no listen-in open. */
  outputFailed?: () => boolean;
}

const secs = (ms: number | null) => (ms === null ? "" : `${Math.max(1, Math.ceil(ms / 1000))} s`);

export class ListenInController {
  private target: string | null = null;
  private muted = false;
  private faulted: { reason: string; at: string } | null = null;
  private offDetail = "Closed at start: only Listen In puts a team's comms on air.";
  private state: PublicState = "off";
  private heard: string | null = null;
  private since = new Date().toISOString();
  private sig = "";
  private readonly listeners = new Set<(v: ListenInView) => void>();
  private readonly offs: (() => void)[] = [];

  constructor(private readonly d: ListenInDeps) {
    // Closed at start, whatever the mixer held (a new controller is a restart).
    d.comms.setPublicTeam(null);
    this.offs.push(d.comms.onPublicClosed((reason) => this.fault(reason)));
    this.offs.push(d.comms.onBlock((b) => this.onBlock(b)));
    this.update();
  }

  dispose(): void {
    for (const off of this.offs.splice(0)) off();
  }

  /** Called with the new view whenever the state, team, heard team, mute or fault changes. */
  onChange(fn: (v: ListenInView) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Listen In — [team]: closes the other team's comms (through silence) and opens this team's permitted, delayed voices. */
  listenIn(teamId: string, who = "operator"): ListenInView {
    const c = this.d.comms;
    if (!c.enabled) throw new ListenInError(409, "comms_off", "Team Comms is off: switch it on first (Team Comms → Bridge and plugin).");
    const team = this.teamOf(teamId);
    if (!team) throw new ListenInError(404, "no_team", "That team isn't one of the active match's teams (Team Comms slots A and B).");
    const problem = this.d.outputProblem();
    if (problem) throw new ListenInError(409, "output_fault", problem);
    const r = c.teamReadiness(teamId)!;
    if (!r.ready) throw new ListenInError(409, "not_ready", `${team.name} isn't ready: ${this.notReady(r)}`);
    if (this.target === teamId && !this.faulted) return this.view();
    this.target = teamId;
    this.muted = false;
    this.faulted = null;
    c.setPublicTeam(teamId);
    this.d.logger.info("team comms: listen in", { team: team.name, by: who });
    this.update(true);
    return this.view();
  }

  /** End Listen-In: closes public comms (and acknowledges a fault). */
  end(who = "operator"): ListenInView {
    const was = this.target;
    this.target = null;
    this.muted = false;
    this.faulted = null;
    this.offDetail = was ? "Ended by the operator." : "Public comms are closed.";
    this.d.comms.setPublicTeam(null);
    if (was) this.d.logger.info("team comms: listen-in ended", { by: who });
    this.update(true);
    return this.view();
  }

  /** Mute All Comms: the public route silent at once. The recording mix and the preview carry on. */
  muteAll(who = "operator"): ListenInView {
    this.target = null;
    this.muted = true;
    this.faulted = null;
    this.offDetail = "Muted with Mute All Comms. The recording and the operator's preview carry on.";
    this.d.comms.mutePublic();
    this.d.logger.warn("team comms: Mute All Comms", { by: who });
    this.update(true);
    return this.view();
  }

  /** The gate closed by a failure (the service closed it, the public output stopped or failed). */
  fault(reason: string): void {
    if (this.target === null) return this.update(true);
    this.target = null;
    this.faulted = { reason, at: new Date().toISOString() };
    this.d.comms.setPublicTeam(null);
    this.d.logger.warn("team comms: public listen-in closed by a fault", { reason });
    this.update(true);
  }

  private onBlock(b: MixBlock): void {
    this.heard = b.public.team;
    if (this.target !== null) {
      const problem = this.d.outputProblem();
      if (problem) return this.fault(problem);
    }
    this.update(false, b.playhead);
  }

  private teamOf(teamId: string): ListenInTeam | null {
    const slot = this.d.comms.status().slots.find((s) => s.team?.id === teamId);
    if (!slot?.team) return null;
    return { id: teamId, slot: slot.id, name: slot.team.name ?? `Team ${slot.id}`, shortName: slot.team.shortName, logoUrl: slot.team.logoUrl, color: slot.team.color };
  }

  private notReady(r: { state: string; readyInMs: number | null; issue: string | null }): string {
    if (r.state === "buffering") return r.readyInMs !== null ? `its buffer doesn't hold the delay yet (ready in about ${secs(r.readyInMs)})` : "its buffer doesn't hold the delay yet";
    if (r.state === "off") return "Team Comms is off";
    return r.issue ?? (r.state === "waiting" ? "its TeamSpeak tab isn't connected in the team's channel" : `its TeamSpeak tab is ${r.state}`);
  }

  private compute(playhead?: number): PublicState {
    if (!this.d.comms.enabled) return "off";
    if (this.faulted) return "fault";
    if (this.target === null) return this.d.outputFailed?.() ? "fault" : "off";
    const ready = playhead !== undefined ? this.d.comms.readyAt(this.target, playhead) : (this.d.comms.teamReadiness(this.target)?.ready ?? false);
    return ready ? "listening" : "buffering";
  }

  private update(force = false, playhead?: number): void {
    const state = this.compute(playhead);
    const sig = `${state}|${this.target}|${this.heard}|${this.muted}|${this.faulted?.reason ?? ""}`;
    if (!force && sig === this.sig) return;
    if (state !== this.state) this.since = new Date().toISOString();
    this.state = state;
    this.sig = sig;
    if (this.listeners.size === 0) return;
    const v = this.view();
    for (const fn of this.listeners) fn(v);
  }

  /** The public state, for the console, the overlay and the support file. */
  view(): ListenInView {
    const c = this.d.comms;
    const enabled = c.enabled;
    const team = this.target ? this.teamOf(this.target) : null;
    const problem = enabled ? this.d.outputProblem() : null;
    // Blocks stop while Team Comms is off: nothing would refresh the state then.
    const state: PublicState = enabled ? this.state : "off";
    const name = (team?.name ?? "").toUpperCase();
    const label = state === "listening" ? `LISTENING IN — ${name}` : state === "buffering" ? `BUFFERING — ${name}` : state === "fault" ? "FAULT" : this.muted ? "OFF — MUTED" : "OFF";
    let detail: string;
    if (!enabled) detail = "Team Comms is off.";
    else if (state === "fault") detail = this.faulted ? `Closed by a fault: ${this.faulted.reason}. Silent; press Listen In again once the team is ready (End Listen-In clears this).` : `The public output can't carry comms: ${problem}`;
    else if (state === "listening") detail = `${team?.name}'s permitted, delayed voices are on air.`;
    else if (state === "buffering") {
      const r = this.target ? c.teamReadiness(this.target) : null;
      detail = `${team?.name}'s delayed audio isn't complete at the playhead: silent until it is${r?.readyInMs != null ? ` (about ${secs(r.readyInMs)})` : ""}.`;
    } else detail = this.offDetail;
    const actions: ListenInAction[] = [];
    for (const s of c.status().slots) {
      if (!s.team) continue;
      const r = c.teamReadiness(s.team.id);
      const tname = s.team.name ?? `Team ${s.id}`;
      const disabledReason = !enabled
        ? "Team Comms is off"
        : problem
          ? problem
          : !r?.ready
            ? `Not ready: ${r ? this.notReady(r) : "no TeamSpeak source"}`
            : this.target === s.team.id && state !== "fault"
              ? `${tname} is on air`
              : null;
      actions.push({ teamId: s.team.id, slot: s.id, label: `Listen In — ${tname}`, ready: !!r?.ready, readyInMs: r?.readyInMs ?? null, disabledReason });
    }
    return {
      state,
      label,
      detail,
      team,
      heardTeamId: this.heard,
      muted: this.muted,
      fault: this.faulted,
      since: this.since,
      actions,
      end: { disabledReason: this.target === null && !this.faulted ? "No listen-in is open" : null },
      muteAll: { disabledReason: enabled ? null : "Team Comms is off" },
    };
  }

  /** Overlay and ducking: whether a team's comms are on air (listening), and which. */
  get onAir(): ListenInTeam | null {
    return this.state === "listening" && this.target ? this.teamOf(this.target) : null;
  }

  /** The listen-in is held (listening or buffering): caster ducking stays on through a short resync. */
  get open(): boolean {
    return this.target !== null && !this.faulted;
  }

  get publicState(): PublicState {
    return this.state;
  }
}
