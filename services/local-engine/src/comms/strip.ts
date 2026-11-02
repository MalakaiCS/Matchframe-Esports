import { createHash, randomBytes } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { z } from "zod";
import type { SettingsRepo } from "../db/store.ts";
import { WsHub } from "../http/ws-hub.ts";
import { BLOCK, type MixBlock } from "./mixer.ts";
import { SPMS } from "./buffer.ts";
import type { TeamComms } from "./service.ts";

/**
 * The dedicated recording's speaker strip (ADR-068; the owner's brief, section 8.1): a row of
 * clipped-corner hexagonal portraits of the people included in the recording, grayscale with a grey
 * frame while silent, in colour with a green frame while speaking; nobody else has a card.
 *
 * - **Who:** the recording team's people with Include in Recording, in a stable order (the team's
 *   roster order for mapped people, then the others as first seen), at most seven. Speaking changes
 *   only the colour and the frame: cards never move, reorder or resize.
 * - **When someone speaks:** from what the recording mix holds for them (`MixBlock.activity.recording`:
 *   the included, delayed samples actually mixed into the recording), never TeamSpeak's talk events,
 *   with the strip's own attack and release (so the frame doesn't flicker between syllables). Everyone
 *   active lights at once during overlapping speech.
 * - **Same timeline as the sound:** each block's cards and speakers are sent when that block leaves
 *   the engine for OBS (its output time plus the NDI send latency), plus a timing offset the operator
 *   calibrates against the recording. A team change or an exclusion changes the cards on the block
 *   where the sound changes.
 * - **Its own page** on the overlay server (`/comms/recording`, its own token, its own socket
 *   `/comms-rec-ws`), only ever in the recording's scene. The public overlay (`/comms/public`) never
 *   receives any of this.
 */

export const STRIP_SOURCE = "MatchFrame Speaker Strip";
export const MAX_CARDS = 7;
const TOKEN_KEY = "comms.stripToken";

