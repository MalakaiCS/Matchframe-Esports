import { useEffect, useState } from "react";
import type { HudLibrary } from "@matchframe/contracts";
import { api, describeError, seg } from "../../api/index.ts";
import type { GraphicsSettings, ObsAutoResponse, ObsState } from "../../api/types.ts";
import { ActionButton, Checkbox, Field, Note, Panel } from "../../components/ui.tsx";
import { useToast } from "../../components/toasts.tsx";
import { useApi } from "../../lib/hooks.ts";
import { usePermission } from "../../state/session.tsx";
import { perLocale, t } from "../../i18n/index.ts";

type SceneMap = ObsAutoResponse["scenes"];
const MODES: { key: keyof SceneMap; label: string; hint: string }[] = perLocale(() => ([
  { key: "LIVE", label: t("prod.liveScene"), hint: t("prod.theGameWithTheHud") },
  { key: "REPLAY", label: t("prod.replayScene"), hint: t("prod.playsReplaysSetUpObs") },
  { key: "BREAK", label: t("prod.breakScene"), hint: t("prod.tacticalTimeoutsAndTechnicalPauses") },
  { key: "STUDIO", label: t("prod.studioScene"), hint: t("prod.afterAMapEnds") },
]));

function SceneSelect({ value, scenes, onChange, label, hint, disabled }: { value: string | null; scenes: string[]; onChange: (v: string | null) => void; label: string; hint?: string; disabled: boolean }) {
  const options = value && !scenes.includes(value) ? [value, ...scenes] : scenes;
  return (
    <Field label={label} hint={hint}>
      <select value={value ?? ""} onChange={(e) => onChange(e.target.value || null)} disabled={disabled}>
        <option value="">{t("prod.notUsed")}</option>
        {options.map((s) => (
          <option key={s} value={s}>
            {s}
          </option>
        ))}
      </select>
    </Field>
  );
}

/** OBS's transition kinds, as OBS names them in English (a transition's own name can be anything). */
/** OBS transition types, by the names OBS gives them. */
const KIND_LABEL: Record<string, string> = { obs_stinger_transition: "Stinger", fade_transition: "Fade", cut_transition: "Cut", swipe_transition: "Swipe", slide_transition: "Slide", fade_to_color_transition: "Fade to Color", wipe_transition: "Luma Wipe" };
/** In a select: Replay out the same as Replay in. */
const SAME = "__same_as_replay_in__";

/** One of OBS's transitions, OBS's own (""), or, with `same`, the same as another one (null: Replay in, or `same` names it). */
export function TransitionSelect({ label, hint, value, transitions, same, disabled, onChange }: { label: string; hint: string; value: string | null; transitions: ObsAutoResponse["transitions"]; same?: boolean | string; disabled: boolean; onChange: (v: string | null) => void }) {
  const names = transitions?.names ?? [];
  const kindOf = new Map((transitions?.kinds ?? []).map((k) => [k.name, k.kind]));
  const missing = value && !names.includes(value) ? value : null;
  return (
    <Field label={label} hint={hint}>
      <select value={value === null ? SAME : value} disabled={disabled} onChange={(e) => onChange(e.target.value === SAME ? null : e.target.value)}>
        {same ? <option value={SAME}>{typeof same === "string" ? same : t("prod.sameAsReplayIn")}</option> : null}
        <option value="">{t("prod.obsSCurrentTransition")}</option>
        {names.map((n) => {
          const kind = KIND_LABEL[kindOf.get(n) ?? ""];
          return (
            <option key={n} value={n}>
              {kind && kind !== n ? `${n} (${kind})` : n}
            </option>
          );
        })}
        {missing ? <option value={missing}>{transitions ? t("prod.missingNotInObs", { missing }) : missing}</option> : null}
      </select>
    </Field>
  );
}

