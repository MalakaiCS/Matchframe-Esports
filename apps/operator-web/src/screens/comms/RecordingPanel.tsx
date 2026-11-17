import { useEffect, useState } from "react";
import { api, describeError } from "../../api/index.ts";
import { useToast } from "../../components/toasts.tsx";
import { ActionButton, Badge, Button, Details, Field, KV, Mono, Note, Panel } from "../../components/ui.tsx";
import { fmtBytes, fmtClock } from "../../lib/format.ts";
import { useApi } from "../../lib/hooks.ts";
import { usePermission } from "../../state/session.tsx";
import type { CommsView, LiveSources, RecorderStatus, RecordingSettings, SetupStep } from "./types.ts";
import { perLocale, t } from "../../i18n/index.ts";
import { T } from "../../i18n/T.tsx";

type Reload = () => void;

/** The recording's state's shape and word, so it never depends on colour alone. */
const MARK: Record<RecorderStatus["state"], { icon: string; tag: string }> = perLocale(() => ({
  idle: { icon: "○", tag: t("comms.notRecording") },
  recording: { icon: "●", tag: "Recording" },
  fault: { icon: "⚠", tag: "Fault" },
}));

/** NOT RECORDING, RECORDING — TEAM or RECORDING FAULT, with its elapsed time, in words. */
export function RecordingStateBanner({ rec, compact = false }: { rec: RecorderStatus | null; compact?: boolean }) {
  const state = rec?.state ?? "idle";
  const m = MARK[state];
  return (
    <div className={`comms-state comms-rec-${state} ${compact ? "is-compact" : ""}`} role="status" aria-live="polite" aria-label={t("comms.commsRecordingV", { v: rec?.label ?? t("common.loading") })}>
      <span className="comms-state-icon" aria-hidden>
        {m.icon}
      </span>
      <div className="comms-state-text">
        <div className="comms-state-kicker"><T k="comms.commsRecordingSpanV" values={{ span: <span className="comms-state-tag">{m.tag}</span>, v: rec?.elapsedMs != null ? <span className="comms-rec-elapsed"> · {fmtClock(rec.elapsedMs / 1000)}</span> : null }} /></div>
        <div className="comms-state-label">{rec?.label ?? "…"}</div>
        {!compact || state === "fault" ? <div className="comms-state-detail">{rec?.detail ?? ""}</div> : null}
      </div>
    </div>
  );
}

/** Start Recording and Stop Recording: their own, never the public listen-in's. */
export function RecordingButtons({ rec, onDone, size = "md" }: { rec: RecorderStatus | null; onDone: (r: RecorderStatus) => void; size?: "sm" | "md" | "lg" }) {
  const reason = usePermission("program.control");
  return (
    <div className="comms-actions">
      <ActionButton size={size} variant="primary" action={() => api.post<RecorderStatus>("/api/v1/comms/recording/start")} onDone={onDone} success={t("comms.commsRecordingStarted")} disabledReason={reason ?? (rec ? rec.actions.start.disabledReason : t("common.loading"))}>{t("comms.startRecording")}</ActionButton>
      <ActionButton
        size={size}
        variant="danger"
        action={() => api.post<RecorderStatus>("/api/v1/comms/recording/stop")}
        onDone={onDone}
        success={(r) => (r.last?.path ? `Saved: ${r.last.path}` : t("comms.commsRecordingStopped"))}
        disabledReason={reason ?? (rec ? rec.actions.stop.disabledReason : t("common.loading"))}
        confirm={{ title: t("comms.stopTheCommsRecording"), body: t("comms.sourceRecordClosesTheFile"), confirmLabel: t("comms.stopRecording"), danger: true }}
      >{t("comms.stopRecording")}</ActionButton>
    </div>
  );
}

