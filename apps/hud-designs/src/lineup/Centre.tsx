import { useRef } from "react";
import type { HudPlayer, HudState, HudTeam } from "@matchframe/hud-sdk";
import { equipmentValue, isLive, lossBonus, money, utilityCounts } from "../shared/format.ts";
import { ArmorIcon, BombIcon, GrenadeIcon, KitIcon, WeaponIcon } from "../shared/parts.ts";
import { Portrait, TeamBadge } from "./Badge.tsx";
import { HealthNumber, HpBar, Nades, grenadeList } from "./Cards.tsx";
import { colorOf, shortMoney, teamVars, useOutgoing, type Settings } from "./util.ts";

interface ObsView {
  name: string;
  avatarUrl: string | null;
  team: HudTeam | null;
  color: string;
  alive: boolean;
  health: number;
  armor: number;
  helmet: boolean;
  kills: number | null;
  assists: number | null;
  deaths: number | null;
  adr: number | null;
  roundKills: number;
  money: number | null;
  weapon: string | null;
  clip: number | null;
  reserve: number | null;
  nades: string;
  kit: boolean;
  bomb: boolean;
}

function view(p: HudPlayer, team: HudTeam | null, color: string): ObsView {
  const alive = p.alive !== false;
  const w = p.activeWeapon;
  return {
    name: p.name,
    avatarUrl: p.avatarUrl,
    team,
    color,
    alive,
    health: alive ? (p.health ?? 100) : 0,
    armor: p.armor ?? 0,
    helmet: !!p.helmet,
    kills: p.kills,
    assists: p.assists,
    deaths: p.deaths,
    adr: p.adr,
    roundKills: p.roundKills ?? 0,
    money: p.money,
    weapon: w?.name ?? null,
    clip: w && w.kind !== "grenade" && w.kind !== "knife" ? w.ammoClip : null,
    reserve: w ? w.ammoReserve : null,
    nades: grenadeList(p),
    kit: !!p.defuseKit,
    bomb: p.hasBomb,
  };
}

function ObsContent({ v, phase, showMoney }: { v: ObsView; phase: "in" | "out"; showMoney: boolean }) {
  return (
    <div className={`lu-obs-content is-${phase}`} style={teamVars(v.color)}>
      <span className="lu-obs-wash" aria-hidden />
      <span className="lu-obs-edge" aria-hidden />
      <div className="lu-obs-top">
        <Portrait name={v.name} avatarUrl={v.avatarUrl} className="lu-obs-portrait" />
        <div className="lu-obs-id">
          <span className="lu-obs-team">
            <i />
            <span>{v.team ? v.team.name : ""}</span>
            {v.roundKills > 0 ? <em>{`${v.roundKills}K THIS ROUND`}</em> : null}
          </span>
          <span className="lu-obs-name">{v.name}</span>
          <span className="lu-obs-stats">
            <span>
              K<b>{v.kills ?? "–"}</b>
            </span>
            <span>
              A<b>{v.assists ?? "–"}</b>
            </span>
            <span>
              D<b>{v.deaths ?? "–"}</b>
            </span>
            {v.adr !== null ? (
              <span>
                ADR<b>{v.adr}</b>
              </span>
            ) : null}
            {showMoney && v.money !== null ? <span className="lu-obs-money">{money(v.money)}</span> : null}
          </span>
        </div>
      </div>
      <div className="lu-obs-bottom">
        <div className="lu-obs-vitals">
          <HealthNumber value={v.health} className="lu-obs-hp" />
          <span className="lu-obs-unit">HP</span>
          {v.armor > 0 ? (
            <span className="lu-obs-armor">
              <ArmorIcon helmet={v.helmet} size={16} />
              {v.armor}
            </span>
          ) : null}
        </div>
        <div className="lu-obs-gear">
          <span className="lu-obs-weaponrow">
            {v.weapon ? <WeaponIcon weapon={v.weapon} className="lu-obs-weapon" /> : null}
            {v.clip !== null ? (
              <span className="lu-obs-ammo">
                {v.clip}
                <small>/{v.reserve ?? "–"}</small>
              </span>
            ) : null}
          </span>
          <span className="lu-obs-utils">
            <Nades list={v.nades} size={16} />
            {v.kit ? <KitIcon size={16} className="lu-obs-kit" /> : null}
            {v.bomb ? <BombIcon size={18} className="lu-obs-c4" /> : null}
          </span>
        </div>
      </div>
      <HpBar health={v.health} className="lu-obs-hpbar" />
    </div>
  );
}

/**
 * The observed player's panel in the middle of the card row. It rises in once the round is live
 * and drops away in freeze time; a new observed player slides in while the previous one slides out.
 */
export function ObservedPanel({ state, settings, shown }: { state: HudState; settings: Settings; shown: boolean }) {
  const p = state.observed;
  const team = p ? (state.left.players.some((x) => x.steamId === p.steamId) ? state.left : state.right.players.some((x) => x.steamId === p.steamId) ? state.right : null) : null;
  const color = team ? colorOf(team, settings) : p?.side === "T" ? settings.tColor : settings.ctColor;
  const v = p ? view(p, team, color) : null;
  const out = useOutgoing(p?.steamId ?? null, v, 140);
  return (
    <div className={`lu-obs ${shown && v ? "is-shown" : ""}`} aria-hidden={!shown}>
      {out && out.value ? <ObsContent key={`out:${out.key}`} v={out.value} phase="out" showMoney={settings.showMoney} /> : null}
      {v && p ? <ObsContent key={p.steamId} v={v} phase="in" showMoney={settings.showMoney} /> : null}
    </div>
  );
}

function Util({ team }: { team: HudTeam }) {
  const u = utilityCounts(team);
  const items: [string, number][] = [
    ["smoke", u.smoke],
    ["flashbang", u.flash],
    ["he", u.he],
    [team.side === "CT" ? "incendiary" : "molotov", u.fire],
  ];
  return (
    <span className="lu-buy-util">
      {items.map(([type, n]) => (
        <span key={type} className={n ? "" : "is-none"}>
          <GrenadeIcon type={type} size={14} />
          {n}
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
  const title = lastTitle.current;
  return (
    <div className={`lu-buy ${shown ? "is-shown" : ""}`} aria-hidden={!shown}>
      <div className="lu-buy-head">
        <span className="lu-buy-team" style={teamVars(lc)}>
          <TeamBadge team={left} className="lu-buy-badge" />
          {left.shortName || left.name}
        </span>
        <b>{title}</b>
        <span className="lu-buy-team is-right" style={teamVars(rc)}>
          {right.shortName || right.name}
          <TeamBadge team={right} className="lu-buy-badge" />
        </span>
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
    </div>
  );
}

/** Whether the freeze-time details (card economy rows, buy panel) are up rather than the live view. */
export const showsEconomy = (phase: HudState["match"]["phase"]): boolean => !isLive(phase) && phase !== "over";
