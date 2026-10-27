import type { OrgRole, UserView } from "@matchframe/cloud-contracts";
import { generateSigningKey, keyId } from "@matchframe/cloud-contracts/token";
import { createPublicKey } from "node:crypto";
import type { CloudConfig } from "./config.ts";
import { migrate } from "./db/migrations.ts";
import type { Sql } from "./db/sql.ts";
import { openSql } from "./db/sql.ts";
import type { BillingProvider } from "./domain/billing-provider.ts";
import { StripeBilling, UnconfiguredBilling } from "./domain/billing-provider.ts";
import { seedCatalog } from "./domain/plans.ts";
import type { OrgAction } from "./domain/roles.ts";
import { roleCan } from "./domain/roles.ts";
import { Mailer } from "./email/sender.ts";
import { RateLimiter } from "./auth/ratelimit.ts";
import type { Ctx } from "./http/router.ts";
import { cookie, HttpError } from "./http/router.ts";
import { hashSecret, newSecret } from "./ids.ts";

export const SESSION_COOKIE = "mf_session";
const SESSION_DAYS = 30;

export interface SessionUser extends UserView {
  sessionHash: string;
}

export interface DeviceAuth {
  deviceId: string;
  orgId: string;
  name: string;
}

export class CloudApp {
  readonly sql: Sql;
  readonly mailer: Mailer;
  readonly billing: BillingProvider;
  /** Licence signing key: MF_CLOUD_SIGNING_KEY when set, otherwise created once and kept in the database (see init). */
  signingKeyPem: string;
  publicKeys: Record<string, string>;
  kid: string;
  signingKeySource: "environment" | "database" = "environment";
  readonly limits: { auth: RateLimiter; email: RateLimiter; deviceAuthorize: RateLimiter; deviceLink: RateLimiter };
  readonly origin: string;

  constructor(
    readonly cfg: CloudConfig,
    deps: { sql?: Sql; billing?: BillingProvider; now?: () => Date; rateLimitScale?: number } = {},
  ) {
    const k = deps.rateLimitScale ?? 1;
    this.limits = {
      auth: new RateLimiter(10 * k, 60_000),
      email: new RateLimiter(5 * k, 15 * 60_000),
      deviceAuthorize: new RateLimiter(10 * k, 60_000),
      deviceLink: new RateLimiter(20 * k, 60_000),
    };
    this.sql = deps.sql ?? openSql(cfg.databaseUrl, cfg.pgliteDir ?? undefined);
    this.mailer = new Mailer(this.sql, cfg.smtpUrl, cfg.mailFrom, cfg.devLogEmails && !cfg.smtpUrl);
    this.billing = deps.billing ?? (cfg.stripeSecretKey ? new StripeBilling(cfg.stripeSecretKey, cfg.stripeWebhookSecret, cfg.stripeApiBase) : new UnconfiguredBilling());
    this.now = deps.now ?? (() => new Date());
    // Provisional until init() loads (or creates) the database key when none is configured.
    this.signingKeyPem = cfg.signingKeyPem ?? generateSigningKey().privateKeyPem;
    this.kid = "";
    this.publicKeys = {};
    this.useSigningKey(this.signingKeyPem, []);
    this.origin = new URL(cfg.publicUrl).origin;
  }

  readonly now: () => Date;
  /** True when the signing key will not survive a restart (in-memory development database without a configured key). */
  ephemeralKey = false;

  async init(): Promise<void> {
    await migrate(this.sql);
    await seedCatalog(this.sql);
    if (!this.cfg.signingKeyPem) await this.loadDatabaseSigningKey();
  }

  private useSigningKey(privatePem: string, otherPublicPems: string[]): void {
    const pub = createPublicKey(privatePem).export({ type: "spki", format: "pem" }).toString();
    this.signingKeyPem = privatePem;
    this.kid = keyId(pub);
    this.publicKeys = { [this.kid]: pub };
    for (const extra of [...otherPublicPems, ...this.cfg.extraPublicKeysPem]) this.publicKeys[keyId(extra)] = extra;
  }

  /**
   * Without MF_CLOUD_SIGNING_KEY the server creates a key on first start and keeps it in the
   * database, so it survives restarts and redeploys. Several instances starting at once agree on the
   * oldest key. Other unretired keys stay published so licences they signed keep verifying.
   */
  private async loadDatabaseSigningKey(): Promise<void> {
    const active = () => this.sql.query<{ kid: string; private_pem: string; public_pem: string }>("SELECT kid, private_pem, public_pem FROM signing_keys WHERE retired_at IS NULL ORDER BY created_at, kid");
    let { rows } = await active();
    if (rows.length === 0) {
      const k = generateSigningKey();
      await this.sql.query("INSERT INTO signing_keys (kid, private_pem, public_pem) VALUES ($1, $2, $3) ON CONFLICT (kid) DO NOTHING", [k.kid, k.privateKeyPem, k.publicKeyPem]);
      ({ rows } = await active());
    }
    const [current, ...others] = rows;
    this.useSigningKey(current!.private_pem, others.map((r) => r.public_pem));
    this.signingKeySource = "database";
    this.ephemeralKey = this.sql.kind === "pglite" && !this.cfg.pgliteDir;
  }

