import type { Capability, GrenadeType, SourceCapabilities, Support } from "@matchframe/contracts";
import { emptySourceCapabilities, GRENADE_TYPES } from "@matchframe/contracts";
import type { GsiObservation } from "./gsi/normalize.ts";
import { resolveRawType } from "./utility/profiles.ts";

/**
 * Builds a source capability report from what actually arrives. Control capabilities
 * (player selection, static cameras) are not derivable from telemetry and remain "unverified"
 * here; the observer control adapter reports them separately.
 */
export class CapabilitySampler {
  private packets = 0;
  private allplayersPackets = 0;
  private playersWithState = 0;
  private playersWithPosition = 0;
  private playersWithForward = 0;
  private playerRecords = 0;
  private observedOnlyPositions = 0;
  private grenadeComponentPackets = 0;
  private grenadeRawTypes = new Map<string, number>();
  private sawEffectTime = false;
  private sawFlames = false;
  private sawReloadState = false;
  private sawAmmo = false;
  private sawPhaseCountdowns = false;
  private sawBomb = false;
  private gameBuild: string | null = null;
  private lastAt: string | null = null;
  private readonly minPackets: number;

  constructor(
    private readonly sourceId: string,
    opts: { minPackets?: number } = {},
  ) {
    this.minPackets = opts.minPackets ?? 20;
  }

  observe(obs: GsiObservation, wallClockIso: string): void {
    this.packets++;
    this.lastAt = wallClockIso;
    if (obs.gameVersion !== null) this.gameBuild = String(obs.gameVersion);
    if (obs.players) {
      this.allplayersPackets++;
      for (const p of obs.players.values()) {
        this.playerRecords++;
        if (p.presence.state) this.playersWithState++;
        if (p.position) this.playersWithPosition++;
        if (p.forward) this.playersWithForward++;
        for (const w of p.weapons ?? []) {
          if (w.state === "reloading") this.sawReloadState = true;
          if (w.ammoClip !== null) this.sawAmmo = true;
        }
      }
    } else if (obs.observed?.position) {
      this.observedOnlyPositions++;
    }
    if (obs.grenades) {
      this.grenadeComponentPackets++;
      for (const g of obs.grenades) {
        this.grenadeRawTypes.set(g.rawType, (this.grenadeRawTypes.get(g.rawType) ?? 0) + 1);
        if (g.effectTimeSec !== null && g.effectTimeSec > 0) this.sawEffectTime = true;
        if (g.flames && g.flames.length > 0) this.sawFlames = true;
      }
    }
    if (obs.phase) this.sawPhaseCountdowns = true;
    if (obs.bomb) this.sawBomb = true;
  }

  get packetCount(): number {
    return this.packets;
  }

  rawGrenadeTypes(): Record<string, number> {
    return Object.fromEntries(this.grenadeRawTypes);
  }

  private cap(key: string, support: Support, limitations: string[], precision: string | null = null): Capability {
    return {
      key,
      support,
      sourceId: this.sourceId,
      testedGameBuild: this.gameBuild,
      lastVerifiedAt: support === "unverified" ? null : this.lastAt,
      limitations,
      precision,
    };
  }

