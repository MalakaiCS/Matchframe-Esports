# Multi-PC setup

Typical split: **Observer PC** (CS2 observer client), **Production PC** (OBS + Matchframe), optional **Replay PC**.

- Matchframe runs on the production PC. Set `MATCHFRAME_HOST` to the production PC's LAN address only if other machines must reach it, firewall ports 37210–37212 to the production subnet, and give each remote client its own role-scoped token.
- GSI: on the observer PC, write the GSI config with the receiver URI pointing at the production PC (`POST /api/v1/setup/write-gsi-config` with `host` set to the production PC's LAN IP, then copy the file to the observer PC's `game/csgo/cfg` if Matchframe cannot reach that disk).
- Observer control across machines: the console channel is loopback-only by design and keyboard input must happen on the observer PC itself. Run a second Matchframe engine on the observer PC as the control agent, or operate POVs manually on that machine. A dedicated remote observer agent with authenticated transport is planned (FEATURE_COVERAGE F02/F12).
- Video: capture the observer PC through a capture card or another tested transport. NDI is optional and not required for local Game Capture; untested transports are labelled as such.
- Clock sync between PCs helps but does not prove that two clients show the same game instant; delayed outputs must be aligned by measurement.
