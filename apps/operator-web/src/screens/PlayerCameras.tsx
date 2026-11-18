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
import { WebCams } from "./cams/WebCams.tsx";
import { t } from "../i18n/index.ts";
import { T } from "../i18n/T.tsx";

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
      success={(p.cameraConsent ? t("cams.consentRevoked", { displayName: p.displayName }) : t("cams.consentRecorded", { displayName: p.displayName }))}
      onDone={onSaved}
      disabledReason={reason}
      confirm={p.cameraConsent ? { title: t("cams.revokeDisplaynameSCameraConsent", { displayName: p.displayName }), body: t("cams.saveTheRoutingAfterwardsTheir") } : { title: t("cams.recordCameraConsentForDisplayname", { displayName: p.displayName }), body: t("cams.onlyRecordConsentYouHave") }}
    >
      {p.cameraConsent ? t("cams.revokeConsent") : t("cams.recordConsent")}
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
  const teamName = (id: string | null) => (id ? (teams.data?.find((tRow) => tRow.id === id)?.name ?? null) : null);
  const inputs = obs.data?.state.inputs.map((i) => i.name) ?? [];
  const scenes = obs.data?.state.scenes ?? [];
  const list = players.data ?? [];
  return (
    <div className="page">
      <div className="page-head">
        <h1 className="page-title">{t("cams.playerCameras")}</h1>
      </div>
      <p className="page-intro">{t("cams.playersFaceCamsSentFrom")}</p>
      <WebCams />
      <h2 className="gb-section-title">{t("cams.camerasYouAddToObs")}</h2>
      <p className="small muted">{t("cams.showsTheObservedPlayerS")}</p>
      <Details summary={t("cams.howThisWorks")} className="gb-intro-details">
        <p className="small muted">{t("cams.whenTheObserverIsConfirmed")}</p>
        <p className="small muted">{t("cams.consentIsStoredOnThe")}</p>
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
            [t("cams.lastRoutedPlayer"), lastPlayer?.displayName ?? st.lastPlayerId ?? t("cams.none")],
            [t("cams.lastSourceShown"), st.lastSource ?? t("cams.none")],
            [t("cams.lastChange"), st.lastAt ? fmtTime(st.lastAt) : MISSING],
          ];
          if (st.programMode !== "LIVE") statusItems.push([t("cams.program"), t("cams.modetextRoutingPausedOutsideLive", { modeText })]);
          if (st.lastError) statusItems.push([t("cams.lastError"), <span className="text-danger">{st.lastError}</span>]);
          return (
            <div className="stack">
              <div className="grid-2">
                <Panel title={t("cams.routing")} actions={active ? <Badge tone="ok" icon="●">{t("cams.routingActive")}</Badge> : c.config.enabled ? <Badge tone="warn">{t("cams.enabledIdle")}</Badge> : <Badge>{t("cams.disabled")}</Badge>}>
                  <div className="form-grid">
                    <Field label={t("cams.obsSceneWithTheCameras")}>
                      <input list="pc-scenes" value={d.scene ?? ""} onChange={(e) => set({ scene: e.target.value || null })} placeholder={t("cams.playerCams")} />
                      <datalist id="pc-scenes">
                        {scenes.map((s) => (
                          <option key={s} value={s} />
                        ))}
                      </datalist>
                    </Field>
                    <Field label={t("cams.fallbackSource")} hint={t("cams.whenTheObservedPlayerHas")}>
                      <input list="pc-inputs" value={d.fallbackSource ?? ""} onChange={(e) => set({ fallbackSource: e.target.value || null })} />
                    </Field>
                    <Field label={t("cams.delayMs")} hint={t("cams.matchADelayedProgramFeed")}>
                      <input type="number" min={0} max={60000} step={100} value={d.delayMs} onChange={(e) => set({ delayMs: Number(e.target.value) })} />
                    </Field>
                  </div>
                  <datalist id="pc-inputs">
                    {inputs.map((s) => (
                      <option key={s} value={s} />
                    ))}
                  </datalist>
                  <div className="form-actions">
                    <Checkbox checked={d.enabled} onChange={(v) => set({ enabled: v })} label={t("cams.enableAutomaticPlayerCameraRouting")} />
                    <ActionButton
                      variant="primary"
                      action={() => api.put("/api/v1/player-cams/config", { ...d, sources: routableSources(d.sources, list) })}
                      success={t("cams.playerCameraRoutingSaved")}
                      onDone={() => {
                        setDraft(null);
                        void cfg.reload();
                      }}
                      disabledReason={reason ?? (d.enabled && !d.scene ? t("cams.chooseTheObsSceneFirst") : null)}
                    >{t("cams.saveRouting")}</ActionButton>
                  </div>
                  {dropped.length ? <p className="small text-warn">{t("cams.countMappingSBelongTo", { count: dropped.length })}</p> : null}
                  {!st.obsConnected ? (
                    <p className="small text-warn"><T k="cams.obsIsNotConnectedSo" tags={{ link: (c) => <Link to="/settings/devices">{c}</Link> }} /></p>
                  ) : null}
                </Panel>
                <Panel title={t("cams.status")} className="gb-start">
                  <KV items={statusItems} />
                  <Details summary={t("cams.more")}>
                    <KV
                      items={[
                        ["OBS", st.obsConnected ? t("cams.connected") : t("cams.disconnected")],
                        [t("cams.program"), modeText],
                        [t("cams.changesApplied"), st.applied],
                        [t("cams.lastError"), st.lastError ?? t("cams.none")],
                      ]}
                    />
                  </Details>
                </Panel>
              </div>
              <Panel title={t("cams.players")}>
                {list.length === 0 ? (
                  <EmptyState title={t("cams.noPlayers")}><T k="cams.addPlayersWithSteamidsIn" tags={{ link: (c) => <Link to="/players">{c}</Link> }} /></EmptyState>
                ) : (
                  <table className="table table-compact">
                    <thead>
                      <tr>
                        <th>{t("cams.player")}</th>
                        <th>{t("cams.team")}</th>
                        <th>{t("cams.consent")}</th>
                        <th>{t("cams.obsCameraSource")}</th>
                        <th>{t("cams.status")}</th>
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
                              {p.steamId ? <div className="small muted mono">{p.steamId}</div> : <div className="small text-warn">{t("cams.noSteamidSoTelemetryCan")}</div>}
                            </td>
                            <td>{teamName(p.teamId) ?? <span className="muted">{t("cams.freeAgent")}</span>}</td>
                            <td>
                              <div className="row">
                                <span className={p.cameraConsent ? "" : "muted"}>{p.cameraConsent ? t("cams.given") : t("cams.notGiven")}</span>
                                <ConsentToggle p={p} onSaved={() => void players.reload()} />
                              </div>
                            </td>
                            <td>
                              <input
                                list="pc-inputs"
                                aria-label={t("cams.obsCameraSourceForDisplayname", { displayName: p.displayName })}
                                value={src}
                                disabled={!p.cameraConsent}
                                placeholder={p.cameraConsent ? (p.cameraSourceId ?? t("cams.obsSourceName")) : t("cams.consentRequired")}
                                onChange={(e) => {
                                  const next = { ...d.sources };
                                  if (e.target.value) next[p.id] = e.target.value;
                                  else delete next[p.id];
                                  set({ sources: next });
                                }}
                              />
                            </td>
                            <td className="gb-nowrap">{ok ? <span className="text-ok">{t("cams.routable")}</span> : !p.cameraConsent ? <span className="muted">{t("cams.notRouted")}</span> : !p.steamId ? <Badge tone="warn">{t("cams.noSteamid")}</Badge> : <Badge tone="warn">{t("cams.noSource")}</Badge>}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                )}
                {sourcesChanged ? <p className="small text-warn">{t("cams.sourceChangesAreNotSaved")}</p> : null}
              </Panel>
            </div>
          );
        }}
      </Async>
    </div>
  );
}
