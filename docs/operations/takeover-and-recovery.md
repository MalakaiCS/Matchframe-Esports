# Manual takeover and recovery

## Taking over

- Click **Take control**, use any manual POV/camera action, press a device button, or change POV directly in CS2. Any of these makes control **manual and sticky**: pending automated commands are cancelled (including queued key presses) and the ownership generation changes, so older commands can never execute.
- Exception: when the spectated player dies and the game auto-switches POV, that is not treated as a human takeover.
- **Emergency stop** (UI button, global hotkey, Companion) cancels everything, blocks automation, and must be cleared explicitly.

## Resuming

**Resume automation** (optional countdown, cancellable). Automation never resumes on its own; a timed auto-resume is not enabled by default.

## Failure handling

| Situation | What Matchframe does | What you do |
|---|---|---|
| GSI stops (stale > 3 s) | HUD clocks freeze; automated command in flight is cancelled and control goes manual; alert raised | Check the observer client / network; resume when fresh |
| Command not confirmed | Fails with `confirmation_timeout`; one bounded retry for transport errors only | Check the adapter test; operate manually |
| Wrong window focused (keyboard) | No input sent (`window_not_focused`) | Focus CS2 |
| OBS disconnect | Program → DEGRADED; reconnect with backoff; no stale cues replayed | Recover to LIVE manually after reconnect |
| Replay provider down | Clip marked failed; live operation unaffected | Use manual replay workflow |
| Engine crash (desktop) | Supervisor restarts it with backoff; it starts disarmed, data intact | Re-check status, resume automation |
| Map change / restore / seek | New epoch; pending commands from the old timeline rejected; utility cleared; round attempt recorded | None |
