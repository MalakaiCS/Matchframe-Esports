import { useEffect, useState } from "react";
import { api, describeError } from "../../api/index.ts";
import { useToast } from "../../components/toasts.tsx";
import { ActionButton, Button, Details, Field, KV, Note, Panel } from "../../components/ui.tsx";
import { usePermission } from "../../state/session.tsx";
import { fmtDelay } from "./TeamPanel.tsx";
import type { CalibrationStatus, CommsView, TimingTestStatus } from "./types.ts";
import { t } from "../../i18n/index.ts";

type Reload = () => void;

/**
 * The comms delay against the observer's gameplay (ADR-068): a player calls "mark" at a visible
 * moment; MatchFrame takes the call's start from their own TeamSpeak stream (exact); the operator
 * presses Seen when the moment shows in the gameplay in OBS. The median of a few marks, less the
 * reaction time and the comms' path to OBS, is the suggested delay. The recording file is the check.
 */
export function CalibrationPanel({ view, onChanged }: { view: CommsView; onChanged: Reload }) {
  const cal = view.calibration;
  const reason = usePermission("program.control");
  const toast = useToast();
  const teams = view.slots.filter((s) => s.team);
  const [team, setTeam] = useState(teams[0]?.team?.id ?? "");
  useEffect(() => {
    if (!team && teams[0]?.team) setTeam(teams[0].team.id);
  }, [team, teams]);
  const [reaction, setReaction] = useState(String(cal.settings.reactionMs));
  useEffect(() => setReaction(String(cal.settings.reactionMs)), [cal.settings.reactionMs]);
  const sug = cal.suggestion;
  const seen = async () => {
    try {
      await api.post<CalibrationStatus>("/api/v1/comms/calibration/seen");
      onChanged();
    } catch (e) {
      toast.push("danger", t("comms.noMark"), describeError(e));
    }
  };
  const step = !cal.live && !cal.armed ? 1 : cal.armed ? 2 : 3;
  return (
    <Panel title={t("comms.delayAgainstTheGameplay")} subtitle={t("comms.lineTheCommsUpWith")}>
      <div className="stack-sm">
        <ol className="small comms-steps">
          <li className={step === 1 ? "is-current" : ""}>{t("comms.chooseTheTeamAskA")}</li>
          <li className={step === 2 ? "is-current" : ""}>{t("comms.matchframeTakesTheStartOf")}</li>
          <li className={step === 3 ? "is-current" : ""}>{t("comms.watchTheObserverSGameplay")}</li>
          <li>{t("comms.threeToFiveMarksUse")}</li>
        </ol>
        <div className="row-end">
          <Field label={t("comms.team")}>
            <select aria-label={t("comms.calibrationTeam")} value={team} disabled={!!reason} onChange={(e) => setTeam(e.target.value)}>
              {teams.map((s) => (
                <option key={s.team!.id} value={s.team!.id}>
                  {s.team!.name ?? t("comms.teamId", { id: s.id })}
                </option>
              ))}
            </select>
          </Field>
          <ActionButton disabledReason={reason ?? (!team ? t("comms.noTeam") : !view.enabled ? t("comms.teamCommsIsOff") : null)} action={() => api.post<CalibrationStatus>("/api/v1/comms/calibration/arm", { teamId: team })} onDone={onChanged} success={t("comms.listeningForTheCall")}>{t("comms.armListenForTheCall")}</ActionButton>
          <Button variant="primary" size="lg" disabledReason={reason ?? (cal.live ? null : t("comms.noCallHeardYet"))} onClick={() => void seen()}>{t("comms.seenInGameplay")}</Button>
        </div>
        <p className="small" role="status" aria-live="polite">
          {cal.live ? t("comms.heardWhoTofixedSAgo", { who: cal.live.who, toFixed: (cal.live.agoMs / 1000).toFixed(1) }) : cal.armed ? t("comms.listeningForTheNextCall", { ceil: Math.ceil(cal.armed.forMs / 1000) }) : t("comms.notArmed")}
        </p>
        {cal.marks.length ? (
          <KV items={cal.marks.map((m, i) => [t("comms.markN", { n: i + 1, who: m.who }), t("comms.offsetmsFromTheCallTo", { offsetMs: fmtDelay(m.offsetMs) })] as [string, string])} />
        ) : null}
        {cal.applied ? <p className="small muted">{t("comms.inUseSince", { at: cal.applied.at.slice(0, 16).replace("T", " "), delay: fmtDelay(cal.applied.delayMs), count: cal.applied.marks })}</p> : null}
        {sug ? (
          <Note tone="info" title={t("comms.suggestedDelayDelayms", { delayMs: fmtDelay(sug.delayMs) })}>{t("comms.medianOfMarks", { count: sug.n, medianOffsetMs: fmtDelay(sug.medianOffsetMs), spreadMs: sug.spreadMs, reactionMs: cal.settings.reactionMs, sendLatencyMs: cal.sendLatencyMs, v2: sug.n < 3 ? t("comms.takeAFewMoreMarks") : sug.spreadMs > 300 ? t("comms.theMarksDisagreeByMore") : "" })}</Note>
        ) : null}
        <div className="row">
          <ActionButton variant="primary" disabledReason={reason ?? (sug ? null : t("comms.noMarksYet"))} action={() => api.post<{ delaySec: number; fineMs: number }>("/api/v1/comms/calibration/apply")} onDone={onChanged} success={(r) => t("comms.delaySetToDelaysecS", { delaySec: r.delaySec, fineMs: r.fineMs })} confirm={{ title: t("comms.useTheSuggestedDelay"), body: t("comms.everyOutputFadesOutFor"), confirmLabel: t("comms.useThisDelay") }}>{t("comms.useThisDelay")}</ActionButton>
          <ActionButton variant="ghost" disabledReason={reason ?? (cal.marks.length || cal.live ? null : t("comms.nothingToClear"))} action={() => api.post("/api/v1/comms/calibration/clear")} onDone={onChanged}>{t("comms.clearMarks")}</ActionButton>
        </div>
        <Details summary={t("comms.reactionTimeAndTheCheck")}>
          <div className="stack-sm">
            <Field label={t("comms.yourReactionMs")} hint={t("comms.takenOffEachMarkSeeing")}>
              <span className="row">
                <input type="number" aria-label={t("comms.reactionMs")} min={0} max={1000} value={reaction} disabled={!!reason} onChange={(e) => setReaction(e.target.value)} style={{ width: 90 }} />
                <ActionButton size="sm" disabledReason={reason ?? (Number(reaction) === cal.settings.reactionMs ? t("comms.noChange") : null)} action={() => api.put("/api/v1/comms/calibration", { reactionMs: Number(reaction) })} onDone={onChanged}>{t("comms.set")}</ActionButton>
              </span>
            </Field>
            <p className="small">{t("comms.theCheckRecordAMinute")}</p>
          </div>
        </Details>
        {view.timingTest ? <TimingTest view={view} test={view.timingTest} onChanged={onChanged} /> : null}
      </div>
    </Panel>
  );
}

