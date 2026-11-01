# Team Comms: both teams' TeamSpeak, per person, delayed

What this is for: the owner's brief, [docs/specs/team-comms-brief.md](../specs/team-comms-brief.md). The decision records: ADR-065 (capture, bridge, buffers, mixes) and ADR-066 (on air: the public listen-in, NDI outputs, preview, ducking, overlay) in [decisions.md](../architecture/decisions.md).

This document covers **phases 1 to 3** of the brief's delivery order: the feasibility checks with real evidence (phase 1); the base in the engine, i.e. the bridge to TeamSpeak, identities, timestamped per-person buffers and the mixes (phase 2); and the public side (phase 3): one output-state controller for the public listen-in (Listen In — [team], End Listen-In, Mute All Comms), the public and recording mixes leaving the engine as NDI audio-only sources for OBS, the operator's private preview in their headphones, caster ducking, the team-only TEAM COMMS overlay, the **Team Comms** page and compact controls in Live Control, and the OBS setup with its routing checks. The dedicated recording and its speaker strip (phase 4), reconnect polish, event presets and the installer (phase 5) come later (the plan is at the end).

## Status

| Part | Status | Evidence |
|---|---|---|
| TeamSpeak 3 plugin: per-person decoded voice before the mix, identities, bounded lock-free hand-off, sender thread | **Real-integration-tested** (Linux, TeamSpeak 3.6.2 client, 3.13.8 server) | Runs r2, r3, rig4 below |
| Plugin: listen-only (microphone deactivated and muted, never deafened), local playback silenced, recording status | **Real-integration-tested** (Linux) | Server's client list; the listener's own playback recorded |
| Plugin for Windows (DLL) | Built with mingw-w64 here and **run under Wine** against the engine (fixture host, not TeamSpeak); MSVC build added to `windows-program.yml`, **not run yet** | Wine run below |
| Plugin in TeamSpeak 3 on Windows | **Not tested** (no Windows here): the owner's PC | — |
| Bridge (127.0.0.1, token, validated wire format, bounds, reconnects) | Implemented; fixture-tested; real-integration-tested | `team-comms.test.ts`, `team-comms-plugin.test.ts`, runs |
| Team slots (team id, not CT/T), identities (team/server/identity), listener excluded, new people excluded, saved choices | Implemented; fixture-tested; real-integration-tested (identities, reconnects) | as above |
| Per-person sparse buffers on the engine's clock, clock mapping and drift, rate conversion, readiness, delay changes | Implemented; fixture-tested (incl. 90 s); real-integration-tested at 20 s | `team-comms-buffer.test.ts`, run r3 |
| Mixes: public (closed at start, one team at a time), recording, preview; gates after the buffers; per-person delayed activity | Implemented; fixture-tested; real-integration-tested (rendered to files, not to any device) | as above |
| Public listen-in: one output-state controller (OFF / BUFFERING — team / LISTENING IN — team / FAULT, in words), Listen In by team id, End Listen-In, Mute All Comms (public only), ready first, closed at start and after a bridge or slot reset or a lost source, never saved open | Implemented; fixture-tested; through the engine's API (e2e) | `team-comms-public.test.ts`, `team-comms-public.e2e.test.ts` |
| Team switch: the open team closed through silence before the other opens, no click | Implemented; fixture-tested (no 10 ms block holds both teams; no sample step beyond the tone's own slope) | `team-comms-public.test.ts` |
| NDI audio-only outputs "MatchFrame Comms" (public) and "MatchFrame Comms Recording", in their own process | Implemented; **real-integration-tested** with a real NDI receiver in another process (NDI 6.3.2, Linux); **DistroAV in OBS: blocked here** (owner's PC) | Phase 3 evidence below, `team-comms-ndi.test.ts` |
| Public silence enforced in Matchframe (zeros sent while closed, whatever the mix holds) | Implemented; fixture-tested; real NDI receiver: 0 bursts heard while closed | as above |
| Private preview: the preview mix over a WebSocket to the console, Web Audio to a chosen output (`setSinkId`), never NDI or OBS | Implemented; fixture-tested (engine side, real WebSocket); console player tested in jsdom (scheduling, device choice, fallback); **real headphones not tested** (owner's PC) | `team-comms-public.test.ts`, `commsPreview.test.ts` |
| Caster ducking through OBS while a listen-in is open (amount, ramp, inputs picked from OBS), released without overwriting operator changes, crash-safe, coexisting with the replays' ducking (whichever ends last restores) | Implemented; fixture-tested against a stand-in OBS (both orders, three cases); **real OBS not tested** | `team-comms-public.test.ts` |
| Team-only public overlay (`/comms/public` on the overlay server, TEAM COMMS banner with the team's name and logo, animated in and out), team-level state only; setup action adds it on top of the live scene | Implemented; fixture-tested (payload carries no person's name or id; page, script and token over HTTP; OBS setup against a stand-in OBS); **look not checked in a real OBS** | `team-comms-public.test.ts`, `team-comms-public.e2e.test.ts` |
| OBS routing check (Desktop Audio off, the comms source in the live scene and not monitored, the recording source off air, TeamSpeak not captured, caster inputs present) | Implemented; tested against a stand-in OBS | `team-comms-public.e2e.test.ts` |
| Console: Team Comms page (Live Control → Team Comms) and compact controls in Live Control | Implemented; component tests (jsdom); **not run in the packaged program here** | `TeamComms.test.tsx` |
| Event presets (mappings, levels, delay per event) | **Not built** (phase 5): mappings, choices and levels are saved per TeamSpeak identity, the delay and the on-air settings in the engine's settings | — |
| Support file (`teamComms`, `teamCommsPublic`) | Implemented; fixture-tested (no password, token, overlay token or full identity) | `team-comms.test.ts`, `team-comms-public.e2e.test.ts` |
| Second video recording: OBS Source Record | **Real-integration-tested** in OBS 30.0.2 (Linux, software rendering); Windows/GPU load **not measured** | Source Record run below |
| Second video recording: a second OBS instance | Evaluated, **not tried** | below |
| Public/recording audio into OBS: NDI audio-only from the engine (grandi) | Phase 1: sending and receiving measured (two processes); phase 3: built (row above); **reception in OBS (DistroAV) blocked here** | NDI runs below |
| TeamSpeak 6 | **Not tested, not claimed.** The plugin targets the TeamSpeak 3 client's plugin API 26 | — |

## How it works

```
TeamSpeak 3 client (owner's PC)                    Matchframe engine
 tab "Team A" ─┐  playback thread                   ┌─ bridge 127.0.0.1:37213 (token)
 tab "Team B" ─┤  onEditPlaybackVoiceDataEvent ──►  │   per plugin: clock map (pings), counters
               │   copy → lock-free queue, zero     │
               │  sender thread ── TCP ───────────► ├─ slots A/B = match's team A/B (by team id)
               │   identity, stamp, events, stats   ├─ people: team/server/identity, saved choices
               │  ◄── MANAGE / RECORDING / PING ─── ├─ VoiceBuffer per person (sparse chunks, 48 kHz)
               └─ mic off, sound silent here        └─ mixer every 10 ms at now − delay:
                                                        public · recording · preview (+ activity)
```

**The plugin** (`native/ts3-matchframe-plugin`, C++17, one DLL/.so):

- **TeamSpeak's playback thread** calls `ts3plugin_onEditPlaybackVoiceDataEvent(schid, clientID, samples, sampleCount, channels)` once per talking person per block, before TeamSpeak mixes them. On a tab Matchframe manages, the block is copied into a bounded lock-free queue (1 024 frames of up to 4 096 samples; a full queue drops the block and counts it, the callback never waits), then zeroed: the tab plays nothing on this computer. `onEditMixedPlaybackVoiceDataEvent` zeroes the tab's mix too (TeamSpeak's own sounds), and `onEditCapturedVoiceDataEvent` stops anything the listener might send.
- **TeamSpeak's main thread** (connection, move, nickname, talking events) keeps an identity cache and queues events; the queue never touches the audio thread.
- **The sender thread** reads `<data folder>/team-comms/bridge.json` (port and token, written by the engine), connects to 127.0.0.1, sends HELLO, each block with the speaker's `CLIENT_UNIQUE_IDENTIFIER`, the tab, the listener's own client id and the plugin's monotonic time (QueryPerformanceCounter / CLOCK_MONOTONIC), events, statistics each second; it applies Matchframe's commands. It reconnects with back-off. While Matchframe is away it drops audio (there is nothing to keep it for) and keeps tabs muted and silent.
- **Nothing is captured** until the engine says which tabs are the teams' (MANAGE). A tab that reconnects is captured again only after Matchframe checks it is still in the team's channel. A whisper or anyone outside the tab's own channel is dropped.
- **Listen-only:** `CLIENT_INPUT_DEACTIVATED` and `CLIENT_INPUT_MUTED` (others see the listener muted); re-applied if someone switches the microphone back on in that tab. Never `CLIENT_OUTPUT_MUTED` (deafening would stop the callbacks).
- **Recording status:** `startVoiceRecording` / `stopVoiceRecording` on the managed tabs when Matchframe signals recording (phase 4 ties it to the dedicated recording).

**The wire** (`services/local-engine/src/comms/wire.ts` has the layout): 12-byte header `MFTC`, version 1, type, length (≤ 1 MiB); JSON for HELLO/EVENT/STATS, binary for AUDIO (40-byte header, identity, int16 samples) and the engine's commands. Validated: format (int16 only), rate (8–48 kHz list), channels (1–2), frames, exact length, identity. TCP on 127.0.0.1 (not a named pipe) because Node and both platforms handle it the same and it tests the same here as on Windows; the token and the loopback-only listen (any other peer refused) protect it.

**The engine** (`services/local-engine/src/comms/`):

- `bridge.ts`: the TCP server. HELLO with the token within 3 s or ERROR and close; at most 4 plugins; at most 64 KiB before HELLO; a framing error closes, a bad message is dropped, counted and named; pings each second to map the clock.
- `clock.ts`: the plugin's µs onto the engine's ms: the answer with the shortest round trip of the last 10 s; small moves slewed (1 ms/s), jumps over 20 ms taken at once and counted; drift in ppm; before the first ping, the audio's own arrival bounds it.
- `buffer.ts`: one `VoiceBuffer` per person: sparse chunks (one per TeamSpeak block) at their place on the timeline; a block within 20 ms of the previous end continues it sample for sample; a pause starts a new chunk; a clock jump back of more than 200 ms cuts and re-lays; samples the outputs already played are dropped as late; other rates converted (linear, continuous), stereo to mono; trimmed to the delay + 2 s; all buffers together capped (512 MB default) by dropping the oldest audio, which makes that team "not ready" until the playhead passes it.
- `mixer.ts`: every 10 ms block at the playhead (output time − delay): **public** (silent unless one team is open; switching closes the old team to silence over 40 ms before opening the other), **recording** (its own team, independent), **preview** (soloed people). Inclusion and level are gains after the buffers, ramped over 10 ms: unchecking removes buffered speech from the next block. A team not ready at the playhead contributes nothing. Activity per person per output from the samples mixed (attack 15 ms, release 250 ms, speaking above −45 dBFS); the public output reports team level only. `CommsSink` is the interface the phase 3 outputs plug into.
- `service.ts` (`TeamComms`): slots, tabs, people, readiness, delay changes (fade out on the old playhead, then the new one, readiness checked again), the public gate closing itself when its team's source is lost (a new Listen In is needed), diagnostics.
- Routes: `GET /api/v1/comms`, `PUT /api/v1/comms/settings`, `PUT /api/v1/comms/slots/:slot` (passwords to the secret store), `PUT /api/v1/comms/participants/:key`, `POST /api/v1/comms/bridge/rotate-token`.

**On air (phase 3, `comms/controller.ts`, `outputs.ts`, `ndi-worker.ts`, `preview.ts`, `ducking.ts`, `overlay.ts`, `public.ts`):**

- **One output-state controller** (`ListenInController`) is the only thing that moves the public gate. *Listen In — [team]* (by the match's team id: halftime changes nothing) refuses unless Team Comms is on, the public output runs and that team's buffer holds the delay at the playhead (the button says why, e.g. "ready in about 42 s"); it closes the other team through silence first. *End Listen-In* closes it (40 ms). *Mute All Comms* closes it in 5 ms (no click) and leaves the recording and the preview alone. A lost source, a bridge or slot reset, the active match changing or the public output stopping closes it as **FAULT**, silent, until an explicit new Listen In (End Listen-In acknowledges it). A delay change while on air is **BUFFERING** (silent) until the longer delay is held, then on air again (the operator's Listen In stands; nothing was reset). Nothing about the listen-in is saved: every start is OFF. Recording and preview never call into it.
- **Outputs** (`CommsOutputs`): every 10 ms block of the public mix is checked once more before it leaves: while the gate is closed the block sent is zeros, whatever the mix holds. Public and recording blocks go, with their place on the engine's timeline, to the **NDI process** (forked like the replay feed's; the NDI binding loads only there): two audio-only senders, "MatchFrame Comms" and "MatchFrame Comms Recording", 48 kHz stereo 32-bit float (FLTp, the mix on both channels), 480-sample frames, each sent a fixed 60 ms after its own time on Matchframe's clock and stamped with that time as its NDI timecode. A block that isn't there in time goes as silence (and is dropped when it comes: never stale or repeated audio); a stalled process skips ahead. If the process stops, a listen-in closes (FAULT) and the process starts again after 3 s.
- **Preview:** the preview mix (the people soloed) goes over `/api/v1/comms/preview/ws` (operator token, production roles only) as 20 ms chunks of 16-bit samples with their timeline place; the console schedules them back to back with Web Audio on the output device picked (`AudioContext.setSinkId`, or an audio element's), 120 ms ahead, never more than 600 ms. Never NDI, never OBS.
- **Caster ducking** (`CommsDucking`): as a listen-in opens, the OBS inputs picked as the casters go down by the amount set (default −10 dB, 300 ms ramp), their volumes saved first (`comms.duck` in the engine's settings); as it closes (End, Mute All, a fault) they go back exactly, unless moved by hand meanwhile (then left alone), or the replays hold the same input (then left at the replays' level; they restore it). The replays' ducking (`replay/audio.ts`) asks the same of Team Comms (`DuckPeer`), so whichever ends last puts the volume back. Left down by a crash: put back at the next start, once OBS answers.
- **Overlay** (`CommsOverlay`): `/comms/public?t=<token>` on the overlay server (its script `/comms/public.js`; the overlay server allows no inline script), state over `/comms-ws`: `{type, v, onAir, team: {name, shortName, logoUrl, color}, label: "TEAM COMMS", placement}` and nothing else, ever. The page hides the banner whenever the engine isn't there.
- **Routes:** `POST /api/v1/comms/listen-in {teamId}`, `POST /api/v1/comms/listen-in/end`, `POST /api/v1/comms/mute-all`, `PUT /api/v1/comms/public` (NDI output, ducking, banner placement), `GET /api/v1/comms/obs/inputs`, `GET /api/v1/comms/obs/check`, `POST /api/v1/comms/overlay/obs`; `GET /api/v1/comms` carries the on-air state under `onAir`. Every action is in the audit log.

**Readiness, exactly:** a team is ready at the playhead when its tab has been captured without a break since before the playhead (and no audio before it was trimmed or dropped). After a (re)connection that is once the delay has passed. After a loss, the audio captured before it still plays out for the delay (it is real, delayed audio), then the gap is silence, then it resumes. The **public** listen-in does not wait for that: it closes at the loss.

**Delay:** 0–300 s plus −999…+999 ms, never less than 150 ms (the plugin-to-engine transport; measured p99 5 ms). The delay is measured from the moment TeamSpeak hands the block to playback, on the engine's clock. Calibration against the observer's gameplay is phase 4 (below).

## Setup

### TeamSpeak and Matchframe

1. Build the plugin (below) and install it: double-click `matchframe-team-comms.ts3_plugin` (TeamSpeak's add-on installer), or copy the DLL into `%APPDATA%\TS3Client\plugins\`. Tools → Options → Add-ons: *Matchframe Team Comms* enabled.
2. In TeamSpeak, connect a tab to each team's channel (bookmarks with *Connect on startup* are easiest). **On a default server each identity can be connected once:** give the second tab its own identity (Tools → Identities → Add, then pick it in the bookmark) or ask the server admin to allow two connections per identity (`i_client_max_clones_uid`). Two TeamSpeak clients, one per team, work too.
3. In Matchframe: activate the match (its team A and team B are the slots). **Live Control → Team Comms → Bridge and TeamSpeak plugin:** Team Comms on; each team's server address, port and channel (passwords go to Matchframe's secure settings and are never shown again; the bridge token is never shown either: the plugin reads it from the bridge file; *Rotate token* makes a new one).
4. Matchframe writes `%APPDATA%\Matchframe Esports\team-comms\bridge.json`; the plugin finds it, connects, and Matchframe takes over the two tabs (muted, silent, captured). Each team panel shows its TeamSpeak tab, the listener (microphone off, not deafened), readiness and everyone in the channel, **excluded until you include them** (Include in Broadcast, Include in Recording), with a level, a roster player to map them to, a live (incoming) meter, a delayed meter (at the outputs' time) and Solo for your headphones.
5. **Delay:** seconds plus a fine adjustment in ms, shared by both teams (they play against the same gameplay). Calibrating it against the observer's gameplay as recorded is phase 4; until then set it to the gameplay delay you use.
6. **Preview in your headphones:** pick the headphones (an output OBS doesn't capture), *Listen in headphones*, Solo someone. Only you hear it.

### OBS (one PC)

Matchframe sends the comms; OBS only receives them. Install **DistroAV** (the OBS plugin for NDI; 6.x, with the NDI 6 Runtime it asks for: Matchframe's own NDI runtime is inside Matchframe and isn't OBS's).

1. **Desktop Audio off:** Settings → Audio → Global Audio Devices → Desktop Audio: *Disabled* (and Desktop Audio 2). A desktop capture takes everything the PC plays: TeamSpeak's own sound if it ever played, the operator's preview, a second copy of the comms.
2. **Game audio as its own source** in the live scene: Add → Application Audio Capture → *[cs2.exe]: Counter-Strike 2*, named e.g. "Game audio".
3. **Casters as their own source(s):** Add → Audio Input Capture (a microphone, or the casters' mixer), named e.g. "Casters". In Matchframe, **Team Comms → Caster ducking:** tick them, choose the amount (default −10 dB) and the ramp.
4. **Comms:** in the live scene, Add → *NDI™ Source*, named **MatchFrame Comms**; Source: *<this PC's name> (MatchFrame Comms)*; Bandwidth: *Audio only*. Then Advanced Audio Properties → MatchFrame Comms → Audio Monitoring: **Monitor Off**; tracks: the stream's. Add the same source (Add → Existing) to any other program scene in which a listen-in may continue. Its silence when no listen-in is open is Matchframe's (zeros are sent): don't rely on muting it in OBS, and don't leave it muted either.
5. **Team-only graphic:** **Team Comms → Public Team Comms graphic → Add to the live scene in OBS** (a 1920×1080 browser source "MatchFrame Team Comms" on top of the live scene; its position under the scorebar or near the bottom, set there).
6. **Recording comms (phase 4):** *<this PC's name> (MatchFrame Comms Recording)* is for the dedicated recording's own scene (Source Record) only. **Never in a program scene.**
7. **Team Comms → OBS routing check:** Desktop Audio off, MatchFrame Comms in the live scene and not monitored, the recording source off the program, no capture of TeamSpeak itself, the caster inputs present. Then the listening tests below.

Never add a capture of TeamSpeak (Application Audio Capture of ts3client) or of Matchframe's own window: comms reach OBS only as *MatchFrame Comms*.

### Routing

```
 TeamSpeak 3 (team tabs, local playback silenced by the plugin)
      │ per person, before TeamSpeak's mix
      ▼
 Matchframe engine ── per-person buffers on one timeline (delay) ──┬─ public mix ──► guard: zeros unless LISTENING IN ──► NDI "MatchFrame Comms" ─────────┐
                                                                    ├─ recording mix ─────────────────────────────────────► NDI "MatchFrame Comms Recording" ─┐ │
                                                                    └─ preview mix ──► WebSocket ──► console (Web Audio, setSinkId) ──► operator headphones  │ │
                                                                                                                         (OBS never captures this device)  │ │
 Matchframe overlay server ── team-level state ──► OBS browser source "MatchFrame Team Comms" (live scene, top)                                                │ │
                                                                                                                                                              │ │
 OBS: live scene = game capture + HUD + "Game audio" (CS2 app capture) + "Casters" (mic, ducked by Matchframe during a listen-in) + "MatchFrame Comms" ◄───────┘ │
      Desktop Audio: disabled · monitoring of MatchFrame Comms: off                                                                                              │
      dedicated recording scene (phase 4, Source Record): gameplay + HUD + speaker strip + "MatchFrame Comms Recording" ◄─────────────────────────────────────┘
```

### Listening tests: loopback, duplication, feedback (on the owner's PC)

The routing check reads OBS's lists; these listen to what actually goes out. Record the program in OBS while doing them, and play the recording back.

1. **Silence when off (loopback):** no listen-in (OFF), a team talking. OBS's *MatchFrame Comms* meter stays at −∞ and the program has no comms; the PC's speakers play nothing of TeamSpeak.
2. **Preview isolated:** Solo someone, listen in the headphones, still no listen-in: the headphones carry the voice, every OBS meter stays still. Then Listen In — the *other* team: the program carries only that team; the soloed person stays in the headphones only.
3. **Duplication:** Listen In; someone says a short sharp word. In the recording it is there once: no second copy 0–500 ms later (a desktop capture or audio monitoring would add one).
4. **Feedback:** during a listen-in with the casters quiet, the Casters meter stays at its noise floor (comms in the casters' headphones must not reach their microphones), and the comms carry no echo of the program.
5. **Team switch:** Listen In A, then Listen In B while both teams talk: no moment with both teams, no click.
6. **Mute All Comms** during speech: the program is silent at once; the recording source (phase 4) carries on.
7. **Restart:** close Matchframe during a listen-in and start it again: comms come back OFF, the casters at their own volume.

## Building the plugin

The TeamSpeak 3 Client Plugin SDK headers are TeamSpeak's ("all rights reserved"); they are **not in this repository**. `scripts/fetch-sdk.mjs` downloads the 7 headers from https://github.com/TeamSpeak-Systems/ts3client-pluginsdk at commit `4aa90a5` (tag 26, plugin API 26) and checks each SHA-256 (`sdk.json`).

```
node native/ts3-matchframe-plugin/scripts/fetch-sdk.mjs              # NODE_USE_ENV_PROXY=1 behind a proxy
cmake -S native/ts3-matchframe-plugin -B build -A x64                # Windows, MSVC (what CI does)
cmake -S native/ts3-matchframe-plugin -B build -DCMAKE_BUILD_TYPE=Release                                    # Linux
cmake -S native/ts3-matchframe-plugin -B build -DCMAKE_TOOLCHAIN_FILE=cmake/mingw-w64.cmake -DCMAKE_BUILD_TYPE=Release   # Windows DLL from Linux
cmake --build build --config Release
node native/ts3-matchframe-plugin/scripts/package.mjs build/Release/matchframe_comms_win64.dll   # → dist/*.ts3_plugin, plugin.json
```

`windows-program.yml` builds it with MSVC (static runtime), packs it, and the program ships it in `resources/ts3-plugin/` (`plugin.json` says `built: false` when it wasn't built). The installer step that offers it to the operator is phase 5.

## Phase 1 evidence

Environment: Linux container (Ubuntu 24.04, 4 cores, 16 GB, no GPU), Node 22.22.0, Xvfb, PulseAudio 16.1 with null sinks, ALSA → PulseAudio plugin. Scratch scripts and raw results are not in the repository; the reproducible rig is `native/ts3-matchframe-plugin/test/real/ts3-rig.sh`.

### A. TeamSpeak 3 per-person capture

**Vendor material read:** the SDK headers and sample plugin at commit `4aa90a5` (2023-07-31, "update to plugin API version 26"); the client's changelog ("3.6.0: Plugin API increased to 26"). Callbacks used: `onEditPlaybackVoiceDataEvent` (per client, before mixing), `onEditMixedPlaybackVoiceDataEvent`, `onEditCapturedVoiceDataEvent`, `onConnectStatusChangeEvent`, `onClientMove*`, `onClientKickFrom*`, `onClientDisplayNameChanged`, `onTalkStatusChangeEvent`, `onClientSelfVariableUpdateEvent`, `onServerErrorEvent`; functions `getClientVariableAsString(CLIENT_UNIQUE_IDENTIFIER, CLIENT_NICKNAME)`, `getChannelClientList`, `getServerVariableAsString(VIRTUALSERVER_UNIQUE_IDENTIFIER)`, `getServerConnectInfo`, `setClientSelfVariableAsInt(CLIENT_INPUT_DEACTIVATED, CLIENT_INPUT_MUTED)`, `flushClientSelfUpdates`, `start/stopVoiceRecording`. The SDK's licence: copyright TeamSpeak Systems GmbH, all rights reserved (hence fetched, not vendored).

**Software:** TeamSpeak 3 Server **3.13.8** (Linux amd64, build 1779874471, SHA-256 `a3c4658e…6eb2d` as published on teamspeak.com), free licence accepted with `TS3SERVER_LICENSE=accept` (its LICENSE: "Unlicensed", one virtual server, 32 slots, non-commercial). TeamSpeak 3 Client **3.6.2** (Linux amd64, build 1695203293, SHA-256 `59f11044…006422` as published; its terms accepted through the installer's `--accept` for this test). Downloaded from files.teamspeak-services.com; not redistributed.

**Rig:** two team channels (Opus Voice, quality 10). A listener client with the plugin, two tabs (*MF Listener A* in Team Alpha, *MF Listener B* in Team Bravo); 14 talking clients (7 per channel), each its own identity, its microphone a PulseAudio null sink playing a distinct tone (A: 330–1170 Hz, B: 1310–2150 Hz in 140 Hz steps), 2 s of every 6 s, person *i* 0.7 s after person *i*−1: 2 to 5 people of a team talk at once. The listener's playback went to its own null sink, recorded throughout. Test-server changes: flood prevention relaxed (16 clients from 127.0.0.1 within seconds tripped it), two connections per identity allowed for the one-client-two-tabs listener (see the identity finding). Talkers used TeamSpeak's level-only voice activation (`vad_mode=1`): the default hybrid mode took pure tones for noise and didn't send.

**Runs:** r2 (330 s, delay 150 ms), r3 (262 s, delay 20 s: plus a server kick of listener B, then the listener client killed and restarted), rig4 (the in-repo harness with one listener client per team and the integration test).

| Measured | Result |
|---|---|
| Callback format | **1 channel, 48 kHz int16, 360 samples (7.5 ms) per call** (195 718 of 195 784 blocks; the rest 720/1 080 when two or three were late). Rate inside talk spurts: median 48 128 Hz (p5 47 914, p95 48 187) incl. spurt-edge error. Spacing per person: median 7.5 ms (p1 4.2, p99 10.7) |
| Callbacks with zeroed samples | Kept firing: tab 1 117 530 calls, 95 076 after Matchframe managed it, all 95 076 zeroed; tab 2 100 540 zeroed. Mixed callback zeroed 31 867 times; 766 of those had sound before zeroing (TeamSpeak's own join/leave sounds) |
| Local playback | Listener's output: peak **0.57–0.67** while unmanaged (voices playing), **exactly 0.0** for the 230 s (r2) and 186 s (r3) after |
| Listen-only | Server's client list throughout: both listeners `client_input_muted=1`, `client_output_muted=0` (not deafened), `client_flag_talking=0`; the plugin never had to block a microphone block |
| Recording status | After the signal: both listeners `client_is_recording=1` |
| Identities | 14 identities, each only on its own team's tab, by `CLIENT_UNIQUE_IDENTIFIER`; listener never a person |
| Overlap kept apart | 100 ms windows with 2/3/4/5 people of one team talking: 895/2 293/1 409/180 (r2). Each person's stream, Hann-windowed 100 ms, steady speech: every other person's tone **−59 to −70 dB** below their own (median), worst −24 to −44 dB (at the test tones' 21 ms on/off steps) |
| Other channel | No Team A identity ever arrived on Team B's tab or the reverse; the listeners never transmitted |
| 7 per channel | 7 + 7 talkers + 2 listeners + ServerQuery = 17 clients, within the free licence's 32 slots. CPU: each TeamSpeak client ~10 % of a core and ~190 MB here (software GL); 15 of them, the server and PulseAudio used about half of the 4 cores |
| Transport | Plugin stamp → engine: median 1.3 ms, p99 4–5 ms, max 33–44 ms. 195 784 blocks, 0 sequence gaps, plugin queue 0 dropped (deepest 9 of 1 024) |
| Clocks | Offset steady to ±0.02 ms, drift −0.05…+0.26 ppm, 0 jumps, round trip 0.15–0.2 ms. (The first 12 s of r2 were 12 ms off: the audio's estimate before the first ping. Fixed: the first ping now replaces it at once, and a burst's blocks all update the clock before any is placed.) |
| Delay | r3 at 20 s: each speech onset in the recording output came **0.0 ms** from capture + 20 000 ms (17 onsets, 1 ms detector step) |
| Readiness | Enabled at 76.1 s → *buffering* → *ready* by 101.3 s (status sampled every 5 s) |
| Reconnects | A talker killed and restarted: same identity, client id 40 → 52, same person and choices (the server named it "Alpha 21" while the old connection timed out). Listener B kicked by the server (150 s): its slot went *waiting*, played out its last 20 s, *buffering* across the gap, *ready* at 176 s; new listener client id. Listener client killed (190 s): **public listen-in closed** (reason recorded), slots *waiting*; restarted (229 s): new plugin instance, both tabs re-bound, *ready* at 246/251 s, **public still closed** |
| Exclusion while speaking | Alpha 1 excluded from the recording mid-sentence: 50 ms before 0.092, from +20 ms **0.0001**, the next second 0.0002 (never-included Alpha 6: 0.0003; included Alpha 2: 0.125) |
| Independent selections | Recording (Alpha 1–5) and broadcast (Alpha 1, 2, 6): each output held exactly its people at 0.07–0.14; the others at the measuring floor (≤ 0.0034, as Team B's tones that were never routed) |
| Engine | 8 % of one core over 331 s with every block also written to disk for the analysis; RSS 173–176 MB, steady |

**Found along the way (fixed):** the plugin's string getters returned empty strings (C++ leaves argument order unspecified: `f(call(&s), s)`); zod 4's `.partial()` keeps `.default()`s, so `{enabled: true}` reset the delay — patches are now default-free (`patchOf`). **TeamSpeak constraints for the owner:** a default server allows one connection per identity (Guest group, `i_client_max_clones_uid`): "Maximum number of connections with the same identity exceeded" — the plugin forwards TeamSpeak's refusals and Matchframe shows them next to the waiting slot. The TeamSpeak client crashed once at startup in this container (a glibc priority-inheritance assertion, without the plugin); not seen otherwise.

**The plugin binary without TeamSpeak** (`team-comms-plugin.test.ts`, every test run with g++ and the SDK headers): the real `.so` loaded by a stand-in host (`test/host.cpp`) calling its callbacks from one audio thread per tab: listen-only applied, recording signalled, >90 % of blocks zeroed (the rest before MANAGE arrived), six people identified, a reconnect re-resolved, 0 invalid messages, 0 sequence gaps, 0 queue drops.

**The Windows DLL under Wine 9.0** (mingw-w64 13 posix, static; imports only KERNEL32, msvcrt, WS2_32), with `host.exe`, against the engine on Linux: connected over Winsock to 127.0.0.1, read the bridge file from a `Z:\…` path, listen-only and flush on both tabs, recording start/stop, 6 366 of 6 402 blocks zeroed (36 before MANAGE), 2 122/2 134 mixes zeroed, 6 people identified, a reconnect re-resolved. Not TeamSpeak on Windows.

**TeamSpeak 6:** not tested. Its client is a different program (TeamSpeak 6 client 6.0.0 betas); whether it loads TeamSpeak 3 plugins, with which API, is not established here. Not claimed.

### B. The independent second recording

**Source Record** (exeldro), **0.4.8** (tag `0.4.8`, 2026-03-25), **GPL-2.0**. Windows and macOS builds are published on the OBS forum (https://obsproject.com/forum/resources/source-record.1285/); Linux: built here out of tree (`cmake -DBUILD_OUT_OF_TREE=On`) against libobs 30.0.2 (Ubuntu's `libobs-dev`), it loaded in OBS **30.0.2**. It adds a filter that renders its source (here a scene) through its own `obs_view` and video output with its own encoder, so the scene is recorded whether or not it is on program. Audio: by default the source's own audio (for a scene, its sources' audio, independent of OBS's mixer tracks); optionally one OBS track (1–6), all tracks, or another source's audio.

Test (OBS 30.0.2, 1920×1080 at 60 fps, Xvfb, Mesa llvmpipe): scene *MF Comms Recording* = the gameplay source (shared with the program's gameplay scene) + a recording-comms audio source (600 Hz) + a speaker-strip stand-in; Source Record on it (x264 *ultrafast*, 12 Mb/s, AAC). The program cut between gameplay and a casters scene (red, caster microphone at 300 Hz) every 4 s for 60 s, and OBS also recorded the program (x264 *ultrafast*).

| | Source Record file | Program recording |
|---|---|---|
| File | 60.02 s, 3 601 frames, 1080p60 H.264 + 1 stereo AAC track | 60.44 s, 3 625 frames |
| Picture (300 frames sampled) | **300 gameplay, 0 casters**; speaker strip in 300 | 142 casters, 160 gameplay; strip in **0** |
| Audio | game 1 kHz present (0.049–0.125), **comms 600 Hz present** (0.069–0.088), **casters 300 Hz absent** (≤ 0.003) | casters present, **comms absent** (≤ 0.0015) |

Load here is not the owner's: OBS used 320–356 % of 4 cores and rendered only 7–14 of 60 frames a second (software rendering on the CPU; 3 246 of 6 198 frames skipped), so both files repeat frames. Disk: 1.5 MB/s at 12 Mb/s (about 5.5 GB an hour).

**A second OBS instance** (`obs --multi --profile … --collection …`): a second full renderer and compositor, a second capture of the game (two game captures hooking CS2, or a window/display capture), its own scene collection to keep in step with the first, and Matchframe's OBS control talking to two OBSes. Not tried here. Its advantage: a crash or overload in one doesn't take the other.

**Recommendation: Source Record** in the broadcast OBS: one game capture and one render loop shared with the program, a scene that stays on gameplay whatever the program does, its own encoder and file, the scene's own audio (game + recording comms, casters left out by not putting them in the scene). Fallback: the second instance. **On the owner's PC:** NVENC (or the GPU's encoder) for Source Record next to the stream encoder; game capture shared by both scenes; GPU and encoder load at 1080p60 with the broadcast running; the Source Record version for the installed OBS (30 or 31); split files and what a crash leaves (MKV or hybrid MP4).

### C. Audio into OBS without capturing the program

**NDI audio-only from the engine** (grandi 2.0.2, already shipped for the replay feed; NDI SDK 6.3.2.0): a sender with `clockAudio` sending 10 ms blocks of 48 kHz stereo float, a receiver in another process (as DistroAV would be): over 180 s **17 989 of 17 989 frames, 0 dropped, 0 timeouts**, 47 969 samples/s, a burst each second arriving **10.5 ms** after it was sent (median; p95 11.1, max 20.1). Discovery needed the loopback address (`extraIPs`) in this container (no mDNS); the first attempt took 43 s to find the source.

**DistroAV** (the owner already receives NDI in OBS with it): **6.2.2**, GPL-2.0, Linux packages (.deb, Flatpak) built for OBS 31.1.1. Here (OBS 30.0.2) building it failed at Qt 6 headers it includes even with `ENABLE_QT=OFF`: **OBS-side NDI reception not tested here (blocked).**

**VB-CABLE** (VB-Audio): free for the user to install, but its licence does not allow bundling it in another program without a licence from VB-Audio; Matchframe would also need a native module to write to a WASAPI device from Node. A dependency the operator installs.

**Recommendation** (built in phase 3 as *MatchFrame Comms* and *MatchFrame Comms Recording*): two NDI audio-only sources from the engine, each an OBS source through DistroAV (public into the program's audio, recording only in the Source Record scene). Their silence is the engine's (the mixes are silent unless open); nothing of TeamSpeak or of the preview is on them; OBS's Desktop Audio stays off. **Private preview:** the console window plays the preview mix with Web Audio to the operator's headphones (`setSinkId`), never through OBS, a device OBS doesn't capture. **On the owner's PC:** DistroAV's latency and buffering for an audio-only source, NDI on the loopback, the drift between NDI's audio clock and OBS's, and a loop/duplication test (Desktop Audio off, TeamSpeak's own playback silenced by the plugin).

## Phase 3 evidence

Same container as phase 1 (Ubuntu 24.04, 4 cores, Node 22.22.0), NDI SDK 6.3.2.0 inside grandi 2.0.2.

### NDI outputs, received in another process

`pnpm exec tsx services/local-engine/scripts/comms-ndi-measure.ts 180`: the engine's outputs (the public guard and the NDI process, forked as the engine forks it) fed real-time 10 ms blocks the way the engine renders them (every 5 ms, whatever has ended), and a real NDI receiver in another process (`test/helpers/comms-ndi-receiver.ts`, as DistroAV would be), found through the loopback address. The public mix carried a 1 kHz burst every 500 ms throughout; the public gate was closed for the first second and the second half, so any burst heard then would be a leak past Matchframe's guard. The recording mix carried a 600 Hz burst every 500 ms. Latency: from a block's own time on the engine's timeline to its arrival at the receiver.

| 180 s, defaults (sent 60 ms after its own time, paced on the engine's clock) | MatchFrame Comms | MatchFrame Comms Recording |
|---|---|---|
| Frames received | 18 001, **100.00 a second** | 18 001, **100.00 a second** |
| Format | **48 000 Hz, 2 channels (the same mix on both), 480 samples** (32-bit float) | same |
| Dropped (NDI's own count at the receiver) | **0** | **0** |
| Latency (bursts matched) | median **60.5 ms**, p95 61.3, p99 64.0, max 64.4 (178 bursts) | median **60.4 ms**, p95 61.1, p99 62.3, max 66.0 (360) |
| Silence while closed | **0 bursts heard while the gate was closed**; 16 221 frames all zeros; all 178 open-gate bursts heard | — |

The sending process: 18 002 frames, 0 blocks missing in time (underruns), 0 late, 0 resyncs; each frame left 59.5–60.6 ms after its own time; the longest send 2.4 ms; one receiver connected to each source. Finding the sources took 5 ms (by the loopback address; phase 1 noted the container has no mDNS).

**NDI's own clocking compared** (the same run with `clockAudio`): 99.91 frames a second arrived, so the latency crept from 60 ms to about 140 ms over three minutes until the sender skipped ahead (one resync, 12 blocks dropped). Hence pacing on the engine's clock by default (setting: Team Comms → Public output → Output settings). An earlier unclocked run while other work loaded the machine: the same 60.5 ms median, one 120 ms stall of the sending process absorbed by one resync.

**What it doesn't show:** DistroAV's reception in OBS (its own buffering, its sync modes, what OBS adds), and how Node's timers pace the sends on Windows (the frames carry their own time as their NDI timecode for a receiver that times by it). Both on the owner's PC.

### Routing, gating and console (fixtures)

Covered by the tests below: the controller's states and transitions; broadcast off as exact zeros to NDI while both buffers and the recording carry on; team switch with no 10 ms block holding both teams and no sample step beyond the tone's own slope; Mute All silent from 5 ms; faults (bridge loss, the NDI process stopping or failing) silent and not reopened by the source coming back; halftime; delay change; never saved open; the preview only in the headphones' stream; the overlay's messages free of any person; ducking with the replays' in every order; the engine's routes, pages, sockets and the OBS routing check; the console's page, live room card and preview player.

## Tests

- `services/local-engine/test/team-comms.test.ts` (fixture: the real bridge over TCP, a stand-in plugin, simulated clock, a tone per person): two teams of seven over each other kept apart by identity; five included, two excluded; independent broadcast and recording; exclusion of buffered speech within a block and a fade at a 10 s delay; a **90 s delay** (onset and end within 10 ms, activity in the same block, nothing before 90 s of history); reconnects with new session ids (choices kept, public closed and not reopened); an unknown identity, also with a known nickname, excluded; halftime (slots by team id); bridge loss (public silent at once, recording after its buffered audio); delay change and 44.1 kHz input; token, HELLO-first, format/rate/channels/length checks, listener never a source; support file without secrets.
- `team-comms-buffer.test.ts`: buffer placement under jitter, gaps, clock jumps, late samples, resampling, trims; clock (pings, drift, jumps, audio before pings); mixer gates (team switch through silence, silent at start, not-ready silence).
- `team-comms-plugin.test.ts`: the real plugin binary in the stand-in host against the real bridge (skipped without g++ and the SDK headers).
- `team-comms-public.test.ts` (phase 3, fixture, simulated clock, stand-in NDI process, stand-in OBS): the output-state controller (OFF at start; refused while buffering with the time left; recording and preview never open it; LISTENING IN in words), broadcast off ⇒ exact zeros while buffers and the recording continue, team switch without overlap or click, End and Mute All (5 ms, the recording and preview carry on), bridge loss ⇒ FAULT and not reopened, the NDI process stopping or not starting ⇒ FAULT and Listen In refused, halftime by team id, delay change ⇒ BUFFERING then on air, never saved open, the private preview over a real WebSocket absent from the public, recording and NDI blocks, the overlay's payload without any person's name or id, caster ducking (put back exactly, a moved fader kept, three orders with the replays' ducking, a crash put right at the next start).
- `team-comms-public.e2e.test.ts` (phase 3, the engine with its own clock): the routes (Listen In by team id, unknown team refused, Mute All, End, audit), the overlay page (token, CSP, external script) and its socket (team only), the preview socket refused to a viewer, the overlay added on top of the live scene in a stand-in OBS, the OBS routing check before and after the documented fixes, the support file without the overlay's token.
- `team-comms-ndi.test.ts` (phase 3, real NDI, skipped when the binding doesn't load or `MATCHFRAME_SKIP_NDI` is set): 8 s of the measurement above with its assertions (format, frame rate, no drops, no leak while closed, latency steady).
- `apps/operator-web/src/screens/TeamComms.test.tsx`, `src/lib/commsPreview.test.ts` (jsdom): the page (the state in words and shape, the four actions by team id, per-person inclusion, roster mapping, Solo, meters labelled live vs delayed, delay seconds + ms, passwords and token never shown, the overlay into OBS, caster inputs from OBS, the routing check, permissions), the live room card (FAULT with its reason, Mute All), the preview panel (devices, start on the chosen headphones, change device), the player (decoding, back-to-back scheduling, a gap, a burst dropped, `setSinkId`, the audio-element fallback).
- `team-comms.ts3.integration.test.ts`: real TeamSpeak, skipped unless `MATCHFRAME_TS3_RIG` points at a running `ts3-rig.sh` rig: both tabs captured listen-only and not deafened, everyone by identity in their team, each person soloed in the preview carrying only their own tone (others at least 30 dB down), no invalid messages, gaps or drops. Passed here in 186 s.

## Needs the owner's Windows PC

- The plugin in TeamSpeak 3.6.2 on Windows (CI's MSVC build): loads, both tabs captured, listen-only, playback silent on the PC's speakers, recording status, CPU of the plugin and TeamSpeak with 14 people.
- Both tabs' identities (or two clients) against the teams' real server, its connection limits and channel passwords.
- Source Record on the installed OBS (30 or 31) with the GPU encoder at 1080p60 next to the stream, and game capture shared.
- DistroAV receiving "MatchFrame Comms": found, audio-only, its latency and sync mode (Network vs Source Timing) and the drift against OBS's own audio clock over an hour, the comms aligned with the gameplay at the configured delay (adjust the fine ms by what DistroAV adds), then the listening tests (loopback, duplication, feedback, preview isolation, team switch, Mute All, restart).
- The preview in real headphones from the packaged program: the output list (labels), `setSinkId` to a device OBS doesn't capture, gaps over a long session.
- Caster ducking against the real OBS mixer (and with a break's replays), and the TEAM COMMS banner's look and position over the HUD in the live scene.
- NDI sends paced by Node's timers on Windows (the NDI process's lag and resync counters are in the Team Comms page and the support file).
- The single-PC load with CS2, OBS streaming, Source Record, TeamSpeak and Matchframe together.

## Plan for phases 4–5

- **Phase 3 is done** (above): the controller, the NDI outputs, the preview, caster ducking, the team-only overlay, the console, the OBS setup and checks. What it leaves: DistroAV, headphones, real OBS ducking and the banner's look on the owner's PC (above).
- **Phase 4 (dedicated recording and speaker strip):** the Source Record scene set up by Matchframe (gameplay + HUD + strip + recording comms), Start/Stop, team selector, game/comms levels, folder, status, disk-space warnings, file recovery; the strip as a recording-only overlay route driven by the recording mix's delayed activity (`MixBlock.activity.recording`) on the same timeline; TeamSpeak's recording signal tied to it; the recording team selector and its own Start/Stop and status in the console (the "MatchFrame Comms Recording" NDI source already carries the recording mix: phase 4 sets its team and puts the source in the recording scene); calibration of the comms delay against the observer's gameplay (a clap/flash test: the offset between the delayed comms and the captured gameplay, measured in the recorded file).
- **Phase 5 (reconnects, recovery, presets, installer, validation):** connecting the team tabs from Matchframe (the plugin running `guiConnect` on TeamSpeak's main thread), persisting the managed tabs in the plugin so a restarted TeamSpeak is silent before Matchframe answers, event presets (mappings, levels, delay), offering the `.ts3_plugin` from the program, soak runs on the owner's PC.
