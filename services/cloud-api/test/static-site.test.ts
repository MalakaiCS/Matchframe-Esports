import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CloudApp } from "../src/app.ts";
import { loadCloudConfig } from "../src/config.ts";
import { PgliteSql } from "../src/db/sql.ts";
import { startCloudServer } from "../src/server.ts";
import { freePort } from "./http.ts";

describe("website files", () => {
  let app: CloudApp;
  let close: () => Promise<void>;
  let base: string;
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  beforeAll(async () => {
    const webDir = mkdtempSync(join(tmpdir(), "mf-web-"));
    writeFileSync(join(webDir, "index.html"), '<meta property="og:image" content="__MF_PUBLIC_URL__/brand/og-image.png" />');
    mkdirSync(join(webDir, "brand"));
    writeFileSync(join(webDir, "brand", "og-image.png"), png);
    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    app = new CloudApp(loadCloudConfig({}, { publicUrl: `${base}/`, port, webDir }), { sql: new PgliteSql() });
    await app.init();
    ({ close } = await startCloudServer(app));
  });

  afterAll(async () => {
    await close?.();
    await app?.close();
  });

  it("fills the public address into the social preview tags of every page", async () => {
    for (const path of ["/", "/pricing"]) {
      const r = await fetch(`${base}${path}`);
      expect(r.headers.get("content-type")).toMatch(/^text\/html/);
      expect(await r.text()).toBe(`<meta property="og:image" content="${base}/brand/og-image.png" />`);
    }
  });

  it("serves brand images unchanged", async () => {
    const r = await fetch(`${base}/brand/og-image.png`);
    expect(r.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await r.arrayBuffer()).equals(png)).toBe(true);
  });
});
