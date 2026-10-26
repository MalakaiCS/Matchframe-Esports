import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { api, seg } from "../api/index.ts";
import type { CapabilitiesResponse, DiscoveryResult, GsiConfigPreview, MapPackDetail, ObserverAdapterResponse, ObserverAdapterSettings, ObsState, PlayerSelectionTestResult, SceneMap, SetupProfile, SetupStatus, WriteGsiResult } from "../api/types.ts";
import { CapabilityTable } from "../components/CapabilityTable.tsx";
import { ActionButton, Async, Badge, Checkbox, CopyButton, Field, KV, Note, Panel, SupportBadge } from "../components/ui.tsx";
import { fmtTime, MISSING } from "../lib/format.ts";
import { useApi } from "../lib/hooks.ts";
import { checklistProgress, setupChecklist } from "../lib/setup.ts";
import { Link } from "../router.tsx";
import { useSnapshot } from "../state/live.ts";
import { usePermission } from "../state/session.tsx";

function Step({ n, id, title, children, done }: { n: number; id: string; title: string; children: ReactNode; done?: boolean }) {
  return (
    <Panel
      id={id}
      className="step"
      title={
        <>
          <span className="step-num">{n}</span>
          {title}
        </>
      }
      actions={done ? <Badge tone="ok" icon="✓">DONE</Badge> : undefined}
    >
      {children}
    </Panel>
  );
}

const DEFAULT_TEMPLATES: Record<string, string> = {
  selectPlayer: "spec_player_by_accountid {accountId}",
  modeInEye: "spec_mode 4",
  modeChase: "spec_mode 5",
  modeRoaming: "spec_mode 6",
  staticCamera: "spec_mode 6; spec_goto {x} {y} {z} {pitch} {yaw}",
  readPose: "getpos",
};

function SourceMode({ status, reload }: { status: SetupStatus; reload: () => void }) {
  const reason = usePermission("settings.manage");
  const [offset, setOffset] = useState(25);
  return (
    <>
      <div className="grid-3">
        <div>
          <h3>Live observer</h3>
          <p className="small muted">A CS2 spectator/observer client sends Game State Integration (GSI) to this engine. Continue with steps 2–4.</p>
        </div>
        <div>
          <h3>Demo playback</h3>
          <p className="small muted">Play a demo in CS2 (<code>playdemo</code>) on the observer client. Telemetry arrives through the same GSI config and control uses the same observer adapter — no extra setup in Matchframe.</p>
        </div>
        <div>
          <h3>Labelled simulation</h3>
          <p className="small muted">Synthetic 5v5 on a synthetic map for rehearsals. Always badged SIMULATION; it never certifies real telemetry or camera control.</p>
          <div className="row">
            {status.simulated ? (
              <ActionButton action={() => api.post("/api/v1/simulation/stop")} success="Simulation stopped" onDone={reload} disabledReason={reason}>
                Stop simulation
              </ActionButton>
            ) : (
              <>
                <Field label="Start offset (s)">
                  <input type="number" min={0} max={80} value={offset} onChange={(e) => setOffset(Number(e.target.value))} style={{ width: 90 }} />
                </Field>
                <ActionButton variant="primary" action={() => api.post("/api/v1/simulation/start", { startOffsetSec: offset })} success="Simulation started" onDone={reload} disabledReason={reason}>
                  Start simulation
                </ActionButton>
              </>
            )}
          </div>
        </div>
      </div>
      <Note tone="neutral" title="TOPOLOGY">
        <strong>One PC:</strong> CS2 observer, OBS and Matchframe on the same machine — everything stays on 127.0.0.1. <strong>Multi-PC:</strong> the observer client posts GSI to this machine; the engine binds to loopback by default, so start it with
        <code>MATCHFRAME_HOST</code> set to the LAN address, allow the GSI port in the firewall, and write the GSI config with this machine's LAN address as host (step 3). Remote consoles then need role-scoped tokens (Devices).
      </Note>
    </>
  );
}

