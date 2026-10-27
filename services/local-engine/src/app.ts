import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import type { AutomationRule, ProgramMode, TriggerEvent, TriggerKind } from "@matchframe/automation";
import { AutomationRule as RuleSchema, exampleRules, RuleEngine } from "@matchframe/automation";
import type { HudManifest, MapPack, MatchState, Side } from "@matchframe/contracts";
import { EventRecord, EventStage, Match, Player, RundownCue, Sponsor, StatCorrection, Team } from "@matchframe/contracts";
import type { DerivedEvent, MeasuredProfilesFile, ProfileSet } from "@matchframe/cs2-state";
import { DEFAULT_PROFILES, profilesFromMeasured } from "@matchframe/cs2-state";
import type { UtilityScenarioRule } from "@matchframe/director-policy";
import { INFERNO_BOTTOM_BANANA_RULE } from "@matchframe/director-policy";
import type { HudState } from "@matchframe/hud-sdk";
import { MapRegistry, syntheticMapPack } from "@matchframe/map-runtime";
import { ObsManager } from "@matchframe/obs-adapter";
import { loadWindowsInputBackend, KeyboardObserverAdapter, NetconObserverAdapter, NoControlAdapter, SimulationObserverAdapter } from "@matchframe/observer-agent";
import type { ReplayProvider } from "@matchframe/replay-agent";
import { ObsReplayBufferProvider, ReplayBridgeProvider, ReplayQueue } from "@matchframe/replay-agent";
import { z } from "zod";
import { SecretStore } from "./auth.ts";
import { CloudLink } from "./cloud/link.ts";
import type { MeterInput } from "./cloud/meter.ts";
import { AutoDirectorMeter, UsageLedger } from "./cloud/meter.ts";
import type { EngineConfig } from "./config.ts";
import { APP_VERSION } from "./config.ts";
import { Database } from "./db/database.ts";
import { AuditRepo, DemoJobRepo, DocumentRepo, MapInstanceRepo, RosterRepo, SettingsRepo, SteamIndexRepo, VetoRepo } from "./db/store.ts";
import { SponsorRotation, zoneAllowed } from "./domain/sponsors.ts";
import { VetoService } from "./domain/veto.ts";
import { HudLibraryService, libraryHudId, libraryOutputId } from "./hud/library.ts";
import { HudPackageManager } from "./hud/packages.ts";
import { OutputService } from "./hud/outputs.ts";
import { DelayBuffer } from "./live/delay.ts";
import { KillfeedBuilder } from "./live/killfeed.ts";
import type { HudContext } from "./live/projection.ts";
import { buildHudState } from "./live/projection.ts";
import { LiveSession } from "./live/session.ts";
import { TeamSideTracker } from "./live/team-sides.ts";
import { Logger } from "./logger.ts";
import { ProgramArbiter } from "./production/program.ts";
import { TrainingService } from "./demos/training.ts";
import { buildBracket, computeStandings } from "./domain/standings.ts";
import { DemoLibrary, PythonWorkerRunner } from "./demos/library.ts";
import { RoundSimulator } from "./sim/simulator.ts";
import { GameConsoleService } from "./game/console.ts";
import { BuiltinRadars } from "./live/builtin-radars.ts";

export const SetupProfile = z.object({
  id: z.string(),
  name: z.string().min(1),
  sourceMode: z.enum(["live_observer", "demo_playback", "simulation"]),
  cs2InstallDir: z.string().nullable().default(null),
  observerAdapter: z.record(z.string(), z.unknown()).default({}),
  obsProfileId: z.string().nullable().default(null),
  programScenes: z.record(z.string(), z.string().nullable()).default({}),
  checklist: z.record(z.string(), z.boolean()).default({}),
  topology: z.enum(["one_pc", "multi_pc"]).default("one_pc"),
  createdAt: z.string().default(() => new Date().toISOString()),
});

export const ObserverAdapterSettings = z.object({
  kind: z.enum(["none", "netcon", "keyboard"]).default("none"),
  host: z.string().default("127.0.0.1"),
  port: z.number().int().min(1).max(65535).default(2121),
  templates: z.record(z.string(), z.string()).default({}),
  windowTitle: z.string().default("^Counter-Strike 2$"),
});
export type ObserverAdapterSettings = z.infer<typeof ObserverAdapterSettings>;

interface Cue {
  id: string;
  kind: string;
  title: string;
  subtitle: string | null;
  data: Record<string, unknown>;
  untilMs: number | null;
  outputs: string[] | null;
}

