import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import type { Support } from "@matchframe/contracts";
import { api, seg } from "../api/index.ts";
import type { CapabilitiesResponse, DiscoveryResult, GsiConfigPreview, MapPackDetail, ObserverAdapterResponse, ObserverAdapterSettings, ObsState, PlayerSelectionTestResult, SceneMap, SetupProfile, SetupStatus, WriteGsiResult } from "../api/types.ts";
import { CapabilityTable } from "../components/CapabilityTable.tsx";
import { ActionButton, Async, Checkbox, CopyButton, Details, Field, KV, Mono, Note, Panel, StatusDot, SupportBadge } from "../components/ui.tsx";
import type { Tone } from "../components/ui.tsx";
import { flattenCapabilities } from "../lib/capabilities.ts";
import { fmtTime, MISSING } from "../lib/format.ts";
import { useApi } from "../lib/hooks.ts";
import { checklistProgress, setupChecklist } from "../lib/setup.ts";
import { useSnapshot } from "../state/live.ts";
import { usePermission } from "../state/session.tsx";
import { LaunchSettings } from "./game/LaunchSettings.tsx";
import { perLocale, t } from "../i18n/index.ts";
import { T } from "../i18n/T.tsx";
import "../styles/group-a.css";

function Step({ n, id, title, children, done }: { n: number; id: string; title: string; children: ReactNode; done?: boolean }) {
  return (
    <section id={id} className="ga-step">
      <h3 className="ga-step-title">
        <span className={`step-num ${done ? "is-done" : ""}`} aria-hidden>
          {n}
        </span>
        {title}
        {done ? <span className="ga-done">{t("setup.done")}</span> : null}
      </h3>
      {children}
    </section>
  );
}

const DEFAULT_TEMPLATES: Record<string, string> = {
  selectPlayer: 'spec_player "{name}"',
  modeInEye: "spec_mode 4",
  modeChase: "spec_mode 5",
  modeRoaming: "spec_mode 6",
  staticCamera: "{roaming}; spec_goto {x} {y} {z} {pitch} {yaw}",
  pathFrame: "spec_goto {x} {y} {z} {pitch} {yaw}",
  readPose: "getpos",
};

const TEMPLATE_HINTS: Record<string, string> = perLocale(() => ({
  selectPlayer: t("setup.hintSelectPlayer"),
  modeRoaming: t("setup.hintModeRoaming"),
  staticCamera: t("setup.hintStaticCamera"),
  pathFrame: t("setup.sent60TimesASecond"),
}));


function SourceMode({ status, reload }: { status: SetupStatus; reload: () => void }) {
  const reason = usePermission("settings.manage");
  const [offset, setOffset] = useState(25);
  return (
    <>
      <p className="muted">{t("setup.aLiveObserverClientOr")}</p>
      <div className="row-end">
        {status.simulated ? (
          <ActionButton action={() => api.post("/api/v1/simulation/stop")} success={t("setup.simulationStopped")} onDone={reload} disabledReason={reason}>{t("setup.stopSimulation")}</ActionButton>
        ) : (
          <>
            <Field label={t("setup.startOffsetS")}>
              <input type="number" min={0} max={80} value={offset} onChange={(e) => setOffset(Number(e.target.value))} style={{ width: 90 }} />
            </Field>
            <ActionButton variant="primary" action={() => api.post("/api/v1/simulation/start", { startOffsetSec: offset })} success={t("setup.simulationStarted")} onDone={reload} disabledReason={reason}>{t("setup.startSimulation")}</ActionButton>
          </>
        )}
      </div>
      <Details summary={t("setup.sourceModesAndMultiPc")}>
        <p><T k="setup.liveObserverACs2Spectator" tags={{ b: (c) => <strong>{c}</strong> }} /></p>
        <p><T k="setup.demoPlaybackPlayADemo" tags={{ b: (c) => <strong>{c}</strong>, code: (c) => <code>{c}</code> }} /></p>
        <p><T k="setup.labelledSimulationASynthetic5v5" tags={{ b: (c) => <strong>{c}</strong> }} /></p>
        <p><T k="setup.onePcCs2ObserverObs" tags={{ b: (c) => <strong>{c}</strong> }} /></p>
        <p><T k="setup.multiPcTheObserverClient" tags={{ b: (c) => <strong>{c}</strong>, code: (c) => <code>{c}</code> }} /></p>
      </Details>
    </>
  );
}

