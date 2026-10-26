import { useEffect, useState } from "react";
import { api, seg } from "../api/index.ts";
import type { DeviceActionInfo, DeviceTally, GamesResponse, MatchframeBridgeStatus, MatchRow, ObserverAdapterResponse, ObsSceneItem, ObsState, TokenInfo } from "../api/types.ts";
import { ActionButton, Async, Badge, Checkbox, CopyButton, EmptyState, Field, KV, Note, Panel, parseJsonOr, SupportBadge, Tabs } from "../components/ui.tsx";
import { fmtTime, MISSING } from "../lib/format.ts";
import { useApi, usePersistentState } from "../lib/hooks.ts";
import { ROLE_DESCRIPTIONS } from "../lib/permissions.ts";
import { Link } from "../router.tsx";
import { useSnapshot } from "../state/live.ts";
import { usePermission } from "../state/session.tsx";

function onOff(v: boolean | null): string {
  return v === null ? "unknown" : v ? "ON" : "off";
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
                  <span style={{ flex: 1 }}>
                    {it.sourceName} <span className="muted">{it.inputKind ?? ""}</span>
                  </span>
                  {enabled ? <Badge tone="ok">VISIBLE</Badge> : <Badge>HIDDEN</Badge>}
                  <ActionButton size="sm" action={() => api.post<{ confirmed: boolean }>("/api/v1/obs/source-visibility", { scene, source: it.sourceName, visible: !enabled })} success={(r) => `${it.sourceName} ${enabled ? "hidden" : "shown"}${r.confirmed ? "" : " (not confirmed)"}`} onDone={() => void items.reload()} disabledReason={reason} reasonPlacement="tooltip">
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
          <ActionButton size="sm" action={() => api.post("/api/v1/obs/audio", { input: input.name, muted: true })} success={`${input.name} muted`} disabledReason={reason} reasonPlacement="tooltip">
            Mute
          </ActionButton>
          <ActionButton size="sm" action={() => api.post("/api/v1/obs/audio", { input: input.name, muted: false })} success={`${input.name} unmuted`} disabledReason={reason} reasonPlacement="tooltip">
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
          <ActionButton size="sm" action={() => api.post<{ volume?: { confirmed: boolean; db: number } }>("/api/v1/obs/audio", { input: input.name, volumeDb: db })} success={(r) => `${input.name} → ${r.volume?.db ?? db} dB${r.volume?.confirmed === false ? " (not confirmed)" : ""}`} disabledReason={reason} reasonPlacement="tooltip">
            Set
          </ActionButton>
        </div>
      </td>
    </tr>
  );
}

