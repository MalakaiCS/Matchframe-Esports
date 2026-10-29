import type { PlayerState } from "@matchframe/contracts";
import { Badge } from "../../components/ui.tsx";
import { fmtMoney, grenadeAbbr, MISSING, weaponName } from "../../lib/format.ts";
import { slotKey } from "../../lib/players.ts";

export type PovRole = "confirmed" | "pending" | "desired";

const LIFE: Record<string, { text: string; tone: "ok" | "danger" | "warn" | "neutral" }> = {
  alive: { text: "ALIVE", tone: "ok" },
  dead: { text: "DEAD", tone: "danger" },
  disconnected: { text: "DISCONNECTED", tone: "warn" },
  unknown: { text: "LIFE ?", tone: "neutral" },
};

function n(v: number | null | undefined): string {
  return typeof v === "number" ? String(v) : MISSING;
}

/** True when the source supplied none of the per-player vitals (spectator feed without allplayers). */
export function telemetryMissing(p: PlayerState): boolean {
  return p.health === null && p.armor === null && p.money === null && p.activeWeapon === null && p.weapons.length === 0;
}

export function RosterCard({ p, roles, onRequest, disabledReason, busy }: { p: PlayerState; roles: PovRole[]; onRequest: (chase: boolean) => void; disabledReason: string | null; busy: boolean }) {
  const life = LIFE[p.lifeState] ?? LIFE.unknown!;
  const missing = telemetryMissing(p);
  const grenades = p.weapons.filter((w) => (w.type ?? "").toLowerCase() === "grenade");
  const hasBomb = p.weapons.some((w) => /c4/i.test(w.name));
  const w = p.activeWeapon;
  const dead = p.lifeState === "dead";
  const reason = disabledReason ?? (dead ? "Player is dead — their POV cannot be selected" : null);
  const key = slotKey(p.observerKey);
  const hp = p.health;
  const flashed = typeof p.flashed === "number" && p.flashed > 0.05 ? p.flashed : null;
  return (
    <button
      type="button"
      className={`pcard side-${p.side ?? "none"} ${dead ? "is-dead" : ""} ${roles.includes("confirmed") ? "is-onair" : ""} ${roles.includes("pending") ? "is-pending" : ""}`}
      onClick={(e) => onRequest(e.shiftKey)}
      aria-disabled={reason !== null || busy}
      disabled={busy}
      title={reason ?? `Request this player's POV on the observer client${key ? ` (key ${key})` : ""}. Shift-click for the chase view. This card shows telemetry, not a video feed.`}
      aria-label={`${p.name}, ${p.side ?? "no side"}, ${life.text}. ${reason ?? "Activate to request this POV."}`}
    >
      <div className="pcard-head">
        <span className="pcard-slot" aria-hidden>
          {key ?? "·"}
        </span>
        <span className="pcard-name">{p.name}</span>
        {p.lifeState !== "alive" ? <Badge tone={life.tone}>{life.text}</Badge> : null}
      </div>
      {missing ? (
        <div className="pcard-missing">
          <Badge tone="warn" icon="?">
            TELEMETRY MISSING
          </Badge>
          <span>The source does not report this player's vitals.</span>
        </div>
      ) : (
        <>
          <div className="pcard-vitals">
            <div className="hpbar" title={hp === null ? "Health not reported" : `Health ${hp}`}>
              <div className={`hpbar-fill ${hp !== null && hp <= 25 ? "is-low" : ""}`} style={{ width: `${hp ?? 0}%` }} />
              <span className="hpbar-text">HP {n(hp)}</span>
            </div>
            <span className="pcard-armor" title="Armor (H = helmet)">
              AR {n(p.armor)}
              {p.helmet ? "+H" : ""}
            </span>
          </div>
          <div className="pcard-row">
            <span className="pcard-weapon" title={w ? `${w.name} (${w.state})` : "Active weapon not reported"}>
              {w ? weaponName(w.name) : MISSING}
              {w && w.ammoClip !== null ? <span className="pcard-ammo">{` ${w.ammoClip}/${n(w.ammoReserve)}`}</span> : null}
              {w?.state === "reloading" ? <Badge tone="info">RELOADING</Badge> : null}
            </span>
            <span className="pcard-money">{fmtMoney(p.money)}</span>
          </div>
          <div className="pcard-row pcard-util">
            <span title="Grenades carried">{grenades.map((g) => grenadeAbbr(g.name)).join(" ")}</span>
            <span>
              {hasBomb ? <Badge tone="warn">C4</Badge> : null}
              {p.defuseKit ? <Badge tone="info">KIT</Badge> : null}
            </span>
          </div>
        </>
      )}
      <div className="pcard-foot">
        <span className="pcard-stats" title="Kills / assists / deaths (cumulative counters)">
          K {n(p.matchStats.kills)} · A {n(p.matchStats.assists)} · D {n(p.matchStats.deaths)}
          {typeof p.roundKills === "number" && p.roundKills > 0 ? ` · ${p.roundKills}K this round` : ""}
        </span>
        <span className="pcard-flags">
          {flashed !== null ? (
            <Badge tone="warn" icon="✺">
              FLASHED {Math.round(flashed * 100)}%
            </Badge>
          ) : null}
          {roles.includes("confirmed") ? (
            <Badge tone="ok" icon="●">
              ON AIR
            </Badge>
          ) : null}
          {roles.includes("pending") ? (
            <Badge tone="info" icon="…">
              PENDING
            </Badge>
          ) : null}
          {roles.includes("desired") && !roles.includes("confirmed") ? (
            <Badge tone="accent" icon="★">
              DIRECTOR PICK
            </Badge>
          ) : null}
        </span>
      </div>
    </button>
  );
}