function DetectCs2({ status, reload }: { status: SetupStatus; reload: () => void }) {
  const reason = usePermission("settings.manage");
  const [manual, setManual] = useState("");
  const [result, setResult] = useState<DiscoveryResult | null>(null);
  const inst = result?.install ?? status.cs2Install;
  const onDetected = (r: DiscoveryResult) => {
    setResult(r);
    reload();
  };
  const manualForm = (
    <div className="row-end">
      <Field label={t("setup.cs2InstallFolder")} hint={t("setup.theFolderThatContainsGame")}>
        <input value={manual} onChange={(e) => setManual(e.target.value)} placeholder={t("setup.cProgramFilesX86Steam")} style={{ width: 520 }} />
      </Field>
      <ActionButton action={() => api.post<DiscoveryResult>("/api/v1/setup/detect-cs2", { manualInstallDir: manual.trim() })} onDone={onDetected} success={(r) => (r.install ? t("setup.folderAccepted") : null)} disabledReason={reason ?? (manual.trim() ? null : t("setup.enterAFolderFirst"))}>{t("setup.useThisFolder")}</ActionButton>
    </div>
  );
  return (
    <>
      {inst ? (
        <p><T k="setup.foundAtMono" values={{ mono: <Mono>{inst.installDir}</Mono> }} /></p>
      ) : null}
      <div className="row-end">
        <ActionButton variant={inst ? "secondary" : "primary"} action={() => api.post<DiscoveryResult>("/api/v1/setup/detect-cs2", {})} onDone={onDetected} success={(r) => (r.install ? t("setup.cs2Found") : t("setup.cs2NotFoundAutomatically"))} disabledReason={reason}>{t("setup.detectCs2")}</ActionButton>
      </div>
      {result && result.problems.length ? (
        <Note tone="warn">
          <ul style={{ margin: 0, paddingLeft: 18 }}>
            {result.problems.map((p, i) => (
              <li key={i}>{p}</li>
            ))}
          </ul>
          {result.steamRoots.length ? <div className="small">{t("setup.steamRootsJoin", { join: result.steamRoots.join(", ") })}</div> : null}
        </Note>
      ) : null}
      {inst ? (
        <Details summary={t("setup.installDetails")}>
          <KV
            items={[
              [t("setup.cfgDirectory"), inst.cfgDir],
              [t("setup.steamLibrary"), inst.libraryPath || MISSING],
              [t("setup.buildManifest"), inst.gameBuildFromManifest ?? MISSING],
            ]}
          />
          <div style={{ marginTop: 10 }}>{manualForm}</div>
        </Details>
      ) : (
        <div style={{ marginTop: 10 }}>{manualForm}</div>
      )}
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
      <div className="row-end">
        <Field label={t("setup.gsiHost")} hint={t("setup.text127001For")}>
          <input value={host} onChange={(e) => setHost(e.target.value)} style={{ width: 170 }} />
        </Field>
        <Field label={status.cs2Install ? t("setup.cfgDirectoryOptional") : t("setup.cfgDirectory")} hint={status.cs2Install ? undefined : t("setup.requiredBecauseCs2WasNot")}>
          <input value={cfgDir} onChange={(e) => setCfgDir(e.target.value)} placeholder={status.cs2Install?.cfgDir} title={status.cs2Install ? t("setup.leaveEmptyToUseCfgdir", { cfgDir: status.cs2Install.cfgDir }) : undefined} style={{ width: 420 }} />
        </Field>
        <ActionButton
          variant="primary"
          action={() => api.post<WriteGsiResult>("/api/v1/setup/write-gsi-config", { host, ...(cfgDir.trim() ? { cfgDir: cfgDir.trim() } : {}) })}
          onDone={(r) => {
            setResult(r);
            reload();
          }}
          success={(r) => (r.unchanged ? t("setup.gsiConfigAlreadyUpTo") : t("setup.gsiConfigWritten"))}
          disabledReason={reason ?? (status.cs2Install || cfgDir.trim() ? null : t("setup.detectCs2Step2Or"))}
        >{t("setup.writeGsiConfig")}</ActionButton>
      </div>
      {result ? (
        <Note tone={result.restartRequired ? "warn" : "ok"} title={result.restartRequired ? t("setup.restartCs2") : undefined}>{t("setup.vV2EndpointUriNote", { v: result.unchanged ? t("setup.theFileAlreadyMatches") : t("setup.writtenToPath", { path: result.path }), v2: result.backup ? t("setup.previousFileBackedUpTo", { backup: result.backup }) : "", uri: result.uri, note: result.note })}</Note>
      ) : null}
      <Details summary={t("setup.whatGetsWritten")}>
        <p className="small muted"><T k="setup.writesGamestateIntegrationMatchframeCfg" tags={{ code: (c) => <code>{c}</code> }} /></p>
        {preview.data ? (
          <>
            <p className="small muted">{t("setup.endpointUriTokenHidden", { uri: preview.data.uri })}</p>
            <pre className="pre">{preview.data.preview}</pre>
          </>
        ) : null}
      </Details>
    </>
  );
}

