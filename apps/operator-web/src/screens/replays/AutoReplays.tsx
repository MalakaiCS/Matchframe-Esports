import { useEffect, useRef, useState } from "react";
import { api, describeError } from "../../api/index.ts";
import type { AutoReplayResponse, AutoReplaySettings, NetworkInfo, ReplayPcResponse } from "../../api/types.ts";
import { ActionButton, Badge, Button, Checkbox, CopyButton, Field, Note, Panel, Tabs } from "../../components/ui.tsx";
import { useToast } from "../../components/toasts.tsx";
import { useApi } from "../../lib/hooks.ts";
import { useSnapshot } from "../../state/live.ts";
import { usePermission } from "../../state/session.tsx";

const STATE_TONE = { off: "neutral", waiting: "info", playing: "accent", blocked: "warn" } as const;
const SPEEDS = [100, 75, 50] as const;

/**
 * Main PC: replays play by themselves in the break after a round: kills the main camera missed
 * (sent by the replay PC) and, optionally, 3K+ the main camera showed (this computer's OBS replay
 * buffer).
 */
export function AutoReplaysPanel() {
  const auto = useApi<AutoReplayResponse>("/api/v1/replays/auto", { refreshMs: 1000 });
  const reason = usePermission("replay.control");
  const setupReason = usePermission("settings.manage");
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const save = async (patch: Partial<AutoReplaySettings>) => {
    setBusy(true);
    try {
      auto.setData(await api.put<AutoReplayResponse>("/api/v1/replays/auto", patch));
    } catch (e) {
      toast.push("danger", "Setting not saved", describeError(e));
    } finally {
      setBusy(false);
    }
  };
  const st = auto.data?.settings;
  const status = auto.data?.status;
  const off = !!reason || busy || !st;
  return (
    <Panel title="Automatic replays" subtitle={status?.detail} actions={status ? <Badge tone={STATE_TONE[status.state]}>{status.state === "playing" ? "Playing" : status.enabled ? "On" : "Off"}</Badge> : null}>
      <div className="stack-sm">
        <Checkbox checked={st?.enabled ?? false} disabled={off} label="Play replays by themselves" hint="In the break after a round: from a few seconds after it ends until just before freeze time ends. Never while a round is live." onChange={(v) => void save({ enabled: v })} />
        <div className="form-grid">
          <Field label="Replays per break">
            <select value={st?.maxPerBreak ?? 2} disabled={off} onChange={(e) => void save({ maxPerBreak: Number(e.target.value) })}>
              {[1, 2, 3, 4].map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Speed">
            <select value={st?.speedPercent ?? 100} disabled={off} onChange={(e) => void save({ speedPercent: Number(e.target.value) })}>
              {SPEEDS.map((s) => (
                <option key={s} value={s}>
                  {s === 100 ? "Real time" : `Slow motion (${s} %)`}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <Checkbox checked={st?.otherAngles ?? true} disabled={off} label="Other angles" hint="When the main camera showed only the player who died, replay it from the killer's side (from the replay PC)." onChange={(v) => void save({ otherAngles: v })} />
        <Checkbox checked={st?.ownBigPlays ?? true} disabled={off} label="Replay big plays shown live" hint="When the main camera shows a 3K or more, save this computer's OBS replay buffer and replay it too." onChange={(v) => void save({ ownBigPlays: v })} />
        <div className="row">
          <ActionButton action={() => api.post<{ scene: string; input: string }>("/api/v1/replays/obs-setup")} success={(r) => `OBS: scene “${r.scene}” with the media source “${r.input}” is ready`} onDone={() => void auto.reload()} disabledReason={setupReason}>
            Set up OBS replay scene
          </ActionButton>
          <span className="muted small">Adds a “Matchframe Replay” scene to OBS and uses it. Put a stinger transition in OBS for a broadcast wipe.</span>
        </div>
        {status?.lastPlayed ? <p className="small muted">Last replay: {status.lastPlayed.label}</p> : null}
      </div>
    </Panel>
  );
}

const TIMING_TONE = { measuring: "info", live: "neutral", behind: "ok", ahead: "warn" } as const;

function timingLabel(t: ReplayPcResponse["status"]["timing"]): string {
  if (t.delayMs === null || t.state === "measuring") return "Timing…";
  const s = (Math.abs(t.delayMs) / 1000).toFixed(1);
  return t.state === "behind" ? `${s} s behind` : t.state === "ahead" ? `${s} s ahead` : "Same time";
}

const SECOND_CSTV = "tv_enable1 1\ntv_port1 27021\ntv_delay1 17";

/** The best setup: this computer a few seconds behind the main PC, so it knows each missed kill before it plays here. */
function BehindHelp() {
  return (
    <details className="small">
      <summary>Best: this computer about 7 s behind the main PC</summary>
      <div className="stack-sm">
        <p>Then every kill the main camera misses is known here before it happens on this computer: the camera gets on the killer first and the whole kill is filmed. The program measures how far behind it is by itself.</p>
        <ul>
          <li>Main PC in the server as a spectator: watch the server's CSTV here, with a CSTV delay of about 7 s (tv_delay 7).</li>
          <li>
            Main PC on CSTV: give the server a second CSTV, 7 s later than the first, and connect to it here (connect server-address:27021). With the main CSTV at tv_delay 10:
            <div className="row">
              <code className="mono">{SECOND_CSTV.replace(/\n/g, "; ")}</code>
              <CopyButton text={SECOND_CSTV} label="Copy" />
            </div>
          </li>
        </ul>
      </div>
    </details>
  );
}

/** Setting up the two computers: the main PC lets the replay PC in, the replay PC connects to it. */
export function ReplayPcPanel() {
  const link = useApi<ReplayPcResponse>("/api/v1/replay-pc", { refreshMs: 1500 });
  const isReplayPc = link.data?.settings.enabled ?? false;
  const [tab, setTab] = useState<"main" | "replay">("main");
  // Open on the side this computer is set up as, once; then the operator's choice stays.
  const chosen = useRef(false);
  useEffect(() => {
    if (link.data && !chosen.current) {
      chosen.current = true;
      setTab(link.data.settings.enabled ? "replay" : "main");
    }
  }, [link.data]);
  return (
    <Panel title="Replay PC" subtitle="A second computer with its own CS2 and OBS that films the kills this camera misses.">
      <Tabs
        label="Which computer this is"
        value={tab}
        onChange={setTab}
        tabs={[
          { id: "main" as const, label: "This is the main PC" },
          { id: "replay" as const, label: isReplayPc ? "This is the replay PC ●" : "This is the replay PC" },
        ]}
      />
      {tab === "main" ? <MainSide /> : <ReplaySide data={link.data ?? null} reload={() => void link.reload()} />}
    </Panel>
  );
}

function MainSide() {
  const reason = usePermission("settings.manage");
  const net = useApi<NetworkInfo>("/api/v1/network", { refreshMs: 5000 });
  const bridge = typeof window !== "undefined" ? window.matchframe?.network : undefined;
  const [access, setAccess] = useState<boolean | null>(null);
  const [code, setCode] = useState<string | null>(null);
  const toast = useToast();
  useEffect(() => {
    void bridge?.get().then((r) => setAccess(r?.networkAccess ?? null));
  }, [bridge]);
  const toggle = async (on: boolean) => {
    const r = await bridge?.set(on);
    if (r) {
      setAccess(r.networkAccess);
      toast.push("info", on ? "Other computers can connect" : "Only this computer can connect", "The engine restarts; the console reconnects by itself.");
    }
  };
  const addresses = net.data?.addresses ?? [];
  const port = net.data?.apiPort ?? 37211;
  return (
    <div className="stack-sm">
      <ol className="steps small">
        <li>Let other computers connect to this one.</li>
        <li>Make a replay PC code and type it, with this computer's address, on the replay PC.</li>
        <li>Turn on automatic replays above.</li>
      </ol>
      {bridge ? (
        <Checkbox checked={access === true} disabled={!!reason || access === null} label="Let other computers on the network connect" hint="They still need a code from this computer. Windows may ask to allow Matchframe through the firewall: allow it on private networks." onChange={(v) => void toggle(v)} />
      ) : (
        <Note tone="neutral">Network access is set in the Matchframe program on the main PC.</Note>
      )}
      {net.data?.reachable ? (
        addresses.length ? (
          <div className="stack-sm">
            <span className="small muted">This computer's address (use one the replay PC can reach):</span>
            {addresses.map((a) => (
              <div key={a} className="row">
                <code>{`${a}:${port}`}</code>
                <CopyButton text={`${a}:${port}`} label="Copy" />
              </div>
            ))}
          </div>
        ) : (
          <Note tone="warn">This computer has no network address. Connect it to the same network as the replay PC.</Note>
        )
      ) : net.data ? (
        <p className="small muted">Only this computer can connect right now.</p>
      ) : null}
      <div className="row">
        <ActionButton
          action={() => api.post<{ token: string }>("/api/v1/tokens", { role: "replay", label: `Replay PC (${new Date().toLocaleDateString()})` })}
          success="Replay PC code made: type it on the replay PC"
          onDone={(t) => setCode(t.token)}
          disabledReason={reason}
        >
          Make a replay PC code
        </ActionButton>
      </div>
      {code ? (
        <div className="row">
          <code className="mono">{code}</code>
          <CopyButton text={code} label="Copy code" />
          <span className="muted small">Shown once. Remove it in Settings → Access to lock the replay PC out.</span>
        </div>
      ) : null}
    </div>
  );
}

function ReplaySide({ data, reload }: { data: ReplayPcResponse | null; reload: () => void }) {
  const reason = usePermission("settings.manage");
  const snap = useSnapshot();
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");
  useEffect(() => {
    if (data?.settings.mainUrl) setUrl(data.settings.mainUrl.replace(/^https?:\/\//, ""));
  }, [data?.settings.mainUrl]);
  const st = data?.status;
  const nameOf = (id: string | null) => (id ? (snap?.state?.players.find((p) => p.steamId === id)?.name ?? id) : "nobody");
  const enabled = data?.settings.enabled ?? false;
  return (
    <div className="stack-sm">
      <ol className="steps small">
        <li>On this computer: Start CS2 and spectate the same match, connect OBS (Game Capture of CS2) and start the Auto Director.</li>
        <li>Type the main PC's address and its replay PC code below.</li>
      </ol>
      <BehindHelp />
      <div className="form-grid">
        <Field label="Main PC address" hint="As shown on the main PC, e.g. 192.168.1.20:37211">
          <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="192.168.1.20:37211" spellCheck={false} />
        </Field>
        <Field label="Replay PC code" hint={data?.hasToken ? "A code is saved; type a new one to replace it." : "Made on the main PC."}>
          <input value={token} onChange={(e) => setToken(e.target.value)} type="password" autoComplete="off" spellCheck={false} placeholder={data?.hasToken ? "••••••••" : ""} />
        </Field>
      </div>
      <div className="row">
        <ActionButton
          variant="primary"
          action={() => api.put<ReplayPcResponse>("/api/v1/replay-pc", { enabled: true, mainUrl: url, ...(token ? { token } : {}) })}
          success="Connecting to the main PC"
          onDone={() => {
            setToken("");
            reload();
          }}
          disabledReason={reason ?? (!url.trim() ? "Type the main PC's address" : !token && !data?.hasToken ? "Type the replay PC code" : null)}
        >
          {enabled ? "Save and reconnect" : "Make this the replay PC"}
        </ActionButton>
        {enabled ? (
          <Button variant="ghost" disabledReason={reason} onClick={() => void api.put("/api/v1/replay-pc", { enabled: false }).then(reload)}>
            Stop being the replay PC
          </Button>
        ) : null}
      </div>
      {enabled ? (
        <Checkbox
          checked={data?.settings.rewind ?? false}
          disabled={!!reason}
          label="Rewind to film a missed kill (experimental)"
          hint="When this computer is at the same time as the main PC and its camera didn't have the killer, CS2 goes back a few seconds, films the kill and skips forward to live again. Only a CSTV+ stream (playcast) can go back; with a CSTV connection the program says so and films someone else."
          onChange={(v) => void api.put("/api/v1/replay-pc", { rewind: v }).then(reload)}
        />
      ) : null}
      {st && st.enabled ? (
        <div className="stack-sm small" role="status">
          <div className="row">
            <Badge tone={st.state === "connected" ? "ok" : st.state === "error" ? "warn" : "info"}>{st.state === "connected" ? "Linked" : st.state === "error" ? "Not linked" : "Connecting"}</Badge>
            <span>{st.detail}</span>
          </div>
          {st.state === "connected" ? (
            <div className="row">
              <Badge tone={TIMING_TONE[st.timing.state]}>{timingLabel(st.timing)}</Badge>
              <span>{st.timing.detail}</span>
            </div>
          ) : null}
          {st.state === "connected" && st.timing.state !== "behind" ? <span>The main camera shows {nameOf(st.mainObserved)}: this computer's Auto Director films someone else.</span> : null}
          {data?.settings.rewind && st.rewind.detail ? <span className={st.rewind.state === "unsupported" ? "text-warn" : ""}>Rewinding: {st.rewind.detail}</span> : null}
          {st.filming ? <span>Filming now: {st.filming}{st.planned ? ` (${st.planned} more planned)` : ""}</span> : null}
          <span className={st.obsReady ? "" : "text-warn"}>{st.obsReady ? "OBS replay buffer is running." : "Connect OBS on this computer (Settings → Devices); its replay buffer starts by itself."}</span>
          <span>
            Clips sent: {st.sent}
            {st.failed ? `, not sent: ${st.failed}` : ""}
            {st.last ? ` · last: ${st.last.label}${st.last.ok ? "" : ` (${st.last.error})`}` : ""}
          </span>
          {st.lastSkip ? (
            <span className="muted">
              Not filmed: {st.skipped} · last: {st.lastSkip.label} ({st.lastSkip.reason})
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