function DetectCs2({ status, reload }: { status: SetupStatus; reload: () => void }) {
  const reason = usePermission("settings.manage");
  const [manual, setManual] = useState("");
  const [result, setResult] = useState<DiscoveryResult | null>(null);
  const inst = result?.install ?? status.cs2Install;
  return (
    <>
      <div className="row-end">
        <ActionButton variant="primary" action={() => api.post<DiscoveryResult>("/api/v1/setup/detect-cs2", {})} onDone={(r) => {
            setResult(r);
            reload();
          }} success={(r) => (r.install ? "CS2 found" : "CS2 not found automatically")} disabledReason={reason}>
          Detect CS2
        </ActionButton>
        <Field label="Or enter the CS2 install folder" hint="The folder that contains game/csgo/cfg, e.g. …\steamapps\common\Counter-Strike Global Offensive">
          <input value={manual} onChange={(e) => setManual(e.target.value)} placeholder="C:\Program Files (x86)\Steam\steamapps\common\Counter-Strike Global Offensive" style={{ width: 520 }} />
        </Field>
        <ActionButton action={() => api.post<DiscoveryResult>("/api/v1/setup/detect-cs2", { manualInstallDir: manual.trim() })} onDone={(r) => {
            setResult(r);
            reload();
          }} success={(r) => (r.install ? "Folder accepted" : null)} disabledReason={reason ?? (manual.trim() ? null : "Enter a folder first")}>
          Use this folder
        </ActionButton>
      </div>
      {inst ? (
        <KV
          items={[
            ["Install", inst.installDir],
            ["cfg directory", inst.cfgDir],
            ["Steam library", inst.libraryPath || MISSING],
            ["Build (manifest)", inst.gameBuildFromManifest ?? MISSING],
          ]}
        />
      ) : null}
      {result && result.problems.length ? (
        <Note tone="warn" title="DETECTION">
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {result.problems.map((p, i) => (
              <li key={i}>{p}</li>
            ))}
          </ul>
          {result.steamRoots.length ? <div className="small">Steam roots: {result.steamRoots.join(", ")}</div> : null}
        </Note>
      ) : null}
    </>
  );
}

function GsiConfig({ status, reload }: { status: SetupStatus; reload: () => void }) {
  const reason = usePermission("settings.manage");
  const preview = useApi<GsiConfigPreview>(reason ? null : "/api/v1/setup/gsi-config");
  const [host, setHost] = useState("127.0.0.1");
  const [cfgDir, setCfgDir] = useState("");
  const [result, setResult] = useState<WriteGsiResult | null>(null);
  return (
    <>
      <p className="small muted">Writes <code>gamestate_integration_matchframe.cfg</code> with this engine's endpoint and secret token. An existing different file is backed up first.</p>
      <div className="row-end">
        <Field label="GSI host" hint="127.0.0.1 for one PC; this machine's LAN IP for multi-PC">
          <input value={host} onChange={(e) => setHost(e.target.value)} style={{ width: 170 }} />
        </Field>
        <Field label="cfg directory (optional)" hint={status.cs2Install ? `Default: ${status.cs2Install.cfgDir}` : "Required when CS2 was not detected"}>
          <input value={cfgDir} onChange={(e) => setCfgDir(e.target.value)} style={{ width: 420 }} />
        </Field>
        <ActionButton
          variant="primary"
          action={() => api.post<WriteGsiResult>("/api/v1/setup/write-gsi-config", { host, ...(cfgDir.trim() ? { cfgDir: cfgDir.trim() } : {}) })}
          onDone={(r) => {
            setResult(r);
            reload();
          }}
          success={(r) => (r.unchanged ? "GSI config already up to date" : "GSI config written")}
          disabledReason={reason ?? (status.cs2Install || cfgDir.trim() ? null : "Detect CS2 (step 2) or enter the cfg directory")}
        >
          Write GSI config
        </ActionButton>
      </div>
      {result ? (
        <Note tone={result.restartRequired ? "warn" : "ok"} title={result.restartRequired ? "RESTART CS2" : "UP TO DATE"}>
          {result.unchanged ? "The file already matches." : `Written to ${result.path}.`} {result.backup ? `Previous file backed up to ${result.backup}.` : ""} Endpoint {result.uri}. {result.note}
        </Note>
      ) : null}
      {preview.data ? (
        <details>
          <summary className="small">Preview (token hidden) · endpoint {preview.data.uri}</summary>
          <pre className="pre">{preview.data.preview}</pre>
        </details>
      ) : null}
    </>
  );
}

