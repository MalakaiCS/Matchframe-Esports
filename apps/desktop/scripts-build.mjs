// Bundles the Electron main/preload and the local engine (single ESM file) with esbuild.
import { build } from "esbuild";
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
console.log("desktop bundles written to apps/desktop/dist");
