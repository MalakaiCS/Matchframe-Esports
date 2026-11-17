import { useEffect, useState } from "react";
import { api, describeError, seg } from "../../api/index.ts";
import type { HighlightsAirResponse, HighlightsAirSettings, ObsAutoResponse, ObsState } from "../../api/types.ts";
import { ActionButton, Badge, Button, Checkbox, Details, Field, Note, Panel } from "../../components/ui.tsx";
import { useToast } from "../../components/toasts.tsx";
import { fmtMs } from "../../lib/format.ts";
import { useApi } from "../../lib/hooks.ts";
import { HIGHLIGHT_KEYS, shortcutLabel } from "../../lib/replay-keys.ts";
import { usePermission } from "../../state/session.tsx";
import { Hotkeys } from "./AutoReplays.tsx";
import { HighlightTransitions } from "./ProductionAutomation.tsx";
import { perLocale, t } from "../../i18n/index.ts";

const COUNTS = [5, 8, 10, 15, "all"] as const;
const WHAT: { id: HighlightsAirSettings["what"]; label: string }[] = perLocale(() => ([
  { id: "map", label: t("prod.thisMap") },
  { id: "half", label: t("prod.theLastHalfOfThis") },
  { id: "previous", label: t("prod.thePreviousMap") },
]));
const VMIX_TRANSITIONS = perLocale(() => ([
  { id: "CutDirect", label: t("prod.cut") },
  { id: "Fade", label: t("prod.fade") },
  { id: "Stinger1", label: t("prod.stinger1") },
  { id: "Stinger2", label: t("prod.stinger2") },
] as const));
/** What the Play button says when it is halftime and highlights are off then. */

/** m:ss. */
const len = (ms: number) => `${Math.floor(ms / 60000)}:${String(Math.round((ms % 60000) / 1000)).padStart(2, "0")}`;

/**
 * Highlights on air: a map's best clips on the program when you press Play, back to back on the
 * highlights scene (fading from one to the next, with the replay graphic and the live audio turned
 * down), then back to the scene the program came from: your analysis scene, the live scene, the
 * studio or break scene. Skip, Hold and Stop as for replays.
 */
