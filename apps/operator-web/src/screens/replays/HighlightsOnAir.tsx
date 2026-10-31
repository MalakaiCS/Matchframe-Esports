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

const COUNTS = [5, 8, 10, 15, "all"] as const;
const WHAT: { id: HighlightsAirSettings["what"]; label: string }[] = [
  { id: "map", label: "This map" },
  { id: "half", label: "The last half of this map" },
  { id: "previous", label: "The previous map" },
];
const VMIX_TRANSITIONS = [
  { id: "CutDirect", label: "Cut" },
  { id: "Fade", label: "Fade" },
  { id: "Stinger1", label: "Stinger 1" },
  { id: "Stinger2", label: "Stinger 2" },
] as const;
/** What the Play button says when it is halftime and highlights are off then. */
export const HALFTIME_OFF = "Highlights at halftime are off";

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
  const control = async (path: string, body?: unknown) => {
    try {
      await api.post(path, body);
      void air.reload();
    } catch (e) {
      toast.push("warn", "Highlights", describeError(e));
    }
  };
  const halftimeOff = !!st?.noHalftime && !!status?.halftime;
  const playReason = reason ?? (!status ? "Loading…" : status.running ? "Highlights are on air" : halftimeOff ? HALFTIME_OFF : status.blocked);
  const plan = status?.plan ?? null;
  const vmix = setup?.mixer === "vmix";
  return (
    <Panel title="Highlights on air" subtitle={status?.detail} actions={status ? <Badge tone={status.running ? "accent" : status.blocked ? "neutral" : "ok"}>{status.running ? (status.held ? "Held" : "On air") : status.blocked ? "Not now" : "Ready"}</Badge> : null}>
      <div className="stack-sm">
        <div className="row" role="group" aria-label="Highlights controls">
          {status?.running ? (
            <>
              <Button variant="primary" disabledReason={reason} title={`Ends the highlight on air now (${shortcutLabel("F5")})`} onClick={() => void control("/api/v1/replays/auto/skip")}>
                Skip
              </Button>
              <Button variant={status.held ? "primary" : "secondary"} disabledReason={reason} title={`${status.held ? "Plays it on" : "Pauses the highlight on air"} (${shortcutLabel("F6")})`} onClick={() => void control("/api/v1/replays/auto/hold", { held: !status.held })}>
                {status.held ? "Resume" : "Hold"}
              </Button>
              <Button variant="danger" disabledReason={reason} title={`Back to the scene the program came from, with Highlights out (${shortcutLabel("F10")})`} onClick={() => void control("/api/v1/highlights/air/stop")}>
                Stop
              </Button>
              {status.position ? <span className="small">{`Highlight ${status.position.n} of ${status.position.of}`}</span> : null}
            </>
          ) : (
            <ActionButton
              variant="primary"
              action={() => api.post<HighlightsAirResponse>("/api/v1/highlights/air/play")}
              success={(r) => (r.status.running ? "Highlights on air" : null)}
              onDone={(r) => air.setData(r)}
              disabledReason={playReason}
              reasonPlacement={halftimeOff ? "inline" : "tooltip"}
              title={`Plays the clips below on the program now, then goes back to the scene it came from (${shortcutLabel("F9")})`}
            >
              Play highlights
            </ActionButton>
          )}
        </div>
        {status?.blocked && !status.running && !halftimeOff ? <span className="small muted">{status.blocked}</span> : null}

        <Checkbox checked={st?.noHalftime ?? true} disabled={off} label="Don't show highlights at halftime" hint="On: no highlights start at halftime, by Play, a hotkey, a Stream Deck or by themselves. Highlights already playing when halftime starts play on." onChange={(v) => void save({ noHalftime: v })} />
        {st && !st.noHalftime ? <Checkbox checked={st.autoHalftime} disabled={off} label="Start by themselves at halftime" hint="Once the round's replays are over, and only when the program is on the live scene: never over your own scene." onChange={(v) => void save({ autoHalftime: v })} /> : null}
        <Checkbox checked={st?.autoMapEnd ?? false} disabled={off} label="Start by themselves when a map ends" hint="Once the last round's replays are over, and only when the program is on the live scene; the studio scene (Map end → studio scene) comes after them." onChange={(v) => void save({ autoMapEnd: v })} />

        <div className="form-grid">
          <Field label="What">
            <select value={st?.what ?? "map"} disabled={off} onChange={(e) => void save({ what: e.target.value as HighlightsAirSettings["what"] })}>
              {WHAT.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="How many" hint="Best: by the same score as automatic replays.">
            <select value={String(st?.count ?? 5)} disabled={off} onChange={(e) => void save({ count: e.target.value === "all" ? "all" : Number(e.target.value) })}>
              {[...COUNTS, ...(st && st.count !== "all" && !(COUNTS as readonly (number | string)[]).includes(st.count) ? [st.count] : [])].map((c) => (
                <option key={String(c)} value={String(c)}>
                  {c === "all" ? "All played clips" : `The best ${c}${c === 5 ? " (recommended)" : ""}`}
                </option>
              ))}
            </select>
          </Field>
        </div>
        {st?.count !== "all" ? <Checkbox checked={st?.unplayed ?? false} disabled={off} label="Also clips that weren't played" hint="The best of the map's other clips (the replay PC films more than a break has time for)." onChange={(v) => void save({ unplayed: v })} /> : null}

        {plan && plan.clips.length ? (
          <div className="stack-sm" aria-label="Highlights that will play">
            <span className="small muted">
              {`${plan.clips.length} clip${plan.clips.length === 1 ? "" : "s"}, ${len(plan.totalMs)}`}
              {plan.rounds ? ` · rounds ${plan.rounds.from}–${plan.rounds.to}` : ""}
              {plan.title ? ` · ${plan.title}` : ""}
            </span>
            <ol className="small" style={{ margin: 0, paddingLeft: 20 }}>
              {plan.clips.map((c) => (
                <li key={c.id}>
                  R{c.roundNumber ?? "?"} · {c.label} · {fmtMs(c.playMs)}
                  {c.played ? "" : " · not played"}
                  {status?.playing?.id === c.id ? <strong> · on air</strong> : null}
                </li>
              ))}
            </ol>
          </div>
        ) : plan ? (
          <p className="muted small">{st?.count === "all" ? "No clip of it has been played yet." : "No clips kept for it yet."}</p>
        ) : null}
        {status?.auto ? <p className={`small ${status.auto.started ? "muted" : "text-warn"}`}>{status.auto.detail}</p> : null}

        <HighlightsScene data={data ?? null} onDone={(r) => air.setData(r)} reload={() => void air.reload()} />

        <h4 className="hud-section-title">Transitions</h4>
        {vmix ? (
          <div className="form-grid">
            <Field label="Highlights in" hint="vMix: to the first highlight.">
              <select value={st?.vmixIn ?? ""} disabled={off} onChange={(e) => void save({ vmixIn: (e.target.value || null) as HighlightsAirSettings["vmixIn"] })}>
                <option value="">Same as Replay in</option>
                {VMIX_TRANSITIONS.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Highlights out" hint="vMix: back to the input that was on air before.">
              <select value={st?.vmixOut ?? ""} disabled={off} onChange={(e) => void save({ vmixOut: (e.target.value || null) as HighlightsAirSettings["vmixOut"] })}>
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
            <HighlightTransitions settings={auto.data?.settings ?? null} transitions={auto.data?.transitions ?? null} disabled={!!programReason || !auto.data} save={saveObs} />
          </div>
        )}
        <p className="muted small">Between highlights: the fade (or cut) and the speed of automatic replays. The live game audio picked under Automatic replays → Sound is turned down meanwhile and put back after.</p>

        <Hotkeys keys={HIGHLIGHT_KEYS} label="Highlights hotkeys" devices={`the device actions highlights_play, highlights_stop and highlights_halftime (Don't show highlights at halftime: on, off or toggle); Skip and Hold are replay_skip and replay_hold (${shortcutLabel("F5")}, ${shortcutLabel("F6")})`} />
        <p className="muted small">Not while a round is live. If a round goes live while they play (halftime over), they play on until the replays' cut back on its clock, then the live scene. If you switch OBS to another scene meanwhile, they stop and Matchframe leaves it there.</p>
      </div>
    </Panel>
  );
}

/** The highlights scene: one click to make Matchframe's, or your own scene and its media source; what's ready. */
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
  if (setup?.mixer === "vmix") return <p className="muted small">Highlights play in vMix, as automatic replays do: each clip is added as an input, and vMix goes back to the input that was on air before.</p>;
  const connected = obs.data?.state.connected ?? setup?.obsConnected ?? false;
  const scenes = obs.data?.state.scenes ?? [];
  const media = (items.data ?? []).filter((i) => i.inputKind === "ffmpeg_source" || i.sourceName === input);
  const mapOwn = async () => {
    try {
      const r = await api.put<HighlightsAirResponse>("/api/v1/highlights/air/scene", { scene: scene || null, input: scene ? input || null : null });
      onDone(r);
      toast.push("ok", scene ? `Highlights play in “${scene}”` : "No highlights scene");
    } catch (e) {
      toast.push("danger", "Scene not saved", describeError(e));
    }
  };
  const twin = setup?.twin;
  const graphic = setup?.graphic;
  return (
    <div className="stack-sm" aria-label="Highlights scene">
      <h4 className="hud-section-title">Highlights scene</h4>
      {!connected ? <Note tone="warn">Connect OBS in Settings → Devices to set up the highlights scene.</Note> : null}
      <div className="row">
        <ActionButton
          action={() => api.post<{ scene: string; input: string; graphicError: string | null }>("/api/v1/highlights/air/obs-setup")}
          success={(r) => `OBS: scene “${r.scene}” with the media source “${r.input}” is ready${r.graphicError ? ` (replay graphic: ${r.graphicError})` : ", with the replay graphic on top"}`}
          onDone={reload}
          disabledReason={setupReason ?? (!connected ? "Connect OBS first (Settings → Devices)" : null)}
        >
          Set up OBS highlights scene
        </ActionButton>
        <span className="muted small">Adds a “Matchframe Highlights” scene with a media source (set like the replay scene's), the replay graphic on top (the same source as in the replay scene), and a second one beside it for fading between highlights.</span>
      </div>
      <Details summary="Or use your own scene">
        <div className="form-grid">
          <Field label="Your highlights scene" hint="An OBS scene with a Media Source directly in it (not in a group).">
            <select value={scene} disabled={!!setupReason || !connected} onChange={(e) => (setScene(e.target.value), setInput(""))}>
              <option value="">None</option>
              {(scene && !scenes.includes(scene) ? [scene, ...scenes] : scenes).map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Its media source" hint="The Media Source the highlights play in.">
            <select value={input} disabled={!!setupReason || !connected || !scene} onChange={(e) => setInput(e.target.value)}>
              <option value="">Choose…</option>
              {(input && !media.some((m) => m.sourceName === input) ? [{ sourceName: input, inputKind: null }, ...media] : media).map((m) => (
                <option key={m.sourceName} value={m.sourceName}>
                  {m.sourceName}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <div className="row">
          <Button size="sm" disabledReason={setupReason ?? (scene && !input ? "Choose its media source" : null)} onClick={() => void mapOwn()}>
            Use this scene
          </Button>
          <ActionButton size="sm" variant="ghost" action={() => api.post("/api/v1/highlights/air/graphic")} success="Replay graphic on top of the highlights scene" onDone={reload} disabledReason={setupReason ?? (!setup?.scene ? "Choose the scene first" : !connected ? "Connect OBS first" : null)}>
            Add the replay graphic
          </ActionButton>
        </div>
      </Details>
      {setup ? (
        <ul className="small" aria-label="Highlights scene status" style={{ margin: 0, paddingLeft: 18 }}>
          <li>
            <Badge tone={setup.sceneReady ? "ok" : "neutral"}>{setup.sceneReady ? "Scene ready" : "Scene not ready"}</Badge> {setup.scene ? `“${setup.scene}” with “${setup.input ?? "?"}”` : "None yet"}
          </li>
          <li>
            <Badge tone={twin?.ready ? "ok" : "neutral"}>{twin?.ready ? "Twin ready" : "No twin yet"}</Badge> {twin ? (twin.ready ? `Fades through “${twin.scene}”${setup.sameAsReplay ? " (the replay scene's)" : ""}: leave it to Matchframe.` : twin.detail) : "Made with the scene."}
          </li>
          <li>
            <Badge tone={graphic?.onTop ? "ok" : "neutral"}>{graphic?.onTop ? "Graphic on top" : graphic?.inScene ? "Graphic not on top" : "No graphic"}</Badge> {graphic ? (graphic.inScene ? (graphic.onTop ? `“${graphic.source}” over the clips.` : "Move it to the top of the scene in OBS.") : "Press Add the replay graphic.") : ""}
          </li>
        </ul>
      ) : null}
      {setup?.detail ? <span className="small muted">{setup.detail}</span> : null}
    </div>
  );
}
