import { useEffect, useRef, useState } from "react";
import { api, describeError } from "../../api/index.ts";
import type { AutoReplayResponse, AutoReplaySettings, NetworkInfo, RankedReplay, ReplayAudioInputs, ReplayFeedResponse, ReplayPcResponse, ReplayTestReport } from "../../api/types.ts";
import { ActionButton, Badge, Button, Checkbox, CopyButton, Field, Note, Panel, Tabs } from "../../components/ui.tsx";
import { useToast } from "../../components/toasts.tsx";
import { useApi } from "../../lib/hooks.ts";
import { REPLAY_KEYS, replayHotkeys, shortcutLabel, type ReplayHotkeyState, type ReplayKey, type ReplayKeyAction } from "../../lib/replay-keys.ts";
import { useSnapshot } from "../../state/live.ts";
import { usePermission } from "../../state/session.tsx";
import { perLocale, t } from "../../i18n/index.ts";
import { T } from "../../i18n/T.tsx";

const STATE_TONE = { off: "neutral", waiting: "info", playing: "accent", blocked: "warn" } as const;
/** Slow motion (ADR-081): around each kill, the whole clip, or none. */
const SLOW_MODES = perLocale(() => ([
  { id: "kill", label: t("replays.killMomentRecommended") },
  { id: "whole", label: t("replays.wholeClip") },
  { id: "off", label: t("replays.off") },
] as const));
const ANGLE_LABEL = perLocale(() => ({ victim: t("replays.victimSView"), free: t("replays.freeCamera") } as const));

