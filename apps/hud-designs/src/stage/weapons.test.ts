import { describe, expect, it } from "vitest";
import type { HudWeapon } from "@matchframe/hud-sdk";
import { ammoWeapon, mainWeaponName } from "./weapons.ts";

const w = (name: string, kind: HudWeapon["kind"], clip: number | null = null): HudWeapon => ({ name: `weapon_${name}`, displayName: name, kind, active: false, ammoClip: clip, ammoClipMax: clip, ammoReserve: clip === null ? null : 60 });
const ak = w("ak47", "primary", 30);
const glock = w("glock", "secondary", 20);
const knife = w("knife", "knife");
const flash = w("flashbang", "grenade");
const zeus = w("taser", "taser", 1);

describe("Stage HUD: the card's one weapon and the observed player's ammunition", () => {
  it("shows the rifle while it is held", () => {
    const p = { alive: true, primary: ak, secondary: glock, activeWeapon: ak };
    expect(mainWeaponName(p)).toBe("weapon_ak47");
    expect(ammoWeapon(p)?.name).toBe("weapon_ak47");
  });

  it("keeps the rifle when the knife is held, and its ammunition", () => {
    const p = { alive: true, primary: ak, secondary: glock, activeWeapon: knife };
    expect(mainWeaponName(p)).toBe("weapon_ak47");
    expect(ammoWeapon(p)?.name).toBe("weapon_ak47");
  });

  it("shows the pistol when that is all they have, also while holding the pistol next to a rifle the ammo follows the hand", () => {
    expect(mainWeaponName({ alive: true, primary: null, secondary: glock, activeWeapon: knife })).toBe("weapon_glock");
    const both = { alive: true, primary: ak, secondary: glock, activeWeapon: glock };
    expect(mainWeaponName(both)).toBe("weapon_ak47");
    expect(ammoWeapon(both)?.name).toBe("weapon_glock");
  });

  it("shows the knife with nothing else, the Zeus when that is all, and nothing for the dead", () => {
    const bare = { alive: true, primary: null, secondary: null, activeWeapon: knife };
    expect(mainWeaponName(bare)).toBe("weapon_knife");
    expect(ammoWeapon(bare)).toBeNull();
    expect(mainWeaponName({ alive: true, primary: null, secondary: null, activeWeapon: zeus })).toBe("weapon_taser");
    expect(mainWeaponName({ alive: false, primary: null, secondary: null, activeWeapon: null })).toBeNull();
  });

  it("keeps the main gun while a grenade is held, with the gun's ammunition", () => {
    const p = { alive: true, primary: null, secondary: glock, activeWeapon: flash };
    expect(mainWeaponName(p)).toBe("weapon_glock");
    expect(ammoWeapon(p)?.name).toBe("weapon_glock");
  });
});
