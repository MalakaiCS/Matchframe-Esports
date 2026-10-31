import type { ObsSceneItemFull } from "@matchframe/obs-adapter";
import { writableTransform } from "@matchframe/obs-adapter";
import type { Engine } from "../app.ts";

/**
 * The replay scene's twin in OBS, so a break's replays can fade from one to the next (replay/auto.ts):
 * the next clip waits, loaded and at its part, in the scene that isn't on program, and the program
 * fades over to it. OBS can't fade one media source into itself, and a second media source in the
 * same scene can't be faded without OBS's transitions.
 *
 * The twin, "<replay scene> B", is the replay scene again: the same sources (shared, as OBS's "Add
 * Existing": one browser source shows in both), with the same transforms, visibility and blend
 * modes, in the same order. Except the replay media source, which has a twin input of its own,
 * "<media source> B", with the same settings, filters and audio. It is built and brought up to date
 * off air: at the start of each break, and when the replay scene is set up.
 */

export interface TwinStatus {
  scene: string | null;
  input: string | null;
  ready: boolean;
  detail: string;
  /** When it was last checked against the replay scene. */
  checkedAt: string | null;
}

interface Stored {
  /** The replay scene and media source it is the twin of. */
  of: string;
  media: string;
  scene: string;
  input: string;
}

/**
 * Both replay media sources play while hidden and keep their place when shown (a clip waits paused at
 * its part off air, then plays as the program fades to it), and hold their last frame (it is still
 * fading out). OBS's own defaults for a new Media Source are the other way round.
 */
export const REPLAY_MEDIA_SETTINGS = { restart_on_activate: false, close_when_inactive: false, clear_on_media_end: false } as const;
const MEDIA_DEFAULTS: Record<string, unknown> = { restart_on_activate: true, close_when_inactive: false, clear_on_media_end: true, looping: false };
/** Settings that change with each clip: never copied. */
const PER_CLIP = new Set(["local_file", "is_local_file", "speed_percent", "input"]);
const SETTINGS_KEY = "replay.twin";

const round3 = (v: unknown) => (typeof v === "number" ? Math.round(v * 1000) / 1000 : v);
/** What must match between an item of the replay scene and its twin's. */
const itemKey = (source: string, i: Pick<ObsSceneItemFull, "enabled" | "locked" | "blendMode" | "transform">) =>
  JSON.stringify([source, i.enabled, i.locked, i.blendMode ?? "OBS_BLEND_NORMAL", Object.entries(writableTransform(i.transform)).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, round3(v)])]);
const sortedJson = (o: Record<string, unknown>) => JSON.stringify(Object.keys(o).sort().map((k) => [k, o[k]]));

export class ReplayTwin {
  private status: TwinStatus = { scene: null, input: null, ready: false, detail: "Not built yet: it is built at the first break, or by Set up OBS replay scene.", checkedAt: null };
  private running: Promise<{ scene: string; input: string } | null> | null = null;

  constructor(private readonly e: Engine) {}

  /** After a restart: the twin built before counts as the replay scene again. */
  init(): void {
    const st = this.stored();
    if (st) {
      this.e.program.setReplayTwin(st.scene, st.of);
      this.status = { ...this.status, scene: st.scene, input: st.input };
    }
  }

  getStatus(): TwinStatus {
    return { ...this.status };
  }

  private stored(): Stored | null {
    const s = this.e.settings.get<Stored | null>(SETTINGS_KEY, null);
    return s && typeof s.scene === "string" && typeof s.input === "string" && typeof s.of === "string" && typeof s.media === "string" ? s : null;
  }

  /**
   * Builds the twin, or brings it up to date with the replay scene, off air. Returns its scene and
   * media source, or null when there can't be one (the replays then play in the replay scene's one
   * source, as before 0.10.5); getStatus() says why.
   */
  sync(): Promise<{ scene: string; input: string } | null> {
    this.running ??= this.doSync().finally(() => (this.running = null));
    return this.running;
  }

  private fail(detail: string): null {
    this.status = { ...this.status, ready: false, detail, checkedAt: new Date().toISOString() };
    this.e.logger.warn("replay twin scene: not used", { detail });
    return null;
  }

