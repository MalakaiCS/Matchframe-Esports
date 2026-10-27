import type { IconName } from "../components/icons.tsx";

/** /use-cases: who Matchframe is designed for. No invented customers, logos or numbers. */
export interface UseCase {
  id: string;
  title: string;
  icon: IconName;
  intro: string;
  helps: string[];
  setup: string;
  features: { slug: string; label: string }[];
}

export const USE_CASES: UseCase[] = [
  {
    id: "tournament-organisers",
    title: "Tournament organisers",
    icon: "trophy",
    intro: "Run a multi-day event with several matches a day and a small crew, and keep graphics, vetoes and sponsors consistent from the first match to the final.",
    helps: [
      "Captains veto from their own links while the HUD shows the result live.",
      "Sponsor rotations run in safe windows and every display is logged for your partners.",
      "Standings and brackets feed the studio graphics between matches.",
      "The Observer can cover live matches while your human observer focuses on the key moments.",
      "On the top plan, Full Action Observer adds nade cameras that catch smokes, flashes, molotovs and HE grenades as they land.",
    ],
    setup: "One production PC with OBS and Matchframe, the CS2 observer client on the same or a separate PC, and extra operator positions for replays or graphics.",
    features: [
      { slug: "match-admin", label: "Match administration" },
      { slug: "auto-director", label: "Observer (auto director)" },
      { slug: "huds", label: "HUDs for OBS" },
    ],
  },
  {
    id: "leagues",
    title: "Leagues",
    icon: "calendar",
    intro: "Produce a weekly schedule with recurring teams and a consistent look, without rebuilding the broadcast every match day.",
    helps: [
      "Teams, players and logos are kept in the program and reused every week.",
      "HUD outputs are versioned: publish a new look between seasons and roll back if needed.",
      "Monthly plans cover regular broadcasts; hour packs top up playoff weeks.",
      "Usage per day and per computer shows where auto-director hours go.",
    ],
    setup: "A production PC per broadcast channel, each linked to the league's organisation, with team members invited by role.",
    features: [
      { slug: "huds", label: "HUDs for OBS" },
      { slug: "match-admin", label: "Match administration" },
      { slug: "multi-pc", label: "Multi-PC operation" },
    ],
  },
  {
    id: "streamers-casters",
    title: "Streamers and casters",
    icon: "mic",
    intro: "Add professional graphics and steady camera work to a community stream when you're the caster, producer and observer at once.",
    helps: [
      "Built-in HUD presets work out of the box as OBS browser sources.",
      "In Off, the Observer suggests shots; in Observer mode it switches player POVs for you while you cast.",
      "Sign in once with a free account; the program then works offline for up to seven days after each check.",
      "The Free plan includes a few auto-director hours each month to try automation.",
    ],
    setup: "A single Windows PC running the CS2 observer client, OBS and Matchframe together.",
    features: [
      { slug: "huds", label: "HUDs for OBS" },
      { slug: "auto-director", label: "Observer (auto director)" },
      { slug: "obs-replays", label: "OBS control and replays" },
    ],
  },
  {
    id: "lan-events",
    title: "LAN events",
    icon: "network",
    intro: "Produce on site on a local network, where internet access may be limited and every computer has a job.",
    helps: [
      "The program works on the local network; only signing in, licence refresh and usage upload need the internet.",
      "A fetched licence keeps automatic direction available offline for up to seven days.",
      "Replay, graphics and producer positions connect to the production computer with their own tokens.",
      "Emergency stop works from anywhere in Windows on the production PC.",
    ],
    setup: "An observer PC, a production PC and optional replay or graphics positions on a dedicated production network.",
    features: [
      { slug: "multi-pc", label: "Multi-PC operation" },
      { slug: "obs-replays", label: "OBS control and replays" },
      { slug: "cameras", label: "Observer camera control" },
    ],
  },
  {
    id: "schools-collegiate",
    title: "Schools and collegiate programmes",
    icon: "school",
    intro: "Give student crews a real broadcast workflow to learn on, with safe defaults and clear roles.",
    helps: [
      "The labelled simulation lets students rehearse with HUDs, replays and the director without a live match.",
      "Automation starts disarmed and every Observer decision shows its reasons, which makes it a teaching tool too.",
      "Team roles separate who can pay, invite people or link computers.",
      "The demo pipeline lets analytics students build datasets from match demos.",
    ],
    setup: "Shared production PCs linked to the programme's organisation, with staff as owners and students as members.",
    features: [
      { slug: "auto-director", label: "Observer (auto director)" },
      { slug: "demo-pipeline", label: "Demo pipeline and training" },
      { slug: "match-admin", label: "Match administration" },
    ],
  },
];
