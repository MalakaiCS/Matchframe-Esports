// Screenshots of a built HUD package (dist/<hud>) in every demo scene, over a game-like background:
//   node scripts/shots.mjs <vector|lineup> <out dir> [--frames <scene>,<scene2> <ms between frames> <count>]
// --frames records an animation: the page shows <scene>, then switches to <scene2>, and a frame is
// taken every <ms> from the switch (e.g. --frames freeze,live 50 12 for going live).
import { createServer } from "node:http";
import { mkdirSync, readFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const [hud = "vector", out = join(here, "..", "shots", hud), ...rest] = process.argv.slice(2);
const dist = join(here, "..", "dist", hud);
if (!existsSync(join(dist, "index.html"))) throw new Error(`build dist/${hud} first (pnpm run build)`);
mkdirSync(out, { recursive: true });
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".woff": "font/woff", ".png": "image/png", ".webp": "image/webp" };
const server = createServer((req, res) => {
  const path = decodeURIComponent(new URL(req.url, "http://x").pathname);
  const file = join(dist, path === "/" ? "index.html" : path);
  if (!file.startsWith(dist) || !existsSync(file)) return res.writeHead(404).end();
  res.writeHead(200, { "content-type": types[extname(file)] ?? "application/octet-stream" }).end(readFileSync(file));
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}/index.html`;
const { chromium } = createRequire(join(here, "..", "..", "..", "package.json"))("playwright");
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
// A stand-in for the game behind the HUD: a mid-tone scene with some contrast.
const backdrop = `document.documentElement.style.background = "linear-gradient(160deg,#6f6a5c 0%,#9c8f74 35%,#4e5a63 70%,#2e3236 100%)";`;
const frames = rest[0] === "--frames" ? { scenes: rest[1].split(","), every: Number(rest[2] ?? 50), count: Number(rest[3] ?? 12) } : null;
if (!frames) {
  for (const scene of ["freeze", "live", "kill", "bomb", "defuse", "over"]) {
    await page.goto(`${base}?demo=${scene}`);
    await page.evaluate(backdrop);
    await page.waitForTimeout(1200);
    await page.screenshot({ path: join(out, `${scene}.png`) });
    console.log(join(out, `${scene}.png`));
  }
} else {
  // Plays the first scene, then switches to the second through the page's demo cycle hook.
  const [a, b] = frames.scenes;
  await page.goto(`${base}?demo=${a}`);
  await page.evaluate(backdrop);
  await page.waitForTimeout(1500);
  await page.evaluate((scene) => window.__mfDemo?.(scene), b);
  for (let i = 0; i < frames.count; i++) {
    await page.screenshot({ path: join(out, `${a}-to-${b}-${String(i).padStart(2, "0")}.png`) });
    await page.waitForTimeout(frames.every);
  }
  console.log(`${frames.count} frames in ${out}`);
}
await browser.close();
server.close();
