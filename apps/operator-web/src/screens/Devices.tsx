import { useEffect, useState } from "react";
import { api, seg } from "../api/index.ts";
import type { DeviceActionInfo, DeviceTally, GamesResponse, MatchFrameBridgeStatus, MatchRow, ObserverAdapterResponse, ObsSceneItem, ObsState, TokenInfo } from "../api/types.ts";
import { ActionButton, Async, Badge, Checkbox, CopyButton, Details, EmptyState, Field, KV, Note, Panel, parseJsonOr, SupportBadge, Tabs } from "../components/ui.tsx";
import { capabilityMeta } from "../lib/capabilities.ts";
import { MODE_INFO } from "../lib/director.ts";
import { fmtTime, MISSING } from "../lib/format.ts";
import { useApi, usePersistentState } from "../lib/hooks.ts";
import { ROLE_DESCRIPTIONS } from "../lib/permissions.ts";
import { Link } from "../router.tsx";
import { useSnapshot } from "../state/live.ts";
import { usePermission } from "../state/session.tsx";
import { engineOrigin } from "../lib/engine.ts";
import { t } from "../i18n/index.ts";
import { T } from "../i18n/T.tsx";
import "../styles/group-c.css";

function onOff(v: boolean | null): string {
  return v === null ? t("common.unknown") : v ? t("common.on") : t("common.off");
}

function SceneItems({ scene }: { scene: string }) {
  const reason = usePermission("program.control");
  const items = useApi<ObsSceneItem[]>(`/api/v1/obs/scenes/${seg(scene)}/items`);
  return (
    <Async state={items}>
      {(list) =>
        list.length === 0 ? (
          <p className="muted small">{t("devices.noSourcesInThisScene")}</p>
        ) : (
          <ul className="list-plain small">
            {list.map((it) => {
              const enabled = it.enabled ?? it.sceneItemEnabled ?? false;
              return (
                <li key={it.sceneItemId} className="row">
                  <span style={{ flex: 1 }} className={enabled ? undefined : "muted"}>
                    {it.sourceName} <span className="muted">{it.inputKind ?? ""}</span>
                  </span>
                  {enabled ? null : <span className="muted">{t("devices.hidden")}</span>}
                  <ActionButton size="sm" variant="ghost" action={() => api.post<{ confirmed: boolean }>("/api/v1/obs/source-visibility", { scene, source: it.sourceName, visible: !enabled })} success={(r) => `${it.sourceName} ${enabled ? "hidden" : "shown"}${r.confirmed ? "" : t("devices.notConfirmed")}`} onDone={() => void items.reload()} disabledReason={reason}>
                    {enabled ? t("devices.hide") : t("devices.show")}
                  </ActionButton>
                </li>
              );
            })}
          </ul>
        )
      }
    </Async>
  );
}

function AudioRow({ input }: { input: { name: string; kind: string } }) {
  const reason = usePermission("program.control");
  const [db, setDb] = useState(0);
  return (
    <tr>
      <td>
        {input.name}
        <div className="small muted">{input.kind}</div>
      </td>
      <td>
        <div className="row">
          <ActionButton size="sm" variant="ghost" action={() => api.post("/api/v1/obs/audio", { input: input.name, muted: true })} success={t("devices.nameMuted", { name: input.name })} disabledReason={reason}>{t("devices.mute")}</ActionButton>
          <ActionButton size="sm" variant="ghost" action={() => api.post("/api/v1/obs/audio", { input: input.name, muted: false })} success={t("devices.nameUnmuted", { name: input.name })} disabledReason={reason}>{t("devices.unmute")}</ActionButton>
        </div>
      </td>
      <td>
        <div className="row">
          <input type="range" min={-60} max={6} step={1} value={db} aria-label={t("devices.nameVolumeDb", { name: input.name })} onChange={(e) => setDb(Number(e.target.value))} />
          <span className="mono small" style={{ width: 52 }}>{t("devices.dbDb", { db })}</span>
          <ActionButton size="sm" action={() => api.post<{ volume?: { confirmed: boolean; db: number } }>("/api/v1/obs/audio", { input: input.name, volumeDb: db })} success={(r) => `${input.name} → ${r.volume?.db ?? db} dB${r.volume?.confirmed === false ? t("devices.notConfirmed") : ""}`} disabledReason={reason}>{t("devices.set")}</ActionButton>
        </div>
      </td>
    </tr>
  );
}

