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
        <Field label="Replay provider">
          <select value={kind} onChange={(e) => setKind(e.target.value)}>
            <option value="obs">OBS replay buffer</option>
            <option value="bridge">Existing replay tool (bridge)</option>
            <option value="none">None</option>
          </select>
        </Field>
        {kind === "obs" ? (
          <Field label="Buffer length (s)" hint="Must match OBS → Output → Replay Buffer">
            <input type="number" min={5} max={600} value={buffer} onChange={(e) => setBuffer(Number(e.target.value))} />
          </Field>
        ) : null}
        {kind === "bridge" ? (
          <Field label="Bridge URL">
            <input value={bridge} onChange={(e) => setBridge(e.target.value)} placeholder="http://127.0.0.1:9000" />
          </Field>
        ) : null}
      </div>
      <div className="form-actions">
        <ActionButton
          action={() => api.put("/api/v1/settings/replay.provider", { value: kind === "obs" ? { kind, bufferSeconds: buffer } : kind === "bridge" ? { kind, bridgeUrl: bridge } : { kind } })}
          success="Replay provider saved"
          onDone={onSaved}
          disabledReason={reason ?? (kind === "bridge" && !/^https?:\/\//.test(bridge) ? "Enter the bridge URL" : null)}
        >
          Save provider
        </ActionButton>
      </div>
      <div className="row-end" style={{ marginTop: 10 }}>
        <Field label="OBS media source for playout" hint="The source in your replay scene that plays clips">
          <input list="obs-media-inputs" value={mediaInput} onChange={(e) => setMediaInput(e.target.value)} placeholder="Replay Media" />
          <datalist id="obs-media-inputs">
            {mediaInputs.map((i) => (
              <option key={i.name} value={i.name} />
            ))}
          </datalist>
        </Field>
        <ActionButton action={() => api.put("/api/v1/settings/replay.mediaInput", { value: mediaInput || null })} success="Replay media source saved" onDone={() => void media.reload()} disabledReason={reason}>
          Save media source
        </ActionButton>
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
      <input type="number" aria-label="Trim start (ms)" min={0} step={100} value={start} onChange={(e) => setStart(Number(e.target.value))} style={{ width: 90 }} />
      <input type="number" aria-label="Trim duration (ms)" min={100} step={100} value={dur} onChange={(e) => setDur(Number(e.target.value))} style={{ width: 90 }} />
      <ActionButton size="sm" variant="ghost" action={() => api.post(`/api/v1/replays/${seg(item.id)}/trim`, { startMs: start, durationMs: dur })} success="Trim saved" onDone={onDone} disabledReason={reason}>
        Trim
      </ActionButton>
    </span>
  );
}

