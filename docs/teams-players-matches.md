# Teams, Players and Matches

How the MatchFrame console's Teams, Players and Matches sections work: list page → Add or Edit screen → Save and Exit → updated list.

## Screens

| Path | Screen |
|---|---|
| `/teams`, `/players`, `/matches` | List pages: search, filters, sortable columns, selection with bulk delete, Add / Import actions. Search, filters, sort and scroll are kept while the console is open. |
| `/teams/new`, `/teams/:id/edit` | Team name, short name, country, logo; Assigned Players (edit only): tiles open the player, Assign Existing Player, Add Player. Additional details: colours, region, extra HUD fields. |
| `/players/new` (`?teamId=` preselects the team), `/players/:id/edit` | Nickname, first and last name, country, SteamID64, team, avatar. Additional details: role, aliases, on-air consent, camera source, roster history, merge a duplicate. |
| `/matches/new`, `/matches/:id/edit` | Left: Team 1 / Team 2, logos, series score with VS, best-of, date and time, tournament and stage, title. Right: the ordered map veto. Additional details: round rules, map pool, status; maps and results, stat corrections, captain veto and links, thumbnails and stingers (these apply at once). |

Editors keep the navigation visible and have a footer with Cancel and Save and Exit. Leaving a changed form (Back, Cancel, the sidebar, the browser's back button, closing the window) asks first: keep editing, discard, or save and continue.

## Data

- **Player**: `displayName` (nickname), `firstName`, `lastName`, `realName` (derived "First Last", kept for compatibility), `steamId` (text, 17 digits starting `7656119`, unique), `countryCode` (ISO 3166-1 alpha-2). A player without a SteamID64 is marked "won't match live CS2 data". Changing the nickname keeps the SteamID64 link.
- **Team membership**: roster memberships with validity history. A player's team is the open membership; saving a player with another team closes the old membership and opens the new one in the same transaction. Teams can have any number of players, substitutes included.
- **Match**: `veto` (ordered entries `{id, type: pick|ban|decider, teamId, mapName, sideChoice: CT|T|null, reversedSides}`), `seriesCorrectionA/B` (manual adjustment). Map instances follow the picks and the decider in order; a map that stays in place keeps its result, and a map with a result is never replaced or removed by a veto edit. The series score is the maps won (completed maps, each once) plus the correction.
- **Images**: an editor upload is checked (PNG, JPEG or WebP by content, size read from the file, 2 MB at most) and staged under `<data folder>/staging`; Save and Exit moves it into the content-addressed asset store, Cancel deletes it, and staged files older than six hours are removed at start-up and every 30 minutes. Removing an image clears the reference only.
- Migration 5 splits existing real names on the first space into first and last names.
- **Default player picture** (Settings → General, `players.defaultPicture`): shown for any player without a picture of their own in the console, MatchFrame HUDs (where the HUD images have no side pictures for that side), imported HUDs and the Team Comms strip (after the strip's own placeholder).
- **HUDs**: names and pictures come from these records, so edits reach every HUD. Imported HUDs (hud.json format) get each player's `firstName`/`lastName` (`domain/players.ts` `playerNames`) and the active match's veto in order, bans included, with the side choice, reversed sides and each played map's result (`domain/veto-entries.ts` `hudVetoList`: the match's own entries, else the captain veto, else its maps).

## Active match

Make Active is an explicit action; at most one match is active. Activating a match does not change its status or its tab. Tabs: **Ended** (completed or cancelled), **Current** (veto or live status, or a map with a result), **Future** (everything else). A scheduled time never activates a match. Recording a map result moves a scheduled match to live.

## Concurrent edits

Edit screens send only the fields that changed, with the values they loaded. If one of those fields was changed elsewhere meanwhile (another computer, a live result, the captain veto), the save is refused with the field named; the form keeps the person's values and offers the current ones. Other fields merge.

## Deleting

Deletes are confirmed in a dialog that lists each record, what blocks it and what deleting it changes. Blocked records are not deleted; the dialog offers Archive (hidden from lists and pickers, kept for history).

| Record | Blocked when | Deleted with it (named in the dialog) |
|---|---|---|
| Team | used by any match (including archived matches); has assigned players; listed in a tournament stage | past roster entries of former players (the logo file stays) |
| Player | a stat correction refers to their SteamID64; on the roster of a played match (membership valid at the match's scheduled time, or any membership when the match has no time); plays for a team in the active match | their roster entries and SteamID64 link |
| Match | it is the active match; placed in a tournament bracket; its results count in a stage's standings | its maps and results, captain veto decisions, stat corrections, thumbnails and stingers |

Captain veto decisions record the team, not a player, so they never block deleting a player.

## Importing (.xlsx)

Download the template (Teams: Team name, Short name, Country. Players: Nickname, First name, Last name, Country, SteamID64, Team), fill it in, upload it, check the preview, then import. The engine reads the spreadsheet itself (a small reader on fflate; no Excel library). Every row is checked again on import; rows with errors are never imported, and nothing is created twice.

- Teams: a name already in MatchFrame, or twice in the file, is an error.
- Players: the team is found by exact id, else by its name or short name (ignoring case and punctuation); no match or more than one match is an error, never a guess. Import teams first. A SteamID64 already in MatchFrame or twice in the file is an error, as is a SteamID64 stored as a number (Excel rounds 17-digit numbers; keep the column as Text). A nickname without a SteamID64 that already exists is an error.
- Country: a two-letter code or the country's English name.
