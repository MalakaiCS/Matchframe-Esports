import { useEffect, useState } from "react";
import { api, describeError } from "../../api/index.ts";
import { useToast } from "../../components/toasts.tsx";
import { ActionButton, Badge, Button, Details, Field, KV, Mono, Note, Panel } from "../../components/ui.tsx";
import { fmtBytes, fmtClock } from "../../lib/format.ts";
import { useApi } from "../../lib/hooks.ts";
import { usePermission } from "../../state/session.tsx";
import type { CommsView, LiveSources, RecorderStatus, RecordingSettings, SetupStep } from "./types.ts";

type Reload = () => void;

/** The recording's state's shape and word, so it never depends on colour alone. */
const MARK: Record<RecorderStatus["state"], { icon: string; tag: string }> = {
  idle: { icon: "○", tag: "Not recording" },
  recording: { icon: "●", tag: "Recording" },
  fault: { icon: "⚠", tag: "Fault" },
};

/** NOT RECORDING, RECORDING — TEAM or RECORDING FAULT, with its elapsed time, in words. */
export function RecordingStateBanner({ rec, compact = false }: { rec: RecorderStatus | null; compact?: boolean }) {
  const state = rec?.state ?? "idle";
  const m = MARK[state];
  return (
    <div className={`comms-state comms-rec-${state} ${compact ? "is-compact" : ""}`} role="status" aria-live="polite" aria-label={`Comms recording: ${rec?.label ?? "loading"}`}>
      <span className="comms-state-icon" aria-hidden>
        {m.icon}
      </span>
      <div className="comms-state-text">
        <div className="comms-state-kicker">
          Comms recording · <span className="comms-state-tag">{m.tag}</span>
          {rec?.elapsedMs != null ? <span className="comms-rec-elapsed"> · {fmtClock(rec.elapsedMs / 1000)}</span> : null}
        </div>
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
      <ActionButton size={size} variant="primary" action={() => api.post<RecorderStatus>("/api/v1/comms/recording/start")} onDone={onDone} success="Comms recording started" disabledReason={reason ?? (rec ? rec.actions.start.disabledReason : "Loading…")}>
        Start Recording
      </ActionButton>
      <ActionButton
        size={size}
        variant="danger"
        action={() => api.post<RecorderStatus>("/api/v1/comms/recording/stop")}
        onDone={onDone}
        success={(r) => (r.last?.path ? `Saved: ${r.last.path}` : "Comms recording stopped")}
        disabledReason={reason ?? (rec ? rec.actions.stop.disabledReason : "Loading…")}
        confirm={{ title: "Stop the comms recording?", body: "Source Record closes the file. The public listen-in isn't affected.", confirmLabel: "Stop Recording", danger: true }}
      >
        Stop Recording
      </ActionButton>
    </div>
  );
}

