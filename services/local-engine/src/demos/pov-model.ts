import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { SettingsRepo } from "../db/store.ts";
import type { Logger } from "../logger.ts";
import type { LiveSession } from "../live/session.ts";
import { loadPovModel, type LivePovModel, type ModelCard } from "../live/model-runtime.ts";
import type { RegistryEntry } from "./training.ts";

const KEY = "director.povModel";
/** The model shipped with the program (assets/models). */
export const BUILTIN_POV_MODEL = "builtin";

export interface PovModelSetting {
  enabled: boolean;
  /** `builtin` or the id of a trained `pov_2s` model with an export. */
  modelId: string;
  /** How much of the director's imminence comes from the model (0..1). */
  weight: number;
  /** The probability counted as "a kill is coming" (full imminence). */
  ref: number;
}

/** Test bench (7 pro matches, each scored by a model trained without it): 0.5 / 0.5 was the best blend. */
export const DEFAULT_POV_MODEL: PovModelSetting = { enabled: true, modelId: BUILTIN_POV_MODEL, weight: 0.5, ref: 0.5 };

export interface PovModelStatus {
  setting: PovModelSetting;
  /** What is steering the director now (null: off, or the model could not be loaded). */
  active: { modelId: string; builtin: boolean; notes: string | null; maps: string[]; sha256: string; bench: unknown } | null;
  error: string | null;
  /** Trained `pov_2s` models that can be used instead of the built-in one. */
  available: { modelId: string; createdAt: string | null; notes: string | null }[];
}

/**
 * "What the demos teach": the demo-trained POV model (`pov_2s`, per player "their POV shows a kill
 * within 2 s") blended into the live director's imminence. The built-in model ships in
 * assets/models/pov_2s-builtin; a model trained here on your own demos can replace it. A model that
 * fails to load leaves the deterministic director in charge.
 */
export class PovModelService {
  private model: LivePovModel | null = null;
  private card: (ModelCard & { supported_maps?: string[]; bench?: unknown }) | null = null;
  private error: string | null = null;

  constructor(
    private readonly deps: {
      settings: SettingsRepo;
      session: LiveSession;
      builtinDir: string | null;
      modelsDir: string;
      registry: () => RegistryEntry[];
      logger: Logger;
    },
  ) {}

  setting(): PovModelSetting {
    return { ...DEFAULT_POV_MODEL, ...this.deps.settings.get<Partial<PovModelSetting>>(KEY, {}) };
  }

  /** The loaded model (also when switched off), for the test bench. */
  loaded(): LivePovModel | null {
    return this.model;
  }

  private exportDir(modelId: string): string | null {
    if (modelId === BUILTIN_POV_MODEL) return this.deps.builtinDir ? join(this.deps.builtinDir, "pov_2s-builtin") : null;
    return join(this.deps.modelsDir, modelId, "export");
  }

  /** Loads the configured model and applies it to the live director (on start and on every change). */
  apply(): PovModelStatus {
    const s = this.setting();
    this.model = null;
    this.card = null;
    this.error = null;
    const dir = this.exportDir(s.modelId);
    if (!dir || !existsSync(join(dir, "model_card.json"))) {
      this.error = s.modelId === BUILTIN_POV_MODEL ? "the built-in model is missing from this installation" : `model ${s.modelId} has no export`;
    } else {
      const res = loadPovModel(dir, s.modelId);
      if (res.ok) {
        this.model = res.model;
        try {
          this.card = JSON.parse(readFileSync(join(dir, "model_card.json"), "utf8")) as typeof this.card;
        } catch {
          this.card = null;
        }
      } else this.error = res.reason;
    }
    if (this.error) this.deps.logger.warn("demo-trained POV model not loaded; the director runs without it", { modelId: s.modelId, reason: this.error });
    this.deps.session.setPovModel(s.enabled ? this.model : null, { weight: s.weight, ref: s.ref });
    return this.status();
  }

  update(patch: Partial<Pick<PovModelSetting, "enabled" | "modelId">>): PovModelStatus {
    const next = { ...this.setting(), ...patch };
    if (patch.modelId && patch.modelId !== BUILTIN_POV_MODEL && !this.available().some((m) => m.modelId === patch.modelId)) {
      throw Object.assign(new Error(`model ${patch.modelId} is not a trained POV model with an export`), { status: 400 });
    }
    this.deps.settings.set(KEY, next);
    return this.apply();
  }

  private available(): PovModelStatus["available"] {
    return this.deps
      .registry()
      .filter((m) => m.task === "pov_2s" && m.exportAvailable && m.status !== "retired" && m.status !== "rolled_back")
      .map((m) => ({ modelId: m.modelId, createdAt: m.createdAt, notes: m.notes }));
  }

  status(): PovModelStatus {
    const s = this.setting();
    const on = s.enabled && this.model !== null;
    return {
      setting: s,
      active:
        on && this.model
          ? { modelId: this.model.id, builtin: this.model.id === BUILTIN_POV_MODEL, notes: this.card?.notes ?? null, maps: this.card?.supported_maps ?? [], sha256: this.model.sha256, bench: this.card?.bench ?? null }
          : null,
      error: this.error,
      available: this.available(),
    };
  }
}