export class Engine {
  readonly logger: Logger;
  readonly db: Database;
  readonly secrets: SecretStore;
  readonly settings: SettingsRepo;
  readonly audit: AuditRepo;
  readonly teams: DocumentRepo<typeof Team>;
  readonly players: DocumentRepo<typeof Player>;
  readonly events: DocumentRepo<typeof EventRecord>;
  readonly matches: DocumentRepo<typeof Match>;
  readonly sponsors: DocumentRepo<typeof Sponsor>;
  readonly rundown: DocumentRepo<typeof RundownCue>;
  readonly stages: DocumentRepo<typeof EventStage>;
  readonly rules: DocumentRepo<typeof RuleSchema>;
  readonly setupProfiles: DocumentRepo<typeof SetupProfile>;
  readonly corrections: DocumentRepo<typeof StatCorrection>;
  readonly roster: RosterRepo;
  readonly steamIndex: SteamIndexRepo;
  readonly mapInstances: MapInstanceRepo;
  readonly vetoRepo: VetoRepo;
  readonly veto: VetoService;
  readonly demoJobs: DemoJobRepo;
  readonly maps = new MapRegistry();
  /** Built-in radar images (minimaps) for the active-duty maps. */
  readonly radars: BuiltinRadars;
  readonly session: LiveSession;
  readonly obs: ObsManager;
  readonly program: ProgramArbiter;
  readonly replays: ReplayQueue;
  readonly ruleEngine: RuleEngine;
  readonly hudPackages: HudPackageManager;
  readonly outputs: OutputService;
  /** HUD Library (ADR-020): installed HUDs, per-HUD settings and runtime control. */
  readonly hudLibrary: HudLibraryService;
  readonly demos: DemoLibrary;
  readonly workers: PythonWorkerRunner;
  readonly training: TrainingService;
  /** Utility profiles in use and which types come from demo measurements. */
  readonly utilityProfiles: { profiles: ProfileSet; measuredTypes: string[]; file: string | null; error: string | null };
  readonly sponsorRotation = new SponsorRotation();
  readonly startedAt = new Date().toISOString();
  readonly now = () => performance.now();
  readonly migration: { from: number; to: number; backup: string | null };
  /** Matchframe account link, signed licence and auto-director hour metering. */
  readonly cloud: CloudLink;
  readonly usageLedger: UsageLedger;
  readonly meter: AutoDirectorMeter;
  /** Start CS2 (launch profile) and the game's console while it runs (console options). */
  readonly gameConsole: GameConsoleService;
  private meterTimer: ReturnType<typeof setInterval> | null = null;
  private cloudMap: string | null = null;

  private readonly killfeed = new KillfeedBuilder();
  private sides = new TeamSideTracker();
  private readonly delayBuffers = new Map<string, DelayBuffer<MatchState>>();
  private readonly cues = new Map<string, Cue>();
  private annotations: HudState["annotations"] = [];
  private roundWinnersLR = new Map<number, "left" | "right">();
  private sim: { simulator: RoundSimulator; adapter: SimulationObserverAdapter; timer: ReturnType<typeof setInterval> } | null = null;
  private replayProvider: ReplayProvider | null = null;
  private hudListeners = new Set<(outputId: string) => void>();

