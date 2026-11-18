import { useEffect, useState } from "react";
import type { HudReplayClip } from "@matchframe/hud-sdk";
import { api, describeError } from "../../api/index.ts";
import { ActionButton, Badge, Button, Checkbox, CopyButton, Details, Field, Meter, Mono, Note, Panel } from "../../components/ui.tsx";
import { useToast } from "../../components/toasts.tsx";
import { fmtBytes, fmtMs } from "../../lib/format.ts";
import { useApi } from "../../lib/hooks.ts";
import { drawReelGraphics } from "../../lib/match-art/reel.ts";
import { usePermission } from "../../state/session.tsx";
import { t } from "../../i18n/index.ts";
import { T } from "../../i18n/T.tsx";

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
  clips: { id: string; label: string; roundNumber: number | null; played: boolean; score: number; reasons: string[]; startMs: number; durationMs: number; graphic: HudReplayClip; angle?: "victim" | "free" | null; slow?: unknown; outMs?: number }[];
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
  const [slow, setSlow] = useState(false);
  const [plan, setPlan] = useState<ReelPlan | null>(null);
  const [planError, setPlanError] = useState<string | null>(null);
  const [drawing, setDrawing] = useState<string | null>(null);
  const [keepGb, setKeepGb] = useState<number | null>(null);
  const data = ov.data;
  const choice = { map: map || null, count, unplayed: count !== "all" && unplayed, fadeMs: Math.round(fade * 1000), slowMotion: slow };
  const key = JSON.stringify(choice);
  const maps = data?.maps ?? [];
  const mapKeys = maps.map((m) => `${m.key}:${m.played}:${m.unplayed}`).join(",");
  useEffect(() => {
    if (!maps.length) return setPlan(null);
    let gone = false;
    const tRow = setTimeout(() => {
      api
        .post<ReelPlan>("/api/v1/highlights/plan", choice)
        .then((p) => !gone && (setPlan(p), setPlanError(null)))
        .catch((e) => !gone && (setPlan(null), setPlanError(describeError(e))));
    }, 150);
    return () => {
      gone = true;
      clearTimeout(tRow);
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
    if (!p.clips.length) throw new Error(t("prod.noClipsToPutIn2"));
    let graphics: Record<string, string> | undefined;
    if (burn) {
      setDrawing(t("prod.drawingTheLowerThirds0", { count: p.clips.length }));
      try {
        graphics = await drawReelGraphics(p.clips, (n) => setDrawing(t("prod.drawingTheLowerThirdsN", { n, count: p.clips.length })));
      } finally {
        setDrawing(null);
      }
    }
    const started = await api.post<ReelJob>("/api/v1/highlights/reels", { ...choice, clipIds: p.clips.map((c) => c.id), ...(graphics ? { graphics } : {}) });
    void ov.reload();
    return started;
  };

  return (
    <Panel title={t("prod.highlightReel")} subtitle={t("prod.aMapSBestClips")} actions={running ? <Badge tone="accent">{t("prod.making")}</Badge> : null}>
      <div className="stack-sm">
        {maps.length === 0 ? <p className="muted small">{t("prod.noClipsYetClipsThat")}</p> : null}
        <div className="form-grid">
          <Field label={t("prod.map")}>
            <select value={map} onChange={(e) => setMap(e.target.value)} disabled={!maps.length}>
              {maps.map((m) => (
                <option key={m.key} value={m.current ? "" : m.key}>
                  {t("prod.vDisplaynameV2PlayedPlayed", { v: m.current ? t("prod.thisMap") : t("prod.previousMap"), displayName: m.displayName, v2: m.title ? ` (${m.title})` : "", played: m.played })}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t("prod.clips")} hint={t("prod.bestByTheSameScore2")}>
            <select value={String(count)} onChange={(e) => setCount(e.target.value === "all" ? "all" : (Number(e.target.value) as Count))}>
              {COUNTS.map((c) => (
                <option key={c} value={String(c)}>
                  {c === "all" ? t("prod.allPlayedClips") : t("prod.theBestC", { c })}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t("prod.crossfadeS")}>
            <input type="number" min={0} max={2} step={0.1} value={fade} onChange={(e) => setFade(Math.max(0, Math.min(2, Number(e.target.value) || 0)))} />
          </Field>
        </div>
        {count !== "all" ? <Checkbox checked={unplayed} onChange={setUnplayed} label={t("prod.alsoClipsThatWerenT")} hint={t("prod.theBestOfTheMap")} /> : null}
        <Checkbox checked={burn} onChange={setBurn} label={t("prod.burnInTheReplayGraphic")} hint={t("prod.eachClipGetsItsLower")} />
        <Checkbox checked={slow} onChange={setSlow} label={t("prod.slowMotionAtTheKills")} hint={t("prod.eachClipSlowedAsAutomatic")} />
        {planError ? <Note tone="warn">{planError}</Note> : null}
        {plan && plan.clips.length ? (
          <Details summary={`${t("prod.clipCount", { count: plan.clips.length })}, ${len(plan.totalMs)}${plan.fadeMs ? t("prod.withVSCrossfades", { v: plan.fadeMs / 1000 }) : ""}`}>
            <ol className="small" style={{ margin: 0, paddingLeft: 20 }}>
              {plan.clips.map((c) => (
                <li key={c.id}>
                  R{c.roundNumber ?? "?"} · {c.label} · {fmtMs(c.outMs ?? c.durationMs)}
                  {c.slow ? t("prod.slowMotion") : ""}
                  {c.played || c.angle ? "" : t("prod.notPlayed")}
                  {c.reasons.length ? <span className="muted"> ({c.reasons.join(", ")})</span> : null}
                </li>
              ))}
            </ol>
          </Details>
        ) : plan ? (
          <p className="muted small">{count === "all" ? t("prod.noClipOfThisMap") : t("prod.noClipsOfThisMap")}</p>
        ) : null}
        {ffmpegMissing ? (
          <Note tone="warn" title={t("prod.ffmpegIsNeeded")}>
            {data?.ffmpeg.canDownload ? t("prod.matchframeCanDownloadItAbout") : t("prod.installItWithThisSystem")}
            {data?.ffmpeg.canDownload ? (
              <div className="row" style={{ marginTop: 8 }}>
                <ActionButton action={() => api.post("/api/v1/highlights/ffmpeg")} success={t("prod.ffmpegDownloaded")} onDone={() => void ov.reload()} disabledReason={settingsReason ?? (data.ffmpeg.downloading !== null ? t("prod.downloadingRound", { round: Math.round(data.ffmpeg.downloading * 100) }) : null)}>{t("prod.downloadFfmpeg")}</ActionButton>
              </div>
            ) : null}
          </Note>
        ) : null}
        <div className="row">
          <ActionButton
            variant="primary"
            action={exportReel}
            success={(j) => t("prod.makingTheReel", { count: j.clips })}
            disabledReason={reason ?? (running ? t("prod.aReelIsBeingMade") : drawing ? drawing : ffmpegMissing ? t("prod.ffmpegIsnTInstalled") : !plan?.clips.length ? t("prod.noClipsToPutIn") : null)}
          >{t("prod.exportHighlightReel")}</ActionButton>
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
                  <Button size="sm" onClick={() => void api.post(`/api/v1/highlights/reels/${encodeURIComponent(job.id)}/cancel`).then(() => ov.reload(), (e) => toast.push("danger", t("prod.notStopped"), describeError(e)))}>{t("common.cancel")}</Button>
                </div>
                <Meter value={job.progress} label={t("prod.highlightReelProgress")} />
              </>
            ) : job.state === "done" && job.file ? (
              <>
                <p className="small"><T k="prod.badgeTitleClips" values={{ badge: <Badge tone="ok">{t("prod.done")}</Badge>, title: job.title, clips: t("prod.clipCount", { count: job.clips }), durationMs: len(job.durationMs), v: job.bytes ? `, ${fmtBytes(job.bytes)}` : "" }} /></p>
                <div className="row">
                  <Mono>{job.file}</Mono>
                  <CopyButton text={job.file} label={t("prod.copyPath")} />
                  {open ? (
                    <Button size="sm" onClick={() => void open(data?.folder)}>{t("prod.openFolder")}</Button>
                  ) : null}
                </div>
              </>
            ) : job.state === "failed" ? (
              <Note tone="danger" title={t("prod.theReelWasnTMade")}>
                {job.error}
              </Note>
            ) : (
              <p className="muted small">{t("prod.theLastReelWasStopped")}</p>
            )}
          </div>
        ) : null}
        <Details summary={t("prod.whereReelsGoAndThe")}>
          <p className="small"><T k="prod.reelsMono" values={{ mono: <Mono>{data?.folder ?? "…"}</Mono> }} /></p>
          <p className="small muted">{t("prod.theReplayQueueDeletesOld", { fmtBytes: fmtBytes(data?.keptBytes ?? 0) })}</p>
          <div className="row-end">
            <Field label={t("prod.keepUpToGb")}>
              <input type="number" min={0.5} max={500} step={0.5} value={keepGb ?? 3} onChange={(e) => setKeepGb(Number(e.target.value))} style={{ width: 100 }} />
            </Field>
            <ActionButton action={() => api.put<HighlightsOverview>("/api/v1/highlights/settings", { keepGb: keepGb ?? 3 })} success={t("prod.saved")} onDone={() => void ov.reload()} disabledReason={settingsReason ?? (!keepGb || keepGb < 0.5 ? t("prod.atLeast05Gb") : null)}>{t("prod.save")}</ActionButton>
          </div>
        </Details>
      </div>
    </Panel>
  );
}
