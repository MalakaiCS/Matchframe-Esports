# Account sync: the same teams, players, matches and HUDs on every computer

Every computer signed in to the same Matchframe organisation shares one set of teams, players, matches and imported HUDs. Add a player on the main PC and it shows up on the observer PC a few seconds later; change a HUD's colours on one computer and every other computer's copy of that HUD changes too. The card is in **Settings → Account**, under the sign-in: **Shared with <organisation>**.

The program still works fully offline. Changes made without a connection stay on the computer and are shared when the website can be reached again.

## What is shared

- Teams, players and rosters (who plays for which team, and since when).
- Events and matches, with their maps, scores and veto.
- The logos and photos these use.
- HUDs you imported (normal and LHM-format HUDs): the HUD's files and its settings (colours, texts, pictures, preset).
- Archiving: an archived team or player is archived on every computer.

Each computer keeps its own HUD URLs (the address OBS uses), whether a HUD is stopped, and its desktop windows: sharing a HUD never changes another computer's OBS sources.

## What is not shared

- The bundled sample HUDs and the built-in Matchframe Broadcast HUD (they come with the program on every computer).
- Sponsors, rundown cues, automation rules and stat corrections.
- The program's own settings: connections, OBS, cameras, the Auto Director, game options, tokens and devices.
- HUD images (HUD Library → HUD images): default player pictures, map logos and pictures and the dead-player icon are kept on each computer for now; add them on every computer that runs HUDs.
- Demos, datasets, models, replays and clips.

## The card in Settings → Account

- **The switch** turns sharing on or off on this computer. Off: changes here stay here, and changes from the other computers don't arrive. Turning it on again shares what changed in the meantime.
- **Synced 4 s ago**: when this computer last checked with the website. It checks every few seconds, and sends a change about a second after it is made.
- **Counts**: the players, teams, matches and HUDs shared on this computer.
- **Uploading HUD …**: a HUD's files are on their way. A large HUD can take a while on a slow connection; everything else keeps working.
- **Storage**: how much of the organisation's shared space the HUD files, logos and photos use, for example **140 MB of 2 GB**.
- **Last problem**: what went wrong, in plain words (no connection, storage full, a record the website refused).
- **Sync now** checks straight away.

In the HUD Library, a HUD you imported shows **Shared** in its details line while sharing is on.

## A computer that already has data

When a computer with its own teams and players signs in to an organisation for the first time, it first takes the organisation's data, then shares what only it has:

- A player with the same SteamID as one of the organisation's players becomes that player. A team with the same name (ignoring capitals, spaces and symbols: "Team Alpha" and "team-alpha!" are the same) becomes that team.
- Everything on the computer that pointed to its own copy (rosters, matches, maps, veto, stages, HUD settings) now points to the organisation's record.
- Details the organisation's record lacks are filled in from the computer's copy (a photo, a real name, a country), and the computer's name for a player is kept as an alias.
- Everything else (other teams, players, matches, imported HUDs) is added to the organisation.

Signing in to a different organisation works the same way: the computer's data is merged into the new organisation's.

## When two computers change the same thing

The last edit wins. If the main PC renames a team at 20:01 and the observer PC renames it at 20:02, both end up with the observer PC's name, even if one of them was offline at the time. The change that lost is not kept anywhere, so agree who edits what during a show.

A deletion counts as an edit: deleting an event on one computer deletes it on the others, unless another computer changed it later. A HUD deleted on one computer is removed on the others, except where a published broadcast output still uses it; there it stays, on that computer only.

## Storage

- An organisation can keep **2 GB** of shared files: HUD packages, logos and photos. Teams, players and matches take almost no space.
- One file (a HUD package) can be at most **60 MB**; one record at most 256 KB.
- When the storage is full, new HUDs and pictures are not shared (the card says so), but they keep working on the computer where they were added. Remove HUDs or pictures you no longer need; their space is freed about an hour later.
- Changing a HUD's settings doesn't upload the HUD again.

## Turn it off

**Settings → Account → Shared with <organisation>**: switch it off. Signing out also stops sharing. The computer keeps everything it has; nothing is deleted.