  constructor(readonly cfg: EngineConfig) {
    this.logger = new Logger(cfg.logLevel, join(cfg.dataDir, "logs"));
    this.db = new Database(join(cfg.dataDir, "matchframe.sqlite"));
    this.migration = this.db.migrate(join(cfg.dataDir, "backups"));
    if (this.migration.to !== this.migration.from) this.logger.info("database migrated", this.migration);
    this.secrets = new SecretStore(join(cfg.dataDir, "secrets.json"));
    this.settings = new SettingsRepo(this.db);
    this.audit = new AuditRepo(this.db);
    this.teams = new DocumentRepo(this.db, "team", Team);
    this.players = new DocumentRepo(this.db, "player", Player);
    this.events = new DocumentRepo(this.db, "event", EventRecord);
    this.matches = new DocumentRepo(this.db, "match", Match);
    this.sponsors = new DocumentRepo(this.db, "sponsor", Sponsor);
    this.rundown = new DocumentRepo(this.db, "rundown_cue", RundownCue);
    this.stages = new DocumentRepo(this.db, "event_stage", EventStage);
    this.rules = new DocumentRepo(this.db, "automation_rule", RuleSchema);
    this.setupProfiles = new DocumentRepo(this.db, "setup_profile", SetupProfile);
    this.corrections = new DocumentRepo(this.db, "stat_correction", StatCorrection);
    this.roster = new RosterRepo(this.db);
    this.steamIndex = new SteamIndexRepo(this.db);
    this.mapInstances = new MapInstanceRepo(this.db);
    this.vetoRepo = new VetoRepo(this.db);
    this.veto = new VetoService(this.vetoRepo);
    this.demoJobs = new DemoJobRepo(this.db);
    this.usageLedger = new UsageLedger(this.db);
    this.meter = new AutoDirectorMeter(this.usageLedger, { appVersion: APP_VERSION, monoNow: this.now, wallNow: Date.now });
    this.cloud = new CloudLink({
      settings: this.settings,
      secrets: this.secrets,
      ledger: this.usageLedger,
      meter: this.meter,
      logger: this.logger,
      appVersion: APP_VERSION,
      pinnedKeys: cfg.cloudPublicKeys,
      enforcement: cfg.cloudEnforcement,
      signIn: cfg.cloudSignIn,
      fixedUrl: cfg.cloudUrl,
    });

    this.loadMapPacks();
    this.utilityProfiles = this.loadUtilityProfiles();
    this.session = new LiveSession({
      logger: this.logger,
      maps: this.maps,
      now: this.now,
      utilityProfiles: this.utilityProfiles.profiles,
      resolveRoster: (steamId) => {
        const playerId = this.steamIndex.lookup(steamId);
        if (!playerId) return null;
        const p = this.players.get(playerId);
        return { playerId, teamId: this.roster.teamOf(playerId), displayName: p?.data.displayName ?? null };
      },
      verifiedControl: () => this.settings.get("observer.verifiedControl", {}),
      armGate: (simulated, observerMode) => this.cloud.canArm(simulated || this.simulationRunning, observerMode),
    });
    this.refreshScenarios();

    this.obs = new ObsManager();
    this.obs.on("disconnected", () => {
      this.program.markDegraded("OBS disconnected");
      this.logger.warn("OBS disconnected; program marked DEGRADED");
    });
    this.obs.on("connected", () => this.ruleEngine.resetWatermark());
    this.program = new ProgramArbiter(
      {
        connected: () => this.obs.state.connected,
        setProgram: async (scene) => (await this.obs.setProgram(scene)).confirmed,
      },
      this.settings.get("program.scenes", { LIVE: null, REPLAY: null, STUDIO: null, BREAK: null }),
    );
    this.replays = new ReplayQueue(null);
    this.ruleEngine = new RuleEngine((action, event, rule) => this.executeRuleAction(action, event, rule), this.now);
    if (this.rules.list().length === 0) for (const r of exampleRules()) this.rules.create(r);
    this.ruleEngine.setRules(this.rules.list().map((d) => d.data));

    this.hudPackages = new HudPackageManager(this.db, join(cfg.dataDir, "huds"));
    this.outputs = new OutputService(this.db, this.settings);
    this.registerBuiltinHud();
    this.hudLibrary = new HudLibraryService({ db: this.db, settings: this.settings, packages: this.hudPackages, outputs: this.outputs, logger: this.logger, hudsDir: join(cfg.dataDir, "huds"), hudRendererDir: cfg.hudRendererDir, overlayPort: cfg.overlayPort });
    // Settings (and installed version) changes push a new snapshot to every output of that HUD.
    this.hudLibrary.onChange((ev) => {
      if (ev.type === "settings") for (const fn of this.hudListeners) fn(libraryOutputId(ev.hudId));
    });

    this.workers = new PythonWorkerRunner(cfg.pythonPath, cfg.workersDir);
    this.training = new TrainingService({ workers: this.workers, dataDir: cfg.dataDir, demoJobs: this.demoJobs, settings: this.settings, session: this.session, logger: this.logger });
    this.demos = new DemoLibrary(this.demoJobs, this.settings, this.workers, this.logger, cfg.dataDir, () => {
      const st = this.session.state();
      return !!st && !st.simulated && !st.sources[0]?.stale;
    });

    this.gameConsole = new GameConsoleService({ settings: this.settings, teams: this.teams, logger: this.logger });
    this.radars = BuiltinRadars.load(cfg.radarDir, (msg, data) => this.logger.warn(msg, data));

    this.session.on("events", (evs) => this.onDerivedEvents(evs));
    this.session.on("state", (s) => this.onState(s));
    this.session.on("alert", (a) => this.logger.log(a.level === "error" ? "error" : a.level === "warn" ? "warn" : "info", `alert: ${a.message}`, { code: a.code }));
  }

  private loadUtilityProfiles(): Engine["utilityProfiles"] {
    const file = this.cfg.utilityProfilesFile;
    if (!file || !existsSync(file)) return { profiles: DEFAULT_PROFILES, measuredTypes: [], file: null, error: null };
    try {
      const r = profilesFromMeasured(JSON.parse(readFileSync(file, "utf8")) as MeasuredProfilesFile);
      return { profiles: r.profiles, measuredTypes: r.measuredTypes, file, error: null };
    } catch (e) {
      return { profiles: DEFAULT_PROFILES, measuredTypes: [], file, error: e instanceof Error ? e.message : String(e) };
    }
  }

  // ---------------------------------------------------------------------------- map packs

  private readonly basePacks = new Map<string, MapPack>();

  /** Registers a pack as the base for camera overrides (shipped JSON, revision changes). */
  registerBasePack(pack: MapPack): void {
    this.basePacks.set(pack.mapName, pack);
    this.maps.register(pack);
    this.applyCameraOverrides(pack.mapName);
  }

  loadMapPacks(): void {
    const dirs = [this.cfg.mapPackDir, join(this.cfg.dataDir, "map-packs")].filter((d): d is string => !!d && existsSync(d));
    for (const dir of dirs) {
      for (const f of readdirSync(dir)) {
        if (!f.endsWith(".json") || f.endsWith(".graph.json")) continue;
        try {
          const rt = this.maps.registerRaw(JSON.parse(readFileSync(join(dir, f), "utf8")), join(dir, f));
          if (rt) this.registerBasePack(rt.pack);
        } catch (e) {
          this.maps.issues.push({ file: join(dir, f), error: e instanceof Error ? e.message : String(e) });
        }
      }
    }
    if (this.maps.issues.length) this.logger.warn("map pack issues", this.maps.issues);
  }

  /** Operator-authored cameras are stored separately and merged into their map pack. */
  applyCameraOverrides(mapName: string): void {
    const base = this.basePacks.get(mapName) ?? this.maps.get(mapName)?.pack;
    if (!base) return;
    const cams = this.settings.get<typeof base.cameras>(`cameras.${mapName}`, []);
    const ids = new Set(cams.map((c) => c.id));
    this.maps.register({ ...base, cameras: [...base.cameras.filter((c) => !ids.has(c.id)), ...cams] });
  }

