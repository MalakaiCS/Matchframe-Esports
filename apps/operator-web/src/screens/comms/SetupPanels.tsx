import { useEffect, useState } from "react";
import { api, describeError, seg } from "../../api/index.ts";
import { useToast } from "../../components/toasts.tsx";
import { ActionButton, Badge, Button, Checkbox, CopyButton, Details, Field, KV, Mono, Note, Panel } from "../../components/ui.tsx";
import { useApi } from "../../lib/hooks.ts";
import { usePermission } from "../../state/session.tsx";
import { fmtDelay } from "./TeamPanel.tsx";
import type { CommsPublicSettings, CommsSlot, CommsView, ObsAudioInput, ObsCheck } from "./types.ts";
import { t } from "../../i18n/index.ts";
import { T } from "../../i18n/T.tsx";

type Reload = () => void;

/** The delay both teams play at: seconds plus a fine adjustment in ms (saved with the engine's settings). */
export function TimingPanel({ view, onChanged }: { view: CommsView; onChanged: Reload }) {
  const reason = usePermission("program.control");
  const toast = useToast();
  const [sec, setSec] = useState(String(view.settings.delaySec));
  const [ms, setMs] = useState(String(view.settings.fineMs));
  useEffect(() => {
    setSec(String(view.settings.delaySec));
    setMs(String(view.settings.fineMs));
  }, [view.settings.delaySec, view.settings.fineMs]);
  const s = Number(sec);
  const f = Number(ms);
  const bad = !Number.isInteger(s) || s < 0 || s > 300 ? t("comms.seconds0To300") : !Number.isInteger(f) || f < -999 || f > 999 ? t("comms.fineAdjustment999To999") : null;
  const changed = s !== view.settings.delaySec || f !== view.settings.fineMs;
  const apply = async () => {
    try {
      await api.put("/api/v1/comms/settings", { delaySec: s, fineMs: f });
      onChanged();
    } catch (e) {
      toast.push("danger", t("comms.delayNotChanged"), describeError(e));
    }
  };
  return (
    <Panel title={t("comms.delay")} subtitle={t("comms.bothTeamsShareItThey")}>
      <div className="stack-sm">
        <div className="row-end">
          <Field label={t("comms.seconds")}>
            <input type="number" min={0} max={300} step={1} value={sec} onChange={(e) => setSec(e.target.value)} />
          </Field>
          <Field label={t("comms.fineMs")}>
            <input type="number" min={-999} max={999} step={1} value={ms} onChange={(e) => setMs(e.target.value)} />
          </Field>
          <Button variant="primary" disabledReason={reason ?? bad ?? (changed ? null : t("comms.noChange"))} onClick={() => void apply()}>{t("comms.applyDelay")}</Button>
        </div>
        <KV
          items={[
            [t("comms.inEffect"), fmtDelay(view.delay.effectiveMs)],
            ...(view.delay.pendingMs !== null ? [[t("comms.changingTo"), t("comms.delayRebuffering", { delay: fmtDelay(view.delay.pendingMs) })] as [string, string]] : []),
          ]}
        />
        <p className="muted small">{t("comms.aChangeMutesEveryOutput", { floorMs: view.delay.floorMs })}</p>
      </div>
    </Panel>
  );
}

