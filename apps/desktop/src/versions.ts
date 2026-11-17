/**
 * Program versions (semantic versions: 0.12.4, 0.13.0-beta.1) and the two update channels (ADR-076).
 * Beta builds are GitHub prereleases; their update file is beta.yml, a Stable build's latest.yml.
 */

export type UpdateChannel = "stable" | "beta";

interface Version {
  core: [number, number, number];
  pre: string[];
}

const VERSION = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z.-]+)?$/;

export function parseVersion(v: string): Version | null {
  const m = VERSION.exec(v.trim());
  if (!m) return null;
  return { core: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ? m[4].split(".") : [] };
}

export const isValidVersion = (v: string): boolean => parseVersion(v) !== null;

export function isPrerelease(v: string): boolean {
  return (parseVersion(v)?.pre.length ?? 0) > 0;
}

function compareIdentifiers(a: string, b: string): number {
  const an = /^\d+$/.test(a);
  const bn = /^\d+$/.test(b);
  if (an && bn) return Math.sign(Number(a) - Number(b));
  if (an !== bn) return an ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Semantic-version order: -1, 0 or 1. A prerelease comes before its release (0.13.0-beta.1 < 0.13.0). */
export function compareVersions(a: string, b: string): number {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) throw new Error(`Not a version: ${!x ? a : b}`);
  for (let i = 0; i < 3; i++) if (x.core[i] !== y.core[i]) return Math.sign(x.core[i]! - y.core[i]!);
  if (!x.pre.length || !y.pre.length) return x.pre.length === y.pre.length ? 0 : x.pre.length ? -1 : 1;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    if (x.pre[i] === undefined) return -1;
    if (y.pre[i] === undefined) return 1;
    const c = compareIdentifiers(x.pre[i]!, y.pre[i]!);
    if (c) return c;
  }
  return 0;
}

export const parseChannel = (v: unknown): UpdateChannel => (v === "beta" ? "beta" : "stable");

/**
 * electron-updater settings for a channel. Beta: the newest release, prereleases included (a beta's
 * update file is beta.yml; a newer Stable release is offered too, through its latest.yml). Stable:
 * GitHub's latest release and its latest.yml. On Stable while running a beta, the latest Stable
 * version may be older, so downgrades are allowed for the check; the program then offers it and never
 * downloads it by itself (updater.ts).
 */
export function updaterSettings(channel: UpdateChannel, currentVersion: string): { channel: "latest" | "beta"; allowPrerelease: boolean; allowDowngrade: boolean } {
  if (channel === "beta") return { channel: "beta", allowPrerelease: true, allowDowngrade: false };
  return { channel: "latest", allowPrerelease: false, allowDowngrade: isPrerelease(currentVersion) };
}

/** Whether a downloaded version belongs to the channel (a Stable program never installs a beta). */
export function fitsChannel(version: string, channel: UpdateChannel): boolean {
  return channel === "beta" || !isPrerelease(version);
}