  refreshScenarios(): void {
    const rules: UtilityScenarioRule[] = [INFERNO_BOTTOM_BANANA_RULE];
    for (const rt of this.maps.list()) {
      for (const s of rt.pack.scenarios) {
        const r = s as unknown as UtilityScenarioRule;
        if (typeof r.id === "string" && Array.isArray(r.regionIds) && !rules.some((x) => x.id === r.id)) rules.push(r);
      }
    }
    this.session.director.setScenarios(rules);
    this.session.director.setMap(this.session.state()?.mapName ? this.maps.get(this.session.state()!.mapName!) : undefined);
  }

  // ---------------------------------------------------------------------------- HUD

  private registerBuiltinHud(): void {
    const manifest: HudManifest = {
      manifestVersion: 1,
      id: "matchframe-default",
      name: "Matchframe Broadcast HUD",
      version: "0.1.0",
      author: "Matchframe Esports",
      licence: "Proprietary (Matchframe Esports)",
      description: "Original Matchframe HUD with Classic, Minimal and Arena presets.",
      game: "cs2",
      schemaVersions: [1],
      entryPoints: { live: "index.html", compact: "index.html", replay: "index.html", veto: "index.html", "pre-match": "index.html", break: "index.html", "post-map": "index.html", "post-series": "index.html", studio: "index.html" },
      preview: null,
      thumbnail: "thumbnail.webp",
      category: "Broadcast",
      tags: ["scoreboard", "radar", "players", "killfeed"],
      designResolution: { width: 1920, height: 1080 },
      permissions: ["match.public", "players.public", "radar.public", "utility.public", "sponsors", "series", "event", "veto.public", "annotations"],
      presets: [
        { id: "classic", name: "Matchframe Classic" },
        { id: "minimal", name: "Matchframe Minimal" },
        { id: "arena", name: "Matchframe Arena" },
      ],
      settingsSchema: {
        "hide.scoreboard": { type: "boolean", label: "Hide scoreboard", default: false, group: "Elements" },
        "hide.radar": { type: "boolean", label: "Hide radar", default: false, group: "Elements" },
        "hide.killfeed": { type: "boolean", label: "Hide kill feed", default: false, group: "Elements" },
        "hide.players": { type: "boolean", label: "Hide player panels", default: false, group: "Elements" },
        "hide.observed": { type: "boolean", label: "Hide observed player", default: false, group: "Elements" },
        "hide.history": { type: "boolean", label: "Hide round history", default: false, group: "Elements" },
        reducedMotion: { type: "boolean", label: "Reduced motion", description: "Fewer animations and transitions.", default: false, group: "Display" },
      },
      resolutions: ["1920x1080", "2560x1440", "3840x2160"],
      classification: "builtin",
    };
    this.hudPackages.registerBuiltin(manifest, this.cfg.hudRendererDir ?? "");
    this.outputs.ensureDefaults("matchframe-default");
  }

  /** Called by the overlay server to subscribe to HUD pushes. */
  onHudUpdate(fn: (outputId: string) => void): () => void {
    this.hudListeners.add(fn);
    return () => this.hudListeners.delete(fn);
  }

  activeMatch(): Match | null {
    const id = this.settings.get<string | null>("live.activeMatchId", null);
    return id ? (this.matches.get(id)?.data ?? null) : null;
  }

  setActiveMatch(matchId: string | null): void {
    this.settings.set("live.activeMatchId", matchId);
    const m = matchId ? this.matches.get(matchId)?.data : null;
    this.sides = new TeamSideTracker({ leftTeamId: m?.teamAId ?? null, rightTeamId: m?.teamBId ?? null });
    this.roundWinnersLR.clear();
  }

  /** Standings/bracket for studio and break screens only (public team fields). */
  private stageProjection(stageId: string | null, variant: string): Pick<HudContext, "standings" | "bracket"> {
    const stage = stageId && (variant === "studio" || variant === "break") ? this.stages.get(stageId)?.data : undefined;
    if (!stage) return { standings: null, bracket: null };
    const matches = this.matches.list().map((d) => d.data).filter((m) => m.stageId === stage.id || stage.bracket.some((n) => n.matchId === m.id));
    const team = (id: string | null) => {
      const t = id ? this.teams.get(id)?.data : undefined;
      return t ? { name: t.name, shortName: t.shortName, logoUrl: this.assetUrl(t.logoAssetId) } : null;
    };
    const standings =
      stage.kind === "single_elimination"
        ? null
        : {
            stageName: stage.name,
            rows: computeStandings(stage, matches, matches.flatMap((m) => this.mapInstances.forMatch(m.id))).rows.map((r) => ({ position: r.position, tied: r.tied, advancing: r.advancing, team: team(r.teamId), played: r.played, wins: r.wins, ties: r.ties, losses: r.losses, points: r.points, mapDifference: r.mapDifference, roundDifference: r.roundDifference })),
          };
    const bracket =
      stage.bracket.length === 0
        ? null
        : { stageName: stage.name, nodes: buildBracket(stage, matches).map((n) => ({ id: n.id, round: n.round, slot: n.slot, label: n.label, status: n.status, a: { team: team(n.a.teamId), placeholder: n.a.placeholder, score: n.a.score, winner: n.a.winner }, b: { team: team(n.b.teamId), placeholder: n.b.placeholder, score: n.b.score, winner: n.b.winner } })) };
    return { standings, bracket };
  }

