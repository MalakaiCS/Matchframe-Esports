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

export const MAP_INTROS_PATH = "/api/v1/map-intros";

/** "Start the intro": each choice and what it means. */
export const TRIGGERS: { id: MapIntroTrigger; label: string; hint: string }[] = [
  { id: "manual", label: "Manual only", hint: "Only when you press Play map intro (Live Control, the hotkey or the Stream Deck)." },
  { id: "map_load", label: "When the map loads", hint: "In the warmup of each new map, as soon as the game data shows it (a server without a warmup: the first round's freeze time)." },
  { id: "knife", label: "Knife round start", hint: "In the freeze time of a knife round (round 1 at 0–0 with knives only). A map without a knife round gets no intro by itself: choose When the match goes live to cover both." },
  { id: "pistol", label: "Pistol round start", hint: "In the freeze time of the first round that isn't a knife round: after the knife round, when there is one." },
  { id: "pistols", label: "Both pistol rounds", hint: "In the freeze time of round 1 and of the second half's first round (13 in MR12, from the active match's format)." },
  { id: "match_live", label: "When the match goes live", hint: "In the freeze time of the first round after the warmup, knife round or not." },
];
const VMIX_TRANSITIONS = [
  { id: "CutDirect", label: "Cut" },
  { id: "Fade", label: "Fade" },
  { id: "Stinger1", label: "Stinger 1" },
  { id: "Stinger2", label: "Stinger 2" },
] as const;
const ACCEPT = ".mp4,.m4v,.mov,video/mp4,video/quicktime";

/** 8.0 s, or m:ss from a minute. */
export const introLength = (ms: number) => (ms < 60_000 ? `${(Math.round(ms / 100) / 10).toFixed(1)} s` : `${Math.floor(ms / 60000)}:${String(Math.round((ms % 60000) / 1000)).padStart(2, "0")}`);
const mb = (bytes: number) => (bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);
const CODECS: Record<string, string> = { h264: "H.264", hevc: "HEVC", prores: "ProRes", dnxhd: "DNxHD", qtrle: "QuickTime Animation", png: "PNG", vp9: "VP9", av1: "AV1", mpeg4: "MPEG-4" };

