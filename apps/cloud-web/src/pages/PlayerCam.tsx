import { useEffect, useRef, useState } from "react";
import type { CamRoomInfo } from "@matchframe/cloud-contracts";
import { api, describeError, isApiError } from "../api/index.ts";
import { Alert, Badge, Button, Card, Loading, PageHeader, SelectField } from "../components/ui.tsx";
import { useTitle } from "../lib/hooks.ts";
import { CamSender, canSend, type SenderState, type SenderStats } from "../lib/camSender.ts";

/**
 * Player cams (ADR-048): the page a production sends its players. It shows the match being played;
 * the player picks themselves and a camera, checks the preview, and sends it. The production's
 * program receives it through the website and shows it in the broadcast (delayed to match the game).
 */

type Step = "player" | "camera" | "sending";

const STATUS_TEXT: Record<string, { tone: "ok" | "info" | "warn" | "neutral"; title: string; body: string }> = {
  waiting_host: { tone: "warn", title: "Waiting for the production", body: "Your camera is ready. It goes through as soon as the production's program is connected. Keep this page open." },
  waiting_approval: { tone: "info", title: "Waiting for the production to approve", body: "The production can see your camera and will put it on air when they're ready. Keep this page open." },
  live: { tone: "ok", title: "Your camera is live", body: "The production is receiving your camera. Keep this page open while you play; you can put the game on top." },
  hidden: { tone: "neutral", title: "Connected, not on air", body: "The production has your camera but isn't showing it right now. Keep this page open." },
};

const remembered = (room: string) => {
  try {
    return localStorage.getItem(`mf-cam-${room}`);
  } catch {
    return null;
  }
};

export function PlayerCam({ room }: { room: string }) {
  useTitle("Player camera", "Send your camera to the production of the match you're playing.");
  const [info, setInfo] = useState<CamRoomInfo | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notOpen, setNotOpen] = useState(false);
  const [step, setStep] = useState<Step>("player");
  const [playerKey, setPlayerKey] = useState<string | null>(() => remembered(room));
  const [supported, setSupported] = useState<boolean | null>(null);

  // The room: on load, then every 10 s while not sending (the production connecting, the roster changing).
  useEffect(() => {
    let live = true;
    const load = () =>
      api
        .camRoom(room)
        .then((r) => {
          if (!live) return;
          setInfo(r);
          setNotOpen(false);
          setLoadError(null);
        })
        .catch((e) => {
          if (!live) return;
          if (isApiError(e, "not_found")) setNotOpen(true);
          else setLoadError(describeError(e));
        });
    void load();
    const t = step === "sending" ? null : setInterval(load, 10_000);
    return () => {
      live = false;
      if (t) clearInterval(t);
    };
  }, [room, step]);

  useEffect(() => {
    if (info && supported === null) void canSend(info.quality).then(setSupported);
  }, [info, supported]);

  const player = info?.teams.flatMap((t) => t.players.map((p) => ({ ...p, team: t.name }))).find((p) => p.key === playerKey) ?? null;

  if (notOpen)
    return (
      <>
        <PageHeader title="Player camera" />
        <Alert tone="warn" title="This camera link isn't open">
          The production hasn't opened player cams for this link, or the link has changed. Ask them for the current link.
        </Alert>
      </>
    );
  if (!info) return loadError ? <Alert tone="danger" title="Can't load the match">{loadError}</Alert> : <Loading label="Loading the match…" />;

  return (
    <>
      <PageHeader eyebrow="Player camera" title={info.title || "Your match"} subtitle="Send your camera to the production. They show it in the broadcast when the observer is on you." />
      {supported === false ? (
        <Alert tone="danger" title="This browser can't send your camera">
          Open this link in Google Chrome or Microsoft Edge on your computer.
        </Alert>
      ) : null}
      {step === "player" || !player ? (
        <PickPlayer
          info={info}
          selected={playerKey}
          onPick={(key) => {
            setPlayerKey(key);
            try {
              localStorage.setItem(`mf-cam-${room}`, key);
            } catch {
              // private mode: just not remembered
            }
            setStep("camera");
          }}
        />
      ) : (
        <CameraStep
          key={player.key}
          room={room}
          info={info}
          player={player}
          sending={step === "sending"}
          disabled={supported === false}
          onBack={() => setStep("player")}
          onSending={(on) => setStep(on ? "sending" : "camera")}
        />
      )}
    </>
  );
}

