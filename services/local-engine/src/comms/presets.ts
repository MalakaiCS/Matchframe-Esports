import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Match } from "@matchframe/contracts";
import type { SettingsRepo } from "../db/store.ts";
import type { Logger } from "../logger.ts";
import { CommsPublicSettings } from "./public.ts";
import type { RecordingPatch, RecordingSettings } from "./recording.ts";
import { MAX_DELAY_SEC, ParticipantRecord, SlotConfig, type TeamComms } from "./service.ts";
import { StripSettings } from "./strip.ts";

/**
 * Team Comms event presets (ADR-069; the brief, section 10): everything an event's comms setup is,
 * saved by name with the event and loaded in one go:
 *
 * - **people:** each TeamSpeak identity of the teams (team/server/identity) with its roster mapping,
 *   display name, Include in Broadcast, Include in Recording (independent) and level;
 * - **TeamSpeak:** each team slot's server, port, channel, listener nickname and identity name;
 * - **delay** (seconds and fine ms), the **recording** team and its comms and game levels, the
 *   **speaker strip's** settings (layout, colours, crops, timing offset) and the **on-air** settings
 *   (NDI output, caster ducking, the banner's placement).
 *
 * Never in a preset: the public listen-in (nothing about it is ever saved; loading a preset never
 * opens it), the operator's private Solo, passwords and tokens (they stay in the secure settings, per
 * team slot), the recording's folder and file format (this computer's). Loading names only the people
 * the preset knows; anyone else keeps what they have, and a new arrival stays excluded.
 */

const KEY = "comms.presets";
const MAX_PRESETS = 100;

/** One person as a preset keeps them (no first/last seen: those are MatchFrame's own record). */
const PresetPerson = z.object({
  teamId: z.string().max(100),
  serverUid: z.string().max(300),
  uid: z.string().max(100),
  nickname: z.string().max(200).default(""),
  playerId: z.string().max(100).nullable().default(null),
  displayName: z.string().max(64).nullable().default(null),
  includeBroadcast: z.boolean().default(false),
  includeRecording: z.boolean().default(false),
  levelDb: z.number().min(-60).max(12).default(0),
});
type PresetPerson = z.infer<typeof PresetPerson>;

export const PresetContent = z.object({
  v: z.literal(1).default(1),
  /** The teams it was saved for (the active match's, by team id). */
  teams: z.array(z.string().max(100)).max(4).default([]),
  slots: z.object({ A: SlotConfig.prefault({}), B: SlotConfig.prefault({}) }).prefault({}),
  people: z.array(PresetPerson).max(500).default([]),
  delay: z.object({ delaySec: z.number().int().min(0).max(MAX_DELAY_SEC), fineMs: z.number().int().min(-999).max(999) }).prefault({ delaySec: 0, fineMs: 0 }),
  recording: z.object({ teamId: z.string().max(100).nullable(), commsLevelDb: z.number().min(-60).max(12), gameLevelDb: z.number().min(-60).max(12) }).prefault({ teamId: null, commsLevelDb: 0, gameLevelDb: 0 }),
  strip: StripSettings.prefault({}),
  onAir: CommsPublicSettings.prefault({}),
});
export type PresetContent = z.infer<typeof PresetContent>;

export const Preset = z.object({
  id: z.string().max(64),
  name: z.string().min(1).max(80),
  eventId: z.string().max(100).nullable().default(null),
  createdAt: z.string(),
  savedAt: z.string(),
  content: PresetContent,
});
export type Preset = z.infer<typeof Preset>;

const Store = z.object({ presets: z.array(Preset).default([]), activeId: z.string().nullable().default(null) });
type Store = z.infer<typeof Store>;

export const PresetSaveAs = z.object({ name: z.string().trim().min(1).max(80), eventId: z.string().max(100).nullable().optional() });
export const PresetRename = z.object({ name: z.string().trim().min(1).max(80).optional(), eventId: z.string().max(100).nullable().optional() });

export type PresetSection = "people" | "teamspeak" | "delay" | "recording" | "strip" | "onAir";
const SECTION_NAMES: Record<PresetSection, string> = { people: "people and choices", teamspeak: "TeamSpeak servers and channels", delay: "delay", recording: "recording team and levels", strip: "speaker strip", onAir: "on-air settings" };

export class PresetError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "PresetError";
  }
}

export interface PresetDeps {
  settings: SettingsRepo;
  comms: TeamComms;
  logger: Pick<Logger, "info">;
  onAir: { settings(): CommsPublicSettings; setSettings(p: Partial<CommsPublicSettings>): unknown };
  recording: { settings(): RecordingSettings; setSettings(p: RecordingPatch): Promise<unknown> };
  strip: { get(): StripSettings; set(s: StripSettings): unknown };
  activeMatch(): Match | null;
  eventName(id: string): string | null;
  teamName(id: string): string | null;
}

/** JSON with its keys sorted: two equal settings compare equal whatever order they were written in. */
function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v)
      .sort()
      .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v);
}

