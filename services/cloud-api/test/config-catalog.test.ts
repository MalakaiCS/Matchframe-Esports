import { describe, expect, it } from "vitest";
import { generateSigningKey } from "@matchframe/cloud-contracts/token";
import { CloudApp } from "../src/app.ts";
import { loadCloudConfig, productionConfigProblems } from "../src/config.ts";
import { migrate } from "../src/db/migrations.ts";
import { PgliteSql } from "../src/db/sql.ts";
import { getHourPack, getPlan, seedCatalog, upsertPlan } from "../src/domain/plans.ts";

describe("deployment configuration", () => {
  it("treats blank environment values as unset (compose passes empty strings)", () => {
    const cfg = loadCloudConfig({ STRIPE_SECRET_KEY: "", STRIPE_WEBHOOK_SECRET: " ", SMTP_URL: "", DATABASE_URL: "", MF_CLOUD_SIGNING_KEY: "", MF_DOWNLOAD_WINDOWS_URL: "", MF_CLOUD_PORT: "" });
    expect(cfg).toMatchObject({ stripeSecretKey: null, stripeWebhookSecret: null, smtpUrl: null, databaseUrl: null, signingKeyPem: null, port: 8080, downloads: { windowsUrl: null } });
  });

  it("accepts the public address as copied from a hosting dashboard (no https://, trailing slash)", () => {
    expect(loadCloudConfig({ MF_CLOUD_PUBLIC_URL: "matchframe-esports-production.up.railway.app" }).publicUrl).toBe("https://matchframe-esports-production.up.railway.app");
    expect(loadCloudConfig({ MF_CLOUD_PUBLIC_URL: " https://app.example.com/ " }).publicUrl).toBe("https://app.example.com");
    expect(loadCloudConfig({ MF_CLOUD_PUBLIC_URL: "http://127.0.0.1:8080" }).publicUrl).toBe("http://127.0.0.1:8080");
    expect(() => loadCloudConfig({ MF_CLOUD_PUBLIC_URL: "https://" })).toThrow(/not a valid web address/);
    expect(() => loadCloudConfig({ MF_CLOUD_PUBLIC_URL: "ftp://files.example.com" })).toThrow(/must start with https/);
  });

  it("listens on the platform's PORT unless MF_CLOUD_PORT is set (Railway and similar hosts)", () => {
    expect(loadCloudConfig({ PORT: "4123" }).port).toBe(4123);
    expect(loadCloudConfig({ PORT: "4123", MF_CLOUD_PORT: "8081" }).port).toBe(8081);
    expect(loadCloudConfig({}).port).toBe(8080);
  });

  it("refuses to run in production without a database and the public address (the signing key is optional)", () => {
    const empty = { NODE_ENV: "production", DATABASE_URL: "", MF_CLOUD_SIGNING_KEY: "", MF_CLOUD_PUBLIC_URL: "" };
    const problems = productionConfigProblems(loadCloudConfig(empty), empty);
    expect(problems.map((p) => p.split(" ")[0])).toEqual(["DATABASE_URL", "MF_CLOUD_PUBLIC_URL"]);
    const ready = { NODE_ENV: "production", DATABASE_URL: "postgres://db/mf", MF_CLOUD_PUBLIC_URL: "https://app.example" };
    expect(productionConfigProblems(loadCloudConfig(ready), ready)).toEqual([]);
    expect(productionConfigProblems(loadCloudConfig({}), {})).toEqual([]); // development and tests are unaffected
  });

  it("creates the licence signing key once, keeps it in the database across restarts, and prefers MF_CLOUD_SIGNING_KEY", async () => {
    const sql = new PgliteSql();
    const cfg = loadCloudConfig({});
    const first = new CloudApp(cfg, { sql });
    await first.init();
    expect(first.signingKeySource).toBe("database");
    const restarted = new CloudApp(cfg, { sql });
    await restarted.init();
    expect(restarted.kid).toBe(first.kid);
    expect(restarted.signingKeyPem).toBe(first.signingKeyPem);
    expect(Object.keys(restarted.publicKeys)).toEqual([first.kid]);
    const env = generateSigningKey();
    const configured = new CloudApp(loadCloudConfig({ MF_CLOUD_SIGNING_KEY: env.privateKeyPem.replace(/\n/g, "\\n") }), { sql });
    await configured.init();
    expect([configured.signingKeySource, configured.kid]).toEqual(["environment", env.kid]);
    await sql.close();
  });

  it("fills Stripe price ids from the environment after the first start without overwriting staff edits", async () => {
    const sql = new PgliteSql();
    await migrate(sql);
    await seedCatalog(sql, {});
    expect((await getPlan(sql, "pro"))?.stripePriceId).toBeNull();
    const studio = (await getPlan(sql, "studio"))!;
    await upsertPlan(sql, { ...studio, stripePriceId: "price_staff_edit" });
    await seedCatalog(sql, { STRIPE_PRICE_PRO: "price_pro_live", STRIPE_PRICE_STUDIO: "price_from_env", STRIPE_PRICE_PACK_10: "price_pack" });
    expect((await getPlan(sql, "pro"))?.stripePriceId).toBe("price_pro_live");
    expect((await getPlan(sql, "studio"))?.stripePriceId).toBe("price_staff_edit");
    expect((await getHourPack(sql, "hours-10"))?.stripePriceId).toBe("price_pack");
    expect((await getHourPack(sql, "hours-50"))?.stripePriceId).toBeNull();
    await sql.close();
  });

  it("fills in the Full Action Observer feature for plans stored before it existed (Studio only), keeping staff edits", async () => {
    const sql = new PgliteSql();
    await migrate(sql);
    await seedCatalog(sql, {});
    expect((await getPlan(sql, "studio"))?.features.fullActionObserver).toBe(true);
    expect((await getPlan(sql, "pro"))?.features.fullActionObserver).toBe(false);
    // A catalogue from an older version: the feature key is missing.
    await sql.query("UPDATE plans SET data = data #- '{features,fullActionObserver}'");
    const pro = (await getPlan(sql, "pro"))!;
    expect(pro.features.fullActionObserver).toBe(false); // schema default while missing
    await upsertPlan(sql, { ...pro, features: { ...pro.features, fullActionObserver: true } }); // staff decision
    await seedCatalog(sql, {});
    expect((await getPlan(sql, "studio"))?.features.fullActionObserver).toBe(true);
    expect((await getPlan(sql, "pro"))?.features.fullActionObserver).toBe(true);
    expect((await getPlan(sql, "free"))?.features.fullActionObserver).toBe(false);
    await sql.close();
  });
});
