import { existsSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Engine } from "./app.ts";
import { loadConfig, pathList } from "./config.ts";
import { NewerDatabaseError } from "./db/database.ts";
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
    sampleHudsDirs: process.env.MATCHFRAME_SAMPLE_HUDS_DIR ? pathList(process.env.MATCHFRAME_SAMPLE_HUDS_DIR) : [repoPath("apps", "hud-designs", "dist")].filter((p): p is string => p !== null),
    mapPackDir: process.env.MATCHFRAME_MAP_PACK_DIR ?? repoPath("assets", "map-packs"),
    utilityProfilesFile: process.env.MATCHFRAME_UTILITY_PROFILES ?? repoPath("assets", "utility-profiles", "measured.json"),
    builtinModelsDir: process.env.MATCHFRAME_MODELS_DIR ?? repoPath("assets", "models"),
    workersDir: process.env.MATCHFRAME_WORKERS_DIR ?? repoPath("workers"),
  });
  const engine = new Engine(cfg);
  await engine.init();
  const servers = await startServers(engine);
  // For scripts and headless use of the API. The console itself runs only inside the MatchFrame program.
  const tokenFile = join(cfg.dataDir, "operator-token.txt");
  writeFileSync(tokenFile, engine.secrets.operatorToken + "\n", { mode: 0o600 });
  process.stdout.write(
    [
      "",
      "MatchFrame Esports engine running",
      `  GSI receiver : http://${cfg.host}:${cfg.gsiPort}/gsi`,
      `  Operator API : http://${cfg.host}:${cfg.apiPort}/api/v1`,
      `  Overlays     : http://${cfg.host}:${cfg.overlayPort}/overlay/main/live?t=…`,
      `  Console      : runs inside the MatchFrame program (pnpm desktop in development)`,
      `  API token (for scripts) written to: ${tokenFile}`,
      "",
    ].join("\n") + "\n",
  );
  // Signal readiness to a supervising desktop shell, if any.
  process.send?.({ type: "ready", apiPort: cfg.apiPort, overlayPort: cfg.overlayPort, gsiPort: cfg.gsiPort, operatorToken: engine.secrets.operatorToken });
  // Low-spec mode (ADR-078) for the program: the desktop HUD windows' frame rate now, the engine's memory cap at its next start.
  const sendPerformance = () => process.send?.({ type: "performance", lowSpec: engine.lowSpec.on, frameCap: engine.lowSpec.frameCap() });
  sendPerformance();
  engine.lowSpec.onChange(sendPerformance);
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
    const msg = m as { type?: string; id?: unknown } | null;
    if (msg?.type === "shutdown") void stop();
    // Crash reports (ADR-077): the program sends them with this computer's website sign-in. Only over
    // this IPC channel to the program that started the engine, never over HTTP.
    else if (msg?.type === "cloud-credentials") {
      const c = engine.cloud.credentials();
      process.send?.({ type: "cloud-credentials", id: msg.id, url: engine.cloud.url, token: c?.token ?? null, secrets: engine.secrets.knownSecrets() });
    }
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
    const message = e instanceof Error ? e.message : String(e);
    process.stderr.write(`MatchFrame engine failed to start: ${message}\n`);
    // Data saved by a newer version (ADR-076): the program shows this to the operator and does not
    // start the engine again (another start can't help).
    if (e instanceof NewerDatabaseError && process.send) process.send({ type: "fatal", reason: "newer-database", message }, () => process.exit(1));
    else process.exit(1);
  });
}
