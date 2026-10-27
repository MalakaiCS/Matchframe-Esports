import { PageHero } from "../../components/marketing.tsx";
import { useTitle } from "../../lib/hooks.ts";
import { Link } from "../../router.tsx";

interface Release {
  version: string;
  title: string;
  summary: string;
  sections: { heading: string; items: string[] }[];
}

const RELEASES: Release[] = [
  {
    version: "0.3.0",
    title: "Start CS2, minimaps everywhere and LHM HUDs",
    summary: "Start CS2 from the program, a minimap and killfeed in every included HUD, HUDs made for Lexogrine HUD Manager running as they are, and updates that install themselves.",
    sections: [
      {
        heading: "HUDs",
        items: [
          "Every included HUD now has a minimap and a killfeed in its own style. Built-in radars cover Ancient, Dust II, Inferno, Mirage, Nuke, Overpass, Train and Vertigo, with upper and lower levels on Nuke and Vertigo.",
          "Minimaps show flashed players and the bomb carrier, smokes outlined in the thrower's team colour and a pulsing planted bomb.",
          "The killfeed shows the killer's weapon, headshots, assists and flashed killers. CS2's game data has no kill events, so kills are matched from the game's counters.",
          "Import HUDs made for Lexogrine HUD Manager (hud.json, index.html, panel.json) as a ZIP or folder. They run as they are, without LHM. Their control panel becomes the HUD's settings, with player and team pickers and buttons that act on the running HUD.",
        ],
      },
      {
        heading: "Start CS2",
        items: [
          "Start CS2 writes the game-data config and starts the game. Choose Standard, Observer tools (the game's console, which needs the free CS2 Workshop Tools) or Observer tools with HLAE.",
          "With Observer tools: Hide game HUD and X-ray, and the console camera control is set up for you.",
          "With HLAE: No flash, team colours in the kill feed and no end-of-match screen. HLAE runs CS2 in insecure mode, so read the warning about VAC-secured servers first.",
        ],
      },
      {
        heading: "The program",
        items: [
          "Updates download in the background and install when you quit, or straight away with Restart now. The program never restarts on its own during a broadcast. Version 0.2.0 has no updater, so install 0.3.0 once by hand.",
          "The program draws its own title bar, and the HUD Library has quick switches, a Counter-Strike 2 card and HUDs grouped by category.",
        ],
      },
    ],
  },
  {
    version: "0.2.0",
    title: "The HUD Library",
    summary: "Matchframe now opens into a library of your HUDs. Run any of them as a transparent window over the game, as an OBS browser source or as a preview, with no account needed.",
    sections: [
      {
        heading: "HUD Library",
        items: [
          "Search, filter, sort and switch between grid and list. Each card shows the HUD's thumbnail, version, status and active outputs.",
          "Import a HUD as a ZIP or a folder. It's copied to your computer and keeps working if the original file is moved. Update with rollback, duplicate, export and remove.",
          "Settings are saved per HUD and apply live to every output.",
          "Two HUDs are included: the Sample CS2 HUD and the Pro CS2 HUD, adapted from Lexogrine's open-source CS2 React HUD.",
          "Run Test Data feeds every HUD with a labelled simulation, so you can set up without CS2.",
        ],
      },
      {
        heading: "Transparent desktop HUD",
        items: [
          "Launch Transparent HUD opens a window that shows only the HUD over the game. It stays on top, mouse clicks pass through it and it never takes keyboard focus.",
          "Choose the monitor, position and scale, drag it in edit mode, and lock it. Matchframe remembers where each HUD goes.",
          "Ctrl+Shift+H shows or hides the desktop HUD. Ctrl+Shift+F9 hides every HUD graphic at once, OBS included.",
          "It keeps running while the manager is minimised or closed to the tray. Use the game's Fullscreen Windowed mode.",
        ],
      },
      {
        heading: "The program",
        items: [
          "A new layout: a collapsible sidebar, a toolbar with the game-data connection and whether live or test data is showing, and a status bar with the HUD outputs and last data update.",
          "Signing in is optional. Sign in under Settings → Account to use the Auto Director on live matches.",
        ],
      },
    ],
  },
  {
    version: "0.1.3",
    title: "A cleaner program",
    summary: "Every screen in the program has been tidied up, with less on screen at once and nothing taken away, and the new Matchframe Esports logo.",
    sections: [
      {
        heading: "The program",
        items: [
          "A compact top bar: connection and game data, the Observer and who owns the camera, auto-director hours and OBS. Hover for the detail. Stop automation (F8) stays on the right.",
          "The sidebar is grouped into Broadcast, Event, Graphics & cameras, Analysis and System, with shorter names.",
          "Calmer headings, labels and badges, fewer boxes, and disabled buttons explain why when you hover them.",
          "Live Control shows what's on air in one Camera panel and puts the Observer modes and controls together in one Observer panel.",
          "Rarely used settings and technical detail are folded under Details, Options and Advanced on every screen.",
          "The new Matchframe Esports logo in the top bar, on the sign-in screen and as the program's icon.",
        ],
      },
      {
        heading: "The website",
        items: ["The new logo, favicons and a preview image for shared links.", "Colours that match the logo, and screenshots of the cleaner program."],
      },
    ],
  },
  {
    version: "0.1.2",
    title: "The Observer",
    summary: "The auto director is now the Observer: Off, Observer, Observer & Cinematics, and Full Action Observer with nade cameras on the top plan.",
    sections: [
      {
        heading: "The program",
        items: [
          "Off: Matchframe never moves the camera; shot suggestions stay visible in Live Control. Uses no hours.",
          "Observer switches between player POVs automatically.",
          "Observer & Cinematics adds cinematic shots from static cameras you capture in Maps & Cameras: an establishing shot during freeze time, bomb plant and defuse shots, and overviews of big fights.",
          "Full Action Observer adds nade cameras that catch smokes, flashes, molotovs and incendiaries, and HE grenades as they land. Top plan only.",
          "Observer, Observer & Cinematics and Full Action Observer use auto-director hours at the same rate; the simulation is free in every mode. If a plan stops including Full Action Observer, the program switches to Observer & Cinematics at the next map change, never mid-map.",
        ],
      },
      {
        heading: "The website",
        items: ["Pricing and plan cards show which Observer modes each plan includes.", "The Observer page explains and compares the four modes.", "Staff can turn Full Action Observer on or off per plan in the catalogue."],
      },
    ],
  },
  {
    version: "0.1.1",
    title: "Sign in to the program",
    summary: "The program now has its own sign-in screen, using the same account as this website.",
    sections: [
      {
        heading: "The program",
        items: [
          "Sign in with your Matchframe email and password when the program opens, or with a code approved on this website. Accounts in several organisations choose which one the computer is for.",
          "Works offline for up to 7 days after each check; a program that is already open is never locked when it is signed out on the website.",
          "Account & Hours shows who the program is signed in as, with Sign out.",
          "Builds are pinned to this website's address and licence keys, so there is nothing to configure.",
        ],
      },
      {
        heading: "The website",
        items: [
          "Changing or resetting your password, being removed from an organisation or a disabled account signs that person's computers out.",
          "Public product pages, FAQ, help centre, legal documents and a staff console for user management.",
        ],
      },
    ],
  },
  {
    version: "0.1.0",
    title: "First release",
    summary: "The first public version of the Matchframe program for Windows and of this website.",
    sections: [
      {
        heading: "The program",
        items: [
          "Counter-Strike 2 Game State Integration ingest with token authentication, capability sampling and clear evidence levels for every derived event.",
          "Browser-source HUDs for OBS: Classic, Minimal and Arena presets with pre-match, veto, live, post-map, standings and bracket variants; imported HUD packages; draft, publish and rollback per output.",
          "Auto director (now the Observer) with explained shot choices, sticky manual takeover, emergency stop and a single-writer camera control arbiter. Always starts disarmed.",
          "Observer camera control through the direct console or keyboard adapter, gated by in-program setup tests; operator-validated static cameras for cinematic shots.",
          "OBS control over obs-websocket 5: scenes, sources, audio, recording, streaming and the replay buffer, with a replay approval queue and confirmed playout.",
          "Events, teams, players, series rules, veto with captain links, sponsors with delivery acknowledgements, automation rules and studio rundown.",
          "Multi-PC operator positions with role-scoped tokens, a Stream Deck and Companion control surface, and a labelled simulation for rehearsals.",
          "Offline demo pipeline that builds datasets from CS2 demos and trains models evaluated in shadow mode.",
          "Account & Hours screen: link the computer, see the plan and hours left; automatic direction on live matches is never cut off mid-map.",
        ],
      },
      {
        heading: "The website",
        items: [
          "Accounts with email verification, password reset, email changes confirmed from the new address, active sessions and data export.",
          "Organisations with owner, admin, billing and member roles, and email invitations.",
          "Plans and hour packs through Stripe Checkout, the customer portal and invoices.",
          "Linking computers with a short code, signed licences with offline grace, and auto-director usage by day, computer and session with CSV export.",
          "Program download with SHA-256 checksum, help centre, FAQ, legal documents and a contact form.",
        ],
      },
    ],
  },
];

export function Changelog() {
  useTitle("Changelog", "What's new in the Matchframe program and website, release by release.");
  return (
    <>
      <PageHero eyebrow="Product updates" title="Changelog" lead="New features and improvements in the Matchframe program and this website." />
      <div className="wrap section-top narrow-block">
        <ol className="releases">
          {RELEASES.map((r) => (
            <li key={r.version} className="release" id={`v${r.version}`}>
              <div className="release-meta">
                <span className="badge badge-brand">Version {r.version}</span>
              </div>
              <div className="release-body">
                <h2 className="display-3">{r.title}</h2>
                <p className="release-summary">{r.summary}</p>
                {r.sections.map((s) => (
                  <section key={s.heading} aria-label={`${r.version}: ${s.heading}`}>
                    <h3 className="h3">{s.heading}</h3>
                    <ul className="release-list">
                      {s.items.map((i) => (
                        <li key={i}>{i}</li>
                      ))}
                    </ul>
                  </section>
                ))}
              </div>
            </li>
          ))}
        </ol>
        <p className="small muted">
          Signed in? The latest installer is on the <Link to="/download">download page</Link>.
        </p>
      </div>
    </>
  );
}
