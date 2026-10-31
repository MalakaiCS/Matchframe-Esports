import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ClipRecord, QueueItem, ReplayPlay } from "@matchframe/replay-agent";
import type { Engine } from "../app.ts";
import type { AutoReplay, TraceEvent } from "./auto.ts";
import { replayLabel } from "./link.ts";
import { VmixClient } from "./vmix.ts";

/**
 * Test replays (ADR-062): two sample clips (bundled with the program: different colours, big "Test
 * clip 1"/"Test clip 2", a tone) played on the program output through the same path as a break's
 * replays (auto.ts: playObsTwin or playVmix, the transitions, the fade between, the live audio turned
 * down), then a report, step by step, of what worked and how to fix what didn't. The clips are
 * unlisted in the replay queue (never ranked, never in a break or a highlight; found only by their id
 * while they play, so the replay graphic can show their play) and gone afterwards. It refuses while a
 * round is live, while the program isn't live, and while a break's replays play or are about to.
 */

export interface TestStep {
  id: "ready" | "in" | "fade" | "out" | "live" | "audio";
  label: string;
  state: "pending" | "ok" | "failed" | "skipped";
  detail: string;
  /** What to do about a step that failed. */
  fix: string | null;
}

export interface TestReport {
  state: "running" | "passed" | "failed";
  mixer: "obs" | "vmix";
  startedAt: string;
  finishedAt: string | null;
  steps: TestStep[];
}

/** The two sample clips (assets/replay-test, 1280×720 30 fps H.264 with 1 s keyframes, AAC stereo tone; 4 s each). */
export const TEST_CLIPS: { file: string; durationMs: number; play: ReplayPlay }[] = [
  { file: "test-clip-1.mp4", durationMs: 4000, play: { kind: "shown", killer: { steamId: "matchframe-test", name: "Test Player" }, victims: ["Test Opponent"], kills: 1, weapon: "ak47", headshot: true } },
  { file: "test-clip-2.mp4", durationMs: 4000, play: { kind: "missed", killer: { steamId: "matchframe-test", name: "Test Player" }, victims: ["Test Opponent", "Second Opponent"], kills: 2, weapon: "awp", headshot: false } },
];

/**
 * The folder with the sample clips: MATCHFRAME_REPLAY_TEST_DIR (set by the program), the installed
 * program's `replay-test` beside its engine, or the repository's assets/replay-test in development.
 */
export function testClipsDir(): string | null {
  const has = (d: string) => TEST_CLIPS.every((c) => existsSync(join(d, c.file)));
  const env = process.env.MATCHFRAME_REPLAY_TEST_DIR;
  if (env && has(env)) return env;
  const here = dirname(fileURLToPath(import.meta.url));
  if (has(join(here, "..", "replay-test"))) return join(here, "..", "replay-test");
  for (let d = here, k = 0; k < 7; k++, d = dirname(d)) if (has(join(d, "assets", "replay-test"))) return join(d, "assets", "replay-test");
  return null;
}

const refuse = (message: string) => Object.assign(new Error(message), { status: 409, code: "test_refused" });
/** OBS's multiplier read back may differ in the last bits from the one set. */
const SAME = (a: number, b: number) => Math.abs(a - b) <= 1e-4 * Math.max(1, Math.abs(b));

export class ReplayTest {
  private last: TestReport | null = null;
  private busy = false;

  constructor(
    private readonly e: Engine,
    private readonly auto: AutoReplay,
  ) {}

  report(): TestReport | null {
    return this.last ? { ...this.last, steps: this.last.steps.map((s) => ({ ...s })) } : null;
  }

  private step(id: TestStep["id"], patch: Partial<TestStep>): void {
    const s = this.last?.steps.find((x) => x.id === id);
    if (s) Object.assign(s, patch);
  }

