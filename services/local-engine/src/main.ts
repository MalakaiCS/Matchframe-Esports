import { existsSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Engine } from "./app.ts";
import { loadConfig, pathList } from "./config.ts";
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
    captainUiDir: process.env.MATCHFRAME_CAPTAIN_UI_DIR ?? repoPath("apps", "operator-web", "dist-captain"),
    hudRendererDir: process.env.MATCHFRAME_HUD_DIR ?? repoPath("apps", "hud-renderer", "dist"),
    sampleHudsDirs: process.env.MATCHFRAME_SAMPLE_HUDS_DIR ? pathList(process.env.MATCHFRAME_SAMPLE_HUDS_DIR) : [repoPath("assets", "hud-packages"), repoPath("apps", "hud-template", "dist")].filter((p): p is string => p !== null),
    mapPackDir: process.env.MATCHFRAME_MAP_PACK_DIR ?? repoPath("assets", "map-packs"),
    utilityProfilesFile: process.env.MATCHFRAME_UTILITY_PROFILES ?? repoPath("assets", "utility-profiles", "measured.json"),
    builtinModelsDir: process.env.MATCHFRAME_MODELS_DIR ?? repoPath("assets", "models"),
    workersDir: process.env.MATCHFRAME_WORKERS_DIR ?? repoPath("workers"),
  });
  const engine = new Engine(cfg);
  await engine.init();
  const servers = await startServers(engine);
  // For scripts and headless use of the API. The console itself runs only inside the Matchframe program.
  const tokenFile = join(cfg.dataDir, "operator-token.txt");
  writeFileSync(tokenFile, engine.secrets.operatorToken + "\n", { mode: 0o600 });
  process.stdout.write(
    [
      "",
      "Matchframe Esports engine running",
      `  GSI receiver : http://${cfg.host}:${cfg.gsiPort}/gsi`,
      `  Operator API : http://${cfg.host}:${cfg.apiPort}/api/v1`,
      `  Overlays     : http://${cfg.host}:${cfg.overlayPort}/overlay/main/live?t=…`,
      `  Console      : runs inside the Matchframe program (pnpm desktop in development)`,
      `  API token (for scripts) written to: ${tokenFile}`,
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
    // A shutdown never hangs: the program restarts the engine only once this process has exited.
    setTimeout(() => {
      engine.logger.warn("shutdown took longer than 5 s; exiting");
      process.exit(0);
    }, 5000).unref();
    await servers.close();
    await engine.shutdown();
    process.exit(0);
  };
  process.on("SIGINT", () => void stop());
  process.on("SIGTERM", () => void stop());
  process.on("message", (m) => {
    if ((m as { type?: string })?.type === "shutdown") void stop();
  });
  if (process.send) {
    // Started by the program over IPC: when the program disappears (quit, crash, killed), the IPC
    // channel closes and the engine shuts down too, so no engine process is left behind.
    process.on("disconnect", () => {
      engine.logger.warn("program disconnected; engine shutting down");
      setTimeout(() => process.exit(0), 5000).unref();
      void stop();
    });
  }
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
