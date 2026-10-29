// Bundles the cloud API into one ESM file for deployment (dist/server.mjs). PGlite stays external
// (it loads its WebAssembly next to its own module); the runtime image installs it.
import { build } from "esbuild";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
await build({
  entryPoints: [join(here, "..", "src", "main.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  outfile: join(here, "..", "dist", "server.mjs"),
  external: ["@electric-sql/pglite", "pg-native", "bufferutil", "utf-8-validate"],
  banner: { js: "import { createRequire as __mfCreateRequire } from 'node:module'; const require = __mfCreateRequire(import.meta.url);" },
  legalComments: "linked",
});
console.log("cloud API bundle written to services/cloud-api/dist/server.mjs");
