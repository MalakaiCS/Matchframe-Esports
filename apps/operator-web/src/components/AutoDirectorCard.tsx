import { useState } from "react";
import { api, describeError } from "../api/index.ts";
import type { AutoDirectorCheck, AutoDirectorStatus } from "../api/types.ts";
import { useApi } from "../lib/hooks.ts";
import { useLive } from "../state/live.ts";
import { usePermission } from "../state/session.tsx";
import { Icon } from "./icons.tsx";
import { useToast } from "./toasts.tsx";
import { Button, Checkbox } from "./ui.tsx";
import "../styles/auto-director.css";

const PHASE: Record<AutoDirectorStatus["phase"], { text: string; tone: string }> = {
  off: { text: "Off", tone: "neutral" },
  starting: { text: "Starting", tone: "info" },
  waiting: { text: "Waiting", tone: "warn" },
  running: { text: "On air", tone: "ok" },
  paused: { text: "You have the camera", tone: "info" },
  error: { text: "Stopped", tone: "danger" },
};

const MARK: Record<AutoDirectorCheck["status"], string> = { ok: "✓", wait: "…", warn: "!", fail: "✕", skip: "–" };

const RETURN_AFTER = [
  { sec: 5, label: "5 s" },
  { sec: 8, label: "8 s" },
  { sec: 15, label: "15 s" },
  { sec: 30, label: "30 s" },
  { sec: 0, label: "Only when I press Start" },
];

/**
 * The one button: Start checks the console, game data, account, player switching and cameras, fixes
 * what it can, and directs the match (see AutoDirector in the engine). Compact on Live Control.
 */