function Payload({ status }: { status: SetupStatus }) {
  if (status.simulated)
    return (
      <Note tone="sim">{t("setup.realGsiPacketsAreIgnored", { packets: status.packets })}</Note>
    );
  if (status.realPayloadReceived)
    return (
      <p><T k="setup.statusdotPacketsRealPacketsReceived" values={{ statusDot: <StatusDot tone="ok" />, packets: status.packets, v: status.gameBuild ?? t("setup.unknown") }} /></p>
    );
  return (
    <p className="muted"><T k="setup.statusdotWaitingForTheFirst" values={{ statusDot: <StatusDot tone="warn" />, packets: status.packets }} /></p>
  );
}

const SUPPORT_ORDER: [Support, Tone][] = [
  ["supported", "ok"],
  ["partial", "info"],
  ["unverified", "warn"],
  ["unsupported", "danger"],
];

function Capabilities({ caps }: { caps: CapabilitiesResponse }) {
  const rows = flattenCapabilities(caps.capabilities);
  return (
    <>
      <div className="ga-counts">
        {SUPPORT_ORDER.map(([s, tone]) => {
          const n = rows.filter(([, c]) => c.support === s).length;
          return n ? (
            <span key={s}>
              <StatusDot tone={tone} /> {n} {s}
            </span>
          ) : null;
        })}
        {caps.simulated ? <span className="muted">{t("setup.fromTheSimulationNotA")}</span> : null}
      </div>
      <Details summary={t("setup.fullCapabilityReport")}>
        <p className="small muted">{caps.note}</p>
        <CapabilityTable caps={caps.capabilities} />
        <p className="small muted" style={{ marginTop: 12 }}>{t("setup.requestedGsiComponentsCountAnd", { count: caps.requestedGsiComponents.length })}</p>
        <pre className="pre">{JSON.stringify({ requested: caps.requestedGsiComponents, summary: caps.telemetrySummary }, null, 2)}</pre>
      </Details>
    </>
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
            <div className="seg" role="radiogroup" aria-label={t("setup.observerAdapter")}>
              {(["none", "netcon", "keyboard"] as const).map((k) => (
                <button key={k} role="radio" aria-checked={s.kind === k} className={`seg-btn ${s.kind === k ? "is-on" : ""}`} onClick={() => set({ kind: k })}>
                  {k === "none" ? t("setup.noControl") : k === "netcon" ? t("setup.directConsoleNetcon") : t("setup.keyboardFallback")}
                </button>
              ))}
            </div>
            <p className="small muted">
              {s.kind === "none" && t("setup.matchframeWillRecommendShotsBut")}
              {s.kind === "netcon" && t("setup.sendsConsoleCommandsOverCs2")}
              {s.kind === "keyboard" && t("setup.sendsSpectatorNumberKeysTo")}
            </p>
            {s.kind === "netcon" ? (
              <>
                <div className="form-grid">
                  <Field label={t("setup.host")} hint={t("setup.loopbackOnlyTheConsoleChannel")}>
                    <select value={s.host} onChange={(e) => set({ host: e.target.value })}>
                      <option value="127.0.0.1">127.0.0.1</option>
                      <option value="localhost">{t("setup.localhost")}</option>
                      <option value="::1">::1</option>
                    </select>
                  </Field>
                  <Field label={t("setup.port")} hint={t("setup.cs2StartedWithToolsNetconport")}>
                    <input type="number" value={s.port} onChange={(e) => set({ port: Number(e.target.value) })} />
                  </Field>
                </div>
                <Details summary={t("setup.commandTemplates")}>
                  <div className="form-grid">
                    {Object.keys(DEFAULT_TEMPLATES).map((k) => (
                      <Field key={k} label={k} hint={TEMPLATE_HINTS[k]}>
                        <input className="mono" value={s.templates[k] ?? ""} placeholder={DEFAULT_TEMPLATES[k]} onChange={(e) => set({ templates: { ...s.templates, [k]: e.target.value } })} />
                      </Field>
                    ))}
                  </div>
                </Details>
              </>
            ) : null}
            {s.kind === "keyboard" ? (
              <Field label={t("setup.observerWindowTitleRegularExpression")}>
                <input className="mono" value={s.windowTitle} onChange={(e) => set({ windowTitle: e.target.value })} />
              </Field>
            ) : null}
            <div className="ga-actions">
              <ActionButton
                variant="primary"
                action={() => {
                  const templates = Object.fromEntries(Object.entries(s.templates).filter(([, v]) => v.trim() !== ""));
                  return api.put<ObserverAdapterResponse>("/api/v1/observer/adapter", { ...s, templates });
                }}
                success={(r) => t("setup.adapterSavedActiveV", { v: r.active ?? "none" })}
                onDone={() => void res.reload()}
                disabledReason={reason}
              >{t("setup.saveAdapter")}</ActionButton>
              <span className="small muted">{t("setup.activeVV2", { v: d.active ?? t("setup.none"), v2: d.active?.startsWith("sim") ? t("setup.theSimulationOwnsTheAdapter") : null })}</span>
            </div>
            {d.capabilities ? (
              <Details summary={t("setup.adapterCapabilities")}>
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
              </Details>
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
      <div className="row-end">
        <Field label={t("setup.player")} hint={t("setup.pickSomeoneWhoIsNot")}>
          <select value={steamId} onChange={(e) => setSteamId(e.target.value)}>
            <option value="">{players.length ? t("setup.chooseAPlayer2") : t("setup.noPlayersInGameData")}</option>
            {players.map((p) => (
              <option key={p.steamId} value={p.steamId} disabled={p.steamId === observed}>
                {p.name} ({p.side ?? "?"}){p.steamId === observed ? t("setup.currentlySpectated") : ""}
              </option>
            ))}
          </select>
        </Field>
        <ActionButton
          variant="primary"
          title={t("setup.requestsAPovChangeAnd")}
          action={() => api.post<PlayerSelectionTestResult>("/api/v1/setup/test-player-selection", { steamId })}
          onDone={setResult}
          success={(r) => (r.recorded ? t("setup.playerSelectionVerifiedAndRecorded") : r.confirmed ? t("setup.confirmedButNotRecordedSee") : t("setup.notConfirmed"))}
          disabledReason={reason ?? (!snap?.state ? t("setup.noTelemetryYetReceiveA") : steamId ? null : t("setup.chooseAPlayer"))}
        >{t("setup.testPlayerSelection")}</ActionButton>
      </div>
      {result ? (
        <>
          <Note tone={result.recorded ? "ok" : result.confirmed ? "warn" : "danger"}>
            {result.recorded
              ? t("setup.telemetryConfirmedTheRequestedPlayer")
              : result.simulated
                ? t("setup.theSimulationAdapterCannotCertify")
                : result.note ?? (result.confirmed ? t("setup.confirmedButThePlayerWas") : t("setup.telemetryDidNotShowThe"))}
          </Note>
          <Details summary={t("setup.testEvidence")}>
            <KV
              items={[
                [t("setup.requested"), name(result.requested)],
                [t("setup.observedBefore"), name(result.observedBefore)],
                [t("setup.observedAfter"), name(result.observedAfter)],
                [t("setup.transport"), result.transport],
                [t("setup.confirmedByTelemetry"), result.confirmed ? t("common.yes") : t("common.no")],
                [t("common.simulation"), result.simulated ? t("common.yes") : t("common.no")],
                [t("setup.build"), result.build ?? MISSING],
                [t("setup.at"), fmtTime(result.at)],
              ]}
            />
          </Details>
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
  const sel = status.verifiedControl.playerSelectionControl;
  const cam = status.verifiedControl.staticCameraControl;
  return (
    <>
      <div className="row-end">
        <Field label={mapName ? t("setup.cameraMapname", { mapName }) : t("setup.camera")} hint={mapName ? undefined : t("setup.needsLiveGameDataWith")}>
          <select value={cameraId} onChange={(e) => setCameraId(e.target.value)}>
            <option value="">{cams.length ? t("setup.chooseACamera2") : t("setup.noCamerasForThisMap")}</option>
            {cams.map((c) => (
              <option key={c.id} value={c.id}>
                {c.displayName} ({c.validation})
              </option>
            ))}
          </select>
        </Field>
        <ActionButton
          variant="primary"
          title={t("setup.telemetryCanOnlyShowConsistency")}
          action={() => api.post<{ transport: string; telemetryConsistent: boolean; nextStep: string }>("/api/v1/setup/test-static-camera", { cameraId })}
          onDone={setTest}
          success={(r) => t("setup.cameraCommandTransport", { transport: r.transport })}
          disabledReason={reason ?? (!snap?.state ? t("setup.noTelemetryYet") : cameraId ? null : t("setup.chooseACamera"))}
        >{t("setup.testCamera")}</ActionButton>
      </div>
      {test ? (
        <Note tone="info">
          <p style={{ marginTop: 0 }}>{t("setup.lookAtTheObserverClient")}</p>
          <div className="row">
            <ActionButton variant="primary" action={() => api.post<{ recorded: boolean; note: string }>("/api/v1/setup/confirm-static-camera", { cameraId, visible: true })} success={(r) => (r.recorded ? t("setup.staticCameraRecordedAsPartial") : r.note)} onDone={reload} disabledReason={reason}>{t("setup.yesTheExpectedViewIs")}</ActionButton>
            <ActionButton action={() => api.post("/api/v1/setup/confirm-static-camera", { cameraId, visible: false })} success={t("setup.recordedViewNotShownSupport")} onDone={reload} disabledReason={reason}>{t("setup.noItIsWrong")}</ActionButton>
          </div>
          <p className="small">{t("setup.sentViaTransportTelemetryV", { transport: test.transport, v: test.telemetryConsistent ? t("setup.consistent") : t("setup.notConsistent") })}</p>
        </Note>
      ) : null}
      <div className="ga-actions">
        <span className="small muted">{t("setup.verifiedPlayerSelectionVStatic", { v: sel ? `✓ (${sel.build ?? "?"})` : "—", v2: cam ? `✓ (${cam.support})` : "—" })}</span>
        <ActionButton size="sm" variant="ghost" action={() => api.post("/api/v1/setup/reset-verification")} success={t("setup.verificationEvidenceCleared")} onDone={reload} disabledReason={resetReason} confirm={{ title: t("setup.resetControlVerification"), body: t("setup.clearsRecordedPlayerSelectionAnd"), confirmLabel: t("setup.reset"), danger: true }}>{t("setup.resetVerification")}</ActionButton>
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
        <Field label={t("setup.obsWebsocketUrl")} hint={t("setup.obsToolsWebsocketServerSettings")}>
          <input value={url} onChange={(e) => setUrl(e.target.value)} style={{ width: 240 }} />
        </Field>
        <Field label={t("setup.password")}>
          <input type="password" autoComplete="off" value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
        <Checkbox checked={remember} onChange={setRemember} label={t("setup.rememberPassword")} hint={t("setup.storedInTheLocalSecret")} />
        <ActionButton
          variant="primary"
          title={t("setup.obsProvidesScenesSourcesRecording")}
          action={() => api.post<{ state: ObsState }>("/api/v1/obs/connect", { url, ...(password ? { password } : {}), remember })}
          success={(r) => (r.state.connected ? t("setup.connectedToObsV", { v: r.state.obsVersion ?? "" }) : t("setup.notConnectedV", { v: r.state.lastError ?? t("setup.unknownError") }))}
          onDone={reload}
          disabledReason={reason ?? (/^wss?:\/\//.test(url) ? null : t("setup.urlMustStartWithWs"))}
        >{t("setup.connectObs")}</ActionButton>
        {status.obs.connected ? (
          <ActionButton variant="ghost" action={() => api.post("/api/v1/obs/disconnect")} success={t("setup.obsDisconnected")} onDone={reload} disabledReason={reason}>{t("setup.disconnect")}</ActionButton>
        ) : null}
      </div>
      {status.obs.connected ? (
        <p className="small muted">{t("setup.connectedScenes", { count: status.obs.scenes })}</p>
      ) : null}
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
      <div className="form-grid">
        {(["LIVE", "REPLAY", "STUDIO", "BREAK"] as const).map((m) => (
          <Field key={m} label={{ LIVE: t("prod.liveScene"), REPLAY: t("prod.replayScene"), STUDIO: t("prod.studioScene"), BREAK: t("prod.breakScene") }[m]}>
            <input list="obs-scene-list" value={scenes[m] ?? ""} onChange={(e) => setScenes({ ...scenes, [m]: e.target.value || null })} placeholder={list.length ? t("setup.chooseOrType") : t("setup.obsSceneName")} />
          </Field>
        ))}
        <datalist id="obs-scene-list">
          {list.map((s) => (
            <option key={s} value={s} />
          ))}
        </datalist>
      </div>
      <div className="ga-actions">
        <ActionButton variant="primary" title={t("setup.matchframeOnlyReportsAProgram")} action={() => api.put("/api/v1/settings/program.scenes", { value: scenes })} success={t("setup.programScenesSaved")} onDone={reload} disabledReason={reason}>{t("setup.saveSceneMapping")}</ActionButton>
        {!obs.data?.state.connected ? <span className="small muted">{t("setup.obsIsNotConnectedSo")}</span> : null}
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
        <input readOnly value={url ?? status.hudUrl} aria-label={t("setup.mainHudUrl")} title={t("setup.carriesAReadOnlyOutput")} onFocus={(e) => e.target.select()} />
        <CopyButton text={url ?? status.hudUrl} label={t("setup.copyUrl")} size="md" />
      </div>
      <div className="ga-actions">
        <ActionButton action={() => api.post<{ sceneName?: string }>("/api/v1/obs/provision", {})} success={t("setup.browserSourceProvisionedInObs")} disabledReason={reason ?? (status.obs.connected ? null : t("setup.connectObsFirstStep9"))}>{t("setup.createTheBrowserSourceIn")}</ActionButton>
        <span className="small muted">{t("setup.orAddTheUrlTo")}</span>
      </div>
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
        <Field label={t("setup.profileName")}>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder={t("setup.eGMainStageObserver")} />
        </Field>
        <Field label={t("setup.sourceMode")}>
          <select value={sourceMode} onChange={(e) => setSourceMode(e.target.value as SetupProfile["sourceMode"])}>
            <option value="live_observer">{t("setup.liveObserver")}</option>
            <option value="demo_playback">{t("setup.demoPlayback")}</option>
            <option value="simulation">{t("common.simulation")}</option>
          </select>
        </Field>
        <Field label={t("setup.topology")}>
          <select value={topology} onChange={(e) => setTopology(e.target.value as SetupProfile["topology"])}>
            <option value="one_pc">{t("setup.onePc")}</option>
            <option value="multi_pc">{t("setup.multiPc")}</option>
          </select>
        </Field>
        <ActionButton
          variant="primary"
          title={t("setup.storesTheObserverAdapterProgram", { done: checklistProgress(items).done, count: items.length })}
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
          success={(p) => t("setup.profileNameSaved", { name: p.name })}
          onDone={() => void profiles.reload()}
          disabledReason={reason ?? (name.trim() ? null : t("setup.enterAProfileName"))}
        >{t("setup.saveSetupProfile")}</ActionButton>
      </div>
      <Async state={profiles}>
        {(list) =>
          list.length === 0 ? null : (
            <table className="table table-compact" style={{ marginTop: 12 }}>
              <thead>
                <tr>
                  <th>{t("setup.name")}</th>
                  <th>{t("setup.mode")}</th>
                  <th>{t("setup.topology")}</th>
                  <th>{t("setup.adapter")}</th>
                  <th>{t("setup.created")}</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {list.map((p) => (
                  <tr key={p.id}>
                    <td>{p.name}</td>
                    <td>{{ live_observer: t("setup.liveObserver"), demo_playback: t("setup.demoPlayback"), simulation: t("common.simulation") }[p.sourceMode] ?? p.sourceMode}</td>
                    <td>{p.topology === "one_pc" ? t("setup.onePc") : t("setup.multiPc")}</td>
                    <td>{String((p.observerAdapter as { kind?: string }).kind ?? "—")}</td>
                    <td>{fmtTime(p.createdAt)}</td>
                    <td>
                      <ActionButton size="sm" action={() => api.post(`/api/v1/setup/profiles/${seg(p.id)}/apply`)} success={t("setup.appliedName", { name: p.name })} disabledReason={reason} confirm={{ title: t("setup.applyProfileName", { name: p.name }), body: t("setup.replacesTheObserverAdapterSettings") }}>{t("setup.apply")}</ActionButton>
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
    // Deep links (/settings/setup#step-…, also via the old /setup path) scroll once the steps are rendered.
    const id = window.location.hash.slice(1);
    if (!id || !hasData) return;
    document.getElementById(id)?.scrollIntoView({ block: "start" });
  }, [hasData]);
  const prog = status.data ? checklistProgress(setupChecklist(status.data)) : null;
  return (
    <div className="page">
      <div className="page-head">
        <h1 className="page-title">{t("setup.setup")}</h1>
        {prog ? (
          <span className="muted">{t("setup.doneOfTotalDone", { done: prog.done, total: prog.total })}</span>
        ) : null}
      </div>
      <p className="page-intro">{t("setup.stepsAreMarkedDoneOnly")}</p>
      <Async state={status}>
        {(s) => {
          const reload = () => void status.reload();
          return (
            <div className="stack">
              <Panel title={t("setup.startCs2")} className="ga-group" id="start-cs2">
                <LaunchSettings />
              </Panel>
              <Panel title={t("setup.gameData")} className="ga-group">
                <Step n={1} id="step-source" title={t("setup.chooseTheSource")}>
                  <SourceMode status={s} reload={reload} />
                </Step>
                <Step n={2} id="step-detect" title={t("setup.detectCs2")} done={!!s.cs2Install}>
                  <DetectCs2 status={s} reload={reload} />
                </Step>
                <Step n={3} id="step-gsi" title={t("setup.writeTheGsiConfig")}>
                  <GsiConfig status={s} reload={reload} />
                </Step>
                <Step n={4} id="step-payload" title={t("setup.waitForARealPayload")} done={s.realPayloadReceived}>
                  <Payload status={s} />
                </Step>
                <Step n={5} id="step-capabilities" title={t("setup.capabilityReport")}>
                  <Async state={caps}>{(c) => <Capabilities caps={c} />}</Async>
                </Step>
              </Panel>
              <Panel title={t("setup.cameraControl")} className="ga-group">
                <Step n={6} id="step-adapter" title={t("setup.observerControlAdapter")} done={s.control.adapter !== "none"}>
                  <AdapterConfig />
                </Step>
                <Step n={7} id="step-selection" title={t("setup.playerSelectionTest")} done={!!s.verifiedControl.playerSelectionControl}>
                  <PlayerSelectionTest />
                </Step>
                <Step n={8} id="step-camera" title={t("setup.staticCameraTest")} done={!!s.verifiedControl.staticCameraControl}>
                  <StaticCameraTest status={s} reload={reload} />
                </Step>
              </Panel>
              <Panel title="OBS" className="ga-group">
                <Step n={9} id="step-obs" title={t("setup.connectObs")} done={s.obs.connected}>
                  <ObsConnect status={s} reload={reload} />
                </Step>
                <Step n={10} id="step-scenes" title={t("setup.programSceneMapping")} done={Object.values(s.obs.programScenes).some(Boolean)}>
                  <ProgramScenes status={s} reload={reload} />
                </Step>
                <Step n={11} id="step-hud" title={t("setup.mainHudBrowserSource")}>
                  <HudUrl status={s} />
                </Step>
              </Panel>
              <Panel title={t("setup.profiles")} className="ga-group">
                <Step n={12} id="step-profile" title={t("setup.saveASetupProfile")}>
                  <Profiles status={s} />
                </Step>
              </Panel>
            </div>
          );
        }}
      </Async>
    </div>
  );
}
