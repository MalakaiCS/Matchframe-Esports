# Security model

## Trust boundaries

| Boundary | Who is on the other side | Controls |
|---|---|---|
| GSI receiver (`:37210/gsi`) | CS2 observer client | Per-install random GSI token (constant-time compare); token stripped before parsing results are stored or broadcast; 512 KiB body limit; schema validation; real packets are ignored while the labelled simulation runs. |
| Operator API + WS (`:37211`) | Operator UI, Companion/Stream Deck, remote operators | Bearer tokens mapped to roles (owner, producer, observer, graphics, replay, analyst, viewer, captain); permission per route; foreign browser origins cannot mutate (CSRF); every mutation is audited. |
| Overlay server (`:37212`) | OBS browser sources, imported HUD packages | Read-only (GET/HEAD only); per-output token (rotatable) grants only the public HUD projection; strict CSP (`default-src 'self'`, no remote scripts/connections); the only inbound WS message accepted is a sponsor display acknowledgement. |
| Observer control channel | CS2 console (`-netconport`) or the focused observer window | Loopback-only console host; command templates fill only validated values (no `;`/newline injection); keyboard input only when the configured observer window has focus. |
| Python workers | Local subprocesses | Run with explicit arguments; never delete raw demos (retention is enforced by the engine with path-containment checks). |
| Imported HUD packages | Third-party HTML/JS | Static assets only, extension allowlist, size limits, traversal/absolute-path/symlink rejection, checksums, no install scripts executed, served on the overlay origin under CSP with no access to operator data or Node. |
| Desktop renderer | Operator UI | Context isolation, sandbox, no Node integration, navigation locked to the loopback engine origin, token released only to that origin. |

## Tokens and secrets

- `secrets.json` in the data directory (owner-only file mode): operator token, GSI token, hashed role tokens, and credentials (OBS password, bridge tokens). With the desktop shell, credentials are AES-256-GCM encrypted with a key protected by the OS credential store (Electron `safeStorage`).
- Role tokens are stored as SHA-256 hashes and shown once on creation; captain tokens are scoped to one match and team and expire (default 6 h).
- Logs pass through a redactor: keys matching token/secret/password/auth/stream key/join key/credential are replaced, and `t=`, `token=`, `key=` query values are stripped from URLs. The operator URL is written to `operator-url.txt` (owner-only) instead of the console log.
- Event package exports never include secrets. Support bundles are sanitized (config redacted, hostname hashed, no tokens).

## Network modes

- **Default:** loopback only. Single-PC productions need nothing else.
- **LAN (multi-PC):** set `MATCHFRAME_HOST` to a LAN address deliberately; every client still needs a token; restrict the ports with a host firewall; prefer a dedicated production VLAN. TLS termination for LAN use should be added with a reverse proxy (not built in); without it, treat the production network as trusted.
- The netcon console channel is never exposed beyond loopback.

## Known limitations

- `node:sqlite` is experimental in Node; data is protected by backups before migrations.
- Windows ACLs on the data directory rely on the per-user `%APPDATA%` location.
- Release signing is configured in the release environment; development builds are unsigned and labelled as such.