  private hudContext(outputId: string, variant: string, presetId: string | null, timeline: HudContext["timeline"], settings: Record<string, unknown>, profile: string): HudContext {
    const match = this.activeMatch();
    const teams = new Map(this.teams.list().map((t) => [t.id, t.data]));
    const playersBySteam = new Map<string, Player>();
    for (const p of this.players.list()) if (p.data.steamId) playersBySteam.set(p.data.steamId, p.data);
    const state = this.session.state();
    const programMode = this.program.mode;
    const sponsorsOn = profile !== "clean";
    const sponsorMap: HudState["sponsors"] = {};
    if (sponsorsOn) {
      const list = this.sponsors.list().map((d) => d.data);
      const roundPhase = state?.roundPhase ?? null;
      const bombPlanted = state?.bomb?.state === "planted" || state?.bomb?.state === "defusing";
      for (const zone of ["top_bar", "bottom_left", "bottom_right", "scoreboard_slot", "break_fullscreen", "result_banner"]) {
        const ok = zoneAllowed(zone, { programMode, roundPhase, bombPlanted, clutch: false });
        if (!ok.allowed) {
          sponsorMap[zone] = null;
          continue;
        }
        const pick = this.sponsorRotation.next(zone, list, Date.now());
        const sp = pick ? list.find((s) => s.id === pick.sponsorId) : undefined;
        sponsorMap[zone] = sp && pick ? { sponsorId: sp.id, name: sp.name, assetUrl: this.assetUrl(sp.assetIds[0] ?? null), untilMs: pick.untilMs } : null;
      }
    }
    const cues = [...this.cues.values()]
      .filter((c) => (c.untilMs === null || c.untilMs > Date.now()) && (c.outputs === null || c.outputs.includes(outputId)))
      .map((c) => ({ id: c.id, kind: c.kind, title: c.title, subtitle: c.subtitle, data: c.data }));
    const replayActive = programMode === "REPLAY_PLAYING";
    return {
      outputId,
      variant: replayActive && variant === "live" ? "replay" : variant,
      presetId,
      timeline,
      match,
      mapInstances: match ? this.mapInstances.forMatch(match.id) : [],
      teams,
      playersBySteam,
      event: (() => {
        const stageId = typeof settings.stageId === "string" ? settings.stageId : null;
        const eventId = match?.eventId ?? (stageId ? (this.stages.get(stageId)?.data.eventId ?? null) : null);
        return eventId ? (this.events.get(eventId)?.data ?? null) : null;
      })(),
      assetUrl: (id) => this.assetUrl(id),
      map: state?.mapName ? this.maps.get(state.mapName) : undefined,
      builtinRadar: this.radars.get(state?.mapName ?? null),
      killfeed: { mode: this.killfeed.mode, entries: this.killfeed.list() },
      sponsors: sponsorMap,
      cues: profile === "clean" ? [] : cues,
      replay: { active: replayActive, label: replayActive ? "REPLAY" : null },
      annotations: this.annotations.filter((a) => a.expiresAtMs === null || a.expiresAtMs > Date.now()),
      veto: null,
      ...this.stageProjection(typeof settings.stageId === "string" ? settings.stageId : (match?.stageId ?? null), variant),
      settings: { ...settings, roundWinnersLR: Object.fromEntries(this.roundWinnersLR) },
      radarUtility: this.settings.get("hud.radarUtility", true),
      allowUnverifiedRadar: this.settings.get("hud.allowUnverifiedRadar", false),
    };
  }

  assetUrl(assetId: string | null): string | null {
    if (!assetId) return null;
    return `/assets/${encodeURIComponent(assetId)}`;
  }

  /**
   * Public HUD state for a published output on its presentation timeline. Library outputs
   * (`hud:<id>`) use the live timeline (no delay), the HUD's own settings and preset, and the
   * program profile.
   */
  hudState(outputId: string, variantOverride?: string): HudState | null {
    const now = this.now();
    let state: MatchState | null = this.session.state() ? this.session.stateAt(now) : null;
    let ctx: HudContext;
    const hudId = libraryHudId(outputId);
    if (hudId !== null) {
      const lib = this.hudLibrary.runtimeConfig(hudId);
      if (!lib) return null;
      const variant = variantOverride && (lib.variants as string[]).includes(variantOverride) ? variantOverride : lib.variants.includes("live") ? "live" : (lib.variants[0] ?? "live");
      ctx = this.hudContext(outputId, variant, lib.presetId, { profile: "live", delayMs: 0 }, lib.settings, "program");
    } else {
      const pub = this.outputs.published(outputId);
      if (!pub) return null;
      const d = pub.data;
      if (d.timelineProfile === "delayed" && d.delayMs > 0) {
        const buf = this.delayBuffers.get(outputId);
        const hit = buf?.at(now, d.delayMs) ?? null;
        // Until the delay buffer has filled, show nothing rather than ahead-of-program data.
        state = hit ? hit.value : null;
      }
      ctx = this.hudContext(outputId, variantOverride ?? d.variant, d.presetId, { profile: d.timelineProfile, delayMs: d.delayMs }, d.settings, d.profile);
    }
    const hud = buildHudState(state, ctx, this.sides, now);
    // Round history winners recorded at round end with the side assignment at that time.
    for (const r of hud.roundHistory) if (r.winner === null) r.winner = this.roundWinnersLR.get(r.roundNumber) ?? null;
    return hud;
  }