const Hex = z.string().regex(/^#[0-9a-fA-F]{6}$/, "a colour like #20FF00");
export const StripAnchor = z.enum(["top-left", "top-center", "top-right", "bottom-left", "bottom-center", "bottom-right"]);
export type StripAnchor = z.infer<typeof StripAnchor>;

/** Where a portrait sits in its frame: the point kept in view (percent across and down) and a zoom (1: the picture just covers the frame). */
export const PortraitCrop = z.object({
  x: z.number().min(0).max(100).default(50),
  y: z.number().min(0).max(100).default(30),
  zoom: z.number().min(1).max(3).default(1),
});
export type PortraitCrop = z.infer<typeof PortraitCrop>;
export const DEFAULT_CROP: PortraitCrop = { x: 50, y: 30, zoom: 1 };

export const StripSettings = z.object({
  anchor: StripAnchor.default("bottom-center"),
  /** From the anchor's edges of the 1920×1080 frame (px): across (positive: right) and in from the top or bottom edge. */
  offsetX: z.number().int().min(-1920).max(1920).default(0),
  offsetY: z.number().int().min(0).max(1080).default(40),
  /** A card's width (px); its height is about the same. */
  cardPx: z.number().int().min(48).max(400).default(132),
  gapPx: z.number().int().min(0).max(200).default(8),
  /** The frame's thickness (px). */
  borderPx: z.number().min(1).max(30).default(6),
  activeColor: Hex.default("#20FF00"),
  idleColor: Hex.default("#808086"),
  /** Inside the frame, behind and around the portrait. */
  insetColor: Hex.default("#0D0F12"),
  /** Speaking must last this long before the frame lights (ms). */
  attackMs: z.number().int().min(0).max(500).default(30),
  /** The frame stays lit this long after the voice stops (ms): no flicker between syllables. */
  releaseMs: z.number().int().min(0).max(3000).default(350),
  /** Names under the portraits (off by default, as the reference). */
  labels: z.boolean().default(false),
  /** HUD images' default player pictures for mapped players without a picture of their own. */
  useHudDefaults: z.boolean().default(true),
  /** The operator's placeholder silhouette (an uploaded picture) for anyone without a portrait; null: MatchFrame's own. */
  placeholderAssetId: z.string().max(100).nullable().default(null),
  /** Per portrait: `player:<player id>` for a mapped player, `person:<card id>` otherwise. */
  crops: z
    .record(z.string().max(160), PortraitCrop)
    .refine((m) => Object.keys(m).length <= 300, "at most 300 portrait crops")
    .default({}),
  /** Added to the strip's timing (ms; positive: later), calibrated against the recording file. */
  timingOffsetMs: z.number().int().min(-1000).max(2000).default(0),
});
export type StripSettings = z.infer<typeof StripSettings>;

export interface StripCard {
  /** Opaque, stable per person (not their TeamSpeak identity). */
  id: string;
  name: string;
  pictureUrl: string;
  /** No portrait of their own: the HUD images' default, the operator's placeholder or MatchFrame's silhouette. */
  picture: "own" | "hud-default" | "placeholder" | "silhouette";
  crop: PortraitCrop;
  /** The crop's key in the settings. */
  cropKey: string;
  /** The person (engine side only: never sent to the page). */
  key: string;
}

export interface StripLayout {
  anchor: StripAnchor;
  offsetX: number;
  offsetY: number;
  cardPx: number;
  gapPx: number;
  borderPx: number;
  activeColor: string;
  idleColor: string;
  insetColor: string;
  labels: boolean;
}

/** Everything the strip page receives about who is shown. */
export interface StripConfigMessage {
  type: "strip-config";
  v: 1;
  layout: StripLayout;
  cards: { id: string; name: string; pictureUrl: string; placeholder: boolean; crop: PortraitCrop }[];
}

/** Who is speaking now (card ids). */
export interface StripSpeakingMessage {
  type: "strip-speaking";
  v: 1;
  speaking: string[];
}

export type StripMessage = StripConfigMessage | StripSpeakingMessage;

export interface StripPictures {
  /** A roster player's name and picture (null when the player hides their photo or has none). */
  player(id: string): { displayName: string; pictureUrl: string | null } | null;
  /** The team's players, in roster order (ids). */
  rosterOrder(teamId: string): string[];
  /** The HUD images' default player picture n for the team's current side (cycling), or null. */
  defaultPicture(teamId: string, index: number): string | null;
  /** Settings' default player picture (used when the strip has no placeholder of its own), or null. */
  fallback?(): string | null;
  assetUrl(id: string | null): string | null;
}

export interface SpeakerStripDeps {
  comms: TeamComms;
  settings: SettingsRepo;
  config: () => StripSettings;
  pictures: StripPictures;
  overlayPort: () => number;
  /** How long after its output time a recording block leaves for OBS (the NDI send latency, ms). */
  sendLatencyMs: () => number;
  /** False while the recording's comms level is off: nothing reaches the recording, nobody lights. */
  commsAudible: () => boolean;
  /** The engine's timeline (ms). */
  now: () => number;
  /** Sends on timers (false in tests that call flushUntil). */
  realtime?: boolean;
}

/** MatchFrame's placeholder silhouette: head and shoulders, grey on dark. */
export const SILHOUETTE_URL = `data:image/svg+xml;utf8,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200"><rect width="200" height="200" fill="#1a1d22"/><circle cx="100" cy="78" r="38" fill="#5b616b"/><path d="M28 200c4-44 34-68 72-68s68 24 72 68z" fill="#5b616b"/></svg>',
)}`;

/** How often the strip reads its settings, the send latency and the comms level again (a strip settings change applies at once). */
const INPUTS_MS = 500;

const cardId = (key: string) => `c${createHash("sha256").update(key).digest("hex").slice(0, 12)}`;

interface CardState {
  rawSince: number | null;
  lastRaw: number | null;
  lit: boolean;
}

interface Pending {
  dueMs: number;
  msg: StripMessage;
}

export class SpeakerStrip {
  private readonly hub: WsHub;
  private team: string | null = null;
  private version = -1;
  private settingsSig = "";
  private cards: StripCard[] = [];
  private overLimit = 0;
  private readonly states = new Map<string, CardState>();
  private speakingSig = "";
  /** What the pages have been sent (a page that connects gets these). */
  private sentConfig: StripConfigMessage;
  private sentSpeaking: StripSpeakingMessage = { type: "strip-speaking", v: 1, speaking: [] };
  private readonly queue: Pending[] = [];
  private lastQueuedConfig: StripConfigMessage | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly off: () => void;
  /** Sent messages with when they were due and sent (tests, the support file's last few). */
  readonly log: { dueMs: number; sentMs: number; msg: StripMessage }[] = [];
  private counters = { configs: 0, speakingChanges: 0, late: 0 };
  /** The timing test: every card lit on the blocks of these timeline sample ranges (the beep's own blocks). */
  private forced: { start: number; end: number }[] = [];
  /** The settings and the other inputs, read at most every INPUTS_MS (every block is 10 ms; each read is a database row and a parse). */
  private inputs: { atMs: number; cfg: StripSettings; sig: string; latencyMs: number; audible: boolean } | null = null;

  constructor(private readonly d: SpeakerStripDeps) {
    this.sentConfig = this.configMessage([]);
    this.hub = new WsHub({
      maxBufferedBytes: 256 * 1024,
      onConnect: (c) => {
        this.hub.sendTo(c, this.sentConfig, { snapshot: true });
        this.hub.sendTo(c, this.sentSpeaking);
      },
    });
    this.off = d.comms.onBlock((b) => this.onBlock(b));
  }

  token(): string {
    let t = this.d.settings.get<string | null>(TOKEN_KEY, null);
    if (!t) {
      t = randomBytes(24).toString("hex");
      this.d.settings.set(TOKEN_KEY, t);
    }
    return t;
  }

  checkToken(given: string | null): boolean {
    return !!given && given === this.token();
  }

  url(): string {
    return `http://127.0.0.1:${this.d.overlayPort()}/comms/recording?t=${this.token()}`;
  }

  /** The timing test (comms/timing-test.ts): every card lit on the blocks overlapping these ranges (timeline samples), timed like speech. */
  setForced(ranges: { start: number; end: number }[]): void {
    this.forced = ranges.map((r) => ({ ...r }));
  }

  /** `/comms-rec-ws` on the overlay server (token checked there). Read-only. */
  upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    this.hub.upgrade(req, socket, head, { kind: "comms-recording" });
  }

  private layout(s: StripSettings): StripLayout {
    return { anchor: s.anchor, offsetX: s.offsetX, offsetY: s.offsetY, cardPx: s.cardPx, gapPx: s.gapPx, borderPx: s.borderPx, activeColor: s.activeColor, idleColor: s.idleColor, insetColor: s.insetColor, labels: s.labels };
  }

  private configMessage(cards: StripCard[]): StripConfigMessage {
    return { type: "strip-config", v: 1, layout: this.layout(this.d.config()), cards: cards.map((c) => ({ id: c.id, name: c.name, pictureUrl: c.pictureUrl, placeholder: c.picture !== "own", crop: { ...c.crop } })) };
  }

  /**
   * A team's cards: its people included in the recording, in roster order (mapped players by the
   * team's roster, then the rest as first seen), at most seven, each with a picture: their roster
   * picture, else the HUD images' default player picture, else the operator's placeholder (the strip's
   * own, else Settings' default player picture), else MatchFrame's silhouette.
   */
  cardsFor(teamId: string | null): { cards: StripCard[]; overLimit: number } {
    if (!teamId) return { cards: [], overLimit: 0 };
    const s = this.d.config();
    const pics = this.d.pictures;
    const order = pics.rosterOrder(teamId);
    const people = this.d.comms.recordingPeople(teamId).filter((p) => p.includeRecording);
    const rank = (playerId: string | null) => {
      const i = playerId ? order.indexOf(playerId) : -1;
      return i < 0 ? Number.MAX_SAFE_INTEGER : i;
    };
    people.sort((a, b) => rank(a.playerId) - rank(b.playerId) || a.firstSeen.localeCompare(b.firstSeen) || a.key.localeCompare(b.key));
    const shown = people.slice(0, MAX_CARDS);
    const placeholder = pics.assetUrl(s.placeholderAssetId) ?? pics.fallback?.() ?? null;
    const cards = shown.map((p, i): StripCard => {
      const id = cardId(p.key);
      const player = p.playerId ? pics.player(p.playerId) : null;
      const rosterIndex = p.playerId ? order.indexOf(p.playerId) : -1;
      let picture: StripCard["picture"] = "silhouette";
      let url: string = SILHOUETTE_URL;
      const hudDefault = s.useHudDefaults && p.playerId ? pics.defaultPicture(teamId, rosterIndex >= 0 ? rosterIndex : i) : null;
      if (player?.pictureUrl) [picture, url] = ["own", player.pictureUrl];
      else if (hudDefault) [picture, url] = ["hud-default", hudDefault];
      else if (placeholder) [picture, url] = ["placeholder", placeholder];
      const cropKey = p.playerId ? `player:${p.playerId}` : `person:${id}`;
      return { id, name: player?.displayName ?? p.displayName, pictureUrl: url, picture, crop: { ...DEFAULT_CROP, ...(s.crops[cropKey] ?? {}) }, cropKey, key: p.key };
    });
    return { cards, overLimit: Math.max(0, people.length - MAX_CARDS) };
  }

  private read(nowMs: number) {
    if (!this.inputs || nowMs - this.inputs.atMs >= INPUTS_MS || nowMs < this.inputs.atMs) {
      const cfg = this.d.config();
      this.inputs = { atMs: nowMs, cfg, sig: JSON.stringify(cfg), latencyMs: this.d.sendLatencyMs(), audible: this.d.commsAudible() };
    }
    return this.inputs;
  }

  private onBlock(b: MixBlock): void {
    const blockMs = b.start / SPMS;
    const inp = this.read(this.d.now());
    const s = inp.cfg;
    const due = blockMs + inp.latencyMs + s.timingOffsetMs;
    const team = b.recording.team;
    const sig = inp.sig;
    // Who is shown: rebuilt on the block where the recording's team, its people or the settings change.
    if (team !== this.team || this.d.comms.peopleVersion !== this.version || sig !== this.settingsSig) {
      const teamChanged = team !== this.team;
      this.team = team;
      this.version = this.d.comms.peopleVersion;
      this.settingsSig = sig;
      const { cards, overLimit } = this.cardsFor(team);
      this.overLimit = overLimit;
      const msg = this.configMessage(cards);
      if (teamChanged) this.states.clear();
      for (const id of [...this.states.keys()]) if (!cards.some((c) => c.id === id)) this.states.delete(id);
      this.cards = cards;
      if (JSON.stringify(msg) !== JSON.stringify(this.lastQueuedConfig)) {
        this.lastQueuedConfig = msg;
        this.enqueue(due, msg);
      }
    }
    // Who speaks in this block, as the recording mix holds them, with attack and release.
    const audible = inp.audible && b.recording.team !== null;
    const endMs = blockMs + (BLOCK / SPMS);
    const speaking: string[] = [];
    for (const c of this.cards) {
      const act = b.activity.recording.get(c.key);
      const raw = audible && !!act?.speaking;
      let st = this.states.get(c.id);
      if (!st) {
        st = { rawSince: null, lastRaw: null, lit: false };
        this.states.set(c.id, st);
      }
      if (raw) {
        st.rawSince ??= blockMs;
        st.lastRaw = endMs;
        if (!st.lit && endMs - st.rawSince >= s.attackMs) st.lit = true;
      } else {
        st.rawSince = null;
        if (st.lit && (st.lastRaw === null || endMs - st.lastRaw >= s.releaseMs)) st.lit = false;
      }
      if (st.lit) speaking.push(c.id);
    }
    // The timing test: all cards on the beep's blocks (the same blocks the recording output beeps on).
    if (this.forced.length) {
      const end = b.start + BLOCK;
      if (this.forced.some((f) => f.start < end && f.end > b.start)) speaking.splice(0, speaking.length, ...this.cards.map((c) => c.id));
      this.forced = this.forced.filter((f) => f.end > end);
    }
    const ssig = speaking.join(",");
    if (ssig !== this.speakingSig) {
      this.speakingSig = ssig;
      this.enqueue(due, { type: "strip-speaking", v: 1, speaking });
    }
    if (this.d.realtime !== false) this.schedule();
  }

  private enqueue(dueMs: number, msg: StripMessage): void {
    this.queue.push({ dueMs, msg });
    if (msg.type === "strip-config") this.counters.configs++;
    else this.counters.speakingChanges++;
  }

  private schedule(): void {
    if (this.timer || !this.queue.length) return;
    const wait = Math.max(0, this.queue[0]!.dueMs - this.d.now());
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flushUntil(this.d.now());
      this.schedule();
    }, wait);
    this.timer.unref?.();
  }

  /** Sends every queued message due by `nowMs`, in order (the timer calls it; tests drive it). */
  flushUntil(nowMs: number): void {
    while (this.queue.length && this.queue[0]!.dueMs <= nowMs) {
      const p = this.queue.shift()!;
      if (nowMs - p.dueMs > 50) this.counters.late++;
      this.send(p.msg);
      this.log.push({ dueMs: p.dueMs, sentMs: nowMs, msg: p.msg });
      if (this.log.length > 2000) this.log.splice(0, this.log.length - 1000);
    }
  }

  private send(msg: StripMessage): void {
    if (msg.type === "strip-config") {
      this.sentConfig = msg;
      // A card that left is no longer speaking.
      const ids = new Set(msg.cards.map((c) => c.id));
      if (this.sentSpeaking.speaking.some((id) => !ids.has(id))) this.sentSpeaking = { ...this.sentSpeaking, speaking: this.sentSpeaking.speaking.filter((id) => ids.has(id)) };
      for (const c of this.hub.clients) this.hub.sendTo(c, msg, { snapshot: true });
    } else {
      this.sentSpeaking = msg;
      for (const c of this.hub.clients) {
        // A page that missed a config (slow) gets the current one first.
        if (c.needsSnapshot) this.hub.sendTo(c, this.sentConfig, { snapshot: true });
        this.hub.sendTo(c, msg);
      }
    }
  }

  /** The settings changed (layout, crops, timing): the pages get the new cards at once (card sets still queued are superseded). */
  refresh(): void {
    this.settingsSig = "";
    this.inputs = null;
    for (let i = this.queue.length - 1; i >= 0; i--) if (this.queue[i]!.msg.type === "strip-config") this.queue.splice(i, 1);
    const { cards, overLimit } = this.cardsFor(this.team);
    this.cards = cards;
    this.overLimit = overLimit;
    const msg = this.configMessage(cards);
    this.lastQueuedConfig = msg;
    this.send(msg);
    this.settingsSig = this.read(this.d.now()).sig;
  }

  /** What the pages show now. */
  current(): { config: StripConfigMessage; speaking: StripSpeakingMessage } {
    return { config: this.sentConfig, speaking: this.sentSpeaking };
  }

  status() {
    const names = new Map(this.sentConfig.cards.map((c) => [c.id, c.name]));
    return {
      url: this.url(),
      source: STRIP_SOURCE,
      pages: this.hub.clients.size,
      team: this.team,
      cards: this.cards.map((c) => ({ id: c.id, name: c.name, picture: c.picture, pictureUrl: c.pictureUrl, crop: c.crop, cropKey: c.cropKey })),
      speaking: this.sentSpeaking.speaking.map((id) => names.get(id) ?? id),
      overLimit: this.overLimit,
      warning: this.overLimit ? `${this.overLimit + MAX_CARDS} people are included in the recording: the strip shows the first ${MAX_CARDS}.` : null,
      counters: { ...this.counters, queued: this.queue.length },
    };
  }

  /** For the support file: the address without its token, names left out. */
  diagnostics() {
    const st = this.status();
    return { ...st, url: st.url.replace(/t=[^&]+/, "t=[redacted]"), cards: st.cards.map((c) => ({ id: c.id, picture: c.picture })), speaking: st.speaking.length };
  }

  close(): void {
    this.off();
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.hub.closeAll();
  }
}

