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
  /** Installer metadata shown on the downloads page. */
  downloads: { version: string; windowsUrl: string | null; sha256: string | null; notesUrl: string | null };
  entitlementTtlHours: number;
  offlineGraceDays: number;
  /** Emails that become staff (admin) on signup or login. */
  staffEmails: string[];
}

export function loadCloudConfig(env: NodeJS.ProcessEnv = process.env, overrides: Partial<CloudConfig> = {}): CloudConfig {
  const list = (v: string | undefined) => (v ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const cfg: CloudConfig = {
    publicUrl: (env.MF_CLOUD_PUBLIC_URL ?? "http://127.0.0.1:8080").replace(/\/$/, ""),
    host: env.MF_CLOUD_HOST ?? "127.0.0.1",
    port: Number(env.MF_CLOUD_PORT ?? env.PORT ?? 8080),
    databaseUrl: env.DATABASE_URL ?? null,
    pgliteDir: env.MF_CLOUD_PGLITE_DIR ?? null,
    signingKeyPem: env.MF_CLOUD_SIGNING_KEY?.replace(/\\n/g, "\n") ?? null,
    extraPublicKeysPem: (env.MF_CLOUD_EXTRA_PUBLIC_KEYS ?? "").replace(/\\n/g, "\n").split("|||").map((k) => k.trim()).filter(Boolean),
    stripeSecretKey: env.STRIPE_SECRET_KEY ?? null,
    stripeWebhookSecret: env.STRIPE_WEBHOOK_SECRET ?? null,
    stripeApiBase: env.MF_STRIPE_API_BASE ?? null,
    smtpUrl: env.SMTP_URL ?? null,
    mailFrom: env.MF_MAIL_FROM ?? "Matchframe <no-reply@localhost>",
    devLogEmails: env.MF_DEV_LOG_EMAILS === "1",
    webDir: env.MF_CLOUD_WEB_DIR ?? null,
    downloads: { version: env.MF_DOWNLOAD_VERSION ?? "0.1.0", windowsUrl: env.MF_DOWNLOAD_WINDOWS_URL ?? null, sha256: env.MF_DOWNLOAD_WINDOWS_SHA256 ?? null, notesUrl: env.MF_DOWNLOAD_NOTES_URL ?? null },
    entitlementTtlHours: Number(env.MF_ENTITLEMENT_TTL_HOURS ?? 24),
    offlineGraceDays: Number(env.MF_OFFLINE_GRACE_DAYS ?? 7),
    staffEmails: list(env.MF_STAFF_EMAILS).map((e) => e.toLowerCase()),
    ...overrides,
  };
  if (!Number.isInteger(cfg.port) || cfg.port < 1 || cfg.port > 65535) throw new Error("MF_CLOUD_PORT must be a port number");
  return cfg;
}
