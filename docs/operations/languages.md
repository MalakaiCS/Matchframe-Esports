# Languages

The MatchFrame program speaks **English, Português (Brasil), Español, Deutsch, Français, Polski and Русский** (ADR-082).

## Choosing a language

**Settings → General → Language**:

- **System** follows the computer's display language (Windows → Time & language → Language). A language MatchFrame doesn't have falls back to English. Portuguese from Portugal uses Português (Brasil).
- Or pick a language by its own name.

It applies at once, without a restart: the console, and the program's tray menu, dialogs, Windows notifications and connection settings page. The program keeps the setting for this computer (`program-settings.json` in the data folder's `program` folder), so each operator position can have its own language.

## What is translated

- **The console, every screen:** the sidebar, top bar and status bar, sign-in, Settings, the HUD Library, Live Control, Automatic replays, Replays & Production, Map intros, Team Comms, Studio & Rundown, the Auto Director, Teams and Players, Matches and veto, Tournaments, HUDs, Maps and cameras, Sponsors, Demos, Training, and Account & hours.
- **The desktop shell:** tray, dialogs (unsaved changes, crash reports, going back to a version, newer data), notifications (replay hotkeys, saved cameras, crash reports), file dialogs, the connection settings page and the messages it gives the console (Start CS2, desktop HUDs, hotkeys, updates).
- Numbers, seconds, dates, durations and money use the language's format (1,5 s, 0,5 с, 1.200 $, 17 нояб.).

## What stays in English

- **HUDs:** their on-air text (ROUND, TIMEOUT, team and player names) is the HUD's own, and so are the settings labels a HUD's manifest gives (shown in the HUD's options); a HUD maker translates their HUD.
- **Match graphics** the console draws for the broadcast: thumbnails, the Up next screen, stingers and highlight reel cards (on-air text, like a HUD's).
- **The website** (`apps/cloud-web`) and **these docs.**
- **Messages from the engine:** API error details, director reasons, Auto Director checks, job steps and a few status lines ("Automatic replays are off.", "Team Comms is off.") come from the engine in English. The console's own words around them are translated ("Permission denied: …").
- Brand and product names (MatchFrame, OBS, vMix, CS2, HLAE, TeamSpeak, Stream Deck, NDI), API paths, hotkeys, setting keys and console commands.
- CS2 terms the scene uses as they are: clutch, eco, force buy, freeze time, POV, X-ray, kill feed (in Russian the transliterations the Russian scene uses: клатч, эко, фризтайм), and CS2's gun names (AK-47, Desert Eagle). Grenades and the knife are translated.
- OBS's transition types (Fade, Cut, Stinger, Luma Wipe), by the names OBS gives them.

## Machine-translated

The translations are machine-made and marked so in the Language setting. They may contain mistakes.

## Reporting or fixing a translation

**Report:** write to MatchFrame support (the website's contact form) with the language, the screen, the text you saw and what it should say. A screenshot helps.

**Fix it yourself** (a pull request):

1. The texts are in one file per language:
   - the console: `apps/operator-web/src/i18n/locales/<language>.json` (`en`, `pt-BR`, `es`, `de`, `fr`, `pl`, `ru`);
   - the desktop shell: `apps/desktop/src/locales/<language>.json`.
2. Find the English text in `en.json`, note its key (for example `settings.language.hint`) and change the same key in your language's file. Never change `en.json` to fix a translation.
3. Keep every `{placeholder}` and `<tag>…</tag>` exactly as English has them (you may move them). Plurals are objects with the forms your language needs: `one`/`other` (German), `one`/`many`/`other` (Portuguese, Spanish, French: `many` is for millions, "1 000 000 de…"), `one`/`few`/`many`/`other` (Polish, Russian: `other` is for fractions).
4. Check: `node scripts/i18n-check.mjs` (it also runs with the tests) reports missing or stray keys, placeholders that differ from English and missing plural forms.
5. Long text: German and Russian run about a third longer than English. Look at the screen at 1280×720 as well as 1600×980.

## Adding text to the console (developers)

- Use `t("namespace.key", { vars })` from `apps/operator-web/src/i18n/index.ts`, or `<T k="…" values={…} tags={…} />` for text with links or code in it. Add the English text to `en.json` and every other catalog in the same change; the check fails otherwise.
- Module-level label tables use `perLocale(() => ({ … }))` so they follow the language.
- Numbers, dates and money: `formatNumber`, `formatDate`, `formatMoney`, or `lib/format.ts` (`fmtNum`, `fmtPct`, `fmtSec`, `fmtMs`): not `toFixed` or a hard-coded " s".
- `src/i18n/untranslated.test.ts` fails on English left in the console: JSX text, user-facing props, key/value rows and label tables (`perLocale` tables and constants named `…LABEL`, `…TEXT`, `…NAMES`), in the `.tsx` files and in `lib/` and `api/`. Brand names, abbreviations in capitals, code-like strings and the text of `<code>`/`<kbd>`/`<Mono>` are allowed; a table kept English on purpose goes in `KEPT_TABLES` with the reason. `PENDING` (files not translated yet) is empty: keep it so.
- Badges set their own capitals: write "Dead", not "DEAD", so each language gets its own.
- Tests render in English: nothing switches the language unless a test does.