const personKey = (p: { teamId: string; serverUid: string; uid: string }) => `${p.teamId}/${p.serverUid}/${p.uid}`;

export class CommsPresets {
  constructor(private readonly d: PresetDeps) {}

  private store(): Store {
    const r = Store.safeParse(this.d.settings.get(KEY, {}));
    return r.success ? r.data : Store.parse({});
  }

  private save(s: Store): void {
    this.d.settings.set(KEY, s);
  }

  /** The teams Team Comms has now (slot A and B's), by team id. */
  private teamIds(): string[] {
    return this.d.comms
      .status()
      .slots.map((s) => s.team?.id ?? null)
      .filter((x): x is string => !!x);
  }

  /** What a preset would hold now. */
  snapshot(teams = this.teamIds()): PresetContent {
    const c = this.d.comms.settings();
    const rec = this.d.recording.settings();
    const people: PresetPerson[] = this.d.comms
      .exportRecords(teams)
      .map((r) => PresetPerson.parse({ teamId: r.teamId, serverUid: r.serverUid, uid: r.uid, nickname: r.lastNickname, playerId: r.playerId, displayName: r.displayName, includeBroadcast: r.includeBroadcast, includeRecording: r.includeRecording, levelDb: r.levelDb }))
      .sort((a, b) => personKey(a).localeCompare(personKey(b)));
    return PresetContent.parse({
      v: 1,
      teams,
      slots: { A: this.d.comms.slotConfig("A"), B: this.d.comms.slotConfig("B") },
      people,
      delay: { delaySec: c.delaySec, fineMs: c.fineMs },
      recording: { teamId: rec.teamId, commsLevelDb: rec.commsLevelDb, gameLevelDb: rec.gameLevelDb },
      strip: this.d.strip.get(),
      onAir: this.d.onAir.settings(),
    });
  }

  /** Which parts of the setup differ from a preset now (people compared on the preset's own teams). */
  differs(p: Preset): PresetSection[] {
    const now = this.snapshot(p.content.teams.length ? p.content.teams : this.teamIds());
    // Someone the preset doesn't know who is still as MatchFrame meets anyone (excluded, unmapped) changes nothing.
    const isNew = (x: PresetPerson) => !x.includeBroadcast && !x.includeRecording && x.playerId === null && x.displayName === null && x.levelDb === 0;
    const known = new Set(p.content.people.map(personKey));
    const strip = (people: PresetPerson[]) => stable(people.map(({ nickname: _n, ...rest }) => rest).sort((a, b) => personKey(a).localeCompare(personKey(b))));
    const out: PresetSection[] = [];
    if (strip(now.people.filter((x) => known.has(personKey(x)) || !isNew(x))) !== strip(p.content.people)) out.push("people");
    if (stable(now.slots) !== stable(p.content.slots)) out.push("teamspeak");
    if (stable(now.delay) !== stable(p.content.delay)) out.push("delay");
    if (stable(now.recording) !== stable(p.content.recording)) out.push("recording");
    if (stable(now.strip) !== stable(p.content.strip)) out.push("strip");
    if (stable(now.onAir) !== stable(p.content.onAir)) out.push("onAir");
    return out;
  }

  private find(id: string): Preset {
    const p = this.store().presets.find((x) => x.id === id);
    if (!p) throw new PresetError(404, "no_preset", "No such preset.");
    return p;
  }

  private defaultEvent(): string | null {
    return this.d.activeMatch()?.eventId ?? null;
  }

  /** Save as: a new preset from the current setup (it becomes the active one). */
  saveAs(name: string, eventId?: string | null): Preset {
    const s = this.store();
    if (s.presets.length >= MAX_PRESETS) throw new PresetError(409, "too_many", `At most ${MAX_PRESETS} presets: delete one first.`);
    const ev = eventId === undefined ? this.defaultEvent() : eventId;
    if (s.presets.some((p) => p.name.toLowerCase() === name.toLowerCase() && p.eventId === ev)) throw new PresetError(409, "name_taken", `There is already a preset “${name}” for this event.`);
    const now = new Date().toISOString();
    const p = Preset.parse({ id: randomUUID(), name, eventId: ev, createdAt: now, savedAt: now, content: this.snapshot() });
    s.presets.push(p);
    s.activeId = p.id;
    this.save(s);
    this.d.logger.info("team comms: preset saved", { name, people: p.content.people.length });
    return p;
  }

  /** Save: the current setup over an existing preset (it becomes the active one). */
  overwrite(id: string): Preset {
    const s = this.store();
    const i = s.presets.findIndex((x) => x.id === id);
    if (i < 0) throw new PresetError(404, "no_preset", "No such preset.");
    const p = Preset.parse({ ...s.presets[i]!, savedAt: new Date().toISOString(), content: this.snapshot() });
    s.presets[i] = p;
    s.activeId = id;
    this.save(s);
    this.d.logger.info("team comms: preset saved", { name: p.name, people: p.content.people.length });
    return p;
  }

