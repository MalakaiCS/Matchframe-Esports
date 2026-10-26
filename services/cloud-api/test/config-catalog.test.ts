import { describe, expect, it } from "vitest";
import { loadCloudConfig } from "../src/config.ts";
import { migrate } from "../src/db/migrations.ts";
import { PgliteSql } from "../src/db/sql.ts";
import { getHourPack, getPlan, seedCatalog, upsertPlan } from "../src/domain/plans.ts";

describe("deployment configuration", () => {
  it("treats blank environment values as unset (compose passes empty strings)", () => {
    const cfg = loadCloudConfig({ STRIPE_SECRET_KEY: "", STRIPE_WEBHOOK_SECRET: " ", SMTP_URL: "", DATABASE_URL: "", MF_CLOUD_SIGNING_KEY: "", MF_DOWNLOAD_WINDOWS_URL: "", MF_CLOUD_PORT: "" });
    expect(cfg).toMatchObject({ stripeSecretKey: null, stripeWebhookSecret: null, smtpUrl: null, databaseUrl: null, signingKeyPem: null, port: 8080, downloads: { windowsUrl: null } });
  });

  it("listens on the platform's PORT unless MF_CLOUD_PORT is set (Railway and similar hosts)", () => {
    expect(loadCloudConfig({ PORT: "4123" }).port).toBe(4123);
    expect(loadCloudConfig({ PORT: "4123", MF_CLOUD_PORT: "8081" }).port).toBe(8081);
    expect(loadCloudConfig({}).port).toBe(8080);
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
});
