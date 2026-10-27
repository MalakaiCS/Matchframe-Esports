import { useEffect, useState } from "react";
import { api, seg } from "../api/index.ts";
import type { DeviceActionInfo, DeviceTally, GamesResponse, MatchframeBridgeStatus, MatchRow, ObserverAdapterResponse, ObsSceneItem, ObsState, TokenInfo } from "../api/types.ts";
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
import "../styles/group-c.css";

function onOff(v: boolean | null): string {
  return v === null ? "unknown" : v ? "on" : "off";
}

function SceneItems({ scene }: { scene: string }) {
  const reason = usePermission("program.control");
  const items = useApi<ObsSceneItem[]>(`/api/v1/obs/scenes/${seg(scene)}/items`);
  return (
    <Async state={items}>
      {(list) =>
        list.length === 0 ? (
          <p className="muted small">No sources in this scene.</p>
        ) : (
          <ul className="list-plain small">
            {list.map((it) => {
              const enabled = it.enabled ?? it.sceneItemEnabled ?? false;
              return (
                <li key={it.sceneItemId} className="row">
                  <span style={{ flex: 1 }} className={enabled ? undefined : "muted"}>
                    {it.sourceName} <span className="muted">{it.inputKind ?? ""}</span>
                  </span>
                  {enabled ? null : <span className="muted">Hidden</span>}
                  <ActionButton size="sm" variant="ghost" action={() => api.post<{ confirmed: boolean }>("/api/v1/obs/source-visibility", { scene, source: it.sourceName, visible: !enabled })} success={(r) => `${it.sourceName} ${enabled ? "hidden" : "shown"}${r.confirmed ? "" : " (not confirmed)"}`} onDone={() => void items.reload()} disabledReason={reason}>
                    {enabled ? "Hide" : "Show"}
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
          <ActionButton size="sm" variant="ghost" action={() => api.post("/api/v1/obs/audio", { input: input.name, muted: true })} success={`${input.name} muted`} disabledReason={reason}>
            Mute
          </ActionButton>
          <ActionButton size="sm" variant="ghost" action={() => api.post("/api/v1/obs/audio", { input: input.name, muted: false })} success={`${input.name} unmuted`} disabledReason={reason}>
            Unmute
          </ActionButton>
        </div>
      </td>
      <td>
        <div className="row">
          <input type="range" min={-60} max={6} step={1} value={db} aria-label={`${input.name} volume (dB)`} onChange={(e) => setDb(Number(e.target.value))} />
          <span className="mono small" style={{ width: 52 }}>
            {db} dB
          </span>
          <ActionButton size="sm" action={() => api.post<{ volume?: { confirmed: boolean; db: number } }>("/api/v1/obs/audio", { input: input.name, volumeDb: db })} success={(r) => `${input.name} → ${r.volume?.db ?? db} dB${r.volume?.confirmed === false ? " (not confirmed)" : ""}`} disabledReason={reason}>
            Set
          </ActionButton>
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
        <Field label="obs-websocket URL" hint="OBS → Tools → WebSocket Server Settings (v5)">
          <input value={url} onChange={(e) => setUrl(e.target.value)} />
        </Field>
        <Field label="Password">
          <input type="password" autoComplete="off" value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
      </div>
      <div className="row">
        <Checkbox checked={remember} onChange={setRemember} label="Remember" />
        <ActionButton
          variant={primary ? "primary" : "secondary"}
          action={() => api.post<{ state: ObsState }>("/api/v1/obs/connect", { url, ...(password ? { password } : {}), remember })}
          success={(r) => (r.state.connected ? `Connected to OBS ${r.state.obsVersion ?? ""}` : `Not connected: ${r.state.lastError ?? "unknown error"}`)}
          onDone={onDone}
          disabledReason={reason ?? (/^wss?:\/\//.test(url) ? null : "URL must start with ws:// or wss://")}
        >
          Connect
        </ActionButton>
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
              title="OBS connection"
              actions={s.connected ? <Badge tone="ok">Connected</Badge> : s.connecting ? <Badge tone="info">Connecting</Badge> : <Badge tone="warn">Disconnected</Badge>}
            >
              {s.connected ? (
                <>
                  <KV
                    items={[
                      ["Program / preview", `${s.programScene ?? MISSING} / ${s.previewScene ?? MISSING}`],
                      ["Studio mode", onOff(s.studioMode)],
                    ]}
                  />
                  {s.inputKinds.includes("browser_source") ? null : <p className="small text-warn">The obs-browser plugin is missing, so HUD browser sources cannot be added.</p>}
                  <div className="form-actions">
                    <ActionButton size="sm" action={() => api.post("/api/v1/obs/refresh")} success="OBS state refreshed" onDone={() => void obs.reload()} disabledReason={reason}>
                      Refresh
                    </ActionButton>
                    <ActionButton size="sm" variant="ghost" action={() => api.post("/api/v1/obs/disconnect")} success="OBS disconnected" onDone={() => void obs.reload()} disabledReason={reason} confirm={{ title: "Disconnect OBS?", body: "Program mode becomes degraded until OBS is reconnected and an operator recovers it." }}>
                      Disconnect
                    </ActionButton>
                  </div>
                </>
              ) : (
                <>
                  {s.lastError ? <p className="small text-danger">Last error: {s.lastError}</p> : null}
                  {profiles[0] ? (
                    <>
                      <ActionButton variant="primary" action={() => api.post<{ state: ObsState }>("/api/v1/obs/connect", { url: profiles[0]!.url, name: profiles[0]!.name })} success={(r) => (r.state.connected ? "Connected to OBS" : `Not connected: ${r.state.lastError ?? "?"}`)} onDone={() => void obs.reload()} disabledReason={reason}>
                        Reconnect saved profile
                      </ActionButton>
                      <Details summary="Connect to a different OBS">
                        <ObsConnectForm onDone={() => void obs.reload()} defaultUrl={profiles[0]?.url} primary={false} />
                      </Details>
                    </>
                  ) : (
                    <ObsConnectForm onDone={() => void obs.reload()} />
                  )}
                </>
              )}
              <Details summary="Connection details">
                <KV
                  items={[
                    ["Profile", profiles[0] ? `${profiles[0].name} · ${profiles[0].url}${profiles[0].hasPassword ? " (password stored)" : ""}` : "none saved"],
                    ["OBS / websocket", `${s.obsVersion ?? MISSING} / ${s.websocketVersion ?? MISSING}${s.platform ? ` · ${s.platform}` : ""}`],
                    ["Studio mode", onOff(s.studioMode)],
                    ["Program / preview", `${s.programScene ?? MISSING} / ${s.previewScene ?? MISSING}`],
                    ["Browser source plugin", s.inputKinds.includes("browser_source") ? "available" : s.connected ? "missing (obs-browser not installed)" : MISSING],
                    ["Last error", s.lastError ?? "none"],
                    ["Reconnect attempts", s.reconnectAttempt],
                  ]}
                />
              </Details>
            </Panel>
            <Panel title="Outputs">
              {!s.connected ? (
                <EmptyState title="OBS not connected">Connect OBS to control recording, streaming and the replay buffer.</EmptyState>
              ) : (
                <table className="table table-compact">
                  <tbody>
                    {(
                      [
                        ["record", "Recording", s.recording],
                        ["stream", "Streaming", s.streaming],
                        ["replay", "Replay buffer", s.replayBuffer],
                      ] as const
                    ).map(([kind, label, on]) => (
                      <tr key={kind}>
                        <td>{label}</td>
                        <td>{on ? <Badge tone={kind === "stream" ? "danger" : "ok"} icon="●">On</Badge> : <span className="muted">{on === null ? "Unknown" : "Off"}</span>}</td>
                        <td>
                          <ActionButton
                            size="sm"
                            variant={on ? "warn" : "secondary"}
                            action={() => api.post("/api/v1/obs/output", { kind, active: !on })}
                            success={`${label} ${on ? "stopped" : "started"}`}
                            onDone={() => void obs.reload()}
                            disabledReason={reason}
                           
                            confirm={kind === "stream" ? { title: on ? "Stop the stream?" : "Start streaming?", body: on ? "Viewers will lose the broadcast." : "OBS starts streaming to its configured service.", danger: !!on } : undefined}
                          >
                            {on ? "Stop" : "Start"}
                          </ActionButton>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              <div className="form-actions">
                <ActionButton size="sm" title="Adds the main HUD as a browser source in the scene “Matchframe Live”" action={() => api.post("/api/v1/obs/provision", {})} success="HUD browser source provisioned (scene “Matchframe Live”)" disabledReason={reason ?? (s.connected ? null : "Connect OBS first")}>
                  Add HUD browser source
                </ActionButton>
              </div>
            </Panel>
          </div>
          {s.connected ? (
            <>
              <div className="grid-2">
                <Panel title={`Scenes (${s.scenes.length})`}>
                  <table className="table table-compact">
                    <tbody>
                      {s.scenes.map((sc) => (
                        <tr key={sc} className={sc === scene ? "is-selected" : ""}>
                          <td>
                            <button className="link-btn" onClick={() => setScene(sc === scene ? null : sc)}>
                              {sc}
                            </button>{" "}
                            {sc === s.programScene ? <Badge tone="danger">Program</Badge> : null} {sc === s.previewScene ? <Badge tone="ok">Preview</Badge> : null}
                          </td>
                          <td>
                            <div className="cell-actions">
                              <ActionButton size="sm" variant="ghost" action={() => api.post<{ confirmed: boolean }>("/api/v1/obs/preview", { scene: sc })} success={(r) => `Preview: ${sc}${r.confirmed ? "" : " (not confirmed)"}`} onDone={() => void obs.reload()} disabledReason={reason ?? (s.studioMode ? null : "Studio mode is off in OBS")}>
                                Preview
                              </ActionButton>
                              <ActionButton size="sm" action={() => api.post<{ confirmed: boolean }>("/api/v1/obs/program", { scene: sc })} success={(r) => `Program: ${sc}${r.confirmed ? "" : " (not confirmed)"}`} onDone={() => void obs.reload()} disabledReason={reason} confirm={{ title: `Put “${sc}” on program?`, body: "Bypasses the program state machine (use Studio & Rundown for mode changes)." }}>
                                Program
                              </ActionButton>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </Panel>
                <Panel title={scene ? `Sources in “${scene}”` : "Scene sources"}>{scene ? <SceneItems key={scene} scene={scene} /> : <p className="muted small">Choose a scene to list and toggle its sources.</p>}</Panel>
              </div>
              <div className="grid-2">
                <Panel title="Audio" subtitle="OBS does not report current mute or volume here; each change is confirmed by read-back.">
                  <table className="table table-compact">
                    <tbody>
                      {s.inputs.map((i) => (
                        <AudioRow key={i.name} input={i} />
                      ))}
                    </tbody>
                  </table>
                </Panel>
                <Panel title="Screenshot">
                  <div className="row-end">
                    <Field label="Source or scene">
                      <input list="obs-shot-sources" value={shotSource} onChange={(e) => setShotSource(e.target.value)} />
                      <datalist id="obs-shot-sources">
                        {[...s.scenes, ...s.inputs.map((i) => i.name)].map((n) => (
                          <option key={n} value={n} />
                        ))}
                      </datalist>
                    </Field>
                    <ActionButton action={() => api.post<{ image: string }>("/api/v1/obs/screenshot", { source: shotSource, width: 640 })} onDone={(r) => setShot(r.image)} disabledReason={shotSource ? null : "Choose a source"}>
                      Capture
                    </ActionButton>
                  </div>
                  {shot ? <img src={shot} alt={`OBS screenshot of ${shotSource}`} style={{ width: "100%", marginTop: 8, borderRadius: 6 }} /> : null}
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
          {a.allowed ? null : <span className="text-warn"> · not allowed for your role</span>}
        </div>
      </td>
      <td>{hasParams ? <input className="mono" aria-label={`Parameters for ${a.id}`} value={params} onChange={(e) => setParams(e.target.value)} style={{ width: 220 }} aria-invalid={!parsed.ok} /> : <span className="muted small">—</span>}</td>
      <td>
        <div className="cell-actions">
          <ActionButton
            size="sm"
            variant={a.id === "emergency_stop" ? "danger" : "secondary"}
            action={() => {
              if (!parsed.ok) throw new Error(`Invalid JSON: ${parsed.error}`);
              return api.post<{ action: string; result: unknown }>(`/api/v1/devices/actions/${a.id}`, hasParams ? parsed.value : {});
            }}
            success={(r) => `Device action ${r.action} executed`}
            disabledReason={a.allowed ? null : `Your role lacks ${a.permission}`}
           
            confirm={{ title: `Run “${a.label}” now?`, body: "This is a real control action, exactly as a Stream Deck/Companion button would trigger it." }}
          >
            Run
          </ActionButton>
          <CopyButton text={curl} label="Copy curl" />
        </div>
      </td>
    </tr>
  );
}

function TallyView({ t }: { t: DeviceTally }) {
  return (
    <>
      <ul className="gc-facts">
        <li>
          <span className="muted">Source</span> {t.simulated ? "Simulation" : "Live"}
        </li>
        <li>
          <span className="muted">Telemetry</span> <span className={t.telemetry === "stale" ? "text-danger" : undefined}>{t.telemetry}</span>
        </li>
        <li>
          <span className="muted">Camera</span> <span className={t.control.emergencyStopped ? "text-danger" : undefined}>{t.control.emergencyStopped ? "Emergency stop" : t.control.automationActive ? "Automation" : "Manual"}</span>
        </li>
        <li>
          <span className="muted">Director</span> {MODE_INFO[t.director.mode]?.label ?? t.director.mode}
          {t.director.hold ? " · hold" : ""}
        </li>
        <li>
          <span className="muted">Program</span> {t.program.mode}
        </li>
        <li>
          <span className="muted">OBS</span> {t.obs.connected ? "Connected" : "Off"}
        </li>
      </ul>
      {t.slots.length ? (
        <div className="row" style={{ marginTop: 10 }}>
          {t.slots.map((s) => (
            <span key={s.steamId} className={`badge ${s.onAir ? "tone-ok" : s.alive ? "" : "tone-danger"}`} title={`${s.side ?? "?"} · ${s.alive ? "alive" : "dead"}`}>
              {s.slot ?? "·"} {s.name} {s.onAir ? "● on air" : s.alive ? "" : "✕"}
            </span>
          ))}
        </div>
      ) : (
        <p className="muted small">No observer slots (no telemetry).</p>
      )}
    </>
  );
}

function ControlSurfacesTab() {
  const actions = useApi<DeviceActionInfo[]>("/api/v1/devices/actions");
  const snap = useSnapshot();
  const tally = useApi<DeviceTally>(snap?.tally ? null : "/api/v1/devices/tally", { refreshMs: 2000 });
  const t = snap?.tally ?? tally.data;
  return (
    <div className="stack">
      <Panel title="Device actions" subtitle="What a Stream Deck or Companion button can trigger. Issue a token for each device in the Tokens tab.">
        <Async state={actions}>
          {(list) => (
            <table className="table table-compact">
              <thead>
                <tr>
                  <th>Action</th>
                  <th>Parameters (JSON)</th>
                  <th aria-label="Run" />
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
        <Details summary="How to connect Companion or Stream Deck">
          <p className="small muted">
            Control surfaces use the same local HTTP API as this console: <code>POST {engineOrigin()}/api/v1/devices/actions/&lt;action&gt;</code> with <code>Authorization: Bearer &lt;token&gt;</code> and a JSON body. In Bitfocus Companion use the Generic HTTP module (POST, JSON body, custom header). Poll <code>GET /api/v1/devices/tally</code> for button feedback. Every action goes through the same control/program arbiters as the console and is audited. Issue a role-scoped token in the Tokens tab (e.g. role <em>observer</em> for camera buttons) — never share the operator token.
          </p>
        </Details>
      </Panel>
      <Panel title="Tally" subtitle="What a control surface sees for button feedback">
        {t ? <TallyView t={t} /> : <Async state={tally}>{(x) => <TallyView t={x} />}</Async>}
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
  if (reason) return <Note tone="warn">{reason}. Token management requires the owner role.</Note>;
  const m = matches.data?.find((x) => x.id === matchId);
  return (
    <div className="grid-1-2">
      <Panel title="Issue a token">
        <div className="form-grid">
          <Field label="Role" hint={ROLE_DESCRIPTIONS[role]}>
            <select value={role} onChange={(e) => setRole(e.target.value)}>
              {(tokens.data?.roles ?? Object.keys(ROLE_DESCRIPTIONS)).map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Label">
            <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Stream Deck — observer desk" />
          </Field>
          <Field label="Expires after (hours)" hint="Leave empty for no expiry (captain links default to 6 h)">
            <input type="number" min={1} max={720} value={ttl} onChange={(e) => setTtl(e.target.value)} />
          </Field>
          {role === "captain" ? (
            <>
              <Field label="Match">
                <select value={matchId} onChange={(e) => setMatchId(e.target.value)}>
                  <option value="">Choose…</option>
                  {(matches.data ?? []).map((x) => (
                    <option key={x.id} value={x.id}>
                      {x.title ?? x.id}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Team">
                <select value={teamId} onChange={(e) => setTeamId(e.target.value)} disabled={!m}>
                  <option value="">Choose…</option>
                  {m ? (
                    <>
                      <option value={m.teamAId}>Team A ({m.teamAId})</option>
                      <option value={m.teamBId}>Team B ({m.teamBId})</option>
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
            success="Token issued — copy it now, it is shown only once"
            onDone={(t) => {
              setIssued({ ...t, role });
              setLabel("");
              void tokens.reload();
            }}
            disabledReason={!label.trim() ? "Enter a label" : role === "captain" && (!matchId || !teamId) ? "Captain tokens need a match and a team" : null}
          >
            Issue token
          </ActionButton>
        </div>
        {issued ? (
          <Note tone="warn" title="Shown once">
            <div className="url-box">
              <input readOnly className="mono" value={issued.token} aria-label="New token" onFocus={(e) => e.target.select()} />
              <CopyButton text={issued.token} />
            </div>
            {issued.role === "captain" ? (
              <div className="small">
                Captain link: <code>{`${engineOrigin()}/captain?match=${matchId}&token=${issued.token}`}</code>
              </div>
            ) : (
              <div className="small">Use as <code>Authorization: Bearer {issued.token.slice(0, 6)}…</code>. Only a hash is stored by the engine.</div>
            )}
          </Note>
        ) : null}
      </Panel>
      <Panel title="Issued tokens">
        <Async state={tokens}>
          {(d) =>
            d.tokens.length === 0 ? (
              <EmptyState title="No issued tokens">Only the local operator token exists. Issue a scoped token for each Companion, Stream Deck, remote producer or captain.</EmptyState>
            ) : (
              <table className="table table-compact">
                <thead>
                  <tr>
                    <th>Label</th>
                    <th>Role</th>
                    <th>Scope</th>
                    <th>Created</th>
                    <th>Expires</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {d.tokens.map((t) => {
                    const expired = t.expiresAt ? Date.parse(t.expiresAt) < Date.now() : false;
                    return (
                      <tr key={t.id}>
                        <td title={`Token id ${t.id}`}>{t.label}</td>
                        <td>{t.role}</td>
                        <td className="small">{t.scope ? Object.entries(t.scope).map(([k, v]) => `${k}=${v}`).join(", ") : "—"}</td>
                        <td className="small">{fmtTime(t.createdAt)}</td>
                        <td className="small">{t.expiresAt ? <>{fmtTime(t.expiresAt)} {expired ? <span className="text-warn">expired</span> : null}</> : "never"}</td>
                        <td>
                          <ActionButton size="sm" variant="ghost" action={() => api.del(`/api/v1/tokens/${seg(t.id)}`)} success={`Token “${t.label}” revoked`} onDone={() => void tokens.reload()} confirm={{ title: `Revoke “${t.label}”?`, body: "Devices using it lose access immediately.", danger: true, confirmLabel: "Revoke" }}>
                            Revoke
                          </ActionButton>
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
  const bridge = useApi<MatchframeBridgeStatus>("/api/v1/integrations/matchframe");
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
        <Panel title="Observer adapter" actions={<Link to="/setup#step-adapter">Configure in Setup</Link>}>
          <Async state={adapter}>
            {(a) => (
              <>
                <KV
                  items={[
                    ["Configured", a.settings.kind],
                    ["Active adapter", a.active ?? "none"],
                  ]}
                />
                {a.capabilities ? (
                  <Details summary={`Capabilities (${Object.keys(a.capabilities).length})`}>
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
        <Panel title="Games">
          <Async state={games}>
            {(g) => (
              <KV
                items={[
                  ["Supported", g.supported.map((x) => `${x.displayName} (${x.status})`).join(", ") || "none"],
                  ["Planned, not supported yet", <span key="p" className="muted">{g.expansion.map((x) => x.displayName).join(", ") || "none"}</span>],
                ]}
              />
            )}
          </Async>
        </Panel>
      </div>
      <Panel title="MatchFrame bridge" subtitle="Optional push of match results to the MatchFrame service" actions={bridge.data ? <Badge tone={bridge.data.status === "connected" ? "ok" : bridge.data.status === "disabled" ? "neutral" : "warn"}>{bridge.data.status}</Badge> : null}>
        <Async state={bridge}>
          {(b) => (
            <>
              <div className="form-grid">
                <Field label="Bridge URL">
                  <input value={cfg.url} onChange={(e) => setCfg({ ...cfg, url: e.target.value })} placeholder="https://…" />
                </Field>
                <Field label="Token" hint="Stored in the secret store. Leave empty to keep the stored token.">
                  <input type="password" autoComplete="off" value={cfg.token} onChange={(e) => setCfg({ ...cfg, token: e.target.value })} />
                </Field>
              </div>
              <div className="form-actions">
                <Checkbox checked={cfg.enabled} onChange={(v) => setCfg({ ...cfg, enabled: v })} label="Enabled" />
                <Checkbox checked={cfg.autoPushResults} onChange={(v) => setCfg({ ...cfg, autoPushResults: v })} label="Push results automatically" />
                <ActionButton
                  variant="primary"
                  action={() => api.put("/api/v1/integrations/matchframe", { enabled: cfg.enabled, url: cfg.url || null, autoPushResults: cfg.autoPushResults, ...(cfg.token ? { token: cfg.token } : {}) })}
                  success="Bridge settings saved"
                  onDone={() => void bridge.reload()}
                  disabledReason={settingsReason ?? (cfg.url && !/^https?:\/\//.test(cfg.url) ? "URL must start with http(s)://" : null)}
                >
                  Save
                </ActionButton>
                <ActionButton variant="ghost" action={() => api.post<{ lastError: string | null }>("/api/v1/integrations/matchframe/discover")} success={(r) => (r.lastError ? `Discovery failed: ${r.lastError}` : "Bridge capabilities discovered")} onDone={() => void bridge.reload()} disabledReason={settingsReason ?? (b.config.enabled && b.config.url ? null : "Enable the bridge and set its URL first")}>
                  Discover
                </ActionButton>
              </div>
              <div className="row-end gc-section">
                <Field label="Push a match result">
                  <select value={pushMatch} onChange={(e) => setPushMatch(e.target.value)}>
                    <option value="">Choose…</option>
                    {(matches.data ?? []).map((x) => (
                      <option key={x.id} value={x.id}>
                        {x.title ?? x.id}
                      </option>
                    ))}
                  </select>
                </Field>
                <ActionButton action={() => api.post<{ ok: boolean; lastError: string | null }>("/api/v1/integrations/matchframe/push-result", { matchId: pushMatch })} success={(r) => (r.ok ? "Result pushed" : `Push failed: ${r.lastError ?? "?"}`)} disabledReason={writeReason ?? (!b.config.enabled ? "Bridge disabled" : pushMatch ? null : "Choose a match")}>
                  Push result
                </ActionButton>
              </div>
              {b.lastError ? <p className="small text-danger">Last error: {b.lastError}</p> : null}
              <Details summary="About the bridge">
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
        <h1 className="page-title">Devices &amp; Integrations</h1>
      </div>
      <Tabs
        label="Device sections"
        value={tab}
        onChange={setTab}
        tabs={[
          { id: "obs", label: "OBS" },
          { id: "surfaces", label: "Control surfaces" },
          { id: "tokens", label: "Tokens" },
          { id: "integrations", label: "Adapters & integrations" },
        ]}
      />
      {tab === "obs" ? <ObsTab /> : null}
      {tab === "surfaces" ? <ControlSurfacesTab /> : null}
      {tab === "tokens" ? <TokensTab /> : null}
      {tab === "integrations" ? <IntegrationsTab /> : null}
    </div>
  );
}