/** OBS scenes per program mode, and what switches them by itself. */
export function ObsAutomationPanel() {
  const auto = useApi<ObsAutoResponse>("/api/v1/obs/auto", { refreshMs: 5000 });
  const obs = useApi<{ state: ObsState }>("/api/v1/obs", { refreshMs: 5000 });
  const reason = usePermission("program.control");
  const settingsReason = usePermission("settings.manage");
  const toast = useToast();
  const [scenes, setScenes] = useState<SceneMap | null>(null);
  useEffect(() => {
    if (auto.data && !scenes) setScenes(auto.data.scenes);
  }, [auto.data]);
  const connected = obs.data?.state.connected ?? false;
  const list = obs.data?.state.scenes ?? [];
  const st = auto.data?.settings;
  const save = async (patch: Partial<ObsAutoResponse["settings"]>) => {
    try {
      await api.put("/api/v1/obs/auto", patch);
      void auto.reload();
    } catch (e) {
      toast.push("danger", t("prod.settingNotSaved"), describeError(e));
    }
  };
  return (
    <Panel title={t("prod.obsScenes")} subtitle={t("prod.whichObsSceneIsOn")}>
      <div className="stack-sm">
        {!connected ? <Note tone="warn">{t("prod.connectObsInSettingsDevices2")}</Note> : null}
        <div className="form-grid">
          {MODES.map((m) => (
            <SceneSelect key={m.key} label={m.label} hint={m.hint} scenes={list} value={scenes?.[m.key] ?? null} disabled={!!settingsReason || !scenes} onChange={(v) => setScenes((cur) => (cur ? { ...cur, [m.key]: v } : cur))} />
          ))}
        </div>
        <div className="row">
          <ActionButton action={() => api.put("/api/v1/settings/program.scenes", { value: scenes })} success={t("prod.scenesSaved")} onDone={() => void auto.reload()} disabledReason={settingsReason ?? (!scenes ? t("common.loading") : null)}>{t("prod.saveScenes")}</ActionButton>
        </div>
        <Checkbox checked={st?.timeouts ?? true} disabled={!!reason || !st} label={t("prod.timeoutsAndPausesBreakScene")} hint={t("prod.onATacticalTimeoutOr")} onChange={(v) => void save({ timeouts: v })} />
        <Checkbox checked={st?.mapEnd ?? true} disabled={!!reason || !st} label={t("prod.mapEndStudioScene")} hint={t("prod.whenAMapEndsThen")} onChange={(v) => void save({ mapEnd: v })} />
        <h4 className="hud-section-title">{t("prod.transitions")}</h4>
        <div className="form-grid">
          <TransitionSelect label={t("prod.replayIn")} hint={t("prod.fromTheLiveSceneTo")} value={st?.replayIn ?? ""} transitions={auto.data?.transitions ?? null} disabled={!!reason || !st} onChange={(v) => void save({ replayIn: v ?? "" })} />
          <TransitionSelect label={t("prod.replayOut")} hint={t("prod.fromAReplayBackTo")} value={st ? st.replayOut : null} same transitions={auto.data?.transitions ?? null} disabled={!!reason || !st} onChange={(v) => void save({ replayOut: v })} />
          <TransitionSelect label={t("prod.otherScenes")} hint={t("prod.toAndFromTheBreak")} value={st?.otherScenes ?? ""} transitions={auto.data?.transitions ?? null} disabled={!!reason || !st} onChange={(v) => void save({ otherScenes: v ?? "" })} />
          <HighlightTransitions settings={st ?? null} transitions={auto.data?.transitions ?? null} disabled={!!reason || !st} save={save} />
        </div>
        {scenes?.HIGHLIGHTS !== undefined ? <p className="muted small">{t("prod.highlightsSceneVSetIt", { v: scenes.HIGHLIGHTS ?? t("prod.notSetUp") })}</p> : null}
        <p className="muted small">{t("prod.aStingerHasToBe")}</p>
        <p className="muted small">{t("prod.scenesOnlyChangeFromThe")}</p>
      </div>
    </Panel>
  );
}

/** Highlights in and Highlights out (ADR-063): the same as Replay in and Replay out until chosen. */
export function HighlightTransitions({ settings, transitions, disabled, save }: { settings: ObsAutoResponse["settings"] | null; transitions: ObsAutoResponse["transitions"]; disabled: boolean; save: (patch: Partial<ObsAutoResponse["settings"]>) => Promise<void> }) {
  return (
    <>
      <TransitionSelect label={t("prod.highlightsIn")} hint={t("prod.toHighlightsOnAirFrom")} value={settings ? (settings.highlightsIn ?? null) : null} same="Same as Replay in" transitions={transitions} disabled={disabled} onChange={(v) => void save({ highlightsIn: v })} />
      <TransitionSelect label={t("prod.highlightsOut")} hint={t("prod.fromHighlightsBackToThe")} value={settings ? (settings.highlightsOut ?? null) : null} same="Same as Replay out" transitions={transitions} disabled={disabled} onChange={(v) => void save({ highlightsOut: v })} />
    </>
  );
}

