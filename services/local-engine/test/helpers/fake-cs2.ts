import { createServer, type Server, type Socket } from "node:net";
import type { SyntheticPlayer } from "../../../../packages/cs2-state/src/testing/gsi-builder.ts";
import { buildSyntheticGsiPayload, syntheticRoster } from "../../../../packages/cs2-state/src/testing/gsi-builder.ts";

export interface ConsoleLine {
  at: number;
  line: string;
}

/**
 * A stand-in for CS2 spectating a match over time: its console takes spec_player / spec_mode /
 * spec_goto and answers getpos like the game, and its game data (every 100 ms) follows the camera
 * and a scripted round: `phase(t)` and `positions(t)` give the round phase, the seconds left in it
 * and where each player is, `t` ms after `start()`.
 */
export class TimedCs2 {
  readonly roster: SyntheticPlayer[] = syntheticRoster();
  readonly lines: ConsoleLine[] = [];
  observed: string | null = this.roster[0]!.steamId;
  free = false;
  pose = { x: 0, y: 0, z: 0, pitch: 0, yaw: 0 };
  /** Strafing the free camera (+left/+right held, CS2's strafe keys): -1/0/1 at 400 units a second, since when. */
  strafe = { dir: 0, since: 0 };
  t0 = 0;
  private seq = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private server: Server | null = null;
  private readonly sockets = new Set<Socket>();

  constructor(
    private readonly opts: {
      gsiUrl: string;
      token: string;
      map: string;
      /** The free camera's spec_mode on this "build". */
      freeMode?: string;
      /** The spec_modes that reach a player (first person, chase) on this "build"; others leave the camera where it is. Default: every one but the free camera's. */
      playerModes?: string[];
      /** `countdown`: the countdown's phase when it isn't the round's (a timeout in freeze time: "timeout_ct"). */
      phase: (t: number) => { phase: "freezetime" | "live" | "over"; endsInSec: number; round: number; countdown?: string };
      positions: (t: number, p: SyntheticPlayer) => { x: number; y: number; z: number };
      /** How far the game data lags the console (like CS2's: the camera changes before the game data says so). */
      gsiLagMs?: number;
    },
  ) {}

  /** What the camera showed at each moment (for game data that lags the console). */
  private readonly views: { at: number; free: boolean; observed: string | null }[] = [];

  private viewAt(t: number): { free: boolean; observed: string | null } {
    let v = { free: this.free, observed: this.observed };
    for (let i = this.views.length - 1; i >= 0; i--) {
      if (this.views[i]!.at <= t) {
        v = this.views[i]!;
        break;
      }
    }
    return v;
  }

  /** Starts the console on `port`. */
  async listen(port: number): Promise<void> {
    this.server = createServer((sock) => {
      this.sockets.add(sock);
      sock.on("close", () => this.sockets.delete(sock));
      let buf = "";
      sock.on("data", (d) => {
        buf += d.toString();
        const parts = buf.split("\n");
        buf = parts.pop() ?? "";
        for (const l of parts.filter(Boolean)) this.onLine(l, sock);
      });
    });
    await new Promise<void>((r) => this.server!.listen(port, "127.0.0.1", () => r()));
  }

  now(): number {
    return Date.now() - this.t0;
  }

  onLine(line: string, sock: Socket): void {
    this.lines.push({ at: this.now(), line });
    const freeMode = this.opts.freeMode ?? "spec_mode 6";
    for (const cmd of line.split(";").map((c) => c.trim())) {
      if (/^spec_mode \d$/.test(cmd)) {
        if (cmd === freeMode) this.free = true;
        else if (!this.opts.playerModes || this.opts.playerModes.includes(cmd)) this.free = false;
      }
      const goto = /^spec_goto (\S+) (\S+) (\S+) (\S+) (\S+)$/.exec(cmd);
      if (goto && this.free) {
        const [x, y, z, pitch, yaw] = goto.slice(1).map(Number) as [number, number, number, number, number];
        this.pose = { x, y, z, pitch, yaw };
        this.strafe.since = Date.now();
        this.observed = null;
      }
      if (/^[+-](left|right)$/.test(cmd)) {
        this.pose = this.poseNow();
        this.strafe = { dir: cmd === "+left" ? -1 : cmd === "+right" ? 1 : 0, since: Date.now() };
      }
      const player = /^spec_player "(.+)"$/.exec(cmd);
      if (player) {
        const p = this.roster.find((r) => r.name === player[1]);
        if (p && !this.free) this.observed = p.steamId;
      }
      if (cmd === "getpos") {
        const f = (n: number) => n.toFixed(6);
        const at = !this.free ? this.roster.find((r) => r.steamId === this.observed)?.position : undefined;
        const pose = at ? { x: at.x, y: at.y, z: at.z + 64, pitch: 10, yaw: 0 } : this.poseNow();
        sock.write(`setpos ${f(pose.x)} ${f(pose.y)} ${f(pose.z)};setang ${f(pose.pitch)} ${f(pose.yaw)} 0.000000\n`);
      }
    }
  }

  /** The free camera's pose now (it slides sideways while +left or +right is held). */
  poseNow(): { x: number; y: number; z: number; pitch: number; yaw: number } {
    return { ...this.pose, x: this.pose.x + (this.free ? this.strafe.dir * 400 * ((Date.now() - this.strafe.since) / 1000) : 0) };
  }

  private async post(): Promise<void> {
    const t = this.now();
    const ph = this.opts.phase(t);
    for (const p of this.roster) p.position = this.opts.positions(t, p);
    this.views.push({ at: t, free: this.free, observed: this.observed });
    if (this.views.length > 100) this.views.shift();
    const view = this.opts.gsiLagMs ? this.viewAt(t - this.opts.gsiLagMs) : { free: this.free, observed: this.observed };
    const payload = buildSyntheticGsiPayload({
      mapName: this.opts.map,
      round: ph.round,
      players: this.roster,
      observed: view.free ? null : view.observed,
      roundPhase: ph.phase,
      phase: ph.countdown ?? ph.phase,
      phaseEndsIn: Math.round(ph.endsInSec * 10) / 10,
      token: this.opts.token,
      timestamp: 1_700_002_000 + this.seq++,
    });
    await fetch(this.opts.gsiUrl, { method: "POST", body: JSON.stringify(payload) }).catch(() => undefined);
  }

  start(): void {
    this.t0 = Date.now();
    this.timer = setInterval(() => void this.post(), 100);
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    for (const s of this.sockets) s.destroy();
    await new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()));
  }
}
