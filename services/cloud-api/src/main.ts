import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CloudApp } from "./app.ts";
import { loadCloudConfig, productionConfigProblems } from "./config.ts";
import { startCloudServer } from "./server.ts";

const here = dirname(fileURLToPath(import.meta.url));
const defaultWeb = [resolve(here, "..", "..", "..", "apps", "cloud-web", "dist"), resolve(here, "..", "web")].find((p) => existsSync(join(p, "index.html"))) ?? null;
const cfg = loadCloudConfig(process.env, { webDir: process.env.MF_CLOUD_WEB_DIR?.trim() || defaultWeb });
const problems = productionConfigProblems(cfg);
if (problems.length > 0) {
  console.error(["Matchframe cloud API: refusing to start in production:", ...problems.map((p) => `  - ${p}`), "See docs/operations/cloud-deployment.md."].join("\n"));
  process.exit(1);
}
const app = new CloudApp(cfg);
await app.init();
const { close } = await startCloudServer(app);
console.log(
  [
    `Matchframe cloud API listening on http://${cfg.host}:${cfg.port} (public URL ${cfg.publicUrl})`,
    `  database: ${app.sql.kind}${app.sql.kind === "pglite" ? ` (${cfg.pgliteDir ?? "in memory — data is lost on exit; set DATABASE_URL or MF_CLOUD_PGLITE_DIR"})` : ""}`,
    `  billing: ${app.billing.configured ? "Stripe" : "not configured (set STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET)"}`,
    `  email: ${app.mailer.kind === "smtp" ? "SMTP" : "outbox table only (set SMTP_URL)"}`,
    `  entitlement signing key: ${app.kid}${app.ephemeralKey ? " (EPHEMERAL — set MF_CLOUD_SIGNING_KEY in production)" : ""}`,
    `  website: ${cfg.webDir ?? "not built (pnpm --filter @matchframe/cloud-web build)"}`,
  ].join("\n"),
);
const stop = async () => {
  await close();
  await app.close();
  process.exit(0);
};
process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());
