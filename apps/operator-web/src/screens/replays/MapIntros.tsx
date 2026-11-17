import { useRef, useState } from "react";
import { api, ApiError, describeError } from "../../api/index.ts";
import type { MapIntroFile, MapIntroSettings, MapIntroSlot, MapIntrosResponse, MapIntroTrigger, ObsAutoResponse } from "../../api/types.ts";
import { ActionButton, Badge, Button, Field, Note, Panel } from "../../components/ui.tsx";
import { useToast } from "../../components/toasts.tsx";
import { useApi } from "../../lib/hooks.ts";
import { MAP_INTRO_KEYS } from "../../lib/replay-keys.ts";
import { usePermission } from "../../state/session.tsx";
import { Hotkeys } from "./AutoReplays.tsx";
import { TransitionSelect } from "./ProductionAutomation.tsx";
import { perLocale, t } from "../../i18n/index.ts";

export const MAP_INTROS_PATH = "/api/v1/map-intros";

/** "Start the intro": each choice and what it means. */
export const TRIGGERS: { id: MapIntroTrigger; label: string; hint: string }[] = perLocale(() => ([
  { id: "manual", label: t("prod.manualOnly"), hint: t("prod.onlyWhenYouPressPlay") },
  { id: "map_load", label: t("prod.whenTheMapLoads"), hint: t("prod.inTheWarmupOfEach") },
  { id: "knife", label: t("prod.knifeRoundStart"), hint: t("prod.inTheFreezeTimeOf4") },
  { id: "pistol", label: t("prod.pistolRoundStart"), hint: t("prod.inTheFreezeTimeOf3") },
  { id: "pistols", label: t("prod.bothPistolRounds"), hint: t("prod.inTheFreezeTimeOf2") },
  { id: "match_live", label: t("prod.whenTheMatchGoesLive"), hint: t("prod.inTheFreezeTimeOf") },
]));
const VMIX_TRANSITIONS = perLocale(() => ([
  { id: "CutDirect", label: t("prod.cut") },
  { id: "Fade", label: t("prod.fade") },
  { id: "Stinger1", label: t("prod.stinger1") },
  { id: "Stinger2", label: t("prod.stinger2") },
] as const));
const ACCEPT = ".mp4,.m4v,.mov,video/mp4,video/quicktime";

/** 8.0 s, or m:ss from a minute. */
export const introLength = (ms: number) => (ms < 60_000 ? `${(Math.round(ms / 100) / 10).toFixed(1)} s` : `${Math.floor(ms / 60000)}:${String(Math.round((ms % 60000) / 1000)).padStart(2, "0")}`);
const mb = (bytes: number) => (bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);
const CODECS: Record<string, string> = { h264: "H.264", hevc: "HEVC", prores: "ProRes", dnxhd: "DNxHD", qtrle: "QuickTime Animation", png: "PNG", vp9: "VP9", av1: "AV1", mpeg4: "MPEG-4" };

/** One line about a kept intro: its length, codec, size and file. */
export function introFacts(it: MapIntroFile): string {
  return [introLength(it.durationMs), CODECS[it.videoCodec] ?? it.videoCodec, it.width && it.height ? `${it.width}×${it.height}` : null, it.fps ? `${Math.round(it.fps * 100) / 100} fps` : null, it.audioCodec ? null : t("prod.noSound"), mb(it.bytes)].filter(Boolean).join(" · ");
}

/**
 * Map intros: one video per map (and a default for maps without one), played on the program by
 * itself at the moment chosen under Start the intro, or by Play map intro in Live Control. Each is
 * checked as it is added (MP4 or MOV that OBS and vMix play, 0.5 s to 2 minutes), shown with its
 * length and a frame from its middle; Replace and Remove.
 */
