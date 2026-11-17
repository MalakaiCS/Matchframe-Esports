import { useEffect, useState } from "react";
import { api, seg } from "../api/index.ts";
import type { ClipState, ObsState, ReplayItem, ReplaysResponse } from "../api/types.ts";
import { ActionButton, Async, Badge, Checkbox, Details, EmptyState, Field, KV, Panel } from "../components/ui.tsx";
import { fmtMatchTime, fmtMs, fmtTime } from "../lib/format.ts";
import { useApi } from "../lib/hooks.ts";
import { Link } from "../router.tsx";
import { useSnapshot } from "../state/live.ts";
import { usePermission } from "../state/session.tsx";
import "../styles/group-b.css";
import { AutoReplaysPanel, ReplayPcPanel } from "./replays/AutoReplays.tsx";
import { GraphicsPanel, ObsAutomationPanel } from "./replays/ProductionAutomation.tsx";
import { HighlightReelPanel } from "./replays/HighlightReel.tsx";
import { HighlightsOnAirPanel } from "./replays/HighlightsOnAir.tsx";
import { MapIntrosPanel } from "./replays/MapIntros.tsx";
import { ReplayGraphicPanel } from "./replays/ReplayGraphic.tsx";
import { StoragePanel } from "./replays/Storage.tsx";
import { t } from "../i18n/index.ts";
import { T } from "../i18n/T.tsx";

const STATE_TONE: Record<ClipState, "ok" | "info" | "warn" | "danger" | "neutral" | "accent"> = {
  bookmarked: "neutral",
  capturing: "info",
  prepared: "info",
  approved: "ok",
  playing: "accent",
  played: "neutral",
  rejected: "warn",
  failed: "danger",
};

