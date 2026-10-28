import { useEffect, useRef, useState } from "react";
import { api, seg } from "../../api/index.ts";
import type { MatchArtObsResult, MatchArtResponse } from "../../api/types.ts";
import { AssetUpload } from "../../components/AssetUpload.tsx";
import { ActionButton, Async, Checkbox, CopyButton, Details, Meter, Note, Panel } from "../../components/ui.tsx";
import { fmtBytes } from "../../lib/format.ts";
import { useApi } from "../../lib/hooks.ts";
import type { ArtKind } from "../../lib/match-art/make.ts";
import { ART_ORDER, makeMatchArt, useArtJob } from "../../lib/match-art/make.ts";
import { usePermission } from "../../state/session.tsx";

const SAVE_AS: Record<ArtKind, string> = {
  "thumb-highlights": "highlights",
  "thumb-replay": "full-replay",
  "thumb-live": "live",
  "up-next": "up-next",
  stinger: "stinger",
  "stinger-replay": "replay-stinger",
};

function fileName(teams: string, kind: ArtKind, url: string): string {
  const ext = url.split("?")[0]!.split(".").pop();
  return `${teams.replace(/[^\w-]+/g, "-").replace(/-+/g, "-")}-${SAVE_AS[kind]}.${ext}`;
}

/** The match's thumbnails, "Up next" screen and stingers: made when the match is created, made again here. */
export function MatchArtPanel({ matchId, teams }: { matchId: string; teams: string }) {
  const art = useApi<MatchArtResponse>(`/api/v1/matches/${seg(matchId)}/art`);
  const job = useArtJob(matchId);
  const writeReason = usePermission("metadata.write");
  const programReason = usePermission("program.control");
  const [useStinger, setUseStinger] = useState(true);
  const [obsResult, setObsResult] = useState<MatchArtObsResult | null>(null);
  const started = useRef(false);
  const working = job?.state === "working";
  // A match made somewhere else (an import, the API) has none yet: make them once when it is opened.
  useEffect(() => {
    if (started.current || writeReason || !art.data || art.data.items.length > 0 || job) return;
    started.current = true;
    void makeMatchArt(matchId);
  }, [art.data, job, matchId, writeReason]);
  // Each finished picture shows as it is stored, and the list is fresh when the run ends.
  const madeCount = job?.made.length ?? 0;
  useEffect(() => {
    if (madeCount > 0 || job?.state !== "working") void art.reload();
  }, [madeCount, job?.state]);
  return (
    <Panel
      title="Thumbnails & stingers"
      subtitle="Made for every new match from both teams' logos and colours (a ? when a team has no logo)."
      actions={
        <ActionButton size="sm" variant="primary" action={() => makeMatchArt(matchId)} disabledReason={writeReason ?? (working ? "Making them now" : null)}>
          Make again
        </ActionButton>
      }
    >
      {job && job.state === "working" ? (
        <div className="stack" style={{ marginBottom: 12 }}>
          <span className="small">Making {job.step.toLowerCase()}… {Math.round(job.progress * 100)} %</span>
          <Meter value={job.progress} label="Making the match graphics" />
        </div>
      ) : job?.state === "failed" && job.error ? (
        <Note tone="warn" title={job.step}>
          {job.error}
        </Note>
      ) : null}
      <Async state={art}>
        {(a) => {
          const byKind = new Map(a.items.map((i) => [i.kind, i]));
          const stingers = a.items.filter((i) => i.kind.startsWith("stinger"));
          return (
            <>
              {a.items.length === 0 && !working ? <p className="muted">Nothing made yet.</p> : null}
              <div className="art-grid">
                {ART_ORDER.map((kind) => {
                  const item = byKind.get(kind);
                  if (!item) return null;
                  const video = kind.startsWith("stinger");
                  return (
                    <figure key={kind} className="art-card">
                      {video ? <video className="art-preview art-checker" src={item.url} autoPlay loop muted playsInline aria-label={`${item.label} preview`} /> : <img className="art-preview" src={item.url} alt={`${item.label} preview`} />}
                      <figcaption>
                        <span>
                          <strong>{item.label}</strong> <span className="muted small">{fmtBytes(item.bytes)}</span>
                        </span>
                        <a className="btn btn-sm" href={item.url} download={fileName(teams, kind, item.url)}>
                          Download
                        </a>
                      </figcaption>
                    </figure>
                  );
                })}
              </div>
              <p className="small muted" style={{ marginTop: 8 }}>
                Saved on this computer in <span className="mono">{a.folder}</span> <CopyButton text={a.folder} label="Copy folder" size="sm" />
              </p>
              <Details summary="Background picture">
                <p className="small muted">The thumbnails and Up next screen are drawn on both teams' colours, or on a picture: a game screenshot, for example. Make them again after changing it.</p>
                <div className="row">
                  <AssetUpload
                    label="Picture"
                    value={a.settings.backgroundAssetId}
                    disabledReason={writeReason}
                    onChange={(id) => {
                      void api.put(`/api/v1/matches/${seg(matchId)}/art/settings`, { backgroundAssetId: id }).then(() => art.reload());
                    }}
                  />
                  <ActionButton size="sm" action={() => api.post(`/api/v1/matches/${seg(matchId)}/art/background-from-obs`)} success="Took the picture on air in OBS" onDone={() => void art.reload()} disabledReason={writeReason}>
                    Use what OBS shows now
                  </ActionButton>
                </div>
              </Details>
              <h3 className="ga-section-title">Stinger transitions in OBS</h3>
              <p className="small">
                Once in OBS: <strong>Scene Transitions → + → Stinger</strong>, named <span className="mono">{a.obs.transitions.stinger}</span>, and a second one named <span className="mono">{a.obs.transitions["stinger-replay"]}</span> (any video file; Matchframe replaces it). Then put this match's stingers in them. The active match's stingers go in by themselves when you activate it.
              </p>
              <div className="row" style={{ gap: 16 }}>
                <ActionButton
                  variant="primary"
                  action={() => api.post<MatchArtObsResult>(`/api/v1/matches/${seg(matchId)}/art/obs`, { useStinger })}
                  onDone={setObsResult}
                  success={(r) => (r.set.length ? `Stingers set in OBS (cut at ${a.obs.cutMs} ms)` : null)}
                  disabledReason={programReason ?? (stingers.length ? null : "Make the stingers first")}
                >
                  Put the stingers in OBS
                </ActionButton>
                <Checkbox checked={useStinger} onChange={setUseStinger} label="Use the stinger for every scene change" hint="Makes Matchframe Stinger OBS's current transition. Replays use the replay stinger." />
              </div>
              {obsResult ? (
                <div className="stack small" style={{ marginTop: 8 }}>
                  {obsResult.set.map((s) => (
                    <span key={s.transition}>
                      {s.confirmed ? "✓" : "⚠"} {s.transition}: {s.confirmed ? "set" : "OBS didn't confirm the change"}
                    </span>
                  ))}
                  {obsResult.missing.length ? (
                    <Note tone="warn" title="Not in OBS yet">
                      Add {obsResult.missing.map((m) => `“${m}”`).join(" and ")} in OBS (Scene Transitions → + → Stinger), then press the button again.
                    </Note>
                  ) : null}
                  {obsResult.set.length ? (
                    <span className="muted">
                      OBS's transition: {obsResult.current ?? "unknown"} · replays: {obsResult.replayTransition || "OBS's current transition"}
                    </span>
                  ) : null}
                </div>
              ) : null}
            </>
          );
        }}
      </Async>
    </Panel>
  );
}
