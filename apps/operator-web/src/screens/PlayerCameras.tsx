import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { api, seg } from "../api/index.ts";
import type { ObsState, PlayerCamConfig, PlayerCamResponse, PlayerRow, TeamRow } from "../api/types.ts";
import { ActionButton, Async, Badge, Checkbox, Details, EmptyState, Field, KV, Panel } from "../components/ui.tsx";
import { fmtTime, MISSING } from "../lib/format.ts";
import { useApi } from "../lib/hooks.ts";
import { Link } from "../router.tsx";
import { usePermission } from "../state/session.tsx";
import "../styles/group-b.css";

/** Keeps routing entries only for players who consented (the engine rejects the rest). */
export function routableSources(sources: Record<string, string>, players: { id: string; cameraConsent: boolean }[]): Record<string, string> {
  const consent = new Set(players.filter((p) => p.cameraConsent).map((p) => p.id));
  return Object.fromEntries(Object.entries(sources).filter(([id, src]) => consent.has(id) && src.trim() !== ""));
}

function ConsentToggle({ p, onSaved }: { p: PlayerRow; onSaved: () => void }) {
  const reason = usePermission("metadata.write");
  return (
    <ActionButton
      size="sm"
      variant="ghost"
      action={() => api.patch(`/api/v1/players/${seg(p.id)}`, { cameraConsent: !p.cameraConsent, revision: p.revision })}
      success={`${p.displayName}: consent ${p.cameraConsent ? "revoked" : "recorded"}`}
      onDone={onSaved}
      disabledReason={reason}
      confirm={p.cameraConsent ? { title: `Revoke ${p.displayName}'s camera consent?`, body: "Save the routing afterwards: their source is then removed from routing." } : { title: `Record camera consent for ${p.displayName}?`, body: "Only record consent you have actually obtained from the player." }}
    >
      {p.cameraConsent ? "Revoke consent" : "Record consent"}
    </ActionButton>
  );
}

