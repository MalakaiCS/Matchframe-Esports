import { HUD_VARIANTS } from "./types.ts";
import type { HotkeyConfig, HudVariant, OverlayConfigPatch } from "./types.ts";

/**
 * Argument checks for the `mf:hud-*` IPC calls (pure; no Electron). Everything that arrives from the
 * renderer is untrusted: each check throws a plain-language Error the console can show.
 */

export const HUD_ID = /^[a-z0-9][a-z0-9.-]{2,63}$/;
export const MAX_ZIP_BYTES = 60 * 1024 * 1024;
export const MAX_SAVE_BYTES = 100 * 1024 * 1024;

/** Coordinate and size limits for DIP bounds (generous: an 8K display at 100 % is 7680 wide). */
const COORD = 100_000;
const MAX_SIZE = 32_768;
const MIN_SIZE = 16;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

export function hudIdArg(v: unknown): string {
  if (typeof v !== "string" || !HUD_ID.test(v)) throw new Error("That is not a valid HUD id.");
  return v;
}

export const isVariant = (v: unknown): v is HudVariant => typeof v === "string" && (HUD_VARIANTS as readonly string[]).includes(v);

export function variantArg(v: unknown): HudVariant {
  if (!isVariant(v)) throw new Error(`Unknown HUD variant (expected one of ${HUD_VARIANTS.join(", ")}).`);
  return v;
}

export function booleanArg(v: unknown, name: string): boolean {
  if (typeof v !== "boolean") throw new Error(`${name} must be true or false.`);
  return v;
}

function numberArg(v: unknown, name: string, min: number, max: number): number {
  if (!finite(v) || v < min || v > max) throw new Error(`${name} must be a number from ${min} to ${max}.`);
  return v;
}

function onlyKeys(o: Record<string, unknown>, allowed: readonly string[], what: string): void {
  const extra = Object.keys(o).filter((k) => !allowed.includes(k));
  if (extra.length) throw new Error(`Unexpected ${what} field${extra.length > 1 ? "s" : ""}: ${extra.join(", ")}.`);
}

export function launchOptsArg(v: unknown): { variant?: HudVariant } {
  if (v === undefined || v === null) return {};
  if (!isObject(v)) throw new Error("Launch options must be an object.");
  onlyKeys(v, ["variant"], "launch");
  return v.variant === undefined ? {} : { variant: variantArg(v.variant) };
}

export function previewOptsArg(v: unknown): { variant: HudVariant; checker: boolean } {
  if (!isObject(v)) throw new Error("Preview options must be an object.");
  onlyKeys(v, ["variant", "checker"], "preview");
  return { variant: variantArg(v.variant), checker: v.checker === undefined ? false : booleanArg(v.checker, "checker") };
}

export function configPatchArg(v: unknown): OverlayConfigPatch {
  if (!isObject(v)) throw new Error("The overlay settings must be an object.");
  onlyKeys(v, ["displayId", "bounds", "scale", "locked", "variant", "fit"], "overlay");
  const out: OverlayConfigPatch = {};
  if (v.displayId !== undefined) {
    if (!finite(v.displayId) || !Number.isSafeInteger(v.displayId)) throw new Error("displayId must be a display id from displays().");
    out.displayId = v.displayId;
  }
  if (v.bounds !== undefined) {
    if (!isObject(v.bounds)) throw new Error("bounds must be an object.");
    onlyKeys(v.bounds, ["x", "y", "width", "height"], "bounds");
    const b: NonNullable<OverlayConfigPatch["bounds"]> = {};
    if (v.bounds.x !== undefined) b.x = numberArg(v.bounds.x, "bounds.x", -COORD, COORD);
    if (v.bounds.y !== undefined) b.y = numberArg(v.bounds.y, "bounds.y", -COORD, COORD);
    if (v.bounds.width !== undefined) b.width = numberArg(v.bounds.width, "bounds.width", MIN_SIZE, MAX_SIZE);
    if (v.bounds.height !== undefined) b.height = numberArg(v.bounds.height, "bounds.height", MIN_SIZE, MAX_SIZE);
    out.bounds = b;
  }
  if (v.scale !== undefined) out.scale = numberArg(v.scale, "scale", 0.1, 4);
  if (v.locked !== undefined) out.locked = booleanArg(v.locked, "locked");
  if (v.variant !== undefined) out.variant = variantArg(v.variant);
  if (v.fit !== undefined) {
    if (v.fit !== "display" && v.fit !== "native") throw new Error('fit must be "display" or "native".');
    out.fit = v.fit;
  }
  return out;
}

// ------------------------------------------------------------------ hotkeys