  /** Starts Test replays (the report fills in as they play); throws why when they can't play now. */
  async start(): Promise<TestReport> {
    if (this.busy) throw refuse("Test replays are playing already.");
    const st = this.auto.settings();
    if (st.mixer === "vmix") await this.auto.checkVmix();
    const why = this.auto.testBlocked();
    if (why) throw refuse(why);
    const dir = testClipsDir();
    if (!dir) throw refuse("The sample clips aren't installed with the program (its replay-test folder): reinstall Matchframe.");
    this.busy = true;
    try {
      const between = st.between === "fade" ? `Fade (${st.fadeMs / 1000} s) between the clips` : "Cut between the clips";
      this.last = {
        state: "running",
        mixer: st.mixer,
        startedAt: new Date().toISOString(),
        finishedAt: null,
        steps: [
          { id: "ready", label: st.mixer === "vmix" ? "vMix ready" : "Replay scene and twin ready", state: "pending", detail: "", fix: null },
          { id: "in", label: "Transition in (Replay in)", state: "pending", detail: "", fix: null },
          { id: "fade", label: between, state: "pending", detail: "", fix: null },
          { id: "out", label: "Transition out (Replay out)", state: "pending", detail: "", fix: null },
          { id: "live", label: "Back live", state: "pending", detail: "", fix: null },
          { id: "audio", label: "Live audio turned down and put back", state: "pending", detail: "", fix: null },
        ],
      };
      await this.checkReady();
      const before = await this.audioNow();
      const items = TEST_CLIPS.map((c, k) => {
        const clip: ClipRecord = { clipId: `clip_test_${k + 1}`, providerId: "matchframe-test", sourceId: "matchframe-test", angle: "recorded_angle", matchTimeFromMs: null, matchTimeToMs: null, timeUncertaintyMs: null, epoch: null, roundNumber: null, media: { path: join(dir, c.file), durationMs: c.durationMs, frameRate: 30, timebase: null, startPts: null, hasAudio: true, width: 1280, height: 720 }, createdAt: new Date().toISOString() };
        return this.e.replays.addUnlisted(`Test clip ${k + 1}: ${replayLabel(c.play)}`, clip, { playMs: c.durationMs, leadMs: null, play: c.play });
      });
      this.e.audit.record("replay-test", "replay.test_started", null, { mixer: st.mixer });
      void this.run(items, before).finally(() => (this.busy = false));
      return this.report()!;
    } catch (err) {
      this.busy = false;
      throw err;
    }
  }

  private async checkReady(): Promise<void> {
    const st = this.auto.settings();
    if (st.mixer === "vmix") {
      const v = this.auto.getStatus().vmix;
      this.step("ready", { state: "ok", detail: `vMix ${v?.version ?? ""} answers at ${st.vmixUrl}.` });
      return;
    }
    const replay = this.e.program.sceneMap.REPLAY;
    const media = this.e.settings.get<string | null>("replay.mediaInput", null);
    const twin = await this.e.replayTwin.sync().catch(() => null);
    if (twin) this.step("ready", { state: "ok", detail: `“${replay}” with “${media}”, and its twin “${twin.scene}” for the fade.` });
    else this.step("ready", { state: "failed", detail: `“${replay}” with “${media}”, but no twin: ${this.e.replayTwin.getStatus().detail}`, fix: "Press Set up OBS replay scene. With your own replay scene, put its media source directly in the scene (not in a group) and make it a Media Source." });
  }

  /** The live game audio picked, as it is now (to check it comes back exactly). */
  private async audioNow(): Promise<Map<string, { volume: number; muted: boolean }>> {
    const st = this.auto.settings();
    const out = new Map<string, { volume: number; muted: boolean }>();
    if (st.mixer === "vmix") {
      const state = await new VmixClient(st.vmixUrl).state().catch(() => null);
      for (const key of st.duckVmixInputs) {
        const x = state?.inputs.find((i) => i.key === key);
        if (x && x.volume !== null) out.set(x.title, { volume: x.volume, muted: x.muted === true });
      }
    } else {
      for (const name of st.duckInputs) {
        const v = await this.e.obs.inputVolume(name).catch(() => null);
        if (v) out.set(name, { volume: v.mul, muted: v.muted });
      }
    }
    return out;
  }

