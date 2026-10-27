import type { HudSide, HudState, HudTeam } from "@matchframe/hud-sdk";
import { lossBonus, money, sum, utilitySummary } from "../util.ts";
import "../styles/sideboxes.scss";
import Weapon from "./Weapon.tsx";

function utilityState(amount: number) {
  if (amount === 20) return "Full";
  if (amount > 14) return "Great";
  if (amount > 9) return "Good";
  if (amount > 5) return "Low";
  if (amount > 0) return "Poor";
  return "None";
}

function utilityColor(amount: number) {
  if (amount === 20) return "#22f222";
  if (amount > 14) return "#32f218";
  if (amount > 9) return "#8ef218";
  if (amount > 5) return "#f29318";
  if (amount > 0) return "#f25618";
  return "#f21822";
}

function GrenadeContainer({ grenade, amount }: { grenade: string; amount: number }) {
  return (
    <div className="grenade_container">
      <div className="grenade_image">
        <Weapon weapon={grenade} active={false} isGrenade />
      </div>
      <div className="grenade_amount">x{amount}</div>
    </div>
  );
}

function UtilityLevel({ team, show }: { team: HudTeam; show: boolean }) {
  const g = utilitySummary(team.players);
  const total = g.smokes + g.inc + g.flashes + g.hg;
  const side: HudSide = team.side ?? "CT";
  return (
    <div className={`utilitybox ${side} ${show ? "show" : "hide"}`}>
      <div className="title_container">
        <div className="title">Utility Level -&nbsp;</div>
        <div className="subtitle" style={{ color: utilityColor(total) }}>
          {utilityState(total)}
        </div>
      </div>
      <div className="grenades_container">
        <GrenadeContainer grenade="smokegrenade" amount={g.smokes} />
        <GrenadeContainer grenade={side === "CT" ? "incgrenade" : "molotov"} amount={g.inc} />
        <GrenadeContainer grenade="flashbang" amount={g.flashes} />
        <GrenadeContainer grenade="hegrenade" amount={g.hg} />
      </div>
    </div>
  );
}

function MoneyBox({ team, orientation, show }: { team: HudTeam; orientation: "left" | "right"; show: boolean }) {
  const loss = lossBonus(team);
  const side = team.side ?? "CT";
  const steps = loss === null ? 0 : (loss - 1400) / 500;
  return (
    <div className={`moneybox ${orientation} ${side} ${show ? "show" : "hide"}`}>
      <div className="loss_container">
        {[4, 3, 2, 1].map((n) => (
          <div key={n} className={`loss-box ${side} ${steps >= n ? "active" : ""}`} />
        ))}
      </div>
      <div className="money_container">
        <div className="title">Loss Bonus</div>
        <div className="value">{loss === null ? "—" : money(loss)}</div>
      </div>
      <div className="money_container">
        <div className="title">Team Money</div>
        <div className="value">{money(sum(team.players, (p) => p.money))}</div>
      </div>
      <div className="money_container">
        <div className="title">Equipment Value</div>
        <div className="value">{money(sum(team.players, (p) => p.equipValue))}</div>
      </div>
    </div>
  );
}

/** Utility level and team economy beside the player lists, shown during freeze time. */
export default function SideBoxes({ state, show }: { state: HudState; show: boolean }) {
  return (
    <>
      <div className="boxes left">
        <UtilityLevel team={state.left} show={show} />
        <MoneyBox team={state.left} orientation="left" show={show} />
      </div>
      <div className="boxes right">
        <UtilityLevel team={state.right} show={show} />
        <MoneyBox team={state.right} orientation="right" show={show} />
      </div>
    </>
  );
}
