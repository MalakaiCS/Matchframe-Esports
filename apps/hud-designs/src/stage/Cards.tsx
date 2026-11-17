import { memo } from "react";
import type { HudPlayer, HudState, HudTeam } from "@matchframe/hud-sdk";
import { deadIcon, playerPicture } from "../shared/art.ts";
import { FitText, Photo } from "./bits.tsx";
import { Armor, Bomb, DeadMark, Deaths, Disconnected, Dollar, Grenade, Health, Kills, Kit, RoundKillMark, Weapon } from "./icons.tsx";
import { mvpShowing, slotKey, slotOrder, teamName, teamVars, type Settings } from "./util.ts";
import { mainWeaponName } from "./weapons.ts";

const NADE_ORDER = ["smoke", "flash", "hegrenade", "molotov", "incgrenade", "decoy"];

/** A player's grenades as a stable comma list, one entry per grenade (two flashbangs show twice), at most four. */
export function grenadeList(p: HudPlayer): string {
  const out: string[] = [];
  for (const g of p.grenades) {
    const n = g.name.includes("flash") ? Math.min(2, Math.max(1, g.ammoReserve ?? 1)) : 1;
    for (let i = 0; i < n; i++) out.push(g.name.startsWith("weapon_") ? g.name : `weapon_${g.name}`);
  }
  const rank = (n: string) => {
    const i = NADE_ORDER.findIndex((k) => n.includes(k));
    return i < 0 ? 99 : i;
  };
  return out
    .sort((a, b) => rank(a) - rank(b))
    .slice(0, 4)
    .join(",");
}

export function Nades({ list, size = 15 }: { list: string; size?: number }) {
  if (!list) return null;
  return (
    <span className="st-nades">
      {list.split(",").map((g, i) => (
        <Grenade key={`${g}-${i}`} type={g} size={size} />
      ))}
    </span>
  );
}

/** Kills and deaths with their marks. */
function KillsDeaths({ kills, deaths }: { kills: number | null; deaths: number | null }) {
  return (
    <span className="st-card-kd">
      <span>
        <Kills size={16} />
        <b>{kills ?? "–"}</b>
      </span>
      <span>
        <Deaths size={16} />
        <b>{deaths ?? "–"}</b>
      </span>
    </span>
  );
}

/** Money: the dollar sign light, the amount green. */
const Money = ({ value }: { value: number | null }) => (
  <span className="st-card-money">
    <Dollar />
    {value === null ? "–" : value.toLocaleString("en-US")}
  </span>
);

interface CardProps {
  name: string;
  slot: string;
  picture: string | null;
  deadIcon: string | null;
  color: string;
  align: "left" | "right";
  alive: boolean;
  /** Gone from the game data (left the server): the card dims with the disconnected mark. */
  offline: boolean;
  health: number;
  armor: number;
  helmet: boolean;
  kit: boolean;
  bomb: boolean;
  money: number | null;
  kills: number | null;
  deaths: number | null;
  roundKills: number;
  /** The one weapon shown: the main gun, whatever is in hand. */
  main: string | null;
  nades: string;
  observed: boolean;
  flashed: number;
  showMoney: boolean;
  index: number;
}

/**
 * One player card, from the screen edge: the slot number on a strip in the team's colour, name with
 * kills and deaths and money, the photo, the weapons with the grenades under them, and the health as a
 * big number with the armour and the kit or bomb under it. The card is filled with the team's colour
 * as far as the player's health (the rest grey; a light trail follows a hit). Dead: the card shrinks to
 * the name and photo, grey, with a skull beside the photo; kills, deaths and money stay. Every prop is a
 * primitive, so React.memo skips cards whose content is unchanged.
 */
const Card = memo(function Card(p: CardProps) {
  const dead = !p.alive;
  const hp = dead ? 0 : Math.max(0, Math.min(100, p.health));
  return (
    <div className={`st-card st-card-${p.align} ${dead ? "is-dead" : ""} ${p.offline && !dead ? "is-offline" : ""} ${p.observed ? "is-observed" : ""}`} style={{ ...teamVars(p.color), ["--i" as string]: p.index }}>
      <span className="st-card-shape" aria-hidden>
        <i className="st-card-trail" style={{ transform: `scaleX(${hp / 100})` }} />
        <i className="st-card-fill" style={{ transform: `scaleX(${hp / 100})` }} />
      </span>
      {p.roundKills > 0 ? (
        <span className="st-card-rk" aria-label={`${p.roundKills} kills this round`}>
          {Array.from({ length: Math.min(5, p.roundKills) }, (_, i) => (
            <RoundKillMark key={i} />
          ))}
        </span>
      ) : null}
      <span className="st-card-slot">{p.slot}</span>
      <span className="st-card-info">
        <FitText text={p.name} className="st-card-name" />
        <KillsDeaths kills={p.kills} deaths={p.deaths} />
        {p.showMoney ? <Money value={p.money} /> : null}
      </span>
      <span className="st-card-pic">
        <Photo url={p.picture} />
        <span className="st-card-flash" style={{ opacity: dead ? 0 : Math.min(1, p.flashed) * 0.8 }} aria-hidden />
      </span>
      <span className="st-card-gear">
        <span className="st-card-guns">{p.main ? <Weapon weapon={p.main} className="st-gun" /> : null}</span>
        <span className={`st-card-hp st-digits ${p.health <= 20 ? "is-low" : ""}`}>{dead ? "" : p.health}</span>
        <span className="st-card-util">
          <Nades list={p.nades} size={19} />
        </span>
        <span className="st-card-kit">
          {p.bomb ? <Bomb size={21} className="st-c4" /> : p.kit ? <Kit size={19} className="st-kit" /> : null}
          {p.armor > 0 ? <Armor helmet={p.helmet} size={20} className="st-armor" /> : null}
        </span>
      </span>
      {p.offline && !dead ? (
        <span className="st-card-offline">
          <Disconnected size={24} />
        </span>
      ) : null}
      <span className={`st-card-skull ${p.deadIcon ? "is-art" : ""}`} aria-hidden>
        {p.deadIcon ? <img src={p.deadIcon} alt="" /> : <DeadMark size={42} />}
      </span>
    </div>
  );
});