const ENCODERS: [string, string][] = perLocale(() => ([
  ["", t("comms.asObsSOwnRecording")],
  ["jim_nvenc", "NVIDIA NVENC H.264 (OBS 30)"],
  ["obs_nvenc_h264_tex", "NVIDIA NVENC H.264 (OBS 31+)"],
  ["h264_texture_amf", "AMD AMF H.264"],
  ["obs_qsv11_v2", t("comms.intelQuicksyncH264")],
  ["obs_x264", t("comms.x264Processor")],
]));

const dbText = (db: number) => (db <= -60 ? "off" : `${db > 0 ? "+" : ""}${db} dB`);

/**
 * The dedicated comms recording (ADR-068): Source Record on a recording-only scene in OBS. Its own
 * Start/Stop, the recording team (by team id), game and comms levels, the folder, status (elapsed,
 * file, free space, faults) and the scene's setup in OBS.
 */
export function RecordingPanel({ view, onChanged }: { view: CommsView; onChanged: Reload }) {
  const rec = view.recorder;
  const control = usePermission("program.control");
  const setup = usePermission("settings.manage");
  const toast = useToast();
  const save = async (patch: Partial<Omit<RecordingSettings, "obs">>, what = "Saved") => {
    try {
      await api.put("/api/v1/comms/recording", patch);
      toast.push("ok", what);
      onChanged();
    } catch (e) {
      toast.push("danger", t("comms.notSaved"), describeError(e));
    }
  };
  const recording = rec.state !== "idle";
  const teams = view.slots.filter((s) => s.team);
  return (
    <Panel title={t("comms.dedicatedCommsRecording")} subtitle={t("comms.gameplayTheHudAndThe")} className="comms-recording" actions={<Badge tone={rec.state === "recording" ? "danger" : rec.state === "fault" ? "warn" : "neutral"}>{MARK[rec.state].tag}</Badge>}>
      <div className="stack-sm">
        <RecordingStateBanner rec={rec} />
        <RecordingButtons rec={rec} onDone={onChanged} size="lg" />
        {rec.errors.map((e) => (
          <Note key={e} tone="danger">
            {e}
          </Note>
        ))}
        {rec.warnings.map((w) => (
          <Note key={w} tone="warn">
            {w}
          </Note>
        ))}
        <div className="row-end">
          <Field label={t("comms.recordingTeam")} hint={t("comms.byTeamNeverBySide")}>
            <select
              aria-label={t("comms.recordingTeam")}
              value={rec.settings.teamId ?? ""}
              disabled={!!control}
              onChange={async (e) => {
                try {
                  await api.post("/api/v1/comms/recording/team", { teamId: e.target.value || null });
                  onChanged();
                } catch (err) {
                  toast.push("danger", t("comms.teamNotChanged"), describeError(err));
                }
              }}
            >
              <option value="">{t("comms.noTeam")}</option>
              {teams.map((s) => (
                <option key={s.team!.id} value={s.team!.id}>
                  {s.team!.name ?? t("comms.teamId", { id: s.id })}
                </option>
              ))}
            </select>
          </Field>
          <LevelField label={t("comms.gameLevel")} setLabel={t("comms.setGameLevel")} value={rec.settings.gameLevelDb} disabledReason={control} hint={t("comms.theRecordingSOwnGame")} onSave={(v) => save({ gameLevelDb: v }, t("comms.gameLevelV", { v: dbText(v) }))} />
          <LevelField label={t("comms.commsLevel")} setLabel={t("comms.setCommsLevel")} value={rec.settings.commsLevelDb} disabledReason={control} hint={t("comms.matchframeSGainOnThe")} onSave={(v) => save({ commsLevelDb: v }, t("comms.commsLevelV", { v: dbText(v) }))} />
        </div>
        <KV
          items={[
            [t("comms.kvFile"), rec.file ? <span key="f">{<Mono>{rec.file.path}</Mono>} · {fmtBytes(rec.file.bytes)} {rec.file.growing ? t("comms.growing") : t("comms.notGrowing")}</span> : recording ? t("comms.waitingForSourceRecordFile") : rec.last ? <span key="l"><T k="comms.lastMonoFmtclock" values={{ mono: <Mono>{rec.last.path ?? "—"}</Mono>, fmtClock: fmtClock(rec.last.durationMs / 1000) }} /></span> : "—"],
            [t("comms.kvFolder"), <span key="d">{<Mono>{rec.folder}</Mono>}{rec.freeBytes !== null ? t("comms.freebytesFree", { freeBytes: fmtBytes(rec.freeBytes) }) : ""}</span>],
            ["TeamSpeak", rec.teamspeakSignal ? t("comms.showsRecordingOnTabs") : t("comms.notShowingRecording")],
            [t("comms.obsTrack1"), rec.obs.track1.inUse === null ? rec.obs.track1.detail : rec.obs.track1.inUse ? t("comms.mixedDetail", { detail: rec.obs.track1.detail }) : t("comms.notMixedDetail", { detail: rec.obs.track1.detail })],
          ]}
        />
        <FolderField rec={rec} disabledReason={setup ?? (recording ? t("comms.stopTheRecordingFirst") : null)} onChanged={onChanged} />
        <Details summary={t("comms.fileSettings")}>
          <FileSettings rec={rec} disabledReason={setup ?? (recording ? t("comms.stopTheRecordingFirst") : null)} onSave={(p) => save(p)} />
        </Details>
        <ObsSetup rec={rec} disabledReason={setup} onChanged={onChanged} />
      </div>
    </Panel>
  );
}

