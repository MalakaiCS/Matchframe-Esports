import { useEffect, useState } from "react";
import type { HudLibrary } from "@matchframe/contracts";
import { api, describeError, seg } from "../../api/index.ts";
import type { GraphicsSettings, ObsAutoResponse, ObsState } from "../../api/types.ts";
import { ActionButton, Checkbox, Field, Note, Panel } from "../../components/ui.tsx";
import { useToast } from "../../components/toasts.tsx";
import { useApi } from "../../lib/hooks.ts";
import { usePermission } from "../../state/session.tsx";

type SceneMap = ObsAutoResponse["scenes"];
const MODES: { key: keyof SceneMap; label: string; hint: string }[] = [
  { key: "LIVE", label: "Live scene", hint: "The game with the HUD." },
  { key: "REPLAY", label: "Replay scene", hint: "Plays replays (Set up OBS replay scene makes one)." },
  { key: "BREAK", label: "Break scene", hint: "Tactical timeouts and technical pauses." },
  { key: "STUDIO", label: "Studio scene", hint: "After a map ends." },
];

function SceneSelect({ value, scenes, onChange, label, hint, disabled }: { value: string | null; scenes: string[]; onChange: (v: string | null) => void; label: string; hint?: string; disabled: boolean }) {
  const options = value && !scenes.includes(value) ? [value, ...scenes] : scenes;
  return (
    <Field label={label} hint={hint}>
      <select value={value ?? ""} onChange={(e) => onChange(e.target.value || null)} disabled={disabled}>
        <option value="">Not used</option>
        {options.map((s) => (
          <option key={s} value={s}>
            {s}
          </option>
        ))}
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
      toast.push("danger", "Setting not saved", describeError(e));
    }
  };
  return (
    <Panel title="OBS scenes" subtitle="Which OBS scene is on program, and when it changes by itself.">
      <div className="stack-sm">
        {!connected ? <Note tone="warn">Connect OBS in Settings → Devices to pick scenes.</Note> : null}
        <div className="form-grid">
          {MODES.map((m) => (
            <SceneSelect key={m.key} label={m.label} hint={m.hint} scenes={list} value={scenes?.[m.key] ?? null} disabled={!!settingsReason || !scenes} onChange={(v) => setScenes((cur) => (cur ? { ...cur, [m.key]: v } : cur))} />
          ))}
        </div>
        <div className="row">
          <ActionButton action={() => api.put("/api/v1/settings/program.scenes", { value: scenes })} success="Scenes saved" onDone={() => void auto.reload()} disabledReason={settingsReason ?? (!scenes ? "Loading…" : null)}>
            Save scenes
          </ActionButton>
        </div>
        <Checkbox checked={st?.timeouts ?? true} disabled={!!reason || !st} label="Timeouts and pauses → break scene" hint="On a tactical timeout or a technical pause, then back to the live scene when play resumes." onChange={(v) => void save({ timeouts: v })} />
        <Checkbox checked={st?.mapEnd ?? true} disabled={!!reason || !st} label="Map end → studio scene" hint="When a map ends, then back to the live scene when the next map starts." onChange={(v) => void save({ mapEnd: v })} />
        <Field label="Replay transition" hint="An OBS transition for cuts to and from replays, such as a Stinger. The transition in use is put back after.">
          <select value={st?.replayTransition ?? ""} disabled={!!reason || !st} onChange={(e) => void save({ replayTransition: e.target.value })}>
            <option value="">OBS's current transition</option>
            {(auto.data?.transitions?.names ?? (st?.replayTransition ? [st.replayTransition] : [])).map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </Field>
        <p className="muted small">Scenes only change from the live scene, and only back from a scene Matchframe chose. Your own program choices are never undone.</p>
      </div>
    </Panel>
  );
}

/** HUD graphics timed to the shots, and an LHM HUD's pages in OBS. */
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
      toast.push("danger", "Setting not saved", describeError(e));
    }
  };
  const lhm = (lib.data?.huds ?? []).filter((h) => h.views.length > 0);
  const sources = (items.data ?? []).map((i) => i.sourceName);
  const off = !!reason || !st;
  return (
    <Panel title="HUD graphics" subtitle="Shown by themselves while the Auto Director has the camera.">
      <div className="stack-sm">
        <Checkbox checked={st?.enabled ?? true} disabled={off} label="Time graphics to the shots" onChange={(v) => void save({ enabled: v })} />
        <div className="form-grid">
          <Checkbox checked={st?.economy ?? true} disabled={off || !st?.enabled} label="Economy in freeze time" onChange={(v) => void save({ economy: v })} />
          <Checkbox checked={st?.mvp ?? true} disabled={off || !st?.enabled} label="Round MVP in freeze time" onChange={(v) => void save({ mvp: v })} />
          <Checkbox checked={st?.playerCards ?? true} disabled={off || !st?.enabled} label="Player card on a long player view" hint="Only on a player view, never over a camera, and gone when the view changes." onChange={(v) => void save({ playerCards: v })} />
          <Checkbox checked={st?.clutch ?? true} disabled={off || !st?.enabled} label="Clutch banner (1v2 and more)" onChange={(v) => void save({ clutch: v })} />
        </div>
        <p className="muted small">Matchframe HUDs draw these. LHM-format HUDs (such as kaiHUD) have their own pages instead, shown below.</p>
        <h4 className="hud-section-title">LHM HUD pages in OBS</h4>
        <p className="muted small">Add the HUD's Player stats and Match stats pages as Browser Sources in one OBS scene (copy their addresses in HUD Library → the HUD → HUD pages), hidden. Matchframe shows Player stats for the round MVP in freeze time, and Match stats at half time and at the end of the map.</p>
        <div className="form-grid">
          <Field label="HUD">
            <select value={pages.hudId} disabled={off} onChange={(e) => void save({ pages: { hudId: e.target.value } })}>
              <option value="">None</option>
              {lhm.map((h) => (
                <option key={h.id} value={h.id}>
                  {h.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="OBS scene with the pages">
            <select value={pages.scene} disabled={off} onChange={(e) => void save({ pages: { scene: e.target.value, playerSource: "", matchSource: "" } })}>
              <option value="">None</option>
              {(obs.data?.state.scenes ?? (pages.scene ? [pages.scene] : [])).map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Player stats source">
            <select value={pages.playerSource} disabled={off || !pages.scene} onChange={(e) => void save({ pages: { playerSource: e.target.value } })}>
              <option value="">None</option>
              {(pages.playerSource && !sources.includes(pages.playerSource) ? [pages.playerSource, ...sources] : sources).map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Match stats source">
            <select value={pages.matchSource} disabled={off || !pages.scene} onChange={(e) => void save({ pages: { matchSource: e.target.value } })}>
              <option value="">None</option>
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