export function ReplaysScreen() {
  const replays = useApi<ReplaysResponse>("/api/v1/replays", { refreshMs: 2000 });
  const snap = useSnapshot();
  const reason = usePermission("replay.control");
  const programReason = usePermission("program.control");
  const [label, setLabel] = useState("Manual bookmark");
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
        <h1 className="page-title">Replays &amp; Highlights</h1>
        <ActionButton variant="primary" action={() => api.post<{ to: string; detail: string | null }>("/api/v1/program/return-live")} success={(t) => `Program → ${t.to.replace(/_/g, " ").toLowerCase()}${t.detail ? ` (${t.detail})` : ""}`} disabledReason={programReason ?? (programMode === "LIVE" ? "Program is already live" : null)}>
          Return live
        </ActionButton>
      </div>
      <p className="page-intro">Bookmark, capture, approve, then play clips on the replay scene; the live observer camera never moves for a replay.</p>
      <Async state={replays}>
        {(r) => {
          const p = r.provider;
          return (
            <div className="stack">
              <div className="grid-2">
                <Panel title="Bookmark">
                  <div className="form-grid">
                    <Field label="Label" className="span-all">
                      <input value={label} onChange={(e) => setLabel(e.target.value)} />
                    </Field>
                    <Field label="Pre-roll (s)">
                      <input type="number" min={0} max={60} value={pre} onChange={(e) => setPre(Number(e.target.value))} />
                    </Field>
                    <Field label="Post-roll (s)">
                      <input type="number" min={0} max={10} value={post} onChange={(e) => setPost(Number(e.target.value))} />
                    </Field>
                  </div>
                  <div className="form-actions">
                    <Checkbox checked={capture} onChange={setCapture} label="Capture a clip after the post-roll" />
                    <ActionButton
                      variant="primary"
                      action={() => api.post<ReplayItem>("/api/v1/replays/bookmarks", { label, preRollMs: pre * 1000, postRollMs: post * 1000, capture })}
                      success={(it) => `Bookmarked “${it.label}”${capture ? " — capturing" : ""}`}
                      onDone={() => void replays.reload()}
                      disabledReason={reason}
                    >
                      Bookmark{capture ? " and capture" : ""}
                    </ActionButton>
                  </div>
                  {capture && p && !p.health.ok ? <p className="small text-warn">The provider isn't ready, so capture will fail. The bookmark is still kept.</p> : null}
                </Panel>
                <Panel title="Provider" subtitle={p ? p.health.detail : undefined} actions={p ? p.health.ok ? <Badge tone="ok">Ready</Badge> : <Badge tone="warn">Not ready</Badge> : <Badge>None</Badge>}>
                  {p ? (
                    !p.health.ok && p.kind === "obs_replay_buffer" ? (
                      <p className="small">
                        Connect OBS and start its replay buffer in <Link to="/settings/devices">Settings → Devices</Link>.
                      </p>
                    ) : null
                  ) : (
                    <EmptyState title="No replay provider">Choose the OBS replay buffer or an existing replay tool in the provider settings.</EmptyState>
                  )}
                  {p ? (
                    <Details summary="Provider details">
                      <KV
                        items={[
                          ["Provider", `${p.kind} · ${p.id}`],
                          ["Health", p.health.detail],
                          ["Capabilities", p.capabilities ? Object.entries(p.capabilities).filter(([k, v]) => k !== "limitations" && v === true).map(([k]) => k).join(", ") : "unknown"],
                        ]}
                      />
                      {p.capabilities?.limitations.length ? (
                        <>
                          <p className="small" style={{ marginTop: 8 }}>
                            Limitations
                          </p>
                          <ul className="small muted" style={{ margin: 0, paddingLeft: 18 }}>
                            {p.capabilities.limitations.map((l, i) => (
                              <li key={i}>{l}</li>
                            ))}
                          </ul>
                        </>
                      ) : null}
                    </Details>
                  ) : null}
                  <Details summary="Provider settings" open={!p}>
                    <ProviderConfig onSaved={() => void replays.reload()} />
                  </Details>
                </Panel>
              </div>
              <Panel title={`Queue (${r.items.length})`} subtitle="Nothing plays until you approve it">
                {r.items.length === 0 ? (
                  <EmptyState title="Queue empty">Bookmarks from this page, Stream Deck or Companion buttons and automation rules appear here.</EmptyState>
                ) : (
                  <div className="table-wrap">
                    <table className="table table-compact">
                      <thead>
                        <tr>
                          <th>State</th>
                          <th>Bookmark</th>
                          <th>Clip</th>
                          <th>Trim (start / length, ms)</th>
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
                                {it.roundNumber !== null ? ` · round ${it.roundNumber}` : ""} · {fmtTime(it.createdAt)}
                              </div>
                            </td>
                            <td className="small">
                              {it.clip ? (
                                <span title={`Match time is estimated (±${fmtMs(it.clip.timeUncertaintyMs)})${it.clip.media.width ? ` · ${it.clip.media.width}×${it.clip.media.height}` : ""}`}>
                                  {fmtMs(it.clip.media.durationMs)} · {it.clip.angle} angle
                                  <div className="muted">
                                    match time {fmtMatchTime(it.clip.matchTimeFromMs)}–{fmtMatchTime(it.clip.matchTimeToMs)} (estimated)
                                  </div>
                                </span>
                              ) : (
                                <span className="muted">No clip yet</span>
                              )}
                            </td>
                            <td>{it.clip ? <TrimForm item={it} onDone={() => void replays.reload()} /> : <span className="muted small">—</span>}</td>
                            <td>
                              <div className="cell-actions">
                                <ActionButton size="sm" action={() => api.post(`/api/v1/replays/${seg(it.id)}/approve`)} success="Approved" onDone={() => void replays.reload()} disabledReason={reason ?? (it.state === "prepared" ? null : it.state === "bookmarked" || it.state === "capturing" ? "Waiting for the captured clip" : `Only prepared clips can be approved (is ${it.state})`)}>
                                  Approve
                                </ActionButton>
                                <ActionButton size="sm" variant="ghost" action={() => api.post(`/api/v1/replays/${seg(it.id)}/reject`)} success="Rejected" onDone={() => void replays.reload()} disabledReason={reason ?? (it.state === "playing" || it.state === "rejected" ? `Cannot reject a ${it.state} item` : null)}>
                                  Reject
                                </ActionButton>
                                <ActionButton size="sm" variant="primary" action={() => api.post(`/api/v1/replays/${seg(it.id)}/play`)} success="Replay on program" onDone={() => void replays.reload()} disabledReason={reason ?? (it.state !== "approved" ? "Approve the clip first" : !it.clip?.media.path ? "Clip has no media file" : null)} confirm={{ title: `Play “${it.label}” on program?`, body: "Switches program to the replay scene. Use Return live to go back." }}>
                                  Play
                                </ActionButton>
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </Panel>
              <Panel title="Highlights playlist" subtitle="Approved and played clips, by round">
                <div className="row-end" style={{ marginBottom: 10 }}>
                  <Field label="From round">
                    <input type="number" min={0} value={from} onChange={(e) => setFrom(e.target.value)} style={{ width: 100 }} />
                  </Field>
                  <Field label="To round">
                    <input type="number" min={0} value={to} onChange={(e) => setTo(e.target.value)} style={{ width: 100 }} />
                  </Field>
                </div>
                <Async state={playlist}>
                  {(list) =>
                    list.length === 0 ? (
                      <p className="muted small">No approved clips in this range.</p>
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
