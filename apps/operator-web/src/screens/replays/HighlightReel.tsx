import { useEffect, useState } from "react";
import type { HudReplayClip } from "@matchframe/hud-sdk";
import { api, describeError } from "../../api/index.ts";
import { ActionButton, Badge, Button, Checkbox, CopyButton, Details, Field, Meter, Mono, Note, Panel } from "../../components/ui.tsx";
import { useToast } from "../../components/toasts.tsx";
import { fmtBytes, fmtMs } from "../../lib/format.ts";
import { useApi } from "../../lib/hooks.ts";
import { drawReelGraphics } from "../../lib/match-art/reel.ts";
import { usePermission } from "../../state/session.tsx";

/** GET /api/v1/highlights (services/local-engine/src/routes/highlights.ts). */
export interface HighlightsOverview {
  maps: { key: string; mapName: string; displayName: string; title: string | null; startedAt: string; current: boolean; played: number; unplayed: number; bytes: number }[];
  settings: { keepGb: number };
  keptBytes: number;
  folder: string;
  ffmpeg: { source: "downloaded" | "path" | "missing"; path: string | null; version: string | null; downloading: number | null; error: string | null; canDownload: boolean };
  jobs: ReelJob[];
}

export interface ReelJob {
  id: string;
  mapKey: string;
  title: string;
  state: "running" | "done" | "failed" | "cancelled";
  step: string;
  progress: number;
  clips: number;
  durationMs: number;
  file: string | null;
  folder: string;
  bytes: number | null;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export interface ReelPlan {
  mapKey: string;
  mapName: string;
  displayName: string;
  title: string | null;
  clips: { id: string; label: string; roundNumber: number | null; played: boolean; score: number; reasons: string[]; startMs: number; durationMs: number; graphic: HudReplayClip }[];
  fadeMs: number;
  totalMs: number;
}

const COUNTS = ["all", 5, 8, 10, 15, 20] as const;
type Count = (typeof COUNTS)[number];

/** m:ss for a reel's length. */
const len = (ms: number) => `${Math.floor(ms / 60000)}:${String(Math.round((ms % 60000) / 1000)).padStart(2, "0")}`;

/** The program can open the reels' folder on this computer (not in a browser, nor when connected to another computer). */
const opener = () => (window.matchframe?.connectionMode !== "remote" ? (window.matchframe?.openHighlights ?? null) : null);

/**
 * A map's best clips as one MP4 for social media: every played clip, or the best N by the replay
 * ranking's score, in round order, with crossfades and, if wanted, each clip's lower third burned
 * in. Made by ffmpeg on the engine's computer, in the background.
 */
export function HighlightReelPanel() {
  const ov = useApi<HighlightsOverview>("/api/v1/highlights", { refreshMs: 1500 });
  const reason = usePermission("replay.control");
  const settingsReason = usePermission("settings.manage");
  const toast = useToast();
  const [map, setMap] = useState<string>("");
  const [count, setCount] = useState<Count>("all");
  const [unplayed, setUnplayed] = useState(false);
  const [fade, setFade] = useState(0.5);
  const [burn, setBurn] = useState(true);
  const [plan, setPlan] = useState<ReelPlan | null>(null);
  const [planError, setPlanError] = useState<string | null>(null);
  const [drawing, setDrawing] = useState<string | null>(null);
  const [keepGb, setKeepGb] = useState<number | null>(null);
  const data = ov.data;
  const choice = { map: map || null, count, unplayed: count !== "all" && unplayed, fadeMs: Math.round(fade * 1000) };
  const key = JSON.stringify(choice);
  const maps = data?.maps ?? [];
  const mapKeys = maps.map((m) => `${m.key}:${m.played}:${m.unplayed}`).join(",");
  useEffect(() => {
    if (!maps.length) return setPlan(null);
    let gone = false;
    const t = setTimeout(() => {
      api
        .post<ReelPlan>("/api/v1/highlights/plan", choice)
        .then((p) => !gone && (setPlan(p), setPlanError(null)))
        .catch((e) => !gone && (setPlan(null), setPlanError(describeError(e))));
    }, 150);
    return () => {
      gone = true;
      clearTimeout(t);
    };
    // The plan follows the choices and the clips kept.
  }, [key, mapKeys]);
  useEffect(() => {
    if (data && keepGb === null) setKeepGb(data.settings.keepGb);
  }, [data, keepGb]);

  const job = data?.jobs[0] ?? null;
  const running = job?.state === "running";
  const ffmpegMissing = data?.ffmpeg.source === "missing";
  const open = opener();

  const exportReel = async (): Promise<ReelJob> => {
    // The plan as it is now (clips may have come in since it was shown).
    const p = await api.post<ReelPlan>("/api/v1/highlights/plan", choice);
    if (!p.clips.length) throw new Error("No clips to put in the reel yet.");
    let graphics: Record<string, string> | undefined;
    if (burn) {
      setDrawing(`Drawing the lower thirds (0 of ${p.clips.length})`);
      try {
        graphics = await drawReelGraphics(p.clips, (n) => setDrawing(`Drawing the lower thirds (${n} of ${p.clips.length})`));
      } finally {
        setDrawing(null);
      }
    }
    const started = await api.post<ReelJob>("/api/v1/highlights/reels", { ...choice, clipIds: p.clips.map((c) => c.id), ...(graphics ? { graphics } : {}) });
    void ov.reload();
    return started;
  };

  return (
    <Panel title="Highlight reel" subtitle="A map's best clips as one MP4, ready for social media." actions={running ? <Badge tone="accent">Making</Badge> : null}>
      <div className="stack-sm">
        {maps.length === 0 ? <p className="muted small">No clips yet. Clips that come into the replay queue are kept here for the current and the previous map.</p> : null}
        <div className="form-grid">
          <Field label="Map">
            <select value={map} onChange={(e) => setMap(e.target.value)} disabled={!maps.length}>
              {maps.map((m) => (
                <option key={m.key} value={m.current ? "" : m.key}>
                  {`${m.current ? "This map" : "Previous map"}: ${m.displayName}${m.title ? ` (${m.title})` : ""} · ${m.played} played`}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Clips" hint="Best: by the same score as the automatic replays.">
            <select value={String(count)} onChange={(e) => setCount(e.target.value === "all" ? "all" : (Number(e.target.value) as Count))}>
              {COUNTS.map((c) => (
                <option key={c} value={String(c)}>
                  {c === "all" ? "All played clips" : `The best ${c}`}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Crossfade (s)">
            <input type="number" min={0} max={2} step={0.1} value={fade} onChange={(e) => setFade(Math.max(0, Math.min(2, Number(e.target.value) || 0)))} />
          </Field>
        </div>
        {count !== "all" ? <Checkbox checked={unplayed} onChange={setUnplayed} label="Also clips that weren't played" hint="The best of the map's other clips (the replay PC films more than a break has time for)." /> : null}
        <Checkbox checked={burn} onChange={setBurn} label="Burn in the replay graphic" hint="Each clip gets its lower third (player, weapon, victims, 2K–ACE, clutch, round), fading in and out." />
        {planError ? <Note tone="warn">{planError}</Note> : null}
        {plan && plan.clips.length ? (
          <Details summary={`${plan.clips.length} clip${plan.clips.length === 1 ? "" : "s"}, ${len(plan.totalMs)}${plan.fadeMs ? ` with ${plan.fadeMs / 1000} s crossfades` : ""}`}>
            <ol className="small" style={{ margin: 0, paddingLeft: 20 }}>
              {plan.clips.map((c) => (
                <li key={c.id}>
                  R{c.roundNumber ?? "?"} · {c.label} · {fmtMs(c.durationMs)}
                  {c.played ? "" : " · not played"}
                  {c.reasons.length ? <span className="muted"> ({c.reasons.join(", ")})</span> : null}
                </li>
              ))}
            </ol>
          </Details>
        ) : plan ? (
          <p className="muted small">{count === "all" ? "No clip of this map has been played yet." : "No clips of this map yet."}</p>
        ) : null}
        {ffmpegMissing ? (
          <Note tone="warn" title="ffmpeg is needed">
            {data?.ffmpeg.canDownload ? "Matchframe can download it (about 90 MB)." : "Install it with this system's package manager (for example apt install ffmpeg)."}
            {data?.ffmpeg.canDownload ? (
              <div className="row" style={{ marginTop: 8 }}>
                <ActionButton action={() => api.post("/api/v1/highlights/ffmpeg")} success="ffmpeg downloaded" onDone={() => void ov.reload()} disabledReason={settingsReason ?? (data.ffmpeg.downloading !== null ? `Downloading (${Math.round(data.ffmpeg.downloading * 100)} %)` : null)}>
                  Download ffmpeg
                </ActionButton>
              </div>
            ) : null}
          </Note>
        ) : null}
        <div className="row">
          <ActionButton
            variant="primary"
            action={exportReel}
            success={(j) => `Making the reel: ${j.clips} clips`}
            disabledReason={reason ?? (running ? "A reel is being made" : drawing ? drawing : ffmpegMissing ? "ffmpeg isn't installed" : !plan?.clips.length ? "No clips to put in the reel" : null)}
          >
            Export highlight reel
          </ActionButton>
          {drawing ? <span className="muted small">{drawing}</span> : null}
        </div>
        {job ? (
          <div className="stack-sm">
            {running ? (
              <>
                <div className="row">
                  <span className="small">
                    {job.title}: {job.step} ({Math.round(job.progress * 100)} %)
                  </span>
                  <Button size="sm" onClick={() => void api.post(`/api/v1/highlights/reels/${encodeURIComponent(job.id)}/cancel`).then(() => ov.reload(), (e) => toast.push("danger", "Not stopped", describeError(e)))}>
                    Cancel
                  </Button>
                </div>
                <Meter value={job.progress} label="Highlight reel progress" />
              </>
            ) : job.state === "done" && job.file ? (
              <>
                <p className="small">
                  <Badge tone="ok">Done</Badge> {job.title}: {job.clips} clips, {len(job.durationMs)}
                  {job.bytes ? `, ${fmtBytes(job.bytes)}` : ""}
                </p>
                <div className="row">
                  <Mono>{job.file}</Mono>
                  <CopyButton text={job.file} label="Copy path" />
                  {open ? (
                    <Button size="sm" onClick={() => void open()}>
                      Open folder
                    </Button>
                  ) : null}
                </div>
              </>
            ) : job.state === "failed" ? (
              <Note tone="danger" title="The reel wasn't made">
                {job.error}
              </Note>
            ) : (
              <p className="muted small">The last reel was stopped.</p>
            )}
          </div>
        ) : null}
        <Details summary="Where reels go, and the clips kept">
          <p className="small">
            Reels: <Mono>{data?.folder ?? "…"}</Mono>
          </p>
          <p className="small muted">The replay queue deletes old clips; the current and previous map's clips are kept for reels: {fmtBytes(data?.keptBytes ?? 0)} now. Over the limit, clips that weren't played go first, then the oldest.</p>
          <div className="row-end">
            <Field label="Keep up to (GB)">
              <input type="number" min={0.5} max={500} step={0.5} value={keepGb ?? 3} onChange={(e) => setKeepGb(Number(e.target.value))} style={{ width: 100 }} />
            </Field>
            <ActionButton action={() => api.put<HighlightsOverview>("/api/v1/highlights/settings", { keepGb: keepGb ?? 3 })} success="Saved" onDone={() => void ov.reload()} disabledReason={settingsReason ?? (!keepGb || keepGb < 0.5 ? "At least 0.5 GB" : null)}>
              Save
            </ActionButton>
          </div>
        </Details>
      </div>
    </Panel>
  );
}