/** HUD graphics timed to the shots, and an imported HUD's pages in OBS. */
export function GraphicsPanel() {
  const g = useApi<GraphicsSettings>("/api/v1/graphics/auto");
  const lib = useApi<HudLibrary>("/api/v1/hud/library");
  const obs = useApi<{ state: ObsState }>("/api/v1/obs", { refreshMs: 5000 });
  const reason = usePermission("hud.publish");
  const toast = useToast();
  const st = g.data;
  const pages = st?.pages ?? { hudId: "", scene: "", playerSource: "", matchSource: "" };
  const items = useApi<{ sourceName: string }[]>(pages.scene ? `/api/v1/obs/scenes/${seg(pages.scene)}/items` : null);
  const save = async (patch: Partial<Omit<GraphicsSettings, "pages">> & { pages?: Partial<GraphicsSettings["pages"]> }) => {
    try {
      g.setData(await api.put<GraphicsSettings>("/api/v1/graphics/auto", patch));
    } catch (e) {
      toast.push("danger", t("prod.settingNotSaved"), describeError(e));
    }
  };
  const imported = (lib.data?.huds ?? []).filter((h) => h.views.length > 0);
  const sources = (items.data ?? []).map((i) => i.sourceName);
  const off = !!reason || !st;
  return (
    <Panel title={t("prod.hudGraphics")} subtitle={t("prod.shownByThemselvesWhileThe")}>
      <div className="stack-sm">
        <Checkbox checked={st?.enabled ?? true} disabled={off} label={t("prod.timeGraphicsToTheShots")} onChange={(v) => void save({ enabled: v })} />
        <div className="form-grid">
          <Checkbox checked={st?.economy ?? true} disabled={off || !st?.enabled} label={t("prod.economyInFreezeTime")} onChange={(v) => void save({ economy: v })} />
          <Checkbox checked={st?.mvp ?? true} disabled={off || !st?.enabled} label={t("prod.roundMvpInFreezeTime")} onChange={(v) => void save({ mvp: v })} />
          <Checkbox checked={st?.playerCards ?? true} disabled={off || !st?.enabled} label={t("prod.playerCardOnALong")} hint={t("prod.onlyOnAPlayerView")} onChange={(v) => void save({ playerCards: v })} />
          <Checkbox checked={st?.clutch ?? true} disabled={off || !st?.enabled} label={t("prod.clutchBanner1v2AndMore")} onChange={(v) => void save({ clutch: v })} />
          <Checkbox checked={st?.buyType ?? true} disabled={off || !st?.enabled} label={t("prod.buyTypeInFreezeTime")} hint={t("prod.dataForHudsThatShow")} onChange={(v) => void save({ buyType: v })} />
        </div>
        <p className="muted small">{t("prod.matchframeHudsDrawTheseImported")}</p>
        <h4 className="hud-section-title">{t("prod.importedHudPagesInObs")}</h4>
        <p className="muted small">{t("prod.addTheHudSPlayer")}</p>
        <div className="form-grid">
          <Field label="HUD">
            <select value={pages.hudId} disabled={off} onChange={(e) => void save({ pages: { hudId: e.target.value } })}>
              <option value="">{t("prod.none")}</option>
              {imported.map((h) => (
                <option key={h.id} value={h.id}>
                  {h.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t("prod.obsSceneWithThePages")}>
            <select value={pages.scene} disabled={off} onChange={(e) => void save({ pages: { scene: e.target.value, playerSource: "", matchSource: "" } })}>
              <option value="">{t("prod.none")}</option>
              {(obs.data?.state.scenes ?? (pages.scene ? [pages.scene] : [])).map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t("prod.playerStatsSource")}>
            <select value={pages.playerSource} disabled={off || !pages.scene} onChange={(e) => void save({ pages: { playerSource: e.target.value } })}>
              <option value="">{t("prod.none")}</option>
              {(pages.playerSource && !sources.includes(pages.playerSource) ? [pages.playerSource, ...sources] : sources).map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t("prod.matchStatsSource")}>
            <select value={pages.matchSource} disabled={off || !pages.scene} onChange={(e) => void save({ pages: { matchSource: e.target.value } })}>
              <option value="">{t("prod.none")}</option>
              {(pages.matchSource && !sources.includes(pages.matchSource) ? [pages.matchSource, ...sources] : sources).map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </Field>
        </div>
      </div>
    </Panel>
  );
}