const ENCODERS: [string, string][] = [
  ["", "As OBS's own recording (default)"],
  ["jim_nvenc", "NVIDIA NVENC H.264 (OBS 30)"],
  ["obs_nvenc_h264_tex", "NVIDIA NVENC H.264 (OBS 31+)"],
  ["h264_texture_amf", "AMD AMF H.264"],
  ["obs_qsv11_v2", "Intel QuickSync H.264"],
  ["obs_x264", "x264 (processor)"],
];

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
      toast.push("danger", "Not saved", describeError(e));
    }
  };
  const recording = rec.state !== "idle";
  const teams = view.slots.filter((s) => s.team);
  return (
    <Panel title="Dedicated comms recording" subtitle="Gameplay, the HUD and the speaker strip with one team's comms, recorded by OBS's Source Record from its own scene: the program can cut anywhere." className="comms-recording" actions={<Badge tone={rec.state === "recording" ? "danger" : rec.state === "fault" ? "warn" : "neutral"}>{MARK[rec.state].tag}</Badge>}>
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
          <Field label="Recording team" hint="By team, never by side: its comms and its speaker strip change together.">
            <select
              aria-label="Recording team"
              value={rec.settings.teamId ?? ""}
              disabled={!!control}
              onChange={async (e) => {
                try {
                  await api.post("/api/v1/comms/recording/team", { teamId: e.target.value || null });
                  onChanged();
                } catch (err) {
                  toast.push("danger", "Team not changed", describeError(err));
                }
              }}
            >
              <option value="">No team</option>
              {teams.map((s) => (
                <option key={s.team!.id} value={s.team!.id}>
                  {s.team!.name ?? `Team ${s.id}`}
                </option>
              ))}
            </select>
          </Field>
          <LevelField label="Game level" value={rec.settings.gameLevelDb} disabledReason={control} hint="The recording's own game audio fader in OBS (not the program's)." onSave={(v) => save({ gameLevelDb: v }, `Game level ${dbText(v)}`)} />
          <LevelField label="Comms level" value={rec.settings.commsLevelDb} disabledReason={control} hint="Matchframe's gain on the recording comms; −60 is off." onSave={(v) => save({ commsLevelDb: v }, `Comms level ${dbText(v)}`)} />
        </div>
        <KV
          items={[
            ["File", rec.file ? <span key="f">{<Mono>{rec.file.path}</Mono>} · {fmtBytes(rec.file.bytes)} {rec.file.growing ? "· growing" : "· NOT GROWING"}</span> : recording ? "Waiting for Source Record's file…" : rec.last ? <span key="l">Last: <Mono>{rec.last.path ?? "—"}</Mono> ({fmtClock(rec.last.durationMs / 1000)})</span> : "—"],
            ["Folder", <span key="d">{<Mono>{rec.folder}</Mono>}{rec.freeBytes !== null ? ` · ${fmtBytes(rec.freeBytes)} free` : ""}</span>],
            ["TeamSpeak", rec.teamspeakSignal ? "Shows recording on both listener tabs" : "Not showing recording"],
            ["OBS track 1", rec.obs.track1.inUse === null ? rec.obs.track1.detail : rec.obs.track1.inUse ? `Mixed: ${rec.obs.track1.detail}` : `NOT MIXED: ${rec.obs.track1.detail}`],
          ]}
        />
        <FolderField rec={rec} disabledReason={setup ?? (recording ? "Stop the recording first" : null)} onChanged={onChanged} />
        <Details summary="File settings">
          <FileSettings rec={rec} disabledReason={setup ?? (recording ? "Stop the recording first" : null)} onSave={(p) => save(p)} />
        </Details>
        <ObsSetup rec={rec} disabledReason={setup} onChanged={onChanged} />
      </div>
    </Panel>
  );
}

