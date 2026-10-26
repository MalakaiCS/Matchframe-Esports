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
| Program window (console) | Operator console bundled in the program | Shown from the program's own `app://matchframe` origin (installed files, strict CSP); context isolation, sandbox, no Node integration; navigation locked to `app://matchframe`; external links open in the default browser (https only). The operator token is released over IPC only to `app://matchframe` pages. The main process forwards the console's `/api` and `/assets` requests to the engine with an allowlist of headers. The engine's HTTP address never serves the console to browsers. |
| Remote operator positions | The program on another computer in remote mode | Connects to the production computer's engine with a role token entered in Connection settings (stored encrypted with the OS credential store, never shown again); permissions are the token's role; plain HTTP on the production LAN, so treat that network as trusted or put TLS in front. |
| Engine → Matchframe website (`/v1/device/*`) | The hosted cloud API | Outbound HTTPS only (the website never connects to the engine). Device token (from the device-code link, approved on the website) kept in the encrypted secret store and sent only as a Bearer token to the configured website. Licences are Ed25519-signed and verified offline against keys pinned into release builds (`cloud.json`); a licence for another computer, an unknown key or a bad signature is refused. Changing the website address unlinks the computer and forgets learned keys. Only link details (computer name, OS platform, app version, a random installation id) and usage records (times, duration, map name, session id, active match id) leave the computer — no telemetry, player data or media. |
| Browser → website | Customers and staff | See [cloud architecture](architecture/cloud.md#trust-boundaries): scrypt passwords, HttpOnly SameSite session cookies, Origin checks on mutations, rate limits, enumeration-safe auth, hashed single-use email tokens, per-organisation roles, staff only from `MF_STAFF_EMAILS`, audited changes. |
| Stripe → website | Stripe webhooks | Signature verification with the endpoint secret, events stored once per id, plan state only from verified events or direct reads from Stripe. |

## Tokens and secrets

- `secrets.json` in the data directory (owner-only file mode): operator token, GSI token, hashed role tokens, and credentials (OBS password, bridge tokens). With the desktop shell, credentials are AES-256-GCM encrypted with a key protected by the OS credential store (Electron `safeStorage`).
- Role tokens are stored as SHA-256 hashes and shown once on creation; captain tokens are scoped to one match and team and expire (default 6 h).
- Logs pass through a redactor: keys matching token/secret/password/auth/stream key/join key/credential are replaced, and `t=`, `token=`, `key=` query values are stripped from URLs. The owner token for scripts is written to `operator-token.txt` (owner-only) instead of the console log; the program gets it over its private IPC channel.
- Cloud secrets: the website's licence signing key, Stripe keys, webhook secret, SMTP credentials and database URL live only in the server environment (`config/cloud.env` is git-ignored). Website session tokens, device tokens and email tokens are stored as SHA-256 hashes; passwords as scrypt hashes. The licence gate on the desktop is a licensing control, not DRM: the server-side usage record is authoritative.
- Event package exports never include secrets. Support bundles are sanitized (config redacted, hostname hashed, no tokens).

## Network modes

- **Default:** loopback only. Single-PC productions need nothing else.
- **LAN (multi-PC):** set `MATCHFRAME_HOST` to a LAN address deliberately; every client still needs a token; restrict the ports with a host firewall; prefer a dedicated production VLAN. TLS termination for LAN use should be added with a reverse proxy (not built in); without it, treat the production network as trusted.
- The netcon console channel is never exposed beyond loopback.

## Known limitations

- `node:sqlite` is experimental in Node; data is protected by backups before migrations.
- Windows ACLs on the data directory rely on the per-user `%APPDATA%` location.
- Release signing is configured in the release environment; development builds are unsigned and labelled as such.