function LevelField({ label, setLabel, value, hint, disabledReason, onSave }: { label: string; setLabel: string; value: number; hint: string; disabledReason: string | null; onSave: (v: number) => void }) {
  const [v, setV] = useState(String(value));
  useEffect(() => setV(String(value)), [value]);
  const n = Number(v);
  const bad = !Number.isFinite(n) || n < -60 || n > 12;
  return (
    <Field label={t("comms.labelDb", { label })} hint={hint}>
      <span className="row">
        <input type="number" min={-60} max={12} step={0.5} value={v} aria-label={label} disabled={!!disabledReason} onChange={(e) => setV(e.target.value)} style={{ width: 90 }} />
        <Button size="sm" aria-label={setLabel} disabledReason={disabledReason ?? (bad ? t("comms.text60To12Db") : n === value ? t("comms.noChange") : null)} onClick={() => onSave(n)}>{t("comms.set")}</Button>
      </span>
    </Field>
  );
}

function FolderField({ rec, disabledReason, onChanged }: { rec: RecorderStatus; disabledReason: string | null; onChanged: Reload }) {
  const [draft, setDraft] = useState(rec.settings.folder ?? "");
  useEffect(() => setDraft(rec.settings.folder ?? ""), [rec.settings.folder]);
  const pick = window.matchframe?.connectionMode !== "remote" ? window.matchframe?.pickDirectory : undefined;
  const save = (folder: string | null) => api.put<RecorderStatus>("/api/v1/comms/recording", { folder });
  return (
    <Field label={t("comms.destinationFolder")} hint={t("comms.whereSourceRecordWritesThe")}>
      <div className="row">
        <input aria-label={t("comms.destinationFolder")} value={draft} spellCheck={false} disabled={!!disabledReason} placeholder={t("comms.videosMatchframeCommsRecordings")} onChange={(e) => setDraft(e.target.value)} />
        {pick ? (
          <ActionButton
            size="sm"
            variant="ghost"
            disabledReason={disabledReason}
            action={async () => {
              const dir = await pick(t("comms.folderForTheCommsRecordings"));
              return dir ? save(dir) : null;
            }}
            success={(r) => (r ? t("comms.folderSaved") : null)}
            onDone={onChanged}
          >{t("comms.chooseFolder")}</ActionButton>
        ) : null}
        <ActionButton size="sm" disabledReason={disabledReason ?? (draft.trim() === (rec.settings.folder ?? "") ? t("comms.noChange") : null)} action={() => save(draft.trim() || null)} success={t("comms.folderSaved")} onDone={onChanged}>{t("comms.save")}</ActionButton>
        {rec.settings.folder ? (
          <ActionButton size="sm" variant="ghost" disabledReason={disabledReason} action={() => save(null)} success={t("comms.backToTheDefaultFolder")} onDone={onChanged}>{t("comms.useDefault")}</ActionButton>
        ) : null}
      </div>
    </Field>
  );
}