/** Team Comms on/off, the TeamSpeak plugin and bridge, each team slot's TeamSpeak server and channel. */
export function BridgePanel({ view, onChanged }: { view: CommsView; onChanged: Reload }) {
  const reason = usePermission("program.control");
  const setup = usePermission("settings.manage");
  const toast = useToast();
  const toggle = async (on: boolean) => {
    try {
      await api.put("/api/v1/comms/settings", { enabled: on });
      onChanged();
    } catch (e) {
      toast.push("danger", t("comms.notChanged"), describeError(e));
    }
  };
  const b = view.bridge;
  return (
    <Panel title={t("comms.bridgeAndTeamspeakPlugin")} subtitle={t("comms.theMatchframeTeamCommsPlugin")} actions={<Badge tone={b.state === "listening" ? (b.sessions ? "ok" : "warn") : b.state === "error" ? "danger" : "neutral"}>{b.state === "listening" ? (b.sessions ? t("comms.pluginsConnected", { count: b.sessions }) : t("comms.waitingForThePlugin")) : b.state === "error" ? t("comms.bridgeError") : t("comms.off")}</Badge>}>
      <div className="stack-sm">
        <Checkbox checked={view.enabled} disabled={!!reason} label={t("comms.teamCommsOn")} hint={t("comms.offNothingListensForThe")} onChange={(v) => void toggle(v)} />
        {b.error ? <Note tone="danger">{b.error}</Note> : null}
        <KV
          items={[
            [t("comms.kvBridge"), b.port ? t("comms.bridgeLocalOnly", { address: `127.0.0.1:${b.port}` }) : "—"],
            [t("comms.kvToken"), t("comms.tokenKept")],
            [t("comms.kvBridgeFile"), <Mono key="f">{b.file}</Mono>],
            ...b.plugins.map((p) => [t("comms.pluginInstance", { id: p.instance.slice(0, 8) }), t("comms.vV2ApiV3Teamspeak", { v: p.plugin?.name ?? t("comms.plugin"), v2: p.plugin?.version ?? "", v3: p.plugin?.apiVersion ?? "?", v4: p.ts3?.clientLibVersion ?? "?", v5: p.platform ?? "?" })] as [string, string]),
          ]}
        />
        {view.tabs && view.tabs.length ? (
          <table className="table comms-tabs" aria-label={t("comms.teamspeakTabs")}>
            <thead>
              <tr>
                <th>{t("comms.teamspeakTab")}</th>
                <th>{t("comms.is")}</th>
              </tr>
            </thead>
            <tbody>
              {view.tabs.map((tRow) => (
                <tr key={tRow.key}>
                  <td className="small">
                    {t("comms.vOnV2", { v: tRow.channel?.name ?? "—", v2: tRow.server?.name ?? tRow.server?.host ?? "—" })}
                    <div className="muted">{t("comms.asVStatus", { v: tRow.listener?.nickname ?? "?", status: tRow.status })}</div>
                  </td>
                  <td className="small">
                    {tRow.team ? (
                      <Badge tone={tRow.capturing ? "ok" : "warn"} icon={tRow.capturing ? "●" : "◔"}>
                        {t("comms.teamSlotVV2", { slot: tRow.team.slot, v: tRow.team.name ?? "?", v2: tRow.capturing ? t("comms.capturedSuffix") : t("comms.connectingSuffix") })}
                      </Badge>
                    ) : (
                      <span className="muted">{tRow.released ? t("comms.notATeamTabHanded") : t("comms.notATeamTab")}</span>
                    )}
                    {tRow.restoredByPlugin ? <div className="muted">{t("comms.keptListenOnlyAndSilent")}</div> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
        <div className="row">
          <ActionButton size="sm" action={() => api.post("/api/v1/comms/bridge/rotate-token")} success={t("comms.newTokenThePluginReconnects")} onDone={onChanged} disabledReason={setup} confirm={{ title: t("comms.rotateThePluginSToken"), body: t("comms.theTeamspeakPluginIsDisconnected"), confirmLabel: t("comms.rotateToken") }}>{t("comms.rotateToken")}</ActionButton>
        </div>
        <Details summary={t("comms.installTheTeamspeakPlugin")}>
          <ol className="small comms-steps">
            <li><T k="comms.closeTeamspeak3DoubleClick" values={{ mono: <Mono>matchframe-team-comms.ts3_plugin</Mono>, mono2: <Mono>resources\ts3-plugin</Mono>, mono3: <Mono>%APPDATA%\TS3Client\plugins\</Mono> }} /></li>
            <li><T k="comms.startTeamspeak3ToolsOptions2" tags={{ em: (c) => <em>{c}</em> }} /></li>
            <li>{t("comms.connectOneTabToEach")}</li>
            <li>{t("comms.setEachTeamSServer")}</li>
          </ol>
        </Details>
        {view.slots.map((s) => (
          <SlotForm key={s.id} slot={s} onChanged={onChanged} disabledReason={setup} />
        ))}
      </div>
    </Panel>
  );
}

function SlotForm({ slot, onChanged, disabledReason }: { slot: CommsSlot; onChanged: Reload; disabledReason: string | null }) {
  const toast = useToast();
  const [f, setF] = useState({ serverHost: slot.config.serverHost, serverPort: String(slot.config.serverPort), serverUid: slot.config.serverUid, channel: slot.config.channel, serverPassword: "", channelPassword: "" });
  const save = async () => {
    try {
      await api.put(`/api/v1/comms/slots/${seg(slot.id)}`, { serverHost: f.serverHost.trim(), serverPort: Number(f.serverPort) || 9987, serverUid: f.serverUid.trim(), channel: f.channel.trim(), ...(f.serverPassword ? { serverPassword: f.serverPassword } : {}), ...(f.channelPassword ? { channelPassword: f.channelPassword } : {}) });
      setF((x) => ({ ...x, serverPassword: "", channelPassword: "" }));
      toast.push("ok", t("comms.vTeamspeakSaved", { v: slot.team?.name ?? t("comms.teamId", { id: slot.id }) }));
      onChanged();
    } catch (e) {
      toast.push("danger", t("comms.notSaved"), describeError(e));
    }
  };
  const field = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));
  return (
    <fieldset className="comms-slot-form">
      <legend>
        {slot.team?.name ?? t("comms.teamId", { id: slot.id })} <span className="muted small">{t("comms.slotId", { id: slot.id })}</span>
      </legend>
      <div className="row-end">
        <Field label={t("comms.serverAddress")}>
          <input value={f.serverHost} onChange={field("serverHost")} placeholder="ts.example.org" />
        </Field>
        <Field label={t("comms.port")}>
          <input type="number" value={f.serverPort} onChange={field("serverPort")} style={{ width: 90 }} />
        </Field>
        <Field label={t("comms.channel")}>
          <input value={f.channel} onChange={field("channel")} placeholder={t("comms.teamChannelName")} />
        </Field>
      </div>
      {slot.connectLink ? (
        <div className="row small">
          <span>{t("comms.teamspeakLinkNoPasswordIn")}</span> <Mono>{slot.connectLink}</Mono> <CopyButton text={slot.connectLink} label={t("comms.copyLink")} />
          {window.matchframe?.connectionMode !== "remote" ? (
            <a className="btn btn-sm" href={slot.connectLink} target="_blank" rel="noreferrer">{t("comms.connectInTeamspeak")}</a>
          ) : null}
        </div>
      ) : null}
      <div className="row-end">
        <Field label={t("comms.serverPassword")} hint={slot.serverPasswordSaved ? t("comms.savedNotShown") : t("comms.noneSaved")}>
          <input type="password" autoComplete="off" value={f.serverPassword} onChange={field("serverPassword")} />
        </Field>
        <Field label={t("comms.channelPassword")} hint={slot.channelPasswordSaved ? t("comms.savedNotShown") : t("comms.noneSaved")}>
          <input type="password" autoComplete="off" value={f.channelPassword} onChange={field("channelPassword")} />
        </Field>
        <Field label={t("comms.serverUniqueIdOptional")}>
          <input value={f.serverUid} onChange={field("serverUid")} />
        </Field>
        <Button disabledReason={disabledReason} onClick={() => void save()}>{t("comms.save")}</Button>
      </div>
    </fieldset>
  );
}

/** The NDI senders OBS receives with DistroAV: "MatchFrame Comms" (public) and "MatchFrame Comms Recording". */
export function OutputsPanel({ view, onChanged }: { view: CommsView; onChanged: Reload }) {
  const reason = usePermission("program.control");
  const toast = useToast();
  const o = view.onAir.outputs.ndi;
  const s = view.onAir.settings.ndi;
  const save = async (patch: Partial<CommsPublicSettings["ndi"]>) => {
    try {
      await api.put("/api/v1/comms/public", { ndi: patch });
      onChanged();
    } catch (e) {
      toast.push("danger", t("comms.notSaved"), describeError(e));
    }
  };
  const st = o.stats;
  return (
    <Panel title={t("comms.publicOutputToObsNdi")} subtitle={t("comms.audioOnlySentByMatchframe")} actions={<Badge tone={o.state === "running" ? "ok" : o.state === "error" ? "danger" : o.state === "starting" ? "info" : "neutral"}>{o.state === "running" ? t("comms.sending") : o.state === "error" ? t("comms.notSending") : o.state === "starting" ? t("comms.starting") : t("comms.off")}</Badge>}>
      <div className="stack-sm">
        <p className="small">{o.detail}</p>
        <KV
          items={[
            [o.names.public, st ? t("comms.receiversPublic", { count: st.connections.public }) : "—"],
            [o.names.recording, st ? t("comms.receiversRecording", { count: st.connections.recording }) : "—"],
            [t("comms.format"), t("comms.ndiFormat")],
            [t("comms.kvTiming"), st ? t("comms.ndiTiming", { lag: Math.round(st.lagMs), set: s.latencyMs, underruns: st.underruns, late: st.late, resyncs: st.resyncs }) : "—"],
            [t("comms.publicSilenced"), t("comms.blocksSilenced", { n: view.onAir.outputs.publicGuard.blocksSilenced })],
            ...(o.restarts ? [[t("comms.restarts"), `${t("comms.restartsDetail", { n: o.restarts, code: o.lastExit?.code ?? "?", s: Math.round((o.lastExit?.ranMs ?? 0) / 1000) })}${o.nextStartInMs != null ? t("comms.startingAgainIn", { s: Math.ceil(o.nextStartInMs / 1000) }) : ""}`] as [string, string]] : []),
          ]}
        />
        {o.state === "error" ? <Note tone="danger" title={t("comms.nothingReachesObs")}>{t("comms.detailThePublicRouteIs", { detail: o.detail })}</Note> : null}
        <Details summary={t("comms.outputSettings")}>
          <div className="stack-sm">
            <Checkbox checked={s.enabled} disabled={!!reason} label={t("comms.sendTheNdiOutputs")} hint={t("comms.offNothingReachesObsA")} onChange={(v) => void save({ enabled: v })} />
            <Field label={t("comms.sendLatencyMs")} hint={t("comms.roomForTheEngineS")}>
              <input type="number" min={20} max={500} defaultValue={s.latencyMs} onBlur={(e) => Number(e.target.value) !== s.latencyMs && void save({ latencyMs: Number(e.target.value) })} />
            </Field>
          </div>
        </Details>
      </div>
    </Panel>
  );
}

/** Caster ducking through OBS while a listen-in is open (released as it ends; operator changes kept). */
export function DuckingPanel({ view, onChanged }: { view: CommsView; onChanged: Reload }) {
  const reason = usePermission("program.control");
  const toast = useToast();
  const d = view.onAir.settings.duck;
  const inputs = useApi<{ inputs: ObsAudioInput[]; error: string | null }>("/api/v1/comms/obs/inputs");
  const save = async (patch: Partial<CommsPublicSettings["duck"]>) => {
    try {
      await api.put("/api/v1/comms/public", { duck: patch });
      onChanged();
      void inputs.reload();
    } catch (e) {
      toast.push("danger", t("comms.notSaved"), describeError(e));
    }
  };
  const st = view.onAir.ducking;
  return (
    <Panel title={t("comms.casterDucking")} subtitle={t("comms.theCastersMicrophonesGoDown")} actions={<Badge tone={st.state === "lowered" ? "accent" : st.state === "pending" ? "warn" : st.state === "idle" ? "ok" : "neutral"}>{st.state === "lowered" ? t("comms.castersDown") : st.state === "pending" ? t("comms.notPutBackYet") : st.state === "idle" ? t("comms.ready") : t("comms.off")}</Badge>}>
      <div className="stack-sm">
        <Checkbox checked={d.enabled} disabled={!!reason} label={t("comms.turnTheCastersDownDuring")} onChange={(v) => void save({ enabled: v })} />
        <div className="row-end">
          <Field label={t("comms.downByVDb", { v: -d.amountDb })}>
            <input type="range" min={-40} max={0} step={1} aria-label={t("comms.duckingAmountDb")} defaultValue={d.amountDb} disabled={!!reason} onPointerUp={(e) => void save({ amountDb: Number((e.target as HTMLInputElement).value) })} onKeyUp={(e) => void save({ amountDb: Number((e.target as HTMLInputElement).value) })} />
          </Field>
          <Field label={t("comms.rampMs")}>
            <input type="number" min={0} max={3000} defaultValue={d.rampMs} onBlur={(e) => Number(e.target.value) !== d.rampMs && void save({ rampMs: Number(e.target.value) })} />
          </Field>
        </div>
        <div className="field" role="group" aria-label={t("comms.casterInputsInObs")}>
          <span className="field-label">{t("comms.casterInputsInObs")}</span>
          <div className="comms-inputs">
            {inputs.data?.error ? <Note tone="warn">{inputs.data.error}</Note> : null}
            {(inputs.data?.inputs ?? []).map((i) => (
              <Checkbox key={i.name} checked={d.inputs.includes(i.name)} disabled={!!reason} label={`${i.name} (${i.kind}, ${i.muted ? t("comms.mutedLower") : `${i.db} dB`})`} onChange={(on) => void save({ inputs: on ? [...d.inputs, i.name] : d.inputs.filter((n) => n !== i.name) })} />
            ))}
            {inputs.data && !inputs.data.error && inputs.data.inputs.length === 0 ? <span className="muted small">{t("comms.obsHasNoAudioInputs")}</span> : null}
          </div>
        </div>
        <p className="small">{st.detail}</p>
        {st.lastRelease ? <p className="muted small">{t("comms.lastPutBackDetail", { detail: st.lastRelease.detail })}</p> : null}
        <p className="muted small">{t("comms.withABreakSReplays")}</p>
      </div>
    </Panel>
  );
}

/** The team-only TEAM COMMS banner for the live scene. */
export function OverlayPanel({ view, onChanged }: { view: CommsView; onChanged: Reload }) {
  const reason = usePermission("program.control");
  const setup = usePermission("settings.manage");
  const toast = useToast();
  const o = view.onAir.overlay;
  const save = async (patch: Partial<CommsPublicSettings["overlay"]>) => {
    try {
      await api.put("/api/v1/comms/public", { overlay: patch });
      onChanged();
    } catch (e) {
      toast.push("danger", t("comms.notSaved"), describeError(e));
    }
  };
  return (
    <Panel title={t("comms.publicTeamCommsGraphic")} subtitle={t("comms.aTeamCommsBannerWith")} actions={o.onAir ? <Badge tone="accent">{t("comms.onAir")}</Badge> : <Badge>{t("comms.hidden")}</Badge>}>
      <div className="stack-sm">
        <div className="row">
          <Mono>{o.url}</Mono>
          <CopyButton text={o.url} />
        </div>
        <div className="row-end">
          <Field label={t("comms.position")}>
            <select value={o.placement.anchor} disabled={!!reason} onChange={(e) => void save({ anchor: e.target.value as "top" | "bottom" })}>
              <option value="top">{t("comms.topCentre")}</option>
              <option value="bottom">{t("comms.bottomCentre")}</option>
            </select>
          </Field>
          <Field label={t("comms.fromTheEdgePx")}>
            <input type="number" min={0} max={1000} defaultValue={o.placement.offsetPx} onBlur={(e) => Number(e.target.value) !== o.placement.offsetPx && void save({ offsetPx: Number(e.target.value) })} />
          </Field>
        </div>
        <div className="row">
          <ActionButton
            action={() => api.post<{ scene: string; source: string; created: boolean; onTop: boolean }>("/api/v1/comms/overlay/obs")}
            success={(r) => `${r.created ? t("comms.sourceAddedOnTopOf", { source: r.source, scene: r.scene }) : t("comms.sourceInScenePointsAt", { source: r.source, scene: r.scene })}${r.onTop ? "" : t("comms.moveItToTheTop")}`}
            disabledReason={setup ?? (!o.obsConnected ? t("comms.connectObsFirstSettingsDevices") : !o.liveScene ? t("comms.mapTheLiveSceneFirst") : null)}
          >{t("comms.addToTheLiveScene")}</ActionButton>
          <span className="muted small">{t("comms.pagesOpen", { v: o.liveScene ? t("comms.liveSceneLivescene", { liveScene: o.liveScene }) : t("comms.noLiveSceneMapped"), count: o.pages })}</span>
        </div>
      </div>
    </Panel>
  );
}

/** OBS's side of the routing, checked from OBS's own lists. */
export function ObsCheckPanel() {
  const [res, setRes] = useState<ObsCheck | null>(null);
  return (
    <Panel title={t("comms.obsRoutingCheck")} subtitle={t("comms.desktopAudioOffTheComms")}>
      <div className="stack-sm">
        <div className="row">
          <ActionButton action={() => api.get<ObsCheck>("/api/v1/comms/obs/check")} onDone={setRes}>{t("comms.checkObsRouting")}</ActionButton>
        </div>
        {res ? (
          <ul className="comms-checks">
            {res.checks.map((c) => (
              <li key={c.id} className={c.ok === false ? "is-bad" : c.ok ? "is-ok" : ""}>
                <Badge tone={c.ok === false ? "danger" : c.ok ? "ok" : "neutral"} icon={c.ok === false ? "✗" : c.ok ? "✓" : "?"}>
                  {c.ok === false ? t("comms.fix") : c.ok ? "OK" : t("common.unknown")}
                </Badge>{" "}
                <strong>{c.title}</strong> <span className="small">{c.detail}</span>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </Panel>
  );
}
