// Writes package-files/<hud>/thumbnail.webp (640x360, the HUD Library card) from the built page in a demo scene:
//   node scripts/thumbnail.mjs <vector|lineup> [scene]
// The browser itself encodes the WebP (canvas), so no image tools are needed.
import { createServer } from "node:http";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const [hud = "vector", scene = "kill"] = process.argv.slice(2);
const dist = join(here, "..", "dist", hud);
if (!existsSync(join(dist, "index.html"))) throw new Error(`build dist/${hud} first (pnpm run build)`);
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".woff": "font/woff", ".png": "image/png", ".webp": "image/webp" };
const server = createServer((req, res) => {
  const path = decodeURIComponent(new URL(req.url, "http://x").pathname);
  const file = join(dist, path === "/" ? "index.html" : path);
  if (!file.startsWith(dist) || !existsSync(file)) return res.writeHead(404).end();
  res.writeHead(200, { "content-type": types[extname(file)] ?? "application/octet-stream" }).end(readFileSync(file));
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const { chromium } = createRequire(join(here, "..", "..", "..", "package.json"))("playwright");
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
await page.goto(`http://127.0.0.1:${server.address().port}/index.html?demo=${scene}`);
// The same dark stage as the other bundled HUDs' cards.
await page.evaluate(() => (document.documentElement.style.background = "radial-gradient(ellipse at 50% 40%,#2c3440 0%,#151a21 70%,#0d1015 100%)"));
await page.waitForTimeout(1500);
const png = (await page.screenshot()).toString("base64");
const webp = await page.evaluate(async (src) => {
  const img = new Image();
  img.src = `data:image/png;base64,${src}`;
  await img.decode();
  const c = document.createElement("canvas");
  c.width = 640;
  c.height = 360;
  const g = c.getContext("2d");
  g.imageSmoothingQuality = "high";
  g.drawImage(img, 0, 0, 640, 360);
  return c.toDataURL("image/webp", 0.86).split(",")[1];
}, png);
const out = join(here, "..", "package-files", hud, "thumbnail.webp");
writeFileSync(out, Buffer.from(webp, "base64"));
console.log(`${out} (${Math.round(Buffer.from(webp, "base64").length / 1024)} KB)`);
await browser.close();
server.close();