  report(): SourceCapabilities {
    const base = emptySourceCapabilities();
    if (this.packets === 0) return base;
    const enough = this.packets >= this.minPackets;
    const ratio = (n: number, d: number) => (d === 0 ? 0 : n / d);

    const allState = ratio(this.allplayersPackets, this.packets);
    const allPlayerState: Support = !enough && allState === 0 ? "unverified" : allState > 0.8 && this.playersWithState > 0 ? "supported" : allState > 0 ? "partial" : "unsupported";

    const posRatio = ratio(this.playersWithPosition, this.playerRecords);
    const playerPositions: Support =
      posRatio > 0.8 ? "supported" : posRatio > 0 || this.observedOnlyPositions > 0 ? "partial" : enough ? "unsupported" : "unverified";
    const fwdRatio = ratio(this.playersWithForward, this.playerRecords);
    const viewDirections: Support = fwdRatio > 0.8 ? "supported" : fwdRatio > 0 ? "partial" : enough ? "unsupported" : "unverified";

    const typesSeen = new Map<GrenadeType, string[]>();
    let fireAmbiguous = false;
    for (const raw of this.grenadeRawTypes.keys()) {
      const r = resolveRawType(raw);
      if (r.type === "fire_unknown") fireAmbiguous = true;
      else if (r.type !== "unknown") typesSeen.set(r.type, [...(typesSeen.get(r.type) ?? []), raw]);
    }
    const grenadeComponent = this.grenadeComponentPackets > 0;
    const anyGrenade = this.grenadeRawTypes.size > 0;

    const typeCap = (t: GrenadeType): Capability => {
      if (typesSeen.has(t)) return this.cap(`grenadeTypeSupport.${t}`, "supported", [], `raw types: ${typesSeen.get(t)!.join(", ")}`);
      if ((t === "molotov" || t === "incendiary") && fireAmbiguous) {
        return this.cap(`grenadeTypeSupport.${t}`, "partial", [
          "Source fire type does not distinguish Molotov from incendiary; resolved from thrower inventory delta (derived) or thrower side (estimated).",
        ]);
      }
      if (!grenadeComponent && enough) return this.cap(`grenadeTypeSupport.${t}`, "unsupported", ["grenades component never received"]);
      return this.cap(`grenadeTypeSupport.${t}`, "unverified", ["type not yet observed in this feed"]);
    };

    return {
      ...base,
      allPlayerState: this.cap("allPlayerState", allPlayerState, allPlayerState === "supported" ? [] : ["all-player component missing in some or all packets"]),
      playerPositions: this.cap("playerPositions", playerPositions, playerPositions === "supported" ? [] : ["positions missing for some players"], "GSI position string at source throttle rate"),
      viewDirections: this.cap("viewDirections", viewDirections, viewDirections === "supported" ? [] : ["forward vectors missing for some players"]),
      weaponReadiness: this.cap(
        "weaponReadiness",
        this.sawAmmo ? "partial" : enough ? "unsupported" : "unverified",
        [
          "Active weapon and ammo only; flash recovery time and stop/strafe state are not reported.",
          ...(this.sawReloadState ? [] : ["Reload state not observed in this feed."]),
        ],
      ),
      exactDamageEvents: this.cap("exactDamageEvents", "unsupported", [
        "GSI reports health and cumulative round damage only; attacker/victim/weapon per hit is not reported. Requires an authorized server-event adapter.",
      ]),
      exactKillEvents: this.cap("exactKillEvents", "unsupported", [
        "GSI reports cumulative kill/death counters; ordered killfeed, weapon, headshot victim and assists are not reported.",
      ]),
      grenadeEntities: this.cap(
        "grenadeEntities",
        anyGrenade ? "supported" : grenadeComponent ? "unverified" : enough ? "unsupported" : "unverified",
        anyGrenade ? [] : ["no grenade has been observed yet"],
      ),
      grenadeLifecycle: this.cap(
        "grenadeLifecycle",
        anyGrenade ? "partial" : enough && !grenadeComponent ? "unsupported" : "unverified",
        ["No explicit detonation events in GSI; activation inferred from effect time, fire areas, rest state or removal (removal is not proof of detonation)."],
      ),
      utilityEffects: this.cap(
        "utilityEffects",
        this.sawEffectTime || this.sawFlames ? "partial" : "unverified",
        [
          ...(this.sawFlames ? [] : ["fire patch positions not yet observed"]),
          ...(this.sawEffectTime ? [] : ["effect time not yet observed"]),
          "Smoke extent and exact expiry are estimated.",
        ],
      ),
      grenadeTypeSupport: {
        he: typeCap("he"),
        flashbang: typeCap("flashbang"),
        smoke: typeCap("smoke"),
        molotov: typeCap("molotov"),
        incendiary: typeCap("incendiary"),
        decoy: typeCap("decoy"),
      },
      grenadeDamageAttribution: this.cap("grenadeDamageAttribution", "unsupported", [
        "Health loss near a detonation is a derived correlation only; attribution requires exact damage events.",
      ]),
      matchTimelineTime: this.cap(
        "matchTimelineTime",
        "partial",
        [
          "Provider timestamp has 1 s resolution; canonical match time is ingest-based and pause-aware, not tick-aligned.",
          ...(this.sawPhaseCountdowns ? [] : ["phase countdowns not observed"]),
        ],
      ),
    };
  }

  summary(): Record<string, unknown> {
    return {
      packets: this.packets,
      allplayersPackets: this.allplayersPackets,
      grenadeComponentPackets: this.grenadeComponentPackets,
      grenadeRawTypes: this.rawGrenadeTypes(),
      sawEffectTime: this.sawEffectTime,
      sawFlames: this.sawFlames,
      sawReloadState: this.sawReloadState,
      sawPhaseCountdowns: this.sawPhaseCountdowns,
      sawBomb: this.sawBomb,
      gameBuild: this.gameBuild,
      grenadeTypes: GRENADE_TYPES,
    };
  }
}
