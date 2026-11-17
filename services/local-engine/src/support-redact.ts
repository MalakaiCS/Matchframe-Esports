/**
 * The last pass over a support file before it leaves the engine (Settings → Diagnostics → Download
 * support bundle) or the program (crash reports, ADR-077; apps/desktop/src/crash/redact.ts uses it
 * too). The engine's sections are built without secrets and log data is redacted when written; this
 * pass also catches what those miss: secrets inside log messages and error text, keys named like
 * API, private or signing keys, every secret the caller knows word for word (the operator token, the
 * website credential, stored passwords), and the user's home folder in paths.
 */

/** Keys whose values never appear in a support file (a wider net than the logger's). */
export const SUPPORT_SECRET_KEYS = /token|secret|password|passwd|passphrase|auth|credential|cookie|api_?key|private_?key|access_?key|signing_?key|session_?key|stream_?key|join_?key/i;

export const REDACTED = "[redacted]";

/** Secrets that have a shape of their own, wherever they appear in text. */
const TEXT_RULES: [RegExp, string][] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, `${REDACTED} private key`],
  // Authorization headers.
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, `$1 ${REDACTED}`],
  // Tokens, keys and passwords in addresses (overlay links ?t=, captain links ?token=, ?key=, ?code=).
  [/([?&#;](?:t|token|key|access_token|auth|password|pass|pwd|secret|sig|signature|code|apikey|api_key)=)[^&\s#"'<>]+/gi, `$1${REDACTED}`],
  // user:password@ in addresses.
  [/(\b[a-z][a-z0-9+.-]*:\/\/)[^/\s:@"']+:[^/\s@"']+@/gi, `$1${REDACTED}@`],
  // "password": "…", token=… written into a message.
  [/("?\b(?:token|secret|password|passwd|api_?key|private_?key|access_?key|stream_?key|join_?key)"?\s*[:=]\s*"?)[^"\s,;}&#?]{4,}/gi, `$1${REDACTED}`],
  // The website's device credential.
  [/\bmfd_[A-Za-z0-9_-]{16,}/g, `mfd_${REDACTED}`],
  // Engine access tokens (operator and role tokens are 24 random bytes in hex). A SHA-256 (64 hex characters) is left alone.
  [/\b[0-9a-f]{48}\b/gi, REDACTED],
];

export interface RedactOptions {
  /** Values to remove wherever they appear (shorter than 6 characters: ignored). */
  secrets?: readonly (string | null | undefined)[];
  /** The user's home folder: replaced by "~" in paths. */
  home?: string | null;
  /** Deeper values become "[depth]". */
  maxDepth?: number;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A function that scrubs one string; build it once for a whole support file. */
export function textScrubber(o: RedactOptions = {}): (s: string) => string {
  const secrets = [...new Set((o.secrets ?? []).filter((s): s is string => typeof s === "string" && s.length >= 6))].sort((a, b) => b.length - a.length);
  const literal = secrets.length ? new RegExp(secrets.flatMap((s) => [s, encodeURIComponent(s)]).map(escape).join("|"), "g") : null;
  const home = o.home && o.home.length > 3 ? o.home.replace(/[\\/]+$/, "") : null;
  // Windows paths: either slash, any letter case. Only the whole folder name ("/home/al" is not in "/home/alex").
  const homeRe = home ? new RegExp(`${escape(home).replace(/\\\\|\//g, "[\\\\/]")}(?![A-Za-z0-9_.-])`, /^[A-Za-z]:/.test(home) ? "gi" : "g") : null;
  return (s) => {
    let out = literal ? s.replace(literal, REDACTED) : s;
    for (const [re, to] of TEXT_RULES) out = out.replace(re, to);
    return homeRe ? out.replace(homeRe, "~") : out;
  };
}

/** Redacts a whole value: secret-looking keys, then every string through `textScrubber`. */
export function redactSupport(value: unknown, o: RedactOptions = {}): unknown {
  const scrub = textScrubber(o);
  const maxDepth = o.maxDepth ?? 40;
  const walk = (v: unknown, depth: number): unknown => {
    if (typeof v === "string") return scrub(v);
    if (v === null || typeof v !== "object") return v;
    if (depth >= maxDepth) return "[depth]";
    if (Array.isArray(v)) return v.map((x) => walk(x, depth + 1));
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) out[k] = SUPPORT_SECRET_KEYS.test(k) ? REDACTED : walk(x, depth + 1);
    return out;
  };
  return walk(value, 0);
}
