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
    version: "0.10.0",
    title: "Vector and Lineup HUDs",
    summary: "Two new broadcast HUDs in the HUD Library, with full animations for going live, kills, the bomb and round wins. Cinematics no longer end in the free camera under a player.",
    sections: [
      {
        heading: "Cinematics",
        items: ["After a cinematic, CS2 goes back to a player's view instead of staying in the free camera under a player. Matchframe now checks where the camera really is before it trusts the first-person command."],
      },
      {
        heading: "HUD Library",
        items: [
          "Vector: each team's players down its side of the screen on team-colour cards with photos, loss bonus and series in freeze time, a winner card when the round ends.",
          "Lineup: all ten players in a row along the bottom, the observed player in the middle, and a score bar that turns into the round winner's banner.",
          "Both show the radar, killfeed, bomb and defuse bar and players alive, have a compact variant, and animate smoothly without straining the graphics card.",
        ],
      },
    ],
  },
  {
    version: "0.9.5",
    title: "Smoother cinematics",
    summary: "Moving cinematics glide, freeze-time shots show the players, nade cams stay on the action, and the free camera no longer sticks on air.",
    sections: [
      {
        heading: "Cinematics",
        items: [
          "Cameras moving round the map turn smoothly: no more jolt every half second.",
          "Freeze-time shots only show places where players are in the picture.",
          "Nade cams are used only with players in the shot, and stay at least 2.5 s.",
          "A cinematic no longer leaves CS2's free camera on air when the player it was on dies.",
          "Game options: cap CS2's frame rate, so HUDs and OBS keep a share of the graphics card.",
        ],
      },
    ],
  },
  {
    version: "0.9.4",
    title: "Demos read on Windows",
    summary: "The Demo library reads demos on Windows; they all failed before.",
    sections: [
      {
        heading: "Demo library",
        items: ["Demos no longer fail with \"No module named 'resource'\" on Windows. Press Retry on demos that failed."],
      },
    ],
  },
  {
    version: "0.9.3",
    title: "Demo library settings fixed",
    summary: "Changes in the Demo library's settings stay until you save them.",
    sections: [
      {
        heading: "Demo library",
        items: ["Library settings no longer undo your changes every few seconds, so you can add your own demo folders and keep your original demos."],
      },
    ],
  },
  {
    version: "0.9.2",
    title: "LHM HUDs that keep up",
    summary: "kaiHUD gets fewer game updates while its page can't keep up, and shows Anubis on its minimap.",
    sections: [
      {
        heading: "HUDs",
        items: [
          "Each HUD output checks whether its page is keeping up; an LHM HUD that falls behind gets fewer game updates until it has room again.",
          "LHM HUDs without an Anubis minimap (kaiHUD) get one from Matchframe.",
        ],
      },
    ],
  },
  {
    version: "0.9.1",
    title: "Smoother LHM HUDs",
    summary: "kaiHUD and other LHM HUDs move smoothly: their minimaps no longer step ten times a second.",
    sections: [
      {
        heading: "HUDs",
        items: [
          "LHM HUDs get game data twice as often (20 times a second), so minimap dots glide instead of surging and stopping.",
          "The HUD Library warns when a HUD output draws fewer than 40 frames a second, and says what helps.",
        ],
      },
    ],
  },
  {
    version: "0.9.0",
    title: "The best replays of each round",
    summary: "The replay PC films every kill it can, the main PC ranks each round's clips and replays the best 3–4. The main PC can record the replay PC's screen over NDI, and replays can play in vMix.",
    sections: [
      {
        heading: "Replays",
        items: [
          "The replay PC films every kill it has time for; the main PC ranks each round's clips, best to worst, and shows why.",
          "Each break replays the best clips that fit (up to 4), best first, and leaves the rest.",
          "Replay feed (NDI), like LHM's: the main PC records the replay PC's screen and cuts each kill from it, so the replay PC needs no OBS.",
          "Replays can play in vMix as well as OBS.",
        ],
      },
    ],
  },
  {
    version: "0.8.2",
    title: "Moving cinematics",
    summary: "Freeze-time, pause and path cinematics through HLAE move as planned, the names above the players show with only the kill feed drawn, and the HUD gets game data more reliably.",
    sections: [
      {
        heading: "Cinematics",
        items: [
          "Fixed HLAE cinematics standing still on their first frame: team shots glide, pause shots glide back and forth, and camera paths fly their whole route.",
          "Team shots in tight spawns push in instead of standing still.",
        ],
      },
      {
        heading: "Game and HUD",
        items: [
          "The names above the players (team overhead) show with Hide game HUD on, and go off with X-ray in clutches and retakes.",
          "Matchframe answers CS2's game data before reading it, and CS2 recovers within a second or two if an answer is lost.",
          "The support file shows gaps in CS2's game data and stalls of the program.",
        ],
      },
    ],
  },
  {
    version: "0.8.1",
    title: "Cinematics that hold and move",
    summary: "Freeze-time and pause cinematics no longer flicker: each shot plays its full length, and team shots and pause shots glide round the players.",
    sections: [
      {
        heading: "Cinematics",
        items: [
          "Fixed cinematics flickering in pauses and freeze time with the HLAE camera.",
          "Team shots glide further round the team; pause shots glide back and forth until the round goes live.",
          "The demo-trained POV model loads on Windows again.",
        ],
      },
    ],
  },
  {
    version: "0.8.0",
    title: "Player cams",
    summary: "Players send their face cam from a link on the Matchframe website; the production shows it in the HUD and OBS, delayed to match the game.",
    sections: [
      {
        heading: "Player cams",
        items: [
          "Players open the link, pick themselves and their camera, see a preview and send it. No account or app needed.",
          "The production sets a delay (up to 5 minutes) so faces match the game, and puts each cam on or off air.",
          "Cams show in LHM-format HUDs such as kaiHUD, in Matchframe's HUD, and as OBS browser sources.",
        ],
      },
    ],
  },
  {
    version: "0.7.2",
    title: "200–300 camera paths on each map",
    summary: "Camera paths built from real pro demos, where players walked and fought: 214–270 on each of the seven pool maps.",
    sections: [
      {
        heading: "Cinematics",
        items: [
          "Orbits, push-ins, pull-outs, cranes and slides round fight spots, bomb plants and spawns, and routes along the ways players really ran.",
          "Every path was flown through the map's collision geometry before it was kept: room round the camera, no walls in the way, over the playable area.",
          "They play in freeze time, half time and at the end of the map while HLAE plays the camera, and take turns from round to round.",
        ],
      },
    ],
  },
  {
    version: "0.7.1",
    title: "Every camera shot through HLAE",
    summary: "With CS2 started through HLAE, HLAE now plays every free-camera and moving shot, like Lexogrine HUD Manager's cinematics.",
    sections: [
      {
        heading: "Cinematics",
        items: [
          "HLAE plays every camera shot, turn, glide and path, and sets the view every frame for smooth, stable moves.",
          "Shots are confirmed when HLAE draws them, and the view goes back to the player as soon as the director picks one.",
          "Without HLAE, shots go over the console as before.",
        ],
      },
    ],
  },
  {
    version: "0.7.0",
    title: "The Auto Director learns from demos",
    summary: "A model trained on pro demos helps pick whose POV to show, multi-frag awareness, a test bench, and cinematics that vary like a real broadcast.",
    sections: [
      {
        heading: "Auto Director",
        items: [
          "A built-in model trained on seven pro matches estimates whose POV is about to show a kill. On those matches the director showed 74 % of kills instead of 71 %.",
          "Multi-frag awareness: after a kill with enemies close, the director goes to that player (53 % of multi-frags shown instead of 45 %).",
          "Director test bench: your demos replayed through the director, scored on the kills it shows.",
        ],
      },
      {
        heading: "Cinematics",
        items: [
          "Freeze times differ from round to round: one longer team shot, no shot of a team on an eco, high, low and side views.",
          "Big moments: pistol-round openers, the team on match point first, half time and the end of the map.",
          "A short shot of the winners after the round.",
          "Camera walkthrough with Keep/Hide, and Ctrl+Shift+F11 saves the CS2 view as your own camera.",
          "Experimental: camera paths played by HLAE.",
        ],
      },
    ],
  },
  {
    version: "0.6.8",
    title: "Cameras that move on CS2",
    summary: "Fixes cameras that never moved and automatic player switches that stopped working: Matchframe mixed CS2's and CS:GO's spectator mode numbers.",
    sections: [
      {
        heading: "Auto Director",
        items: [
          "Fixed: the free camera command used CS:GO's number, which CS2 doesn't have, so cameras stayed at the player.",
          "Cameras now find the command that moves them on your CS2 and remember it.",
          "A camera that doesn't move goes straight back to first person.",
        ],
      },
    ],
  },
  {
    version: "0.6.7",
    title: "Cinematics in the right place",
    summary: "Fixes cinematics that went into the free camera but stayed in the ground under the player instead of moving to the camera.",
    sections: [
      {
        heading: "Auto Director",
        items: [
          "Fixed: the camera stuck under the player when a cinematic started. CS2 switches to the free camera a moment late, so the camera's position is now sent again and checked.",
          "A camera that still doesn't move is skipped, and the director goes straight back to a player.",
        ],
      },
    ],
  },
  {
    version: "0.6.6",
    title: "Demo learning",
    summary: "The Demo Library turns pro demos into POV data (who gets a kill, dies or starts a multi-frag in the next seconds), uploads it to your FTP storage and deletes the demo. Python is set up from the program.",
    sections: [
      {
        heading: "Demo Library",
        items: [
          "POV labels for every moment and player: kills, deaths and multi-frags in the next 2, 5 or 10 seconds.",
          "Cloud storage (FTP): each match's data uploaded (encrypted by default), then the demo deleted if you choose.",
          "HLTV .zip and .rar downloads unpacked automatically.",
          "Set up Python from the program: no command line needed.",
        ],
      },
    ],
  },
  {
    version: "0.6.5",
    title: "No X-ray in retakes, no follow cams",
    summary: "X-ray goes off for retakes after the plant, when the CTs go for the bomb with time to defuse. The Auto Director now sticks to first person, cinematic cameras and nade cams.",
    sections: [
      {
        heading: "Game options",
        items: ["No X-ray in retakes: once a CT gets close to the planted bomb with time left to defuse, X-ray goes off until the round is over (on by default). Not while the CTs save."],
      },
      {
        heading: "Auto Director",
        items: ["Follow cams removed: first person, cinematic cameras and nade cams only."],
      },
    ],
  },
  {
    version: "0.6.4",
    title: "Clutches without X-ray, and coaches hidden",
    summary: "X-ray goes off in a clutch so a win looks like magic, and player names show above heads with X-ray on. The minimap numbers match the number keys again. Coaches are no longer shown as a sixth player.",
    sections: [
      {
        heading: "Game options",
        items: [
          "No X-ray in clutches: when one player is left against two or more, X-ray goes off until the round is over (on by default).",
          "With X-ray on, each player's name shows above them (hud_showtargetid).",
        ],
      },
      {
        heading: "HUDs",
        items: [
          "Fixed: player numbers one too low on kaiHUD's minimap (the first player showed as 0).",
          "Coaches are left off scoreboards and the minimap. They are found automatically, or picked in Live Control when a team shows more than five players.",
        ],
      },
    ],
  },
  {
    version: "0.6.3",
    title: "Real spawns, and Cache",
    summary: "Freeze-time team shots checked and tuned on where players really stand, from a pro match on every map in the pool. The spawn cameras now aim at the real spawns. Cache is supported.",
    sections: [
      {
        heading: "Auto Director",
        items: [
          "Team shots checked on every round of a pro match on each of the seven pool maps: every team framed, the players a good size in the picture.",
          "Spawn cameras aim at where players really spawn (they were off by up to 500 units, and on Ancient and Anubis missed the CT spawn).",
        ],
      },
      {
        heading: "Maps",
        items: ["Cache: areas, cameras and camera paths, checked against CS2's own geometry. The default map pool is now Ancient, Anubis, Cache, Dust II, Inferno, Mirage and Nuke."],
      },
    ],
  },
  {
    version: "0.6.2",
    title: "Broadcast team shots, and cameras that stay put",
    summary: "Freeze time shows each team the way a broadcast does: the camera framed from where the players stand, gliding slowly round them. Fixes cinematics sliding into walls and floors. Every map's cameras checked again.",
    sections: [
      {
        heading: "Auto Director",
        items: [
          "Fixed: freeze-time cinematics could slide sideways into walls or under the floor (on Mirage, into the ground). Matchframe now moves every camera itself.",
          "Team shots: in freeze time the camera frames each team from where its players stand, a little above their heads, everyone in the picture, and glides slowly round them. One team, then the other, until the round goes live.",
          "Pauses hold a still shot of the team that called them.",
        ],
      },
      {
        heading: "Maps",
        items: ["All nine maps' cameras checked against CS2's own geometry: none sits inside a wall or under a floor, and 25 that looked into a wall were dropped or moved."],
      },
    ],
  },
  {
    version: "0.6.1",
    title: "Smooth freeze-time cinematics, and back to the players on time",
    summary: "Freeze time is cinematic all the way, with shots CS2 itself turns smoothly; pauses hold on one team; first person when the round goes live. Fixes the camera staying on a freeze-time shot into the live round. A HUD that lags now says so, and why.",
    sections: [
      {
        heading: "Auto Director",
        items: [
          "Freeze time filled with shots of both spawns, one after another, each turning slowly and smoothly, the last until the round goes live.",
          "Tactical and technical pauses: a still shot of the team that called it, held until the round starts; then first person.",
          "Fixed: the camera could stay on a freeze-time shot well into the live round. Matchframe read CS2's game data too early, could save the wrong camera-mode numbering and then never leave a shot. It now waits for the game data, and repairs a wrong saved setting by itself.",
          "A director log of every console command, decision and game data change, included in the support file.",
        ],
      },
      {
        heading: "CS2",
        items: ["New game option, on by default: Run behind other windows. CS2 keeps every frame and its sound while you use Matchframe or OBS."],
      },
      {
        heading: "HUDs",
        items: ["Each HUD output measures how smoothly it draws; an output that stutters shows in amber with what helps (in OBS: browser source hardware acceleration)."],
      },
    ],
  },
  {
    version: "0.6.0",
    title: "Cinematics that hold, and graphics for every match",
    summary: "Pre-round shots of the spawns where the players are, played once and in full, then first person when the round goes live. Smooth LHM HUDs. Create matches with new teams, and get thumbnails and stinger transitions made from both teams' logos.",
    sections: [
      {
        heading: "Auto Director",
        items: [
          "Fixed: freeze-time shots that lasted a second and repeated. Up to two shots of the spawns with players, each in full, never repeated.",
          "First person as soon as the round goes live, with no overviews or follow cams in the first 10 seconds.",
          "Follow cams at most once per map, smoother, and always handing back. Nade cams on by default and more frequent.",
        ],
      },
      {
        heading: "HUDs",
        items: ["LHM-format HUDs (like kaiHUD) get game data at most 10 times a second unless something on screen changes: no more laggy baseboard."],
      },
      {
        heading: "Matches and graphics",
        items: [
          "Create match is always at the top of Matches, and new teams can be made in the form.",
          "Every match gets Highlights, Full replay and Live thumbnails, an Up next screen, and a stinger and replay stinger with the teams' logos (a ? without one).",
          "One click puts the stingers in OBS; replays use the replay stinger.",
        ],
      },
    ],
  },
  {
    version: "0.5.3",
    title: "Back to live, the right way",
    summary: "The replay PC goes back and forward in CSTV with the relative commands broadcasters use.",
    sections: [
      {
        heading: "Replays",
        items: ["Going back uses demo_gototick -448 relative, and returning to live after filming a missed kill uses demo_gototick 448 relative."],
      },
    ],
  },
  {
    version: "0.5.2",
    title: "Same CSTV, 7 seconds behind",
    summary: "With both computers on the same CSTV, the replay PC goes back 7 seconds by itself and stays there, so it knows every missed kill before it plays on its screen.",
    sections: [
      {
        heading: "Replays",
        items: [
          "The replay PC goes back 7 s once on CSTV (demo_gototick -448 relative) and keeps playing from there: no second CSTV needed. 5, 7 or 10 s.",
          "After a reconnect or map change it goes back again by itself.",
          "Going back for each missed kill and then returning to live is still a choice.",
        ],
      },
    ],
  },
  {
    version: "0.5.1",
    title: "A replay PC that knows the kill is coming",
    summary: "Run the replay PC a few seconds behind the main PC and it films every kill the main camera misses, from the killer, before it happens on its screen.",
    sections: [
      {
        heading: "Replays",
        items: [
          "The replay PC measures how far behind the main PC it is. A few seconds behind, it gets on the killer before each missed kill plays there and films it with its lead-up.",
          "Two missed kills at once: it films the better one, and switches to a multi-kill.",
          "Experimental: at the same time as the main PC, it can go back in CS2 to film a missed kill, then return to live.",
        ],
      },
    ],
  },
  {
    version: "0.5.0",
    title: "Replay PC, automatic replays, clutch mode and follow cams",
    summary: "A second computer catches the kills your camera misses and the program replays them between rounds. The Auto Director cuts before fights start, follows lurks with a free camera, locks onto clutches, and times HUD graphics and OBS scenes to the shots.",
    sections: [
      {
        heading: "Replays",
        items: [
          "Replay PC: a second computer films whoever the main camera isn't showing and sends the kills it missed to the main PC.",
          "Automatic replays between rounds, best first: won clutches, 3K+, then missed kills. Never during a live round. Slow motion and a Stinger transition are options.",
        ],
      },
      {
        heading: "Auto Director",
        items: [
          "Cuts to a fight before it starts, using a map of CS2's own collision geometry for every active-duty map.",
          "Follow cams: a free camera behind a player on a lurk or rotation, kept clear of walls.",
          "Clutch mode: stays with the last player alive, with a 1v3 banner and a replay if they win.",
        ],
      },
      {
        heading: "Graphics and OBS",
        items: [
          "Economy and round MVP in freeze time, player cards on long holds, and OBS break and studio scenes for timeouts and map ends.",
          "kaiHUD's Player Highlight, Match stats and other pages now open in OBS, with team logos and sponsor images.",
        ],
      },
    ],
  },
  {
    version: "0.4.3",
    title: "Cameras all over the map, and a chase cam",
    summary: "Built-in cameras now cover almost every named area of each map, and the Auto Director shows plants, defuses and round wins from behind the player.",
    sections: [
      {
        heading: "Cameras",
        items: [
          "391 cameras instead of 104: every named area, not only the bombsites, mid and spawns, with the same checks against CS2's own geometry. 200 of the 227 named areas on the nine active-duty maps have cameras.",
          "Big-fight overviews and nade cams can now use a camera almost anywhere a round is played.",
        ],
      },
      {
        heading: "Chase cam",
        items: [
          "While a player plants or defuses the bomb, and when their team wins the round, the Auto Director shows them from behind (CS2's third-person view), then goes back to their eyes.",
          "Switch it off with Chase cam on the Auto Director card. Hold Shift when you pick a player in Live Control to choose the chase view yourself.",
        ],
      },
    ],
  },
  {
    version: "0.4.2",
    title: "Cameras checked against CS2's own geometry",
    summary: "The built-in cameras and camera paths are rebuilt from CS2's own map geometry, so they don't look through walls or sit inside them.",
    sections: [
      {
        heading: "Cameras",
        items: [
          "104 cameras and 81 camera paths across the nine active-duty maps, placed on CS2's walkable floor and checked against the geometry players collide with: clear space around each camera, a clear view of its area, and paths that never cross a wall.",
          "More areas are covered: Train CT spawn, Vertigo T spawn, and mid on Nuke, Train and Overpass.",
        ],
      },
    ],
  },
  {
    version: "0.4.1",
    title: "Game options fixed, and no CS2 kill feed",
    summary: "The game options on the Counter-Strike 2 card no longer switch each other off, and with HLAE you can hide CS2's own kill feed while keeping the crosshair.",
    sections: [
      {
        heading: "Game options",
        items: [
          "Each switch on the Counter-Strike 2 card now changes only its own option. Before, turning one on could turn the others off.",
          "Hide CS2 kill feed (with HLAE): CS2's own kill feed is blocked so only your HUD's kill feed shows. With Hide game HUD on, the crosshair stays.",
        ],
      },
    ],
  },
  {
    version: "0.4.0",
    title: "A one-button Auto Director and cameras on every map",
    summary: "Press Start Auto Director and Matchframe checks CS2, confirms that it can switch players and place cameras, and directs the match, with built-in cameras and camera paths on all nine active-duty maps.",
    sections: [
      {
        heading: "Auto Director",
        items: [
          "Start Auto Director checks the CS2 console, the game data and your hours, tests player switching and the cameras on your CS2 build, and then directs. Each check says what it's doing or what it needs.",
          "Toggles for cinematic cameras and nade cams. Pick a player yourself and the Auto Director takes the camera back after a few seconds.",
          "Camera control confirms itself from CS2's own feedback, so there are no setup tests to run and no commands to type.",
        ],
      },
      {
        heading: "Cameras",
        items: [
          "Built-in cameras and camera paths on Ancient, Anubis, Dust II, Inferno, Mirage, Nuke, Overpass, Train and Vertigo, placed from the maps' navigation data.",
          "In freeze time, a camera path flies around the map every round. The bomb and big fights get cinematic shots too.",
        ],
      },
    ],
  },
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
