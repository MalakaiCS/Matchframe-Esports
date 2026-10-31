import { describe, expect, it } from "vitest";
import type { HudPlayer, HudState, HudTeam } from "@matchframe/hud-sdk";
import { deadIcon, mapArt, mapBackground, playerPicture } from "./art.ts";

const player = (steamId: string, slot: number, side: "CT" | "T", avatarUrl: string | null = null) => ({ steamId, slot, side, avatarUrl }) as HudPlayer;
const team = (key: "left" | "right", side: "CT" | "T", players: HudPlayer[]) => ({ key, side, players }) as HudTeam;

function state(art?: HudState["art"]): HudState {
  // Slots out of order on purpose: picture order follows the observer slots.
  const left = team("left", "T", [player("t3", 3, "T"), player("t1", 1, "T"), player("t2", 2, "T")]);
  const right = team("right", "CT", [player("c6", 6, "CT"), player("c7", 7, "CT", "/assets/own.png")]);
  return { left, right, art } as HudState;
}

describe("HUD images in the Matchframe Broadcast HUD", () => {
  const art: HudState["art"] = { defaultPlayers: { ct: ["/assets/ct.png"], t: ["/assets/a.png", "/assets/b.png"] }, maps: { de_inferno: { logoUrl: "/assets/inf.svg", imageUrl: "/assets/inf.jpg" } }, icons: { dead: "/assets/x.png" } };

  it("gives players without a photo their side's pictures in slot order, cycling", () => {
    const s = state(art);
    expect(["t1", "t2", "t3"].map((id) => playerPicture(s, s.left.players.find((p) => p.steamId === id)!))).toEqual(["/assets/a.png", "/assets/b.png", "/assets/a.png"]);
    expect(playerPicture(s, s.right.players[0]!)).toBe("/assets/ct.png");
    expect(playerPicture(s, s.right.players[1]!)).toBe("/assets/own.png");
    // An engine that sends no HUD images: no picture.
    expect(playerPicture(state(), state().left.players[0]!)).toBeNull();
  });

  it("finds map logos and pictures and the dead-player icon", () => {
    expect(mapArt(state(art), "de_inferno")).toEqual({ logoUrl: "/assets/inf.svg", imageUrl: "/assets/inf.jpg" });
    expect(mapArt(state(art), null)).toEqual({ logoUrl: null, imageUrl: null });
    expect(mapArt(state(), "de_inferno")).toEqual({ logoUrl: null, imageUrl: null });
    expect(deadIcon(state(art))).toBe("/assets/x.png");
    expect(deadIcon(state())).toBeNull();
    expect(mapBackground(null)).toBeUndefined();
    expect(mapBackground('/assets/a".jpg')?.backgroundImage).toContain('url("/assets/a.jpg")');
  });
});