/**
 * The timing test in a recording (ADR-069): beeps in the recording comms with every strip card lit on
 * the same blocks; MatchFrame finds both in the finished file and suggests the strip's timing offset
 * (and the fine ms, when the delay is the marks' suggestion).
 */
function TimingTest({ view, test, onChanged }: { view: CommsView; test: TimingTestStatus; onChanged: Reload }) {
  const reason = usePermission("program.control");
  const r = test.result;
  const recording = view.recorder.state !== "idle";
  const cards = view.strip.cards.length;
  return (
    <section className="stack-sm" aria-label={t("comms.timingTestInARecording")}>
      <h4 className="comms-subhead">{t("comms.timingTestInARecording")}</h4>
      <ol className="small comms-steps">
        <li>{t("comms.startTheDedicatedRecordingA")}</li>
        <li>{t("comms.pressRunTimingTestCount", { count: test.beep.count, hz: test.beep.hz, ms: test.beep.ms })}</li>
        <li>{t("comms.stopTheRecordingThenFind")}</li>
      </ol>
      <div className="row">
        <ActionButton disabledReason={reason ?? (!recording ? t("comms.startTheDedicatedRecordingFirst") : cards < 1 ? t("comms.theStripShowsNobodyInclude") : test.running ? t("comms.running") : null)} action={() => api.post<TimingTestStatus>("/api/v1/comms/timing-test/start")} onDone={onChanged} success={t("comms.beepsOnTheirWayTo")}>{t("comms.runTimingTest")}</ActionButton>
        <ActionButton disabledReason={reason ?? (!test.lastRun ? t("comms.runTheTimingTestFirst") : test.analysing ? t("comms.analysing") : view.recorder.state === "recording" ? t("comms.stopTheRecordingFirstIts") : null)} action={() => api.post<TimingTestStatus>("/api/v1/comms/timing-test/analyse")} onDone={onChanged} success={t("comms.foundInTheRecording")}>{t("comms.findItInTheRecording")}</ActionButton>
        <ActionButton variant="primary" disabledReason={reason ?? (!r ? t("comms.nothingFoundYet") : r.applied ? t("comms.applied") : null)} action={() => api.post<TimingTestStatus>("/api/v1/comms/timing-test/apply")} onDone={onChanged} success={t("comms.applied")} confirm={r && r.suggestion.fineMs !== null ? { title: t("comms.applyTheTimingTest"), body: t("comms.theStripSTimingOffset"), confirmLabel: t("comms.apply") } : undefined}>{t("comms.applyTheSuggestion")}</ActionButton>
      </div>
      <p className="small" role="status" aria-live="polite">
        {test.running ? t("comms.beepingCeilSLeft", { ceil: Math.ceil(test.running.endsInMs / 1000) }) : test.lastRun && !r ? t("comms.lastTestNotAnalysed", { at: test.lastRun.startedAt.slice(11, 19), count: test.lastRun.cards }) : null}
      </p>
      {r ? (
        <Note tone={r.pairs >= 3 && r.spreadMs <= 2 * Math.max(17, r.frameMs) ? "info" : "warn"} title={r.medianMs >= 0 ? t("comms.stripLitAfter", { medianMs: Math.abs(r.medianMs) }) : t("comms.stripLitBefore", { medianMs: Math.abs(r.medianMs) })}>
          {t("comms.pairsOfBeepsBeepsMatched", { pairs: r.pairs, beeps: r.beeps, spreadMs: r.spreadMs, frameMs: r.frameMs, stripOffsetMs: r.suggestion.stripOffsetMs, v: r.suggestion.fineMs !== null ? t("comms.delayDelaysecSFinemsMs", { delaySec: r.suggestion.delaySec, fineMs: r.suggestion.fineMs }) : "", note: r.suggestion.note, v2: r.applied ? t("comms.appliedSuffix") : "" })}
        </Note>
      ) : null}
    </section>
  );
}
