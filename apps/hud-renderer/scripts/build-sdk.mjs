// Bundles the read-only HUD SDK client for imported HUD packages (served at /sdk/hud-sdk.js).
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
await build({
  entryPoints: [join(here, "..", "..", "..", "packages", "hud-sdk", "src", "index.ts")],
  bundle: true,
  format: "esm",
  target: "es2022",
  outfile: join(here, "..", "dist", "sdk", "hud-sdk.js"),
  minify: true,
  legalComments: "none",
});
console.log("HUD SDK bundle written to dist/sdk/hud-sdk.js");
