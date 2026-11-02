// MatchFrame's own HUD parts, shared with the built-in HUD renderer: weapon silhouettes (the Pro CS2
// HUD's icon set, third-party MIT: see THIRD_PARTY_NOTICES.md), grenade, bomb and defuse-kit glyphs (original MatchFrame
// shapes), and the radar (schematic outline or radar image, players, bomb and utility). Their
// look comes from each HUD's own stylesheet (classes mf-weapon, mf-icon, mf-radar-*).
export { WeaponIcon, weaponId } from "../../../hud-renderer/src/components/WeaponIcon.tsx";
export * from "../../../hud-renderer/src/components/Icons.tsx";
export { Radar } from "../../../hud-renderer/src/components/Radar.tsx";
