/** Writes docs/architecture/openapi.json and the route table in api-routes.md from the engine's registered routes. Run: pnpm openapi */
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Engine } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { startServers } from "../src/servers.ts";

process.env.MATCHFRAME_LOG_STDOUT = "0";
const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const engine = new Engine(loadConfig({ dataDir: mkdtempSync(join(tmpdir(), "mf-openapi-")), gsiPort: 47210, apiPort: 47211, overlayPort: 47212, operatorUiDir: null, hudRendererDir: null, mapPackDir: null, workersDir: null, pythonPath: null }));
await engine.init();
const servers = await startServers(engine);
const doc = servers.router.openapi({ title: "Matchframe Esports local API", version: "0.1.0" });
writeFileSync(join(root, "docs", "architecture", "openapi.json"), JSON.stringify(doc, null, 2) + "\n");
const routesMd = join(root, "docs", "architecture", "api-routes.md");
const md = readFileSync(routesMd, "utf8");
const start = md.indexOf("| Method | Path | Permission |");
const end = md.indexOf("\n## ", start);
const table = ["| Method | Path | Permission |", "|---|---|---|", ...servers.router.routeList().map((r) => `| ${r.method} | \`${r.path}\` | ${r.permission} |`)].join("\n");
writeFileSync(routesMd, md.slice(0, start) + table + "\n" + md.slice(end));
console.log(`wrote ${Object.keys(doc.paths as object).length} paths`);
await servers.close();
await engine.shutdown();
process.exit(0);