function PickPlayer({ info, selected, onPick }: { info: CamRoomInfo; selected: string | null; onPick: (key: string) => void }) {
  return (
    <Card title="Who are you?">
      {info.teams.every((t) => t.players.length === 0) ? (
        <p className="muted">The production hasn't listed the players yet. This page updates by itself.</p>
      ) : (
        <div className="two-col cam-teams">
          {info.teams.map((t, i) => (
            <div key={`${t.name}-${i}`} className="stack">
              <h3 className="h3">{t.name || `Team ${i + 1}`}</h3>
              <div className="stack cam-players">
                {t.players.map((p) => (
                  <Button key={p.key} variant={p.key === selected ? "primary" : "secondary"} block onClick={() => onPick(p.key)}>
                    {p.name}
                  </Button>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

function CameraStep({ room, info, player, sending, disabled, onBack, onSending }: { room: string; info: CamRoomInfo; player: { key: string; name: string; team: string }; sending: boolean; disabled: boolean; onBack: () => void; onSending: (on: boolean) => void }) {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  /** The camera shown in the list, and the one the player picked (opening the camera again). */
  const [deviceId, setDeviceId] = useState<string>("");
  const [chosen, setChosen] = useState<string>("");
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [camError, setCamError] = useState<string | null>(null);
  const [state, setState] = useState<SenderState | null>(null);
  const [stats, setStats] = useState<SenderStats | null>(null);
  const video = useRef<HTMLVideoElement>(null);
  const sender = useRef<CamSender | null>(null);

  // The camera: ask once, then list the cameras (names appear only after permission). Opened again
  // only for another camera or other video settings (the room is fetched again every few seconds).
  const qualityKey = JSON.stringify(info.quality);
  useEffect(() => {
    let live = true;
    let opened: MediaStream | null = null;
    const q = JSON.parse(qualityKey) as CamRoomInfo["quality"];
    const md = navigator.mediaDevices;
    if (!md?.getUserMedia) {
      setCamError("This browser has no camera access. Open the link in Chrome or Edge.");
      return;
    }
    md.getUserMedia({ audio: false, video: { ...(chosen ? { deviceId: { exact: chosen } } : {}), width: { ideal: q.width }, height: { ideal: q.height }, frameRate: { ideal: q.fps }, aspectRatio: { ideal: 16 / 9 } } })
      .then(async (s) => {
        if (!live) {
          s.getTracks().forEach((t) => t.stop());
          return;
        }
        opened = s;
        setStream(s);
        setCamError(null);
        const all = (await md.enumerateDevices()).filter((d) => d.kind === "videoinput");
        if (!live) return;
        setDevices(all);
        setDeviceId(s.getVideoTracks()[0]?.getSettings().deviceId ?? all[0]?.deviceId ?? "");
      })
      .catch((e: Error) => {
        if (!live) return;
        setStream(null);
        setCamError(e.name === "NotAllowedError" ? "The browser was not allowed to use your camera. Allow the camera for this site (the camera icon in the address bar), then reload." : e.name === "NotFoundError" ? "No camera found. Plug one in and reload." : `Your camera couldn't start: ${e.message}`);
      });
    return () => {
      live = false;
      opened?.getTracks().forEach((t) => t.stop());
    };
  }, [chosen, qualityKey]);

  useEffect(() => {
    if (video.current) video.current.srcObject = stream;
  }, [stream]);

  // Stop sending when the page goes away.
  useEffect(() => () => sender.current?.stop(), []);

  useEffect(() => {
    if (!sending) return;
    const t = setInterval(() => setStats(sender.current?.stats() ?? null), 1000);
    return () => clearInterval(t);
  }, [sending]);

  function start() {
    if (!stream) return;
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    const label = stream.getVideoTracks()[0]?.label ?? "Camera";
    const s = new CamSender({
      url: `${proto}//${window.location.host}/v1/cams/${encodeURIComponent(room)}/publish?key=${encodeURIComponent(player.key)}`,
      stream,
      quality: info.quality,
      camera: label,
      onState: (st) => {
        setState(st);
        if (st.kind === "kicked" || st.kind === "error") {
          sender.current?.stop();
          sender.current = null;
          onSending(false);
          setState(st);
        }
      },
    });
    sender.current = s;
    s.start();
    onSending(true);
  }

  function stop() {
    sender.current?.stop();
    sender.current = null;
    setState(null);
    onSending(false);
  }

  const status = state?.kind === "status" ? STATUS_TEXT[state.status] : null;
  return (
    <div className="stack-lg">
      {sending ? (
        <>
          {state?.kind === "connecting" ? <Alert tone="info" title="Connecting…" /> : null}
          {state?.kind === "reconnecting" ? <Alert tone="warn" title="Connection lost">Trying again in {state.inSec} s. Keep this page open.</Alert> : null}
          {status ? (
            <Alert tone={status.tone === "neutral" ? "info" : status.tone} title={status.title}>
              {status.body}
            </Alert>
          ) : null}
          {stats ? (
            <p className="small muted">
              <Badge tone={state?.kind === "status" && state.status === "live" ? "ok" : "neutral"}>{stats.width}×{stats.height}</Badge> {stats.kbps} kbit/s · {stats.frames} frames sent
              {stats.timerSource ? " · keep this window visible: this browser slows your camera down when the game covers it (Chrome and Edge don't)." : ""}
            </p>
          ) : null}
        </>
      ) : null}
      <Card
        title={`${player.name} · ${player.team || "your team"}`}
        actions={
          sending ? null : (
            <Button size="sm" variant="ghost" onClick={onBack}>
              Not you?
            </Button>
          )
        }
      >
        <div className="stack">
          <div className="cam-preview">
            <video ref={video} autoPlay muted playsInline aria-label="Your camera preview" />
            {!stream && !camError ? <div className="cam-preview-empty muted">Starting your camera…</div> : null}
          </div>
          <p className="small muted">This is what the production receives (not mirrored).</p>
          {camError ? <Alert tone="danger">{camError}</Alert> : null}
          {!sending && devices.length > 1 ? (
            <SelectField
              label="Camera"
              value={deviceId}
              onValue={(v) => {
                setDeviceId(v);
                setChosen(v);
              }}
            >
              {devices.map((d, i) => (
                <option key={d.deviceId || i} value={d.deviceId}>
                  {d.label || `Camera ${i + 1}`}
                </option>
              ))}
            </SelectField>
          ) : null}
          {sending ? (
            <div className="button-row">
              <Button variant="danger" onClick={stop}>
                Stop sending
              </Button>
            </div>
          ) : (
            <div className="button-row">
              <Button variant="primary" size="lg" onClick={start} disabled={!stream || disabled} disabledReason={!stream ? "Your camera isn't on yet" : disabled ? "This browser can't send video" : null}>
                Approve and send
              </Button>
            </div>
          )}
        </div>
      </Card>
      {!sending && state?.kind === "kicked" ? <Alert tone="warn" title="The production stopped your camera">{state.reason}</Alert> : null}
      {!sending && state?.kind === "error" ? <Alert tone="danger" title="Sending stopped">{state.message}</Alert> : null}
    </div>
  );
}
