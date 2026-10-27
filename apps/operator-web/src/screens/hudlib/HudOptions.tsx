import { useState } from "react";
import type { HudLibrary } from "@matchframe/contracts";
import { desktopHud } from "../../api/desktop.ts";
import { api } from "../../api/index.ts";
import type { SetupStatus } from "../../api/types.ts";
import { Icon } from "../../components/icons.tsx";
import { Badge, Button, CopyButton } from "../../components/ui.tsx";
import { LAUNCH_MODES, launchUnavailableReason, setConsoleOptions, setLaunchProfile, useGameConsole, useHlae, type ConsoleOptions, type GameLaunchMode } from "../../lib/game.ts";
import { useApi } from "../../lib/hooks.ts";
import { Link } from "../../router.tsx";
import { useLive } from "../../state/live.ts";
import { usePermission } from "../../state/session.tsx";
import { consoleLine, HlaeWarningDialog } from "../game/LaunchSettings.tsx";
import { LIBRARY_PATH, useRun } from "./actions.ts";

function Toggle({ label, hint, on, onChange, reason, testId }: { label: string; hint: string; on: boolean | null; onChange: (v: boolean) => void; reason: string | null; testId: string }) {
  return (
    <div className="hud-option" data-option={testId}>
      <div className="hud-option-text">
        <span className="hud-option-label">{label}</span>
        <span className="hud-option-hint" title={hint}>
          ?
        </span>
      </div>
      <button type="button" role="switch" aria-checked={!!on} aria-label={label} className={`switch ${on ? "is-on" : ""}`} disabled={!!reason || on === null} title={reason ?? hint} onClick={() => onChange(!on)}>
        <span className="switch-track" aria-hidden>
          <span className="switch-thumb" />
        </span>
      </button>
    </div>
  );
}

/** Library-wide switches: test data, all HUD graphics on or off, utility on the radar. */
export function HudOptions({ library, onChanged }: { library: HudLibrary | undefined; onChanged: () => void }) {
  const run = useRun();
  const simulated = useLive((s) => s.snapshot?.simulated ?? false);
  const simReason = usePermission("settings.manage");
  const editReason = usePermission("hud.publish");
  const radar = useApi<{ value: unknown }>(simReason ? null : "/api/v1/settings/hud.radarUtility");
  const [radarOn, setRadarOn] = useState<boolean | null>(null);
  const radarValue = radarOn ?? (radar.data ? radar.data.value !== false : null);
  const bridge = desktopHud();
  return (
    <section className="hudlib-card hud-options" aria-label="HUD options">
      <Toggle
        label="Test data"
        testId="test-data"
        hint="Feeds every HUD with the labelled simulation (a synthetic match), without CS2. Stop it before a real match."
        on={simulated}
        reason={simReason}
        onChange={(v) => void run(v ? "Run Test Data" : "Stop Test Data", () => api.post(v ? "/api/v1/simulation/start" : "/api/v1/simulation/stop", v ? { startOffsetSec: 25 } : {}), v ? "Test data running" : "Test data stopped")}
      />
      <Toggle
        label="Show HUD graphics"
        testId="show-graphics"
        hint="Off hides every HUD graphic at once: desktop HUDs, previews and OBS sources (the emergency hide, Ctrl+Shift+F9)."
        on={library ? !library.hiddenAll : null}
        reason={editReason}
        onChange={(v) =>
          void run(v ? "Show HUD graphics" : "Hide all HUD graphics", async () => {
            await api.post(`${LIBRARY_PATH}/visibility`, { hidden: !v });
            if (bridge?.available) await (v ? bridge.showAll() : bridge.hideAll()).catch(() => undefined);
            onChanged();
          })
        }
      />
      <Toggle
        label="Utility on the radar"
        testId="radar-utility"
        hint="Smokes, fires and flashes confirmed by the game appear on HUD radars (never predictions)."
        on={radarValue}
        reason={simReason}
        onChange={(v) =>
          void run("Utility on the radar", async () => {
            await api.put("/api/v1/settings/hud.radarUtility", { value: v });
            setRadarOn(v);
          })
        }
      />
    </section>
  );
}

/**
 * The game: CS2 found or not and whether its data arrives, the launch mode and Start CS2, the
 * console connection, and the game options sent through the console (or, in the standard mode, the
 * console command to paste by hand).
 */
