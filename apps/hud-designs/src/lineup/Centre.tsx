import { useRef } from "react";
import type { HudPlayer, HudState, HudTeam } from "@matchframe/hud-sdk";
import { equipmentValue, lossBonus, money, utilityCounts } from "../shared/format.ts";
import { ArmorIcon, WeaponIcon } from "../shared/parts.ts";
import { Portrait } from "./Badge.tsx";
import { HealthNumber } from "./Cards.tsx";
import { colorOf, shortMoney, teamVars, useOutgoing, type Settings } from "./util.ts";

interface ObsView {
  name: string;
  avatarUrl: string | null;
  color: string;
  health: number;
  armor: number;
  helmet: boolean;
  clip: number | null;
  reserve: number | null;
}

function view(p: HudPlayer, color: string): ObsView {
  const alive = p.alive !== false;
  const w = p.activeWeapon;
  const shoots = !!w && w.kind !== "grenade" && w.kind !== "knife" && w.kind !== "bomb";
  return {
    name: p.name,
    avatarUrl: p.avatarUrl,
    color,
    health: alive ? (p.health ?? 100) : 0,
    armor: p.armor ?? 0,
    helmet: !!p.helmet,
    clip: shoots ? w!.ammoClip : null,
    reserve: shoots ? w!.ammoReserve : null,
  };
}

function ObsContent({ v, phase }: { v: ObsView; phase: "in" | "out" }) {
  return (
    <div className={`lu-obs-content is-${phase}`} style={teamVars(v.color)}>
      <Portrait avatarUrl={v.avatarUrl} className="lu-obs-photo" />
      <div className="lu-obs-box">
        <span className="lu-obs-vitals">
          <HealthNumber value={v.health} className="lu-obs-hp" />
          {v.armor > 0 ? <ArmorIcon helmet={v.helmet} size={18} className="lu-obs-armor" /> : null}
        </span>
        <span className="lu-obs-name">{v.name}</span>
        <span className="lu-obs-ammo">
          {v.clip !== null ? (
            <>
              <b>{v.clip}</b>/{v.reserve ?? "–"}
            </>
          ) : null}
        </span>
        <span className="lu-obs-line" aria-hidden />
      </div>
    </div>
  );
}

/**
 * The observed player in the middle of the card row: the photo standing on a navy strip with
 * health and armour, name and ammunition. It rises in once the round is live and drops away in
 * freeze time; a new observed player slides in while the previous one slides out.
 */
export function ObservedPanel({ state, settings, shown }: { state: HudState; settings: Settings; shown: boolean }) {
  const p = state.observed;
  const team = p ? (state.left.players.some((x) => x.steamId === p.steamId) ? state.left : state.right.players.some((x) => x.steamId === p.steamId) ? state.right : null) : null;
  const color = team ? colorOf(team, settings) : p?.side === "T" ? settings.tColor : settings.ctColor;
  const v = p ? view(p, color) : null;
  const out = useOutgoing(p?.steamId ?? null, v, 140);
  return (
    <div className={`lu-obs ${shown && v ? "is-shown" : ""}`} aria-hidden={!shown}>
      {out && out.value ? <ObsContent key={`out:${out.key}`} v={out.value} phase="out" /> : null}
      {v && p ? <ObsContent key={p.steamId} v={v} phase="in" /> : null}
    </div>
  );
}

const UTIL: [keyof ReturnType<typeof utilityCounts>, string][] = [
  ["smoke", "weapon_smokegrenade"],
  ["flash", "weapon_flashbang"],
  ["he", "weapon_hegrenade"],
  ["fire", "weapon_molotov"],
];

function Util({ team }: { team: HudTeam }) {
  const u = utilityCounts(team);
  return (
    <span className="lu-buy-util">
      {UTIL.map(([k, icon]) => (
        <span key={k} className={u[k] ? "" : "is-none"}>
          <WeaponIcon weapon={icon} className="lu-buy-nade" />
          {u[k]}
        </span>
      ))}
    </span>
  );
}

/** Freeze-time panel in the middle: both teams' equipment, money, loss bonus and grenades. */
export function BuyPanel({ state, settings, shown }: { state: HudState; settings: Settings; shown: boolean }) {
  const { left, right } = state;
  const lc = colorOf(left, settings);
  const rc = colorOf(right, settings);
  const eqL = equipmentValue(left);
  const eqR = equipmentValue(right);
  const share = eqL + eqR > 0 ? eqL / (eqL + eqR) : 0.5;
  const cash = (t: HudTeam) => t.players.reduce((s, p) => s + (p.money ?? 0), 0);
  const bonus = (t: HudTeam) => {
    const b = lossBonus(t.consecutiveRoundLosses);
    return b === null ? "–" : money(b);
  };
  const phase = state.match.phase;
  // The title stays as it was while the panel drops away.
  const lastTitle = useRef("BUY TIME");
  if (shown) lastTitle.current = phase === "halftime" ? "HALFTIME" : phase === "warmup" ? "WARMUP" : phase.startsWith("timeout") ? "TIMEOUT" : phase === "paused" ? "PAUSED" : "BUY TIME";
  return (
    <div className={`lu-buy ${shown ? "is-shown" : ""}`} aria-hidden={!shown}>
      <div className="lu-buy-head">
        <span style={teamVars(lc)}>{left.shortName || left.name}</span>
        <b>{lastTitle.current}</b>
        <span style={teamVars(rc)}>{right.shortName || right.name}</span>
      </div>
      <div className="lu-buy-row">
        <span>{shortMoney(eqL)}</span>
        <label>EQUIPMENT</label>
        <span>{shortMoney(eqR)}</span>
      </div>
      <div className="lu-buy-split" aria-hidden>
        <i style={{ ...teamVars(lc), transform: `scaleX(${share.toFixed(3)})` }} />
        <i className="is-right" style={{ ...teamVars(rc), transform: `scaleX(${(1 - share).toFixed(3)})` }} />
      </div>
      {settings.showMoney ? (
        <div className="lu-buy-row">
          <span>{shortMoney(cash(left))}</span>
          <label>TEAM MONEY</label>
          <span>{shortMoney(cash(right))}</span>
        </div>
      ) : null}
      <div className="lu-buy-row">
        <span>{bonus(left)}</span>
        <label>LOSS BONUS</label>
        <span>{bonus(right)}</span>
      </div>
      <div className="lu-buy-row is-util">
        <Util team={left} />
        <label>UTILITY</label>
        <Util team={right} />
      </div>
      <span className="lu-buy-line" aria-hidden />
    </div>
  );
}
