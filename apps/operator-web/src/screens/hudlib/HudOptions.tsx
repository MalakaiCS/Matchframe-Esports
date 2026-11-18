import { useEffect, useState } from "react";
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
import { t } from "../../i18n/index.ts";

/** For the standard launch mode (no console): only the kill feed and the names above the players from the game's HUD. */
const GAME_HUD_COMMAND = "cl_drawhud 1; cl_draw_only_deathnotices 1; cl_drawhud_force_teamid_overhead 1";

const FRAME_CAPS = [60, 120, 144, 240];
const frameCapHint = () => t("game.opt.frameCapHint");

/**
 * The CT and T colours for the X-ray, smokes and kill feed (HLAE): chosen here, or each team's own.
 * A colour is saved a moment after it stops changing (the picker changes it continuously).
 */
function GameColours({ o, reason, save }: { o: ConsoleOptions | null; reason: string | null; save: (patch: Partial<ConsoleOptions>) => void }) {
  const [ct, setCt] = useState(o?.ctColour ?? "#3d9bff");
  const [tCol, setT] = useState(o?.tColour ?? "#ff4a4a");
  useEffect(() => {
    if (o) [setCt, setT].forEach((set, i) => set(i ? o.tColour : o.ctColour));
  }, [o?.ctColour, o?.tColour]);
  useEffect(() => {
    if (!o || (ct.toLowerCase() === o.ctColour.toLowerCase() && tCol.toLowerCase() === o.tColour.toLowerCase())) return;
    const timer = setTimeout(() => save({ ctColour: ct, tColour: tCol }), 400);
    return () => clearTimeout(timer);
  }, [ct, tCol]);
  const off = !!reason || !o;
  const hint = t("game.opt.coloursHint");
  return (
    <div className="hud-option" data-option="game-colours">
      <div className="hud-option-text">
        <span className="hud-option-label">{t("game.opt.colours")}</span>
        <span className="hud-option-hint" title={hint}>
          ?
        </span>
      </div>
      <div className="row">
        <select aria-label={t("game.opt.whichColours")} value={o?.colourSource ?? "sides"} disabled={off} title={reason ?? hint} onChange={(e) => save({ colourSource: e.target.value as ConsoleOptions["colourSource"] })}>
          <option value="sides">{t("game.opt.sideColours")}</option>
          <option value="teams">{t("game.opt.teamColours")}</option>
        </select>
        <label className="row small" title={t("game.opt.ctSide")}>
          CT <input type="color" aria-label={t("game.opt.ctColour")} value={ct} disabled={off} onChange={(e) => setCt(e.target.value)} />
        </label>
        <label className="row small" title={t("game.opt.tSide")}>
          T <input type="color" aria-label={t("game.opt.tColour")} value={tCol} disabled={off} onChange={(e) => setT(e.target.value)} />
        </label>
      </div>
    </div>
  );
}

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
    <section className="hudlib-card hud-options" aria-label={t("hudlib.options.label")}>
      <Toggle
        label={t("hudlib.options.testData")}
        testId="test-data"
        hint={t("hudlib.options.testDataHint")}
        on={simulated}
        reason={simReason}
        onChange={(v) => void run(v ? t("hudlib.options.runTestData") : t("hudlib.options.stopTestData"), () => api.post(v ? "/api/v1/simulation/start" : "/api/v1/simulation/stop", v ? { startOffsetSec: 25 } : {}), v ? t("hudlib.options.testDataRunning") : t("hudlib.options.testDataStopped"))}
      />
      <Toggle
        label={t("hudlib.options.showGraphics")}
        testId="show-graphics"
        hint={t("hudlib.options.showGraphicsHint")}
        on={library ? !library.hiddenAll : null}
        reason={editReason}
        onChange={(v) =>
          void run(v ? t("hudlib.options.showGraphics") : t("hudlib.options.hideAll"), async () => {
            await api.post(`${LIBRARY_PATH}/visibility`, { hidden: !v });
            if (bridge?.available) await (v ? bridge.showAll() : bridge.hideAll()).catch(() => undefined);
            onChanged();
          })
        }
      />
      <Toggle
        label={t("hudlib.options.radar")}
        testId="radar-utility"
        hint={t("hudlib.options.radarHint")}
        on={radarValue}
        reason={simReason}
        onChange={(v) =>
          void run(t("hudlib.options.radar"), async () => {
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
    ? [t("game.card.checking"), ""]
    : receiving
      ? [st.gameBuild ? t("game.card.receivingBuild", { build: st.gameBuild }) : t("game.card.receiving"), t("game.card.receivingHint")]
      : st.cs2Install
        ? [t("game.card.waiting"), t("game.card.waitingHint")]
        : [t("game.card.notFound"), t("game.card.notFoundHint")];
  const cl = consoleLine(g);
  const launchReason = launchUnavailableReason() ?? settingsReason ?? (!g ? t("common.loading") : mode === "hlae" && hlae.info && !hlae.info.ok ? hlae.info.problem : null);
  const saveMode = (m: GameLaunchMode, acknowledgeInsecure?: boolean) =>
    g && void run(t("game.launch.mode"), () => setLaunchProfile({ mode: m, netconPort: g.profile.netconPort, extraArgs: g.profile.extraArgs, ...(acknowledgeInsecure ? { acknowledgeInsecure } : {}) }).then(() => game.reload()));
  const option = (k: keyof ConsoleOptions) => (v: boolean) => void run(t("game.opt.option"), () => setConsoleOptions({ [k]: v }).then(() => game.reload()));
  const o = g?.options;
  return (
    <section className="hudlib-card hud-game" aria-label={t("shell.top.game")}>
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
            <span className="sr-only">{t("game.launch.mode")}</span>
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
                t("game.start"),
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
            <Icon name="play" size={14} /> {t("game.start")}
          </Button>
          <Link to="/settings/setup#start-cs2" className="btn btn-secondary btn-md" title={t("game.card.setupTitle")}>
            <Icon name="settings" size={14} /> {t("nav.setup")}
          </Link>
        </div>
      </div>
      {mode === "standard" ? (
        <div className="hud-game-command" title={t("game.card.commandTitle")}>
          <code>{GAME_HUD_COMMAND}</code>
          <CopyButton text={GAME_HUD_COMMAND} label={t("common.copy")} />
        </div>
      ) : (
        <div className="hud-game-options" aria-label={t("game.opt.label")}>
          <Toggle label={t("game.opt.hideHud")} testId="hide-game-hud" hint={t("game.opt.hideHudHint")} on={o ? o.hideGameHud : null} reason={cameraReason} onChange={option("hideGameHud")} />
          <Toggle label={t("game.opt.xray")} testId="xray" hint={t("game.opt.xrayHint")} on={o ? o.xray : null} reason={cameraReason} onChange={option("xray")} />
          <Toggle
            label={t("game.opt.clutchXray")}
            testId="clutch-xray-off"
            hint={t("game.opt.clutchXrayHint")}
            on={o ? o.clutchXrayOff : null}
            reason={cameraReason ?? (o && !o.xray ? t("game.opt.xrayOff") : null)}
            onChange={option("clutchXrayOff")}
          />
          <Toggle
            label={t("game.opt.retakeXray")}
            testId="retake-xray-off"
            hint={t("game.opt.retakeXrayHint")}
            on={o ? o.retakeXrayOff : null}
            reason={cameraReason ?? (o && !o.xray ? t("game.opt.xrayOff") : null)}
            onChange={option("retakeXrayOff")}
          />
          <Toggle
            label={t("game.opt.background")}
            testId="run-in-background"
            hint={t("game.opt.backgroundHint")}
            on={o ? o.runInBackground : null}
            reason={cameraReason}
            onChange={option("runInBackground")}
          />
          <div className="hud-option" data-option="frame-cap">
            <div className="hud-option-text">
              <span className="hud-option-label">{t("game.opt.frameCap")}</span>
              <span className="hud-option-hint" title={frameCapHint()}>
                ?
              </span>
            </div>
            <select
              aria-label={t("game.opt.frameCap")}
              value={o?.frameCap ?? ""}
              disabled={!!cameraReason || !o}
              title={cameraReason ?? frameCapHint()}
              onChange={(e) => void run(t("game.opt.option"), () => setConsoleOptions({ frameCap: e.target.value ? Number(e.target.value) : null }).then(() => game.reload()))}
            >
              <option value="">{t("game.opt.dontChange")}</option>
              {FRAME_CAPS.map((n) => (
                <option key={n} value={n}>
                  {t("game.opt.fps", { n })}
                </option>
              ))}
            </select>
          </div>
          {mode === "hlae" ? (
            <>
              <Toggle label={t("game.opt.noFlash")} testId="no-flash" hint={t("game.opt.noFlashHint")} on={o ? o.noFlash : null} reason={cameraReason} onChange={option("noFlash")} />
              <Toggle
                label={t("game.opt.xrayColours")}
                testId="xray-colours"
                hint={t("game.opt.xrayColoursHint")}
                on={o ? o.xrayColours : null}
                reason={cameraReason}
                onChange={option("xrayColours")}
              />
              <Toggle label={t("game.opt.smokes")} testId="smoke-colours" hint={t("game.opt.smokesHint")} on={o ? o.smokeColours : null} reason={cameraReason} onChange={option("smokeColours")} />
              <Toggle label={t("game.opt.killfeedColours")} testId="killfeed-colours" hint={t("game.opt.killfeedColoursHint")} on={o ? o.killfeedTeamColours : null} reason={cameraReason} onChange={option("killfeedTeamColours")} />
              <GameColours o={o ?? null} reason={cameraReason} save={(patch) => void run(t("game.opt.option"), () => setConsoleOptions(patch).then(() => game.reload()))} />
              <Toggle label={t("game.opt.endOfMatch")} testId="hide-end-of-match" hint={t("game.opt.endOfMatchHint")} on={o ? o.hideEndOfMatch : null} reason={cameraReason} onChange={option("hideEndOfMatch")} />
              <Toggle
                label={t("game.opt.hideKillfeed")}
                testId="hide-game-killfeed"
                hint={t("game.opt.hideKillfeedHint")}
                on={o ? o.hideGameKillfeed : null}
                reason={cameraReason}
                onChange={option("hideGameKillfeed")}
              />
            </>
          ) : null}
        </div>
      )}
      {mode === "hlae" && hlae.info && !hlae.info.ok ? (
        <div className="hud-game-note">
          <span className="text-warn small">{hlae.info.problem}</span>
          {hlae.choose ? (
            <Button size="sm" onClick={() => void hlae.choose!()} disabledReason={settingsReason}>
              {t("game.chooseHlae")}
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
