import type { HudState } from "@matchframe/hud-sdk";

/** Exact entries show killer/weapon; degraded entries never invent killer, weapon or headshot. */
export function Killfeed({ state }: { state: HudState }) {
  const entries = state.killfeed.entries.slice(-5);
  if (entries.length === 0) return null;
  return (
    <div className="mf-killfeed" data-mode={state.killfeed.mode}>
      {entries.map((k) => (
        <div key={k.id} className={`mf-kill mf-kill-${k.kind}`}>
          {k.killer ? <span className={`mf-kill-name mf-side-${k.killer.side ?? "none"}`}>{k.killer.name}</span> : null}
          {k.kind === "exact" ? <span className="mf-kill-weapon">{k.weapon ?? ""}{k.headshot ? " ◎" : ""}</span> : <span className="mf-kill-sep" aria-hidden>{k.kind === "probable" ? "›" : "✕"}</span>}
          <span className={`mf-kill-name mf-kill-victim mf-side-${k.victim.side ?? "none"}`}>{k.victim.name}</span>
        </div>
      ))}
    </div>
  );
}
