# Team Comms — owner's implementation brief (1 November 2026)

The owner's brief for the Team Comms module, kept as written (the reference picture, IMG_6256.jpeg, is not in the repository: it shows real people and is a design reference only; see section 8.1).

> Visual update · 1 November 2026: the owner supplied IMG_6256.jpeg as the reference for the recording-only speaker strip. Follow section 8.1. The public broadcast continues to use the team-only comms graphic.

This is an implementation brief for an addition to the existing MatchFrame Esports application. It describes required behaviour, not features already implemented or tested.

## Instructions

Inspect the existing repository, AGENTS.md instructions, audio/video architecture, OBS adapter, match/roster models and installed integrations first. Extend the existing application and its design system. Build working capture, timing, mixing, graphics and recording paths, not a disconnected interface.

Begin with real feasibility checks for TeamSpeak capture and the second video recording. Record the supported TeamSpeak, plugin API, OBS and recording-plugin versions. Use the existing stack where practical; implement a native companion component where audio callbacks require it. Continue through the phases below and distinguish implemented, fixture-tested, real-integration-tested and blocked work. A simulated input is useful for testing but is not evidence of working TeamSpeak capture.

## 1. Product outcome

A Team Comms module for CS2 broadcasts. Everything on the production side must be able to run on the owner's main Windows PC alongside TeamSpeak, MatchFrame Esports and OBS. The TeamSpeak server can be wherever the teams normally connect.

Connect to both teams' voice channels simultaneously. Support at least seven people in each channel, including players, coaches, substitutes and managers. The operator must be able to choose exactly which people are heard in each output.

The public broadcast gets comms only when the operator presses Listen In — [team name]. It must not visually identify the individual speaking. A separate gameplay recording gets its own selected team comms and a graphic identifying the included players who are speaking.

For example, a channel can contain five players, a coach and a manager. The operator can include only the five players in either output while all seven remain able to communicate normally in TeamSpeak. Five is an example selection, not a hard-coded participant limit.

## 2. Output contract

| Destination | Picture and graphics | Audio | Gate and ownership |
|---|---|---|---|
| Public broadcast | Normal production. During a listen-in, team name/logo and a general TEAM COMMS banner only. | Normal game/caster mix plus the selected team's permitted delayed voices during a listen-in. | Controlled by public Listen In / End Listen-In. One team's comms on air at a time. |
| Dedicated comms recording | Continuous observer gameplay, normal MatchFrame game HUD and a separate speaker panel. | Game audio and the recording-selected team's permitted delayed voices. Caster audio excluded by default. | Recording state and team selection independent of public listen-in. |
| Private production monitoring | Participant rows, identities, levels and speaking activity in MatchFrame. | Operator-selected preview or solo feed to headphones. | Never routed into public audio just because the operator previews it. |

Existing names and statistics on the normal CS2 HUD are fine. The public restriction is specifically no attribution of comms to an individual: no voice-triggered player name, avatar, microphone badge, highlighted roster card or per-player voice meter. The public comms overlay should receive team-level state only. Use separate overlay routes/components for public and recording graphics.

The default scope is one public broadcast plus one separate comms video recording. Recording both teams into two additional videos is not required. The operator selects which team is used by the dedicated recording; never sum both teams' conversations automatically.

## 3. TeamSpeak integration

Use a TeamSpeak 3 client companion plugin as the initial supported integration, with two voice connections/tabs: one per team. They may connect to different channels on the same server or to different servers. Respect normal server access, connection limits and channel permissions. Make connection failures actionable in the UI.

TeamSpeak's standalone voice SDK and its client Plugin SDK are different products. The standalone SDK is not a drop-in client for normal TeamSpeak servers. ServerQuery is not an audio capture API. Inspect the current vendor documentation before selecting dependencies. Do not claim TeamSpeak 6 plugin compatibility without testing it.

The bridge must obtain per-client decoded voice audio before the channel mix, using the supported client plugin callbacks. Send audio, source identity, connection identity, sample format and timing information to MatchFrame over a local bridge. MatchFrame must retain separate participant streams through buffering and output selection.

A single mixed desktop/NDI capture cannot provide reliable participant removal during overlapping speech. vMix Desktop Capture is therefore not required for the primary implementation.

