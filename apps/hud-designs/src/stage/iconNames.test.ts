import { describe, expect, it } from "vitest";
import { bundledLookup, killCandidates, packIconUrl, packLookup, weaponCandidates, weaponIconName } from "./iconNames.ts";

describe("Stage HUD icon resolver", () => {
  it("maps game item names to icon names", () => {
    expect(weaponIconName("weapon_ak47")).toBe("ak47");
    expect(weaponIconName("weapon_m4a1_silencer")).toBe("m4a1_silencer");
    expect(weaponIconName("weapon_usp_silencer")).toBe("usp_silencer");
    expect(weaponIconName("item_defuser")).toBe("defuser");
    expect(weaponIconName("weapon_knife_default_t")).toBe("knife_t");
    expect(weaponIconName("weapon_knife_karambit")).toBe("knife_karambit");
    expect(weaponCandidates("weapon_knife_kukri")).toEqual(["knife_kukri", "knife"]);
    expect(weaponCandidates("weapon_bayonet")).toEqual(["bayonet", "knife"]);
    expect(weaponCandidates("weapon_m4a1_silencer_off")).toEqual(["m4a1_silencer_off", "m4a1_silencer"]);
    expect(weaponCandidates("weapon_hkp2000")).toEqual(["hkp2000", "p2000"]);
    // Fire and grenade kills show the fire or blast mark first.
    expect(killCandidates("weapon_inferno")).toEqual(["fire_damage", "inferno"]);
    expect(killCandidates("hegrenade")).toEqual(["explosion", "hegrenade"]);
    expect(killCandidates("weapon_awp")).toEqual(["awp"]);
  });

  it("uses the pack's icon when it has it, the next candidate, else none (the HUD's own icon)", () => {
    const pack = packLookup({ names: ["ak47", "knife", "kill"], base: "/icon-pack/" });
    expect(packIconUrl(pack, "ak47")).toBe("/icon-pack/ak47.svg");
    expect(packIconUrl(pack, ...weaponCandidates("weapon_knife_butterfly"))).toBe("/icon-pack/knife.svg");
    // The pack lacks it: no URL, so the bundled MIT or MatchFrame's own icon is drawn.
    expect(packIconUrl(pack, "awp")).toBeNull();
    expect(packIconUrl(pack, "kill_headshot")).toBeNull();
    // No pack at all (or an empty one).
    expect(packIconUrl(packLookup(null), "ak47")).toBeNull();
    expect(packIconUrl(packLookup({ names: [], base: "/icon-pack/" }), "ak47")).toBeNull();
  });

  it("puts the owner's bundled icons first, the loaded pack for what they lack, and the most specific name first", () => {
    const owner = bundledLookup({ ak47: "./assets/ak47.png", knife: "./assets/knife.png", kills: "./assets/kills.png" });
    const pack = packLookup({ names: ["ak47", "awp", "knife_karambit", "kill", "star"], base: "/icon-pack/" });
    const sets = [owner, pack];
    expect(packIconUrl(sets, "ak47")).toBe("./assets/ak47.png");
    expect(packIconUrl(sets, "awp")).toBe("/icon-pack/awp.svg");
    // A karambit is the pack's karambit, not the owner's plain knife; another knife is the owner's knife.
    expect(packIconUrl(sets, ...weaponCandidates("weapon_knife_karambit"))).toBe("/icon-pack/knife_karambit.svg");
    expect(packIconUrl(sets, ...weaponCandidates("weapon_knife_kukri"))).toBe("./assets/knife.png");
    // The owner's name for a mark before the game's.
    expect(packIconUrl(sets, "kills", "kill")).toBe("./assets/kills.png");
    expect(packIconUrl(sets, "star")).toBe("/icon-pack/star.svg");
    // Neither: the HUD's own.
    expect(packIconUrl(sets, "healthshot")).toBeNull();
    expect(packIconUrl([owner, null], "awp")).toBeNull();
  });
});
