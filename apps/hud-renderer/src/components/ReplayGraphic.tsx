import type { CSSProperties } from "react";
import type { HudReplayClip, HudState } from "@matchframe/hud-sdk";
import { replayBadge } from "@matchframe/hud-sdk";
import { HeadshotIcon, ReplayIcon } from "./Icons.tsx";
import { clipColor, clipVictims, teamMonogram, useReplayGraphic } from "./replay.ts";
import "./replay.css";

const SIDE = { ct: "var(--mf-ct)", t: "var(--mf-t)" };
const NEUTRAL = "var(--mf-ink-dim)";

function Card({ clip, leaving }: { clip: HudReplayClip; leaving: boolean }) {
  const badge = replayBadge(clip);
  const victims = clipVictims(clip);
  const t = clip.team;
  return (
    <div className={`mf-rp-card ${leaving ? "is-out" : "is-in"}`} style={{ "--mf-rp": clipColor(clip, SIDE, NEUTRAL) } as CSSProperties}>
      <div className="mf-rp-logo">{t?.logoUrl ? <img src={t.logoUrl} alt="" /> : <span>{t ? teamMonogram(t) : "?"}</span>}</div>
      <div className="mf-rp-body">
        <div className="mf-rp-head">
          <span className="mf-rp-name">{clip.player?.name}</span>
          {t ? <span className="mf-rp-team">{t.name}</span> : null}
        </div>
        <div className="mf-rp-meta">
          {clip.weapon ? <span className="mf-rp-weapon">{clip.weapon.displayName}</span> : null}
          {clip.headshot ? (
            <span className="mf-rp-hs">
              <HeadshotIcon size={14} /> Headshot
            </span>
          ) : null}
          {victims ? <span className="mf-rp-victims">{victims}</span> : null}
        </div>
      </div>
      {badge ? (
        <div className="mf-rp-badge">
          <b>{clip.clutchVersus !== null ? `1v${clip.clutchVersus}` : clip.multiKill}</b>
          {clip.clutchVersus !== null ? <span>Clutch</span> : null}
        </div>
      ) : null}
    </div>
  );
}

/**
 * The Broadcast HUD's replay graphic (its `replay` entry point, also used for LHM-format HUDs that
 * have none): a "REPLAY" tag top left and a lower third in the HUD's panels, in each preset's
 * style (Classic, Minimal, Arena). Transparent everywhere else.
 */
export function ReplayGraphic({ state }: { state: HudState }) {
  const view = useReplayGraphic(state.replay.clip);
  const card = view.card;
  const clip = card?.clip ?? state.replay.clip;
  return (
    <div className="mf-rp">
      {view.tag !== "off" ? (
        <div className={`mf-rp-tag ${view.tag === "out" ? "is-out" : "is-in"}`} style={clip ? ({ "--mf-rp": clipColor(clip, SIDE, NEUTRAL) } as CSSProperties) : undefined}>
          <ReplayIcon size={18} />
          <span className="mf-rp-tag-text">Replay</span>
          {clip?.roundNumber != null ? <span className="mf-rp-tag-round">Round {clip.roundNumber}</span> : null}
        </div>
      ) : null}
      {card?.clip.player ? <Card key={card.clip.id} clip={card.clip} leaving={card.state === "out"} /> : null}
    </div>
  );
}