function FileSettings({ rec, disabledReason, onSave }: { rec: RecorderStatus; disabledReason: string | null; onSave: (p: Partial<RecordingSettings>) => void }) {
  const s = rec.settings;
  const num = (k: "bitrateKbps" | "splitMinutes" | "warnFreeGB", min: number, max: number) => (e: { target: { value: string } }) => {
    const v = Number(e.target.value);
    if (Number.isFinite(v) && v >= min && v <= max && v !== s[k]) onSave({ [k]: v });
  };
  return (
    <div className="stack-sm">
      <div className="row-end">
        <Field label={t("comms.format")} hint={t("comms.mkvSurvivesACrashObs")}>
          <select aria-label={t("comms.format")} value={s.format} disabled={!!disabledReason} onChange={(e) => onSave({ format: e.target.value as RecordingSettings["format"] })}>
            <option value="mkv">MKV</option>
            <option value="hybrid_mp4">{t("comms.hybridMp4")}</option>
            <option value="fragmented_mp4">{t("comms.fragmentedMp4")}</option>
            <option value="mp4">MP4</option>
            <option value="mov">MOV</option>
          </select>
        </Field>
        <Field label={t("comms.videoEncoder")} hint={t("comms.sourceRecordSOwnEncoder")}>
          <select aria-label={t("comms.videoEncoder")} value={s.encoder} disabled={!!disabledReason} onChange={(e) => onSave({ encoder: e.target.value })}>
            {ENCODERS.map(([id, label]) => (
              <option key={id} value={id}>
                {label}
              </option>
            ))}
            {!ENCODERS.some(([id]) => id === s.encoder) ? <option value={s.encoder}>{s.encoder}</option> : null}
          </select>
        </Field>
      </div>
      <div className="row-end">
        <Field label={t("comms.videoBitrateKbS")}>
          <input type="number" min={1000} max={150000} step={500} defaultValue={s.bitrateKbps} disabled={!!disabledReason} onBlur={num("bitrateKbps", 1000, 150000)} />
        </Field>
        <Field label={t("comms.newFileEveryMin")} hint={t("comms.text0OneFile")}>
          <input type="number" min={0} max={720} defaultValue={s.splitMinutes} disabled={!!disabledReason} onBlur={num("splitMinutes", 0, 720)} />
        </Field>
        <Field label={t("comms.warnUnderGbFree")}>
          <input type="number" min={1} max={10000} defaultValue={s.warnFreeGB} disabled={!!disabledReason} onBlur={num("warnFreeGB", 1, 10000)} />
        </Field>
      </div>
      <p className="muted small">{t("comms.thePictureIsObsS")}</p>
    </div>
  );
}

function StepList({ steps }: { steps: SetupStep[] }) {
  return (
    <ul className="comms-checks" aria-label={t("comms.recordingSceneSetup")}>
      {steps.map((s) => (
        <li key={s.id}>
          <Badge tone={s.ok === true ? "ok" : s.ok === false ? "danger" : "neutral"}>{s.ok === true ? t("comms.done") : s.ok === false ? t("comms.fix") : t("comms.note")}</Badge> <strong>{s.title}</strong> <span className="small">{s.detail}</span>
        </li>
      ))}
    </ul>
  );
}