Configure each team's server, channel, connection identity and credentials through MatchFrame or a clearly documented companion setup. Both listener connections must receive continuously with microphone transmission disabled. Do not deafen them. Keep local TeamSpeak playback out of the captured desktop audio path; verify that the chosen playback suppression does not stop the callbacks needed for capture.

Use a bounded, non-blocking handoff from TeamSpeak audio callbacks. No disk writing, network waits, UI work or expensive processing in the callback. Validate the callback's actual format and handle it explicitly. Use supported TeamSpeak recording-status signalling when recording voices.

## 4. Participant mapping and selection

For every detected participant provide:
- TeamSpeak name and connection/availability status.
- Optional mapping to an existing MatchFrame roster player, display name and avatar.
- Include in Broadcast checkbox.
- Include in Recording checkbox.
- Individual level adjustment and meter.
- Private preview/solo control.

The two inclusion checkboxes are independent. A participant can be included in the recording and excluded from broadcast, or the reverse.

Persist mappings and selections using a stable TeamSpeak unique identity, scoped appropriately to the configured team/server. Resolve temporary session client IDs afresh after reconnect. Do not identify people solely by nickname or roster position. If a person reconnects with a different identity, treat them as unapproved until mapped.

New or unrecognised arrivals start excluded from both output mixes and speaker graphics. The MatchFrame listener itself is never treated as a player source. A returning recognised identity may recover its saved selection, but must not reopen a closed public listen-in automatically.

These controls change MatchFrame's output mixes only. Do not mute, kick or otherwise change how the team's own channel participants hear one another.

## 5. Delay and timing

Implement continuously running, bounded per-participant audio buffers. Use a configurable delay with an initial engineering target of 0–300 seconds, plus fine adjustment in milliseconds. This range is a proposed implementation target to validate, not an existing capability claim.

Calibrate comms against the actual observer gameplay captured for the output. If gameplay arrives approximately 90 seconds behind the players, comms will require approximately that much additional delay, adjusted for the different transport/capture paths. Do not blindly copy a server delay setting, synchronize to the newest GSI event, or add the streaming platform's final delivery latency again.

Keep participant audio on a common production timeline. Account for callback gaps, silence, reconnects, sample-rate conversion and clock drift. Timestamp speaker activity and play it back against the same timeline as the delayed audio and captured gameplay.

Maintain buffering while public comms are off. Listen In opens an already-buffered output; it does not begin capturing or filling a fresh buffer.

Apply output-specific inclusion and mute controls after the delay buffers and before each mix. Unchecking a participant must remove their remaining buffered speech from subsequent output immediately, within the documented audio-block/fade response. Do not wait 90 seconds for a mute to propagate. This does not erase speech already broadcast or written to an earlier part of a recording.

Show buffer readiness and source health. Do not permit public playback until the configured delay is available. Delay changes or source resets must follow a defined mute/rebuffer/resync transition. Never substitute undelayed audio when a buffer is empty or a source fails.

## 6. Public listen-in controls

Provide named controls populated from the active match's teams:
- Listen In — [Team A name]
- Listen In — [Team B name]
- End Listen-In
- Mute All Comms

Use persistent team identity rather than CT/T side labels so halftime does not swap the teams' audio routing.

Starting a listen-in must select one team, close the other public comms route, open only permitted delayed voices and activate the team-only graphic. Use a short transition that avoids audible clicks and overlap between opposing teams.

Integrate optional caster ducking through the existing OBS/mixer adapter. Make the amount configurable. End Listen-In closes public comms, clears its graphic and releases ducking without overwriting unrelated operator mixer changes. Keep all actions synchronized through one output-state controller and show failures accurately.

The public audio output should be silent at application startup and after a bridge/channel reset or critical connection loss. Require an explicit new listen-in action to put comms back on air. Recording and preview actions must never implicitly open this public gate.

## 7. OBS audio routing on one PC

Expose a dedicated processed public audio route that OBS can capture as MatchFrame Comms. Reuse an appropriate virtual cable or supported plugin/output route; document any installation dependency rather than assuming the application already owns a virtual audio driver.

Only the permitted, delayed, publicly selected mix may enter this route. Its silent state must be enforced in MatchFrame, rather than relying solely on an OBS source being muted.