function ObsConnectForm({ onDone, defaultUrl, primary = true }: { onDone: () => void; defaultUrl?: string | undefined; primary?: boolean }) {
  const reason = usePermission("program.control");
  const [url, setUrl] = useState(defaultUrl ?? "ws://127.0.0.1:4455");
  const [password, setPassword] = useState("");
  const [remember, setRemember] = useState(true);
  return (
    <div className="gc-form">
      <div className="form-grid">
        <Field label={t("devices.obsWebsocketUrl")} hint={t("devices.obsToolsWebsocketServerSettings")}>
          <input value={url} onChange={(e) => setUrl(e.target.value)} />
        </Field>
        <Field label={t("devices.password")}>
          <input type="password" autoComplete="off" value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
      </div>
      <div className="row">
        <Checkbox checked={remember} onChange={setRemember} label={t("devices.remember")} />
        <ActionButton
          variant={primary ? "primary" : "secondary"}
          action={() => api.post<{ state: ObsState }>("/api/v1/obs/connect", { url, ...(password ? { password } : {}), remember })}
          success={(r) => (r.state.connected ? t("devices.connectedToObsV", { v: r.state.obsVersion ?? "" }) : t("devices.notConnectedV", { v: r.state.lastError ?? t("devices.unknownError") }))}
          onDone={onDone}
          disabledReason={reason ?? (/^wss?:\/\//.test(url) ? null : t("devices.urlMustStartWithWs"))}
        >{t("devices.connect")}</ActionButton>
      </div>
    </div>
  );
}

function ObsTab() {
  const reason = usePermission("program.control");
  const obs = useApi<{ state: ObsState; profiles: { id: string; name: string; url: string; hasPassword: boolean }[] }>("/api/v1/obs", { refreshMs: 3000 });
  const [scene, setScene] = useState<string | null>(null);
  const [shotSource, setShotSource] = useState("");
  const [shot, setShot] = useState<string | null>(null);
  return (
    <Async state={obs}>
      {({ state: s, profiles }) => (
        <div className="stack">
          <div className="grid-2">
            <Panel
              title={t("devices.obsConnection")}
              actions={s.connected ? <Badge tone="ok">{t("devices.connected")}</Badge> : s.connecting ? <Badge tone="info">{t("devices.connecting")}</Badge> : <Badge tone="warn">{t("devices.disconnected")}</Badge>}
            >
              {s.connected ? (
                <>
                  <KV
                    items={[
                      [t("devices.programPreview"), `${s.programScene ?? MISSING} / ${s.previewScene ?? MISSING}`],
                      [t("devices.studioMode"), onOff(s.studioMode)],
                    ]}
                  />
                  {s.inputKinds.includes("browser_source") ? null : <p className="small text-warn">{t("devices.theObsBrowserPluginIs")}</p>}
                  <div className="form-actions">
                    <ActionButton size="sm" action={() => api.post("/api/v1/obs/refresh")} success={t("devices.obsStateRefreshed")} onDone={() => void obs.reload()} disabledReason={reason}>{t("devices.refresh")}</ActionButton>
                    <ActionButton size="sm" variant="ghost" action={() => api.post("/api/v1/obs/disconnect")} success={t("devices.obsDisconnected")} onDone={() => void obs.reload()} disabledReason={reason} confirm={{ title: t("devices.disconnectObs"), body: t("devices.programModeBecomesDegradedUntil") }}>{t("devices.disconnect")}</ActionButton>
                  </div>
                </>
              ) : (
                <>
                  {s.lastError ? <p className="small text-danger">{t("devices.lastErrorLasterror", { lastError: s.lastError })}</p> : null}
                  {profiles[0] ? (
                    <>
                      <ActionButton variant="primary" action={() => api.post<{ state: ObsState }>("/api/v1/obs/connect", { url: profiles[0]!.url, name: profiles[0]!.name })} success={(r) => (r.state.connected ? t("devices.connectedToObs") : t("devices.notConnectedV", { v: r.state.lastError ?? "?" }))} onDone={() => void obs.reload()} disabledReason={reason}>{t("devices.reconnectSavedProfile")}</ActionButton>
                      <Details summary={t("devices.connectToADifferentObs")}>
                        <ObsConnectForm onDone={() => void obs.reload()} defaultUrl={profiles[0]?.url} primary={false} />
                      </Details>
                    </>
                  ) : (
                    <ObsConnectForm onDone={() => void obs.reload()} />
                  )}
                </>
              )}
              <Details summary={t("devices.connectionDetails")}>
                <KV
                  items={[
                    [t("devices.profile"), profiles[0] ? `${profiles[0].name} · ${profiles[0].url}${profiles[0].hasPassword ? t("devices.passwordStored") : ""}` : t("devices.noneSaved")],
                    [t("devices.obsWebsocketVersions"), `${s.obsVersion ?? MISSING} / ${s.websocketVersion ?? MISSING}${s.platform ? ` · ${s.platform}` : ""}`],
                    [t("devices.studioMode"), onOff(s.studioMode)],
                    [t("devices.programPreview"), `${s.programScene ?? MISSING} / ${s.previewScene ?? MISSING}`],
                    [t("devices.browserSourcePlugin"), s.inputKinds.includes("browser_source") ? t("devices.available") : s.connected ? t("devices.obsBrowserMissing") : MISSING],
                    [t("devices.lastError"), s.lastError ?? t("common.none")],
                    [t("devices.reconnectAttempts"), s.reconnectAttempt],
                  ]}
                />
              </Details>
            </Panel>
            <Panel title={t("devices.outputs")}>
              {!s.connected ? (
                <EmptyState title={t("devices.obsNotConnected")}>{t("devices.connectObsToControlRecording")}</EmptyState>
              ) : (
                <table className="table table-compact">
                  <tbody>
                    {(
                      [
                        ["record", "Recording", s.recording],
                        ["stream", "Streaming", s.streaming],
                        ["replay", t("devices.replayBuffer"), s.replayBuffer],
                      ] as const
                    ).map(([kind, label, on]) => (
                      <tr key={kind}>
                        <td>{label}</td>
                        <td>{on ? <Badge tone={kind === "stream" ? "danger" : "ok"} icon="●">{t("devices.on")}</Badge> : <span className="muted">{on === null ? t("common.unknown") : t("devices.off")}</span>}</td>
                        <td>
                          <ActionButton
                            size="sm"
                            variant={on ? "warn" : "secondary"}
                            action={() => api.post("/api/v1/obs/output", { kind, active: !on })}
                            success={`${label} ${on ? "stopped" : "started"}`}
                            onDone={() => void obs.reload()}
                            disabledReason={reason}
                           
                            confirm={kind === "stream" ? { title: on ? t("devices.stopTheStream") : t("devices.startStreaming"), body: on ? t("devices.viewersWillLoseTheBroadcast") : t("devices.obsStartsStreamingToIts"), danger: !!on } : undefined}
                          >
                            {on ? t("devices.stop") : t("devices.start")}
                          </ActionButton>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              <div className="form-actions">
                <ActionButton size="sm" title={t("devices.addsTheMainHudAs")} action={() => api.post("/api/v1/obs/provision", {})} success={t("devices.hudBrowserSourceProvisionedScene")} disabledReason={reason ?? (s.connected ? null : t("devices.connectObsFirst"))}>{t("devices.addHudBrowserSource")}</ActionButton>
              </div>
            </Panel>
          </div>
          {s.connected ? (
            <>
              <div className="grid-2">
                <Panel title={t("devices.scenesCount", { count: s.scenes.length })}>
                  <table className="table table-compact">
                    <tbody>
                      {s.scenes.map((sc) => (
                        <tr key={sc} className={sc === scene ? "is-selected" : ""}>
                          <td>
                            <button className="link-btn" onClick={() => setScene(sc === scene ? null : sc)}>
                              {sc}
                            </button>{" "}
                            {sc === s.programScene ? <Badge tone="danger">{t("devices.program")}</Badge> : null} {sc === s.previewScene ? <Badge tone="ok">{t("devices.preview")}</Badge> : null}
                          </td>
                          <td>
                            <div className="cell-actions">
                              <ActionButton size="sm" variant="ghost" action={() => api.post<{ confirmed: boolean }>("/api/v1/obs/preview", { scene: sc })} success={(r) => `Preview: ${sc}${r.confirmed ? "" : t("devices.notConfirmed")}`} onDone={() => void obs.reload()} disabledReason={reason ?? (s.studioMode ? null : t("devices.studioModeIsOffIn"))}>{t("devices.preview")}</ActionButton>
                              <ActionButton size="sm" action={() => api.post<{ confirmed: boolean }>("/api/v1/obs/program", { scene: sc })} success={(r) => `Program: ${sc}${r.confirmed ? "" : t("devices.notConfirmed")}`} onDone={() => void obs.reload()} disabledReason={reason} confirm={{ title: t("devices.putScOnProgram", { sc }), body: t("devices.bypassesTheProgramStateMachine") }}>{t("devices.program")}</ActionButton>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </Panel>
                <Panel title={scene ? t("devices.sourcesInScene", { scene }) : t("devices.sceneSources")}>{scene ? <SceneItems key={scene} scene={scene} /> : <p className="muted small">{t("devices.chooseASceneToList")}</p>}</Panel>
              </div>
              <div className="grid-2">
                <Panel title={t("devices.audio")} subtitle={t("devices.obsDoesNotReportCurrent")}>
                  <table className="table table-compact">
                    <tbody>
                      {s.inputs.map((i) => (
                        <AudioRow key={i.name} input={i} />
                      ))}
                    </tbody>
                  </table>
                </Panel>
                <Panel title={t("devices.screenshot")}>
                  <div className="row-end">
                    <Field label={t("devices.sourceOrScene")}>
                      <input list="obs-shot-sources" value={shotSource} onChange={(e) => setShotSource(e.target.value)} />
                      <datalist id="obs-shot-sources">
                        {[...s.scenes, ...s.inputs.map((i) => i.name)].map((n) => (
                          <option key={n} value={n} />
                        ))}
                      </datalist>
                    </Field>
                    <ActionButton action={() => api.post<{ image: string }>("/api/v1/obs/screenshot", { source: shotSource, width: 640 })} onDone={(r) => setShot(r.image)} disabledReason={shotSource ? null : t("devices.chooseASource")}>{t("devices.capture")}</ActionButton>
                  </div>
                  {shot ? <img src={shot} alt={t("devices.obsScreenshotOfShotsource", { shotSource })} style={{ width: "100%", marginTop: 8, borderRadius: 6 }} /> : null}
                </Panel>
              </div>
            </>
          ) : null}
        </div>
      )}
    </Async>
  );
}

function defaultsFromSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const props = (schema.properties ?? {}) as Record<string, { default?: unknown; enum?: unknown[] }>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(props)) out[k] = v.default ?? (v.enum ? v.enum[0] : null);
  return out;
}

function ActionRow({ a }: { a: DeviceActionInfo }) {
  const [params, setParams] = useState(() => JSON.stringify(defaultsFromSchema(a.params)));
  const hasParams = Object.keys((a.params.properties ?? {}) as object).length > 0;
  const parsed = parseJsonOr<Record<string, unknown>>(params, {});
  const curl = `curl -X POST -H "Authorization: Bearer <token>" -H "Content-Type: application/json" -d '${hasParams ? params : "{}"}' ${engineOrigin()}/api/v1/devices/actions/${a.id}`;
  return (
    <tr>
      <td>
        {a.label}
        <div className="small muted">
          <span className="mono">{a.id}</span> · {a.permission}
          {a.allowed ? null : <span className="text-warn">{t("devices.notAllowedForYourRole")}</span>}
        </div>
      </td>
      <td>{hasParams ? <input className="mono" aria-label={t("devices.parametersForId", { id: a.id })} value={params} onChange={(e) => setParams(e.target.value)} style={{ width: 220 }} aria-invalid={!parsed.ok} /> : <span className="muted small">—</span>}</td>
      <td>
        <div className="cell-actions">
          <ActionButton
            size="sm"
            variant={a.id === "emergency_stop" ? "danger" : "secondary"}
            action={() => {
              if (!parsed.ok) throw new Error(t("common.invalidJson", { error: parsed.error }));
              return api.post<{ action: string; result: unknown }>(`/api/v1/devices/actions/${a.id}`, hasParams ? parsed.value : {});
            }}
            success={(r) => t("devices.deviceActionActionExecuted", { action: r.action })}
            disabledReason={a.allowed ? null : t("devices.yourRoleLacksPermission", { permission: a.permission })}
           
            confirm={{ title: t("devices.runLabelNow", { label: a.label }), body: t("devices.thisIsARealControl") }}
          >{t("devices.run")}</ActionButton>
          <CopyButton text={curl} label={t("devices.copyCurl")} />
        </div>
      </td>
    </tr>
  );
}

function TallyView({ t: tRow }: { t: DeviceTally }) {
  return (
    <>
      <ul className="gc-facts">
        <li>
          <span className="muted">{t("devices.source")}</span> {tRow.simulated ? t("common.simulation") : t("devices.live")}
        </li>
        <li>
          <span className="muted">{t("devices.telemetry")}</span> <span className={tRow.telemetry === "stale" ? "text-danger" : undefined}>{tRow.telemetry}</span>
        </li>
        <li>
          <span className="muted">{t("devices.camera")}</span> <span className={tRow.control.emergencyStopped ? "text-danger" : undefined}>{tRow.control.emergencyStopped ? t("devices.emergencyStop") : tRow.control.automationActive ? t("devices.automation") : t("devices.manual")}</span>
        </li>
        <li>
          <span className="muted">{t("devices.director")}</span> {MODE_INFO[tRow.director.mode]?.label ?? tRow.director.mode}
          {tRow.director.hold ? t("devices.hold") : ""}
        </li>
        <li>
          <span className="muted">{t("devices.program")}</span> {tRow.program.mode}
        </li>
        <li>
          <span className="muted">OBS</span> {tRow.obs.connected ? t("devices.connected") : t("devices.off")}
        </li>
      </ul>
      {tRow.slots.length ? (
        <div className="row" style={{ marginTop: 10 }}>
          {tRow.slots.map((s) => (
            <span key={s.steamId} className={`badge ${s.onAir ? "tone-ok" : s.alive ? "" : "tone-danger"}`} title={`${s.side ?? "?"} · ${s.alive ? "alive" : "dead"}`}>
              {s.slot ?? "·"} {s.name} {s.onAir ? t("devices.onAir") : s.alive ? "" : "✕"}
            </span>
          ))}
        </div>
      ) : (
        <p className="muted small">{t("devices.noObserverSlotsNoTelemetry")}</p>
      )}
    </>
  );
}

function ControlSurfacesTab() {
  const actions = useApi<DeviceActionInfo[]>("/api/v1/devices/actions");
  const snap = useSnapshot();
  const tally = useApi<DeviceTally>(snap?.tally ? null : "/api/v1/devices/tally", { refreshMs: 2000 });
  const tRow = snap?.tally ?? tally.data;
  return (
    <div className="stack">
      <Panel title={t("devices.deviceActions")} subtitle={t("devices.whatAStreamDeckOr")}>
        <Async state={actions}>
          {(list) => (
            <table className="table table-compact">
              <thead>
                <tr>
                  <th>{t("devices.action")}</th>
                  <th>{t("devices.parametersJson")}</th>
                  <th aria-label={t("devices.run")} />
                </tr>
              </thead>
              <tbody>
                {list.map((a) => (
                  <ActionRow key={a.id} a={a} />
                ))}
              </tbody>
            </table>
          )}
        </Async>
        <Details summary={t("devices.howToConnectCompanionOr")}>
          <p className="small muted"><T k="devices.controlSurfacesUseTheSame" values={{ code: <code>POST {engineOrigin()}/api/v1/devices/actions/&lt;action&gt;</code> }} tags={{ code: (c) => <code>{c}</code>, em: (c) => <em>{c}</em> }} /></p>
        </Details>
      </Panel>
      <Panel title={t("devices.tally")} subtitle={t("devices.whatAControlSurfaceSees")}>
        {tRow ? <TallyView t={tRow} /> : <Async state={tally}>{(x) => <TallyView t={x} />}</Async>}
      </Panel>
    </div>
  );
}

function TokensTab() {
  const reason = usePermission("settings.manage");
  const tokens = useApi<{ roles: string[]; tokens: TokenInfo[] }>(reason ? null : "/api/v1/tokens");
  const matches = useApi<MatchRow[]>("/api/v1/matches");
  const [role, setRole] = useState("observer");
  const [label, setLabel] = useState("");
  const [ttl, setTtl] = useState("");
  const [matchId, setMatchId] = useState("");
  const [teamId, setTeamId] = useState("");
  const [issued, setIssued] = useState<{ id: string; token: string; role: string } | null>(null);
  if (reason) return <Note tone="warn">{t("devices.reasonTokenManagementRequiresThe", { reason })}</Note>;
  const m = matches.data?.find((x) => x.id === matchId);
  return (
    <div className="grid-1-2">
      <Panel title={t("devices.issueAToken")}>
        <div className="form-grid">
          <Field label={t("devices.role")} hint={ROLE_DESCRIPTIONS[role]}>
            <select value={role} onChange={(e) => setRole(e.target.value)}>
              {(tokens.data?.roles ?? Object.keys(ROLE_DESCRIPTIONS)).map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t("devices.label")}>
            <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder={t("devices.streamDeckObserverDesk")} />
          </Field>
          <Field label={t("devices.expiresAfterHours")} hint={t("devices.leaveEmptyForNoExpiry")}>
            <input type="number" min={1} max={720} value={ttl} onChange={(e) => setTtl(e.target.value)} />
          </Field>
          {role === "captain" ? (
            <>
              <Field label={t("devices.match")}>
                <select value={matchId} onChange={(e) => setMatchId(e.target.value)}>
                  <option value="">{t("devices.choose")}</option>
                  {(matches.data ?? []).map((x) => (
                    <option key={x.id} value={x.id}>
                      {x.title ?? x.id}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label={t("devices.team")}>
                <select value={teamId} onChange={(e) => setTeamId(e.target.value)} disabled={!m}>
                  <option value="">{t("devices.choose")}</option>
                  {m ? (
                    <>
                      <option value={m.teamAId}>{t("devices.teamATeamaid", { teamAId: m.teamAId })}</option>
                      <option value={m.teamBId}>{t("devices.teamBTeambid", { teamBId: m.teamBId })}</option>
                    </>
                  ) : null}
                </select>
              </Field>
            </>
          ) : null}
        </div>
        <div className="form-actions">
          <ActionButton
            variant="primary"
            action={() => api.post<{ id: string; token: string }>("/api/v1/tokens", { role, label: label.trim(), ...(ttl ? { ttlHours: Number(ttl) } : {}), ...(role === "captain" ? { matchId, teamId } : {}) })}
            success={t("devices.tokenIssuedCopyItNow")}
            onDone={(tRow) => {
              setIssued({ ...tRow, role });
              setLabel("");
              void tokens.reload();
            }}
            disabledReason={!label.trim() ? t("devices.enterALabel") : role === "captain" && (!matchId || !teamId) ? t("devices.captainTokensNeedAMatch") : null}
          >{t("devices.issueToken")}</ActionButton>
        </div>
        {issued ? (
          <Note tone="warn" title={t("devices.shownOnce")}>
            <div className="url-box">
              <input readOnly className="mono" value={issued.token} aria-label={t("devices.newToken")} onFocus={(e) => e.target.select()} />
              <CopyButton text={issued.token} />
            </div>
            {issued.role === "captain" ? (
              <div className="small"><T k="devices.captainLinkCode" values={{ code: <code>{`${engineOrigin()}/captain?match=${matchId}&token=${issued.token}`}</code> }} /></div>
            ) : (
              <div className="small"><T k="devices.useAsCodeOnlyA" values={{ code: <code>Authorization: Bearer {issued.token.slice(0, 6)}…</code> }} /></div>
            )}
          </Note>
        ) : null}
      </Panel>
      <Panel title={t("devices.issuedTokens")}>
        <Async state={tokens}>
          {(d) =>
            d.tokens.length === 0 ? (
              <EmptyState title={t("devices.noIssuedTokens")}>{t("devices.onlyTheLocalOperatorToken")}</EmptyState>
            ) : (
              <table className="table table-compact">
                <thead>
                  <tr>
                    <th>{t("devices.label")}</th>
                    <th>{t("devices.role")}</th>
                    <th>{t("devices.scope")}</th>
                    <th>{t("devices.created")}</th>
                    <th>{t("devices.expires")}</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {d.tokens.map((tRow) => {
                    const expired = tRow.expiresAt ? Date.parse(tRow.expiresAt) < Date.now() : false;
                    return (
                      <tr key={tRow.id}>
                        <td title={t("devices.tokenIdId", { id: tRow.id })}>{tRow.label}</td>
                        <td>{tRow.role}</td>
                        <td className="small">{tRow.scope ? Object.entries(tRow.scope).map(([k, v]) => `${k}=${v}`).join(", ") : "—"}</td>
                        <td className="small">{fmtTime(tRow.createdAt)}</td>
                        <td className="small">{tRow.expiresAt ? <>{fmtTime(tRow.expiresAt)} {expired ? <span className="text-warn">{t("devices.expired")}</span> : null}</> : t("devices.never")}</td>
                        <td>
                          <ActionButton size="sm" variant="ghost" action={() => api.del(`/api/v1/tokens/${seg(tRow.id)}`)} success={t("devices.tokenLabelRevoked", { label: tRow.label })} onDone={() => void tokens.reload()} confirm={{ title: t("devices.revokeLabel", { label: tRow.label }), body: t("devices.devicesUsingItLoseAccess"), danger: true, confirmLabel: t("devices.revoke") }}>{t("devices.revoke")}</ActionButton>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )
          }
        </Async>
      </Panel>
    </div>
  );
}

function IntegrationsTab() {
  const adapter = useApi<ObserverAdapterResponse>("/api/v1/observer/adapter", { refreshMs: 5000 });
  const games = useApi<GamesResponse>("/api/v1/games");
  const bridge = useApi<MatchFrameBridgeStatus>("/api/v1/integrations/matchframe");
  const matches = useApi<MatchRow[]>("/api/v1/matches");
  const settingsReason = usePermission("settings.manage");
  const writeReason = usePermission("metadata.write");
  const [cfg, setCfg] = useState<{ enabled: boolean; url: string; autoPushResults: boolean; token: string }>({ enabled: false, url: "", autoPushResults: false, token: "" });
  const [pushMatch, setPushMatch] = useState("");
  useEffect(() => {
    if (bridge.data) setCfg((c) => ({ ...c, enabled: bridge.data!.config.enabled, url: bridge.data!.config.url ?? "", autoPushResults: bridge.data!.config.autoPushResults }));
  }, [bridge.data]);
  return (
    <div className="stack">
      <div className="grid-2">
        <Panel title={t("devices.observerAdapter")} actions={<Link to="/settings/setup#step-adapter">{t("devices.configureInSetup")}</Link>}>
          <Async state={adapter}>
            {(a) => (
              <>
                <KV
                  items={[
                    [t("devices.configured"), a.settings.kind],
                    [t("devices.activeAdapter"), a.active ?? t("common.none")],
                  ]}
                />
                {a.capabilities ? (
                  <Details summary={t("devices.capabilitiesCount", { count: Object.keys(a.capabilities).length })}>
                    <table className="table table-compact">
                      <tbody>
                        {Object.entries(a.capabilities).map(([k, c]) => (
                          <tr key={k}>
                            <td className="small" title={k}>
                              {capabilityMeta(k).label}
                            </td>
                            <td>
                              <SupportBadge support={c.support} />
                            </td>
                            <td className="small muted">{c.limitations.join("; ")}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </Details>
                ) : null}
              </>
            )}
          </Async>
        </Panel>
        <Panel title={t("devices.games")}>
          <Async state={games}>
            {(g) => (
              <KV
                items={[
                  [t("devices.supported"), g.supported.map((x) => `${x.displayName} (${x.status})`).join(", ") || t("common.none")],
                  [t("devices.plannedNotSupported"), <span key="p" className="muted">{g.expansion.map((x) => x.displayName).join(", ") || t("devices.none")}</span>],
                ]}
              />
            )}
          </Async>
        </Panel>
      </div>
      <Panel title={t("devices.matchframeBridge")} subtitle={t("devices.optionalPushOfMatchResults")} actions={bridge.data ? <Badge tone={bridge.data.status === "connected" ? "ok" : bridge.data.status === "disabled" ? "neutral" : "warn"}>{bridge.data.status}</Badge> : null}>
        <Async state={bridge}>
          {(b) => (
            <>
              <div className="form-grid">
                <Field label={t("devices.bridgeUrl")}>
                  <input value={cfg.url} onChange={(e) => setCfg({ ...cfg, url: e.target.value })} placeholder="https://…" />
                </Field>
                <Field label={t("devices.token")} hint={t("devices.storedInTheSecretStore")}>
                  <input type="password" autoComplete="off" value={cfg.token} onChange={(e) => setCfg({ ...cfg, token: e.target.value })} />
                </Field>
              </div>
              <div className="form-actions">
                <Checkbox checked={cfg.enabled} onChange={(v) => setCfg({ ...cfg, enabled: v })} label={t("devices.enabled")} />
                <Checkbox checked={cfg.autoPushResults} onChange={(v) => setCfg({ ...cfg, autoPushResults: v })} label={t("devices.pushResultsAutomatically")} />
                <ActionButton
                  variant="primary"
                  action={() => api.put("/api/v1/integrations/matchframe", { enabled: cfg.enabled, url: cfg.url || null, autoPushResults: cfg.autoPushResults, ...(cfg.token ? { token: cfg.token } : {}) })}
                  success={t("devices.bridgeSettingsSaved")}
                  onDone={() => void bridge.reload()}
                  disabledReason={settingsReason ?? (cfg.url && !/^https?:\/\//.test(cfg.url) ? t("devices.urlMustStartWithHttp") : null)}
                >{t("devices.save")}</ActionButton>
                <ActionButton variant="ghost" action={() => api.post<{ lastError: string | null }>("/api/v1/integrations/matchframe/discover")} success={(r) => (r.lastError ? t("devices.discoveryFailedLasterror", { lastError: r.lastError }) : t("devices.bridgeCapabilitiesDiscovered"))} onDone={() => void bridge.reload()} disabledReason={settingsReason ?? (b.config.enabled && b.config.url ? null : t("devices.enableTheBridgeAndSet"))}>{t("devices.discover")}</ActionButton>
              </div>
              <div className="row-end gc-section">
                <Field label={t("devices.pushAMatchResult")}>
                  <select value={pushMatch} onChange={(e) => setPushMatch(e.target.value)}>
                    <option value="">{t("devices.choose")}</option>
                    {(matches.data ?? []).map((x) => (
                      <option key={x.id} value={x.id}>
                        {x.title ?? x.id}
                      </option>
                    ))}
                  </select>
                </Field>
                <ActionButton action={() => api.post<{ ok: boolean; lastError: string | null }>("/api/v1/integrations/matchframe/push-result", { matchId: pushMatch })} success={(r) => (r.ok ? t("devices.resultPushed") : t("devices.pushFailedV", { v: r.lastError ?? "?" }))} disabledReason={writeReason ?? (!b.config.enabled ? t("devices.bridgeDisabled") : pushMatch ? null : t("devices.chooseAMatch"))}>{t("devices.pushResult")}</ActionButton>
              </div>
              {b.lastError ? <p className="small text-danger">{t("devices.lastErrorLasterror", { lastError: b.lastError })}</p> : null}
              <Details summary={t("devices.aboutTheBridge")}>
                <p className="small muted">{b.note}</p>
              </Details>
            </>
          )}
        </Async>
      </Panel>
    </div>
  );
}

export function DevicesScreen() {
  const [tab, setTab] = usePersistentState<"obs" | "surfaces" | "tokens" | "integrations">("devicesTab", "obs");
  return (
    <div className="page">
      <div className="page-head">
        <h1 className="page-title">{t("devices.devicesIntegrations")}</h1>
      </div>
      <Tabs
        label={t("devices.deviceSections")}
        value={tab}
        onChange={setTab}
        tabs={[
          { id: "obs", label: "OBS" },
          { id: "surfaces", label: t("devices.controlSurfaces") },
          { id: "tokens", label: t("devices.tokens") },
          { id: "integrations", label: t("devices.adaptersIntegrations") },
        ]}
      />
      {tab === "obs" ? <ObsTab /> : null}
      {tab === "surfaces" ? <ControlSurfacesTab /> : null}
      {tab === "tokens" ? <TokensTab /> : null}
      {tab === "integrations" ? <IntegrationsTab /> : null}
    </div>
  );
}