  private onState(s: MatchState): void {
    if (!s.simulated) this.gameConsole.onState(s);
    for (const o of this.outputs.list()) {
      const pub = o.published?.data;
      if (pub && pub.timelineProfile === "delayed" && pub.delayMs > 0) {
        let buf = this.delayBuffers.get(pub.outputId);
        if (!buf) {
          buf = new DelayBuffer<MatchState>(Math.max(pub.delayMs, 1000));
          this.delayBuffers.set(pub.outputId, buf);
        }
        buf.push(this.now(), s);
      }
    }
    // Keyed by session + round attempt: a restarted session must not inherit old entries.
    this.killfeed.resetForRound(`${s.sessionId}:${s.epoch}:${s.roundAttemptId}`);
    const map = s.mapName ? this.maps.get(s.mapName) : undefined;
    this.session.director.setMap(map);
    this.enforceAllowanceAtMapChange(s);
    for (const fn of this.hudListeners) fn("*");
  }

  // ---------------------------------------------------------------------------- cloud metering

  /** What the auto-director meter needs to decide whether this second is billable. */
  meterInput(): MeterInput {
    const s = this.session.state();
    const adapter = this.session.arbiter.getAdapter();
    return {
      accountLinked: this.cloud.link !== null,
      automationActive: this.session.arbiter.automationAllowed,
      controlAvailable: !!adapter && adapter.kind !== "none" && !adapter.simulated,
      mode: this.session.director.currentMode,
      simulated: this.simulationRunning || this.session.simulated || !!s?.simulated,
      // GSI heartbeats every 10 s when nothing changes; longer silence means the game is gone.
      telemetryLive: !!s && this.now() - s.time.receivedAtMonotonicMs <= 15_000,
      sessionId: this.session.sessionId,
      mapName: s?.mapName ?? null,
      matchRef: this.activeMatch()?.id ?? null,
    };
  }

  /**
   * Hours never run out mid-map: when the allowance is used up (or the licence lapsed) automation
   * keeps running until the map changes, then hands the camera back to the operator.
   */
  private enforceAllowanceAtMapChange(s: MatchState): void {
    const prev = this.cloudMap;
    this.cloudMap = s.mapName;
    if (prev === null || s.mapName === null || prev === s.mapName) return;
    const mode = this.session.director.currentMode;
    if (!this.session.arbiter.automationAllowed || (mode !== "automatic" && mode !== "assisted")) return;
    const simulated = this.session.simulated || this.simulationRunning;
    const observer = this.session.observerMode;
    const gate = this.cloud.canArm(simulated, observer);
    if (gate.ok) return;
    // The plan no longer includes Full Action Observer: carry on without nade cameras.
    if (observer === "full_action" && this.cloud.canArm(simulated, "observer_cinematics").ok) {
      this.session.setObserverMode("observer_cinematics");
      this.audit.record("system", "cloud.observer_mode_reduced", s.mapName, { from: observer, to: "observer_cinematics", previousMap: prev });
      this.session.emit("alert", { level: "warn", code: "cloud_full_action_unavailable", message: `Switched to Observer & Cinematics at the map change: ${gate.reason}` });
      return;
    }
    this.meter.flush();
    this.session.takeover("auto-director-allowance");
    this.session.setMode("advisory");
    this.audit.record("system", "cloud.allowance_takeover", s.mapName, { code: gate.code, previousMap: prev });
    this.session.emit("alert", { level: "warn", code: `cloud_${gate.code}`, message: `Automatic direction stopped at the map change: ${gate.reason}` });
  }

  private playerCam = { lastPlayerId: null as string | null, lastSource: null as string | null, lastError: null as string | null, lastAt: null as string | null, applied: 0 };

  playerCamStatus(): Record<string, unknown> {
    return { ...this.playerCam, obsConnected: this.obs.state.connected, programMode: this.program.mode };
  }

  /**
   * Shows the observed player's camera source (by stable player ID, never by observer slot) and
   * hides the other configured player sources. Only players who consented are routed; outside LIVE
   * program mode nothing is changed. An optional delay aligns cameras with a delayed program.
   */
  private routePlayerCamera(observedSteamId: string | null): void {
    const cfg = this.settings.get<{ enabled?: boolean; scene?: string | null; sources?: Record<string, string>; fallbackSource?: string | null; delayMs?: number }>("playerCams", {});
    if (!cfg.enabled || !cfg.scene || !this.obs.state.connected || this.program.mode !== "LIVE") return;
    const playerId = observedSteamId ? this.steamIndex.lookup(observedSteamId) : null;
    const player = playerId ? this.players.get(playerId)?.data : undefined;
    const target = player?.cameraConsent && playerId ? (cfg.sources?.[playerId] ?? null) : null;
    const show = target ?? cfg.fallbackSource ?? null;
    const apply = async () => {
      try {
        const all = new Set([...Object.values(cfg.sources ?? {}), ...(cfg.fallbackSource ? [cfg.fallbackSource] : [])]);
        for (const src of all) await this.obs.setSourceVisible(cfg.scene!, src, src === show);
        this.playerCam = { lastPlayerId: playerId, lastSource: show, lastError: null, lastAt: new Date().toISOString(), applied: this.playerCam.applied + 1 };
      } catch (err) {
        this.playerCam = { ...this.playerCam, lastError: err instanceof Error ? err.message : String(err), lastAt: new Date().toISOString() };
      }
    };
    if (cfg.delayMs && cfg.delayMs > 0) setTimeout(() => void apply(), cfg.delayMs);
    else void apply();
  }