Configure OBS with separate sources for game audio, casters and MatchFrame Comms. Disable global Desktop Audio in the documented setup. Do not capture raw TeamSpeak audio or a broad MatchFrame process mix that also contains private preview. Send preview to a separate headphone route which OBS does not capture. Test for loopback, duplication and feedback.

Keep public audio, recording audio and private monitoring as distinct buses. An emergency public mute must not unexpectedly stop the separate recording. Provide a distinct stop-recording control.

## 8. Dedicated gameplay/comms recording

The dedicated output records a persistent gameplay scene, the normal game HUD and a recording-only speaker panel. It must remain on gameplay while the public program switches to casters, replay, a break or another scene.

Provide its own Start/Stop Recording, recording-team selector, game level, comms level, destination folder and recording status. The recording can run continuously for the match regardless of public Listen In state. Changing its selected team must also change its team graphic and speaker selection at the same timeline position.

The speaker panel shows only people permitted in the recording mix. Map their TeamSpeak identities to names/avatars and highlight voice activity from the audio actually routed to that output. Handle overlapping speakers by highlighting all included people who are active. An excluded coach must neither be audible nor appear as speaking in this recording.

Use the same delayed playout timeline for audio and speaker graphics. Network receive-time talking events must not light the graphic early. Where useful, determine activity from per-client PCM at the appropriate stage and use sensible attack/release smoothing.

Record a ready-to-watch mix of game audio plus the recording-selected comms. Separate game/comms stems are useful where the selected recorder supports them. A complete per-player stem archive is optional future scope; do not silently add excluded people to recording tracks. Stock OBS supports up to six recording audio tracks, so do not promise fourteen isolated participant tracks in one ordinary OBS recording.

### 8.1 Recording speaker strip — approved visual reference

The owner's IMG_6256.jpeg is the design reference. It shows five player portraits in one horizontal row, each inside a dark, clipped-corner hexagonal frame. The inactive players are grayscale with grey frame borders. The active speaker is shown in colour with a bright green border.

Recreate this behaviour with the current match's own roster portraits:

| State | Portrait | Frame |
|---|---|---|
| Included, silent player | Grayscale | Dark interior and a substantial charcoal/grey hexagonal border |
| Included, speaking player | Full colour | The same shape with a vivid green border, approximately #20FF00 as a configurable starting colour |
| Excluded participant | No portrait in the strip | No slot or speaking highlight |

- Keep portraits in a stable roster order. Speaking changes colour/border state only; cards must not jump, reorder or resize when someone speaks.
- Match the reference's cropped head-and-shoulders presentation, consistent card size, rounded corner joins, dark inset and even spacing. Preserve image proportions and provide an operator-adjustable crop for each portrait.
- Show five cards when five people are selected. Support one to seven selected participants without displaying excluded coaches/managers or filling empty slots. Keep the row centered within its configured bounds.
- Use portraits without name labels by default to match the reference. Optional labels are allowed on this recording-only strip. Use an operator-supplied placeholder silhouette when a selected person has no portrait.
- Keep the area outside the frames transparent so the strip can sit over gameplay. Its anchor, position, card size, spacing and active colour must be configurable. Bottom-centre is a proposed default placement.
- Base activity on the included, delayed audio actually reaching the recording mix. Highlight every included speaker during overlapping speech. Use a short configurable release so borders do not flicker between syllables.
- On silence, return the portrait to grayscale and the border to grey. On exclusion, remove that person from the strip and mix. On a team change, update portraits and activity with the recording's selected team on the same timeline.
- Implement the masks and active/inactive styling as live graphics, using the project's existing HTML/CSS/SVG rendering where appropriate. The sample faces are illustrative; do not use the screenshot as a static replacement for the actual team's player portraits.

This portrait strip belongs only to the dedicated comms recording. It must never be composited into the public broadcast or its team-only listen-in overlay. The production panel may show its own private participant activity.

## 9. A real second video path is required

Separate audio tracks alone do not create the required independent video composition. Document and implement the actual second rendering/recording path. OBS WebSocket control alone is not a second video renderer.

Depending on the repository and installed environment, use a validated OBS scene-recording integration or an appropriate MatchFrame recording component. Source Record is a possible integration to evaluate, not an automatic guarantee of correct scene/audio/encoder behaviour. Verify its installed version and chosen audio-track routing. Do not count a preview page or a second browser-source URL as a working video recording.

