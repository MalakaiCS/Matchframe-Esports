import { useEffect, useRef } from "react";
import type { HudState } from "@matchframe/hud-sdk";

export function SponsorZone({ zone, state, onShown }: { zone: string; state: HudState; onShown?: (sponsorId: string, zone: string) => void }) {
  const s = state.sponsors[zone] ?? null;
  const shown = useRef<string | null>(null);
  useEffect(() => {
    if (s && shown.current !== s.sponsorId) {
      shown.current = s.sponsorId;
      onShown?.(s.sponsorId, zone);
    }
    if (!s) shown.current = null;
  }, [s, zone, onShown]);
  if (!s) return null;
  return <div className={`mf-sponsor mf-sponsor-${zone}`}>{s.assetUrl ? <img src={s.assetUrl} alt={s.name} /> : <span>{s.name}</span>}</div>;
}

export function Cues({ state }: { state: HudState }) {
  if (state.cues.length === 0) return null;
  return (
    <>
      {state.cues.map((c) => {
        if (c.kind === "timeout") {
          return (
            <div key={c.id} className="mf-cue mf-cue-timeout">
              <span className="mf-cue-eyebrow">TACTICAL TIMEOUT</span>
              <span className="mf-cue-title">{c.subtitle ?? c.title}</span>
            </div>
          );
        }
        if (c.kind === "economy") {
          const money = (side: "left" | "right") => state[side].players.reduce((s, p) => s + (p.money ?? 0), 0);
          const equip = (side: "left" | "right") => state[side].players.reduce((s, p) => s + (p.equipValue ?? 0), 0);
          return (
            <div key={c.id} className="mf-cue mf-cue-economy">
              <div>
                <b>{state.left.shortName}</b> ${money("left")} <small>equip ${equip("left")}</small>
              </div>
              <span className="mf-cue-eyebrow">ECONOMY</span>
              <div>
                <b>{state.right.shortName}</b> ${money("right")} <small>equip ${equip("right")}</small>
              </div>
            </div>
          );
        }
        return (
          <div key={c.id} className={`mf-cue mf-cue-lower mf-cue-${c.kind}`}>
            <span className="mf-cue-title">{c.title}</span>
            {c.subtitle ? <span className="mf-cue-sub">{c.subtitle}</span> : null}
          </div>
        );
      })}
    </>
  );
}

export function Annotations({ state }: { state: HudState }) {
  if (state.annotations.length === 0) return null;
  return (
    <svg className="mf-annotations" viewBox="0 0 1920 1080" aria-hidden>
      <defs>
        <marker id="mf-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
          <path d="M0,0 L10,5 L0,10 z" fill="context-stroke" />
        </marker>
      </defs>
      {state.annotations.map((a) => (
        <polyline
          key={a.id}
          points={a.points.map(([x, y]) => `${x * 1920},${y * 1080}`).join(" ")}
          stroke={a.color}
          strokeWidth="6"
          fill="none"
          strokeLinecap="round"
          strokeLinejoin="round"
          markerEnd={a.kind === "arrow" ? "url(#mf-arrow)" : undefined}
        />
      ))}
    </svg>
  );
}

export function Badges({ state, connected }: { state: HudState | null; connected: boolean }) {
  return (
    <div className="mf-badges">
      {state?.simulated ? <span className="mf-badge mf-badge-sim">SIMULATION · synthetic data</span> : null}
      {!connected ? <span className="mf-badge mf-badge-warn">HUD DATA DISCONNECTED</span> : null}
    </div>
  );
}
