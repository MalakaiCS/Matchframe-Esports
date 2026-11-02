import { useEffect, useState } from "react";
import { api, describeError } from "../../api/index.ts";
import { useToast } from "../../components/toasts.tsx";
import { ActionButton, Button, Details, Field, KV, Note, Panel } from "../../components/ui.tsx";
import { usePermission } from "../../state/session.tsx";
import { fmtDelay } from "./TeamPanel.tsx";
import type { CalibrationStatus, CommsView, TimingTestStatus } from "./types.ts";

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
      toast.push("danger", "No mark", describeError(e));
    }
  };
  const step = !cal.live && !cal.armed ? 1 : cal.armed ? 2 : 3;
  return (
    <Panel title="Delay against the gameplay" subtitle="Line the comms up with the observer's gameplay as OBS shows it: a call heard live, the same moment seen in the gameplay.">
      <div className="stack-sm">
        <ol className="small comms-steps">
          <li className={step === 1 ? "is-current" : ""}>Choose the team, ask a player to say a short “mark!” (or clap) exactly as they do something you will see: a shot, a flash popping, a jump. Press Arm just before.</li>
          <li className={step === 2 ? "is-current" : ""}>MatchFrame takes the start of the call from that player's own TeamSpeak sound (to 7.5 ms).</li>
          <li className={step === 3 ? "is-current" : ""}>Watch the observer's gameplay in OBS (program, preview or the recording scene). Press Seen the moment it happens there.</li>
          <li>Three to five marks; use the suggested delay; then check one recording and fine-tune the milliseconds.</li>
        </ol>
        <div className="row-end">
          <Field label="Team">
            <select aria-label="Calibration team" value={team} disabled={!!reason} onChange={(e) => setTeam(e.target.value)}>
              {teams.map((s) => (
                <option key={s.team!.id} value={s.team!.id}>
                  {s.team!.name ?? `Team ${s.id}`}
                </option>
              ))}
            </select>
          </Field>
          <ActionButton disabledReason={reason ?? (!team ? "No team" : !view.enabled ? "Team Comms is off" : null)} action={() => api.post<CalibrationStatus>("/api/v1/comms/calibration/arm", { teamId: team })} onDone={onChanged} success="Listening for the call">
            Arm: listen for the call
          </ActionButton>
          <Button variant="primary" size="lg" disabledReason={reason ?? (cal.live ? null : "No call heard yet")} onClick={() => void seen()}>
            Seen in gameplay
          </Button>
        </div>
        <p className="small" role="status" aria-live="polite">
          {cal.live ? `Heard ${cal.live.who} ${(cal.live.agoMs / 1000).toFixed(1)} s ago: press Seen when it shows in the gameplay.` : cal.armed ? `Listening for the next call (${Math.ceil(cal.armed.forMs / 1000)} s left)…` : "Not armed."}
        </p>
        {cal.marks.length ? (
          <KV items={cal.marks.map((m, i) => [`Mark ${i + 1} (${m.who})`, `${fmtDelay(m.offsetMs)} from the call to the gameplay`] as [string, string])} />
        ) : null}
        {cal.applied ? <p className="small muted">{`In use since ${cal.applied.at.slice(0, 16).replace("T", " ")}: ${fmtDelay(cal.applied.delayMs)} from ${cal.applied.marks} mark${cal.applied.marks === 1 ? "" : "s"}.`}</p> : null}
        {sug ? (
          <Note tone="info" title={`Suggested delay: ${fmtDelay(sug.delayMs)}`}>
            Median of {sug.n} mark{sug.n === 1 ? "" : "s"} {fmtDelay(sug.medianOffsetMs)} (spread {sug.spreadMs} ms), less {cal.settings.reactionMs} ms reaction and {cal.sendLatencyMs} ms for the comms to reach OBS. {sug.n < 3 ? "Take a few more marks: one is a guess." : sug.spreadMs > 300 ? "The marks disagree by more than 300 ms: take more." : ""}
          </Note>
        ) : null}
        <div className="row">
          <ActionButton variant="primary" disabledReason={reason ?? (sug ? null : "No marks yet")} action={() => api.post<{ delaySec: number; fineMs: number }>("/api/v1/comms/calibration/apply")} onDone={onChanged} success={(r) => `Delay set to ${r.delaySec} s ${r.fineMs} ms`} confirm={{ title: "Use the suggested delay?", body: "Every output fades out for a moment and plays from the new delay once the buffers hold it.", confirmLabel: "Use this delay" }}>
            Use this delay
          </ActionButton>
          <ActionButton variant="ghost" disabledReason={reason ?? (cal.marks.length || cal.live ? null : "Nothing to clear")} action={() => api.post("/api/v1/comms/calibration/clear")} onDone={onChanged}>
            Clear marks
          </ActionButton>
        </div>
        <Details summary="Reaction time and the check in a recording">
          <div className="stack-sm">
            <Field label="Your reaction (ms)" hint="Taken off each mark: seeing something and pressing takes about 200 ms.">
              <span className="row">
                <input type="number" aria-label="Reaction (ms)" min={0} max={1000} value={reaction} disabled={!!reason} onChange={(e) => setReaction(e.target.value)} style={{ width: 90 }} />
                <ActionButton size="sm" disabledReason={reason ?? (Number(reaction) === cal.settings.reactionMs ? "No change" : null)} action={() => api.put("/api/v1/comms/calibration", { reactionMs: Number(reaction) })} onDone={onChanged}>
                  Set
                </ActionButton>
              </span>
            </Field>
            <p className="small">
              The check: record a minute with marks, open the file, step frame by frame to a mark. The call and the moment in the gameplay should be within a frame or two; move the delay's fine milliseconds by what's left (positive: comms later). Then compare the call with its card lighting and set the strip's timing offset the same way, or let the timing test below measure it.
            </p>
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
    <section className="stack-sm" aria-label="Timing test in a recording">
      <h4 className="comms-subhead">Timing test in a recording</h4>
      <ol className="small comms-steps">
        <li>Start the dedicated recording (a minute is enough) with someone included in it, so the strip shows cards.</li>
        <li>
          Press Run timing test: {test.beep.count} beeps ({test.beep.hz} Hz, {test.beep.ms} ms, one a second) in the recording comms only, every card lit on the same moments. Never on the public output.
        </li>
        <li>Stop the recording, then Find it in the recording: MatchFrame reads the file with ffmpeg.</li>
      </ol>
      <div className="row">
        <ActionButton disabledReason={reason ?? (!recording ? "Start the dedicated recording first" : cards < 1 ? "The strip shows nobody: include someone in the recording" : test.running ? "Running" : null)} action={() => api.post<TimingTestStatus>("/api/v1/comms/timing-test/start")} onDone={onChanged} success="Beeps on their way to the recording">
          Run timing test
        </ActionButton>
        <ActionButton disabledReason={reason ?? (!test.lastRun ? "Run the timing test first" : test.analysing ? "Analysing" : view.recorder.state === "recording" ? "Stop the recording first (its file must be finished)" : null)} action={() => api.post<TimingTestStatus>("/api/v1/comms/timing-test/analyse")} onDone={onChanged} success="Found in the recording">
          Find it in the recording
        </ActionButton>
        <ActionButton variant="primary" disabledReason={reason ?? (!r ? "Nothing found yet" : r.applied ? "Applied" : null)} action={() => api.post<TimingTestStatus>("/api/v1/comms/timing-test/apply")} onDone={onChanged} success="Applied" confirm={r && r.suggestion.fineMs !== null ? { title: "Apply the timing test?", body: "The strip's timing offset changes, and so does the delay (every output fades out for a moment).", confirmLabel: "Apply" } : undefined}>
          Apply the suggestion
        </ActionButton>
      </div>
      <p className="small" role="status" aria-live="polite">
        {test.running ? `Beeping: ${Math.ceil(test.running.endsInMs / 1000)} s left.` : test.lastRun && !r ? `Last test ${test.lastRun.startedAt.slice(11, 19)} with ${test.lastRun.cards} card${test.lastRun.cards === 1 ? "" : "s"}: not analysed yet.` : null}
      </p>
      {r ? (
        <Note tone={r.pairs >= 3 && r.spreadMs <= 2 * Math.max(17, r.frameMs) ? "info" : "warn"} title={`The strip lit ${Math.abs(r.medianMs)} ms ${r.medianMs >= 0 ? "after" : "before"} the beep in the recording`}>
          {`${r.pairs} of ${r.beeps} beeps matched (spread ${r.spreadMs} ms, one frame ${r.frameMs} ms). Suggested: strip timing offset ${r.suggestion.stripOffsetMs} ms${r.suggestion.fineMs !== null ? `, delay ${r.suggestion.delaySec} s + ${r.suggestion.fineMs} ms` : ""}. ${r.suggestion.note}${r.applied ? " Applied." : ""}`}
        </Note>
      ) : null}
    </section>
  );
}