const RANKED_STATE: Record<RankedReplay["state"], { label: string; tone: "ok" | "accent" | "info" | "neutral" }> = perLocale(() => ({
  played: { label: t("replays.played"), tone: "ok" },
  picked: { label: t("replays.onAir"), tone: "accent" },
  waiting: { label: t("replays.waiting"), tone: "info" },
  duplicate: { label: t("replays.sameKills"), tone: "neutral" },
  left: { label: t("replays.notPlayed"), tone: "neutral" },
}));
const TRANSITIONS = perLocale(() => ([
  { id: "CutDirect", label: t("replays.cut") },
  { id: "Fade", label: t("replays.fade") },
  { id: "Stinger1", label: t("replays.stinger1") },
  { id: "Stinger2", label: t("replays.stinger2") },
] as const));
/** When the break's replays end: by a time on the next round's clock (seconds left), or before it starts. */
const CUT_BACK = [112, 110, 105, 100, 95, 90] as const;
const FADES = [300, 500, 750, 1000] as const;
/** Early replays (ADR-083): at most this many seconds before the round's end (never more than 10). */
const EARLY_SEC = [10, 9, 8, 7, 6, 5] as const;
/** A rendered break's sound fade in and out (ms). */
const AUDIO_FADES = [0, 300, 400, 500] as const;
/** The replay media sources' volume: as set in OBS (null), or in dB. */
const REPLAY_VOLUMES = [null, 6, 3, 0, -3, -6, -10] as const;
/** The live game audio during replays: muted, or this many dB down. */
const DUCK_TO = ["mute", -10, -20, -30] as const;
const STEP_TONE = { pending: "neutral", ok: "ok", failed: "warn", skipped: "neutral" } as const;
const STEP_LABEL = perLocale(() => ({ pending: "…", ok: "OK", failed: t("replays.step.failed"), skipped: t("replays.step.skipped") }));
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
      toast.push("danger", t("replays.settingNotSaved"), describeError(e));
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
  const vmix = st?.mixer === "vmix";
  /** A break playing as one rendered file now: the operator's Exclude and Pin apply from the next break. */
  const renderedNow = !!status?.running && !vmix && st?.playback !== "scenes" && status?.render?.rendered === true && status.render.kind === "break";
  /** A control or a clip's Exclude / Pin: the answer is the panel's new state. */
  const control = async (path: string, body?: unknown, method: "POST" | "PUT" = "POST") => {
    try {
      auto.setData(await (method === "PUT" ? api.put<AutoReplayResponse>(path, body) : api.post<AutoReplayResponse>(path, body)));
    } catch (e) {
      toast.push("warn", t("replays.replays"), describeError(e));
    }
  };
  return (
    <Panel title={t("replays.automaticReplays")} subtitle={status?.detail} actions={status ? <Badge tone={STATE_TONE[status.state]}>{status.state === "playing" ? (status.held ? t("replays.held") : t("replays.playing")) : status.enabled ? t("replays.on") : t("replays.off")}</Badge> : null}>
      <div className="stack-sm">
        {status?.running ? (
          <div className="row" role="group" aria-label={t("replays.replaysPlayingNow")}>
            <Button variant="primary" disabledReason={reason} title={t("replays.endsTheClipOnAir", { shortcutLabel: shortcutLabel("F5") })} onClick={() => void control("/api/v1/replays/auto/skip")}>{t("replays.skip")}</Button>
            <Button variant={status.held ? "primary" : "secondary"} disabledReason={reason} title={`${status.held ? t("replays.playsItOn") : t("replays.pausesTheClipOnAir")} (${shortcutLabel("F6")})`} onClick={() => void control("/api/v1/replays/auto/hold", { held: !status.held })}>
              {status.held ? t("replays.resume") : t("replays.hold")}
            </Button>
            <Button variant="danger" disabledReason={reason} title={t("replays.backToTheLiveScene", { shortcutLabel: shortcutLabel("F7") })} onClick={() => void control("/api/v1/replays/auto/stop")}>{t("replays.stopAndGoLive")}</Button>
            <span className="muted small">{status.held ? t("replays.heldNothingPlaysOnUntil") : t("replays.shortcutlabelSkipShortcutlabel2HoldShort", { shortcutLabel: shortcutLabel("F5"), shortcutLabel2: shortcutLabel("F6"), shortcutLabel3: shortcutLabel("F7") })}</span>
          </div>
        ) : null}
        <Checkbox
          checked={st?.enabled ?? false}
          disabled={off}
          label={t("replays.playReplaysByThemselves")}
          hint={t("replays.inTheBreakAfterA", { v: st?.cutBack === "before_round" ? t("replays.justBeforeTheNextRound") : t("replays.theNextRoundSClock", { clock: clock(st?.cutBackClockSec ?? 110) }) })}
          onChange={(v) => void save({ enabled: v })}
        />
        <Checkbox
          checked={st?.early ?? true}
          disabled={off}
          label={t("replays.startReplaysEarlyWhenThe")}
          hint={t("replays.theBombIsPlantedAnd")}
          onChange={(v) => void save({ early: v })}
        />
        {st?.early !== false ? (
          <>
            <div className="form-grid">
              <Field label={t("replays.atMost")} hint={t("replays.beforeTheBombGoesOff")}>
                <select value={String(st?.earlyMaxSec ?? 10)} disabled={off} onChange={(e) => void save({ earlyMaxSec: Number(e.target.value) })}>
                  {EARLY_SEC.map((n) => (
                    <option key={n} value={String(n)}>
                      {t("replays.secondsEarly", { count: n })}{n === 10 ? t("replays.recommendedSuffix") : ""}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            <Checkbox
              checked={st?.earlyBackToLive ?? true}
              disabled={off}
              label={t("replays.backToLiveIfThe")}
              hint={t("replays.whileEarlyReplaysAreOn")}
              onChange={(v) => void save({ earlyBackToLive: v })}
            />
          </>
        ) : null}
        <div className="form-grid">
          <Field label={t("replays.replaysPerBreak")} hint={t("replays.theBestClipsOfThe")}>
            <select value={st?.perBreak ?? 4} disabled={off} onChange={(e) => void save({ perBreak: Number(e.target.value) })}>
              {[1, 2, 3, 4].map((n) => (
                <option key={n} value={n}>
                  {n === 1 ? t("replays.theBestOne") : t("replays.theBestN", { n })}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t("replays.order")} hint={t("replays.theChosenClipsPlayBack")}>
            <select value={st?.order ?? "round"} disabled={off} onChange={(e) => void save({ order: e.target.value as AutoReplaySettings["order"] })}>
              <option value="round">{t("replays.roundOrder")}</option>
              <option value="best">{t("replays.bestFirst")}</option>
            </select>
          </Field>
          <Field label={t("replays.backToLive")} hint={t("replays.replaysMayRunOnInto")}>
            <select
              value={st?.cutBack === "before_round" ? "before_round" : String(st?.cutBackClockSec ?? 110)}
              disabled={off}
              onChange={(e) => void save(e.target.value === "before_round" ? { cutBack: "before_round" } : { cutBack: "clock", cutBackClockSec: Number(e.target.value) })}
            >
              {[...CUT_BACK, ...(st?.cutBackClockSec && !(CUT_BACK as readonly number[]).includes(st.cutBackClockSec) ? [st.cutBackClockSec] : [])].map((sec) => (
                <option key={sec} value={String(sec)}>
                  {t("replays.bySecOnTheRound", { sec: clock(sec), v: sec === 110 ? t("replays.recommendedSuffix") : "" })}
                </option>
              ))}
              <option value="before_round">{t("replays.beforeTheRoundStarts")}</option>
            </select>
          </Field>
          <Field label={t("replays.betweenReplays")} hint={vmix ? t("replays.theEndOfOneReplay") : t("replays.fadeOneSceneRenderedThe")}>
            <select value={st?.between === "cut" ? "cut" : st?.playback === "scenes" || vmix ? "scenes" : "rendered"} disabled={off} onChange={(e) => void save(e.target.value === "cut" ? { between: "cut" } : { between: "fade", playback: e.target.value as "rendered" | "scenes" })}>
              {vmix ? <option value="scenes">{t("replays.fade")}</option> : null}
              {!vmix ? <option value="rendered">{t("replays.fadeOneSceneRendered")}</option> : null}
              {!vmix ? <option value="scenes">{t("replays.fadeTwoScenesObs")}</option> : null}
              <option value="cut">{t("replays.cut")}</option>
            </select>
          </Field>
          {st?.between !== "cut" ? (
            <Field label={t("replays.fadeLength")}>
              <select value={String(st?.fadeMs ?? 500)} disabled={off} onChange={(e) => void save({ fadeMs: Number(e.target.value) })}>
                {[...FADES, ...(st?.fadeMs && !(FADES as readonly number[]).includes(st.fadeMs) ? [st.fadeMs] : [])].map((ms) => (
                  <option key={ms} value={String(ms)}>
                    {`${ms / 1000} s${ms === 500 ? t("replays.recommendedSuffix") : ""}`}
                  </option>
                ))}
              </select>
            </Field>
          ) : null}
          {!vmix && st?.playback !== "scenes" ? (
            <Field label={t("replays.soundFade")} hint={t("replays.aRenderedBreakSSound")}>
              <select value={String(st?.audioFadeMs ?? 400)} disabled={off} onChange={(e) => void save({ audioFadeMs: Number(e.target.value) })}>
                {[...AUDIO_FADES, ...(st?.audioFadeMs !== undefined && !(AUDIO_FADES as readonly number[]).includes(st.audioFadeMs) ? [st.audioFadeMs] : [])].map((ms) => (
                  <option key={ms} value={String(ms)}>
                    {ms === 0 ? t("replays.none") : `${ms / 1000} s${ms === 400 ? t("replays.recommendedSuffix") : ""}`}
                  </option>
                ))}
              </select>
            </Field>
          ) : null}
          <Field label={t("replays.slowMotion")} hint={vmix || st?.playback === "scenes" ? t("replays.killMomentSlowsARendered") : t("replays.killMomentEachClipEases")}>
            <select value={st?.slowMotion ?? "kill"} disabled={off} onChange={(e) => void save({ slowMotion: e.target.value as NonNullable<AutoReplaySettings["slowMotion"]> })}>
              {SLOW_MODES.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
          </Field>
          {st?.slowMotion !== "off" ? (
            <Field label={t("replays.slowSpeed")}>
              <select value={String(st?.slowSpeed ?? 50)} disabled={off} onChange={(e) => void save({ slowSpeed: Number(e.target.value) as 50 | 33 })}>
                <option value="50">50 %</option>
                <option value="33">33 %</option>
              </select>
            </Field>
          ) : null}
          {st?.slowMotion !== "off" ? (
            <Field label={t("replays.soundWhileSlowed")} hint={t("replays.mutedTheGameSoundFades")}>
              <select value={st?.slowAudio ?? "mute"} disabled={off} onChange={(e) => void save({ slowAudio: e.target.value as "mute" | "pitch" })}>
                <option value="mute">{t("replays.mutedRecommended")}</option>
                <option value="pitch">{t("replays.slowedPitchKept")}</option>
              </select>
            </Field>
          ) : null}
        </div>
        {st?.slowMotion !== "off" && !vmix ? (
          <Checkbox
            checked={st?.slowSmooth ?? false}
            disabled={off}
            label={t("replays.smoothSlowMotionMoreCpu")}
            hint={t("replays.makesTheInBetweenFrames")}
            onChange={(v) => void save({ slowSmooth: v })}
          />
        ) : null}
        <div className="form-grid">
          <Field label={t("replays.multiAngleReplays")} hint={t("replays.theReplayPcIsAsked")}>
            <select value={st?.multiAngle ?? "top"} disabled={off} onChange={(e) => void save({ multiAngle: e.target.value as NonNullable<AutoReplaySettings["multiAngle"]> })}>
              <option value="top">{t("replays.theRoundSTopKill")}</option>
              <option value="starred">{t("replays.onlyStarredKills")}</option>
              <option value="off">{t("replays.off")}</option>
            </select>
          </Field>
          {st?.multiAngle !== "off" ? (
            <Field label={t("replays.extraAngle")}>
              <select value={st?.angleViews ?? "victim"} disabled={off} onChange={(e) => void save({ angleViews: e.target.value as NonNullable<AutoReplaySettings["angleViews"]> })}>
                <option value="victim">{t("replays.thePlayerWhoDiedS")}</option>
                <option value="free">{t("replays.aFreeCamera")}</option>
                <option value="both">{t("replays.both")}</option>
              </select>
            </Field>
          ) : null}
        </div>
        <Checkbox checked={st?.otherAngles ?? true} disabled={off} label={t("replays.otherAngles")} hint={t("replays.whenTheMainCameraShowed")} onChange={(v) => void save({ otherAngles: v })} />
        <Checkbox checked={st?.ownBigPlays ?? true} disabled={off} label={t("replays.replayBigPlaysShownLive")} hint={t("replays.whenTheMainCameraShows")} onChange={(v) => void save({ ownBigPlays: v })} />
        <Field label={t("replays.playReplaysIn")}>
          <select value={st?.mixer ?? "obs"} disabled={off} onChange={(e) => void save({ mixer: e.target.value as AutoReplaySettings["mixer"] })}>
            <option value="obs">OBS</option>
            <option value="vmix">vMix</option>
          </select>
        </Field>
        {st?.mixer === "vmix" ? (
          <div className="stack-sm">
            <div className="form-grid">
              <Field label={t("replays.vmixAddress")} hint={t("replays.vmixOnThisComputerWith")}>
                <input value={vmixUrl} disabled={off} spellCheck={false} onChange={(e) => setVmixUrl(e.target.value)} onBlur={() => vmixUrl !== st.vmixUrl && void save({ vmixUrl })} placeholder="http://127.0.0.1:8088" />
              </Field>
              <Field label={t("replays.replayIn")} hint={t("replays.toTheFirstReplayStingers")}>
                <select value={st.vmixTransition} disabled={off} onChange={(e) => void save({ vmixTransition: e.target.value as AutoReplaySettings["vmixTransition"] })}>
                  {TRANSITIONS.map((tRow) => (
                    <option key={tRow.id} value={tRow.id}>
                      {tRow.label}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label={t("replays.replayOut")} hint={t("replays.backToLiveAfterThe")}>
                <select value={st.vmixTransitionOut ?? ""} disabled={off} onChange={(e) => void save({ vmixTransitionOut: (e.target.value || null) as AutoReplaySettings["vmixTransitionOut"] })}>
                  <option value="">{t("replays.sameAsReplayIn")}</option>
                  {TRANSITIONS.map((tRow) => (
                    <option key={tRow.id} value={tRow.id}>
                      {tRow.label}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            <div className="row">
              <ActionButton action={() => api.post<{ connected: boolean; version: string | null; error: string | null }>("/api/v1/replays/vmix/test")} success={(r) => (r.connected ? t("replays.vmixVAnswers", { v: r.version ?? "" }) : t("replays.vmixDoesnTAnswerV", { v: r.error ?? "" }))} onDone={() => void auto.reload()} disabledReason={reason}>{t("replays.testVmix")}</ActionButton>
              {status?.vmix ? <Badge tone={status.vmix.connected ? "ok" : "warn"}>{status.vmix.connected ? `vMix ${status.vmix.version ?? ""}` : t("replays.vmixNotReached")}</Badge> : null}
              <span className="muted small">{t("replays.eachReplayIsAddedTo")}</span>
            </div>
          </div>
        ) : (
          <div className="row">
            <ActionButton action={() => api.post<{ scene: string; input: string }>("/api/v1/replays/obs-setup")} success={(r) => t("replays.obsSceneSceneWithThe", { scene: r.scene, input: r.input })} onDone={() => void auto.reload()} disabledReason={setupReason}>{t("replays.setUpObsReplayScene")}</ActionButton>
            <span className="muted small">{t("replays.addsAMatchframeReplayScene")}</span>
            {status?.twin ? <span className={`small ${status.twin.ready ? "muted" : "text-warn"}`}>{status.twin.ready ? t("replays.fadesBetweenReplaysThroughScene", { scene: status.twin.scene }) : t("replays.betweenReplaysDetail", { detail: status.twin.detail })}</span> : null}
          </div>
        )}
        {ranked.length ? (
          <div className="stack-sm" aria-label={t("replays.clipsOfTheRoundBest")}>
            <span className="small muted">{t("replays.roundVItsClipsBest", { v: status?.round ?? "?", v2: renderedNow ? t("replays.thisBreakPlaysAsOne") : "" })}</span>
            <ol className="ranked-replays small">
              {ranked.map((r) => (
                <li key={r.id} className="row">
                  <Badge tone={RANKED_STATE[r.state].tone}>{RANKED_STATE[r.state].label}</Badge>
                  {r.pinned ? <Badge tone="accent">{t("replays.pinnedFirst")}</Badge> : null}
                  <span>{r.label}</span>
                  <span className="muted">
                    {r.score}
                    {r.reasons.length ? ` · ${r.reasons.join(", ")}` : ""}
                  </span>
                  {r.note ? <span className="text-warn">{r.note}</span> : null}
                  {r.state !== "played" && r.state !== "picked" && (!r.note || r.excluded) ? (
                    <span className="row">
                      <Button size="sm" variant="ghost" disabledReason={reason} aria-label={r.excluded ? t("replays.includeLabel", { label: r.label }) : t("replays.excludeLabel", { label: r.label })} onClick={() => void control(`/api/v1/replays/auto/clips/${encodeURIComponent(r.id)}`, { excluded: !r.excluded }, "PUT")}>
                        {r.excluded ? t("replays.include") : t("replays.exclude")}
                      </Button>
                      {!r.excluded ? (
                        <Button size="sm" variant="ghost" disabledReason={reason} aria-label={r.pinned ? t("replays.unpinLabel", { label: r.label }) : t("replays.pinFirstLabel", { label: r.label })} onClick={() => void control(`/api/v1/replays/auto/clips/${encodeURIComponent(r.id)}`, { pinned: !r.pinned }, "PUT")}>
                          {r.pinned ? t("replays.unpin") : t("replays.pinFirst")}
                        </Button>
                      ) : null}
                      {!r.excluded && r.slow !== undefined ? (
                        <Button size="sm" variant={r.slow ? "secondary" : "ghost"} aria-pressed={r.slow} disabledReason={reason} title={r.slow ? t("replays.playsInSlowMotionPress") : t("replays.playsAtRealTimePress")} aria-label={t("replays.slowLabel", { label: r.label })} onClick={() => void control(`/api/v1/replays/auto/clips/${encodeURIComponent(r.id)}`, { slow: !r.slow }, "PUT")}>{t("replays.slow")}</Button>
                      ) : null}
                      {!r.excluded && r.starred !== undefined && st?.multiAngle !== "off" ? (
                        <Button size="sm" variant={r.starred ? "secondary" : "ghost"} aria-pressed={!!r.starred} disabledReason={reason} title={r.starred ? t("replays.starredItsExtraAnglesAre") : t("replays.askTheReplayPcFor")} aria-label={t("replays.starLabel", { label: r.label })} onClick={() => void control(`/api/v1/replays/auto/clips/${encodeURIComponent(r.id)}`, { starred: !r.starred }, "PUT")}>
                          {r.starred ? t("replays.starred") : t("replays.star")}
                        </Button>
                      ) : null}
                    </span>
                  ) : null}
                  {r.anglesWanted?.length ? <span className="muted">{t("replays.extraAngleAskedOfThe", { join: r.anglesWanted.map((v) => ANGLE_LABEL[v]).join(", ") })}</span> : null}
                  {r.angles?.length ? (
                    <ul className="list-plain stack-sm" aria-label={t("replays.extraAnglesOfLabel", { label: r.label })} style={{ flexBasis: "100%", paddingLeft: 24 }}>
                      {r.angles.map((a) => (
                        <li key={a.id} className="row">
                          <Badge tone={RANKED_STATE[a.state].tone}>{RANKED_STATE[a.state].label}</Badge>
                          <span>{`↳ ${ANGLE_LABEL[a.angle]}`}</span>
                          {a.state !== "played" && a.state !== "picked" ? (
                            <span className="row">
                              <Button size="sm" variant="ghost" disabledReason={reason} aria-label={a.excluded ? t("replays.includeLabel", { label: a.label }) : t("replays.excludeLabel", { label: a.label })} onClick={() => void control(`/api/v1/replays/auto/clips/${encodeURIComponent(a.id)}`, { excluded: !a.excluded }, "PUT")}>
                                {a.excluded ? t("replays.include") : t("replays.exclude")}
                              </Button>
                              <Button size="sm" variant={a.slow ? "secondary" : "ghost"} aria-pressed={a.slow} disabledReason={reason} aria-label={t("replays.slowLabel", { label: a.label })} onClick={() => void control(`/api/v1/replays/auto/clips/${encodeURIComponent(a.id)}`, { slow: !a.slow }, "PUT")}>{t("replays.slow")}</Button>
                            </span>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </li>
              ))}
            </ol>
          </div>
        ) : null}
        {status?.lastPlayed ? <p className="small muted">{t("replays.lastReplayLabel", { label: status.lastPlayed.label })}</p> : null}
        {status?.render && !vmix ? <p className={`small ${status.render.rendered ? "muted" : "text-warn"}`}>{`${status.render.kind === "highlights" ? t("replays.lastHighlights") : status.render.kind === "test" ? t("replays.lastTestReplays") : t("replays.lastBreak")}: ${status.render.detail}`}</p> : null}
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
      toast.push("warn", t("replays.audioInputsNotRead"), describeError(e));
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
    <div className="stack-sm" aria-label={t("replays.soundDuringReplays")}>
      <h4 className="hud-section-title">{t("replays.sound")}</h4>
      <div className="form-grid">
        <Field label={t("replays.replayVolume")} hint={vmix ? t("replays.eachReplayInputInVmix") : t("replays.bothReplayMediaSourcesYour")}>
          <select value={st.replayVolumeDb === null || st.replayVolumeDb === undefined ? "" : String(st.replayVolumeDb)} disabled={off} onChange={(e) => void save({ replayVolumeDb: e.target.value === "" ? null : Number(e.target.value) })}>
            {[...REPLAY_VOLUMES, ...(st.replayVolumeDb !== null && st.replayVolumeDb !== undefined && !(REPLAY_VOLUMES as readonly (number | null)[]).includes(st.replayVolumeDb) ? [st.replayVolumeDb] : [])].map((db) => (
              <option key={String(db)} value={db === null ? "" : String(db)}>
                {db === null ? (vmix ? t("replays.asVmixHasIt") : t("replays.asSetInObs")) : db === 0 ? t("replays.text0DbAsRecorded") : t("replays.vDbDb", { v: db > 0 ? "+" : "", db })}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t("replays.liveGameAudioDuringReplays")} hint={t("replays.turnedDownWithAShort")}>
          <select value={String(st.duckTo ?? -20)} disabled={off} onChange={(e) => void save({ duckTo: e.target.value === "mute" ? "mute" : Number(e.target.value) })}>
            {DUCK_TO.map((d) => (
              <option key={String(d)} value={String(d)}>
                {d === "mute" ? t("replays.muted") : t("replays.dDb", { d })}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <div className="stack-sm" role="group" aria-label={t("replays.liveGameAudioInputs")}>
        <span className="small muted">{t("replays.theLiveGameAudioTick", { v: vmix ? t("replays.vmixInputs") : t("replays.obsAudioInputs") })}</span>
        {inputs?.error ? <span className="small text-warn">{inputs.error}</span> : null}
        {list.map((i) => (
          <Checkbox key={i.id} checked={picked.includes(i.id)} disabled={off || i.replay} label={`${i.name}${i.replay ? t("replays.aReplaySourceNeverTurned") : ""}`} hint={vmix ? t("replays.vmixVolumeVolumeV", { volume: Math.round(i.volume), v: i.muted ? t("replays.offSuffix") : "" }) : t("replays.vDbV2", { v: i.volume <= -100 ? "-inf" : i.volume, v2: i.muted ? t("replays.mutedSuffix") : "" })} onChange={(v) => pick(i.id, v)} />
        ))}
        {missing.map((id) => (
          <Checkbox key={id} checked disabled={off} label={t("replays.idNotFoundInV", { id, v: vmix ? "vMix" : "OBS" })} onChange={() => pick(id, false)} />
        ))}
        <div className="row">
          <Button size="sm" onClick={() => void find()}>{t("replays.findAudioInputs")}</Button>
          {audio ? <span className={`small ${audio.state === "lowered" ? "text-warn" : "muted"}`}>{audio.detail}</span> : null}
        </div>
        {audio?.lastRestore && !audio.lastRestore.ok ? <span className="small text-warn">{audio.lastRestore.detail}</span> : null}
      </div>
      <p className="muted small">{t("replays.replaysCarryTheReplayPc")}</p>
    </div>
  );
}

/** Test replays: two sample clips on program now, through the whole chain, then what worked and how to fix what didn't. */
function TestReplays({ report, running, reason, onDone }: { report: ReplayTestReport | null; running: boolean; reason: string | null; onDone: (r: AutoReplayResponse) => void }) {
  return (
    <div className="stack-sm" aria-label={t("replays.testReplays")}>
      <h4 className="hud-section-title">{t("replays.testReplays")}</h4>
      <div className="row">
        <ActionButton
          action={() => api.post<AutoReplayResponse>("/api/v1/replays/auto/test")}
          confirm={{
            title: t("replays.testReplaysOnAir"),
            body: t("replays.thisPlaysOnYourProgram"),
            confirmLabel: t("replays.playTheTestNow"),
          }}
          success={null}
          onDone={onDone}
          disabledReason={reason ?? (report?.state === "running" ? t("replays.testReplaysArePlaying") : running ? t("replays.replaysArePlaying") : null)}
        >{t("replays.testReplays")}</ActionButton>
        <span className="muted small">{t("replays.playsTwoSampleClipsThrough")}</span>
      </div>
      {report ? (
        <ol className="stack-sm small" aria-label={t("replays.testReplaysReport")}>
          {report.steps.map((s) => (
            <li key={s.id} className="stack-sm">
              <div className="row">
                <Badge tone={STEP_TONE[s.state]}>{STEP_LABEL[s.state]}</Badge>
                <span>{s.label}</span>
                {s.detail ? <span className="muted">{s.detail}</span> : null}
              </div>
              {s.state === "failed" && s.fix ? <span className="text-warn">{t("replays.fixFix", { fix: s.fix })}</span> : null}
            </li>
          ))}
        </ol>
      ) : null}
      {report && report.state !== "running" ? <span className={`small ${report.state === "passed" ? "muted" : "text-warn"}`}>{report.state === "passed" ? t("replays.everyStepWorked") : t("replays.someStepsFailedSeeFix")}</span> : null}
    </div>
  );
}

/** Keys for the replays playing: the console's own, and (in the program) global hotkeys that work with CS2 or OBS in front. */
function ReplayHotkeys() {
  return <Hotkeys keys={REPLAY_KEYS} label={t("replays.replayHotkeys")} devices={t("replays.theDeviceActionsReplaySkip")} />;
}

/**
 * Console shortcuts and (in the program) global hotkeys for some of the replay keys (`keys`: the
 * replays' Skip, Hold, Stop; or the highlights' Play and Stop). Global hotkeys are off until set.
 */
export function Hotkeys({ keys, label, devices }: { keys: ReplayKey[]; label: string; devices: string }) {
  const bridge = replayHotkeys();
  const ids = keys.map((k) => k.id);
  const pick = <T,>(o: Partial<Record<ReplayKeyAction, T>>, fill: T) => Object.fromEntries(ids.map((id) => [id, o[id] ?? fill])) as Record<ReplayKeyAction, T>;
  const [state, setState] = useState<ReplayHotkeyState | null>(null);
  const [draft, setDraft] = useState<Record<ReplayKeyAction, string>>(() => pick<string>({}, ""));
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void bridge
      ?.get()
      .then((s) => {
        setState(s);
        setDraft(pick<string>(s.keys as Partial<Record<ReplayKeyAction, string>>, ""));
      })
      .catch((e) => setError(describeError(e)));
  }, [bridge]);
  const set = async (patch: Partial<Record<ReplayKeyAction, string | null>>) => {
    if (!bridge) return;
    setError(null);
    try {
      const s = await bridge.set(patch);
      setState(s);
      setDraft(pick<string>(s.keys as Partial<Record<ReplayKeyAction, string>>, ""));
    } catch (e) {
      setError(describeError(e));
    }
  };
  return (
    <div className="stack-sm" aria-label={label}>
      <h4 className="hud-section-title">{t("replays.hotkeysAndStreamDeck")}</h4>
      <p className="muted small">{t("replays.inTheConsoleJoinStream", { join: keys.map((k) => `${shortcutLabel(k.key)} ${k.label}`).join(" · "), devices })}</p>
      {bridge ? (
        <div className="stack-sm">
          <span className="small muted">{t("replays.globalHotkeysWorkWithCs2")}</span>
          <div className="form-grid">
            {keys.map((k) => (
              <Field key={k.id} label={t("replays.labelGlobal", { label: k.label })} hint={state?.errors[k.id] ?? (state?.keys[k.id] ? (state.registered[k.id] ? t("replays.registered") : t("replays.notRegistered")) : t("replays.off"))}>
                <input value={draft[k.id] ?? ""} placeholder={state?.suggested[k.id] ?? ""} spellCheck={false} onChange={(e) => setDraft((d) => ({ ...d, [k.id]: e.target.value }))} onBlur={() => (draft[k.id] ?? "") !== (state?.keys[k.id] ?? "") && void set({ [k.id]: (draft[k.id] ?? "").trim() || null })} />
              </Field>
            ))}
          </div>
          <div className="row">
            <Button size="sm" disabledReason={!state ? t("common.loading") : null} onClick={() => state && void set(Object.fromEntries(ids.filter((id) => state.suggested[id]).map((id) => [id, state.suggested[id]])))}>{t("replays.useTheSuggestedKeys")}</Button>
            <Button size="sm" variant="ghost" disabledReason={!state ? t("common.loading") : null} onClick={() => void set(Object.fromEntries(ids.map((id) => [id, null])))}>{t("replays.turnThemOff")}</Button>
          </div>
          {keys
            .filter((k) => state?.errors[k.id])
            .map((k) => (
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

function timingLabel(tRow: ReplayPcResponse["status"]["timing"]): string {
  if (tRow.delayMs === null || tRow.state === "measuring") return t("replays.timing");
  const s = (Math.abs(tRow.delayMs) / 1000).toFixed(1);
  return tRow.state === "behind" ? t("replays.sSBehind", { s }) : tRow.state === "ahead" ? t("replays.sSAhead", { s }) : t("replays.sameTime");
}

const SECOND_CSTV = "tv_enable1 1\ntv_port1 27021\ntv_delay1 17";

const SAME_CSTV_HINT = perLocale(() => ({
  stay_behind: t("replays.whenThisComputerIsAt"),
  each_kill: t("replays.whenAKillTheMain"),
  off: t("replays.thisComputerFilmsSomeoneElse"),
} as const));

/** The best setup: this computer a few seconds behind the main PC, so it knows each missed kill before it plays here. */
function BehindHelp() {
  return (
    <details className="small">
      <summary>{t("replays.bestThisComputerAbout7")}</summary>
      <div className="stack-sm">
        <p>{t("replays.thenEveryKillTheMain")}</p>
        <ul>
          <li>{t("replays.bothOnTheSameCstv")}</li>
          <li>{t("replays.mainPcInTheServer")}</li>
          <li><T k="replays.mainPcOnCstvGive" values={{ div: <div className="row">
              <code className="mono">{SECOND_CSTV.replace(/\n/g, "; ")}</code>
              <CopyButton text={SECOND_CSTV} label={t("common.copy")} />
            </div> }} /></li>
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
    <Panel title={t("replays.replayPc")} subtitle={t("replays.aSecondComputerWithIts")}>
      <Tabs
        label={t("replays.whichComputerThisIs")}
        value={tab}
        onChange={setTab}
        tabs={[
          { id: "main" as const, label: t("replays.thisIsTheMainPc") },
          { id: "replay" as const, label: isReplayPc ? t("replays.thisIsTheReplayPc2") : t("replays.thisIsTheReplayPc") },
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
      toast.push("info", on ? t("replays.otherComputersCanConnect") : t("replays.onlyThisComputerCanConnect2"), t("replays.theEngineRestartsTheConsole"));
    }
  };
  const addresses = net.data?.addresses ?? [];
  const port = net.data?.apiPort ?? 37211;
  return (
    <div className="stack-sm">
      <ol className="steps small">
        <li>{t("replays.letOtherComputersConnectTo")}</li>
        <li>{t("replays.makeAReplayPcCode2")}</li>
        <li>{t("replays.turnOnAutomaticReplaysAbove")}</li>
      </ol>
      {bridge ? (
        <Checkbox checked={access === true} disabled={!!reason || access === null} label={t("replays.letOtherComputersOnThe")} hint={t("replays.theyStillNeedACode")} onChange={(v) => void toggle(v)} />
      ) : (
        <Note tone="neutral">{t("replays.networkAccessIsSetIn")}</Note>
      )}
      {net.data?.reachable ? (
        addresses.length ? (
          <div className="stack-sm">
            <span className="small muted">{t("replays.thisComputerSAddressUse")}</span>
            {addresses.map((a) => (
              <div key={a} className="row">
                <code>{`${a}:${port}`}</code>
                <CopyButton text={`${a}:${port}`} label={t("common.copy")} />
              </div>
            ))}
          </div>
        ) : (
          <Note tone="warn">{t("replays.thisComputerHasNoNetwork")}</Note>
        )
      ) : net.data ? (
        <p className="small muted">{t("replays.onlyThisComputerCanConnect")}</p>
      ) : null}
      <div className="row">
        <ActionButton
          action={() => api.post<{ token: string }>("/api/v1/tokens", { role: "replay", label: t("replays.replayPcTolocaledatestring", { toLocaleDateString: new Date().toLocaleDateString() }) })}
          success={t("replays.replayPcCodeMadeType")}
          onDone={(tRow) => setCode(tRow.token)}
          disabledReason={reason}
        >{t("replays.makeAReplayPcCode")}</ActionButton>
      </div>
      {code ? (
        <div className="row">
          <code className="mono">{code}</code>
          <CopyButton text={code} label={t("replays.copyCode")} />
          <span className="muted small">{t("replays.shownOnceRemoveItIn")}</span>
        </div>
      ) : null}
      <ReplayFeedSection />
    </div>
  );
}

const FEED_TONE = { off: "neutral", starting: "info", waiting: "warn", recording: "ok", error: "warn" } as const;
/** An ffmpeg encoder in words. */
const encoderName = (id: string) => ({ h264_nvenc: "NVIDIA (NVENC)", h264_qsv: "Intel (Quick Sync)", h264_amf: "AMD (AMF)", libx264: t("replays.encoderCpu") })[id] ?? id;
const ENCODERS = perLocale(() => ([
  { id: "auto", label: t("replays.bestThisComputerHas") },
  { id: "h264_nvenc", label: t("replays.nvidiaNvenc") },
  { id: "h264_qsv", label: t("replays.intelQuickSync") },
  { id: "h264_amf", label: "AMD (AMF)" },
  { id: "libx264", label: t("replays.cpuX264") },
] as const));

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
      toast.push("danger", t("replays.settingNotSaved"), describeError(e));
    }
  };
  const st = feed.data?.settings;
  const status = feed.data?.status;
  const ff = status?.ffmpeg;
  const encoder = status?.encoder ?? ff?.encoder ?? null;
  const d = status?.diagnostics;
  const choices = [...(sources ?? []), ...(st?.source && !sources?.some((x) => x.name === st.source!.name) ? [st.source] : [])];
  return (
    <div className="stack-sm">
      <h3 className="gb-section-title">{t("replays.replayFeedNdi")}</h3>
      <p className="small muted">{t("replays.thisComputerRecordsTheReplay")}</p>
      <Checkbox checked={st?.enabled ?? false} disabled={!!reason || !st} label={t("replays.recordTheReplayPcS")} hint={t("replays.itKeepsTheLastFew")} onChange={(v) => void save({ enabled: v })} />
      {ff?.source === "missing" ? (
        ff.canDownload ? (
          <div className="row">
            <ActionButton action={() => api.post("/api/v1/replays/feed/ffmpeg")} success={t("replays.ffmpegDownloaded")} onDone={() => void feed.reload()} disabledReason={reason ?? (ff.downloading !== null ? t("replays.downloading") : null)}>{t("replays.downloadFfmpeg")}</ActionButton>
            <span className="muted small">{ff.downloading !== null ? t("replays.downloadingRound", { round: Math.round(ff.downloading * 100) }) : t("replays.theRecordingNeedsFfmpegA")}</span>
          </div>
        ) : (
          <Note tone="warn">{t("replays.theRecordingNeedsFfmpegInstall")}</Note>
        )
      ) : ff ? (
        <span className="small muted">{t("replays.ffmpegVV2", { v: ff.version ?? "", v2: encoder ? t("replays.encodingWithEncoder", { encoder: encoderName(encoder) }) : "" })}</span>
      ) : null}
      {ff?.error ? <span className="small text-warn">{ff.error}</span> : null}
      <div className="form-grid">
        <Field label={t("replays.theReplayPcSNdi")} hint={t("replays.startTheNdiSenderOn")}>
          <select value={st?.source?.name ?? ""} disabled={!!reason || !st} onChange={(e) => void save({ source: choices.find((c) => c.name === e.target.value) ?? null })}>
            <option value="" disabled>
              {sources === null ? t("replays.pressFindNdiSources") : sources.length ? t("replays.chooseOne") : t("replays.noNdiSourcesFound")}
            </option>
            {choices.map((c) => (
              <option key={c.name} value={c.name}>
                {c.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t("replays.encoder")}>
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
        <ActionButton action={() => api.post<{ sources: { name: string; urlAddress?: string }[]; error: string | null }>("/api/v1/replays/feed/sources")} success={(r) => (r.error ? `NDI: ${r.error}` : t("replays.ndiSourcesFound", { count: r.sources.length }))} onDone={(r) => setSources(r.sources)} disabledReason={reason}>{t("replays.findNdiSources")}</ActionButton>
        {status?.ndi.version ? <span className="muted small">{status.ndi.version}</span> : status?.ndi.error ? <span className="small text-warn">NDI: {status.ndi.error}</span> : null}
      </div>
      {status && status.enabled ? (
        <div className="stack-sm small" role="status">
          <div className="row">
            <Badge tone={FEED_TONE[status.state]}>{status.state === "recording" ? t("replays.recording") : status.state === "waiting" ? t("replays.noPicture") : status.state === "starting" ? t("replays.starting") : status.state === "error" ? t("replays.notRecording") : t("replays.off")}</Badge>
            <span>{status.detail}</span>
          </div>
          {status.state === "recording" ? (
            <span className="muted">{t("replays.tofixedSKeptTofixed2V", { toFixed: status.bufferedSec.toFixed(0), toFixed2: status.receivingFps.toFixed(0), v: d?.sourceFps ? t("replays.ofSourcefps", { sourceFps: Math.round(d.sourceFps) }) : "", clips: status.clips })}</span>
          ) : null}
          {status.state === "recording" && status.losses ? (
            status.losses.length ? (
              <ul className="list-plain stack-sm" aria-label={t("replays.framesLost")}>
                {status.losses.map((l) => (
                  <li key={l.where}>
                    <span className="text-warn">{l.text}</span> <span className="muted">{l.hint}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <span className="muted">{t("replays.noFramesLostInThe")}</span>
            )
          ) : null}
          {status.state === "recording" && d ? (
            <span className="muted small">{t("replays.sinceItStarted", { repeated: t("replays.framesRepeated", { count: d.repeated }), encoderDropped: d.encoderDropped, ndi: d.ndi ? t("replays.videodroppedDroppedByNdi", { videoDropped: d.ndi.videoDropped }) : "", audio: d.audio ? t("replays.soundDetail", { dropouts: t("replays.soundDropouts", { count: d.audio.dropouts }), resyncs: t("replays.soundResyncs", { count: d.audio.corrections + d.audio.joins }) }) : "" })}</span>
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
        <li>{t("replays.onThisComputerStartCs2")}</li>
        <li>{t("replays.typeTheMainPcS2")}</li>
      </ol>
      <BehindHelp />
      <div className="form-grid">
        <Field label={t("replays.mainPcAddress")} hint={t("replays.asShownOnTheMain")}>
          <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="192.168.1.20:37211" spellCheck={false} />
        </Field>
        <Field label={t("replays.replayPcCode")} hint={data?.hasToken ? t("replays.aCodeIsSavedType") : t("replays.madeOnTheMainPc")}>
          <input value={token} onChange={(e) => setToken(e.target.value)} type="password" autoComplete="off" spellCheck={false} placeholder={data?.hasToken ? "••••••••" : ""} />
        </Field>
      </div>
      <div className="row">
        <ActionButton
          variant="primary"
          action={() => api.put<ReplayPcResponse>("/api/v1/replay-pc", { enabled: true, mainUrl: url, ...(token ? { token } : {}) })}
          success={t("replays.connectingToTheMainPc")}
          onDone={() => {
            setToken("");
            reload();
          }}
          disabledReason={reason ?? (!url.trim() ? t("replays.typeTheMainPcS") : !token && !data?.hasToken ? t("replays.typeTheReplayPcCode") : null)}
        >
          {enabled ? t("replays.saveAndReconnect") : t("replays.makeThisTheReplayPc")}
        </ActionButton>
        {enabled ? (
          <Button variant="ghost" disabledReason={reason} onClick={() => void api.put("/api/v1/replay-pc", { enabled: false }).then(reload)}>{t("replays.stopBeingTheReplayPc")}</Button>
        ) : null}
      </div>
      {enabled ? (
        <div className="form-grid">
          <Field label={t("replays.onTheSameCstvAs")} hint={SAME_CSTV_HINT[data?.settings.sameCstv ?? "stay_behind"]}>
            <select value={data?.settings.sameCstv ?? "stay_behind"} disabled={!!reason} onChange={(e) => void api.put("/api/v1/replay-pc", { sameCstv: e.target.value }).then(reload)}>
              <option value="stay_behind">{t("replays.goBackAndStayBehind")}</option>
              <option value="each_kill">{t("replays.goBackForEachMissed")}</option>
              <option value="off">{t("replays.donTGoBack")}</option>
            </select>
          </Field>
          <Field label={t("replays.killsToFilm")} hint={t("replays.behindTheMainPcThis")}>
            <select value={data?.settings.filmAll === false ? "missed" : "all"} disabled={!!reason} onChange={(e) => void api.put("/api/v1/replay-pc", { filmAll: e.target.value === "all" }).then(reload)}>
              <option value="all">{t("replays.everyKillRecommended")}</option>
              <option value="missed">{t("replays.onlyKillsTheMainCamera")}</option>
            </select>
          </Field>
          <Checkbox
            checked={data?.settings.filmAngles ?? false}
            disabled={!!reason}
            label={t("replays.filmExtraAnglesExperimental")}
            hint={t("replays.whenTheMainPcAsks")}
            onChange={(v) => void api.put("/api/v1/replay-pc", { filmAngles: v }).then(reload)}
          />
          {data?.settings.sameCstv === "stay_behind" ? (
            <Field label={t("replays.howFarBehind")}>
              <select value={data.settings.behindMs} disabled={!!reason} onChange={(e) => void api.put("/api/v1/replay-pc", { behindMs: Number(e.target.value) }).then(reload)}>
                {[5000, 7000, 10000].map((ms) => (
                  <option key={ms} value={ms}>{t("replays.vSDemoGototickV2", { v: ms / 1000, v2: (ms / 1000) * 64 })}</option>
                ))}
              </select>
            </Field>
          ) : null}
        </div>
      ) : null}
      {st && st.enabled ? (
        <div className="stack-sm small" role="status">
          <div className="row">
            <Badge tone={st.state === "connected" ? "ok" : st.state === "error" ? "warn" : "info"}>{st.state === "connected" ? t("replays.linked") : st.state === "error" ? t("replays.notLinked") : t("replays.connecting")}</Badge>
            <span>{st.detail}</span>
          </div>
          {st.state === "connected" ? (
            <div className="row">
              <Badge tone={TIMING_TONE[st.timing.state]}>{timingLabel(st.timing)}</Badge>
              <span>{st.timing.detail}</span>
            </div>
          ) : null}
          {st.state === "connected" && st.timing.state !== "behind" ? <span>{t("replays.theMainCameraShowsMainobserved", { mainObserved: nameOf(st.mainObserved) })}</span> : null}
          {data?.settings.sameCstv !== "off" && st.rewind.detail ? <span className={st.rewind.state === "unsupported" ? "text-warn" : ""}>{t("replays.goingBackDetail", { detail: st.rewind.detail })}</span> : null}
          {st.filming ? <span>{t("replays.filmingNowFilmingV", { filming: st.filming, v: st.planned ? t("replays.plannedMorePlanned", { planned: st.planned }) : "" })}</span> : null}
          {st.transport === "feed" ? (
            <span>{t("replays.theMainPcRecordsThis")}</span>
          ) : (
            <span className={st.obsReady ? "" : "text-warn"}>{st.obsReady ? t("replays.obsReplayBufferIsRunning") : t("replays.connectObsOnThisComputer")}</span>
          )}
          <span>{t("replays.clipsSentSentVV2", { sent: st.sent, v: st.failed ? t("replays.notSentFailed", { failed: st.failed }) : "", v2: st.last ? t("replays.lastLabelV", { label: st.last.label, v: st.last.ok ? "" : ` (${st.last.error})` }) : "" })}</span>
          {st.lastSkip ? (
            <span className="muted">{t("replays.notFilmedSkippedLastLabel", { skipped: st.skipped, label: st.lastSkip.label, reason: st.lastSkip.reason })}</span>
          ) : null}
          {st.angles && st.angles.state !== "off" ? (
            <span className={st.angles.state === "unsupported" ? "text-warn" : ""}>{t("replays.extraAnglesVV2", { v: st.angles.detail || t("replays.noneAskedFor"), v2: st.angles.filmed || st.angles.failed ? t("replays.filmedFilmedVV2", { filmed: st.angles.filmed, v: st.angles.failed ? t("replays.notFilmedCount", { failed: st.angles.failed }) : "", v2: st.angles.last && !st.angles.last.ok ? t("replays.lastAngleFailed", { label: st.angles.last.label, detail: st.angles.last.detail }) : "" }) : "" })}</span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
