import type { CameraPose } from "@matchframe/director-policy";

/**
 * The HLAE camera: every free-camera and moving shot played by HLAE (AfxHookSource2) instead of
 * console commands. A Matchframe script loaded into CS2 with `mirv_script_load` connects to the
 * engine over a local WebSocket and sets the rendered view on every frame
 * (`mirv.events.cViewRenderSetupView`), from timed poses the engine sends. Moves are as smooth as
 * the game's frame rate, independent of console timing, and HLAE confirms when a shot is on screen.
 * The way Lexogrine HUD Manager runs its cinematics.
 */

/** A pose `t` ms into a shot (Hammer units, degrees; yaw already unwrapped between keys). */
export interface HlaeKey {
  t: number;
  x: number;
  y: number;
  z: number;
  pitch: number;
  yaw: number;
  fov?: number;
}

/** The view HLAE reported when a shot came on screen. */
export interface HlaeView {
  x: number;
  y: number;
  z: number;
  rX: number;
  rY: number;
  rZ: number;
  fov: number;
}

/** The engine side of the connection to the script in CS2. */
export interface HlaeCameraLink {
  /** The script is connected (and HLAE camera shots are switched on). */
  connected(): boolean;
  /** Plays `keys` (the last is held); resolves with the first frame HLAE drew, or null on timeout or disconnect. */
  play(keys: HlaeKey[], opts?: { timeoutMs?: number }): Promise<{ view: HlaeView } | null>;
  /** A streamed shot: the view eases towards this pose every frame. */
  live(pose: CameraPose): void;
  /** Stops overriding the view: back to what CS2 shows (the spectated player). */
  release(): void;
}

/** Shots are sent as poses this far apart; HLAE interpolates between them every frame. */
export const HLAE_KEY_STEP_MS = 33;

const keyOf = (t: number, p: CameraPose): HlaeKey => ({ t: Math.round(t), x: round(p.position.x), y: round(p.position.y), z: round(p.position.z), pitch: round(p.pitch), yaw: round(p.yaw) });
const round = (v: number) => Math.round(v * 1000) / 1000;

/** Samples a move (`pose(t)` for t in 0..durationMs) into keys, unwrapping yaw so HLAE turns the short way. */
export function hlaeKeys(pose: (t: number) => CameraPose | null, durationMs: number, stepMs = HLAE_KEY_STEP_MS): HlaeKey[] {
  const keys: HlaeKey[] = [];
  const times: number[] = [];
  for (let t = 0; t < durationMs; t += stepMs) times.push(t);
  times.push(Math.max(0, durationMs));
  for (const t of times) {
    const p = pose(t);
    if (!p) break;
    const k = keyOf(t, p);
    const prev = keys[keys.length - 1];
    if (prev) {
      if (k.t === prev.t) continue;
      k.yaw = round(prev.yaw + ((((k.yaw - prev.yaw) % 360) + 540) % 360) - 180);
    }
    keys.push(k);
  }
  return keys;
}

/**
 * The script HLAE runs in CS2 (Boa JavaScript, mirv-script API of HLAE 2.162+; `mirv.events` from
 * 2.190, the older `mirv.on…` hooks before that). It connects to `url`, retrying every second, and
 * overrides the view only while a shot is on; when the connection drops it stops overriding at once
 * (the game's own camera is shown). Loading it again replaces the running copy.
 */