export function HighlightsOnAirPanel() {
  const air = useApi<HighlightsAirResponse>("/api/v1/highlights/air", { refreshMs: 1000 });
  const auto = useApi<ObsAutoResponse>("/api/v1/obs/auto", { refreshMs: 5000 });
  const reason = usePermission("replay.control");
  const programReason = usePermission("program.control");
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const data = air.data;
  const st = data?.settings;
  const status = data?.status;
  const setup = data?.setup;
  const off = !!reason || busy || !st;
  const save = async (patch: Partial<HighlightsAirSettings>) => {
    setBusy(true);
    try {
      air.setData(await api.put<HighlightsAirResponse>("/api/v1/highlights/air", patch));
    } catch (e) {
      toast.push("danger", t("prod.settingNotSaved"), describeError(e));
    } finally {
      setBusy(false);
    }
  };
  const saveObs = async (patch: Partial<ObsAutoResponse["settings"]>) => {
    try {
      await api.put("/api/v1/obs/auto", patch);
      void auto.reload();
    } catch (e) {
      toast.push("danger", t("prod.settingNotSaved"), describeError(e));
    }
  };
  const control = async (path: string, body?: unknown) => {
    try {
      await api.post(path, body);
      void air.reload();
    } catch (e) {
      toast.push("warn", t("prod.highlights"), describeError(e));
    }
  };
  const halftimeOff = !!st?.noHalftime && !!status?.halftime;
  const playReason = reason ?? (!status ? t("common.loading") : status.running ? t("prod.highlightsAreOnAir") : halftimeOff ? t("prod.highlightsAtHalftimeAreOff") : status.blocked);
  const plan = status?.plan ?? null;
  const vmix = setup?.mixer === "vmix";
  return (
    <Panel title={t("prod.highlightsOnAir")} subtitle={status?.detail} actions={status ? <Badge tone={status.running ? "accent" : status.blocked ? "neutral" : "ok"}>{status.running ? (status.held ? t("prod.held") : t("prod.onAir")) : status.blocked ? t("prod.notNow") : t("prod.ready")}</Badge> : null}>
      <div className="stack-sm">
        <div className="row" role="group" aria-label={t("prod.highlightsControls")}>
          {status?.running ? (
            <>
              <Button variant="primary" disabledReason={reason} title={t("prod.endsTheHighlightOnAir", { shortcutLabel: shortcutLabel("F5") })} onClick={() => void control("/api/v1/replays/auto/skip")}>{t("prod.skip")}</Button>
              <Button variant={status.held ? "primary" : "secondary"} disabledReason={reason} title={`${status.held ? t("prod.playsItOn") : t("prod.pausesTheHighlightOnAir")} (${shortcutLabel("F6")})`} onClick={() => void control("/api/v1/replays/auto/hold", { held: !status.held })}>
                {status.held ? t("prod.resume") : t("prod.hold")}
              </Button>
              <Button variant="danger" disabledReason={reason} title={t("prod.backToTheSceneThe2", { shortcutLabel: shortcutLabel("F10") })} onClick={() => void control("/api/v1/highlights/air/stop")}>{t("prod.stop")}</Button>
              {status.position ? <span className="small">{t("prod.highlightNOfOf", { n: status.position.n, of: status.position.of })}</span> : null}
            </>
          ) : (
            <ActionButton
              variant="primary"
              action={() => api.post<HighlightsAirResponse>("/api/v1/highlights/air/play")}
              success={(r) => (r.status.running ? t("prod.highlightsOnAir") : null)}
              onDone={(r) => air.setData(r)}
              disabledReason={playReason}
              reasonPlacement={halftimeOff ? "inline" : "tooltip"}
              title={t("prod.playsTheClipsBelowOn", { shortcutLabel: shortcutLabel("F9") })}
            >{t("prod.playHighlights")}</ActionButton>
          )}
        </div>
        {status?.blocked && !status.running && !halftimeOff ? <span className="small muted">{status.blocked}</span> : null}

        <Checkbox checked={st?.noHalftime ?? true} disabled={off} label={t("prod.donTShowHighlightsAt")} hint={t("prod.onNoHighlightsStartAt")} onChange={(v) => void save({ noHalftime: v })} />
        {st && !st.noHalftime ? <Checkbox checked={st.autoHalftime} disabled={off} label={t("prod.startByThemselvesAtHalftime")} hint={t("prod.onceTheRoundSReplays")} onChange={(v) => void save({ autoHalftime: v })} /> : null}
        <Checkbox checked={st?.autoMapEnd ?? false} disabled={off} label={t("prod.startByThemselvesWhenA")} hint={t("prod.onceTheLastRoundS")} onChange={(v) => void save({ autoMapEnd: v })} />

        <div className="form-grid">
          <Field label={t("prod.what")}>
            <select value={st?.what ?? "map"} disabled={off} onChange={(e) => void save({ what: e.target.value as HighlightsAirSettings["what"] })}>
              {WHAT.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t("prod.howMany")} hint={t("prod.bestByTheSameScore")}>
            <select value={String(st?.count ?? 5)} disabled={off} onChange={(e) => void save({ count: e.target.value === "all" ? "all" : Number(e.target.value) })}>
              {[...COUNTS, ...(st && st.count !== "all" && !(COUNTS as readonly (number | string)[]).includes(st.count) ? [st.count] : [])].map((c) => (
                <option key={String(c)} value={String(c)}>
                  {c === "all" ? t("prod.allPlayedClips") : t("prod.theBestCV", { c, v: c === 5 ? t("replays.recommendedSuffix") : "" })}
                </option>
              ))}
            </select>
          </Field>
        </div>
        {st?.count !== "all" ? <Checkbox checked={st?.unplayed ?? false} disabled={off} label={t("prod.alsoClipsThatWerenT")} hint={t("prod.theBestOfTheMap")} onChange={(v) => void save({ unplayed: v })} /> : null}
        <Checkbox checked={st?.slowMotion ?? false} disabled={off} label={t("prod.slowMotion2")} hint={t("prod.eachHighlightSlowedAsAutomatic")} onChange={(v) => void save({ slowMotion: v })} />

        {plan && plan.clips.length ? (
          <div className="stack-sm" aria-label={t("prod.highlightsThatWillPlay")}>
            <span className="small muted">
              {`${t("prod.clipCount", { count: plan.clips.length })}, ${len(plan.totalMs)}`}
              {plan.rounds ? t("prod.roundsFromTo", { from: plan.rounds.from, to: plan.rounds.to }) : ""}
              {plan.title ? ` · ${plan.title}` : ""}
            </span>
            <ol className="small" style={{ margin: 0, paddingLeft: 20 }}>
              {plan.clips.map((c) => (
                <li key={c.id}>
                  R{c.roundNumber ?? "?"} · {c.label} · {fmtMs(c.onAirMs ?? c.playMs)}
                  {c.slow ? t("prod.slowMotion") : ""}
                  {c.played || c.angle ? "" : t("prod.notPlayed")}
                  {status?.playing?.id === c.id ? <strong>{t("prod.onAir2")}</strong> : null}
                </li>
              ))}
            </ol>
          </div>
        ) : plan ? (
          <p className="muted small">{st?.count === "all" ? t("prod.noClipOfItHas") : t("prod.noClipsKeptForIt")}</p>
        ) : null}
        {status?.auto ? <p className={`small ${status.auto.started ? "muted" : "text-warn"}`}>{status.auto.detail}</p> : null}

        <HighlightsScene data={data ?? null} onDone={(r) => air.setData(r)} reload={() => void air.reload()} />

        <h4 className="hud-section-title">{t("prod.transitions")}</h4>
        {vmix ? (
          <div className="form-grid">
            <Field label={t("prod.highlightsIn")} hint={t("prod.vmixToTheFirstHighlight")}>
              <select value={st?.vmixIn ?? ""} disabled={off} onChange={(e) => void save({ vmixIn: (e.target.value || null) as HighlightsAirSettings["vmixIn"] })}>
                <option value="">{t("prod.sameAsReplayIn")}</option>
                {VMIX_TRANSITIONS.map((tRow) => (
                  <option key={tRow.id} value={tRow.id}>
                    {tRow.label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={t("prod.highlightsOut")} hint={t("prod.vmixBackToTheInput")}>
              <select value={st?.vmixOut ?? ""} disabled={off} onChange={(e) => void save({ vmixOut: (e.target.value || null) as HighlightsAirSettings["vmixOut"] })}>
                <option value="">{t("prod.sameAsReplayOut")}</option>
                {VMIX_TRANSITIONS.map((tRow) => (
                  <option key={tRow.id} value={tRow.id}>
                    {tRow.label}
                  </option>
                ))}
              </select>
            </Field>
          </div>
        ) : (
          <div className="form-grid">
            <HighlightTransitions settings={auto.data?.settings ?? null} transitions={auto.data?.transitions ?? null} disabled={!!programReason || !auto.data} save={saveObs} />
          </div>
        )}
        <p className="muted small">{t("prod.betweenHighlightsTheFadeOr")}</p>

        <Hotkeys keys={HIGHLIGHT_KEYS} label={t("prod.highlightsHotkeys")} devices={t("prod.theDeviceActionsHighlightsPlay", { shortcutLabel: shortcutLabel("F5"), shortcutLabel2: shortcutLabel("F6") })} />
        <p className="muted small">{t("prod.notWhileARoundIs")}</p>
      </div>
    </Panel>
  );
}

/** The highlights scene: one click to make MatchFrame's, or your own scene and its media source; what's ready. */
function HighlightsScene({ data, onDone, reload }: { data: HighlightsAirResponse | null; onDone: (r: HighlightsAirResponse) => void; reload: () => void }) {
  const setupReason = usePermission("settings.manage");
  const obs = useApi<{ state: ObsState }>("/api/v1/obs", { refreshMs: 5000 });
  const toast = useToast();
  const setup = data?.setup ?? null;
  const [scene, setScene] = useState<string>("");
  const [input, setInput] = useState<string>("");
  useEffect(() => {
    if (setup) {
      setScene(setup.scene ?? "");
      setInput(setup.input ?? "");
    }
  }, [setup?.scene, setup?.input]);
  const items = useApi<{ sourceName: string; inputKind: string | null }[]>(scene && obs.data?.state.connected ? `/api/v1/obs/scenes/${seg(scene)}/items` : null);
  if (setup?.mixer === "vmix") return <p className="muted small">{t("prod.highlightsPlayInVmixAs")}</p>;
  const connected = obs.data?.state.connected ?? setup?.obsConnected ?? false;
  const scenes = obs.data?.state.scenes ?? [];
  const media = (items.data ?? []).filter((i) => i.inputKind === "ffmpeg_source" || i.sourceName === input);
  const mapOwn = async () => {
    try {
      const r = await api.put<HighlightsAirResponse>("/api/v1/highlights/air/scene", { scene: scene || null, input: scene ? input || null : null });
      onDone(r);
      toast.push("ok", scene ? t("prod.highlightsPlayInScene", { scene }) : t("prod.noHighlightsScene"));
    } catch (e) {
      toast.push("danger", t("prod.sceneNotSaved"), describeError(e));
    }
  };
  const twin = setup?.twin;
  const graphic = setup?.graphic;
  return (
    <div className="stack-sm" aria-label={t("prod.highlightsScene")}>
      <h4 className="hud-section-title">{t("prod.highlightsScene")}</h4>
      {!connected ? <Note tone="warn">{t("prod.connectObsInSettingsDevices")}</Note> : null}
      <div className="row">
        <ActionButton
          action={() => api.post<{ scene: string; input: string; graphicError: string | null }>("/api/v1/highlights/air/obs-setup")}
          success={(r) => t("prod.obsSceneSceneWithThe", { scene: r.scene, input: r.input, v: r.graphicError ? t("prod.replayGraphicGraphicerror", { graphicError: r.graphicError }) : t("prod.withTheReplayGraphicOn") })}
          onDone={reload}
          disabledReason={setupReason ?? (!connected ? t("prod.connectObsFirstSettingsDevices") : null)}
        >{t("prod.setUpObsHighlightsScene")}</ActionButton>
        <span className="muted small">{t("prod.addsAMatchframeHighlightsScene")}</span>
      </div>
      <Details summary={t("prod.orUseYourOwnScene")}>
        <div className="form-grid">
          <Field label={t("prod.yourHighlightsScene")} hint={t("prod.anObsSceneWithA")}>
            <select value={scene} disabled={!!setupReason || !connected} onChange={(e) => (setScene(e.target.value), setInput(""))}>
              <option value="">{t("prod.none")}</option>
              {(scene && !scenes.includes(scene) ? [scene, ...scenes] : scenes).map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t("prod.itsMediaSource")} hint={t("prod.theMediaSourceTheHighlights")}>
            <select value={input} disabled={!!setupReason || !connected || !scene} onChange={(e) => setInput(e.target.value)}>
              <option value="">{t("prod.choose")}</option>
              {(input && !media.some((m) => m.sourceName === input) ? [{ sourceName: input, inputKind: null }, ...media] : media).map((m) => (
                <option key={m.sourceName} value={m.sourceName}>
                  {m.sourceName}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <div className="row">
          <Button size="sm" disabledReason={setupReason ?? (scene && !input ? t("prod.chooseItsMediaSource") : null)} onClick={() => void mapOwn()}>{t("prod.useThisScene")}</Button>
          <ActionButton size="sm" variant="ghost" action={() => api.post("/api/v1/highlights/air/graphic")} success={t("prod.replayGraphicOnTopOf")} onDone={reload} disabledReason={setupReason ?? (!setup?.scene ? t("prod.chooseTheSceneFirst") : !connected ? t("prod.connectObsFirst") : null)}>{t("prod.addTheReplayGraphic")}</ActionButton>
        </div>
      </Details>
      {setup ? (
        <ul className="small" aria-label={t("prod.highlightsSceneStatus")} style={{ margin: 0, paddingLeft: 18 }}>
          <li>
            <Badge tone={setup.sceneReady ? "ok" : "neutral"}>{setup.sceneReady ? t("prod.sceneReady") : t("prod.sceneNotReady")}</Badge> {setup.scene ? t("prod.sceneWithV", { scene: setup.scene, v: setup.input ?? "?" }) : t("prod.noneYet")}
          </li>
          <li>
            <Badge tone={twin?.ready ? "ok" : "neutral"}>{twin?.ready ? t("prod.twinReady") : t("prod.noTwinYet")}</Badge> {twin ? (twin.ready ? t("prod.fadesThroughSceneVLeave", { scene: twin.scene, v: setup.sameAsReplay ? t("prod.theReplaySceneS") : "" }) : twin.detail) : t("prod.madeWithTheScene")}
          </li>
          <li>
            <Badge tone={graphic?.onTop ? "ok" : "neutral"}>{graphic?.onTop ? t("prod.graphicOnTop") : graphic?.inScene ? t("prod.graphicNotOnTop") : t("prod.noGraphic")}</Badge> {graphic ? (graphic.inScene ? (graphic.onTop ? t("prod.sourceOverTheClips", { source: graphic.source }) : t("prod.moveItToTheTop")) : t("prod.pressAddTheReplayGraphic")) : ""}
          </li>
        </ul>
      ) : null}
      {setup?.detail ? <span className="small muted">{setup.detail}</span> : null}
    </div>
  );
}