  private onDerivedEvents(evs: DerivedEvent[]): void {
    for (const ev of evs) if (ev.kind === "observer_changed") this.routePlayerCamera((ev.data.to as string | null) ?? null);
    const state = this.session.state();
    const nameOf = (steamId: string) => {
      const p = state?.players.find((x) => x.steamId === steamId);
      const reg = this.players.get(this.steamIndex.lookup(steamId) ?? "")?.data;
      return { name: reg?.displayName ?? p?.name ?? steamId, side: (p?.side ?? null) as Side | null };
    };
    this.killfeed.ingest(evs, nameOf);
    if (state) {
      for (const e of evs) {
        if (e.kind === "round_end" && typeof e.data.roundNumber === "number" && e.data.winnerSide) {
          const { left } = this.sides.assign(state);
          this.roundWinnersLR.set(e.data.roundNumber, e.data.winnerSide === left ? "left" : "right");
        }
        if (e.kind === "epoch_changed") this.ruleEngine.resetWatermark();
      }
    }
    for (const e of evs) void this.dispatchRuleEvent(e);
  }

  private async dispatchRuleEvent(e: DerivedEvent): Promise<void> {
    const kind = (e.kind === "observer_changed" ? "observer_changed" : e.kind) as TriggerKind;
    const ev: TriggerEvent = { eventId: e.eventId, kind, epoch: e.epoch, observedAtMs: e.receivedAtMonotonicMs, data: e.data };
    const caps = this.session.capabilities();
    const capMap: Record<string, string> = {};
    for (const [k, v] of Object.entries(caps)) if (v && typeof v === "object" && "support" in v) capMap[k] = (v as { support: string }).support;
    try {
      await this.ruleEngine.onEvent(ev, { programMode: this.program.mode as ProgramMode, capabilities: capMap, phase: this.session.state()?.gamePhase ?? null });
    } catch (err) {
      this.logger.warn("rule dispatch failed", { error: String(err) });
    }
  }

  private async executeRuleAction(action: AutomationRule["action"], event: TriggerEvent, rule: AutomationRule): Promise<void> {
    const p = action.params;
    switch (action.kind) {
      case "hud_cue":
        this.showCue({ kind: String(p.cue ?? "cue"), title: String(p.title ?? p.cue ?? rule.name), subtitle: null, data: { ruleId: rule.id, eventId: event.eventId }, durationMs: Number(p.durationMs ?? 6000), outputs: null });
        return;
      case "obs_scene":
        if (typeof p.scene === "string") await this.obs.setProgram(p.scene);
        return;
      case "obs_source_visibility":
        if (typeof p.scene === "string" && typeof p.source === "string") await this.obs.setSourceVisible(p.scene, p.source, p.visible !== false);
        return;
      case "replay_bookmark":
        this.replays.bookmark(`Auto: ${rule.name}`, event.kind, this.session.state()?.roundNumber ?? null);
        return;
      case "alert":
        this.logger.log(p.level === "error" ? "error" : "warn", String(p.message ?? rule.name));
        return;
      case "sponsor_show":
      case "hud_variant":
        this.showCue({ kind: action.kind, title: rule.name, subtitle: null, data: p, durationMs: Number(p.durationMs ?? 6000), outputs: null });
        return;
    }
  }

  showCue(c: { kind: string; title: string; subtitle: string | null; data: Record<string, unknown>; durationMs: number | null; outputs: string[] | null }): Cue {
    const cue: Cue = { id: `cue_${Date.now().toString(36)}_${this.cues.size}`, kind: c.kind, title: c.title, subtitle: c.subtitle, data: c.data, untilMs: c.durationMs ? Date.now() + c.durationMs : null, outputs: c.outputs };
    this.cues.set(cue.id, cue);
    for (const fn of this.hudListeners) fn("*");
    return cue;
  }

  clearCue(id: string): void {
    this.cues.delete(id);
    for (const fn of this.hudListeners) fn("*");
  }

  listCues(): Cue[] {
    return [...this.cues.values()];
  }

  setAnnotations(a: HudState["annotations"]): void {
    this.annotations = a;
    for (const fn of this.hudListeners) fn("*");
  }

  get annotationsList(): HudState["annotations"] {
    return this.annotations;
  }

  // ---------------------------------------------------------------------------- observer adapter

  observerSettings(): ObserverAdapterSettings {
    return ObserverAdapterSettings.parse(this.settings.get("observer.adapter", {}));
  }