interface MvpProps {
  name: string;
  slot: string;
  picture: string | null;
  color: string;
  align: "left" | "right";
  roundNumber: number;
  kills: number;
  damage: number;
  health: number;
  armor: number;
  helmet: boolean;
}

/**
 * The previous round's key player, in place of their card: ROUND MVP, the name large, the round's
 * kills and damage, health and armour at the round's end, and the player's picture standing on the
 * card (a cut-out PNG looks best; a square photo fades out at its foot). The slot number sits on a
 * team-colour strip on the card's inner edge.
 */
const MvpCard = memo(function MvpCard(p: MvpProps) {
  return (
    <div className={`st-mvp st-mvp-${p.align}`} style={teamVars(p.color)}>
      <span className="st-mvp-body" aria-hidden />
      <span className="st-mvp-pic">
        <Photo url={p.picture} />
      </span>
      <span className="st-mvp-text">
        <span className="st-mvp-head">ROUND MVP</span>
        <FitText text={p.name} className="st-mvp-name" />
        <span className="st-mvp-round">ROUND {p.roundNumber} STATS</span>
        <span className="st-mvp-stats">
          <Kills size={21} />
          <b className="st-digits">{p.kills}</b>
          <i className="st-mvp-sep" />
          <span className="st-mvp-dmg st-digits">DMG</span>
          <b className="st-digits">{p.damage}</b>
        </span>
        <span className="st-mvp-hp">
          <Health size={19} />
          <b className="st-digits">{p.health}</b>
          {p.armor > 0 ? <Armor helmet={p.helmet} size={21} /> : null}
        </span>
      </span>
      <span className="st-mvp-slot">{p.slot}</span>
    </div>
  );
});

function cardProps(state: HudState, p: HudPlayer, color: string, align: "left" | "right", showMoney: boolean, index: number): CardProps {
  const alive = p.alive !== false;
  return {
    name: p.name,
    slot: slotKey(p.slot),
    picture: playerPicture(state, p),
    deadIcon: deadIcon(state),
    color,
    align,
    alive,
    offline: p.alive === null,
    health: p.health ?? (alive ? 100 : 0),
    armor: alive ? (p.armor ?? 0) : 0,
    helmet: !!p.helmet,
    kit: alive && !!p.defuseKit,
    bomb: alive && p.hasBomb,
    money: p.money,
    kills: p.kills,
    deaths: p.deaths,
    roundKills: p.roundKills ?? 0,
    main: mainWeaponName(p),
    nades: alive ? grenadeList(p) : "",
    observed: p.observed,
    flashed: Math.round((p.flashed ?? 0) * 10) / 10,
    showMoney,
    index,
  };
}

/**
 * One side's team tab and five cards in slot order (the right side mirrored), bottom-aligned: the
 * round MVP's tall card pushes the cards above it up and the cards below keep their places.
 */
export function TeamCards({ state, team, color, align, settings, shown }: { state: HudState; team: HudTeam; color: string; align: "left" | "right"; settings: Settings; shown: boolean }) {
  const mvp = settings.showMvp && mvpShowing(state) ? state.lastRound!.mvp! : null;
  return (
    <div className={`st-cards st-cards-${align} ${shown ? "is-on" : ""}`} style={teamVars(color)}>
      <div className="st-tab">
        <FitText text={teamName(team, settings)} className="st-tab-name" />
      </div>
      {slotOrder(team).map((p, i) =>
        mvp && p.steamId === mvp.steamId ? (
          <MvpCard key={`mvp-${p.steamId}-${state.lastRound!.roundNumber}`} name={p.name} slot={slotKey(p.slot)} picture={playerPicture(state, p)} color={color} align={align} roundNumber={state.lastRound!.roundNumber} kills={mvp.kills} damage={mvp.damage} health={mvp.health} armor={mvp.armor} helmet={mvp.helmet} />
        ) : (
          <Card key={p.steamId} {...cardProps(state, p, color, align, settings.showMoney, i)} />
        ),
      )}
    </div>
  );
}