  private onEvent(ev: TraceEvent): void {
    const st = this.auto.settings();
    const obs = st.mixer === "obs";
    const own = "OBS's current transition";
    if (ev.type === "in") {
      const replay = this.e.program.replayScenes;
      const ok = ev.confirmed && (!obs || ev.scene === null || replay.includes(ev.scene));
      this.step("in", ok ? { state: "ok", detail: `${ev.transition ?? own} to ${obs ? `“${ev.scene}”` : `the first clip (${ev.scene})`}.` } : { state: "failed", detail: `The program didn't go to the replay scene (OBS shows “${ev.scene ?? "?"}”).`, fix: "Check the replay scene in OBS scenes, and that the Replay in transition still exists in OBS (Scene Transitions)." });
    } else if (ev.type === "between") {
      this.step("fade", ev.confirmed ? { state: "ok", detail: `${ev.transition ?? own} to ${obs ? `“${ev.scene}”` : `the second clip (${ev.scene})`}.` } : { state: "failed", detail: `OBS didn't confirm “${ev.scene}” on program.`, fix: "Leave the second replay scene to Matchframe, and keep a Fade among OBS's transitions." });
    } else if (ev.type === "one-source") {
      this.step("fade", { state: "failed", detail: `No fade: the clips played one after the other in the replay scene's one media source (${ev.why})`, fix: "Press Set up OBS replay scene, or put your replay media source directly in your replay scene (not in a group)." });
    } else if (ev.type === "clip" && !ev.ok) {
      const first = this.last?.steps.find((s) => s.id === "in")?.state === "pending";
      this.step(first ? "in" : "fade", { state: "failed", detail: `The sample clip didn't play: ${ev.error}.`, fix: obs ? "The replay media source must be a Media Source playing local files. Check OBS can read the program's replay-test folder." : "vMix must be able to add a video input from the program's replay-test folder." });
    } else if (ev.type === "out") {
      this.step("out", ev.confirmed ? { state: "ok", detail: `${ev.transition ?? own} back to “${ev.scene ?? "?"}”.` } : { state: "failed", detail: ev.error ?? "The mixer didn't go back to the live scene.", fix: obs ? "Map your live scene in OBS scenes." : "Put your live input back on air in vMix." });
    } else if (ev.type === "audio-down") {
      this.step("audio", { detail: ev.inputs.length ? `Turned down: ${ev.inputs.join(", ")}.` : "" });
    } else if (ev.type === "audio-back" && !ev.ok) {
      this.step("audio", { state: "failed", detail: ev.detail, fix: "Set the volume back in the mixer by hand; Matchframe tries again as soon as the mixer answers." });
    }
  }

  private async run(items: QueueItem[], before: Map<string, { volume: number; muted: boolean }>): Promise<void> {
    const st = this.auto.settings();
    let result: Awaited<ReturnType<AutoReplay["playTest"]>>;
    try {
      result = await this.auto.playTest(items, (ev) => this.onEvent(ev));
    } catch (err) {
      this.e.logger.warn("test replays: stopped by an error", { error: String(err) });
      result = { played: 0, failed: items.length, error: err instanceof Error ? err.message : String(err), stopped: null };
    } finally {
      for (const it of items) this.e.replays.removeUnlisted(it.id);
    }
    const why = result.stopped === "stopped" ? "Stopped by the operator." : result.stopped === "deadline" ? "A round went live: the test stopped." : result.stopped === "taken" ? "Someone else changed the program during the test." : result.error ? `It stopped: ${result.error}.` : "It didn't happen.";
    for (const id of ["in", "fade", "out"] as const) {
      const s = this.last!.steps.find((x) => x.id === id)!;
      if (s.state === "pending") Object.assign(s, { state: "failed", detail: why, fix: s.fix ?? (result.stopped === "taken" ? "Run the test while nobody else changes the program." : null) });
    }
    await this.checkLive(st.mixer);
    await this.checkAudio(before);
    const failed = this.last!.steps.some((s) => s.state === "failed");
    this.last = { ...this.last!, state: failed ? "failed" : "passed", finishedAt: new Date().toISOString() };
    this.e.audit.record("replay-test", "replay.test_finished", null, { passed: !failed, failed: this.last.steps.filter((s) => s.state === "failed").map((s) => s.id) });
  }

