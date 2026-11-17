import type { HudLibrary } from "@matchframe/contracts";
import type { HudReplayClip } from "@matchframe/hud-sdk";
import { api, describeError } from "../../api/index.ts";
import { ActionButton, Badge, Checkbox, CopyButton, Field, Mono, Note, Panel } from "../../components/ui.tsx";
import { useToast } from "../../components/toasts.tsx";
import { useApi } from "../../lib/hooks.ts";
import { usePermission } from "../../state/session.tsx";
import { t } from "../../i18n/index.ts";

/** GET /api/v1/replay-graphic (services/local-engine/src/routes/replay-graphic.ts). */
export interface ReplayGraphicView {
  settings: { enabled: boolean; hudId: string };
  output: { hudId: string; hudName: string; forHudId: string; forHudName: string; style: "own" | "builtin"; url: string; why: string } | null;
  source: string;
  replayScene: string | null;
  obsConnected: boolean;
  onAir: HudReplayClip | null;
}

interface ObsSetup {
  scene: string;
  source: string;
  created: boolean;
  onTop: boolean;
  output: NonNullable<ReplayGraphicView["output"]>;
}

/** What the lower third says, in a line. */
export function describeClip(c: HudReplayClip): string {
  const what = c.clutchVersus !== null ? t("prod.text1vClutchversusClutch", { clutchVersus: c.clutchVersus }) : c.multiKill ?? (c.kills === 1 ? "kill" : null);
  return [c.player?.name ?? "Replay", what, c.weapon?.displayName, c.headshot ? "headshot" : null, c.roundNumber !== null ? `round ${c.roundNumber}` : null].filter(Boolean).join(" · ");
}

/**
 * The replay graphic: a "REPLAY" tag and a lower third with the play on MatchFrame's HUDs while a
 * replay is on air. It shows on a HUD's replay page (transparent but for the graphic), which goes
 * on top of the OBS replay scene; the live HUD never shows it.
 */
export function ReplayGraphicPanel() {
  const g = useApi<ReplayGraphicView>("/api/v1/replay-graphic", { refreshMs: 2000 });
  const lib = useApi<HudLibrary>("/api/v1/hud/library");
  const reason = usePermission("hud.publish");
  const setupReason = usePermission("settings.manage");
  const toast = useToast();
  const st = g.data;
  const save = async (patch: Partial<ReplayGraphicView["settings"]>) => {
    try {
      g.setData(await api.put<ReplayGraphicView>("/api/v1/replay-graphic", patch));
    } catch (e) {
      toast.push("danger", t("prod.settingNotSaved"), describeError(e));
    }
  };
  const off = !!reason || !st;
  const out = st?.output ?? null;
  return (
    <Panel title={t("prod.replayGraphic")} subtitle={t("prod.aReplayTagAndA")} actions={st?.onAir ? <Badge tone="accent">{t("prod.onAir")}</Badge> : st ? <Badge tone={st.settings.enabled ? "ok" : "neutral"}>{st.settings.enabled ? t("prod.on") : t("prod.off")}</Badge> : null}>
      <div className="stack-sm">
        <Checkbox checked={st?.settings.enabled ?? true} disabled={off} label={t("prod.showTheReplayGraphic")} hint={t("prod.whoMadeThePlayThe")} onChange={(v) => void save({ enabled: v })} />
        <Field label="HUD" hint={t("prod.eachMatchframeHudHasIts")}>
          <select value={st?.settings.hudId ?? "auto"} disabled={off} onChange={(e) => void save({ hudId: e.target.value })}>
            <option value="auto">{t("prod.automaticTheHudInObs")}</option>
            {(lib.data?.huds ?? []).map((h) => (
              <option key={h.id} value={h.id}>
                {h.name}
              </option>
            ))}
          </select>
        </Field>
        {out ? (
          <div className="stack-sm">
            <p className="small">
              {out.why} <span className="muted">{t("prod.pageHudnameReplay", { hudName: out.hudName })}</span>
            </p>
            <div className="row">
              <Mono>{out.url}</Mono>
              <CopyButton text={out.url} />
            </div>
          </div>
        ) : st ? (
          <Note tone="warn">{t("prod.noHudHasAReplay")}</Note>
        ) : null}
        <div className="row">
          <ActionButton
            action={() => api.post<ObsSetup>("/api/v1/replay-graphic/obs")}
            success={(r) => `${r.created ? t("prod.sourceAddedOnTopOf", { source: r.source, scene: r.scene }) : t("prod.sourceInSceneShowsHudname", { source: r.source, scene: r.scene, hudName: r.output.hudName })}${r.onTop ? "" : t("prod.moveItToTheTop2")}`}
            onDone={() => void g.reload()}
            disabledReason={setupReason ?? (!st ? t("common.loading") : !st.obsConnected ? t("prod.connectObsFirstSettingsDevices") : !st.replayScene ? t("prod.mapTheReplaySceneFirst") : null)}
          >{t("prod.addReplayGraphicToThe")}</ActionButton>
          {st?.replayScene ? <span className="muted small">{t("prod.replaySceneReplayscene", { replayScene: st.replayScene })}</span> : null}
        </div>
        {st?.onAir ? <p className="small">{t("prod.onAirOnair", { onAir: describeClip(st.onAir) })}</p> : null}
        <p className="muted small">{t("prod.a19201080BrowserSource", { v: st?.source ?? "MatchFrame Replay Graphic" })}</p>
      </div>
    </Panel>
  );
}
