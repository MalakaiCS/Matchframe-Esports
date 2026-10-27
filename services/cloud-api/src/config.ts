export interface CloudConfig {
  /** Public origin of the website, e.g. https://app.matchframe.gg (links in emails, CSRF origin). */
  publicUrl: string;
  host: string;
  port: number;
  /** Postgres connection string; null uses an embedded PGlite database (development/tests). */
  databaseUrl: string | null;
  pgliteDir: string | null;
  /** Ed25519 private key (PKCS#8 PEM) that signs entitlements; generated in development when absent. */
  signingKeyPem: string | null;
  /** Additional public keys (PEM) still accepted by desktops during key rotation, published at /v1/keys. */
  extraPublicKeysPem: string[];
  stripeSecretKey: string | null;
  stripeWebhookSecret: string | null;
  /** Optional Stripe API host override (tests). */
  stripeApiBase: string | null;
  /** SMTP connection URL (smtps://user:pass@host:465); null keeps emails in the outbox table only. */
  smtpUrl: string | null;
  mailFrom: string;
  /** Development only: print emails to the console when SMTP is not configured. */
  devLogEmails: boolean;
  /** Static website build to serve (apps/cloud-web/dist). */
  webDir: string | null;
  /** Directory holding `MatchframeEsports-Setup-<version>.exe` installers served at /downloads/. */
  downloadDir: string | null;
  /** Installer metadata shown on the downloads page. */
  downloads: { version: string; windowsUrl: string | null; sha256: string | null; notesUrl: string | null };
  entitlementTtlHours: number;
  offlineGraceDays: number;
  /** Emails that become staff (admin) on signup or login. */
  staffEmails: string[];
}

export function loadCloudConfig(env: NodeJS.ProcessEnv = process.env, overrides: Partial<CloudConfig> = {}): CloudConfig {
  const list = (v: string | undefined) => (v ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  // Blank values count as unset (container tooling often passes empty strings for unset variables).
  const opt = (v: string | undefined) => (v && v.trim() ? v.trim() : null);
  const cfg: CloudConfig = {
    publicUrl: (opt(env.MF_CLOUD_PUBLIC_URL) ?? "http://127.0.0.1:8080").replace(/\/$/, ""),
    host: opt(env.MF_CLOUD_HOST) ?? "127.0.0.1",
    port: Number(opt(env.MF_CLOUD_PORT) ?? opt(env.PORT) ?? 8080),
    databaseUrl: opt(env.DATABASE_URL),
    pgliteDir: opt(env.MF_CLOUD_PGLITE_DIR),
    signingKeyPem: opt(env.MF_CLOUD_SIGNING_KEY)?.replace(/\\n/g, "\n") ?? null,
    extraPublicKeysPem: (env.MF_CLOUD_EXTRA_PUBLIC_KEYS ?? "").replace(/\\n/g, "\n").split("|||").map((k) => k.trim()).filter(Boolean),
    stripeSecretKey: opt(env.STRIPE_SECRET_KEY),
    stripeWebhookSecret: opt(env.STRIPE_WEBHOOK_SECRET),
    stripeApiBase: opt(env.MF_STRIPE_API_BASE),
    smtpUrl: opt(env.SMTP_URL),
    mailFrom: opt(env.MF_MAIL_FROM) ?? "Matchframe <no-reply@localhost>",
    devLogEmails: env.MF_DEV_LOG_EMAILS === "1",
    webDir: opt(env.MF_CLOUD_WEB_DIR),
    downloadDir: opt(env.MF_DOWNLOAD_DIR),
    downloads: { version: opt(env.MF_DOWNLOAD_VERSION) ?? "0.1.0", windowsUrl: opt(env.MF_DOWNLOAD_WINDOWS_URL), sha256: opt(env.MF_DOWNLOAD_WINDOWS_SHA256), notesUrl: opt(env.MF_DOWNLOAD_NOTES_URL) },
    entitlementTtlHours: Number(opt(env.MF_ENTITLEMENT_TTL_HOURS) ?? 24),
    offlineGraceDays: Number(opt(env.MF_OFFLINE_GRACE_DAYS) ?? 7),
    staffEmails: list(env.MF_STAFF_EMAILS).map((e) => e.toLowerCase()),
    ...overrides,
  };
  if (!Number.isInteger(cfg.port) || cfg.port < 1 || cfg.port > 65535) throw new Error("MF_CLOUD_PORT must be a port number");
  return cfg;
}

/**
 * Settings a production server must not run without (NODE_ENV=production, as in the Docker image).
 * Without them it would keep accounts, payments and its licence signing key in an in-memory
 * database, or put wrong addresses in emails and payment redirects. (The signing key itself is
 * optional: without MF_CLOUD_SIGNING_KEY it is created once and stored in the database.)
 */
export function productionConfigProblems(cfg: CloudConfig, env: NodeJS.ProcessEnv = process.env): string[] {
  if (env.NODE_ENV !== "production") return [];
  const problems: string[] = [];
  if (!cfg.databaseUrl && !cfg.pgliteDir) problems.push("DATABASE_URL is not set: add a Postgres database and set DATABASE_URL (on Railway: ${{Postgres.DATABASE_URL}}).");
  if (!env.MF_CLOUD_PUBLIC_URL?.trim()) problems.push("MF_CLOUD_PUBLIC_URL is not set: set the website's public https:// address.");
  return problems;
}
