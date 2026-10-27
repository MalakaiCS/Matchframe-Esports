import type { HudState } from "@matchframe/hud-sdk";
import { ArmorFull, ArmorHelmet, Bullets, HealthFull } from "../icons.tsx";
import { grenadesOf, sideClass } from "../util.ts";
import "../styles/observed.scss";
import { Avatar } from "./Players.tsx";
import TeamLogo from "./TeamLogo.tsx";
import Weapon from "./Weapon.tsx";

function Statistic({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="stat">
      <div className="label">{label}</div>
      <div className="value">{value}</div>
    </div>
  );
}

const regionNames = typeof Intl !== "undefined" && "DisplayNames" in Intl ? new Intl.DisplayNames(["en"], { type: "region" }) : null;

/** The observed player (bottom centre): avatar, team, grenades, health, armour, K/A/D and ammo. */
export default function Observed({ state }: { state: HudState }) {
  const p = state.observed;
  if (!p) return null;
  const team = state.left.players.some((x) => x.steamId === p.steamId) ? state.left : state.right;
  const weapon = p.activeWeapon;
  const k = p.kills ?? 0;
  const d = p.deaths ?? 0;
  const ratio = d === 0 ? k : k / d;
  const country = p.countryCode && regionNames ? (() => {
    try {
      return regionNames.of(p.countryCode.toUpperCase()) ?? null;
    } catch {
      return null;
    }
  })() : null;
  return (
    <div className={`observed ${sideClass(p.side)}`}>
      <div className="main_row">
        <Avatar url={p.avatarUrl} size={140} />
        <TeamLogo team={team} size={35} />
        <div className="username_container">
          <div className="username">{p.name}</div>
          <div className="real_name">{country ?? ""}</div>
        </div>
        <div className="grenade_container">
          {grenadesOf(p).map((g, i) => (
            <Weapon key={`${g.name}-${i}`} weapon={g.name} active={g.active} isGrenade />
          ))}
        </div>
      </div>
      <div className="stats_row">
        <div className="health_armor_container">
          <div className="health-icon icon">
            <HealthFull />
          </div>
          <div className="health text">{p.health ?? "–"}</div>
          <div className="armor-icon icon">{p.helmet ? <ArmorHelmet /> : <ArmorFull />}</div>
          <div className="health text">{p.armor ?? "–"}</div>
        </div>
        <div className="statistics">
          <Statistic label="K" value={p.kills ?? "–"} />
          <Statistic label="A" value={p.assists ?? "–"} />
          <Statistic label="D" value={p.deaths ?? "–"} />
          <Statistic label="K/D" value={p.kills === null ? "–" : ratio.toFixed(2)} />
        </div>
        <div className="ammo">
          <div className="ammo_icon_container">
            <Bullets />
          </div>
          <div className="ammo_counter">
            <div className="ammo_clip">{weapon?.ammoClip ?? "-"}</div>
            <div className="ammo_reserve">/{weapon?.ammoReserve ?? "-"}</div>
          </div>
        </div>
      </div>
    </div>
  );
}