/** The strip page: transparent, cards drawn by its script (/comms/recording.js; the overlay server allows no inline script). */
export function stripPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>MatchFrame Speaker Strip</title>
<style>
:root { --mf-active: #20ff00; --mf-idle: #808086; --mf-inset: #0d0f12; --mf-font: "Inter", "Segoe UI", system-ui, sans-serif; }
html, body { margin: 0; padding: 0; width: 1920px; height: 1080px; overflow: hidden; background: transparent; font-family: var(--mf-font); }
.mf-strip { position: absolute; display: flex; align-items: flex-start; opacity: 0; transition: opacity 240ms ease; }
.mf-strip.on { opacity: 1; }
.mf-card { position: relative; flex: none; display: flex; flex-direction: column; align-items: center; }
.mf-card svg { display: block; overflow: visible; filter: drop-shadow(0 3px 6px rgba(0, 0, 0, 0.45)); }
.mf-frame-on, .mf-color { opacity: 0; transition: opacity 140ms ease-out; }
.mf-card.speaking .mf-frame-on, .mf-card.speaking .mf-color { opacity: 1; transition-duration: 50ms; }
.mf-label { margin-top: 6px; max-width: 100%; padding: 2px 8px; background: rgba(10, 12, 16, 0.82); color: #e9edf3; font-size: 14px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; box-sizing: border-box; border-bottom: 2px solid var(--mf-idle); transition: border-color 140ms ease-out; }
.mf-card.speaking .mf-label { border-bottom-color: var(--mf-active); }
</style>
</head>
<body>
<div id="mf-strip" class="mf-strip" aria-hidden="true"></div>
<script src="/comms/recording.js"></script>
</body>
</html>
`;
}

/**
 * The strip page's script: cards from /comms-rec-ws (`strip-config`), speaking from `strip-speaking`.
 * Each card is an SVG: a rounded, clipped-corner hexagon frame (idle and active, crossfaded), a dark
 * inset, and the portrait twice inside the inner hexagon (grayscale, and colour over it shown while
 * speaking), placed by the operator's crop. Hidden whenever the engine isn't there.
 */
export const STRIP_JS = `(function () {
  "use strict";
  var root = document.getElementById("mf-strip");
  var token = new URLSearchParams(location.search).get("t") || "";
  var NS = "http://www.w3.org/2000/svg";
  var cards = {};
  var cfgKey = null;
  var retry = 500;
  var hideTimer = null;
  var seq = 0;
  function f(p) { return p[0].toFixed(2) + "," + p[1].toFixed(2); }
  function hexPts(w, h) { var a = w * 0.235; return [[a, 0], [w - a, 0], [w, h / 2], [w - a, h], [a, h], [0, h / 2]]; }
  // The polygon moved inwards by d (clockwise on screen: each edge's inward normal is (-dy, dx)).
  function inset(pts, d) {
    var n = pts.length, lines = [], out = [];
    for (var i = 0; i < n; i++) {
      var p = pts[i], q = pts[(i + 1) % n], dx = q[0] - p[0], dy = q[1] - p[1], l = Math.hypot(dx, dy);
      var nx = -dy / l * d, ny = dx / l * d;
      lines.push([[p[0] + nx, p[1] + ny], [dx, dy]]);
    }
    for (var j = 0; j < n; j++) {
      var a = lines[(j - 1 + n) % n], b = lines[j];
      var cr = a[1][0] * b[1][1] - a[1][1] * b[1][0];
      var t = ((b[0][0] - a[0][0]) * b[1][1] - (b[0][1] - a[0][1]) * b[1][0]) / cr;
      out.push([a[0][0] + a[1][0] * t, a[0][1] + a[1][1] * t]);
    }
    return out;
  }
  function rounded(pts, r) {
    var n = pts.length, d = "";
    for (var i = 0; i < n; i++) {
      var p = pts[(i - 1 + n) % n], v = pts[i], q = pts[(i + 1) % n];
      var l1 = Math.hypot(p[0] - v[0], p[1] - v[1]), l2 = Math.hypot(q[0] - v[0], q[1] - v[1]);
      var t1 = Math.min(0.45, r / l1), t2 = Math.min(0.45, r / l2);
      var A = [v[0] + (p[0] - v[0]) * t1, v[1] + (p[1] - v[1]) * t1], B = [v[0] + (q[0] - v[0]) * t2, v[1] + (q[1] - v[1]) * t2];
      d += (i === 0 ? "M" : "L") + f(A) + "Q" + f(v) + " " + f(B);
    }
    return d + "Z";
  }
  function el(name, attrs, parent) {
    var e = document.createElementNS(NS, name);
    for (var k in attrs) e.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(e);
    return e;
  }
  // The portrait covers the inner box, the crop's point kept where it is, zoomed.
  function place(imgs, box, nat, crop) {
    var s = Math.max(box.w / nat.w, box.h / nat.h) * (crop.zoom || 1);
    var dw = nat.w * s, dh = nat.h * s;
    var x = box.x + (box.w - dw) * (crop.x / 100), y = box.y + (box.h - dh) * (crop.y / 100);
    for (var i = 0; i < imgs.length; i++) {
      imgs[i].setAttribute("x", x.toFixed(2)); imgs[i].setAttribute("y", y.toFixed(2));
      imgs[i].setAttribute("width", dw.toFixed(2)); imgs[i].setAttribute("height", dh.toFixed(2));
    }
  }
  function card(c, L) {
    var w = L.cardPx, h = Math.round(L.cardPx * 0.99), b = L.borderPx, r = w * 0.085, ring = Math.max(1, b * 0.3);
    var id = "mf" + (++seq);
    var outer = hexPts(w, h), mid = inset(outer, b), inner = inset(outer, b + ring);
    var div = document.createElement("div");
    div.className = "mf-card";
    div.style.width = w + "px";
    var svg = el("svg", { width: w, height: h, viewBox: "0 0 " + w + " " + h }, div);
    var defs = el("defs", {}, svg);
    var clip = el("clipPath", { id: id + "c" }, defs);
    el("path", { d: rounded(inner, Math.max(1, r - (b + ring) * 0.55)) }, clip);
    var gray = el("filter", { id: id + "g", "color-interpolation-filters": "sRGB" }, defs);
    el("feColorMatrix", { type: "saturate", values: "0" }, gray);
    var shade = el("radialGradient", { id: id + "s", cx: "50%", cy: "45%", r: "62%" }, defs);
    el("stop", { offset: "70%", "stop-color": "#000", "stop-opacity": "0" }, shade);
    el("stop", { offset: "100%", "stop-color": "#000", "stop-opacity": "0.45" }, shade);
    el("path", { d: rounded(outer, r), fill: L.idleColor, "class": "mf-frame-off" }, svg);
    el("path", { d: rounded(outer, r), fill: L.activeColor, "class": "mf-frame-on" }, svg);
    el("path", { d: rounded(mid, Math.max(1, r - b * 0.55)), fill: L.insetColor }, svg);
    var g = el("g", { "clip-path": "url(#" + id + "c)" }, svg);
    var box = { x: b + ring, y: b + ring, w: w - 2 * (b + ring), h: h - 2 * (b + ring) };
    var gi = el("image", { href: c.pictureUrl, preserveAspectRatio: "none", filter: "url(#" + id + "g)", "class": "mf-gray" }, g);
    var ci = el("image", { href: c.pictureUrl, preserveAspectRatio: "none", "class": "mf-color" }, g);
    el("path", { d: rounded(inner, Math.max(1, r - (b + ring) * 0.55)), fill: "url(#" + id + "s)" }, svg);
    place([gi, ci], box, { w: 1, h: 1 }, { x: 50, y: 50, zoom: 1 });
    var im = new Image();
    im.onload = function () { place([gi, ci], box, { w: im.naturalWidth || 1, h: im.naturalHeight || 1 }, c.crop); };
    im.src = c.pictureUrl;
    if (L.labels) {
      var lab = document.createElement("div");
      lab.className = "mf-label";
      lab.textContent = c.name;
      div.appendChild(lab);
    }
    return div;
  }
  function position(L) {
    var s = root.style;
    s.left = s.right = s.top = s.bottom = "auto";
    s.transform = "none";
    var parts = L.anchor.split("-");
    if (parts[0] === "top") s.top = L.offsetY + "px"; else s.bottom = L.offsetY + "px";
    if (parts[1] === "left") s.left = L.offsetX + "px";
    else if (parts[1] === "right") s.right = (-L.offsetX) + "px";
    else { s.left = "50%"; s.transform = "translateX(calc(-50% + " + L.offsetX + "px))"; }
    s.gap = L.gapPx + "px";
    document.documentElement.style.setProperty("--mf-active", L.activeColor);
    document.documentElement.style.setProperty("--mf-idle", L.idleColor);
  }
  function config(m) {
    var key = JSON.stringify(m);
    if (key === cfgKey) return;
    var speaking = {};
    for (var id in cards) if (cards[id].classList.contains("speaking")) speaking[id] = true;
    cfgKey = key;
    position(m.layout);
    root.textContent = "";
    cards = {};
    for (var i = 0; i < m.cards.length; i++) {
      var c = m.cards[i], d = card(c, m.layout);
      if (speaking[c.id]) d.classList.add("speaking");
      cards[c.id] = d;
      root.appendChild(d);
    }
    root.classList.toggle("on", m.cards.length > 0);
  }
  function speak(m) {
    var on = {};
    for (var i = 0; i < m.speaking.length; i++) on[m.speaking[i]] = true;
    for (var id in cards) cards[id].classList.toggle("speaking", !!on[id]);
  }
  function connect() {
    var ws = new WebSocket((location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/comms-rec-ws?t=" + encodeURIComponent(token));
    ws.onopen = function () { retry = 500; if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; } };
    ws.onmessage = function (ev) {
      try {
        var m = JSON.parse(ev.data);
        if (m && m.type === "strip-config") config(m);
        else if (m && m.type === "strip-speaking") speak(m);
      } catch (e) {}
    };
    ws.onclose = function () {
      speak({ speaking: [] });
      if (!hideTimer) hideTimer = setTimeout(function () { root.classList.remove("on"); cfgKey = null; }, 1000);
      setTimeout(connect, retry);
      retry = Math.min(5000, retry * 2);
    };
  }
  connect();
})();
`;