export function MapIntrosPanel() {
  const intros = useApi<MapIntrosResponse>(MAP_INTROS_PATH, { refreshMs: 2000 });
  const auto = useApi<ObsAutoResponse>("/api/v1/obs/auto", { refreshMs: 5000 });
  const reason = usePermission("replay.control");
  const setupReason = usePermission("settings.manage");
  const programReason = usePermission("program.control");
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const data = intros.data;
  const st = data?.settings;
  const status = data?.status;
  const off = !!reason || busy || !st;
  const save = async (patch: Partial<MapIntroSettings>) => {
    setBusy(true);
    try {
      intros.setData(await api.put<MapIntrosResponse>(`${MAP_INTROS_PATH}/settings`, patch));
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
  const trigger = TRIGGERS.find((tRow) => tRow.id === (st?.trigger ?? "pistol"))!;
  const vmix = data?.setup.mixer === "vmix";
  return (
    <Panel title={t("prod.mapIntros")} subtitle={status?.detail} actions={status ? <Badge tone={status.running ? "accent" : status.state === "waiting" ? "warn" : "ok"}>{status.running ? t("prod.onAir") : status.state === "waiting" ? t("prod.waiting") : st?.trigger === "manual" ? t("prod.manual") : t("prod.ready")}</Badge> : null}>
      <div className="stack-sm">
        <div className="form-grid">
          <Field label={t("prod.startTheIntro")} hint={trigger.hint}>
            <select value={st?.trigger ?? "pistol"} disabled={off} onChange={(e) => void save({ trigger: e.target.value as MapIntroTrigger })}>
              {TRIGGERS.map((tRow) => (
                <option key={tRow.id} value={tRow.id}>
                  {tRow.label}
                </option>
              ))}
            </select>
          </Field>
          <Field
            label={t("prod.ifTheRoundGoesLive")}
            hint={st?.onLive === "finish" ? t("prod.theIntroPlaysToIts") : t("prod.backToTheGameAs")}
          >
            <select value={st?.onLive ?? "cut"} disabled={off} onChange={(e) => void save({ onLive: e.target.value as MapIntroSettings["onLive"] })}>
              <option value="cut">{t("prod.cutBackToTheGame")}</option>
              <option value="finish">{t("prod.finishTheIntroViewersMiss")}</option>
            </select>
          </Field>
        </div>
        <p className="muted small">{t("prod.eachMapSIntroPlays")}</p>
        {status?.auto ? <p className={`small ${status.auto.started ? "muted" : "text-warn"}`}>{status.auto.detail}</p> : null}
        {status?.last?.error ? <p className="small text-warn">{t("prod.lastIntroDisplaynameError", { displayName: status.last.displayName, error: status.last.error })}</p> : null}

        <IntroSlots data={data ?? null} onChange={(r) => intros.setData(r)} disabledReason={setupReason} />
        <Note>{t("prod.mapIntrosStayOnThis")}</Note>
        {data && data.ffmpeg.source === "missing" ? <Note tone="warn">{t("prod.ffmpegChecksEachIntroAs")}</Note> : null}

        <h4 className="hud-section-title">{t("prod.transitions")}</h4>
        {vmix ? (
          <div className="form-grid">
            <Field label={t("prod.mapIntroIn")} hint={t("prod.vmixToTheIntro")}>
              <select value={st?.vmixIn ?? ""} disabled={off} onChange={(e) => void save({ vmixIn: (e.target.value || null) as MapIntroSettings["vmixIn"] })}>
                <option value="">{t("prod.sameAsReplayIn")}</option>
                {VMIX_TRANSITIONS.map((tRow) => (
                  <option key={tRow.id} value={tRow.id}>
                    {tRow.label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={t("prod.mapIntroOut")} hint={t("prod.vmixBackToTheInput")}>
              <select value={st?.vmixOut ?? ""} disabled={off} onChange={(e) => void save({ vmixOut: (e.target.value || null) as MapIntroSettings["vmixOut"] })}>
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
            <TransitionSelect label={t("prod.mapIntroIn")} hint={t("prod.toTheIntroFromThe")} value={auto.data ? (auto.data.settings.introIn ?? null) : null} same="MatchFrame Stinger (when OBS has it)" transitions={auto.data?.transitions ?? null} disabled={!!programReason || !auto.data} onChange={(v) => void saveObs({ introIn: v })} />
            <TransitionSelect label={t("prod.mapIntroOut")} hint={t("prod.backToTheSceneThe")} value={auto.data ? (auto.data.settings.introOut ?? null) : null} same="Same as Map intro in" transitions={auto.data?.transitions ?? null} disabled={!!programReason || !auto.data} onChange={(v) => void saveObs({ introOut: v })} />
          </div>
        )}

        {data && !vmix ? (
          <div className="row" aria-label={t("prod.mapIntroScene")}>
            <ActionButton size="sm" action={() => api.post<{ scene: string; created: boolean }>(`${MAP_INTROS_PATH}/obs-setup`)} success={(r) => `OBS: “${r.scene}” ${r.created ? "made" : t("prod.isReady")}`} onDone={() => void intros.reload()} disabledReason={setupReason ?? (!data.setup.obsConnected ? t("prod.connectObsFirstSettingsDevices") : null)}>{t("prod.setUpObsMapIntro")}</ActionButton>
            <span className="muted small">{data.setup.detail}</span>
          </div>
        ) : data ? (
          <p className="muted small">{data.setup.detail}</p>
        ) : null}
        <p className="muted small">{t("prod.theLiveGameAudioPicked")}</p>

        <Hotkeys keys={MAP_INTRO_KEYS} label={t("prod.mapIntroHotkeys")} devices={t("prod.theDeviceActionsMapIntro")} />
      </div>
    </Panel>
  );
}

/** Every map's slot (and the default): its intro's frame, length and file; Add, Replace, Remove. */
function IntroSlots({ data, onChange, disabledReason }: { data: MapIntrosResponse | null; onChange: (r: MapIntrosResponse) => void; disabledReason: string | null }) {
  const toast = useToast();
  const [checking, setChecking] = useState<MapIntroSlot | null>(null);
  const input = useRef<HTMLInputElement | null>(null);
  const target = useRef<MapIntroSlot | null>(null);
  const onAir = data?.status.playing?.slot ?? null;
  const pick = (slot: MapIntroSlot) => {
    target.current = slot;
    input.current?.click();
  };
  const upload = async (file: File) => {
    const slot = target.current;
    if (!slot || !data) return;
    if (file.size > data.maxBytes) {
      toast.push("danger", t("prod.introNotAdded"), t("prod.nameIsLargerThanRound", { name: file.name, round: Math.round(data.maxBytes / 1024 / 1024) }));
      return;
    }
    setChecking(slot);
    try {
      const r = await api.upload<MapIntrosResponse & { intro: MapIntroFile }>(`${MAP_INTROS_PATH}/${slot}?name=${encodeURIComponent(file.name)}`, file, file.type || "application/octet-stream");
      onChange(r);
      toast.push("ok", t("prod.vIntroAdded", { v: data.slots.find((s) => s.slot === slot)?.label ?? slot }), introFacts(r.intro));
    } catch (e) {
      // A file that can't be an intro (422), or no ffmpeg to check it (409): the engine says why in plain words.
      toast.push("danger", t("prod.introNotAdded"), e instanceof ApiError && (e.status === 422 || e.status === 409) ? e.message : describeError(e));
    } finally {
      setChecking(null);
    }
  };
  const remove = async (slot: MapIntroSlot, label: string) => {
    try {
      onChange(await api.del<MapIntrosResponse>(`${MAP_INTROS_PATH}/${slot}`));
      toast.push("ok", t("prod.labelIntroRemoved", { label }));
    } catch (e) {
      toast.push("danger", t("prod.introNotRemoved"), describeError(e));
    }
  };
  if (!data) return null;
  return (
    <>
      <input
        ref={input}
        type="file"
        accept={ACCEPT}
        hidden
        aria-label={t("prod.introVideoFile")}
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (f) void upload(f);
        }}
      />
      <table className="table table-compact" aria-label={t("prod.mapIntroVideos")}>
        <thead>
          <tr>
            <th>{t("prod.map")}</th>
            <th>{t("prod.intro")}</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {data.slots.map(({ slot, label, intro }) => (
            <tr key={slot}>
              <td>
                <strong>{label}</strong>
                {slot === "default" ? <div className="muted small">{t("prod.mapsWithoutTheirOwn")}</div> : null}
              </td>
              <td>
                {intro ? (
                  <div className="row" style={{ alignItems: "flex-start", gap: 8 }}>
                    {intro.previewUrl ? <img src={intro.previewUrl} alt={t("prod.labelIntroFrame", { label })} width={96} style={{ borderRadius: 4, flex: "none" }} /> : null}
                    <div className="small">
                      <div>{introFacts(intro)}</div>
                      <div className="muted" title={intro.originalName}>
                        {intro.originalName}
                      </div>
                      {intro.notes.map((n) => (
                        <div key={n} className="muted">
                          {n}
                        </div>
                      ))}
                    </div>
                  </div>
                ) : (
                  <span className="muted small">{checking === slot ? t("prod.checking") : slot === "default" ? t("prod.none") : data.slots.some((s) => s.slot === "default" && s.intro) ? t("prod.theDefaultPlays") : t("prod.none")}</span>
                )}
              </td>
              <td>
                <div className="row" style={{ justifyContent: "flex-end" }}>
                  <Button size="sm" disabledReason={disabledReason ?? (checking ? t("prod.checkingAFile") : onAir === slot ? t("prod.itIsOnAir") : null)} onClick={() => pick(slot)}>
                    {checking === slot ? t("prod.checking") : intro ? t("prod.replace") : t("prod.add")}
                  </Button>
                  {intro ? (
                    <Button size="sm" variant="ghost" disabledReason={disabledReason ?? (onAir === slot ? t("prod.itIsOnAir") : null)} onClick={() => void remove(slot, label)}>{t("prod.remove")}</Button>
                  ) : null}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="muted small">{t("prod.mp4OrMovH264")}</p>
    </>
  );
}