Reuse game capture and HUD rendering where practical. Start with a configurable 1920×1080, 60 fps target and measure encoder, GPU, CPU and disk load on the actual production PC. Report tested capacity rather than guaranteeing it for unspecified hardware. Make recording paths, errors, disk-space warnings and recoverable file/container handling visible. Keep a continuous gameplay source active when public scene transitions would otherwise suspend it.

## 10. Operator interface

Add a Team Comms page and compact controls in the existing live control room. Follow MatchFrame's current visual style.

Show both teams side by side or in clearly labelled panels. Each panel needs connection/channel status, buffer readiness, configured delay, participant list, inclusion checkboxes, levels and private preview controls. Clearly distinguish incoming activity from delayed output activity.

Display public state prominently: OFF, BUFFERING, LISTENING IN — [TEAM], or FAULT. Show recording state separately with the selected recording team, elapsed time and file/destination status. Colour must not be the only indicator.

Save team/identity mappings, selections, levels and delay presets with the event where appropriate. Do not save an active public gate as a state to restore on startup. Store credentials using the project's existing secure local settings mechanism and redact them from diagnostics.

## 11. Acceptance checks

Implement meaningful automated timing/routing tests and perform real integration checks where the environment permits. Record evidence, versions, settings and unresolved limitations.

| Check | Required result |
|---|---|
| Two channels | Both teams receive continuously; no team audio is sent into the opposing channel. |
| Seven people per team | All sources are identified independently and remain usable under overlapping speech. |
| Five selected, two excluded | Excluded voices are absent from the relevant mix, including while an included person speaks. |
| Independent selections | Broadcast and recording can include different participants without changing each other's mix. |
| Broadcast off | OBS receives silence from public comms while both buffers and the recording continue. |
| Private preview | Preview is audible in operator headphones and absent from the public and recording mixes. |
| Team switch | Public Listen In changes to the correct named team without playing both teams together. |
| Public graphic | A team-only comms banner is shown; no graphic identifies the active individual speaker. |
| Recording graphic | Only included active speakers are highlighted, including simultaneous speakers. |
| Recording visual reference | Stable hexagonal portraits match IMG_6256.jpeg: inactive grayscale/grey, speaking colour/green, excluded people absent. This strip never appears on the public output. |
| Long delay | At a tested delay such as 90 seconds, comms, gameplay and recording speaker graphics align. Log measured error and drift. |
| Immediate exclusion | Disabling a person suppresses their buffered speech at output without waiting for the configured delay. |
| Scene independence | Public replay/break/caster cuts do not replace the dedicated recording's gameplay picture. |
| Reconnection | Session IDs can change without misassigning identities; unknown arrivals remain excluded; public comms do not reopen automatically. |
| Half-time | CT/T side changes do not swap the teams' identities or comms feeds. |
| Failure | Bridge loss, empty buffer and output errors yield silence or an explicit recording fault, never raw live comms. |
| Recording file | The finished file opens, has the intended picture/mix, contains no excluded voices in its output tracks and stays aligned. |
| Single-PC load | Measure production performance with both team inputs, OBS broadcast and the separate recorder active. |

Use distinguishable fixture voices/tones and source identities to test routing deterministically. Include a longer real-input soak run to check drift, drops and resource growth. Report real test duration and results; do not replace unavailable integration tests with claims of success.

## 12. Delivery order and handover

1. Inspect the repository and prove real per-person capture from two TeamSpeak connections. Prove the chosen independent recording path separately.
2. Build the local bridge, identity mapping and timestamped per-person buffers with tests and diagnostics.
3. Deliver the public mix, named controls, team-only overlay, private preview and real OBS routing.
4. Deliver the dedicated gameplay recording, recording-specific selection and synchronized speaker panel.
5. Complete reconnect handling, failure recovery, event presets, installer/setup steps and real production validation.

Keep the application runnable through implementation. Provide source changes, companion plugin/build instructions, setup and calibration instructions, a routing diagram, the actual OBS configuration steps and an honest feature/test status table. Explain any manual companion setup or extra dependency. Do not mark the feature complete merely because the buttons and overlays render.