  private async doSync(): Promise<{ scene: string; input: string } | null> {
    const obs = this.e.obs;
    const replay = this.e.program.sceneMap.REPLAY;
    const media = this.e.settings.get<string | null>("replay.mediaInput", null);
    if (!obs.state.connected) return this.fail("OBS isn't connected.");
    if (!replay || !media) return this.fail("No replay scene and media source: Set up OBS replay scene.");
    try {
      const items = await obs.sceneItemsFull(replay);
      const mediaItem = items.find((i) => i.sourceName === media);
      if (!mediaItem) return this.fail(`The replay scene “${replay}” has no media source “${media}” of its own (not in a group).`);
      const src = await obs.inputSettings(media);
      if (src.kind !== "ffmpeg_source") return this.fail(`“${media}” isn't a Media Source.`);
      const onAir = new Set([obs.state.programScene, obs.state.previewScene]);
      let st = this.stored();
      if (st && (st.of !== replay || st.media !== media)) {
        // The twin of another replay scene (or source): gone, unless it is on air.
        if (!onAir.has(st.scene)) {
          await obs.removeScene(st.scene).catch(() => undefined);
          await obs.removeInput(st.input).catch(() => undefined);
        }
        st = null;
      }
      const names = st ?? this.freeNames(replay, media);
      if (onAir.has(names.scene) || onAir.has(replay)) {
        // Never changed on air: as it is, when it exists.
        if (st) return this.ready(st, "On air: left as it is until the next break.");
        return this.fail("The replay scene is on air: the second one is made at the next break.");
      }
      // The replay source too: it plays while hidden, keeps its place when shown and holds its last frame.
      const fix = Object.fromEntries(Object.entries(REPLAY_MEDIA_SETTINGS).filter(([k, v]) => (src.settings[k] ?? MEDIA_DEFAULTS[k]) !== v));
      if (Object.keys(fix).length) await obs.setInputSettings(media, fix);
      const want: Record<string, unknown> = { ...Object.fromEntries(Object.entries(src.settings).filter(([k]) => !PER_CLIP.has(k))), ...REPLAY_MEDIA_SETTINGS, looping: false };
      const twinNow = await obs.inputSettings(names.input).catch(() => null);
      const sceneExists = await obs
        .sceneItemsFull(names.scene)
        .then(() => true)
        .catch(() => false);
      if (!sceneExists) await obs.createScene(names.scene);
      if (!twinNow) await obs.createInput(names.scene, names.input, "ffmpeg_source", { ...want, is_local_file: true });
      else if (twinNow.kind !== "ffmpeg_source") return this.fail(`“${names.input}” in OBS isn't a Media Source.`);
      else {
        const have = Object.fromEntries(Object.entries(twinNow.settings).filter(([k]) => !PER_CLIP.has(k)));
        const full = { ...MEDIA_DEFAULTS, ...want };
        if (Object.entries(full).some(([k, v]) => (have[k] ?? MEDIA_DEFAULTS[k]) !== v) || Object.keys(have).some((k) => !(k in full))) {
          const keep = Object.fromEntries(Object.entries(twinNow.settings).filter(([k]) => PER_CLIP.has(k)));
          await obs.setInputSettings(names.input, { ...want, ...keep }, false);
        }
      }
      await this.syncItems(items, mediaItem, names);
      await this.syncFilters(media, names.input);
      await this.syncAudio(media, names.input);
      const stored: Stored = { of: replay, media, scene: names.scene, input: names.input };
      this.e.settings.set(SETTINGS_KEY, stored);
      return this.ready(stored, `“${names.scene}” matches “${replay}”: replays fade from one to the next.`);
    } catch (err) {
      return this.fail(`OBS refused the second replay scene: ${err instanceof Error ? err.message : String(err)}.`);
    }
  }

  private ready(st: Stored, detail: string): { scene: string; input: string } {
    this.e.program.setReplayTwin(st.scene, st.of);
    this.status = { scene: st.scene, input: st.input, ready: true, detail, checkedAt: new Date().toISOString() };
    return { scene: st.scene, input: st.input };
  }

  /** "<scene> B" and "<source> B", or with a number when OBS has a source of that name already. */
  private freeNames(replay: string, media: string): { scene: string; input: string } {
    const taken = new Set([...this.e.obs.state.scenes, ...this.e.obs.state.inputs.map((i) => i.name)]);
    const free = (base: string) => {
      for (let n = 1; ; n++) {
        const name = n === 1 ? `${base} B` : `${base} B ${n}`;
        if (!taken.has(name)) {
          taken.add(name);
          return name;
        }
      }
    };
    return { scene: free(replay), input: free(media) };
  }

  /** The twin scene's items as the replay scene's, bottom to top; rebuilt (off air) when anything differs. */
  private async syncItems(items: ObsSceneItemFull[], mediaItem: ObsSceneItemFull, names: { scene: string; input: string }): Promise<void> {
    const obs = this.e.obs;
    const sourceOf = (i: ObsSceneItemFull) => (i === mediaItem ? names.input : i.sourceName);
    const want = items.map((i) => itemKey(sourceOf(i), i));
    const have = await obs.sceneItemsFull(names.scene);
    if (have.length === want.length && have.every((h, k) => itemKey(h.sourceName, h) === want[k])) return;
    // The twin media source's own item stays (removing its last item would delete it); everything else is added again.
    const keep = have.find((h) => h.sourceName === names.input) ?? null;
    for (const h of have) if (h !== keep) await obs.removeSceneItem(names.scene, h.sceneItemId);
    const ids: number[] = [];
    for (const i of items) {
      const id = i === mediaItem ? (keep?.sceneItemId ?? (await obs.createSceneItem(names.scene, names.input, i.enabled))) : await obs.createSceneItem(names.scene, i.sourceName, i.enabled);
      await obs.setSceneItem(names.scene, id, { transform: i.transform, enabled: i.enabled, locked: i.locked, blendMode: i.blendMode });
      ids.push(id);
    }
    for (const [k, id] of ids.entries()) await obs.setSceneItem(names.scene, id, { index: k });
  }

  /** The twin media source's filters as the replay source's (crop, colour correction…). */
  private async syncFilters(media: string, twin: string): Promise<void> {
    const obs = this.e.obs;
    const [want, have] = await Promise.all([obs.filters(media), obs.filters(twin)]);
    const key = (f: { name: string; kind: string; enabled: boolean; settings: Record<string, unknown> }) => JSON.stringify([f.name, f.kind, f.enabled, sortedJson(f.settings)]);
    if (want.length === have.length && want.every((f, k) => key(f) === key(have[k]!))) return;
    for (const f of have) await obs.removeFilter(twin, f.name);
    for (const f of want) await obs.createFilter(twin, f);
  }

  /** The twin media source's volume, mute, monitoring, balance, sync offset and tracks as the replay source's. */
  private async syncAudio(media: string, twin: string): Promise<void> {
    const obs = this.e.obs;
    const [want, have] = await Promise.all([obs.inputAudio(media), obs.inputAudio(twin)]);
    const diff = Object.fromEntries(Object.entries(want).filter(([k, v]) => JSON.stringify(v) !== JSON.stringify(have[k as keyof typeof have])));
    if (Object.keys(diff).length) await obs.setInputAudio(twin, diff);
  }
}
