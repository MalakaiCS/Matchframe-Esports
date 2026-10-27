import type { HudTeam } from "@matchframe/hud-sdk";
import { LogoCT, LogoT } from "../icons.tsx";

/** Team logo from the Matchframe team record, else the side's default logo. */
export default function TeamLogo({ team, size }: { team: Pick<HudTeam, "logoUrl" | "side" | "name"> | null; size?: number }) {
  if (!team) return null;
  return (
    <div className="logo">
      <img src={team.logoUrl ?? (team.side === "CT" ? LogoCT : LogoT)} width={size} height={size} alt="" />
    </div>
  );
}