function ProviderConfig({ onSaved }: { onSaved: () => void }) {
  const reason = usePermission("settings.manage");
  const cur = useApi<{ value: { kind: string; bufferSeconds?: number; bridgeUrl?: string } | null }>("/api/v1/settings/replay.provider");
  const media = useApi<{ value: string | null }>("/api/v1/settings/replay.mediaInput");
  const obs = useApi<{ state: ObsState }>("/api/v1/obs");
  const [kind, setKind] = useState("obs");
  const [buffer, setBuffer] = useState(20);
  const [bridge, setBridge] = useState("");
  const [mediaInput, setMediaInput] = useState("");
  useEffect(() => {
    const v = cur.data?.value;
    if (v) {
      setKind(v.kind);
      setBuffer(v.bufferSeconds ?? 20);
      setBridge(v.bridgeUrl ?? "");
    }
  }, [cur.data]);
  useEffect(() => setMediaInput(media.data?.value ?? ""), [media.data]);
  const mediaInputs = (obs.data?.state.inputs ?? []).filter((i) => /media|ffmpeg|vlc/i.test(i.kind));
  return (
    <>
      <div className="form-grid">
        <Field label={t("replays.replayProvider")}>
          <select value={kind} onChange={(e) => setKind(e.target.value)}>
            <option value="obs">{t("replays.obsReplayBuffer")}</option>
            <option value="bridge">{t("replays.existingReplayToolBridge")}</option>
            <option value="none">{t("replays.none")}</option>
          </select>
        </Field>
        {kind === "obs" ? (
          <Field label={t("replays.bufferLengthS")} hint={t("replays.mustMatchObsOutputReplay")}>
            <input type="number" min={5} max={600} value={buffer} onChange={(e) => setBuffer(Number(e.target.value))} />
          </Field>
        ) : null}
        {kind === "bridge" ? (
          <Field label={t("replays.bridgeUrl")}>
            <input value={bridge} onChange={(e) => setBridge(e.target.value)} placeholder="http://127.0.0.1:9000" />
          </Field>
        ) : null}
      </div>
      <div className="form-actions">
        <ActionButton
          action={() => api.put("/api/v1/settings/replay.provider", { value: kind === "obs" ? { kind, bufferSeconds: buffer } : kind === "bridge" ? { kind, bridgeUrl: bridge } : { kind } })}
          success={t("replays.replayProviderSaved")}
          onDone={onSaved}
          disabledReason={reason ?? (kind === "bridge" && !/^https?:\/\//.test(bridge) ? t("replays.enterTheBridgeUrl") : null)}
        >{t("replays.saveProvider")}</ActionButton>
      </div>
      <div className="row-end" style={{ marginTop: 10 }}>
        <Field label={t("replays.obsMediaSourceForPlayout")} hint={t("replays.theSourceInYourReplay")}>
          <input list="obs-media-inputs" value={mediaInput} onChange={(e) => setMediaInput(e.target.value)} placeholder={t("replays.replayMedia")} />
          <datalist id="obs-media-inputs">
            {mediaInputs.map((i) => (
              <option key={i.name} value={i.name} />
            ))}
          </datalist>
        </Field>
        <ActionButton action={() => api.put("/api/v1/settings/replay.mediaInput", { value: mediaInput || null })} success={t("replays.replayMediaSourceSaved")} onDone={() => void media.reload()} disabledReason={reason}>{t("replays.saveMediaSource")}</ActionButton>
      </div>
    </>
  );
}

function TrimForm({ item, onDone }: { item: ReplayItem; onDone: () => void }) {
  const reason = usePermission("replay.control");
  const [start, setStart] = useState(item.trim?.startMs ?? 0);
  const [dur, setDur] = useState(item.trim?.durationMs ?? item.clip?.media.durationMs ?? 8000);
  return (
    <span className="row">
      <input type="number" aria-label={t("replays.trimStartMs")} min={0} step={100} value={start} onChange={(e) => setStart(Number(e.target.value))} style={{ width: 90 }} />
      <input type="number" aria-label={t("replays.trimDurationMs")} min={100} step={100} value={dur} onChange={(e) => setDur(Number(e.target.value))} style={{ width: 90 }} />
      <ActionButton size="sm" variant="ghost" action={() => api.post(`/api/v1/replays/${seg(item.id)}/trim`, { startMs: start, durationMs: dur })} success={t("replays.trimSaved")} onDone={onDone} disabledReason={reason}>{t("replays.trim")}</ActionButton>
    </span>
  );
}

export function ReplaysScreen() {
  const replays = useApi<ReplaysResponse>("/api/v1/replays", { refreshMs: 2000 });
  const snap = useSnapshot();
  const reason = usePermission("replay.control");
  const programReason = usePermission("program.control");
  const [label, setLabel] = useState(t("replays.manualBookmark"));
  const [pre, setPre] = useState(8);
  const [post, setPost] = useState(2);
  const [capture, setCapture] = useState(true);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const playlist = useApi<ReplayItem[]>(`/api/v1/replays/playlist${from || to ? `?${new URLSearchParams({ ...(from ? { from } : {}), ...(to ? { to } : {}) }).toString()}` : ""}`, { refreshMs: 5000 });
  const programMode = snap?.program.mode ?? "LIVE";
  return (
    <div className="page">
      <div className="page-head">
        <h1 className="page-title">{t("replays.replaysProduction")}</h1>
        <ActionButton variant="primary" action={() => api.post<{ to: string; detail: string | null }>("/api/v1/program/return-live")} success={(tRow) => `Program → ${tRow.to.replace(/_/g, " ").toLowerCase()}${tRow.detail ? ` (${tRow.detail})` : ""}`} disabledReason={programReason ?? (programMode === "LIVE" ? t("replays.programIsAlreadyLive") : null)}>{t("replays.returnLive")}</ActionButton>
      </div>
      <p className="page-intro">{t("replays.replaysPlayByThemselvesBetween")}</p>
      <div className="grid-2">
        <AutoReplaysPanel />
        <ReplayPcPanel />
        <ObsAutomationPanel />
        <GraphicsPanel />
        <ReplayGraphicPanel />
        <HighlightsOnAirPanel />
        <MapIntrosPanel />
        <HighlightReelPanel />
        <StoragePanel />
      </div>
      <Async state={replays}>
        {(r) => {
          const p = r.provider;
          return (
            <div className="stack">
              <div className="grid-2">
                <Panel title={t("replays.bookmark")}>
                  <div className="form-grid">
                    <Field label={t("replays.label")} className="span-all">
                      <input value={label} onChange={(e) => setLabel(e.target.value)} />
                    </Field>
                    <Field label={t("replays.preRollS")}>
                      <input type="number" min={0} max={60} value={pre} onChange={(e) => setPre(Number(e.target.value))} />
                    </Field>
                    <Field label={t("replays.postRollS")}>
                      <input type="number" min={0} max={10} value={post} onChange={(e) => setPost(Number(e.target.value))} />
                    </Field>
                  </div>
                  <div className="form-actions">
                    <Checkbox checked={capture} onChange={setCapture} label={t("replays.captureAClipAfterThe")} />
                    <ActionButton
                      variant="primary"
                      action={() => api.post<ReplayItem>("/api/v1/replays/bookmarks", { label, preRollMs: pre * 1000, postRollMs: post * 1000, capture })}
                      success={(it) => `Bookmarked “${it.label}”${capture ? " — capturing" : ""}`}
                      onDone={() => void replays.reload()}
                      disabledReason={reason}
                    >{t("replays.bookmarkV", { v: capture ? t("replays.andCapture") : "" })}</ActionButton>
                  </div>
                  {capture && p && !p.health.ok ? <p className="small text-warn">{t("replays.theProviderIsnTReady")}</p> : null}
                </Panel>
                <Panel title={t("replays.provider")} subtitle={p ? p.health.detail : undefined} actions={p ? p.health.ok ? <Badge tone="ok">{t("replays.ready")}</Badge> : <Badge tone="warn">{t("replays.notReady")}</Badge> : <Badge>{t("replays.none")}</Badge>}>
                  {p ? (
                    !p.health.ok && p.kind === "obs_replay_buffer" ? (
                      <p className="small"><T k="replays.connectObsAndStartIts" tags={{ link: (c) => <Link to="/settings/devices">{c}</Link> }} /></p>
                    ) : null
                  ) : (
                    <EmptyState title={t("replays.noReplayProvider")}>{t("replays.chooseTheObsReplayBuffer")}</EmptyState>
                  )}
                  {p ? (
                    <Details summary={t("replays.providerDetails")}>
                      <KV
                        items={[
                          [t("replays.provider"), `${p.kind} · ${p.id}`],
                          [t("replays.health"), p.health.detail],
                          [t("replays.capabilities"), p.capabilities ? Object.entries(p.capabilities).filter(([k, v]) => k !== "limitations" && v === true).map(([k]) => k).join(", ") : t("common.unknown")],
                        ]}
                      />
                      {p.capabilities?.limitations.length ? (
                        <>
                          <p className="small" style={{ marginTop: 8 }}>{t("replays.limitations")}</p>
                          <ul className="small muted" style={{ margin: 0, paddingLeft: 18 }}>
                            {p.capabilities.limitations.map((l, i) => (
                              <li key={i}>{l}</li>
                            ))}
                          </ul>
                        </>
                      ) : null}
                    </Details>
                  ) : null}
                  <Details summary={t("replays.providerSettings")} open={!p}>
                    <ProviderConfig onSaved={() => void replays.reload()} />
                  </Details>
                </Panel>
              </div>
              <Panel title={t("replays.queueCount", { count: r.items.length })} subtitle={t("replays.nothingPlaysUntilYouApprove")}>
                {r.items.length === 0 ? (
                  <EmptyState title={t("replays.queueEmpty")}>{t("replays.bookmarksFromThisPageStream")}</EmptyState>
                ) : (
                  <div className="table-wrap">
                    <table className="table table-compact">
                      <thead>
                        <tr>
                          <th>{t("replays.state")}</th>
                          <th>{t("replays.bookmark")}</th>
                          <th>{t("replays.clip")}</th>
                          <th>{t("replays.trimStartLengthMs")}</th>
                          <th />
                        </tr>
                      </thead>
                      <tbody>
                        {[...r.items].reverse().map((it) => (
                          <tr key={it.id}>
                            <td>
                              <Badge tone={STATE_TONE[it.state]}>{it.state}</Badge>
                              {it.error ? <div className="small text-danger">{it.error}</div> : null}
                            </td>
                            <td>
                              <strong>{it.label}</strong>
                              <div className="small muted">
                                {it.reason}
                                {it.roundNumber !== null ? t("replays.roundRoundnumber", { roundNumber: it.roundNumber }) : ""} · {fmtTime(it.createdAt)}
                              </div>
                            </td>
                            <td className="small">
                              {it.clip ? (
                                <span title={t("replays.matchTimeIsEstimatedTimeuncertaintyms", { timeUncertaintyMs: fmtMs(it.clip.timeUncertaintyMs), v: it.clip.media.width ? ` · ${it.clip.media.width}×${it.clip.media.height}` : "" })}><T k="replays.durationmsAngleAngleDiv" values={{ durationMs: fmtMs(it.clip.media.durationMs), angle: it.clip.angle, div: <div className="muted">{t("replays.matchTimeMatchtimefrommsMatchtimetomsEst", { matchTimeFromMs: fmtMatchTime(it.clip.matchTimeFromMs), matchTimeToMs: fmtMatchTime(it.clip.matchTimeToMs) })}</div> }} /></span>
                              ) : (
                                <span className="muted">{t("replays.noClipYet")}</span>
                              )}
                            </td>
                            <td>{it.clip ? <TrimForm item={it} onDone={() => void replays.reload()} /> : <span className="muted small">—</span>}</td>
                            <td>
                              <div className="cell-actions">
                                <ActionButton size="sm" action={() => api.post(`/api/v1/replays/${seg(it.id)}/approve`)} success={t("replays.approved")} onDone={() => void replays.reload()} disabledReason={reason ?? (it.state === "prepared" ? null : it.state === "bookmarked" || it.state === "capturing" ? t("replays.waitingForTheCapturedClip") : t("replays.onlyPreparedClipsCanBe", { state: it.state }))}>{t("replays.approve")}</ActionButton>
                                <ActionButton size="sm" variant="ghost" action={() => api.post(`/api/v1/replays/${seg(it.id)}/reject`)} success={t("replays.rejected")} onDone={() => void replays.reload()} disabledReason={reason ?? (it.state === "playing" || it.state === "rejected" ? t("replays.cannotRejectAStateItem", { state: it.state }) : null)}>{t("replays.reject")}</ActionButton>
                                <ActionButton size="sm" variant="primary" action={() => api.post(`/api/v1/replays/${seg(it.id)}/play`)} success={t("replays.replayOnProgram")} onDone={() => void replays.reload()} disabledReason={reason ?? (it.state !== "approved" ? t("replays.approveTheClipFirst") : !it.clip?.media.path ? t("replays.clipHasNoMediaFile") : null)} confirm={{ title: t("replays.playLabelOnProgram", { label: it.label }), body: t("replays.switchesProgramToTheReplay") }}>{t("replays.play")}</ActionButton>
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </Panel>
              <Panel title={t("replays.highlightsPlaylist")} subtitle={t("replays.approvedAndPlayedClipsBy")}>
                <div className="row-end" style={{ marginBottom: 10 }}>
                  <Field label={t("replays.fromRound")}>
                    <input type="number" min={0} value={from} onChange={(e) => setFrom(e.target.value)} style={{ width: 100 }} />
                  </Field>
                  <Field label={t("replays.toRound")}>
                    <input type="number" min={0} value={to} onChange={(e) => setTo(e.target.value)} style={{ width: 100 }} />
                  </Field>
                </div>
                <Async state={playlist}>
                  {(list) =>
                    list.length === 0 ? (
                      <p className="muted small">{t("replays.noApprovedClipsInThis")}</p>
                    ) : (
                      <ol>
                        {list.map((it) => (
                          <li key={it.id}>
                            R{it.roundNumber ?? "?"} · {it.label} · {it.state} {it.clip ? `· ${fmtMs(it.clip.media.durationMs)}` : ""}
                          </li>
                        ))}
                      </ol>
                    )
                  }
                </Async>
              </Panel>
            </div>
          );
        }}
      </Async>
    </div>
  );
}
