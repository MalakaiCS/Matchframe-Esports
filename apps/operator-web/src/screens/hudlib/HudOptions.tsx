import { useState } from "react";
import type { HudLibrary } from "@matchframe/contracts";
import { desktopHud } from "../../api/desktop.ts";
import { api } from "../../api/index.ts";
import type { SetupStatus } from "../../api/types.ts";
import { Icon } from "../../components/icons.tsx";
import { Button, CopyButton } from "../../components/ui.tsx";
import { useApi } from "../../lib/hooks.ts";
import { Link } from "../../router.tsx";
import { useLive } from "../../state/live.ts";
import { usePermission } from "../../state/session.tsx";
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

/** The game: CS2 found or not, whether its data arrives, a console command for spectating, and Launch CS2. */
export function GameCard() {
  const status = useApi<SetupStatus>("/api/v1/setup/status", { refreshMs: 10_000 });
  const src = useLive((s) => s.snapshot?.state?.sources[0] ?? null);
  const run = useRun();
  const st = status.data;
  const receiving = !!src && !src.stale;
  const [line, hint] = !st
    ? ["Checking…", ""]
    : receiving
      ? [`Receiving game data${st.gameBuild ? ` · build ${st.gameBuild}` : ""}`, "CS2 is sending game data to Matchframe."]
      : st.cs2Install
        ? ["Waiting for game data", "CS2 is installed. Start it and spectate a match or play a demo; data arrives through game state integration (GSI)."]
        : ["CS2 not found yet", "Set up CS2 in Setup: Matchframe installs the game state integration (GSI) config into the CS2 folder."];
  const launch = window.matchframe?.launchCs2;
  return (
    <section className="hudlib-card hud-game" aria-label="Game">
      <div className="hud-game-title">
        <Icon name="gamepad" size={18} />
        <div>
          <strong>Counter-Strike 2</strong>
          <span className={`small ${receiving ? "text-ok" : "muted"}`} title={hint}>
            {line}
          </span>
        </div>
      </div>
      <div className="hud-game-command" title="Paste into the CS2 console while spectating: hides the game's own HUD apart from the kill notices, so only your HUD shows">
        <code>cl_draw_only_deathnotices 1</code>
        <CopyButton text="cl_draw_only_deathnotices 1" label="Copy" />
      </div>
      <div className="row hud-game-actions">
        {launch ? (
          <Button variant="primary" onClick={() => void run("Launch CS2", () => launch(), "Starting CS2 through Steam")}>
            <Icon name="play" size={14} /> Launch CS2
          </Button>
        ) : null}
        <Link to="/settings/setup" className="btn btn-secondary btn-md" title="Game state integration (GSI) config, camera control and checks">
          <Icon name="settings" size={14} /> Setup
        </Link>
      </div>
    </section>
  );
}