  async close(): Promise<void> {
    await this.sql.close();
  }

  get secureCookies(): boolean {
    return this.cfg.publicUrl.startsWith("https://");
  }

  // ------------------------------------------------------------------ sessions

  async createSession(userId: string, ctx: Ctx): Promise<string> {
    const secret = newSecret();
    await this.sql.query("INSERT INTO sessions (id_hash, user_id, expires_at, ip, user_agent) VALUES ($1, $2, $3, $4, $5)", [
      hashSecret(secret),
      userId,
      new Date(this.now().getTime() + SESSION_DAYS * 86_400_000),
      ctx.ip,
      String(ctx.headers["user-agent"] ?? "").slice(0, 200),
    ]);
    return cookie(SESSION_COOKIE, secret, { maxAgeSec: SESSION_DAYS * 86400, secure: this.secureCookies });
  }

  clearSessionCookie(): string {
    return cookie(SESSION_COOKIE, "", { maxAgeSec: 0, secure: this.secureCookies });
  }

  async optionalUser(ctx: Ctx): Promise<SessionUser | null> {
    const secret = ctx.cookies[SESSION_COOKIE];
    if (!secret) return null;
    const h = hashSecret(secret);
    const { rows } = await this.sql.query<{ id: string; email: string; display_name: string; email_verified_at: Date | null; staff: boolean; created_at: Date }>(
      "SELECT u.id, u.email, u.display_name, u.email_verified_at, u.staff, u.created_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id_hash = $1 AND s.expires_at > $2",
      [h, this.now()],
    );
    const u = rows[0];
    if (!u) return null;
    return { id: u.id, email: u.email, displayName: u.display_name, emailVerified: !!u.email_verified_at, staff: u.staff, createdAt: u.created_at.toISOString(), sessionHash: h };
  }

  async requireUser(ctx: Ctx, opts: { verified?: boolean } = {}): Promise<SessionUser> {
    const u = await this.optionalUser(ctx);
    if (!u) throw new HttpError(401, "unauthenticated", "sign in first");
    if (opts.verified && !u.emailVerified) throw new HttpError(403, "email_unverified", "verify your email address first");
    return u;
  }

  async requireStaff(ctx: Ctx): Promise<SessionUser> {
    const u = await this.requireUser(ctx);
    if (!u.staff) throw new HttpError(403, "forbidden", "staff only");
    return u;
  }

  async roleIn(userId: string, orgId: string): Promise<OrgRole | null> {
    const { rows } = await this.sql.query<{ role: OrgRole }>("SELECT role FROM memberships WHERE org_id = $1 AND user_id = $2", [orgId, userId]);
    return rows[0]?.role ?? null;
  }

  /** Signed-in member of the org whose role allows the action (staff may view any org). */
  async requireOrg(ctx: Ctx, orgId: string, action: OrgAction, opts: { verified?: boolean } = {}): Promise<{ user: SessionUser; role: OrgRole | "staff" }> {
    const user = await this.requireUser(ctx, opts);
    const role = await this.roleIn(user.id, orgId);
    if (role && roleCan(role, action)) return { user, role };
    if (user.staff && (action === "org.view" || action === "usage.view" || action === "billing.view")) return { user, role: "staff" };
    if (!role) throw new HttpError(404, "not_found", "organisation not found");
    throw new HttpError(403, "forbidden", `your role (${role}) cannot ${action}`);
  }

  // ------------------------------------------------------------------ devices

  async requireDevice(ctx: Ctx): Promise<DeviceAuth> {
    const h = ctx.headers.authorization;
    const token = h?.startsWith("Bearer ") ? h.slice(7) : null;
    if (!token) throw new HttpError(401, "unauthenticated", "device token required");
    const { rows } = await this.sql.query<{ id: string; org_id: string; name: string }>("SELECT id, org_id, name FROM devices WHERE token_hash = $1 AND revoked_at IS NULL", [hashSecret(token)]);
    const d = rows[0];
    if (!d) throw new HttpError(401, "device_revoked", "this computer is not linked (it may have been unlinked on the website)");
    return { deviceId: d.id, orgId: d.org_id, name: d.name };
  }

  rateLimit(limiter: RateLimiter, key: string): void {
    if (!limiter.take(key)) throw new HttpError(429, "rate_limited", "too many requests; wait a minute and try again");
  }
}
