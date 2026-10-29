import type { HudPlayer, HudTeam } from "@matchframe/hud-sdk";
import { ArmorIcon, BombIcon, EyeIcon, GrenadeIcon, KitIcon, SkullIcon } from "./Icons.tsx";
import { PlayerCam } from "./PlayerCam.tsx";

function hpClass(hp: number | null): string {
  if (hp === null) return "hp-unknown";
  if (hp <= 20) return "hp-low";
  if (hp <= 50) return "hp-mid";
  return "hp-high";
}

export function PlayerRow({ p, align }: { p: HudPlayer; align: "left" | "right" }) {
  const dead = p.alive === false;
  const weapon = p.primary ?? p.secondary;
  return (
    <div className={`mf-player mf-player-${align} ${dead ? "is-dead" : ""} ${p.observed ? "is-observed" : ""} ${(p.flashed ?? 0) > 0.4 ? "is-flashed" : ""} mf-side-${p.side ?? "none"}`}>
      <div className="mf-player-hpbar" aria-hidden>
        <div className={`mf-player-hpfill ${hpClass(p.health)}`} style={{ width: `${Math.max(0, Math.min(100, p.health ?? 0))}%` }} />
      </div>
      <div className="mf-player-main">
        <span className="mf-player-hp">{dead ? <SkullIcon size={16} /> : (p.health ?? "–")}</span>
        <span className="mf-player-name" title={p.name}>
          {p.observed ? <EyeIcon size={13} className="mf-player-eye" /> : null}
          {p.name}
        </span>
        <span className="mf-player-weapon">{dead ? "" : (weapon?.displayName ?? "")}</span>
      </div>
      <div className="mf-player-sub">
        <span className="mf-player-money">{p.money !== null ? `$${p.money}` : ""}</span>
        <span className="mf-player-kit">
          {!dead && p.armor !== null && p.armor > 0 ? <ArmorIcon helmet={!!p.helmet} size={13} /> : null}
          {!dead && p.defuseKit ? <KitIcon size={13} /> : null}
          {!dead && p.hasBomb ? <BombIcon size={13} className="mf-bomb-carrier" /> : null}
        </span>
        <span className="mf-player-nades">{dead ? null : p.grenades.map((g, i) => <GrenadeIcon key={`${g.name}-${i}`} type={g.name} size={13} />)}</span>
        <span className="mf-player-kills">
          {p.roundKills ? <b>{p.roundKills}</b> : null}
          <small>
            {p.kills ?? "–"}/{p.deaths ?? "–"}
          </small>
        </span>
      </div>
    </div>
  );
}

export function TeamPanel({ team, align }: { team: HudTeam; align: "left" | "right" }) {
  const players = [...team.players].sort((a, b) => (a.slot ?? 99) - (b.slot ?? 99));
  return (
    <div className={`mf-teampanel mf-teampanel-${align}`} style={team.color ? ({ "--mf-team": team.color } as React.CSSProperties) : undefined}>
      {players.map((p) => (
        <PlayerRow key={p.steamId} p={p} align={align} />
      ))}
    </div>
  );
}

export function ObservedPanel({ p, team }: { p: HudPlayer | null; team: HudTeam | null }) {
  if (!p) return null;
  const w = p.activeWeapon;
  return (
    <div className={`mf-observed mf-side-${p.side ?? "none"}`} style={team?.color ? ({ "--mf-team": team.color } as React.CSSProperties) : undefined}>
      <PlayerCam steamId={p.steamId} className="mf-observed-cam" />
      <div className="mf-observed-head">
        {p.avatarUrl ? <img className="mf-observed-avatar" src={p.avatarUrl} alt="" /> : null}
        <div className="mf-observed-name" title={p.name}>
          {p.name}
        </div>
        <div className="mf-observed-team">{team?.shortName ?? ""}</div>
      </div>
      <div className="mf-observed-body">
        <div className="mf-observed-vitals">
          <span className="mf-observed-hp">{p.alive === false ? "—" : (p.health ?? "–")}</span>
          <span className="mf-observed-armor">
            {p.armor !== null && p.armor > 0 ? <ArmorIcon helmet={!!p.helmet} size={18} /> : null}
            {p.armor ?? ""}
          </span>
        </div>
        <div className="mf-observed-weapon">
          <span>{w?.displayName ?? ""}</span>
          {w && w.ammoClip !== null ? (
            <span className="mf-observed-ammo">
              {w.ammoClip}
              <small>/{w.ammoReserve ?? "–"}</small>
            </span>
          ) : null}
        </div>
        <div className="mf-observed-stats">
          <span>
            K <b>{p.kills ?? "–"}</b>
          </span>
          <span>
            A <b>{p.assists ?? "–"}</b>
          </span>
          <span>
            D <b>{p.deaths ?? "–"}</b>
          </span>
          {p.adr !== null ? (
            <span>
              ADR <b>{p.adr}</b>
            </span>
          ) : null}
        </div>
        <div className="mf-observed-nades">
          {p.grenades.map((g, i) => (
            <GrenadeIcon key={`${g.name}-${i}`} type={g.name} size={18} />
          ))}
          {p.hasBomb ? <BombIcon size={18} className="mf-bomb-carrier" /> : null}
          {p.defuseKit ? <KitIcon size={18} /> : null}
        </div>
      </div>
    </div>
  );
}