/** One line about a kept intro: its length, codec, size and file. */
export function introFacts(it: MapIntroFile): string {
  return [introLength(it.durationMs), CODECS[it.videoCodec] ?? it.videoCodec, it.width && it.height ? `${it.width}×${it.height}` : null, it.fps ? `${Math.round(it.fps * 100) / 100} fps` : null, it.audioCodec ? null : "no sound", mb(it.bytes)].filter(Boolean).join(" · ");
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
      toast.push("danger", "Setting not saved", describeError(e));
    } finally {
      setBusy(false);
    }
  };
  const saveObs = async (patch: Partial<ObsAutoResponse["settings"]>) => {
    try {
      await api.put("/api/v1/obs/auto", patch);
      void auto.reload();
    } catch (e) {
      toast.push("danger", "Setting not saved", describeError(e));
    }
  };
  const trigger = TRIGGERS.find((t) => t.id === (st?.trigger ?? "pistol"))!;
  const vmix = data?.setup.mixer === "vmix";
  return (
    <Panel title="Map intros" subtitle={status?.detail} actions={status ? <Badge tone={status.running ? "accent" : status.state === "waiting" ? "warn" : "ok"}>{status.running ? "On air" : status.state === "waiting" ? "Waiting" : st?.trigger === "manual" ? "Manual" : "Ready"}</Badge> : null}>
      <div className="stack-sm">
        <div className="form-grid">
          <Field label="Start the intro" hint={trigger.hint}>
            <select value={st?.trigger ?? "pistol"} disabled={off} onChange={(e) => void save({ trigger: e.target.value as MapIntroTrigger })}>
              {TRIGGERS.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.label}
                </option>
              ))}
            </select>
          </Field>
          <Field
            label="If the round goes live during the intro"
            hint={st?.onLive === "finish" ? "The intro plays to its end, then the live scene: viewers miss the start of the round." : "Back to the game as the freeze time ends (the cut starts a second before, so the game is on screen as the round goes live). An intro doesn't start with under 3 s of freeze time left."}
          >
            <select value={st?.onLive ?? "cut"} disabled={off} onChange={(e) => void save({ onLive: e.target.value as MapIntroSettings["onLive"] })}>
              <option value="cut">Cut back to the game (recommended)</option>
              <option value="finish">Finish the intro (viewers miss the start of the round)</option>
            </select>
          </Field>
        </div>
        <p className="muted small">Each map's intro plays by itself once per map in a match (Both pistol rounds: once per half), never during a live round; Play map intro plays it again. If the replays or highlights are on air at that moment it waits for them, until the round goes live. It never starts by itself over your own scene in OBS.</p>
        {status?.auto ? <p className={`small ${status.auto.started ? "muted" : "text-warn"}`}>{status.auto.detail}</p> : null}
        {status?.last?.error ? <p className="small text-warn">{`Last intro (${status.last.displayName}): ${status.last.error}`}</p> : null}

        <IntroSlots data={data ?? null} onChange={(r) => intros.setData(r)} disabledReason={setupReason} />
        <Note>Map intros stay on this computer: account sync doesn't share them (video files are large). Add them on each computer that plays intros.</Note>
        {data && data.ffmpeg.source === "missing" ? <Note tone="warn">ffmpeg checks each intro as it is added: download it under Replay PC → Replay feed (NDI) (Windows), or install it.</Note> : null}

        <h4 className="hud-section-title">Transitions</h4>
        {vmix ? (
          <div className="form-grid">
            <Field label="Map intro in" hint="vMix: to the intro.">
              <select value={st?.vmixIn ?? ""} disabled={off} onChange={(e) => void save({ vmixIn: (e.target.value || null) as MapIntroSettings["vmixIn"] })}>
                <option value="">Same as Replay in</option>
                {VMIX_TRANSITIONS.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Map intro out" hint="vMix: back to the input that was on air before.">
              <select value={st?.vmixOut ?? ""} disabled={off} onChange={(e) => void save({ vmixOut: (e.target.value || null) as MapIntroSettings["vmixOut"] })}>
                <option value="">Same as Replay out</option>
                {VMIX_TRANSITIONS.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.label}
                  </option>
                ))}
              </select>
            </Field>
          </div>
        ) : (
          <div className="form-grid">
            <TransitionSelect label="Map intro in" hint="To the intro, from the scene the program is on." value={auto.data ? (auto.data.settings.introIn ?? null) : null} same="MatchFrame Stinger (when OBS has it)" transitions={auto.data?.transitions ?? null} disabled={!!programReason || !auto.data} onChange={(v) => void saveObs({ introIn: v })} />
            <TransitionSelect label="Map intro out" hint="Back to the scene the program came from (or to live)." value={auto.data ? (auto.data.settings.introOut ?? null) : null} same="Same as Map intro in" transitions={auto.data?.transitions ?? null} disabled={!!programReason || !auto.data} onChange={(v) => void saveObs({ introOut: v })} />
          </div>
        )}

        {data && !vmix ? (
          <div className="row" aria-label="Map intro scene">
            <ActionButton size="sm" action={() => api.post<{ scene: string; created: boolean }>(`${MAP_INTROS_PATH}/obs-setup`)} success={(r) => `OBS: “${r.scene}” ${r.created ? "made" : "is ready"}`} onDone={() => void intros.reload()} disabledReason={setupReason ?? (!data.setup.obsConnected ? "Connect OBS first (Settings → Devices)" : null)}>
              Set up OBS map intro scene
            </ActionButton>
            <span className="muted small">{data.setup.detail}</span>
          </div>
        ) : data ? (
          <p className="muted small">{data.setup.detail}</p>
        ) : null}
        <p className="muted small">The live game audio picked under Automatic replays → Sound is turned down while an intro plays, and put back after.</p>

        <Hotkeys keys={MAP_INTRO_KEYS} label="Map intro hotkeys" devices="the device actions map_intro_play (the current map's intro) and map_intro_next (the next map's, from the active match's veto); Return live (return_live) ends an intro early" />
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
      toast.push("danger", "Intro not added", `${file.name} is larger than ${Math.round(data.maxBytes / 1024 / 1024)} MB.`);
      return;
    }
    setChecking(slot);
    try {
      const r = await api.upload<MapIntrosResponse & { intro: MapIntroFile }>(`${MAP_INTROS_PATH}/${slot}?name=${encodeURIComponent(file.name)}`, file, file.type || "application/octet-stream");
      onChange(r);
      toast.push("ok", `${data.slots.find((s) => s.slot === slot)?.label ?? slot} intro added`, introFacts(r.intro));
    } catch (e) {
      // A file that can't be an intro (422), or no ffmpeg to check it (409): the engine says why in plain words.
      toast.push("danger", "Intro not added", e instanceof ApiError && (e.status === 422 || e.status === 409) ? e.message : describeError(e));
    } finally {
      setChecking(null);
    }
  };
  const remove = async (slot: MapIntroSlot, label: string) => {
    try {
      onChange(await api.del<MapIntrosResponse>(`${MAP_INTROS_PATH}/${slot}`));
      toast.push("ok", `${label} intro removed`);
    } catch (e) {
      toast.push("danger", "Intro not removed", describeError(e));
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
        aria-label="Intro video file"
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (f) void upload(f);
        }}
      />
      <table className="table table-compact" aria-label="Map intro videos">
        <thead>
          <tr>
            <th>Map</th>
            <th>Intro</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {data.slots.map(({ slot, label, intro }) => (
            <tr key={slot}>
              <td>
                <strong>{label}</strong>
                {slot === "default" ? <div className="muted small">Maps without their own</div> : null}
              </td>
              <td>
                {intro ? (
                  <div className="row" style={{ alignItems: "flex-start", gap: 8 }}>
                    {intro.previewUrl ? <img src={intro.previewUrl} alt={`${label} intro frame`} width={96} style={{ borderRadius: 4, flex: "none" }} /> : null}
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
                  <span className="muted small">{checking === slot ? "Checking…" : slot === "default" ? "None" : data.slots.some((s) => s.slot === "default" && s.intro) ? "The default plays" : "None"}</span>
                )}
              </td>
              <td>
                <div className="row" style={{ justifyContent: "flex-end" }}>
                  <Button size="sm" disabledReason={disabledReason ?? (checking ? "Checking a file…" : onAir === slot ? "It is on air" : null)} onClick={() => pick(slot)}>
                    {checking === slot ? "Checking…" : intro ? "Replace" : "Add"}
                  </Button>
                  {intro ? (
                    <Button size="sm" variant="ghost" disabledReason={disabledReason ?? (onAir === slot ? "It is on air" : null)} onClick={() => void remove(slot, label)}>
                      Remove
                    </Button>
                  ) : null}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="muted small">MP4 or MOV (H.264 is the safest; ProRes 4444 or QuickTime Animation for a see-through intro), 0.5 s to 2 minutes. Each file is checked as it is added and kept in the data folder's map-intros folder.</p>
    </>
  );
}
