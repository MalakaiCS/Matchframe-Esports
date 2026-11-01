import { useEffect, useState } from "react";
import { api, describeError, seg } from "../../api/index.ts";
import { useToast } from "../../components/toasts.tsx";
import { ActionButton, Badge, Button, Checkbox, CopyButton, Details, Field, KV, Mono, Note, Panel } from "../../components/ui.tsx";
import { useApi } from "../../lib/hooks.ts";
import { usePermission } from "../../state/session.tsx";
import { fmtDelay } from "./TeamPanel.tsx";
import type { CommsPublicSettings, CommsSlot, CommsView, ObsAudioInput, ObsCheck } from "./types.ts";

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
  const bad = !Number.isInteger(s) || s < 0 || s > 300 ? "Seconds: 0 to 300" : !Number.isInteger(f) || f < -999 || f > 999 ? "Fine adjustment: −999 to 999 ms" : null;
  const changed = s !== view.settings.delaySec || f !== view.settings.fineMs;
  const apply = async () => {
    try {
      await api.put("/api/v1/comms/settings", { delaySec: s, fineMs: f });
      onChanged();
    } catch (e) {
      toast.push("danger", "Delay not changed", describeError(e));
    }
  };
  return (
    <Panel title="Delay" subtitle="Both teams share it: they play against the same gameplay. Match it to the observer's gameplay as it reaches the output.">
      <div className="stack-sm">
        <div className="row-end">
          <Field label="Seconds">
            <input type="number" min={0} max={300} step={1} value={sec} onChange={(e) => setSec(e.target.value)} />
          </Field>
          <Field label="Fine (ms)">
            <input type="number" min={-999} max={999} step={1} value={ms} onChange={(e) => setMs(e.target.value)} />
          </Field>
          <Button variant="primary" disabledReason={reason ?? bad ?? (changed ? null : "No change")} onClick={() => void apply()}>
            Apply delay
          </Button>
        </div>
        <KV
          items={[
            ["In effect", fmtDelay(view.delay.effectiveMs)],
            ...(view.delay.pendingMs !== null ? [["Changing to", `${fmtDelay(view.delay.pendingMs)} (muted, then re-buffering)`] as [string, string]] : []),
          ]}
        />
        <p className="muted small">A change mutes every output for a moment, then plays from the new delay once the buffers hold it (a longer delay re-buffers). Never less than {view.delay.floorMs} ms.</p>
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
      toast.push("danger", "Not changed", describeError(e));
    }
  };
  const b = view.bridge;
  return (
    <Panel title="Bridge and TeamSpeak plugin" subtitle="The Matchframe Team Comms plugin in TeamSpeak 3 hands each person's voice to Matchframe on this computer." actions={<Badge tone={b.state === "listening" ? (b.sessions ? "ok" : "warn") : b.state === "error" ? "danger" : "neutral"}>{b.state === "listening" ? (b.sessions ? `${b.sessions} plugin${b.sessions > 1 ? "s" : ""} connected` : "Waiting for the plugin") : b.state === "error" ? "Bridge error" : "Off"}</Badge>}>
      <div className="stack-sm">
        <Checkbox checked={view.enabled} disabled={!!reason} label="Team Comms on" hint="Off: nothing listens for the plugin, and no comms output runs." onChange={(v) => void toggle(v)} />
        {b.error ? <Note tone="danger">{b.error}</Note> : null}
        <KV
          items={[
            ["Bridge", b.port ? `127.0.0.1:${b.port} (this computer only)` : "—"],
            ["Token", "Kept in Matchframe's secure settings; the plugin reads it from the bridge file below. Never shown here."],
            ["Bridge file", <Mono key="f">{b.file}</Mono>],
            ...b.plugins.map((p) => [`Plugin ${p.instance.slice(0, 8)}`, `${p.plugin?.name ?? "plugin"} ${p.plugin?.version ?? ""} (API ${p.plugin?.apiVersion ?? "?"}) · TeamSpeak ${p.ts3?.clientLibVersion ?? "?"} · ${p.platform ?? "?"}`] as [string, string]),
          ]}
        />
        <div className="row">
          <ActionButton size="sm" action={() => api.post("/api/v1/comms/bridge/rotate-token")} success="New token: the plugin reconnects with it" onDone={onChanged} disabledReason={setup} confirm={{ title: "Rotate the plugin's token?", body: "The TeamSpeak plugin is disconnected and reconnects with the new token from the bridge file. An open listen-in closes (FAULT).", confirmLabel: "Rotate token" }}>
            Rotate token
          </ActionButton>
        </div>
        <Details summary="Install the TeamSpeak plugin">
          <ol className="small comms-steps">
            <li>Close TeamSpeak 3. Double-click <Mono>matchframe-team-comms.ts3_plugin</Mono> (in the program's <Mono>resources\ts3-plugin</Mono> folder), or copy the DLL into <Mono>%APPDATA%\TS3Client\plugins\</Mono>.</li>
            <li>Start TeamSpeak 3: Tools → Options → Add-ons → <em>Matchframe Team Comms</em> enabled.</li>
            <li>Connect one tab to each team's channel (a bookmark per team with Connect on startup). On a default server, give the second tab its own identity (Tools → Identities).</li>
            <li>Set each team's server and channel below. Matchframe takes over those two tabs: microphone off, sound silent on this computer, each person captured.</li>
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
      toast.push("ok", `${slot.team?.name ?? `Team ${slot.id}`}: TeamSpeak saved`);
      onChanged();
    } catch (e) {
      toast.push("danger", "Not saved", describeError(e));
    }
  };
  const field = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));
  return (
    <fieldset className="comms-slot-form">
      <legend>
        {slot.team?.name ?? `Team ${slot.id}`} <span className="muted small">(slot {slot.id})</span>
      </legend>
      <div className="row-end">
        <Field label="Server address">
          <input value={f.serverHost} onChange={field("serverHost")} placeholder="ts.example.org" />
        </Field>
        <Field label="Port">
          <input type="number" value={f.serverPort} onChange={field("serverPort")} style={{ width: 90 }} />
        </Field>
        <Field label="Channel">
          <input value={f.channel} onChange={field("channel")} placeholder="Team channel name" />
        </Field>
      </div>
      <div className="row-end">
        <Field label="Server password" hint={slot.serverPasswordSaved ? "Saved (not shown)" : "None saved"}>
          <input type="password" autoComplete="off" value={f.serverPassword} onChange={field("serverPassword")} />
        </Field>
        <Field label="Channel password" hint={slot.channelPasswordSaved ? "Saved (not shown)" : "None saved"}>
          <input type="password" autoComplete="off" value={f.channelPassword} onChange={field("channelPassword")} />
        </Field>
        <Field label="Server unique id (optional)">
          <input value={f.serverUid} onChange={field("serverUid")} />
        </Field>
        <Button disabledReason={disabledReason} onClick={() => void save()}>
          Save
        </Button>
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
      toast.push("danger", "Not saved", describeError(e));
    }
  };
  const st = o.stats;
  return (
    <Panel title="Public output to OBS (NDI)" subtitle="Audio only, sent by Matchframe. OBS takes it with DistroAV; its silence when no listen-in is open is Matchframe's, not an OBS mute." actions={<Badge tone={o.state === "running" ? "ok" : o.state === "error" ? "danger" : o.state === "starting" ? "info" : "neutral"}>{o.state === "running" ? "Sending" : o.state === "error" ? "Not sending" : o.state === "starting" ? "Starting" : "Off"}</Badge>}>
      <div className="stack-sm">
        <p className="small">{o.detail}</p>
        <KV
          items={[
            [o.names.public, st ? `${st.connections.public} receiver${st.connections.public === 1 ? "" : "s"} connected (OBS is one)` : "—"],
            [o.names.recording, st ? `${st.connections.recording} receiver${st.connections.recording === 1 ? "" : "s"} connected · for the dedicated recording (phase 4)` : "—"],
            ["Format", "48 kHz stereo, 32-bit float, 10 ms frames"],
            ["Timing", st ? `sent ${Math.round(st.lagMs)} ms after the output time (set ${s.latencyMs} ms) · ${st.underruns} gaps · ${st.late} late · ${st.resyncs} resyncs` : "—"],
            ["Public silenced", `${view.onAir.outputs.publicGuard.blocksSilenced} blocks sent as silence while closed`],
          ]}
        />
        <Details summary="Output settings">
          <div className="stack-sm">
            <Checkbox checked={s.enabled} disabled={!!reason} label="Send the NDI outputs" hint="Off: nothing reaches OBS (a listen-in can still be opened)." onChange={(v) => void save({ enabled: v })} />
            <Field label="Send latency (ms)" hint="Room for the engine's timing: each 10 ms block leaves this long after its own time. Compensate in the delay's fine adjustment.">
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
      toast.push("danger", "Not saved", describeError(e));
    }
  };
  const st = view.onAir.ducking;
  return (
    <Panel title="Caster ducking" subtitle="The casters' microphones go down in OBS while a listen-in is open, and back when it ends." actions={<Badge tone={st.state === "lowered" ? "accent" : st.state === "pending" ? "warn" : st.state === "idle" ? "ok" : "neutral"}>{st.state === "lowered" ? "Casters down" : st.state === "pending" ? "Not put back yet" : st.state === "idle" ? "Ready" : "Off"}</Badge>}>
      <div className="stack-sm">
        <Checkbox checked={d.enabled} disabled={!!reason} label="Turn the casters down during a listen-in" onChange={(v) => void save({ enabled: v })} />
        <div className="row-end">
          <Field label={`Down by ${-d.amountDb} dB`}>
            <input type="range" min={-40} max={0} step={1} aria-label="Ducking amount (dB)" defaultValue={d.amountDb} disabled={!!reason} onPointerUp={(e) => void save({ amountDb: Number((e.target as HTMLInputElement).value) })} onKeyUp={(e) => void save({ amountDb: Number((e.target as HTMLInputElement).value) })} />
          </Field>
          <Field label="Ramp (ms)">
            <input type="number" min={0} max={3000} defaultValue={d.rampMs} onBlur={(e) => Number(e.target.value) !== d.rampMs && void save({ rampMs: Number(e.target.value) })} />
          </Field>
        </div>
        <div className="field" role="group" aria-label="Caster inputs in OBS">
          <span className="field-label">Caster inputs in OBS</span>
          <div className="comms-inputs">
            {inputs.data?.error ? <Note tone="warn">{inputs.data.error}</Note> : null}
            {(inputs.data?.inputs ?? []).map((i) => (
              <Checkbox key={i.name} checked={d.inputs.includes(i.name)} disabled={!!reason} label={`${i.name} (${i.kind}, ${i.muted ? "muted" : `${i.db} dB`})`} onChange={(on) => void save({ inputs: on ? [...d.inputs, i.name] : d.inputs.filter((n) => n !== i.name) })} />
            ))}
            {inputs.data && !inputs.data.error && inputs.data.inputs.length === 0 ? <span className="muted small">OBS has no audio inputs.</span> : null}
          </div>
        </div>
        <p className="small">{st.detail}</p>
        {st.lastRelease ? <p className="muted small">Last put back: {st.lastRelease.detail}</p> : null}
        <p className="muted small">With a break's replays turning the same input down, whichever ends last puts it back. A fader moved by hand meanwhile is left where it was put.</p>
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
      toast.push("danger", "Not saved", describeError(e));
    }
  };
  return (
    <Panel title="Public Team Comms graphic" subtitle="A TEAM COMMS banner with the team's name and logo while it is on air. Team only: it never names or shows who is speaking." actions={o.onAir ? <Badge tone="accent">On air</Badge> : <Badge>Hidden</Badge>}>
      <div className="stack-sm">
        <div className="row">
          <Mono>{o.url}</Mono>
          <CopyButton text={o.url} />
        </div>
        <div className="row-end">
          <Field label="Position">
            <select value={o.placement.anchor} disabled={!!reason} onChange={(e) => void save({ anchor: e.target.value as "top" | "bottom" })}>
              <option value="top">Top centre</option>
              <option value="bottom">Bottom centre</option>
            </select>
          </Field>
          <Field label="From the edge (px)">
            <input type="number" min={0} max={1000} defaultValue={o.placement.offsetPx} onBlur={(e) => Number(e.target.value) !== o.placement.offsetPx && void save({ offsetPx: Number(e.target.value) })} />
          </Field>
        </div>
        <div className="row">
          <ActionButton
            action={() => api.post<{ scene: string; source: string; created: boolean; onTop: boolean }>("/api/v1/comms/overlay/obs")}
            success={(r) => `${r.created ? `“${r.source}” added on top of “${r.scene}”` : `“${r.source}” in “${r.scene}” points at this page`}${r.onTop ? "" : " (move it to the top in OBS)"}`}
            disabledReason={setup ?? (!o.obsConnected ? "Connect OBS first (Settings → Devices)" : !o.liveScene ? "Map the live scene first (Settings → Setup → OBS scenes)" : null)}
          >
            Add to the live scene in OBS
          </ActionButton>
          <span className="muted small">{o.liveScene ? `Live scene: ${o.liveScene}` : "No live scene mapped"} · {o.pages} page{o.pages === 1 ? "" : "s"} open</span>
        </div>
      </div>
    </Panel>
  );
}

/** OBS's side of the routing, checked from OBS's own lists. */
export function ObsCheckPanel() {
  const [res, setRes] = useState<ObsCheck | null>(null);
  return (
    <Panel title="OBS routing check" subtitle="Desktop Audio off, the comms source in the live scene and not monitored, the recording source kept off air, TeamSpeak not captured. Then do the listening tests in the setup guide.">
      <div className="stack-sm">
        <div className="row">
          <ActionButton action={() => api.get<ObsCheck>("/api/v1/comms/obs/check")} onDone={setRes}>
            Check OBS routing
          </ActionButton>
        </div>
        {res ? (
          <ul className="comms-checks">
            {res.checks.map((c) => (
              <li key={c.id} className={c.ok === false ? "is-bad" : c.ok ? "is-ok" : ""}>
                <Badge tone={c.ok === false ? "danger" : c.ok ? "ok" : "neutral"} icon={c.ok === false ? "✗" : c.ok ? "✓" : "?"}>
                  {c.ok === false ? "Fix" : c.ok ? "OK" : "Unknown"}
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