  rename(id: string, patch: z.infer<typeof PresetRename>): Preset {
    const s = this.store();
    const i = s.presets.findIndex((x) => x.id === id);
    if (i < 0) throw new PresetError(404, "no_preset", "No such preset.");
    const cur = s.presets[i]!;
    const next = { ...cur, ...(patch.name !== undefined ? { name: patch.name } : {}), ...(patch.eventId !== undefined ? { eventId: patch.eventId } : {}) };
    if (s.presets.some((p) => p.id !== id && p.name.toLowerCase() === next.name.toLowerCase() && p.eventId === next.eventId)) throw new PresetError(409, "name_taken", `There is already a preset “${next.name}” for this event.`);
    s.presets[i] = Preset.parse(next);
    this.save(s);
    return s.presets[i]!;
  }

  remove(id: string): void {
    const s = this.store();
    const before = s.presets.length;
    s.presets = s.presets.filter((p) => p.id !== id);
    if (s.presets.length === before) throw new PresetError(404, "no_preset", "No such preset.");
    if (s.activeId === id) s.activeId = null;
    this.save(s);
  }

  /**
   * Load: the preset's people, TeamSpeak slots, delay, recording team and levels, strip and on-air
   * settings applied now. The public listen-in is untouched (closed stays closed; an open one stays as
   * the operator left it, now with the preset's choices), and so are passwords and the Solo.
   */
  async load(id: string): Promise<{ preset: Preset; applied: PresetSection[]; skipped: string[] }> {
    const p = this.find(id);
    const c = PresetContent.parse(p.content);
    const skipped: string[] = [];
    for (const slot of ["A", "B"] as const) {
      const { teamId, serverHost, serverPort, serverUid, channel, nickname, identity } = c.slots[slot];
      this.d.comms.updateSlot(slot, { teamId, serverHost, serverPort, serverUid, channel, nickname, identity });
    }
    const now = new Date().toISOString();
    const records = c.people.map((x) => ParticipantRecord.parse({ teamId: x.teamId, serverUid: x.serverUid, uid: x.uid, playerId: x.playerId, displayName: x.displayName, includeBroadcast: x.includeBroadcast, includeRecording: x.includeRecording, levelDb: x.levelDb, preview: false, lastNickname: x.nickname, firstSeen: now, lastSeen: now }));
    const unmapped = records.filter((r) => r.playerId && !this.d.comms.hasPlayer(r.playerId)).length;
    if (unmapped) skipped.push(`${unmapped} roster mapping${unmapped > 1 ? "s" : ""} to players MatchFrame doesn't have any more (left unmapped)`);
    this.d.comms.importRecords(records);
    await this.d.comms.updateSettings({ delaySec: c.delay.delaySec, fineMs: c.delay.fineMs });
    let recTeam = c.recording.teamId;
    if (recTeam && !this.d.teamName(recTeam)) {
      skipped.push("the recording team (that team isn't in MatchFrame any more)");
      recTeam = null;
    }
    await this.d.recording.setSettings({ teamId: recTeam, commsLevelDb: c.recording.commsLevelDb, gameLevelDb: c.recording.gameLevelDb });
    this.d.strip.set(c.strip);
    this.d.onAir.setSettings(c.onAir);
    const s = this.store();
    s.activeId = id;
    this.save(s);
    this.d.logger.info("team comms: preset loaded", { name: p.name, people: records.length });
    return { preset: p, applied: ["people", "teamspeak", "delay", "recording", "strip", "onAir"], skipped };
  }

  /** The list for the console: names, events, counts, which one is active and what differs from it now. */
  status() {
    const s = this.store();
    const active = s.activeId ? (s.presets.find((p) => p.id === s.activeId) ?? null) : null;
    const differs = active ? this.differs(active) : [];
    const currentEventId = this.defaultEvent();
    return {
      currentEventId,
      currentEventName: currentEventId ? this.d.eventName(currentEventId) : null,
      active: active ? { id: active.id, name: active.name, changed: differs.length > 0, differs: differs.map((x) => SECTION_NAMES[x]) } : null,
      presets: s.presets
        .map((p) => ({
          id: p.id,
          name: p.name,
          eventId: p.eventId,
          eventName: p.eventId ? this.d.eventName(p.eventId) : null,
          createdAt: p.createdAt,
          savedAt: p.savedAt,
          teams: p.content.teams.map((t) => ({ id: t, name: this.d.teamName(t) })),
          people: p.content.people.length,
          included: { broadcast: p.content.people.filter((x) => x.includeBroadcast).length, recording: p.content.people.filter((x) => x.includeRecording).length },
          delayMs: p.content.delay.delaySec * 1000 + p.content.delay.fineMs,
          active: p.id === s.activeId,
        }))
        .sort((a, b) => Number(b.eventId === currentEventId) - Number(a.eventId === currentEventId) || a.name.localeCompare(b.name)),
    };
  }

  /** For the support file: names, events and counts (no identities). */
  diagnostics() {
    const st = this.status();
    return { active: st.active, presets: st.presets.map(({ id, name, eventId, savedAt, people, included, delayMs }) => ({ id, name, eventId, savedAt, people, included, delayMs })) };
  }
}
