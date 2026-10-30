// Bundles the Electron main/preload and the local engine (single ESM file) with esbuild.
import { build } from "esbuild";
import { cpSync, existsSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
await build({ entryPoints: [join(here, "src", "main.ts")], bundle: true, platform: "node", format: "cjs", target: "node22", outfile: join(here, "dist", "main.cjs"), external: ["electron"] });
await build({ entryPoints: [join(here, "src", "preload.ts")], bundle: true, platform: "node", format: "cjs", target: "node22", outfile: join(here, "dist", "preload.cjs"), external: ["electron"] });
await build({
  entryPoints: [join(root, "services", "local-engine", "src", "main.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  outfile: join(here, "dist", "engine", "engine.mjs"),
  // Optional native/accelerator modules are loaded lazily if present.
  external: ["koffi", "bufferutil", "utf-8-validate"],
  banner: { js: "import { createRequire as __mfCreateRequire } from 'node:module'; const require = __mfCreateRequire(import.meta.url);" },
  define: { "process.env.MATCHFRAME_ENGINE_MAIN": '"1"' },
});
// The replay feed's own process (it loads the NDI binding; services/local-engine/src/replay/feed-worker.ts).
await build({
  entryPoints: [join(root, "services", "local-engine", "src", "replay", "feed-worker.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  outfile: join(here, "dist", "engine", "feed-worker.mjs"),
  external: ["grandi"],
  banner: { js: "import { createRequire as __mfCreateRequire } from 'node:module'; const require = __mfCreateRequire(import.meta.url);" },
});

// The NDI binding next to the bundles (engine/node_modules): grandi, its loader, and this platform's
// prebuilt addon with the NDI runtime (Processing.NDI.Lib.x64.dll on Windows) and its licences.
const packageRoot = (file) => {
  let dir = dirname(file);
  while (!existsSync(join(dir, "package.json"))) dir = dirname(dir);
  return dir;
};
const modules = join(here, "dist", "engine", "node_modules");
rmSync(modules, { recursive: true, force: true });
const fromEngine = createRequire(join(root, "services", "local-engine", "package.json"));
const grandi = packageRoot(fromEngine.resolve("grandi"));
const fromGrandi = createRequire(join(grandi, "package.json"));
const prebuilt = `@grandi/${process.platform}-${process.arch}`;
for (const [name, dir] of [["grandi", grandi], ["node-gyp-build", packageRoot(fromGrandi.resolve("node-gyp-build"))], [prebuilt, packageRoot(fromGrandi.resolve(prebuilt))]]) {
  cpSync(dir, join(modules, name), { recursive: true, dereference: true, filter: (src) => !/[\\/]node_modules[\\/]\.bin([\\/]|$)/.test(src) });
}
console.log("desktop bundles written to apps/desktop/dist");
