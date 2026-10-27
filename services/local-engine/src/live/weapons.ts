import type { WeaponState } from "@matchframe/contracts";
import type { HudWeapon } from "@matchframe/hud-sdk";

const NAMES: Record<string, string> = {
  weapon_ak47: "AK-47",
  weapon_m4a1: "M4A4",
  weapon_m4a1_silencer: "M4A1-S",
  weapon_awp: "AWP",
  weapon_ssg08: "SSG 08",
  weapon_aug: "AUG",
  weapon_sg556: "SG 553",
  weapon_famas: "FAMAS",
  weapon_galilar: "Galil AR",
  weapon_g3sg1: "G3SG1",
  weapon_scar20: "SCAR-20",
  weapon_mp9: "MP9",
  weapon_mac10: "MAC-10",
  weapon_mp7: "MP7",
  weapon_mp5sd: "MP5-SD",
  weapon_ump45: "UMP-45",
  weapon_p90: "P90",
  weapon_bizon: "PP-Bizon",
  weapon_nova: "Nova",
  weapon_xm1014: "XM1014",
  weapon_mag7: "MAG-7",
  weapon_sawedoff: "Sawed-Off",
  weapon_negev: "Negev",
  weapon_m249: "M249",
  weapon_glock: "Glock-18",
  weapon_hkp2000: "P2000",
  weapon_usp_silencer: "USP-S",
  weapon_p250: "P250",
  weapon_elite: "Dual Berettas",
  weapon_fiveseven: "Five-SeveN",
  weapon_tec9: "Tec-9",
  weapon_cz75a: "CZ75-Auto",
  weapon_deagle: "Desert Eagle",
  weapon_revolver: "R8 Revolver",
  weapon_taser: "Zeus x27",
  weapon_hegrenade: "HE Grenade",
  weapon_flashbang: "Flashbang",
  weapon_smokegrenade: "Smoke Grenade",
  weapon_molotov: "Molotov",
  weapon_incgrenade: "Incendiary",
  weapon_decoy: "Decoy",
  weapon_c4: "C4",
};

export function displayWeaponName(name: string): string {
  if (NAMES[name]) return NAMES[name]!;
  if (name.startsWith("weapon_knife") || name.startsWith("weapon_bayonet")) return "Knife";
  return name.replace(/^weapon_/, "").replace(/_/g, " ").toUpperCase();
}

export function weaponKind(w: WeaponState): HudWeapon["kind"] {
  const t = (w.type ?? "").toLowerCase();
  if (w.name === "weapon_c4" || t === "c4") return "bomb";
  if (w.name === "weapon_taser") return "taser";
  if (t === "knife" || w.name.includes("knife") || w.name.includes("bayonet")) return "knife";
  if (t === "grenade") return "grenade";
  if (t === "pistol") return "secondary";
  if (["rifle", "sniperrifle", "submachine gun", "machine gun", "shotgun"].includes(t)) return "primary";
  return "other";
}

export function toHudWeapon(w: WeaponState): HudWeapon {
  return {
    name: w.name,
    displayName: displayWeaponName(w.name),
    kind: weaponKind(w),
    active: w.state === "active" || w.state === "reloading",
    ammoClip: w.ammoClip,
    ammoClipMax: w.ammoClipMax,
    ammoReserve: w.ammoReserve,
  };
}
