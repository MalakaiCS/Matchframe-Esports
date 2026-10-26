import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const ROLES = ["owner", "producer", "observer", "graphics", "replay", "analyst", "viewer", "captain"] as const;
export type Role = (typeof ROLES)[number];

export type Permission =
  | "metadata.read"
  | "metadata.write"
  | "hud.publish"
  | "camera.control"
  | "director.control"
  | "program.control"
  | "replay.control"
  | "demos.manage"
  | "training.manage"
  | "models.promote"
  | "settings.manage"
  | "veto.captain"
  | "state.read";

const ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  owner: ["metadata.read", "metadata.write", "hud.publish", "camera.control", "director.control", "program.control", "replay.control", "demos.manage", "training.manage", "models.promote", "settings.manage", "state.read"],
  producer: ["metadata.read", "metadata.write", "hud.publish", "program.control", "replay.control", "director.control", "state.read"],
  observer: ["metadata.read", "camera.control", "director.control", "state.read"],
  graphics: ["metadata.read", "metadata.write", "hud.publish", "state.read"],
  replay: ["metadata.read", "replay.control", "state.read"],
  analyst: ["metadata.read", "demos.manage", "training.manage", "state.read"],
  viewer: ["metadata.read", "state.read"],
  // Captains only act on their own veto through a scoped link; they never read production telemetry.
  captain: ["veto.captain"],
};

export function can(role: Role, p: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(p);
}

export interface Principal {
  tokenId: string;
  role: Role;
  label: string;
  scope: { matchId?: string; teamId?: string } | null;
}

interface StoredToken {
  id: string;
  hash: string;
  role: Role;
  label: string;
  scope: Principal["scope"];
  createdAt: string;
  expiresAt: string | null;
}

interface SecretFile {
  operatorToken: string;
  gsiToken: string;
  tokens: StoredToken[];
  /** Other credentials (e.g. OBS passwords) keyed by name. Never logged or exported. */
  extra?: Record<string, string>;
}

export const hashToken = (t: string) => createHash("sha256").update(t).digest("hex");

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/**
 * Local secret store. The file is created with owner-only permissions. The desktop shell can wrap
 * this with the OS credential store (Electron safeStorage); stream keys and remote credentials are
 * never written here in plain text.
 */
/**
 * Optional at-rest encryption for stored credentials. The desktop shell derives the key from the
 * OS credential store (Electron safeStorage) and passes it as MATCHFRAME_SECRET_KEY (hex, 32 bytes).
 */
function encryptValue(key: Buffer, value: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([c.update(value, "utf8"), c.final()]);
  return `enc:v1:${iv.toString("base64")}:${c.getAuthTag().toString("base64")}:${enc.toString("base64")}`;
}

function decryptValue(key: Buffer | null, value: string): string | undefined {
  if (!value.startsWith("enc:v1:")) return value;
  if (!key) return undefined;
  const [, , iv, tag, data] = value.split(":");
  try {
    const d = createDecipheriv("aes-256-gcm", key, Buffer.from(iv!, "base64"));
    d.setAuthTag(Buffer.from(tag!, "base64"));
    return Buffer.concat([d.update(Buffer.from(data!, "base64")), d.final()]).toString("utf8");
  } catch {
    return undefined;
  }
}

export class SecretStore {
  private data: SecretFile;
  private readonly key: Buffer | null;

  constructor(
    private readonly path: string,
    keyHex: string | undefined = process.env.MATCHFRAME_SECRET_KEY,
  ) {
    this.key = keyHex && /^[0-9a-f]{64}$/i.test(keyHex) ? Buffer.from(keyHex, "hex") : null;
    if (existsSync(path)) {
      this.data = JSON.parse(readFileSync(path, "utf8")) as SecretFile;
    } else {
      this.data = { operatorToken: randomBytes(24).toString("hex"), gsiToken: randomBytes(16).toString("hex"), tokens: [] };
      this.save();
    }
  }

  private save(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    try {
      chmodSync(this.path, 0o600);
    } catch {
      // Windows ACLs are handled by the per-user AppData location.
    }
  }

  get operatorToken(): string {
    return this.data.operatorToken;
  }

  get gsiToken(): string {
    return this.data.gsiToken;
  }

  rotateGsiToken(): string {
    this.data.gsiToken = randomBytes(16).toString("hex");
    this.save();
    return this.data.gsiToken;
  }

  get encryptedAtRest(): boolean {
    return this.key !== null;
  }

  setSecret(name: string, value: string | null): void {
    this.data.extra = this.data.extra ?? {};
    if (value === null) delete this.data.extra[name];
    else this.data.extra[name] = this.key ? encryptValue(this.key, value) : value;
    this.save();
  }

  getSecret(name: string): string | undefined {
    const v = this.data.extra?.[name];
    return v === undefined ? undefined : decryptValue(this.key, v);
  }

  hasSecret(name: string): boolean {
    return this.data.extra?.[name] !== undefined;
  }

  checkGsiToken(token: string | undefined): boolean {
    return typeof token === "string" && safeEqual(token, this.data.gsiToken);
  }

  /** Issues a role-scoped token. Only the hash is stored; the plain token is returned once. */
  issue(role: Role, label: string, scope: Principal["scope"] = null, ttlMs: number | null = null): { id: string; token: string } {
    const token = randomBytes(24).toString("hex");
    const id = `tok_${randomBytes(6).toString("hex")}`;
    this.data.tokens.push({ id, hash: hashToken(token), role, label, scope, createdAt: new Date().toISOString(), expiresAt: ttlMs ? new Date(Date.now() + ttlMs).toISOString() : null });
    this.save();
    return { id, token };
  }

  revoke(id: string): void {
    this.data.tokens = this.data.tokens.filter((t) => t.id !== id);
    this.save();
  }

  listTokens(): Omit<StoredToken, "hash">[] {
    return this.data.tokens.map(({ hash: _h, ...rest }) => rest);
  }

  authenticate(token: string | undefined): Principal | null {
    if (!token) return null;
    if (safeEqual(token, this.data.operatorToken)) return { tokenId: "operator", role: "owner", label: "local operator", scope: null };
    const h = hashToken(token);
    const t = this.data.tokens.find((x) => safeEqual(x.hash, h));
    if (!t) return null;
    if (t.expiresAt && Date.parse(t.expiresAt) < Date.now()) return null;
    return { tokenId: t.id, role: t.role, label: t.label, scope: t.scope };
  }
}