const MODIFIERS = new Set(["command", "cmd", "control", "ctrl", "commandorcontrol", "cmdorctrl", "alt", "option", "altgr", "shift", "super", "meta"]);
const NAMED_KEYS = new Set([
  "plus", "space", "tab", "capslock", "numlock", "scrolllock", "backspace", "delete", "insert", "return", "enter", "up", "down", "left", "right", "home", "end", "pageup", "pagedown", "escape", "esc",
  "volumeup", "volumedown", "volumemute", "medianexttrack", "mediaprevioustrack", "mediastop", "mediaplaypause", "printscreen",
  "num0", "num1", "num2", "num3", "num4", "num5", "num6", "num7", "num8", "num9", "numdec", "numadd", "numsub", "nummult", "numdiv",
]);
const PUNCTUATION = new Set([")", "!", "@", "#", "$", "%", "^", "&", "*", "(", ":", ";", "<", "=", ">", "?", "~", "[", "{", "]", "}", "|", "\\", "'", '"', ",", "-", ".", "/", "_", "`"]);
const FUNCTION_KEY = /^f([1-9]|1[0-9]|2[0-4])$/i;

/**
 * An Electron accelerator ("CommandOrControl+Shift+H"): modifiers then one key. Global hotkeys need
 * at least one modifier, except function keys (a bare letter would be taken from every program).
 */
export function acceleratorArg(v: unknown, name: string): string {
  if (typeof v !== "string") throw new Error(`The ${name} hotkey must be text such as CommandOrControl+Shift+H.`);
  const s = v.trim();
  if (!s || s.length > 64) throw new Error(`The ${name} hotkey must be text such as CommandOrControl+Shift+H.`);
  const parts = s.split("+");
  // "Ctrl++" names the plus key.
  if (parts.length > 1 && parts[parts.length - 1] === "" && parts[parts.length - 2] === "") parts.splice(-2, 2, "Plus");
  const key = parts[parts.length - 1] ?? "";
  const mods = parts.slice(0, -1).map((p) => p.trim().toLowerCase());
  if (mods.some((m) => !MODIFIERS.has(m))) throw new Error(`The ${name} hotkey "${s}" has an unknown modifier (use Ctrl, Alt, Shift, Super or CommandOrControl).`);
  if (new Set(mods).size !== mods.length) throw new Error(`The ${name} hotkey "${s}" repeats a modifier.`);
  const k = key.trim();
  const valid = /^[A-Za-z0-9]$/.test(k) || FUNCTION_KEY.test(k) || NAMED_KEYS.has(k.toLowerCase()) || PUNCTUATION.has(k);
  if (!valid) throw new Error(`The ${name} hotkey "${s}" does not end with a key.`);
  if (!mods.length && !FUNCTION_KEY.test(k)) throw new Error(`The ${name} hotkey "${s}" needs a modifier such as Ctrl or Alt.`);
  return s;
}

/** Normalised form for comparing accelerators ("ctrl+shift+h" equals "Control+Shift+H"). */
export function acceleratorKey(accel: string): string {
  const alias: Record<string, string> = { cmd: "command", ctrl: "control", cmdorctrl: "commandorcontrol", option: "alt", esc: "escape", return: "enter", meta: "super" };
  const parts = accel.toLowerCase().split("+").map((p) => alias[p.trim()] ?? p.trim());
  const key = parts.pop() ?? "";
  return [...parts.sort(), key].join("+");
}

export function hotkeyPatchArg(v: unknown): Partial<HotkeyConfig> {
  if (!isObject(v)) throw new Error("The hotkey settings must be an object.");
  onlyKeys(v, ["toggle", "emergencyHide"], "hotkey");
  const out: Partial<HotkeyConfig> = {};
  if (v.toggle !== undefined) out.toggle = acceleratorArg(v.toggle, "toggle");
  if (v.emergencyHide !== undefined) out.emergencyHide = acceleratorArg(v.emergencyHide, "emergency hide");
  return out;
}

// ------------------------------------------------------------------ files

/** Bytes from the renderer (Uint8Array, Buffer or ArrayBuffer), at most `max` bytes. */
export function bytesArg(v: unknown, max: number): Uint8Array {
  const bytes = v instanceof Uint8Array ? v : v instanceof ArrayBuffer ? new Uint8Array(v) : null;
  if (!bytes) throw new Error("The file contents are missing.");
  if (bytes.byteLength > max) throw new Error(`The file is larger than ${Math.round(max / 1024 / 1024)} MB.`);
  return bytes;
}

const RESERVED_NAMES = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;

/** A safe file name for a save dialog's default: no folders, no characters Windows refuses. */
export function sanitizeFileName(v: unknown, fallback = "matchframe-hud.zip"): string {
  if (typeof v !== "string") return fallback;
  const base = v.split(/[\\/]/).pop() ?? "";
  let name = base
    .replace(/[<>:"|?*]/g, "_")
    .replace(/\p{Cc}/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/, "");
  if (name.length > 120) {
    const dot = name.lastIndexOf(".");
    const ext = dot > 0 && name.length - dot <= 10 ? name.slice(dot) : "";
    name = name.slice(0, 120 - ext.length) + ext;
  }
  if (!name || name.startsWith(".") || RESERVED_NAMES.test(name)) return fallback;
  return name;
}