  async applyObserverAdapter(): Promise<void> {
    if (this.sim) return; // simulation owns the adapter while running
    const s = this.observerSettings();
    const verified = this.settings.get<Record<string, { support: "supported" | "partial"; build: string | null; at: string }>>("observer.verifiedControl", {});
    if (s.kind === "netcon") {
      // Shares the console connection Start CS2 opened when it is the same game console.
      const shared = this.gameConsole.connection;
      const connection = shared && shared.port === s.port && ["127.0.0.1", "localhost"].includes(s.host) ? shared : undefined;
      await this.session.setAdapter(new NetconObserverAdapter({ host: s.host, port: s.port, templates: s.templates, now: this.now, verified, connection }));
    } else if (s.kind === "keyboard") {
      const backend = await loadWindowsInputBackend();
      await this.session.setAdapter(new KeyboardObserverAdapter(backend, { windowTitle: new RegExp(s.windowTitle), now: this.now, verified: verified.playerSelectionControl ?? null }));
    } else {
      await this.session.setAdapter(new NoControlAdapter());
    }
  }

  // ---------------------------------------------------------------------------- simulation

  get simulationRunning(): boolean {
    return this.sim !== null;
  }

  async startSimulation(opts: { startOffsetSec?: number } = {}): Promise<void> {
    if (this.sim) return;
    if (!this.maps.get("de_synthetic")) this.registerBasePack(syntheticMapPack({ withValidatedCamera: true, mapName: "de_synthetic" }));
    this.refreshScenarios();
    this.session.restart(true);
    const adapter = new SimulationObserverAdapter(this.now, { acquisitionMs: 150 });
    await this.session.setAdapter(adapter);
    const simulator = new RoundSimulator(adapter.observer, this.now, opts);
    const token = this.secrets.gsiToken;
    const timer = setInterval(() => {
      const payload = simulator.payload(token);
      const text = JSON.stringify(payload);
      this.session.ingestGsi(payload, "simulation", this.now(), text);
    }, 100);
    this.sim = { simulator, adapter, timer };
    this.sides = new TeamSideTracker();
    this.audit.record("system", "simulation.start", null);
  }

  async stopSimulation(): Promise<void> {
    if (!this.sim) return;
    clearInterval(this.sim.timer);
    this.sim = null;
    this.session.restart(false);
    await this.applyObserverAdapter();
    this.audit.record("system", "simulation.stop", null);
  }

  // ---------------------------------------------------------------------------- replay

  configureReplay(): void {
    const cfg = this.settings.get<{ kind: "none" | "obs" | "bridge"; bridgeUrl?: string; bufferSeconds?: number }>("replay.provider", { kind: "obs", bufferSeconds: 20 });
    if (cfg.kind === "obs") this.replayProvider = new ObsReplayBufferProvider(this.obs, { bufferSeconds: cfg.bufferSeconds ?? null });
    else if (cfg.kind === "bridge" && cfg.bridgeUrl) {
      const token = this.secrets.getSecret("replay.bridgeToken");
      this.replayProvider = new ReplayBridgeProvider(cfg.bridgeUrl, token ? { token } : {});
    } else this.replayProvider = null;
    this.replays.setProvider(this.replayProvider);
  }

  get replayProviderInstance(): ReplayProvider | null {
    return this.replayProvider;
  }

  // ---------------------------------------------------------------------------- lifecycle

  async init(): Promise<void> {
    this.hudLibrary.installSamples(this.cfg.sampleHudsDirs);
    this.configureReplay();
    this.gameConsole.sync();
    this.gameConsole.onConnectionChange(() => void this.applyObserverAdapter());
    await this.applyObserverAdapter();
    this.session.start();
    this.meterTimer = setInterval(() => this.meter.tick(this.meterInput()), 1000);
    void this.cloud.start();
    this.demos.start();
    const shadowIssue = this.training.restore();
    if (shadowIssue) this.audit.record("system", "model.shadow_rejected", this.settings.get("models.shadowModelId", null), { reason: shadowIssue });
    // Restart always resumes in manual/disarmed mode until sources and ownership are validated.
    this.session.setMode("advisory");
    this.audit.record("system", "engine.start", null, { version: APP_VERSION, migration: this.migration });
  }

  async shutdown(): Promise<void> {
    await this.stopSimulation().catch(() => undefined);
    this.demos.stop();
    this.session.stop();
    if (this.meterTimer) clearInterval(this.meterTimer);
    this.meterTimer = null;
    await this.cloud.stop().catch(() => undefined);
    await this.obs.disconnect().catch(() => undefined);
    await this.session.setAdapter(null);
    this.gameConsole.stop();
    this.db.close();
  }

  /** Sanitized health summary. */
  health(): Record<string, unknown> {
    const s = this.session.state();
    const primary = s?.sources[0] ?? null;
    return {
      ok: true,
      version: APP_VERSION,
      startedAt: this.startedAt,
      simulated: this.simulationRunning,
      telemetry: primary ? { sourceId: primary.sourceId, stale: primary.stale, packets: primary.packetsReceived, gameBuild: primary.gameBuild } : null,
      director: { mode: this.session.director.currentMode, ownership: this.session.arbiter.state(), adapter: this.session.arbiter.getAdapter()?.kind ?? "none" },
      obs: { connected: this.obs.state.connected, lastError: this.obs.state.lastError },
      utilityProfiles: { measuredTypes: this.utilityProfiles.measuredTypes, defaultsFor: Object.keys(this.utilityProfiles.profiles).filter((t) => !this.utilityProfiles.measuredTypes.includes(t)), error: this.utilityProfiles.error },
      program: this.program.mode,
      schemaVersion: this.db.schemaVersion,
      mapPacks: this.maps.list().map((m) => m.mapName),
    };
  }
}