function ObsConnectForm({ onDone, defaultUrl }: { onDone: () => void; defaultUrl?: string | undefined }) {
  const reason = usePermission("program.control");
  const [url, setUrl] = useState(defaultUrl ?? "ws://127.0.0.1:4455");
  const [password, setPassword] = useState("");
  const [remember, setRemember] = useState(true);
  return (
    <div className="row-end" style={{ marginTop: 10 }}>
      <Field label="obs-websocket URL" hint="OBS → Tools → WebSocket Server Settings (v5)">
        <input value={url} onChange={(e) => setUrl(e.target.value)} style={{ width: 220 }} />
      </Field>
      <Field label="Password">
        <input type="password" autoComplete="off" value={password} onChange={(e) => setPassword(e.target.value)} style={{ width: 160 }} />
      </Field>
      <Checkbox checked={remember} onChange={setRemember} label="Remember" />
      <ActionButton
        variant="primary"
        action={() => api.post<{ state: ObsState }>("/api/v1/obs/connect", { url, ...(password ? { password } : {}), remember })}
        success={(r) => (r.state.connected ? `Connected to OBS ${r.state.obsVersion ?? ""}` : `Not connected: ${r.state.lastError ?? "unknown error"}`)}
        onDone={onDone}
        disabledReason={reason ?? (/^wss?:\/\//.test(url) ? null : "URL must start with ws:// or wss://")}
      >
        Connect
      </ActionButton>
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
              actions={s.connected ? <Badge tone="ok">CONNECTED</Badge> : s.connecting ? <Badge tone="info">CONNECTING</Badge> : <Badge tone="warn">DISCONNECTED</Badge>}
            >
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
              <div className="form-actions">
                {profiles[0] && !s.connected ? (
                  <ActionButton variant="primary" action={() => api.post<{ state: ObsState }>("/api/v1/obs/connect", { url: profiles[0]!.url, name: profiles[0]!.name })} success={(r) => (r.state.connected ? "Connected to OBS" : `Not connected: ${r.state.lastError ?? "?"}`)} onDone={() => void obs.reload()} disabledReason={reason}>
                    Reconnect saved profile
                  </ActionButton>
                ) : null}
                {s.connected ? (
                  <>
                    <ActionButton action={() => api.post("/api/v1/obs/refresh")} success="OBS state refreshed" onDone={() => void obs.reload()} disabledReason={reason}>
                      Refresh
                    </ActionButton>
                    <ActionButton action={() => api.post("/api/v1/obs/disconnect")} success="OBS disconnected" onDone={() => void obs.reload()} disabledReason={reason} confirm={{ title: "Disconnect OBS?", body: "Program mode becomes DEGRADED until OBS is reconnected and an operator recovers it." }}>
                      Disconnect
                    </ActionButton>
                  </>
                ) : null}
              </div>
              {!s.connected ? <ObsConnectForm onDone={() => void obs.reload()} defaultUrl={profiles[0]?.url} /> : null}
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
                        <td>{on ? <Badge tone={kind === "stream" ? "danger" : "ok"} icon="●">ON</Badge> : <Badge>{on === null ? "UNKNOWN" : "OFF"}</Badge>}</td>
                        <td>
                          <ActionButton
                            size="sm"
                            variant={on ? "warn" : "secondary"}
                            action={() => api.post("/api/v1/obs/output", { kind, active: !on })}
                            success={`${label} ${on ? "stopped" : "started"}`}
                            onDone={() => void obs.reload()}
                            disabledReason={reason}
                            reasonPlacement="tooltip"
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
                <ActionButton action={() => api.post("/api/v1/obs/provision", {})} success="HUD browser source provisioned (scene “Matchframe Live”)" disabledReason={reason ?? (s.connected ? null : "Connect OBS first")}>
                  Provision main HUD browser source
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
                            {sc === s.programScene ? <Badge tone="danger">PROGRAM</Badge> : null} {sc === s.previewScene ? <Badge tone="ok">PREVIEW</Badge> : null}
                          </td>
                          <td>
                            <div className="cell-actions">
                              <ActionButton size="sm" action={() => api.post<{ confirmed: boolean }>("/api/v1/obs/preview", { scene: sc })} success={(r) => `Preview: ${sc}${r.confirmed ? "" : " (not confirmed)"}`} onDone={() => void obs.reload()} disabledReason={reason ?? (s.studioMode ? null : "Studio mode is off in OBS")} reasonPlacement="tooltip">
                                Preview
                              </ActionButton>
                              <ActionButton size="sm" variant="primary" action={() => api.post<{ confirmed: boolean }>("/api/v1/obs/program", { scene: sc })} success={(r) => `Program: ${sc}${r.confirmed ? "" : " (not confirmed)"}`} onDone={() => void obs.reload()} disabledReason={reason} reasonPlacement="tooltip" confirm={{ title: `Put “${sc}” on program?`, body: "Bypasses the program state machine (use Studio & Rundown for mode changes)." }}>
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
                <Panel title="Audio">
                  <table className="table table-compact">
                    <tbody>
                      {s.inputs.map((i) => (
                        <AudioRow key={i.name} input={i} />
                      ))}
                    </tbody>
                  </table>
                  <p className="small muted">OBS does not report the current mute/volume in this state view; the result of each change is confirmed by read-back.</p>
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
  const curl = `curl -X POST -H "Authorization: Bearer <token>" -H "Content-Type: application/json" -d '${hasParams ? params : "{}"}' ${window.location.origin}/api/v1/devices/actions/${a.id}`;
  return (
    <tr>
      <td>
        <strong>{a.label}</strong>
        <div className="mono small muted">{a.id}</div>
      </td>
      <td className="small">
        {a.permission} {a.allowed ? null : <Badge tone="warn">NOT ALLOWED</Badge>}
      </td>
      <td>{hasParams ? <input className="mono" aria-label={`Parameters for ${a.id}`} value={params} onChange={(e) => setParams(e.target.value)} style={{ width: 220 }} aria-invalid={!parsed.ok} /> : <span className="muted small">none</span>}</td>
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
            reasonPlacement="tooltip"
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
      <div className="row" style={{ marginBottom: 8 }}>
        {t.simulated ? <Badge tone="sim">SIMULATION</Badge> : null}
        <Badge tone={t.telemetry === "live" ? "ok" : t.telemetry === "stale" ? "danger" : "neutral"}>TELEMETRY {t.telemetry.toUpperCase()}</Badge>
        <Badge tone={t.control.emergencyStopped ? "danger" : t.control.automationActive ? "ok" : "warn"}>{t.control.emergencyStopped ? "EMERGENCY STOP" : t.control.automationActive ? "AUTOMATION" : "MANUAL"}</Badge>
        <Badge tone="info">DIRECTOR {t.director.mode.toUpperCase()}</Badge>
        {t.director.hold ? <Badge tone="warn">HOLD</Badge> : null}
        <Badge tone={t.program.mode === "LIVE" ? "ok" : "info"}>PROGRAM {t.program.mode}</Badge>
        <Badge tone={t.obs.connected ? "ok" : "warn"}>OBS {t.obs.connected ? "ON" : "OFF"}</Badge>
      </div>
      {t.slots.length ? (
        <div className="row">
          {t.slots.map((s) => (
            <span key={s.steamId} className={`badge ${s.onAir ? "tone-ok" : s.alive ? "" : "tone-danger"}`} title={`${s.side ?? "?"} · ${s.alive ? "alive" : "dead"}`}>
              {s.slot ?? "·"} {s.name} {s.onAir ? "● ON AIR" : s.alive ? "" : "✕"}
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
      <Note tone="neutral" title="COMPANION / STREAM DECK">
        Control surfaces use the same local HTTP API as this console: <code>POST {window.location.origin}/api/v1/devices/actions/&lt;action&gt;</code> with <code>Authorization: Bearer &lt;token&gt;</code> and a JSON body. In Bitfocus Companion use the Generic HTTP module (POST, JSON body, custom header). Poll <code>GET /api/v1/devices/tally</code> for button feedback. Every action goes through the same control/program arbiters as the console and is audited. Issue a role-scoped token in the Tokens tab (e.g. role <em>observer</em> for camera buttons) — never share the operator token.
      </Note>
      <Panel title="Tally" subtitle="What a control surface sees for button feedback">
        {t ? <TallyView t={t} /> : <Async state={tally}>{(x) => <TallyView t={x} />}</Async>}
      </Panel>
      <Panel title="Device actions">
        <Async state={actions}>
          {(list) => (
            <table className="table table-compact">
              <thead>
                <tr>
                  <th>Action</th>
                  <th>Permission</th>
                  <th>Parameters (JSON)</th>
                  <th />
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
          <Field label="Expires after (hours)" hint="empty = no expiry (captain links default to 6 h)">
            <input type="number" min={1} max={720} value={ttl} onChange={(e) => setTtl(e.target.value)} />
          </Field>
          {role === "captain" ? (
            <>
              <Field label="Match">
                <select value={matchId} onChange={(e) => setMatchId(e.target.value)}>
                  <option value="">choose…</option>
                  {(matches.data ?? []).map((x) => (
                    <option key={x.id} value={x.id}>
                      {x.title ?? x.id}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Team">
                <select value={teamId} onChange={(e) => setTeamId(e.target.value)} disabled={!m}>
                  <option value="">choose…</option>
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
          <Note tone="warn" title="SHOWN ONCE">
            <div className="url-box">
              <input readOnly className="mono" value={issued.token} aria-label="New token" onFocus={(e) => e.target.select()} />
              <CopyButton text={issued.token} />
            </div>
            {issued.role === "captain" ? (
              <div className="small">
                Captain link: <code>{`${window.location.origin}/captain?match=${matchId}&token=${issued.token}`}</code>
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
              <EmptyState title="No issued tokens">Only the local operator token exists. Issue scoped tokens for Companion, Stream Deck, remote producers or captains.</EmptyState>
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
                        <td>
                          {t.label}
                          <div className="mono small muted">{t.id}</div>
                        </td>
                        <td>{t.role}</td>
                        <td className="small">{t.scope ? Object.entries(t.scope).map(([k, v]) => `${k}=${v}`).join(", ") : "—"}</td>
                        <td className="small">{fmtTime(t.createdAt)}</td>
                        <td className="small">{t.expiresAt ? <>{fmtTime(t.expiresAt)} {expired ? <Badge tone="warn">EXPIRED</Badge> : null}</> : "never"}</td>
                        <td>
                          <ActionButton size="sm" variant="danger" action={() => api.del(`/api/v1/tokens/${seg(t.id)}`)} success={`Token “${t.label}” revoked`} onDone={() => void tokens.reload()} confirm={{ title: `Revoke “${t.label}”?`, body: "Devices using it lose access immediately.", danger: true, confirmLabel: "Revoke" }}>
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
                  <table className="table table-compact" style={{ marginTop: 8 }}>
                    <tbody>
                      {Object.entries(a.capabilities).map(([k, c]) => (
                        <tr key={k}>
                          <td className="small">{k}</td>
                          <td>
                            <SupportBadge support={c.support} />
                          </td>
                          <td className="small muted">{c.limitations.join("; ")}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : null}
              </>
            )}
          </Async>
        </Panel>
        <Panel title="Games">
          <Async state={games}>
            {(g) => (
              <table className="table table-compact">
                <tbody>
                  {g.supported.map((x) => (
                    <tr key={x.gameId}>
                      <td>{x.displayName}</td>
                      <td>
                        <Badge tone="ok">SUPPORTED · {x.status.toUpperCase()}</Badge>
                      </td>
                    </tr>
                  ))}
                  {g.expansion.map((x) => (
                    <tr key={x.gameId}>
                      <td>{x.displayName}</td>
                      <td>
                        <Badge>PLANNED · NOT SUPPORTED</Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Async>
        </Panel>
      </div>
      <Panel title="MatchFrame bridge" subtitle="Optional push of match results to the MatchFrame service" actions={bridge.data ? <Badge tone={bridge.data.status === "connected" ? "ok" : bridge.data.status === "disabled" ? "neutral" : "warn"}>{bridge.data.status.toUpperCase()}</Badge> : null}>
        <Async state={bridge}>
          {(b) => (
            <>
              <p className="small muted">{b.note}</p>
              <div className="form-grid">
                <Field label="Bridge URL">
                  <input value={cfg.url} onChange={(e) => setCfg({ ...cfg, url: e.target.value })} placeholder="https://…" />
                </Field>
                <Field label="Token (stored in the secret store)" hint="leave empty to keep the stored token">
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
                <ActionButton action={() => api.post<{ lastError: string | null }>("/api/v1/integrations/matchframe/discover")} success={(r) => (r.lastError ? `Discovery failed: ${r.lastError}` : "Bridge capabilities discovered")} onDone={() => void bridge.reload()} disabledReason={settingsReason ?? (b.config.enabled && b.config.url ? null : "Enable the bridge and set its URL first")}>
                  Discover
                </ActionButton>
              </div>
              <div className="row-end" style={{ marginTop: 8 }}>
                <Field label="Push a match result">
                  <select value={pushMatch} onChange={(e) => setPushMatch(e.target.value)}>
                    <option value="">choose…</option>
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
