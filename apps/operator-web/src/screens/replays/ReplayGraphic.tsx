import type { HudLibrary } from "@matchframe/contracts";
import type { HudReplayClip } from "@matchframe/hud-sdk";
import { api, describeError } from "../../api/index.ts";
import { ActionButton, Badge, Checkbox, CopyButton, Field, Mono, Note, Panel } from "../../components/ui.tsx";
import { useToast } from "../../components/toasts.tsx";
import { useApi } from "../../lib/hooks.ts";
import { usePermission } from "../../state/session.tsx";

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
  const what = c.clutchVersus !== null ? `1v${c.clutchVersus} clutch` : c.multiKill ?? (c.kills === 1 ? "kill" : null);
  return [c.player?.name ?? "Replay", what, c.weapon?.displayName, c.headshot ? "headshot" : null, c.roundNumber !== null ? `round ${c.roundNumber}` : null].filter(Boolean).join(" · ");
}

/**
 * The replay graphic: a "REPLAY" tag and a lower third with the play on Matchframe's HUDs while a
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
      toast.push("danger", "Setting not saved", describeError(e));
    }
  };
  const off = !!reason || !st;
  const out = st?.output ?? null;
  return (
    <Panel title="Replay graphic" subtitle="A REPLAY tag and a lower third with the play, a moment after each replay starts." actions={st?.onAir ? <Badge tone="accent">On air</Badge> : st ? <Badge tone={st.settings.enabled ? "ok" : "neutral"}>{st.settings.enabled ? "On" : "Off"}</Badge> : null}>
      <div className="stack-sm">
        <Checkbox checked={st?.settings.enabled ?? true} disabled={off} label="Show the replay graphic" hint="Who made the play, the weapon, headshot, victims, 2K to ACE or a clutch, and the round. Off: the replay page stays empty." onChange={(v) => void save({ enabled: v })} />
        <Field label="HUD" hint="Each Matchframe HUD has its own replay graphic. LHM-format HUDs (such as kaiHUD) have none: they get Matchframe's built-in one.">
          <select value={st?.settings.hudId ?? "auto"} disabled={off} onChange={(e) => void save({ hudId: e.target.value })}>
            <option value="auto">Automatic: the HUD in OBS</option>
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
              {out.why} <span className="muted">Page: {out.hudName}, replay</span>
            </p>
            <div className="row">
              <Mono>{out.url}</Mono>
              <CopyButton text={out.url} />
            </div>
          </div>
        ) : st ? (
          <Note tone="warn">No HUD has a replay page: the built-in HUD's files are missing (run pnpm build).</Note>
        ) : null}
        <div className="row">
          <ActionButton
            action={() => api.post<ObsSetup>("/api/v1/replay-graphic/obs")}
            success={(r) => `${r.created ? `“${r.source}” added on top of “${r.scene}”` : `“${r.source}” in “${r.scene}” shows ${r.output.hudName}'s replay graphic`}${r.onTop ? "" : " (move it to the top of the scene in OBS)"}`}
            onDone={() => void g.reload()}
            disabledReason={setupReason ?? (!st ? "Loading…" : !st.obsConnected ? "Connect OBS first (Settings → Devices)" : !st.replayScene ? "Map the replay scene first (Set up OBS replay scene, or OBS scenes)" : null)}
          >
            Add replay graphic to the OBS replay scene
          </ActionButton>
          {st?.replayScene ? <span className="muted small">Replay scene: {st.replayScene}</span> : null}
        </div>
        {st?.onAir ? <p className="small">On air: {describeClip(st.onAir)}</p> : null}
        <p className="muted small">A 1920×1080 browser source named “{st?.source ?? "Matchframe Replay Graphic"}” over the replay clip. Choosing another HUD here points it at that HUD's page; press again when another HUD is on air in OBS. With vMix, add the address as a Web Browser input over your replays.</p>
      </div>
    </Panel>
  );
}
