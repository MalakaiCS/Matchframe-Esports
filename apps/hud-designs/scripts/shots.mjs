// Screenshots of a built HUD package (dist/<hud>) in every demo scene, over a game-like background:
//   node scripts/shots.mjs <vector|lineup|stage> <out dir> [--query "<demo params>"] [--frames <scene>,<scene2> <ms between frames> <count>]
// --query adds demo parameters to every page, e.g. --query "art=1&radar=1&logo=1&bo=5" (sample HUD
// images, sample radar, sample team emblems, best of 5).
// --frames records an animation: the page shows <scene>, then switches to <scene2>, and a frame is
// taken every <ms> from the switch (e.g. --frames freeze,live 50 12 for going live; replay:none,replay:3k
// for the replay graphic coming in). With a list of times instead (ms after the switch), a frame is
// taken at each, named with the time it was really taken, and later scenes switch in at <scene>@<ms>:
// --frames over,mvpfreeze,mvplive@6000 4900,5100,13900,14100 records the round MVP card coming in 5 s
// into freeze time and going 8 s into the round. --clip <x,y,w,h> takes only that part of the page in
// each frame (quicker, so frames can be closer together).
// --replay takes the replay layer (?demo=replay) with each sample play, with and without team logos.
// --backdrop <image> puts a picture behind the HUD instead of the gradient (e.g. a darkened game frame
// for side-by-side comparisons; the picture stays wherever it is, it is only served to the page).
// `?radar=mirage` pages get Mirage's real radar image from assets/radars at /demo-radar/.
// --scenes <a,b,…> takes those scenes instead of the usual eleven (e.g. --scenes edge,edgebomb,edgeover,
// edgeboard,edgepause, the test states with long names, knives in hand, a team without a logo, paused
// data, a pause with no countdown).
// --icons <dir> serves an icon pack folder (an engine's <dataDir>/icon-pack: <name>.svg and pack.json)
// at /icon-pack/ and tells the demo which icons there are (?iconpack=…), as a loaded icon pack would.
import { createServer } from "node:http";
import { mkdirSync, readFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const [hud = "vector", out = join(here, "..", "shots", hud), ...args] = process.argv.slice(2);
const bi = args.indexOf("--backdrop");
const backdropImage = bi >= 0 ? args[bi + 1] : null;
const args1 = bi >= 0 ? [...args.slice(0, bi), ...args.slice(bi + 2)] : args;
const ii = args1.indexOf("--icons");
const icons = ii >= 0 ? args1[ii + 1] : null;
const args2 = ii >= 0 ? [...args1.slice(0, ii), ...args1.slice(ii + 2)] : args1;
const ci = args2.indexOf("--clip");
const clipArg = ci >= 0 ? args2[ci + 1].split(",").map(Number) : null;
const clip = clipArg ? { x: clipArg[0], y: clipArg[1], width: clipArg[2], height: clipArg[3] } : undefined;
if (ci >= 0) args2.splice(ci, 2);
const si = args2.indexOf("--scenes");
const scenes = si >= 0 ? args2[si + 1].split(",") : ["freeze", "live", "kill", "plant", "bomb", "defuse", "over", "timeout", "mvp", "nocam", "pause"];
const argsLeft = si >= 0 ? [...args2.slice(0, si), ...args2.slice(si + 2)] : args2;
const radars = join(here, "..", "..", "..", "assets", "radars");
const qi = argsLeft.indexOf("--query");
const iconNames = icons ? JSON.parse(readFileSync(join(icons, "pack.json"), "utf8")).names : [];
const extra = (qi >= 0 ? `&${argsLeft[qi + 1] ?? ""}` : "") + (iconNames.length ? `&iconpack=${iconNames.join(",")}` : "");
const rest = qi >= 0 ? [...argsLeft.slice(0, qi), ...argsLeft.slice(qi + 2)] : argsLeft;
const dist = join(here, "..", "dist", hud);
if (!existsSync(join(dist, "index.html"))) throw new Error(`build dist/${hud} first (pnpm run build)`);
mkdirSync(out, { recursive: true });
const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".woff": "font/woff", ".png": "image/png", ".webp": "image/webp" };
const server = createServer((req, res) => {
  const path = decodeURIComponent(new URL(req.url, "http://x").pathname);
  if (path === "/__backdrop" && backdropImage) return res.writeHead(200, { "content-type": types[extname(backdropImage)] ?? "image/png" }).end(readFileSync(backdropImage));
  const radar = /^\/demo-radar\/(de_[a-z0-9]+)\.png$/.exec(path);
  if (radar) {
    const f = join(radars, `${radar[1]}.png`);
    return existsSync(f) ? res.writeHead(200, { "content-type": "image/png" }).end(readFileSync(f)) : res.writeHead(404).end();
  }
  const icon = icons && /^\/icon-pack\/([a-z0-9_]+)\.svg$/.exec(path);
  if (icon) {
    const f = join(icons, `${icon[1]}.svg`);
    return existsSync(f) ? res.writeHead(200, { "content-type": "image/svg+xml" }).end(readFileSync(f)) : res.writeHead(404).end();
  }
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
const backdrop = backdropImage ? `document.documentElement.style.background = "#000 url(/__backdrop) center / cover no-repeat";` : `document.documentElement.style.background = "linear-gradient(160deg,#6f6a5c 0%,#9c8f74 35%,#4e5a63 70%,#2e3236 100%)";`;
const frames = rest[0] === "--frames" ? { scenes: rest[1].split(","), every: Number(rest[2] ?? 50), count: Number(rest[3] ?? 12), times: String(rest[2] ?? "").includes(",") ? rest[2].split(",").map(Number) : null } : null;
if (rest[0] === "--replay") {
  for (const play of ["3k", "kill", "ace", "clutch", "manual"]) {
    for (const logo of ["0", "1"]) {
      await page.goto(`${base}?demo=replay&play=${play}&logo=${logo}${extra}`);
      await page.evaluate(backdrop);
      await page.waitForTimeout(2000);
      const file = join(out, `replay-${play}${logo === "1" ? "-logo" : ""}.png`);
      await page.screenshot({ path: file });
      console.log(file);
    }
  }
} else if (!frames) {
  for (const scene of scenes) {
    await page.goto(`${base}?demo=${scene}${extra}`);
    await page.evaluate(backdrop);
    await page.waitForTimeout(1200);
    await page.screenshot({ path: join(out, `${scene}.png`) });
    console.log(join(out, `${scene}.png`));
  }
} else {
  // Plays the first scene, then switches to the second through the page's demo cycle hook.
  const [a, b] = frames.scenes;
  // A replay:<play> scene is shown on the replay layer's page.
  await page.goto(`${base}?demo=${a.startsWith("replay") ? `replay&play=${a.slice(7) || "none"}` : a}${extra}`);
  await page.evaluate(backdrop);
  await page.waitForTimeout(1500);
  const t0 = await page.evaluate((scene) => (window.__mfDemo?.(scene), window.performance.now()), b.split("@")[0]);
  if (frames.times) {
    // Frames at set times after the switch, and later scenes switched in on the way (page clock).
    const later = frames.scenes.slice(2).map((s) => ({ t: Number(s.split("@")[1] ?? 0), scene: s.split("@")[0] }));
    const events = [...frames.times.map((t, i) => ({ t, shot: i })), ...later].sort((x, y) => x.t - y.t);
    for (const ev of events) {
      const wait = ev.t - (await page.evaluate((s) => window.performance.now() - s, t0));
      if (wait > 0) await page.waitForTimeout(wait);
      if (ev.scene) {
        await page.evaluate((scene) => window.__mfDemo?.(scene), ev.scene);
        continue;
      }
      const at = Math.round(await page.evaluate((s) => window.performance.now() - s, t0));
      await page.screenshot({ clip, path: join(out, `${a}-to-${b.split("@")[0]}-${String(ev.shot).padStart(2, "0")}-${at}ms.png`.replace(/:/g, "-")) });
    }
    console.log(`${frames.times.length} frames in ${out}`);
  } else {
    for (let i = 0; i < frames.count; i++) {
      await page.screenshot({ path: join(out, `${a}-to-${b}-${String(i).padStart(2, "0")}.png`.replace(/:/g, "-")) });
      await page.waitForTimeout(frames.every);
    }
    console.log(`${frames.count} frames in ${out}`);
  }
}
await browser.close();
server.close();
