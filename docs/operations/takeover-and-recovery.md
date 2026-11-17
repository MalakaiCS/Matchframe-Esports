# Manual takeover and recovery

## Taking over

- Click **Take control**, use any manual POV/camera action, press a device button, or change POV directly in CS2. Any of these makes control **manual and sticky**: pending automated commands are cancelled (including queued key presses) and the ownership generation changes, so older commands can never execute.
- Exception: when the spectated player dies and the game auto-switches POV, that is not treated as a human takeover.
- **Emergency stop** (UI button, global hotkey, Companion) cancels everything, blocks automation, and must be cleared explicitly.

## Resuming

**Resume automation** (optional countdown, cancellable). Automation never resumes on its own; a timed auto-resume is not enabled by default.

## Failure handling

| Situation | What MatchFrame does | What you do |
|---|---|---|
| GSI stops (stale > 3 s) | HUD clocks freeze; automated command in flight is cancelled and control goes manual; alert raised | Check the observer client / network; resume when fresh |
| Command not confirmed | Fails with `confirmation_timeout`; one bounded retry for transport errors only | Check the adapter test; operate manually |
| Wrong window focused (keyboard) | No input sent (`window_not_focused`) | Focus CS2 |
| OBS disconnect | Program → DEGRADED; reconnect with backoff; no stale cues replayed | Recover to LIVE manually after reconnect |
| Replay provider down | Clip marked failed; live operation unaffected | Use manual replay workflow |
| Engine crash (desktop) | Supervisor restarts it with backoff; it starts disarmed, data intact; a crash report is kept (below) | Re-check status, resume automation |
| Map change / restore / seek | New epoch; pending commands from the old timeline rejected; utility cleared; round attempt recorded | None |

## Crash reports

Off unless you turn on **Settings → General → Program → Send crash reports** (ADR-077).

- **What counts as a crash:** an error nothing handled in the program's main process (the program keeps running and shows the error), the manager window or a desktop HUD or HUD preview window's page stopping (crashed, out of memory, killed), the engine stopping when nobody asked it to (a restart, switching to remote mode, Network access, quitting and Windows logging off or shutting down don't count), and native crashes, which Electron's crash reporter writes as minidumps in `<data folder>\program\Crashpad` (never uploaded by Electron itself).
- **While it's off:** the crash is kept on this computer. At the next start MatchFrame asks once, *"MatchFrame closed unexpectedly. Send a crash report?"*: **Send**, **Don't send** (deletes them), or **Always send** (turns the setting on). One question covers every crash since the last start; it never asks again about them.
- **What is sent:** the support file (the same as Settings → Diagnostics → Download support bundle: settings without passwords, tokens or keys, health, recent decisions and logs, with your user folder shown as `~`), the program version, Windows version, which part crashed, the error and stack, how long it had run, the engine's last output lines for an engine crash, and a minidump when it is at most 2 MB (with the program's tokens overwritten). At most 10 MB. In remote mode no support file is sent (it would be the production computer's).
- **Offline:** reports wait in `<data folder>\program\crash-reports` and are sent when the website can be reached (tried again after 1 min, 5 min, 15 min, 1 h, then every 6 h). At most 20 reports and 50 MB wait; the same crash again within 30 minutes is counted on the report already there; a report not sent within 30 days is dropped.
- **Sent:** the console says **Crash report sent (ID CR-XXXX-XXXX)** (a Windows notification when the window isn't on screen). Quote that ID to support; the last ones are listed under Settings → General → Program.
- **Signed in or not:** a signed-in program sends with its computer's credential, so support sees the organisation and computer; otherwise the report goes without an account, under stricter limits (it is kept and sent later when the website refuses it for now).
- **Program log lines** start with `[crash]` (recorded, sent with its ID, waiting, dropped and why).
