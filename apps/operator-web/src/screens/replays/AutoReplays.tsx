import { useEffect, useRef, useState } from "react";
import { api, describeError } from "../../api/index.ts";
import type { AutoReplayResponse, AutoReplaySettings, NetworkInfo, RankedReplay, ReplayAudioInputs, ReplayFeedResponse, ReplayPcResponse, ReplayTestReport } from "../../api/types.ts";
import { ActionButton, Badge, Button, Checkbox, CopyButton, Field, Note, Panel, Tabs } from "../../components/ui.tsx";
import { useToast } from "../../components/toasts.tsx";
import { useApi } from "../../lib/hooks.ts";
import { REPLAY_KEYS, replayHotkeys, shortcutLabel, type ReplayHotkeyState, type ReplayKeyAction } from "../../lib/replay-keys.ts";
import { useSnapshot } from "../../state/live.ts";
import { usePermission } from "../../state/session.tsx";

const STATE_TONE = { off: "neutral", waiting: "info", playing: "accent", blocked: "warn" } as const;
const SPEEDS = [100, 75, 50] as const;

const RANKED_STATE: Record<RankedReplay["state"], { label: string; tone: "ok" | "accent" | "info" | "neutral" }> = {
  played: { label: "Played", tone: "ok" },
  picked: { label: "On air", tone: "accent" },
  waiting: { label: "Waiting", tone: "info" },
  duplicate: { label: "Same kills", tone: "neutral" },
  left: { label: "Not played", tone: "neutral" },
};
const TRANSITIONS = [
  { id: "CutDirect", label: "Cut" },
  { id: "Fade", label: "Fade" },
  { id: "Stinger1", label: "Stinger 1" },
  { id: "Stinger2", label: "Stinger 2" },
] as const;
/** When the break's replays end: by a time on the next round's clock (seconds left), or before it starts. */
const CUT_BACK = [112, 110, 105, 100, 95, 90] as const;
const FADES = [300, 500, 750, 1000] as const;
/** The replay media sources' volume: as set in OBS (null), or in dB. */
const REPLAY_VOLUMES = [null, 6, 3, 0, -3, -6, -10] as const;
/** The live game audio during replays: muted, or this many dB down. */
const DUCK_TO = ["mute", -10, -20, -30] as const;
const STEP_TONE = { pending: "neutral", ok: "ok", failed: "warn", skipped: "neutral" } as const;
const STEP_LABEL = { pending: "…", ok: "OK", failed: "Failed", skipped: "Skipped" } as const;
/** A round clock time as CS2 shows it (110 → 1:50). */
const clock = (sec: number) => `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;

/**
 * Main PC: replays play by themselves in the break after a round. The round's clips (from the
 * replay PC, and this computer's own 3K+ and clutches) are ranked, and the best ones that fit play
 * back to back, in round order or best first, in OBS or vMix.
 */
export function AutoReplaysPanel() {
  const auto = useApi<AutoReplayResponse>("/api/v1/replays/auto", { refreshMs: 1000 });
  const reason = usePermission("replay.control");
  const setupReason = usePermission("settings.manage");
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const save = async (patch: Partial<AutoReplaySettings>) => {
    setBusy(true);
    try {
      auto.setData(await api.put<AutoReplayResponse>("/api/v1/replays/auto", patch));
    } catch (e) {
      toast.push("danger", "Setting not saved", describeError(e));
    } finally {
      setBusy(false);
    }
  };
  const st = auto.data?.settings;
  const status = auto.data?.status;
  const off = !!reason || busy || !st;
  const [vmixUrl, setVmixUrl] = useState("");
  useEffect(() => {
    if (st?.vmixUrl) setVmixUrl(st.vmixUrl);
  }, [st?.vmixUrl]);
  const ranked = status?.ranked ?? [];
  /** A control or a clip's Exclude / Pin: the answer is the panel's new state. */
  const control = async (path: string, body?: unknown, method: "POST" | "PUT" = "POST") => {
    try {
      auto.setData(await (method === "PUT" ? api.put<AutoReplayResponse>(path, body) : api.post<AutoReplayResponse>(path, body)));
    } catch (e) {
      toast.push("warn", "Replays", describeError(e));
    }
  };
  return (
    <Panel title="Automatic replays" subtitle={status?.detail} actions={status ? <Badge tone={STATE_TONE[status.state]}>{status.state === "playing" ? (status.held ? "Held" : "Playing") : status.enabled ? "On" : "Off"}</Badge> : null}>
      <div className="stack-sm">
        {status?.running ? (
          <div className="row" role="group" aria-label="Replays playing now">
            <Button variant="primary" disabledReason={reason} title={`Ends the clip on air now (${shortcutLabel("F5")})`} onClick={() => void control("/api/v1/replays/auto/skip")}>
              Skip
            </Button>
            <Button variant={status.held ? "primary" : "secondary"} disabledReason={reason} title={`${status.held ? "Plays it on" : "Pauses the clip on air"} (${shortcutLabel("F6")})`} onClick={() => void control("/api/v1/replays/auto/hold", { held: !status.held })}>
              {status.held ? "Resume" : "Hold"}
            </Button>
            <Button variant="danger" disabledReason={reason} title={`Back to the live scene now, with Replay out (${shortcutLabel("F7")})`} onClick={() => void control("/api/v1/replays/auto/stop")}>
              Stop and go live
            </Button>
            <span className="muted small">{status.held ? "Held: nothing plays on until Resume. The round clock still cuts back to live." : `${shortcutLabel("F5")} Skip · ${shortcutLabel("F6")} Hold · ${shortcutLabel("F7")} Stop`}</span>
          </div>
        ) : null}
        <Checkbox
          checked={st?.enabled ?? false}
          disabled={off}
          label="Play replays by themselves"
          hint={`In the break after a round: from a few seconds after it ends until ${st?.cutBack === "before_round" ? "just before the next round starts" : `the next round's clock reads ${clock(st?.cutBackClockSec ?? 110)}`}, one transition to the replays and one back to live. They never start once the next round is live.`}
          onChange={(v) => void save({ enabled: v })}
        />
        <div className="form-grid">
          <Field label="Replays per break" hint="The best clips of the round that fit in the break; the rest are left.">
            <select value={st?.perBreak ?? 4} disabled={off} onChange={(e) => void save({ perBreak: Number(e.target.value) })}>
              {[1, 2, 3, 4].map((n) => (
                <option key={n} value={n}>
                  {n === 1 ? "The best one" : `The best ${n}`}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Order" hint="The chosen clips play back to back. Round order: from the start of the round to its end. Best first: the best one first.">
            <select value={st?.order ?? "round"} disabled={off} onChange={(e) => void save({ order: e.target.value as AutoReplaySettings["order"] })}>
              <option value="round">Round order</option>
              <option value="best">Best first</option>
            </select>
          </Field>
          <Field label="Back to live" hint="Replays may run on into the next round while the teams leave spawn: the cut back to live starts by this time on its clock (CS2's round starts at 1:55). The bomb planted, or the round over, ends them at once.">
            <select
              value={st?.cutBack === "before_round" ? "before_round" : String(st?.cutBackClockSec ?? 110)}
              disabled={off}
              onChange={(e) => void save(e.target.value === "before_round" ? { cutBack: "before_round" } : { cutBack: "clock", cutBackClockSec: Number(e.target.value) })}
            >
              {[...CUT_BACK, ...(st?.cutBackClockSec && !(CUT_BACK as readonly number[]).includes(st.cutBackClockSec) ? [st.cutBackClockSec] : [])].map((sec) => (
                <option key={sec} value={String(sec)}>
                  {`By ${clock(sec)} on the round clock${sec === 110 ? " (recommended)" : ""}`}
                </option>
              ))}
              <option value="before_round">Before the round starts</option>
            </select>
          </Field>
          <Field label="Between replays" hint="The end of one replay fades into the start of the next. In OBS through a second replay scene Matchframe keeps the same as yours.">
            <select value={st?.between === "cut" ? "cut" : String(st?.fadeMs ?? 500)} disabled={off} onChange={(e) => void save(e.target.value === "cut" ? { between: "cut" } : { between: "fade", fadeMs: Number(e.target.value) })}>
              {[...FADES, ...(st?.fadeMs && !(FADES as readonly number[]).includes(st.fadeMs) ? [st.fadeMs] : [])].map((ms) => (
                <option key={ms} value={String(ms)}>
                  {`Fade, ${ms / 1000} s${ms === 500 ? " (recommended)" : ""}`}
                </option>
              ))}
              <option value="cut">Cut</option>
            </select>
          </Field>
          <Field label="Speed">
            <select value={st?.speedPercent ?? 100} disabled={off} onChange={(e) => void save({ speedPercent: Number(e.target.value) })}>
              {SPEEDS.map((s) => (
                <option key={s} value={s}>
                  {s === 100 ? "Real time" : `Slow motion (${s} %)`}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <Checkbox checked={st?.otherAngles ?? true} disabled={off} label="Other angles" hint="When the main camera showed only the player who died, replay it from the killer's side (from the replay PC)." onChange={(v) => void save({ otherAngles: v })} />
        <Checkbox checked={st?.ownBigPlays ?? true} disabled={off} label="Replay big plays shown live" hint="When the main camera shows a 3K or more, save this computer's OBS replay buffer and replay it too." onChange={(v) => void save({ ownBigPlays: v })} />
        <Field label="Play replays in">
          <select value={st?.mixer ?? "obs"} disabled={off} onChange={(e) => void save({ mixer: e.target.value as AutoReplaySettings["mixer"] })}>
            <option value="obs">OBS</option>
            <option value="vmix">vMix</option>
          </select>
        </Field>
        {st?.mixer === "vmix" ? (
          <div className="stack-sm">
            <div className="form-grid">
              <Field label="vMix address" hint="vMix on this computer, with its Web Controller on (vMix → Settings → Web Controller).">
                <input value={vmixUrl} disabled={off} spellCheck={false} onChange={(e) => setVmixUrl(e.target.value)} onBlur={() => vmixUrl !== st.vmixUrl && void save({ vmixUrl })} placeholder="http://127.0.0.1:8088" />
              </Field>
              <Field label="Replay in" hint="To the first replay. Stingers use vMix's own Stinger 1 or 2.">
                <select value={st.vmixTransition} disabled={off} onChange={(e) => void save({ vmixTransition: e.target.value as AutoReplaySettings["vmixTransition"] })}>
                  {TRANSITIONS.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.label}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Replay out" hint="Back to live after the last replay.">
                <select value={st.vmixTransitionOut ?? ""} disabled={off} onChange={(e) => void save({ vmixTransitionOut: (e.target.value || null) as AutoReplaySettings["vmixTransitionOut"] })}>
                  <option value="">Same as Replay in</option>
                  {TRANSITIONS.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.label}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            <div className="row">
              <ActionButton action={() => api.post<{ connected: boolean; version: string | null; error: string | null }>("/api/v1/replays/vmix/test")} success={(r) => (r.connected ? `vMix ${r.version ?? ""} answers` : `vMix doesn't answer: ${r.error ?? ""}`)} onDone={() => void auto.reload()} disabledReason={reason}>
                Test vMix
              </ActionButton>
              {status?.vmix ? <Badge tone={status.vmix.connected ? "ok" : "warn"}>{status.vmix.connected ? `vMix ${status.vmix.version ?? ""}` : "vMix not reached"}</Badge> : null}
              <span className="muted small">Each replay is added to vMix as an input (the next one while the one before plays) and removed after the break's replays.</span>
            </div>
          </div>
        ) : (
          <div className="row">
            <ActionButton action={() => api.post<{ scene: string; input: string }>("/api/v1/replays/obs-setup")} success={(r) => `OBS: scene “${r.scene}” with the media source “${r.input}” is ready`} onDone={() => void auto.reload()} disabledReason={setupReason}>
              Set up OBS replay scene
            </ActionButton>
            <span className="muted small">Adds a “Matchframe Replay” scene to OBS and uses it, with a second one beside it for fading between replays. Pick a Stinger for replays under OBS scenes → Transitions.</span>
            {status?.twin ? <span className={`small ${status.twin.ready ? "muted" : "text-warn"}`}>{status.twin.ready ? `Fades between replays through “${status.twin.scene}”, a copy of your replay scene that Matchframe keeps the same: leave it to Matchframe.` : `Between replays: ${status.twin.detail}`}</span> : null}
          </div>
        )}
        {ranked.length ? (
          <div className="stack-sm" aria-label="Clips of the round, best first">
            <span className="small muted">Round {status?.round ?? "?"}: its clips, best first</span>
            <ol className="ranked-replays small">
              {ranked.map((r) => (
                <li key={r.id} className="row">
                  <Badge tone={RANKED_STATE[r.state].tone}>{RANKED_STATE[r.state].label}</Badge>
                  {r.pinned ? <Badge tone="accent">Pinned first</Badge> : null}
                  <span>{r.label}</span>
                  <span className="muted">
                    {r.score}
                    {r.reasons.length ? ` · ${r.reasons.join(", ")}` : ""}
                  </span>
                  {r.note ? <span className="text-warn">{r.note}</span> : null}
                  {r.state !== "played" && r.state !== "picked" && (!r.note || r.excluded) ? (
                    <span className="row">
                      <Button size="sm" variant="ghost" disabledReason={reason} aria-label={`${r.excluded ? "Include" : "Exclude"} ${r.label}`} onClick={() => void control(`/api/v1/replays/auto/clips/${encodeURIComponent(r.id)}`, { excluded: !r.excluded }, "PUT")}>
                        {r.excluded ? "Include" : "Exclude"}
                      </Button>
                      {!r.excluded ? (
                        <Button size="sm" variant="ghost" disabledReason={reason} aria-label={`${r.pinned ? "Unpin" : "Pin first"} ${r.label}`} onClick={() => void control(`/api/v1/replays/auto/clips/${encodeURIComponent(r.id)}`, { pinned: !r.pinned }, "PUT")}>
                          {r.pinned ? "Unpin" : "Pin first"}
                        </Button>
                      ) : null}
                    </span>
                  ) : null}
                </li>
              ))}
            </ol>
          </div>
        ) : null}
        {status?.lastPlayed ? <p className="small muted">Last replay: {status.lastPlayed.label}</p> : null}
        {st ? <ReplaySound st={st} status={status ?? null} save={save} off={off} /> : null}
        <TestReplays report={status?.test ?? null} running={!!status?.running} reason={reason} onDone={(r) => auto.setData(r)} />
        <ReplayHotkeys />
      </div>
    </Panel>
  );
}