function Payload({ status }: { status: SetupStatus }) {
  return (
    <div className="row">
      {status.simulated ? (
        <Note tone="sim" title="SIMULATION RUNNING">
          Real GSI packets are ignored while the simulation runs ({status.packets} simulated packets so far). Stop the simulation in step 1 to wait for the real client.
        </Note>
      ) : status.realPayloadReceived ? (
        <Note tone="ok" title="RECEIVING">
          {status.packets} real packets received · game build {status.gameBuild ?? "unknown"}.
        </Note>
      ) : (
        <Note tone="warn" title="WAITING">
          Waiting for the first real GSI payload… ({status.packets} packets). After writing the config, fully restart CS2 and join a match/demo as spectator. If nothing arrives, check the host/port in the config and the firewall.
        </Note>
      )}
    </div>
  );
}

function AdapterConfig() {
  const reason = usePermission("settings.manage");
  const res = useApi<ObserverAdapterResponse>("/api/v1/observer/adapter", { refreshMs: 10000 });
  const [draft, setDraft] = useState<ObserverAdapterSettings | null>(null);
  useEffect(() => {
    if (res.data && !draft) setDraft(res.data.settings);
  }, [res.data, draft]);
  return (
    <Async state={res}>
      {(d) => {
        const s = draft ?? d.settings;
        const set = (patch: Partial<ObserverAdapterSettings>) => setDraft({ ...s, ...patch });
        return (
          <>
            <div className="seg" role="radiogroup" aria-label="Observer adapter">
              {(["none", "netcon", "keyboard"] as const).map((k) => (
                <button key={k} role="radio" aria-checked={s.kind === k} className={`seg-btn ${s.kind === k ? "is-on" : ""}`} onClick={() => set({ kind: k })}>
                  {k === "none" ? "No control" : k === "netcon" ? "Direct console (netcon)" : "Keyboard fallback"}
                </button>
              ))}
            </div>
            <p className="small muted">
              {s.kind === "none" && "Matchframe will recommend shots but never move the observer camera."}
              {s.kind === "netcon" && "Sends console commands over CS2's -netconport on this PC. Command templates are candidates: capabilities stay UNVERIFIED until the tests below confirm them."}
              {s.kind === "keyboard" && "Sends spectator number keys to the CS2 window (Windows only). The observer window must stay focused; confirmation still comes from telemetry."}
            </p>
            {s.kind === "netcon" ? (
              <div className="form-grid">
                <Field label="Host" hint="Loopback only: the console channel accepts arbitrary commands">
                  <select value={s.host} onChange={(e) => set({ host: e.target.value })}>
                    <option value="127.0.0.1">127.0.0.1</option>
                    <option value="localhost">localhost</option>
                    <option value="::1">::1</option>
                  </select>
                </Field>
                <Field label="Port" hint="Launch CS2 with -netconport <port>">
                  <input type="number" value={s.port} onChange={(e) => set({ port: Number(e.target.value) })} />
                </Field>
                {Object.keys(DEFAULT_TEMPLATES).map((k) => (
                  <Field key={k} label={`Template: ${k}`}>
                    <input className="mono" value={s.templates[k] ?? ""} placeholder={DEFAULT_TEMPLATES[k]} onChange={(e) => set({ templates: { ...s.templates, [k]: e.target.value } })} />
                  </Field>
                ))}
              </div>
            ) : null}
            {s.kind === "keyboard" ? (
              <Field label="Observer window title (regular expression)">
                <input className="mono" value={s.windowTitle} onChange={(e) => set({ windowTitle: e.target.value })} />
              </Field>
            ) : null}
            <div className="form-actions">
              <ActionButton
                variant="primary"
                action={() => {
                  const templates = Object.fromEntries(Object.entries(s.templates).filter(([, v]) => v.trim() !== ""));
                  return api.put<ObserverAdapterResponse>("/api/v1/observer/adapter", { ...s, templates });
                }}
                success={(r) => `Adapter saved (active: ${r.active ?? "none"})`}
                onDone={() => void res.reload()}
                disabledReason={reason}
              >
                Save adapter
              </ActionButton>
            </div>
            <KV items={[["Active adapter", d.active ?? "none"]]} />
            {d.active?.startsWith("sim") ? (
              <Note tone="sim" title="SIMULATION">
                The labelled simulation owns the observer adapter while it runs. The setting saved here is applied when the simulation stops.
              </Note>
            ) : null}
            {d.capabilities ? (
              <table className="table table-compact">
                <tbody>
                  {Object.entries(d.capabilities).map(([k, c]) => (
                    <tr key={k}>
                      <td>{k}</td>
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
        );
      }}
    </Async>
  );
}

function PlayerSelectionTest() {
  const snap = useSnapshot();
  const reason = usePermission("camera.control");
  const [steamId, setSteamId] = useState("");
  const [result, setResult] = useState<PlayerSelectionTestResult | null>(null);
  const players = snap?.state?.players ?? [];
  const observed = snap?.state?.observer.observedSteamId ?? null;
  const name = (id: string | null) => players.find((p) => p.steamId === id)?.name ?? id ?? "none";
  return (
    <>
      <p className="small muted">Requests a POV change and records evidence only if telemetry shows the requested player within 3 s. Pick a player who is not already spectated.</p>
      <div className="row-end">
        <Field label="Player">
          <select value={steamId} onChange={(e) => setSteamId(e.target.value)}>
            <option value="">{players.length ? "choose a player…" : "no players in telemetry"}</option>
            {players.map((p) => (
              <option key={p.steamId} value={p.steamId} disabled={p.steamId === observed}>
                {p.name} ({p.side ?? "?"}){p.steamId === observed ? " — currently spectated" : ""}
              </option>
            ))}
          </select>
        </Field>
        <ActionButton
          variant="primary"
          action={() => api.post<PlayerSelectionTestResult>("/api/v1/setup/test-player-selection", { steamId })}
          onDone={setResult}
          success={(r) => (r.recorded ? "Player selection verified and recorded" : r.confirmed ? "Confirmed, but not recorded (see note)" : "Not confirmed")}
          disabledReason={reason ?? (!snap?.state ? "No telemetry yet — receive a GSI payload first (step 4)" : steamId ? null : "Choose a player")}
        >
          Run player-selection test
        </ActionButton>
      </div>
      {result ? (
        <>
          <Note tone={result.recorded ? "ok" : result.confirmed ? "warn" : "danger"} title={result.recorded ? "RECORDED" : "NOT RECORDED"}>
            {result.recorded
              ? "Telemetry confirmed the requested player. playerSelectionControl is now supported for this build."
              : result.simulated
                ? "The simulation adapter cannot certify real control — evidence is shown but not recorded."
                : result.note ?? (result.confirmed ? "Confirmed but the player was already spectated." : "Telemetry did not show the requested player within 3 s.")}
          </Note>
          <KV
            items={[
              ["Requested", name(result.requested)],
              ["Observed before", name(result.observedBefore)],
              ["Observed after", name(result.observedAfter)],
              ["Transport", result.transport],
              ["Confirmed by telemetry", result.confirmed ? "yes" : "no"],
              ["Simulation", result.simulated ? "yes" : "no"],
              ["Build", result.build ?? MISSING],
              ["At", fmtTime(result.at)],
            ]}
          />
        </>
      ) : null}
    </>
  );
}

function StaticCameraTest({ status, reload }: { status: SetupStatus; reload: () => void }) {
  const snap = useSnapshot();
  const reason = usePermission("camera.control");
  const resetReason = usePermission("settings.manage");
  const mapName = snap?.state?.mapName ?? null;
  const pack = useApi<MapPackDetail>(mapName ? `/api/v1/maps/${seg(mapName)}` : null);
  const [cameraId, setCameraId] = useState("");
  const [test, setTest] = useState<{ transport: string; telemetryConsistent: boolean; nextStep: string } | null>(null);
  const cams = pack.data?.cameras ?? [];
  return (
    <>
      <p className="small muted">Moves the observer to a stored static camera. Telemetry can only show consistency (free camera mode), so an operator must confirm the view on the observer screen — support is then recorded as PARTIAL.</p>
      <div className="row-end">
        <Field label="Camera" hint={mapName ? `Cameras of ${mapName}` : "Requires live telemetry with a map"}>
          <select value={cameraId} onChange={(e) => setCameraId(e.target.value)}>
            <option value="">{cams.length ? "choose a camera…" : "no cameras for this map (author one in Maps & Cameras)"}</option>
            {cams.map((c) => (
              <option key={c.id} value={c.id}>
                {c.displayName} ({c.validation})
              </option>
            ))}
          </select>
        </Field>
        <ActionButton
          variant="primary"
          action={() => api.post<{ transport: string; telemetryConsistent: boolean; nextStep: string }>("/api/v1/setup/test-static-camera", { cameraId })}
          onDone={setTest}
          success={(r) => `Camera command: ${r.transport}`}
          disabledReason={reason ?? (!snap?.state ? "No telemetry yet" : cameraId ? null : "Choose a camera")}
        >
          Run camera test
        </ActionButton>
      </div>
      {test ? (
        <>
          <KV
            items={[
              ["Transport", test.transport],
              ["Telemetry consistent (free camera)", test.telemetryConsistent ? "yes" : "no"],
            ]}
          />
          <Note tone="info" title="OPERATOR CHECK">
            Look at the observer client now. Does it show the expected view for this camera?
          </Note>
          <div className="row">
            <ActionButton variant="primary" action={() => api.post<{ recorded: boolean; note: string }>("/api/v1/setup/confirm-static-camera", { cameraId, visible: true })} success={(r) => (r.recorded ? "Static camera recorded as PARTIAL support" : r.note)} onDone={reload} disabledReason={reason}>
              Yes, the expected view is shown
            </ActionButton>
            <ActionButton action={() => api.post("/api/v1/setup/confirm-static-camera", { cameraId, visible: false })} success="Recorded: view not shown (support unchanged)" onDone={reload} disabledReason={reason}>
              No, it is wrong
            </ActionButton>
          </div>
        </>
      ) : null}
      <div className="form-actions">
        <span className="small muted">
          Verified: player selection {status.verifiedControl.playerSelectionControl ? `✓ (${status.verifiedControl.playerSelectionControl.build ?? "?"})` : "—"} · static camera {status.verifiedControl.staticCameraControl ? `✓ (${status.verifiedControl.staticCameraControl.support})` : "—"}
        </span>
        <ActionButton size="sm" variant="warn" action={() => api.post("/api/v1/setup/reset-verification")} success="Verification evidence cleared" onDone={reload} disabledReason={resetReason} confirm={{ title: "Reset control verification?", body: "Clears recorded player-selection and static-camera evidence. Capabilities return to UNVERIFIED until the tests are run again.", confirmLabel: "Reset", danger: true }}>
          Reset verification
        </ActionButton>
      </div>
    </>
  );
}

function ObsConnect({ status, reload }: { status: SetupStatus; reload: () => void }) {
  const reason = usePermission("program.control");
  const [url, setUrl] = useState("ws://127.0.0.1:4455");
  const [password, setPassword] = useState("");
  const [remember, setRemember] = useState(true);
  return (
    <>
      <div className="row-end">
        <Field label="obs-websocket URL" hint="OBS → Tools → WebSocket Server Settings (v5)">
          <input value={url} onChange={(e) => setUrl(e.target.value)} style={{ width: 240 }} />
        </Field>
        <Field label="Password">
          <input type="password" autoComplete="off" value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
        <Checkbox checked={remember} onChange={setRemember} label="Remember (stored in the local secret store)" />
        <ActionButton
          variant="primary"
          action={() => api.post<{ state: ObsState }>("/api/v1/obs/connect", { url, ...(password ? { password } : {}), remember })}
          success={(r) => (r.state.connected ? `Connected to OBS ${r.state.obsVersion ?? ""}` : `Not connected: ${r.state.lastError ?? "unknown error"}`)}
          onDone={reload}
          disabledReason={reason ?? (/^wss?:\/\//.test(url) ? null : "URL must start with ws:// or wss://")}
        >
          Connect OBS
        </ActionButton>
        {status.obs.connected ? (
          <ActionButton action={() => api.post("/api/v1/obs/disconnect")} success="OBS disconnected" onDone={reload} disabledReason={reason}>
            Disconnect
          </ActionButton>
        ) : null}
      </div>
      <p className="small muted">
        Status: {status.obs.connected ? <Badge tone="ok">CONNECTED</Badge> : <Badge tone="warn">DISCONNECTED</Badge>} · {status.obs.scenes} scenes. OBS provides scenes, sources, recording and the replay buffer — not CS2 telemetry or camera control.
      </p>
    </>
  );
}

function ProgramScenes({ status, reload }: { status: SetupStatus; reload: () => void }) {
  const reason = usePermission("settings.manage");
  const obs = useApi<{ state: ObsState }>("/api/v1/obs");
  const [scenes, setScenes] = useState<SceneMap>(status.obs.programScenes);
  const list = obs.data?.state.scenes ?? [];
  return (
    <>
      <p className="small muted">The program state machine only claims a mode (STUDIO, BREAK, REPLAY) when the mapped scene is really put on program by OBS.</p>
      <div className="form-grid">
        {(["LIVE", "REPLAY", "STUDIO", "BREAK"] as const).map((m) => (
          <Field key={m} label={`${m} scene`}>
            <input list="obs-scene-list" value={scenes[m] ?? ""} onChange={(e) => setScenes({ ...scenes, [m]: e.target.value || null })} placeholder={list.length ? "choose or type" : "OBS scene name"} />
          </Field>
        ))}
        <datalist id="obs-scene-list">
          {list.map((s) => (
            <option key={s} value={s} />
          ))}
        </datalist>
      </div>
      <div className="form-actions">
        <ActionButton variant="primary" action={() => api.put("/api/v1/settings/program.scenes", { value: scenes })} success="Program scenes saved" onDone={reload} disabledReason={reason}>
          Save scene mapping
        </ActionButton>
        {!obs.data?.state.connected ? <span className="small muted">OBS is not connected — scene names cannot be listed, but you can type them.</span> : null}
      </div>
    </>
  );
}

function HudUrl({ status }: { status: SetupStatus }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    api
      .get<{ url: string }>("/api/v1/hud/outputs/main/url")
      .then((r) => setUrl(r.url))
      .catch(() => setUrl(status.hudUrl));
  }, [status.hudUrl]);
  const reason = usePermission("program.control");
  return (
    <>
      <div className="url-box">
        <input readOnly value={url ?? status.hudUrl} aria-label="Main HUD URL" onFocus={(e) => e.target.select()} />
        <CopyButton text={url ?? status.hudUrl} label="Copy URL" size="md" />
      </div>
      <p className="small muted">Add as an OBS Browser Source at 1920×1080. The URL carries a read-only output token (rotate it in HUDs & Composer). The overlay never receives operator data.</p>
      <ActionButton action={() => api.post<{ sceneName?: string }>("/api/v1/obs/provision", {})} success="Browser source provisioned in OBS (scene “Matchframe Live”)" disabledReason={reason ?? (status.obs.connected ? null : "Connect OBS first (step 9)")}>
        Create the browser source in OBS
      </ActionButton>
    </>
  );
}

function Profiles({ status }: { status: SetupStatus }) {
  const reason = usePermission("settings.manage");
  const profiles = useApi<SetupProfile[]>("/api/v1/setup/profiles");
  const adapter = useApi<ObserverAdapterResponse>("/api/v1/observer/adapter");
  const [name, setName] = useState("");
  const [sourceMode, setSourceMode] = useState<SetupProfile["sourceMode"]>(status.simulated ? "simulation" : "live_observer");
  const [topology, setTopology] = useState<SetupProfile["topology"]>("one_pc");
  const items = setupChecklist(status);
  return (
    <>
      <div className="row-end">
        <Field label="Profile name">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Main stage — observer 1" />
        </Field>
        <Field label="Source mode">
          <select value={sourceMode} onChange={(e) => setSourceMode(e.target.value as SetupProfile["sourceMode"])}>
            <option value="live_observer">Live observer</option>
            <option value="demo_playback">Demo playback</option>
            <option value="simulation">Simulation</option>
          </select>
        </Field>
        <Field label="Topology">
          <select value={topology} onChange={(e) => setTopology(e.target.value as SetupProfile["topology"])}>
            <option value="one_pc">One PC</option>
            <option value="multi_pc">Multi-PC</option>
          </select>
        </Field>
        <ActionButton
          variant="primary"
          action={() =>
            api.post<SetupProfile>("/api/v1/setup/profiles", {
              name: name.trim(),
              sourceMode,
              topology,
              cs2InstallDir: status.cs2Install?.installDir ?? null,
              observerAdapter: adapter.data?.settings ?? {},
              programScenes: status.obs.programScenes,
              checklist: Object.fromEntries(items.map((i) => [i.id, i.done])),
            })
          }
          success={(p) => `Profile “${p.name}” saved`}
          onDone={() => void profiles.reload()}
          disabledReason={reason ?? (name.trim() ? null : "Enter a profile name")}
        >
          Save setup profile
        </ActionButton>
      </div>
      <p className="small muted">A profile stores the observer adapter, program scene mapping, CS2 folder and checklist state ({checklistProgress(items).done}/{items.length} done now). Secrets are never stored in profiles.</p>
      <Async state={profiles}>
        {(list) =>
          list.length === 0 ? (
            <p className="muted small">No saved profiles yet.</p>
          ) : (
            <table className="table table-compact">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Mode</th>
                  <th>Topology</th>
                  <th>Adapter</th>
                  <th>Created</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {list.map((p) => (
                  <tr key={p.id}>
                    <td>{p.name}</td>
                    <td>{p.sourceMode.replace("_", " ")}</td>
                    <td>{p.topology === "one_pc" ? "One PC" : "Multi-PC"}</td>
                    <td>{String((p.observerAdapter as { kind?: string }).kind ?? "—")}</td>
                    <td>{fmtTime(p.createdAt)}</td>
                    <td>
                      <ActionButton size="sm" action={() => api.post(`/api/v1/setup/profiles/${seg(p.id)}/apply`)} success={`Applied “${p.name}”`} disabledReason={reason} confirm={{ title: `Apply profile “${p.name}”?`, body: "Replaces the observer adapter settings and the program scene mapping with the profile's values." }}>
                        Apply
                      </ActionButton>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )
        }
      </Async>
    </>
  );
}

export function SetupScreen() {
  const status = useApi<SetupStatus>("/api/v1/setup/status", { refreshMs: 1500 });
  const caps = useApi<CapabilitiesResponse>("/api/v1/capabilities", { refreshMs: 5000 });
  const hasData = status.data !== undefined;
  useEffect(() => {
    // Deep links from the Overview checklist (/setup#step-…) scroll once the steps are rendered.
    const id = window.location.hash.slice(1);
    if (!id || !hasData) return;
    document.getElementById(id)?.scrollIntoView({ block: "start" });
  }, [hasData]);
  return (
    <div className="page">
      <div className="page-head">
        <h1 className="page-title">Setup</h1>
        {status.data ? (
          <Badge tone={checklistProgress(setupChecklist(status.data)).done === setupChecklist(status.data).length ? "ok" : "info"}>
            {checklistProgress(setupChecklist(status.data)).done}/{setupChecklist(status.data).length} COMPLETE
          </Badge>
        ) : null}
      </div>
      <p className="page-intro">
        First-run checklist for a broadcast PC. Each step shows only what the engine has actually observed — nothing is marked verified from configuration alone. Return to the <Link to="/">Overview</Link> any time.
      </p>
      <Async state={status}>
        {(s) => (
          <div className="stack">
            <Step n={1} id="step-source" title="Choose the source">
              <SourceMode status={s} reload={() => void status.reload()} />
            </Step>
            <Step n={2} id="step-detect" title="Detect CS2" done={!!s.cs2Install}>
              <DetectCs2 status={s} reload={() => void status.reload()} />
            </Step>
            <Step n={3} id="step-gsi" title="Write the GSI config">
              <GsiConfig status={s} reload={() => void status.reload()} />
            </Step>
            <Step n={4} id="step-payload" title="Wait for a real payload" done={s.realPayloadReceived}>
              <Payload status={s} />
            </Step>
            <Step n={5} id="step-capabilities" title="Capability report">
              <Async state={caps}>
                {(c) => (
                  <>
                    {c.simulated ? (
                      <Note tone="sim" title="SIMULATION">
                        These capabilities describe the simulation source, not a real CS2 client.
                      </Note>
                    ) : null}
                    <p className="small muted">{c.note}</p>
                    <CapabilityTable caps={c.capabilities} />
                    <details>
                      <summary className="small">Requested GSI components ({c.requestedGsiComponents.length}) and telemetry sample summary</summary>
                      <pre className="pre">{JSON.stringify({ requested: c.requestedGsiComponents, summary: c.telemetrySummary }, null, 2)}</pre>
                    </details>
                  </>
                )}
              </Async>
            </Step>
            <Step n={6} id="step-adapter" title="Observer control adapter" done={s.control.adapter !== "none"}>
              <AdapterConfig />
            </Step>
            <Step n={7} id="step-selection" title="Player-selection test" done={!!s.verifiedControl.playerSelectionControl}>
              <PlayerSelectionTest />
            </Step>
            <Step n={8} id="step-camera" title="Static camera test" done={!!s.verifiedControl.staticCameraControl}>
              <StaticCameraTest status={s} reload={() => void status.reload()} />
            </Step>
            <Step n={9} id="step-obs" title="Connect OBS" done={s.obs.connected}>
              <ObsConnect status={s} reload={() => void status.reload()} />
            </Step>
            <Step n={10} id="step-scenes" title="Program scene mapping" done={Object.values(s.obs.programScenes).some(Boolean)}>
              <ProgramScenes status={s} reload={() => void status.reload()} />
            </Step>
            <Step n={11} id="step-hud" title="Main HUD browser source">
              <HudUrl status={s} />
            </Step>
            <Step n={12} id="step-profile" title="Save a setup profile">
              <Profiles status={s} />
            </Step>
          </div>
        )}
      </Async>
    </div>
  );
}