  /** Back on the live scene (OBS: the program live and OBS on the live scene, once the transition out is over). */
  private async checkLive(mixer: "obs" | "vmix"): Promise<void> {
    if (mixer === "vmix") {
      const state = await new VmixClient(this.auto.settings().vmixUrl).state().catch(() => null);
      const on = state?.inputs.find((i) => i.number === state.active);
      const ok = !!on && !TEST_CLIPS.some((c) => on.title.includes(c.file.replace(/\.mp4$/, "")));
      this.step("live", ok ? { state: "ok", detail: `vMix shows “${on!.title}”.` } : { state: "failed", detail: state ? `vMix still shows “${on?.title ?? "?"}”.` : "vMix didn't answer.", fix: "Put your live input back on air in vMix." });
      return;
    }
    const live = this.e.program.sceneMap.LIVE;
    for (let k = 0; k < 40 && !(this.e.program.mode === "LIVE" && (!live || this.e.obs.state.programScene === live)); k++) await new Promise((r) => setTimeout(r, 100));
    const ok = this.e.program.mode === "LIVE" && (!live || this.e.obs.state.programScene === live);
    this.step("live", ok ? { state: "ok", detail: live ? `OBS shows “${live}”, the program is live.` : "The program is live (no live scene mapped)." } : { state: "failed", detail: `The program is ${this.e.program.mode.replace(/_/g, " ").toLowerCase()}, OBS shows “${this.e.obs.state.programScene ?? "?"}”.`, fix: "Press Return live at the top of Replays & Production, and map your live scene in OBS scenes." });
  }

  /** The live game audio picked is back at its exact volume and mute. */
  private async checkAudio(before: Map<string, { volume: number; muted: boolean }>): Promise<void> {
    const st = this.auto.settings();
    const picked = st.mixer === "vmix" ? st.duckVmixInputs : st.duckInputs;
    if (!picked.length) {
      this.step("audio", { state: "skipped", detail: "No live game audio picked: nothing was turned down (Automatic replays → Sound).", fix: null });
      return;
    }
    const s = this.last!.steps.find((x) => x.id === "audio")!;
    if (s.state === "failed") return;
    const lowered = s.detail;
    if (!before.size) {
      this.step("audio", { state: "failed", detail: `None of the live game audio inputs picked was found (${picked.join(", ")}).`, fix: "Pick them again under Automatic replays → Sound: an input renamed in the mixer isn't found." });
      return;
    }
    const after = await this.audioNow();
    const wrong = [...before].filter(([name, b]) => {
      const a = after.get(name);
      return !a || a.muted !== b.muted || !(st.mixer === "vmix" ? Math.abs(a.volume - b.volume) <= 0.5 : SAME(a.volume, b.volume));
    });
    if (!lowered) this.step("audio", { state: "failed", detail: "The live game audio wasn't turned down.", fix: "Check the inputs picked under Automatic replays → Sound still exist in the mixer." });
    else if (wrong.length) this.step("audio", { state: "failed", detail: `${lowered} Not back as before: ${wrong.map(([n]) => n).join(", ")}.`, fix: "Set them back in the mixer by hand; if someone moved a fader during the test, it was left as they put it." });
    else this.step("audio", { state: "ok", detail: `${lowered} Put back exactly as before (${st.duckTo === "mute" ? "muted" : `${st.duckTo} dB`} during the replays).` });
  }
}