export function hlaeCameraScript(url: string): string {
  return `// Matchframe camera for HLAE. Written by the Matchframe program each time CS2 starts with HLAE; do not edit.
{
  const ID = "matchframe-camera";
  const URL = ${JSON.stringify(url)};
  const old = globalThis[ID];
  if (old && old.stop) {
    try { old.stop(); } catch (e) {}
  }
  const S = { inS: null, outS: null, open: false, connecting: false, stopped: false, q: [], sending: false, msgs: [], frame: 0, shot: null, live: null, cur: null, t: 0, wall: null };

  function drop() {
    try { if (S.inS) S.inS.drop(); } catch (e) {}
    try { if (S.outS) S.outS.drop(); } catch (e) {}
    S.inS = null; S.outS = null; S.open = false; S.q = []; S.sending = false;
    // Never left on a camera nobody controls.
    S.shot = null; S.live = null; S.cur = null;
  }
  function pump() {
    if (S.sending || !S.outS || S.q.length === 0) return;
    S.sending = true;
    const m = S.q.shift();
    S.outS.send(m).then(function () { S.sending = false; pump(); }, function () { drop(); });
  }
  function send(o) { if (S.open) { S.q.push(JSON.stringify(o)); pump(); } }
  function read() {
    if (!S.inS) return;
    S.inS.next().then(function (m) {
      if (m === null) { drop(); return; }
      if (typeof m === "string") S.msgs.push(m);
      read();
    }, function () { drop(); });
  }
  function connect() {
    if (S.connecting || S.open || S.stopped) return;
    S.connecting = true;
    mirv.connect_async(URL).then(function (ws) {
      S.connecting = false;
      if (S.stopped) { try { ws.in.drop(); ws.out.drop(); } catch (e) {} return; }
      S.inS = ws.in; S.outS = ws.out; S.open = true;
      send({ type: "hello", script: 1 });
      read();
    }, function () { S.connecting = false; });
  }
  function handle(text) {
    let m;
    try { m = JSON.parse(text); } catch (e) { return; }
    if (m.type === "shot" && m.keys && m.keys.length) { S.shot = { id: m.id, keys: m.keys, t0: null, acked: false }; S.live = null; }
    else if (m.type === "live" && m.pose) { S.shot = null; S.live = m.pose; }
    else if (m.type === "release") { S.shot = null; S.live = null; S.cur = null; }
    else if (m.type === "ping") send({ type: "pong", id: m.id });
  }
  function sample(keys, t) {
    if (t <= keys[0].t) return keys[0];
    const last = keys[keys.length - 1];
    if (t >= last.t) return last;
    let lo = 0, hi = keys.length - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (keys[mid].t <= t) lo = mid; else hi = mid; }
    const a = keys[lo], b = keys[hi], u = (t - a.t) / (b.t - a.t);
    const l = function (p, q) { return p + (q - p) * u; };
    const out = { x: l(a.x, b.x), y: l(a.y, b.y), z: l(a.z, b.z), pitch: l(a.pitch, b.pitch), yaw: l(a.yaw, b.yaw) };
    if (a.fov !== undefined && b.fov !== undefined) out.fov = l(a.fov, b.fov);
    return out;
  }
  function ease(cur, to, dtMs) {
    const k = 1 - Math.pow(0.5, dtMs / 80);
    let dy = ((((to.yaw - cur.yaw) % 360) + 540) % 360) - 180;
    return { x: cur.x + (to.x - cur.x) * k, y: cur.y + (to.y - cur.y) * k, z: cur.z + (to.z - cur.z) * k, pitch: cur.pitch + (to.pitch - cur.pitch) * k, yaw: cur.yaw + dy * k };
  }
  // How long the frame being drawn is (ms). HLAE's absTime is CS2's absoluteframetime: the length
  // of this frame in seconds, not a clock. Shots run on the sum of the frames' lengths, the way
  // HLAE's own camera (mirv_input) moves; the wall clock only where absTime is missing.
  function frameMs(e) {
    const a = e.absTime;
    if (typeof a === "number" && a >= 0) return Math.min(a, 5) * 1000;
    const w = Date.now();
    const d = S.wall === null ? 16 : Math.max(0, Math.min(5000, w - S.wall));
    S.wall = w;
    return d;
  }
  function onView(e) {
    const dt = frameMs(e);
    S.t += dt;
    const now = S.t;
    let p = null;
    if (S.shot) {
      const sh = S.shot;
      if (sh.t0 === null) sh.t0 = now;
      p = sample(sh.keys, now - sh.t0);
      if (!sh.acked) { sh.acked = true; send({ type: "started", id: sh.id, view: e.currentView }); }
    } else if (S.live) {
      p = S.cur ? ease(S.cur, S.live, Math.min(100, dt)) : S.live;
    }
    if (!p) return undefined;
    S.cur = p;
    const v = { x: p.x, y: p.y, z: p.z, rX: p.pitch, rY: p.yaw, rZ: 0 };
    if (p.fov !== undefined) v.fov = p.fov;
    return v;
  }
  function onFrame(e) {
    // FRAME_START (0): once a tick; FRAME_RENDER_PASS (12): before each frame is drawn.
    if (e.curStage === 0 && e.isBefore) {
      if (!S.open && S.frame % 64 === 0) connect();
      S.frame++;
      while (S.msgs.length) handle(S.msgs.shift());
      mirv.run_jobs();
      mirv.run_jobs_async();
      pump();
    }
  }
  const ev = mirv.events;
  if (ev && ev.cViewRenderSetupView && ev.clientFrameStageNotify) {
    ev.cViewRenderSetupView.on(ID, onView);
    ev.clientFrameStageNotify.on(ID, onFrame);
  } else {
    mirv.onCViewRenderSetupView = onView;
    mirv.onClientFrameStageNotify = onFrame;
  }
  globalThis[ID] = {
    stop: function () {
      S.stopped = true;
      if (ev && ev.cViewRenderSetupView && ev.clientFrameStageNotify) {
        ev.cViewRenderSetupView.off(ID);
        ev.clientFrameStageNotify.off(ID);
      } else {
        mirv.onCViewRenderSetupView = undefined;
        mirv.onClientFrameStageNotify = undefined;
      }
      try { if (S.outS) S.outS.close(); } catch (e) {}
      drop();
    },
  };
  mirv.message("Matchframe camera: connecting to the Matchframe program\\n");
}
`;
}