function LevelField({ label, value, hint, disabledReason, onSave }: { label: string; value: number; hint: string; disabledReason: string | null; onSave: (v: number) => void }) {
  const [v, setV] = useState(String(value));
  useEffect(() => setV(String(value)), [value]);
  const n = Number(v);
  const bad = !Number.isFinite(n) || n < -60 || n > 12;
  return (
    <Field label={`${label} (dB)`} hint={hint}>
      <span className="row">
        <input type="number" min={-60} max={12} step={0.5} value={v} aria-label={label} disabled={!!disabledReason} onChange={(e) => setV(e.target.value)} style={{ width: 90 }} />
        <Button size="sm" aria-label={`Set ${label.toLowerCase()}`} disabledReason={disabledReason ?? (bad ? "−60 to +12 dB" : n === value ? "No change" : null)} onClick={() => onSave(n)}>
          Set
        </Button>
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
    <Field label="Destination folder" hint="Where Source Record writes the files (OBS runs on this computer). A drive with room: about 7 GB an hour at 16 Mb/s.">
      <div className="row">
        <input aria-label="Destination folder" value={draft} spellCheck={false} disabled={!!disabledReason} placeholder="Videos → Matchframe Comms Recordings" onChange={(e) => setDraft(e.target.value)} />
        {pick ? (
          <ActionButton
            size="sm"
            variant="ghost"
            disabledReason={disabledReason}
            action={async () => {
              const dir = await pick("Folder for the comms recordings");
              return dir ? save(dir) : null;
            }}
            success={(r) => (r ? "Folder saved" : null)}
            onDone={onChanged}
          >
            Choose folder…
          </ActionButton>
        ) : null}
        <ActionButton size="sm" disabledReason={disabledReason ?? (draft.trim() === (rec.settings.folder ?? "") ? "No change" : null)} action={() => save(draft.trim() || null)} success="Folder saved" onDone={onChanged}>
          Save
        </ActionButton>
        {rec.settings.folder ? (
          <ActionButton size="sm" variant="ghost" disabledReason={disabledReason} action={() => save(null)} success="Back to the default folder" onDone={onChanged}>
            Use default
          </ActionButton>
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
        <Field label="Format" hint="MKV survives a crash (OBS: File → Remux Recordings makes an MP4). Hybrid MP4 needs OBS 30.2+.">
          <select aria-label="Format" value={s.format} disabled={!!disabledReason} onChange={(e) => onSave({ format: e.target.value as RecordingSettings["format"] })}>
            <option value="mkv">MKV</option>
            <option value="hybrid_mp4">Hybrid MP4</option>
            <option value="fragmented_mp4">Fragmented MP4</option>
            <option value="mp4">MP4</option>
            <option value="mov">MOV</option>
          </select>
        </Field>
        <Field label="Video encoder" hint="Source Record's own encoder: the graphics card's next to the stream's (NVENC on an NVIDIA card).">
          <select aria-label="Video encoder" value={s.encoder} disabled={!!disabledReason} onChange={(e) => onSave({ encoder: e.target.value })}>
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
        <Field label="Video bitrate (kb/s)">
          <input type="number" min={1000} max={150000} step={500} defaultValue={s.bitrateKbps} disabled={!!disabledReason} onBlur={num("bitrateKbps", 1000, 150000)} />
        </Field>
        <Field label="New file every (min)" hint="0: one file.">
          <input type="number" min={0} max={720} defaultValue={s.splitMinutes} disabled={!!disabledReason} onBlur={num("splitMinutes", 0, 720)} />
        </Field>
        <Field label="Warn under (GB free)">
          <input type="number" min={1} max={10000} defaultValue={s.warnFreeGB} disabled={!!disabledReason} onBlur={num("warnFreeGB", 1, 10000)} />
        </Field>
      </div>
      <p className="muted small">The picture is OBS's canvas (set 1920×1080 at 60 fps in OBS → Settings → Video). The sound is one stereo track: the scene's own, game plus the recording comms (casters aren't in the scene).</p>
    </div>
  );
}

function StepList({ steps }: { steps: SetupStep[] }) {
  return (
    <ul className="comms-checks" aria-label="Recording scene setup">
      {steps.map((s) => (
        <li key={s.id}>
          <Badge tone={s.ok === true ? "ok" : s.ok === false ? "danger" : "neutral"}>{s.ok === true ? "Done" : s.ok === false ? "Fix" : "Note"}</Badge> <strong>{s.title}</strong> <span className="small">{s.detail}</span>
        </li>
      ))}
    </ul>
  );
}

/** Source Record (installed or how to install it) and the recording scene built by Matchframe. */
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
        {none !== null ? <option value="">{none}</option> : <option value="">Choose…</option>}
        {(d?.sources ?? []).map((s) => (
          <option key={s.name} value={s.name}>
            {s.name} {s.kind ? `(${s.kind})` : ""}
          </option>
        ))}
      </select>
    </Field>
  );
  return (
    <section className="stack-sm" aria-label="Recording scene in OBS">
      <h4 className="comms-subhead">Recording scene in OBS</h4>
      {sr === false ? (
        <Note tone="danger" title="Source Record isn't installed in OBS">
          <ol className="small comms-steps">
            {rec.obs.sourceRecord.install.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ol>
        </Note>
      ) : sr === true ? (
        <p className="small">
          Source Record is installed (filter <Mono>{rec.obs.sourceRecord.kind}</Mono>). Scene <Mono>{rec.obs.scene}</Mono>: {rec.obs.sceneExists ? "in OBS" : "not made yet"}.
        </p>
      ) : (
        <p className="small muted">{rec.obs.connected ? "Checking OBS for Source Record…" : "Connect OBS (Settings → Devices) to check for Source Record."}</p>
      )}
      {d?.error ? <Note tone="warn">{d.error}</Note> : null}
      <div className="row-end">
        {select("gameSource", "Gameplay (from the live scene)", null)}
        {select("hudSource", "HUD (from the live scene)", "No HUD")}
        {select("gameAudioSource", "Game audio (copied for the recording)", "The gameplay source's own sound")}
      </div>
      <div className="row">
        <ActionButton
          disabledReason={disabledReason ?? (!pick?.gameSource ? "Choose the gameplay source" : null)}
          action={() => api.post<{ scene: string; ok: boolean; steps: SetupStep[] }>("/api/v1/comms/recording/obs", { gameSource: pick!.gameSource, hudSource: pick!.hudSource || null, gameAudioSource: pick!.gameAudioSource || null })}
          success={(r) => (r.ok ? `“${r.scene}” is set up in OBS` : `“${r.scene}”: some steps need fixing`)}
          onDone={(r) => {
            setResult(r.steps);
            onChanged();
          }}
        >
          Set up the recording scene in OBS
        </ActionButton>
        <Button size="sm" variant="ghost" onClick={() => void src.reload()}>
          Refresh sources
        </Button>
      </div>
      {result ? <StepList steps={result} /> : rec.obs.lastSetup ? <StepList steps={rec.obs.lastSetup.steps} /> : null}
      <p className="muted small">The gameplay and the HUD are the live scene's own sources, shared (they stay active whatever the program shows). The scene is only ever recorded: never put it on program, and never add the speaker strip or “MatchFrame Comms Recording” to a program scene.</p>
    </section>
  );
}
