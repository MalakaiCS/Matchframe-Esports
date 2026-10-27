import { z } from "zod";
import { discoverCs2, renderGsiConfig, writeGsiConfig, type Cs2Install } from "@matchframe/game-adapters";
import type { Engine } from "../app.ts";
import { ConsoleOptions, GameLaunchMode, launchPlan, parseExtraArgs } from "../game/console.ts";
import { HttpError } from "../http/router.ts";
import type { Router } from "../http/router.ts";

/** Start CS2 and its console: launch profile, console options and the launch plan the program runs. */
export function registerGameRoutes(r: Router, e: Engine): void {
  r.get("/api/v1/game/console", { permission: "state.read" }, () => e.gameConsole.status());

  r.put(
    "/api/v1/game/launch-profile",
    {
      permission: "settings.manage",
      body: z.object({
        mode: GameLaunchMode,
        netconPort: z.number().int().min(1024).max(65535).default(2121),
        extraArgs: z.string().max(400).default(""),
        /** Accepts the HLAE warning: -insecure, no VAC-secured servers, VAC ban risk. */
        acknowledgeInsecure: z.boolean().optional(),
      }),
    },
    (req) => {
      const extra = parseExtraArgs(req.body.extraArgs);
      if (extra.error) throw new HttpError(400, extra.error, "invalid_launch_options");
      const prev = e.gameConsole.profile();
      const insecureAcknowledgedAt = req.body.acknowledgeInsecure ? new Date().toISOString() : prev.insecureAcknowledgedAt;
      if (req.body.mode === "hlae" && !insecureAcknowledgedAt) {
        throw new HttpError(409, "The HLAE mode starts CS2 with -insecure: it cannot join VAC-secured servers, and HLAE on a VAC-secured server risks a VAC ban. Accept the warning to use it.", "insecure_not_acknowledged");
      }
      e.gameConsole.setProfile({ mode: req.body.mode, netconPort: req.body.netconPort, extraArgs: extra.args.join(" "), insecureAcknowledgedAt });
      e.audit.record(req.principal!.label, "game.launch_profile.set", req.body.mode, { netconPort: req.body.netconPort, extraArgs: extra.args, acknowledgedInsecure: !!req.body.acknowledgeInsecure });
      return e.gameConsole.status();
    },
  );

  r.put("/api/v1/game/console-options", { permission: "camera.control", body: ConsoleOptions.partial() }, (req) => {
    e.gameConsole.setOptions(req.body);
    e.audit.record(req.principal!.label, "game.console_options.set", null, req.body);
    return e.gameConsole.status();
  });

  /**
   * Prepares Start CS2: finds CS2, writes the GSI config, sets camera control to the game's console
   * (when it was off) and starts listening for the console. Returns what the program starts; the
   * program on this computer starts it (the engine never starts other programs).
   */
  r.post("/api/v1/game/prepare-launch", { permission: "settings.manage" }, (req) => {
    let install = e.settings.get<Cs2Install | null>("cs2.install", null);
    if (!install) {
      const found = discoverCs2();
      if (found.install) e.settings.set("cs2.install", found.install);
      install = found.install;
    }
    if (!install) throw new HttpError(409, "CS2 was not found on this computer. Find it in Settings → Setup (or choose its folder there).", "cs2_not_found");
    const profile = e.gameConsole.profile();
    if (profile.mode === "hlae" && !profile.insecureAcknowledgedAt) throw new HttpError(409, "Accept the HLAE warning in the launch settings first.", "insecure_not_acknowledged");

    const uri = `http://127.0.0.1:${e.cfg.gsiPort}/gsi`;
    let gsi: { path: string; unchanged: boolean; error: null } | { path: null; unchanged: false; error: string };
    try {
      const res = writeGsiConfig(install.cfgDir, renderGsiConfig({ uri, token: e.secrets.gsiToken }));
      gsi = { path: res.path, unchanged: res.unchanged, error: null };
    } catch (err) {
      gsi = { path: null, unchanged: false, error: err instanceof Error ? err.message : String(err) };
    }

    const plan = launchPlan(profile, install);
    let observerAdapterChanged = false;
    if (plan.netconPort !== null) {
      const s = e.observerSettings();
      if (s.kind === "none" || (s.kind === "netcon" && (s.port !== plan.netconPort || !["127.0.0.1", "localhost"].includes(s.host)))) {
        e.settings.set("observer.adapter", { ...s, kind: "netcon", host: "127.0.0.1", port: plan.netconPort });
        observerAdapterChanged = true;
      }
    }
    e.gameConsole.sync();
    if (observerAdapterChanged) void e.applyObserverAdapter();
    e.audit.record(req.principal!.label, "game.prepare_launch", profile.mode, { args: plan.args, gsiWritten: gsi.error === null && !gsi.unchanged, observerAdapterChanged });
    return { plan, gsi, observerAdapterChanged, console: e.gameConsole.status() };
  });
}