/**
 * The replays' sound: the replay media sources' volume, and the live game audio turned down while
 * they play (the inputs picked, how far), put back exactly after.
 */
function ReplaySound({ st, status, save, off }: { st: AutoReplaySettings; status: AutoReplayResponse["status"] | null; save: (patch: Partial<AutoReplaySettings>) => Promise<void>; off: boolean }) {
  const [inputs, setInputs] = useState<ReplayAudioInputs | null>(null);
  const toast = useToast();
  const vmix = st.mixer === "vmix";
  const picked = (vmix ? st.duckVmixInputs : st.duckInputs) ?? [];
  const find = async () => {
    try {
      setInputs(await api.get<ReplayAudioInputs>("/api/v1/replays/audio-inputs"));
    } catch (e) {
      toast.push("warn", "Audio inputs not read", describeError(e));
    }
  };
  useEffect(() => {
    void find();
  }, [st.mixer]);
  const pick = (id: string, on: boolean) => {
    const next = on ? [...picked, id] : picked.filter((x) => x !== id);
    void save(vmix ? { duckVmixInputs: next } : { duckInputs: next });
  };
  const list = inputs && inputs.mixer === st.mixer ? inputs.inputs : [];
  // Picked inputs the mixer doesn't list (renamed, removed): still shown, so they can be unpicked.
  const missing = picked.filter((id) => !list.some((i) => i.id === id));
  const audio = status?.audio;
  return (
    <div className="stack-sm" aria-label="Sound during replays">
      <h4 className="hud-section-title">Sound</h4>
      <div className="form-grid">
        <Field label="Replay volume" hint={vmix ? "Each replay input in vMix (its fader; above 0 dB its gain)." : "Both replay media sources (your replay scene's and its copy). Above 0 dB is louder than recorded."}>
          <select value={st.replayVolumeDb === null || st.replayVolumeDb === undefined ? "" : String(st.replayVolumeDb)} disabled={off} onChange={(e) => void save({ replayVolumeDb: e.target.value === "" ? null : Number(e.target.value) })}>
            {[...REPLAY_VOLUMES, ...(st.replayVolumeDb !== null && st.replayVolumeDb !== undefined && !(REPLAY_VOLUMES as readonly (number | null)[]).includes(st.replayVolumeDb) ? [st.replayVolumeDb] : [])].map((db) => (
              <option key={String(db)} value={db === null ? "" : String(db)}>
                {db === null ? (vmix ? "As vMix has it" : "As set in OBS") : db === 0 ? "0 dB (as recorded)" : `${db > 0 ? "+" : ""}${db} dB`}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Live game audio during replays" hint="Turned down with a short ramp as the replays start, and back to exactly where it was after them, however they end.">
          <select value={String(st.duckTo ?? -20)} disabled={off} onChange={(e) => void save({ duckTo: e.target.value === "mute" ? "mute" : Number(e.target.value) })}>
            {DUCK_TO.map((d) => (
              <option key={String(d)} value={String(d)}>
                {d === "mute" ? "Muted" : `${d} dB`}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <div className="stack-sm" role="group" aria-label="Live game audio inputs">
        <span className="small muted">The live game audio: tick the {vmix ? "vMix inputs" : "OBS audio inputs"} with the game's sound. Only these are touched: leave casters' microphones unticked.</span>
        {inputs?.error ? <span className="small text-warn">{inputs.error}</span> : null}
        {list.map((i) => (
          <Checkbox key={i.id} checked={picked.includes(i.id)} disabled={off || i.replay} label={`${i.name}${i.replay ? " (a replay source: never turned down)" : ""}`} hint={vmix ? `vMix volume ${Math.round(i.volume)}${i.muted ? ", off" : ""}` : `${i.volume <= -100 ? "-inf" : i.volume} dB${i.muted ? ", muted" : ""}`} onChange={(v) => pick(i.id, v)} />
        ))}
        {missing.map((id) => (
          <Checkbox key={id} checked disabled={off} label={`${id} (not found in ${vmix ? "vMix" : "OBS"})`} onChange={() => pick(id, false)} />
        ))}
        <div className="row">
          <Button size="sm" onClick={() => void find()}>
            Find audio inputs
          </Button>
          {audio ? <span className={`small ${audio.state === "lowered" ? "text-warn" : "muted"}`}>{audio.detail}</span> : null}
        </div>
        {audio?.lastRestore && !audio.lastRestore.ok ? <span className="small text-warn">{audio.lastRestore.detail}</span> : null}
      </div>
      <p className="muted small">Replays carry the replay PC's game sound: the replay feed records it with the picture (when its NDI sender sends sound), and clips from its OBS replay buffer have the tracks its OBS records.</p>
    </div>
  );
}

/** Test replays: two sample clips on program now, through the whole chain, then what worked and how to fix what didn't. */
function TestReplays({ report, running, reason, onDone }: { report: ReplayTestReport | null; running: boolean; reason: string | null; onDone: (r: AutoReplayResponse) => void }) {
  return (
    <div className="stack-sm" aria-label="Test replays">
      <h4 className="hud-section-title">Test replays</h4>
      <div className="row">
        <ActionButton
          action={() => api.post<AutoReplayResponse>("/api/v1/replays/auto/test")}
          confirm={{
            title: "Test replays on air?",
            body: "This plays on your program output now: two sample clips (Test clip 1 and 2) with Replay in, the fade between them and Replay out, the live game audio turned down meanwhile. It takes about 10 seconds.",
            confirmLabel: "Play the test now",
          }}
          success={null}
          onDone={onDone}
          disabledReason={reason ?? (report?.state === "running" ? "Test replays are playing" : running ? "Replays are playing" : null)}
        >
          Test replays
        </ActionButton>
        <span className="muted small">Plays two sample clips through the same path as a break's replays. Not while a round is live.</span>
      </div>
      {report ? (
        <ol className="stack-sm small" aria-label="Test replays report">
          {report.steps.map((s) => (
            <li key={s.id} className="stack-sm">
              <div className="row">
                <Badge tone={STEP_TONE[s.state]}>{STEP_LABEL[s.state]}</Badge>
                <span>{s.label}</span>
                {s.detail ? <span className="muted">{s.detail}</span> : null}
              </div>
              {s.state === "failed" && s.fix ? <span className="text-warn">Fix: {s.fix}</span> : null}
            </li>
          ))}
        </ol>
      ) : null}
      {report && report.state !== "running" ? <span className={`small ${report.state === "passed" ? "muted" : "text-warn"}`}>{report.state === "passed" ? "Every step worked." : "Some steps failed: see Fix above, then test again."}</span> : null}
    </div>
  );
}

/** Keys for the replays playing: the console's own, and (in the program) global hotkeys that work with CS2 or OBS in front. */
function ReplayHotkeys() {
  const bridge = replayHotkeys();
  const [state, setState] = useState<ReplayHotkeyState | null>(null);
  const [draft, setDraft] = useState<Record<ReplayKeyAction, string>>({ skip: "", hold: "", stop: "" });
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void bridge
      ?.get()
      .then((s) => {
        setState(s);
        setDraft({ skip: s.keys.skip ?? "", hold: s.keys.hold ?? "", stop: s.keys.stop ?? "" });
      })
      .catch((e) => setError(describeError(e)));
  }, [bridge]);
  const set = async (patch: Partial<Record<ReplayKeyAction, string | null>>) => {
    if (!bridge) return;
    setError(null);
    try {
      const s = await bridge.set(patch);
      setState(s);
      setDraft({ skip: s.keys.skip ?? "", hold: s.keys.hold ?? "", stop: s.keys.stop ?? "" });
    } catch (e) {
      setError(describeError(e));
    }
  };
  return (
    <div className="stack-sm" aria-label="Replay hotkeys">
      <h4 className="hud-section-title">Hotkeys and Stream Deck</h4>
      <p className="muted small">In the console: {REPLAY_KEYS.map((k) => `${shortcutLabel(k.key)} ${k.label}`).join(" · ")}. Stream Deck and Bitfocus Companion: the device actions replay_skip, replay_hold, replay_stop, replay_exclude and replay_pin (see the Replay PC guide).</p>
      {bridge ? (
        <div className="stack-sm">
          <span className="small muted">Global hotkeys work with CS2 or OBS in front. They are off until set; the suggested keys aren't used by CS2 or OBS.</span>
          <div className="form-grid">
            {REPLAY_KEYS.map((k) => (
              <Field key={k.id} label={`${k.label} (global)`} hint={state?.errors[k.id] ?? (state?.keys[k.id] ? (state.registered[k.id] ? "Registered" : "Not registered") : "Off")}>
                <input value={draft[k.id]} placeholder={state?.suggested[k.id] ?? ""} spellCheck={false} onChange={(e) => setDraft((d) => ({ ...d, [k.id]: e.target.value }))} onBlur={() => draft[k.id] !== (state?.keys[k.id] ?? "") && void set({ [k.id]: draft[k.id].trim() || null })} />
              </Field>
            ))}
          </div>
          <div className="row">
            <Button size="sm" disabledReason={!state ? "Loading…" : null} onClick={() => state && void set(state.suggested)}>
              Use the suggested keys
            </Button>
            <Button size="sm" variant="ghost" disabledReason={!state ? "Loading…" : null} onClick={() => void set({ skip: null, hold: null, stop: null })}>
              Turn them off
            </Button>
          </div>
          {REPLAY_KEYS.filter((k) => state?.errors[k.id]).map((k) => (
            <span key={k.id} className="small text-warn" role="alert">
              {state!.errors[k.id]}
            </span>
          ))}
          {error ? (
            <span className="small text-warn" role="alert">
              {error}
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

const TIMING_TONE = { measuring: "info", live: "neutral", behind: "ok", ahead: "warn" } as const;

function timingLabel(t: ReplayPcResponse["status"]["timing"]): string {
  if (t.delayMs === null || t.state === "measuring") return "Timing…";
  const s = (Math.abs(t.delayMs) / 1000).toFixed(1);
  return t.state === "behind" ? `${s} s behind` : t.state === "ahead" ? `${s} s ahead` : "Same time";
}

const SECOND_CSTV = "tv_enable1 1\ntv_port1 27021\ntv_delay1 17";

const SAME_CSTV_HINT = {
  stay_behind: "When this computer is at the main PC's time, CS2 goes back once (demo_gototick) and stays behind: every missed kill is then known before it plays here. It goes back again after a reconnect or a map change.",
  each_kill: "When a kill the main camera missed wasn't on this camera, CS2 goes back a few seconds, films it, then skips forward to live again.",
  off: "This computer films someone else and sends what its camera happens to catch.",
} as const;

/** The best setup: this computer a few seconds behind the main PC, so it knows each missed kill before it plays here. */
function BehindHelp() {
  return (
    <details className="small">
      <summary>Best: this computer about 7 s behind the main PC</summary>
      <div className="stack-sm">
        <p>Then every kill the main camera misses is known here before it happens on this computer: the camera gets on the killer first and the whole kill is filmed. The program measures how far behind it is by itself.</p>
        <ul>
          <li>Both on the same CSTV: nothing to set up. This computer goes back 7 s by itself (demo_gototick -448 relative) and stays there (below).</li>
          <li>Main PC in the server as a spectator: watch the server's CSTV here, with a CSTV delay of about 7 s (tv_delay 7).</li>
          <li>
            Main PC on CSTV: give the server a second CSTV, 7 s later than the first, and connect to it here (connect server-address:27021). With the main CSTV at tv_delay 10:
            <div className="row">
              <code className="mono">{SECOND_CSTV.replace(/\n/g, "; ")}</code>
              <CopyButton text={SECOND_CSTV} label="Copy" />
            </div>
          </li>
        </ul>
      </div>
    </details>
  );
}

/** Setting up the two computers: the main PC lets the replay PC in, the replay PC connects to it. */
export function ReplayPcPanel() {
  const link = useApi<ReplayPcResponse>("/api/v1/replay-pc", { refreshMs: 1500 });
  const isReplayPc = link.data?.settings.enabled ?? false;
  const [tab, setTab] = useState<"main" | "replay">("main");
  // Open on the side this computer is set up as, once; then the operator's choice stays.
  const chosen = useRef(false);
  useEffect(() => {
    if (link.data && !chosen.current) {
      chosen.current = true;
      setTab(link.data.settings.enabled ? "replay" : "main");
    }
  }, [link.data]);
  return (
    <Panel title="Replay PC" subtitle="A second computer with its own CS2 and OBS that films the kills this camera misses.">
      <Tabs
        label="Which computer this is"
        value={tab}
        onChange={setTab}
        tabs={[
          { id: "main" as const, label: "This is the main PC" },
          { id: "replay" as const, label: isReplayPc ? "This is the replay PC ●" : "This is the replay PC" },
        ]}
      />
      {tab === "main" ? <MainSide /> : <ReplaySide data={link.data ?? null} reload={() => void link.reload()} />}
    </Panel>
  );
}

function MainSide() {
  const reason = usePermission("settings.manage");
  const net = useApi<NetworkInfo>("/api/v1/network", { refreshMs: 5000 });
  const bridge = typeof window !== "undefined" ? window.matchframe?.network : undefined;
  const [access, setAccess] = useState<boolean | null>(null);
  const [code, setCode] = useState<string | null>(null);
  const toast = useToast();
  useEffect(() => {
    void bridge?.get().then((r) => setAccess(r?.networkAccess ?? null));
  }, [bridge]);
  const toggle = async (on: boolean) => {
    const r = await bridge?.set(on);
    if (r) {
      setAccess(r.networkAccess);
      toast.push("info", on ? "Other computers can connect" : "Only this computer can connect", "The engine restarts; the console reconnects by itself.");
    }
  };
  const addresses = net.data?.addresses ?? [];
  const port = net.data?.apiPort ?? 37211;
  return (
    <div className="stack-sm">
      <ol className="steps small">
        <li>Let other computers connect to this one.</li>
        <li>Make a replay PC code and type it, with this computer's address, on the replay PC.</li>
        <li>Turn on automatic replays above.</li>
      </ol>
      {bridge ? (
        <Checkbox checked={access === true} disabled={!!reason || access === null} label="Let other computers on the network connect" hint="They still need a code from this computer. Windows may ask to allow Matchframe through the firewall: allow it on private networks." onChange={(v) => void toggle(v)} />
      ) : (
        <Note tone="neutral">Network access is set in the Matchframe program on the main PC.</Note>
      )}
      {net.data?.reachable ? (
        addresses.length ? (
          <div className="stack-sm">
            <span className="small muted">This computer's address (use one the replay PC can reach):</span>
            {addresses.map((a) => (
              <div key={a} className="row">
                <code>{`${a}:${port}`}</code>
                <CopyButton text={`${a}:${port}`} label="Copy" />
              </div>
            ))}
          </div>
        ) : (
          <Note tone="warn">This computer has no network address. Connect it to the same network as the replay PC.</Note>
        )
      ) : net.data ? (
        <p className="small muted">Only this computer can connect right now.</p>
      ) : null}
      <div className="row">
        <ActionButton
          action={() => api.post<{ token: string }>("/api/v1/tokens", { role: "replay", label: `Replay PC (${new Date().toLocaleDateString()})` })}
          success="Replay PC code made: type it on the replay PC"
          onDone={(t) => setCode(t.token)}
          disabledReason={reason}
        >
          Make a replay PC code
        </ActionButton>
      </div>
      {code ? (
        <div className="row">
          <code className="mono">{code}</code>
          <CopyButton text={code} label="Copy code" />
          <span className="muted small">Shown once. Remove it in Settings → Access to lock the replay PC out.</span>
        </div>
      ) : null}
      <ReplayFeedSection />
    </div>
  );
}

const FEED_TONE = { off: "neutral", starting: "info", waiting: "warn", recording: "ok", error: "warn" } as const;
const ENCODERS = [
  { id: "auto", label: "Best this computer has" },
  { id: "h264_nvenc", label: "NVIDIA (NVENC)" },
  { id: "h264_qsv", label: "Intel (Quick Sync)" },
  { id: "h264_amf", label: "AMD (AMF)" },
  { id: "libx264", label: "CPU (x264)" },
] as const;

/**
 * Main PC: the replay feed. This computer records the replay PC's whole screen over NDI and cuts
 * each kill the replay PC films from it; the replay PC then needs no OBS, only an NDI screen sender.
 */
function ReplayFeedSection() {
  const feed = useApi<ReplayFeedResponse>("/api/v1/replays/feed", { refreshMs: 1500 });
  const reason = usePermission("settings.manage");
  const toast = useToast();
  const [sources, setSources] = useState<{ name: string; urlAddress?: string }[] | null>(null);
  const save = async (patch: Partial<ReplayFeedResponse["settings"]>) => {
    try {
      feed.setData(await api.put<ReplayFeedResponse>("/api/v1/replays/feed", patch));
    } catch (e) {
      toast.push("danger", "Setting not saved", describeError(e));
    }
  };
  const st = feed.data?.settings;
  const status = feed.data?.status;
  const ff = status?.ffmpeg;
  const choices = [...(sources ?? []), ...(st?.source && !sources?.some((x) => x.name === st.source!.name) ? [st.source] : [])];
  return (
    <div className="stack-sm">
      <h3 className="gb-section-title">Replay feed (NDI)</h3>
      <p className="small muted">This computer records the replay PC's whole screen over NDI and cuts each kill from it, like LHM's Replay Feed. The replay PC then needs no OBS: only an NDI screen sender, such as vMix Desktop Capture.</p>
      <Checkbox checked={st?.enabled ?? false} disabled={!!reason || !st} label="Record the replay PC's screen" hint="It keeps the last few minutes and cuts clips from them; nothing is played from it by itself." onChange={(v) => void save({ enabled: v })} />
      {ff?.source === "missing" ? (
        ff.canDownload ? (
          <div className="row">
            <ActionButton action={() => api.post("/api/v1/replays/feed/ffmpeg")} success="ffmpeg downloaded" onDone={() => void feed.reload()} disabledReason={reason ?? (ff.downloading !== null ? "Downloading…" : null)}>
              Download ffmpeg
            </ActionButton>
            <span className="muted small">{ff.downloading !== null ? `Downloading… ${Math.round(ff.downloading * 100)} %` : "The recording needs ffmpeg (a 92 MB download from gyan.dev, checked before use)."}</span>
          </div>
        ) : (
          <Note tone="warn">The recording needs ffmpeg: install it with this system's package manager.</Note>
        )
      ) : ff ? (
        <span className="small muted">ffmpeg {ff.version ?? ""}{ff.encoder ? ` · encoding with ${ff.encoder}` : ""}</span>
      ) : null}
      {ff?.error ? <span className="small text-warn">{ff.error}</span> : null}
      <div className="form-grid">
        <Field label="The replay PC's NDI source" hint="Start the NDI sender on the replay PC first, then find it here.">
          <select value={st?.source?.name ?? ""} disabled={!!reason || !st} onChange={(e) => void save({ source: choices.find((c) => c.name === e.target.value) ?? null })}>
            <option value="" disabled>
              {sources === null ? "Press Find NDI sources" : sources.length ? "Choose one" : "No NDI sources found"}
            </option>
            {choices.map((c) => (
              <option key={c.name} value={c.name}>
                {c.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Encoder">
          <select value={st?.encoder ?? "auto"} disabled={!!reason || !st} onChange={(e) => void save({ encoder: e.target.value as ReplayFeedResponse["settings"]["encoder"] })}>
            {ENCODERS.map((x) => (
              <option key={x.id} value={x.id}>
                {x.label}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <div className="row">
        <ActionButton action={() => api.post<{ sources: { name: string; urlAddress?: string }[]; error: string | null }>("/api/v1/replays/feed/sources")} success={(r) => (r.error ? `NDI: ${r.error}` : `${r.sources.length} NDI source${r.sources.length === 1 ? "" : "s"} found`)} onDone={(r) => setSources(r.sources)} disabledReason={reason}>
          Find NDI sources
        </ActionButton>
        {status?.ndi.version ? <span className="muted small">{status.ndi.version}</span> : status?.ndi.error ? <span className="small text-warn">NDI: {status.ndi.error}</span> : null}
      </div>
      {status && status.enabled ? (
        <div className="stack-sm small" role="status">
          <div className="row">
            <Badge tone={FEED_TONE[status.state]}>{status.state === "recording" ? "Recording" : status.state === "waiting" ? "No picture" : status.state === "starting" ? "Starting" : status.state === "error" ? "Not recording" : "Off"}</Badge>
            <span>{status.detail}</span>
          </div>
          {status.state === "recording" ? (
            <span className="muted">
              {status.bufferedSec.toFixed(0)} s kept · {status.receivingFps.toFixed(0)} frames a second arriving
              {status.dropped ? ` · ${status.dropped} dropped (encoder behind: try another encoder)` : ""} · {status.clips} clips cut
            </span>
          ) : null}
          {status.state === "recording" && status.audio ? <span className={status.audio.recording ? "muted" : "text-warn"}>{status.audio.detail}</span> : null}
        </div>
      ) : null}
    </div>
  );
}

function ReplaySide({ data, reload }: { data: ReplayPcResponse | null; reload: () => void }) {
  const reason = usePermission("settings.manage");
  const snap = useSnapshot();
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");
  useEffect(() => {
    if (data?.settings.mainUrl) setUrl(data.settings.mainUrl.replace(/^https?:\/\//, ""));
  }, [data?.settings.mainUrl]);
  const st = data?.status;
  const nameOf = (id: string | null) => (id ? (snap?.state?.players.find((p) => p.steamId === id)?.name ?? id) : "nobody");
  const enabled = data?.settings.enabled ?? false;
  return (
    <div className="stack-sm">
      <ol className="steps small">
        <li>On this computer: Start CS2 and spectate the same match, connect OBS (Game Capture of CS2) and start the Auto Director.</li>
        <li>Type the main PC's address and its replay PC code below.</li>
      </ol>
      <BehindHelp />
      <div className="form-grid">
        <Field label="Main PC address" hint="As shown on the main PC, e.g. 192.168.1.20:37211">
          <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="192.168.1.20:37211" spellCheck={false} />
        </Field>
        <Field label="Replay PC code" hint={data?.hasToken ? "A code is saved; type a new one to replace it." : "Made on the main PC."}>
          <input value={token} onChange={(e) => setToken(e.target.value)} type="password" autoComplete="off" spellCheck={false} placeholder={data?.hasToken ? "••••••••" : ""} />
        </Field>
      </div>
      <div className="row">
        <ActionButton
          variant="primary"
          action={() => api.put<ReplayPcResponse>("/api/v1/replay-pc", { enabled: true, mainUrl: url, ...(token ? { token } : {}) })}
          success="Connecting to the main PC"
          onDone={() => {
            setToken("");
            reload();
          }}
          disabledReason={reason ?? (!url.trim() ? "Type the main PC's address" : !token && !data?.hasToken ? "Type the replay PC code" : null)}
        >
          {enabled ? "Save and reconnect" : "Make this the replay PC"}
        </ActionButton>
        {enabled ? (
          <Button variant="ghost" disabledReason={reason} onClick={() => void api.put("/api/v1/replay-pc", { enabled: false }).then(reload)}>
            Stop being the replay PC
          </Button>
        ) : null}
      </div>
      {enabled ? (
        <div className="form-grid">
          <Field label="On the same CSTV as the main PC" hint={SAME_CSTV_HINT[data?.settings.sameCstv ?? "stay_behind"]}>
            <select value={data?.settings.sameCstv ?? "stay_behind"} disabled={!!reason} onChange={(e) => void api.put("/api/v1/replay-pc", { sameCstv: e.target.value }).then(reload)}>
              <option value="stay_behind">Go back and stay behind (recommended)</option>
              <option value="each_kill">Go back for each missed kill, then live</option>
              <option value="off">Don't go back</option>
            </select>
          </Field>
          <Field label="Kills to film" hint="Behind the main PC, this computer can film every kill it has time for; the main PC replays the best of each round.">
            <select value={data?.settings.filmAll === false ? "missed" : "all"} disabled={!!reason} onChange={(e) => void api.put("/api/v1/replay-pc", { filmAll: e.target.value === "all" }).then(reload)}>
              <option value="all">Every kill (recommended)</option>
              <option value="missed">Only kills the main camera missed</option>
            </select>
          </Field>
          {data?.settings.sameCstv === "stay_behind" ? (
            <Field label="How far behind">
              <select value={data.settings.behindMs} disabled={!!reason} onChange={(e) => void api.put("/api/v1/replay-pc", { behindMs: Number(e.target.value) }).then(reload)}>
                {[5000, 7000, 10000].map((ms) => (
                  <option key={ms} value={ms}>
                    {ms / 1000} s (demo_gototick -{(ms / 1000) * 64} relative)
                  </option>
                ))}
              </select>
            </Field>
          ) : null}
        </div>
      ) : null}
      {st && st.enabled ? (
        <div className="stack-sm small" role="status">
          <div className="row">
            <Badge tone={st.state === "connected" ? "ok" : st.state === "error" ? "warn" : "info"}>{st.state === "connected" ? "Linked" : st.state === "error" ? "Not linked" : "Connecting"}</Badge>
            <span>{st.detail}</span>
          </div>
          {st.state === "connected" ? (
            <div className="row">
              <Badge tone={TIMING_TONE[st.timing.state]}>{timingLabel(st.timing)}</Badge>
              <span>{st.timing.detail}</span>
            </div>
          ) : null}
          {st.state === "connected" && st.timing.state !== "behind" ? <span>The main camera shows {nameOf(st.mainObserved)}: this computer's Auto Director films someone else.</span> : null}
          {data?.settings.sameCstv !== "off" && st.rewind.detail ? <span className={st.rewind.state === "unsupported" ? "text-warn" : ""}>Going back: {st.rewind.detail}</span> : null}
          {st.filming ? <span>Filming now: {st.filming}{st.planned ? ` (${st.planned} more planned)` : ""}</span> : null}
          {st.transport === "feed" ? (
            <span>The main PC records this computer's screen over NDI: no OBS needed here. Keep the NDI sender (such as vMix Desktop Capture) running.</span>
          ) : (
            <span className={st.obsReady ? "" : "text-warn"}>{st.obsReady ? "OBS replay buffer is running." : "Connect OBS on this computer (Settings → Devices); its replay buffer starts by itself. Or let the main PC record this screen over NDI (its Replay feed)."}</span>
          )}
          <span>
            Clips sent: {st.sent}
            {st.failed ? `, not sent: ${st.failed}` : ""}
            {st.last ? ` · last: ${st.last.label}${st.last.ok ? "" : ` (${st.last.error})`}` : ""}
          </span>
          {st.lastSkip ? (
            <span className="muted">
              Not filmed: {st.skipped} · last: {st.lastSkip.label} ({st.lastSkip.reason})
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