export function PlayerCamerasScreen() {
  const reason = usePermission("program.control");
  const cfg = useApi<PlayerCamResponse>("/api/v1/player-cams/config", { refreshMs: 5000 });
  const players = useApi<PlayerRow[]>("/api/v1/players");
  const teams = useApi<TeamRow[]>("/api/v1/teams");
  const obs = useApi<{ state: ObsState }>("/api/v1/obs", { refreshMs: 10000 });
  const [draft, setDraft] = useState<PlayerCamConfig | null>(null);
  useEffect(() => {
    if (cfg.data && !draft) setDraft(cfg.data.config);
  }, [cfg.data, draft]);
  const teamName = (id: string | null) => (id ? (teams.data?.find((t) => t.id === id)?.name ?? null) : null);
  const inputs = obs.data?.state.inputs.map((i) => i.name) ?? [];
  const scenes = obs.data?.state.scenes ?? [];
  const list = players.data ?? [];
  return (
    <div className="page">
      <div className="page-head">
        <h1 className="page-title">Player Cameras</h1>
      </div>
      <p className="page-intro">Shows the observed player's camera in OBS and hides the others, while program is live.</p>
      <Details summary="How this works" className="gb-intro-details">
        <p className="small muted">
          When the observer is confirmed on a player, Matchframe makes that player's camera source visible in the chosen OBS scene and hides the others. Routing is keyed by stable player identity (SteamID), never by observer slot, and only covers players who consented. It acts only while program is live.
        </p>
        <p className="small muted">
          Consent is stored on the player record; the OBS source mapping is part of the routing settings. Routing only toggles OBS source visibility: remote camera intake (SRT, NDI, WebRTC) and a dedicated camera mixer are not implemented, so add each camera to the OBS scene yourself.
        </p>
      </Details>
      <Async state={cfg}>
        {(c) => {
          const d = draft ?? c.config;
          const set = (p: Partial<PlayerCamConfig>) => setDraft({ ...d, ...p });
          const st = c.status;
          const active = c.config.enabled && !!c.config.scene && st.obsConnected && st.programMode === "LIVE";
          const lastPlayer = list.find((p) => p.id === st.lastPlayerId);
          const dropped = Object.keys(d.sources).filter((id) => !list.find((p) => p.id === id)?.cameraConsent);
          const sourcesChanged = JSON.stringify(d.sources) !== JSON.stringify(c.config.sources);
          const modeText = st.programMode.charAt(0) + st.programMode.slice(1).replace(/_/g, " ").toLowerCase();
          const statusItems: [ReactNode, ReactNode][] = [
            ["Last routed player", lastPlayer?.displayName ?? st.lastPlayerId ?? "None"],
            ["Last source shown", st.lastSource ?? "None"],
            ["Last change", st.lastAt ? fmtTime(st.lastAt) : MISSING],
          ];
          if (st.programMode !== "LIVE") statusItems.push(["Program", `${modeText} (routing paused outside live)`]);
          if (st.lastError) statusItems.push(["Last error", <span className="text-danger">{st.lastError}</span>]);
          return (
            <div className="stack">
              <div className="grid-2">
                <Panel title="Routing" actions={active ? <Badge tone="ok" icon="●">Routing active</Badge> : c.config.enabled ? <Badge tone="warn">Enabled · idle</Badge> : <Badge>Disabled</Badge>}>
                  <div className="form-grid">
                    <Field label="OBS scene with the cameras">
                      <input list="pc-scenes" value={d.scene ?? ""} onChange={(e) => set({ scene: e.target.value || null })} placeholder="Player Cams" />
                      <datalist id="pc-scenes">
                        {scenes.map((s) => (
                          <option key={s} value={s} />
                        ))}
                      </datalist>
                    </Field>
                    <Field label="Fallback source" hint="When the observed player has no camera">
                      <input list="pc-inputs" value={d.fallbackSource ?? ""} onChange={(e) => set({ fallbackSource: e.target.value || null })} />
                    </Field>
                    <Field label="Delay (ms)" hint="Match a delayed program feed">
                      <input type="number" min={0} max={60000} step={100} value={d.delayMs} onChange={(e) => set({ delayMs: Number(e.target.value) })} />
                    </Field>
                  </div>
                  <datalist id="pc-inputs">
                    {inputs.map((s) => (
                      <option key={s} value={s} />
                    ))}
                  </datalist>
                  <div className="form-actions">
                    <Checkbox checked={d.enabled} onChange={(v) => set({ enabled: v })} label="Enable automatic player-camera routing" />
                    <ActionButton
                      variant="primary"
                      action={() => api.put("/api/v1/player-cams/config", { ...d, sources: routableSources(d.sources, list) })}
                      success="Player-camera routing saved"
                      onDone={() => {
                        setDraft(null);
                        void cfg.reload();
                      }}
                      disabledReason={reason ?? (d.enabled && !d.scene ? "Choose the OBS scene first" : null)}
                    >
                      Save routing
                    </ActionButton>
                  </div>
                  {dropped.length ? <p className="small text-warn">{dropped.length} mapping(s) belong to players without consent and will be removed on save.</p> : null}
                  {!st.obsConnected ? (
                    <p className="small text-warn">
                      OBS is not connected, so routing can't act. <Link to="/settings/devices">Connect OBS</Link>
                    </p>
                  ) : null}
                </Panel>
                <Panel title="Status" className="gb-start">
                  <KV items={statusItems} />
                  <Details summary="More">
                    <KV
                      items={[
                        ["OBS", st.obsConnected ? "Connected" : "Disconnected"],
                        ["Program", modeText],
                        ["Changes applied", st.applied],
                        ["Last error", st.lastError ?? "None"],
                      ]}
                    />
                  </Details>
                </Panel>
              </div>
              <Panel title="Players">
                {list.length === 0 ? (
                  <EmptyState title="No players">
                    Add players with SteamIDs in <Link to="/players">Players</Link> — routing matches telemetry by SteamID.
                  </EmptyState>
                ) : (
                  <table className="table table-compact">
                    <thead>
                      <tr>
                        <th>Player</th>
                        <th>Team</th>
                        <th>Consent</th>
                        <th>OBS camera source</th>
                        <th>Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {list.map((p) => {
                        const src = d.sources[p.id] ?? "";
                        const ok = p.cameraConsent && !!p.steamId && !!src;
                        return (
                          <tr key={p.id}>
                            <td>
                              <strong>{p.displayName}</strong>
                              {p.steamId ? <div className="small muted mono">{p.steamId}</div> : <div className="small text-warn">No SteamID, so telemetry can't match</div>}
                            </td>
                            <td>{teamName(p.teamId) ?? <span className="muted">Free agent</span>}</td>
                            <td>
                              <div className="row">
                                <span className={p.cameraConsent ? "" : "muted"}>{p.cameraConsent ? "Given" : "Not given"}</span>
                                <ConsentToggle p={p} onSaved={() => void players.reload()} />
                              </div>
                            </td>
                            <td>
                              <input
                                list="pc-inputs"
                                aria-label={`OBS camera source for ${p.displayName}`}
                                value={src}
                                disabled={!p.cameraConsent}
                                placeholder={p.cameraConsent ? (p.cameraSourceId ?? "OBS source name") : "Consent required"}
                                onChange={(e) => {
                                  const next = { ...d.sources };
                                  if (e.target.value) next[p.id] = e.target.value;
                                  else delete next[p.id];
                                  set({ sources: next });
                                }}
                              />
                            </td>
                            <td className="gb-nowrap">{ok ? <span className="text-ok">Routable</span> : !p.cameraConsent ? <span className="muted">Not routed</span> : !p.steamId ? <Badge tone="warn">No SteamID</Badge> : <Badge tone="warn">No source</Badge>}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                )}
                {sourcesChanged ? <p className="small text-warn">Source changes are not saved yet. Press Save routing.</p> : null}
              </Panel>
            </div>
          );
        }}
      </Async>
    </div>
  );
}