export function AutoDirectorCard({ compact = false }: { compact?: boolean }) {
  const status = useApi<AutoDirectorStatus>("/api/v1/director/auto", { refreshMs: 1000 });
  const fullAction = useLive((s) => s.snapshot?.simulated || s.snapshot?.cloud?.fullActionObserver !== false);
  const reason = usePermission("director.control");
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const st = status.data;
  const set = st?.settings ?? { cinematic: true, nadeCams: false, returnAfterSec: 8, chase: true, clutch: true };

  const call = async (fn: () => Promise<AutoDirectorStatus>, failTitle: string) => {
    setBusy(true);
    try {
      const next = await fn();
      status.setData(next);
      if (next.phase === "error") toast.push("danger", "Auto Director stopped", next.headline);
    } catch (e) {
      toast.push("danger", failTitle, describeError(e));
    } finally {
      setBusy(false);
      void status.reload();
    }
  };
  const start = () => call(() => api.post<AutoDirectorStatus>("/api/v1/director/auto/start", {}), "Auto Director not started");
  const stop = () => call(() => api.post<AutoDirectorStatus>("/api/v1/director/auto/stop", {}), "Auto Director not stopped");
  const save = (patch: Partial<AutoDirectorStatus["settings"]>) => call(() => api.put<AutoDirectorStatus>("/api/v1/director/auto/settings", patch), "Setting not saved");

  const on = st?.on ?? false;
  const phase = PHASE[st?.phase ?? "off"];
  const checks = st?.checks ?? [];
  return (
    <section className={`autodir ${compact ? "is-compact" : ""} ${on ? "is-on" : ""}`} aria-label="Auto Director">
      <div className="autodir-head">
        <div className="autodir-title">
          <Icon name="director" size={18} />
          <div>
            <strong>Auto Director</strong>
            <span className="small muted">Matchframe moves the CS2 camera for you.</span>
          </div>
        </div>
        <span className={`autodir-pill tone-${phase.tone}`} role="status">
          {phase.text}
        </span>
      </div>
      <div className="autodir-main">
        {on ? (
          <Button variant="danger" size="lg" className="autodir-go" disabledReason={reason ?? (busy ? "Working…" : null)} onClick={() => void stop()}>
            <Icon name="stop" size={16} /> Stop
          </Button>
        ) : (
          <Button variant="primary" size="lg" className="autodir-go" disabledReason={reason ?? (busy ? "Working…" : !st ? "Loading…" : null)} onClick={() => void start()}>
            <Icon name="play" size={16} /> Start Auto Director
          </Button>
        )}
        <p className={`autodir-headline ${st?.phase === "error" ? "text-danger" : ""}`} aria-live="polite">
          {st ? st.headline : status.error ? `Can't reach the engine: ${status.error}` : "Loading…"}
        </p>
      </div>
      <div className="autodir-options" role="group" aria-label="What the Auto Director films">
        <Checkbox checked label="Player POVs" disabled hint="Always on: follows the action and switches players." onChange={() => undefined} />
        <Checkbox
          checked={set.cinematic || set.nadeCams}
          disabled={!!reason || busy}
          label="Cinematic cameras"
          hint="Team shots and spawn cameras in freeze time, the bomb at plant and defuse, and overviews of big fights. Built-in cameras for every active-duty map."
          onChange={(v) => void save(v ? { cinematic: true } : { cinematic: false, nadeCams: false })}
        />
        <Checkbox
          checked={set.nadeCams}
          disabled={!!reason || busy || !fullAction}
          label={fullAction ? "Nade cams" : "Nade cams · Top plan"}
          hint={fullAction ? "Cameras that catch smokes, flashes, molotovs and HE grenades as they land (Full Action Observer)." : "Nade cams come with the top plan. Upgrade on the website."}
          onChange={(v) => void save(v ? { nadeCams: true, cinematic: true } : { nadeCams: false })}
        />
        <Checkbox
          checked={set.chase}
          disabled={!!reason || busy}
          label="Chase cam"
          hint="Shows the player from behind (third person) while they plant or defuse the bomb and when their team wins the round, then goes back to their eyes."
          onChange={(v) => void save({ chase: v })}
        />
        <Checkbox
          checked={set.clutch}
          disabled={!!reason || busy}
          label="Clutch mode"
          hint="When one player is left alone against the other team, stay with them: no cuts to cameras, and the chase view while no opponent is near. A won clutch is replayed if automatic replays are on."
          onChange={(v) => void save({ clutch: v })}
        />
        {compact || !(set.cinematic || set.nadeCams) ? null : (
          <>
            <Checkbox
              checked={set.variety !== false}
              disabled={!!reason || busy}
              label="Different freeze times"
              hint="Not the same shots every round: sometimes one longer shot of one team, from high up, low or from their side; no team shot of a team saving on an eco; cameras used in the last rounds give way to others."
              onChange={(v) => void save({ variety: v })}
            />
            <Checkbox
              checked={set.bigMoments !== false}
              disabled={!!reason || busy}
              label="Big moments"
              hint="A wide opener before each pistol round, the team on match point first and longer, and slow shots of the map at half time and at the end of the map (the winners first)."
              onChange={(v) => void save({ bigMoments: v })}
            />
            <label className="autodir-return">
              <span className="small muted">After the round, show the winners</span>
              <select value={set.winnerShots ?? "every_round"} disabled={!!reason || busy} onChange={(e) => void save({ winnerShots: e.target.value as "every_round" | "big_rounds" | "off" })}>
                <option value="every_round">every round</option>
                <option value="big_rounds">big rounds only</option>
                <option value="off">never</option>
              </select>
            </label>
            <Checkbox
              checked={set.hlaePaths === true}
              disabled={!!reason || busy}
              label="Camera paths through HLAE (experimental)"
              hint="In the Observer tools + HLAE launch mode, camera paths are played by HLAE (mirv_campath), which moves the camera every frame. Not yet tried live: if a path doesn't start, Matchframe moves the camera itself as before."
              onChange={(v) => void save({ hlaePaths: v })}
            />
          </>
        )}
        {compact ? null : (
          <label className="autodir-return">
            <span className="small muted">When I pick a player, take the camera back after</span>
            <select value={set.returnAfterSec} disabled={!!reason || busy} onChange={(e) => void save({ returnAfterSec: Number(e.target.value) })}>
              {(RETURN_AFTER.some((r) => r.sec === set.returnAfterSec) ? RETURN_AFTER : [...RETURN_AFTER, { sec: set.returnAfterSec, label: `${set.returnAfterSec} s` }]).map((r) => (
                <option key={r.sec} value={r.sec}>
                  {r.label}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      {checks.length ? (
        <ul className="autodir-checks" aria-label="Checks">
          {checks.map((c) => (
            <li key={c.id} className={`autodir-check is-${c.status}`}>
              <span className="autodir-mark" aria-hidden>
                {MARK[c.status]}
              </span>
              <span className="autodir-check-label">{c.label}</span>
              <span className="autodir-check-detail small">{c.detail}</span>
            </li>
          ))}
        </ul>
      ) : compact ? null : (
        <p className="small muted autodir-help">Press Start with CS2 spectating a match or playing a demo. Matchframe checks the console, the game data and your hours, tests player switching and the cameras on this CS2 build, and then directs. Press Stop, or the emergency stop, to take over.</p>
      )}
    </section>
  );
}
