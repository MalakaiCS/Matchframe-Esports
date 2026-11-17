import { useState } from "react";
import { api, describeError } from "../api/index.ts";
import type { LowSpecStatus } from "../api/types.ts";
import { useApi } from "../lib/hooks.ts";
import { useLowSpec } from "../lib/lowSpec.ts";
import { Link } from "../router.tsx";
import { usePermission } from "../state/session.tsx";
import { ActionButton, Checkbox, KV, Note, Panel } from "./ui.tsx";

/** Turns low-spec mode on or off (PUT /api/v1/performance, audited). */
export const setLowSpec = (on: boolean) => api.put<LowSpecStatus>("/api/v1/performance", { lowSpec: on });

function engineMemory(st: LowSpecStatus, canRestart: boolean): string {
  const used = `${st.engine.heapUsedMb} MB in use`;
  if (!st.lowSpec) return `${used} (no cap)`;
  if (st.engine.heapCapMb !== null) return `Capped at ${st.engine.heapCapMb} MB (${used})`;
  return canRestart ? `The cap applies from the engine's next start (${used})` : `Set by the MatchFrame program when it starts the engine (${used})`;
}

function obsLine(st: LowSpecStatus): string {
  if (!st.lowSpec) return "Unchanged";
  if (st.obs.error) return `Could not set every source: ${st.obs.error}`;
  if (!st.obs.connected) return "Not connected: set when OBS connects";
  return st.obs.sources.length ? `30 fps on ${st.obs.sources.join(", ")}` : "No browser source made by MatchFrame: set your own to 30 fps";
}

/**
 * Settings → General → Performance: Low-spec mode (one PC, ADR-078), off by default. What it does,
 * and what it has done here: the engine's memory cap, OBS's browser sources, background work.
 */
export function PerformancePanel() {
  const reason = usePermission("settings.manage");
  const summary = useLowSpec();
  const status = useApi<LowSpecStatus>("/api/v1/performance", { refreshMs: 5000 });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const st = status.data;
  const on = st?.lowSpec ?? summary?.lowSpec ?? false;
  const mf = window.matchframe;
  const canRestart = !!mf?.restartEngine && mf.connectionMode !== "remote";
  const save = async (v: boolean) => {
    setSaving(true);
    setError(null);
    try {
      status.setData(await setLowSpec(v));
    } catch (e) {
      setError(describeError(e));
    } finally {
      setSaving(false);
    }
  };
  return (
    <Panel title="Performance" subtitle="For productions where CS2, OBS and MatchFrame all run on one PC">
      <div className="stack" data-testid="performance-panel">
        <Checkbox checked={on} disabled={reason !== null || saving || !st} onChange={(v) => void save(v)} label={<strong>Low-spec mode (one PC)</strong>} hint={reason ?? "Lighter HUDs, a 30 fps cap, capped memory and background work held during live rounds"} />
        <ul className="small muted" style={{ margin: 0, paddingLeft: 18 }}>
          <li>HUD outputs and the desktop HUD draw at most 30 frames a second. MatchFrame&apos;s HUDs drop blur, large shadows and looping animations; imported HUDs get the frame cap only.</li>
          <li>Browser sources MatchFrame made in OBS are set to 30 fps. For your own: the source&apos;s properties, Use custom frame rate, FPS 30.</li>
          <li>The engine sends HUDs only what changed, starts with a memory cap, holds demo hashing and processing, training and highlight reels while a round is live, and encodes replays with lighter presets.</li>
          <li>The console shows no live previews or animated thumbnails (a button still opens a preview).</li>
        </ul>
        {st ? (
          <KV
            items={[
              ["Engine memory", engineMemory(st, canRestart)],
              ["OBS browser sources", obsLine(st)],
              ["Background work", st.deferring ? "Waiting for the live round to end" : st.lowSpec ? "Runs between rounds" : "Runs as set in the Demo Library"],
            ]}
          />
        ) : null}
        {st?.lowSpec && st.engine.heapCapMb === null && canRestart ? (
          <div className="row">
            <ActionButton
              size="sm"
              action={async () => {
                if (!(await mf!.restartEngine!())) throw new Error("The program did not restart the engine.");
                return true;
              }}
              success="Engine restarting with the memory cap" confirm={{ title: "Restart the engine now?", body: "HUD outputs reconnect by themselves within seconds. Camera automation stays off until you resume it.", confirmLabel: "Restart engine" }}>
              Restart engine now
            </ActionButton>
          </div>
        ) : null}
        {!on && summary?.suggestion ? <Note tone="info" title="Suggested">{summary.suggestion.reason}</Note> : null}
        {error ? <Note tone="warn">{error}</Note> : null}
      </div>
    </Panel>
  );
}

/**
 * The one-time suggestion (HUD Library): HUD outputs stuttered while CS2 runs on this computer. Turn
 * it on, or dismiss it for good.
 */
export function LowSpecSuggestion() {
  const summary = useLowSpec();
  const reason = usePermission("settings.manage");
  const [done, setDone] = useState(false);
  const s = summary?.suggestion;
  if (!s || summary.lowSpec || done) return null;
  return (
    <div data-testid="low-spec-suggestion">
      <Note tone="info" title="One PC?">
        <p style={{ margin: "0 0 8px" }}>
          {s.reason} <strong>Low-spec mode</strong> caps HUD outputs at 30 fps, lightens MatchFrame&apos;s HUDs and holds MatchFrame&apos;s background work during live rounds.
        </p>
        <div className="row">
          <ActionButton size="sm" variant="primary" action={() => setLowSpec(true)} success="Low-spec mode on" onDone={() => setDone(true)} disabledReason={reason}>
            Turn on low-spec mode
          </ActionButton>
          <ActionButton size="sm" variant="ghost" action={() => api.post<LowSpecStatus>("/api/v1/performance/suggestion/dismiss")} success={null} onDone={() => setDone(true)} disabledReason={reason}>
            Dismiss
          </ActionButton>
          <Link to="/settings">What it does</Link>
        </div>
      </Note>
    </div>
  );
}
