import { existsSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Engine } from "./app.ts";
import { loadConfig } from "./config.ts";
import { startServers } from "./servers.ts";

function repoPath(...parts: string[]): string | null {
  // Works from source (services/local-engine/src) and from a bundled build (resources/engine).
  const here = dirname(fileURLToPath(import.meta.url));
  for (const base of [resolve(here, "..", "..", ".."), resolve(here, ".."), resolve(here, "..", "..")]) {
    const p = join(base, ...parts);
    if (existsSync(p)) return p;
  }
  return null;
}

export async function main(): Promise<void> {
  const cfg = loadConfig({
    operatorUiDir: process.env.MATCHFRAME_OPERATOR_UI_DIR ?? repoPath("apps", "operator-web", "dist"),
    hudRendererDir: process.env.MATCHFRAME_HUD_DIR ?? repoPath("apps", "hud-renderer", "dist"),
    mapPackDir: process.env.MATCHFRAME_MAP_PACK_DIR ?? repoPath("assets", "map-packs"),
    workersDir: process.env.MATCHFRAME_WORKERS_DIR ?? repoPath("workers"),
  });
  const engine = new Engine(cfg);
  await engine.init();
  const servers = await startServers(engine);
  const url = `http://127.0.0.1:${cfg.apiPort}/?token=${engine.secrets.operatorToken}`;
  const urlFile = join(cfg.dataDir, "operator-url.txt");
  writeFileSync(urlFile, url + "\n", { mode: 0o600 });
  process.stdout.write(
    [
      "",
      "Matchframe Esports engine running",
      `  GSI receiver : http://${cfg.host}:${cfg.gsiPort}/gsi`,
      `  Operator API : http://${cfg.host}:${cfg.apiPort}/api/v1`,
      `  Overlays     : http://${cfg.host}:${cfg.overlayPort}/overlay/main/live?t=…`,
      `  Operator URL (contains the operator token) written to: ${urlFile}`,
      "",
    ].join("\n") + "\n",
  );
  // Signal readiness to a supervising desktop shell, if any.
  process.send?.({ type: "ready", apiPort: cfg.apiPort, overlayPort: cfg.overlayPort, gsiPort: cfg.gsiPort, operatorToken: engine.secrets.operatorToken });
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    engine.logger.info("engine shutting down");
    await servers.close();
    await engine.shutdown();
    process.exit(0);
  };
  process.on("SIGINT", () => void stop());
  process.on("SIGTERM", () => void stop());
  process.on("message", (m) => {
    if ((m as { type?: string })?.type === "shutdown") void stop();
  });
  process.on("uncaughtException", (err) => engine.logger.error("uncaught exception", { error: err.stack ?? String(err) }));
  process.on("unhandledRejection", (err) => engine.logger.error("unhandled rejection", { error: String(err) }));
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain || process.env.MATCHFRAME_ENGINE_MAIN === "1") {
  main().catch((e) => {
    process.stderr.write(`Matchframe engine failed to start: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  });
}
