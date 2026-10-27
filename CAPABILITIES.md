# Capabilities and limitations

What Matchframe can read, control and produce, at what evidence level, and what has actually been verified. The running engine reports the live picture at `GET /api/v1/capabilities` (per field and per grenade type, from what the feed really delivered, with the game build) and `GET /api/v1/setup/status` (control verification recorded by setup tests).

Status words: **verified** (exercised against the real system), **implemented** (code and fixture/simulation tests, real system not available), **unverified** (built against public documentation, waiting for a real test), **blocked** (needs an input that was not available), **planned**.

## 1. Data sources

| Source | What it gives | Status | Evidence / limits |
|---|---|---|---|
| CS2 Game State Integration (spectator/observer client) | map, phase, round, scores, players (position, forward, health, armor, weapons, money, match stats, flashed/smoked/burning), bomb, grenades, observed player, phase countdowns | **unverified** | Parser, normalizer, reconciliation and tracker are tested with synthetic payloads built from the public field layout (`packages/cs2-state/test`). No CS2 client was available, so no real payload has been ingested. `provider.timestamp` has 1 s resolution; GSI does **not** provide kill events, damage, headshots, assists per kill or utility impacts — the killfeed runs in degraded mode and these details are never invented (A10). |
| GSI capability sampling | per-field and per-grenade-type support from what actually arrived | implemented | `CapabilitySampler`; molotov vs incendiary reported `partial` because GSI's `firebomb` covers both. |
| Parsed CS2 demos (demoparser2 0.42.0) | ticks, events, grenades, rounds, attributions | **verified** on 5 real 2023 demos (builds 13914–14000) | Event coverage varies by demo (3 of 5 lack hurt/utility/bomb events; 4 of 5 lack player ids on events — recovered from counters). Demos are offline training data, not live input, and not observer decisions. See docs/models/phase0-demo-pipeline-report.md. |
| Authorized server events (exact kills/damage) | exact event feed | planned | Metrics such as ADR/KAST stay `unavailable` until such a source exists. |
| MatchFrame service bridge | shared assets/results | **blocked** | Documented contract and client with tests against a stub; the real service API was not available. |
| Existing replay tool | clip capture/playout | **blocked** | Documented bridge contract + stub-tested client; OBS replay buffer provider is the working fallback. |

Evidence levels attached to derived data: `measured` (directly reported), `derived` (computed deterministically from measured data, e.g. a death from health 0), `estimated` (model or heuristic, e.g. predicted grenade landing). Predictions are never promoted to confirmations.

## 2. Observer control (camera)

| Capability | Mechanism | Status |
|---|---|---|
| Read the observed player and camera mode | GSI `player` block | implemented (unverified on real CS2) |
| Select a player (POV cut) | Direct console (`-netconport`, loopback, configurable command templates) or Windows keyboard (SendInput of slot keys, only to the focused CS2 window) | **unverified** — no CS2 client; automatic cuts stay blocked until the setup test confirms a cut from observed feedback |
| Free/static camera positions (cinematics) | console `spec_goto`-style templates | **unverified / blocked** for this environment — automatic cinematics require verified static-camera control and operator-validated cameras; neither exists yet |
| Simulation adapter | moves the simulated observer | implemented, labelled SIMULATION, never counted as evidence |

Control safety (tested): single writer with ownership generations, sticky manual takeover, engine starts and restarts disarmed, transport acknowledgement ≠ confirmation, at most one automated command in flight, bounded retry, emergency stop, stale-telemetry fallback to manual, keyboard input only to the focused observer window (A11–A15, A48). No memory reading, injection or anti-cheat evasion.

## 3. Production and media

| Capability | Status | Evidence |
|---|---|---|
| OBS (obs-websocket v5): connect/auth, discovery, program/preview scenes, source visibility, audio, record/stream/replay outputs, provisioning without replacement, replay buffer save | **verified** on OBS 30.0.2 (Linux, headless) | `packages/obs-adapter/test/obs.integration.test.ts`; set operations confirmed by read-back, replay save by the `ReplayBufferSaved` event. Browser Source provisioning not verified (plugin missing in that build); Windows OBS not tested. |
| Browser-source HUD (built-in, 3 presets × 9 variants + studio standings/bracket) | implemented, rendered in Chromium | screenshots in `docs/screenshots/hud/`; public projection only, per-output tokens and delay buffers |
| Imported HUD packages (zip/folder) | implemented | path, size, script and permission checks; draft/publish/rollback (A37/A38) |
| Replay: bookmarks, approval queue, playout via OBS media source, return live | **verified** with OBS 30.0.2 | capture → approve → playback confirmed from OBS media status → return live; program angle only; extra angles need the replay tool (blocked) |
| Player cameras: identity → mixer source routing with consent, LIVE-only, delay alignment | implemented | not tested with real camera sources |
| Device control surface (Companion/Stream Deck/hotkeys) and tally | implemented | engine e2e test; not tested with hardware |
| Statistics | implemented for source-reported values | ADR, KAST, utility damage, opening duels reported unavailable on GSI |
| Learned models | implemented in shadow | real-demo training run + local inference test; never drives the camera |

## 4. The program and the website

The Matchframe program for Windows (`.exe`) contains everything app-related; its console is shown only inside the program (never served to browsers). Installer build, silent install and an installed-program smoke test pass on a Windows CI runner; extra operator positions connect to the production computer from the program.

### Accounts, billing and auto-director hours (website)

| Capability | Status | Evidence |
|---|---|---|
| Signup, email verification, login, password reset, organisations, roles, invitations | implemented; tested with fixtures | cloud API end-to-end test over HTTP (PGlite) |
| Stripe Checkout (plans, hour packs), customer portal, invoices, webhooks | implemented; tested against a local Stripe API stub | real Stripe SDK requests asserted; signed, duplicate and forged webhooks; no real Stripe account available |
| Program sign-in with the website account (email + password, or device code), required when the program opens; signed licences, offline grace, sign-out on password change/disable/leaving | implemented; tested end to end | cloud API tests; engine ↔ website test with both real servers; program smoke tests sign in through the screen against a local website (dev program and packaged program) |
| Auto-director metering and allowance (included hours, credits, quotas, no mid-map cut-off) | implemented; tested end to end | meter unit tests, engine ↔ website test, real Postgres concurrency test |
| Account management on the website (name, email change confirmed from the new address, password, organisations, team) | implemented; tested with fixtures | cloud API e2e + website component tests |
| Program download from the website | implemented; verified in a container | installer served from `MF_DOWNLOAD_DIR` with SHA-256; full download byte-identical |
| Hosting | deployable (Dockerfile, compose, bundle) | runtime image verified on Postgres; real deployment, TLS, Stripe live mode and SMTP need the owner's accounts |

The licence check runs on the customer's computer: it is a licensing control, not DRM. Server-side usage records are the billing source of truth. Release builds ask to sign in when the program opens and then work offline for up to 7 days after each check; being signed out during a session never interrupts it.

## 5. Not supported (by design or out of scope here)

- Treating GSI as a camera controller, or HUD player cards as video feeds.
- Inferring exact kills, headshots, damage or grenade impacts from GSI and presenting them as confirmed.
- Any LLM call in the live cut loop.
- Silently changing competitive server settings.
- Dependence on any third-party HUD manager account, assets, private API or licence.