export function GameCard() {
  const status = useApi<SetupStatus>("/api/v1/setup/status", { refreshMs: 10_000 });
  const game = useGameConsole(3000);
  const src = useLive((s) => s.snapshot?.state?.sources[0] ?? null);
  const run = useRun();
  const hlae = useHlae();
  const settingsReason = usePermission("settings.manage");
  const cameraReason = usePermission("camera.control");
  const [askHlae, setAskHlae] = useState<GameLaunchMode | null>(null);
  const st = status.data;
  const g = game.data;
  const mode = g?.profile.mode ?? "standard";
  const receiving = !!src && !src.stale;
  const [line, hint] = !st
    ? ["Checking…", ""]
    : receiving
      ? [`Receiving game data${st.gameBuild ? ` · build ${st.gameBuild}` : ""}`, "CS2 is sending game data to Matchframe."]
      : st.cs2Install
        ? ["Waiting for game data", "CS2 is installed. Start it and spectate a match or play a demo; data arrives through game state integration (GSI)."]
        : ["CS2 not found yet", "Set up CS2 in Setup: Matchframe installs the game state integration (GSI) config into the CS2 folder."];
  const cl = consoleLine(g);
  const launchReason = launchUnavailableReason() ?? settingsReason ?? (!g ? "Loading…" : mode === "hlae" && hlae.info && !hlae.info.ok ? hlae.info.problem : null);
  const saveMode = (m: GameLaunchMode, acknowledgeInsecure?: boolean) =>
    g && void run("Launch mode", () => setLaunchProfile({ mode: m, netconPort: g.profile.netconPort, extraArgs: g.profile.extraArgs, ...(acknowledgeInsecure ? { acknowledgeInsecure } : {}) }).then(() => game.reload()));
  const option = (k: keyof ConsoleOptions) => (v: boolean) => void run("Game option", () => setConsoleOptions({ [k]: v }).then(() => game.reload()));
  const o = g?.options;
  return (
    <section className="hudlib-card hud-game" aria-label="Game">
      <div className="hud-game-head">
        <div className="hud-game-title">
          <Icon name="gamepad" size={18} />
          <div>
            <strong>Counter-Strike 2</strong>
            <span className={`small ${receiving ? "text-ok" : "muted"}`} title={hint}>
              {line}
            </span>
          </div>
        </div>
        {cl ? (
          <Badge tone={cl.tone} title={cl.title}>
            {cl.text}
          </Badge>
        ) : null}
        <div className="row hud-game-actions">
          <label className="hud-game-mode" title={LAUNCH_MODES.find((m) => m.id === mode)?.detail}>
            <span className="sr-only">Launch mode</span>
            <select
              value={mode}
              disabled={!g || !!settingsReason}
              onChange={(e) => {
                const m = e.target.value as GameLaunchMode;
                if (m === "hlae" && !g?.profile.insecureAcknowledgedAt) setAskHlae(m);
                else saveMode(m);
              }}
            >
              {LAUNCH_MODES.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.short}
                </option>
              ))}
            </select>
          </label>
          <Button
            variant="primary"
            disabledReason={launchReason}
            onClick={() =>
              void run(
                "Start CS2",
                async () => {
                  const r = await window.matchframe!.launchCs2!();
                  if (!r.ok) throw new Error(r.message);
                  void game.reload();
                  return r;
                },
                (r) => r.message,
              )
            }
          >
            <Icon name="play" size={14} /> Start CS2
          </Button>
          <Link to="/settings/setup#start-cs2" className="btn btn-secondary btn-md" title="Launch mode, console port, launch options, HLAE, and the game data (GSI) config">
            <Icon name="settings" size={14} /> Setup
          </Link>
        </div>
      </div>
      {mode === "standard" ? (
        <div className="hud-game-command" title="Paste into the CS2 console while spectating: hides the game's own HUD apart from the kill notices, so only your HUD shows. The Observer tools launch mode does this for you.">
          <code>cl_draw_only_deathnotices 1</code>
          <CopyButton text="cl_draw_only_deathnotices 1" label="Copy" />
        </div>
      ) : (
        <div className="hud-game-options" aria-label="Game options">
          <Toggle label="Hide game HUD" testId="hide-game-hud" hint="cl_draw_only_deathnotices 1: the game shows only its kill feed; your HUD shows the rest. Sent when the console connects." on={o ? o.hideGameHud : null} reason={cameraReason} onChange={option("hideGameHud")} />
          <Toggle label="X-ray" testId="xray" hint="spec_show_xray: players visible through walls on the observer's screen." on={o ? o.xray : null} reason={cameraReason} onChange={option("xray")} />
          {mode === "hlae" ? (
            <>
              <Toggle label="No flash" testId="no-flash" hint="HLAE mirv_noflash 1: flashbangs don't white out the observer's screen." on={o ? o.noFlash : null} reason={cameraReason} onChange={option("noFlash")} />
              <Toggle label="Team colours in kill feed" testId="killfeed-colours" hint="HLAE mirv_deathmsg colors: CT and T names in the kill feed in each team's colour (Teams → colour), swapped at half time." on={o ? o.killfeedTeamColours : null} reason={cameraReason} onChange={option("killfeedTeamColours")} />
              <Toggle label="Hide end-of-match screen" testId="hide-end-of-match" hint="HLAE mirv_endofmatch 0: no end-of-match scene over the game." on={o ? o.hideEndOfMatch : null} reason={cameraReason} onChange={option("hideEndOfMatch")} />
            </>
          ) : null}
        </div>
      )}
      {mode === "hlae" && hlae.info && !hlae.info.ok ? (
        <div className="hud-game-note">
          <span className="text-warn small">{hlae.info.problem}</span>
          {hlae.choose ? (
            <Button size="sm" onClick={() => void hlae.choose!()} disabledReason={settingsReason}>
              Choose HLAE.exe…
            </Button>
          ) : null}
        </div>
      ) : null}
      {askHlae ? (
        <HlaeWarningDialog
          onCancel={() => setAskHlae(null)}
          onConfirm={() => {
            saveMode(askHlae, true);
            setAskHlae(null);
          }}
        />
      ) : null}
    </section>
  );
}