/** Source Record (installed or how to install it) and the recording scene built by MatchFrame. */
function ObsSetup({ rec, disabledReason, onChanged }: { rec: RecorderStatus; disabledReason: string | null; onChanged: Reload }) {
  const src = useApi<LiveSources>("/api/v1/comms/recording/obs/sources");
  const [pick, setPick] = useState<{ gameSource: string; hudSource: string; gameAudioSource: string } | null>(null);
  const [result, setResult] = useState<SetupStep[] | null>(null);
  const d = src.data;
  useEffect(() => {
    if (!d || pick) return;
    const o = rec.settings.obs;
    setPick({ gameSource: o.gameSource ?? d.suggested.gameSource ?? "", hudSource: o.hudSource ?? d.suggested.hudSource ?? "", gameAudioSource: o.gameAudioSource ?? d.suggested.gameAudioSource ?? "" });
  }, [d, pick, rec.settings.obs]);
  const sr = rec.obs.sourceRecord.available ?? d?.sourceRecord ?? null;
  const select = (k: "gameSource" | "hudSource" | "gameAudioSource", label: string, none: string | null) => (
    <Field label={label}>
      <select aria-label={label} value={pick?.[k] ?? ""} disabled={!!disabledReason || !d} onChange={(e) => setPick((p) => ({ ...(p ?? { gameSource: "", hudSource: "", gameAudioSource: "" }), [k]: e.target.value }))}>
        {none !== null ? <option value="">{none}</option> : <option value="">{t("comms.choose")}</option>}
        {(d?.sources ?? []).map((s) => (
          <option key={s.name} value={s.name}>
            {s.name} {s.kind ? `(${s.kind})` : ""}
          </option>
        ))}
      </select>
    </Field>
  );
  return (
    <section className="stack-sm" aria-label={t("comms.recordingSceneInObs")}>
      <h4 className="comms-subhead">{t("comms.recordingSceneInObs")}</h4>
      {sr === false ? (
        <Note tone="danger" title={t("comms.sourceRecordIsnTInstalled")}>
          <ol className="small comms-steps">
            {rec.obs.sourceRecord.install.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ol>
        </Note>
      ) : sr === true ? (
        <p className="small"><T k="comms.sourceRecordIsInstalledFilter" values={{ mono: <Mono>{rec.obs.sourceRecord.kind}</Mono>, mono2: <Mono>{rec.obs.scene}</Mono>, v: rec.obs.sceneExists ? t("comms.inObs") : t("comms.notMadeYet") }} /></p>
      ) : (
        <p className="small muted">{rec.obs.connected ? t("comms.checkingObsForSourceRecord") : t("comms.connectObsSettingsDevicesTo")}</p>
      )}
      {d?.error ? <Note tone="warn">{d.error}</Note> : null}
      <div className="row-end">
        {select("gameSource", t("comms.gameplayFromTheLiveScene"), null)}
        {select("hudSource", t("comms.hudFromTheLiveScene"), t("comms.noHud"))}
        {select("gameAudioSource", t("comms.gameAudioCopiedForThe"), t("comms.theGameplaySourceSOwn"))}
      </div>
      <div className="row">
        <ActionButton
          disabledReason={disabledReason ?? (!pick?.gameSource ? t("comms.chooseTheGameplaySource") : null)}
          action={() => api.post<{ scene: string; ok: boolean; steps: SetupStep[] }>("/api/v1/comms/recording/obs", { gameSource: pick!.gameSource, hudSource: pick!.hudSource || null, gameAudioSource: pick!.gameAudioSource || null })}
          success={(r) => (r.ok ? t("comms.sceneIsSetUpIn", { scene: r.scene }) : t("comms.sceneSomeStepsNeedFixing", { scene: r.scene }))}
          onDone={(r) => {
            setResult(r.steps);
            onChanged();
          }}
        >{t("comms.setUpTheRecordingScene")}</ActionButton>
        <Button size="sm" variant="ghost" onClick={() => void src.reload()}>{t("comms.refreshSources")}</Button>
      </div>
      {result ? <StepList steps={result} /> : rec.obs.lastSetup ? <StepList steps={rec.obs.lastSetup.steps} /> : null}
      <p className="muted small">{t("comms.theGameplayAndTheHud")}</p>
    </section>
  );
}
