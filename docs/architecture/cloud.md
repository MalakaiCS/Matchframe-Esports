# Cloud: website, accounts, billing and auto-director hours

Matchframe is two products that work together:

- **The Matchframe program for Windows** (`.exe` installer; Electron shell + local engine) runs on
  the production computer and does everything app-related: HUDs, the auto director, observer
  camera control, OBS, replays, player cameras, match administration. Its operator console exists
  only inside the program. It opens without an account (ADR-021); signing in with the website
  account's email and password under Settings → Account is needed for the Auto Director on live
  matches, and works offline for up to 7 days after each check.
- **The website** (`apps/cloud-web`, served by `services/cloud-api`) is only for **payments**
  (Stripe Checkout, invoices, hour packs), **subscription management** (plans, customer portal),
  **auto-director hours usage** (allowance, daily and per-computer usage, CSV), **account
  management** (sign-up, verification, password, name and email changes, organisations,
  linked computers, signed-in browsers, data export) and **staff management** (team members,
  invitations and roles for customers; the Matchframe staff admin with support and admin roles for
  user management — verify emails, staff roles, disable accounts — organisations, hour grants, the
  plan catalogue, the support inbox, the email log, Stripe events and the audit log). It also has
  the public pages (product, pricing, help, contact, legal). Signed-in accounts can download the
  program installer there. The website has no HUD, director, camera or match features; it keeps
  the players, teams, matches and imported HUDs the organisation's computers share (account sync,
  below) and shows only how many there are.

```
 Browser ──HTTPS (session cookie, same-origin)──▶ website + cloud API ──▶ Postgres
                                                     ▲      │  ▲
 Stripe Checkout / portal ◀── redirect ──────────────┘      │  └── Stripe webhooks (signed)
                                                            │
 Desktop engine ──HTTPS (device token, Bearer)──────────────┘
   • device-code linking   • signed licence (Ed25519)   • usage upload (idempotent)
   • account sync (shared players, teams, matches, HUDs and their files)
```

## What needs the website

| Capability | Signed in (online, or offline within 7 days of the last check) |
|---|---|
| HUDs, outputs, match admin, veto, sponsors, replays, OBS | yes |
| Manual camera work, Observer Off (shot suggestions), takeover, emergency stop | yes |
| Labelled simulation (including automatic direction) | yes, free |
| Observer and Observer & Cinematics on live telemetry | yes, while the plan has auto-director hours |
| Full Action Observer (nade cameras) on live telemetry | plans with the `fullActionObserver` feature (Studio by default), while they have hours |
| Learned-director shadow comparison | plan feature flag reported in the licence |

Release builds ask to sign in when the program opens. A program that is already open is never
locked: if it is signed out on the website (password changed or reset, account disabled, removed
from the organisation, computer unlinked) or the offline period ends, it shows a notice and keeps
running until it is closed; automatic direction then follows the usual gate (below). Development
builds open without signing in (`MATCHFRAME_SIGN_IN=off`, the default for `pnpm dev`).

## Flows

**Signup and account.** Email + password (scrypt), a verification email, and an organisation with
the signer as owner. Name changes take effect at once; an email change is confirmed from a link
sent to the new address (the old address is told) and only then becomes the sign-in address. Roles: owner (everything), admin (everything but billing), billing (billing and usage),
member (view, link computers, usage). Invitations are emailed and must be accepted by the invited
address; an organisation always keeps at least one owner.

**Billing.** Stripe Checkout for subscriptions (plans) and one-time hour packs; the Stripe customer
portal for plan changes, payment methods and cancellation; invoices listed on the website. Plan
state comes only from signed webhooks (stored once per event id) and is re-read from Stripe when a
checkout completes. `active`, `trialing` and `past_due` keep the paid plan; anything else falls back
to Free. An admin can set an organisation's status and plan by hand (`subscription_overrides`,
migration 5): the override wins over Stripe everywhere (website, licence, computer and member limits,
hours) until an admin removes it. Stripe's updates keep being stored underneath and apply again once
it is removed. An override never changes what Stripe charges.

**Signing in from the program.** Settings → Account sends the email and
password through the local engine to `/v1/device/login` on the pinned website, once; nothing but
the resulting computer credential is stored. The website checks them exactly like its own sign-in
(scrypt, the same per-address rate limit, disabled accounts refused, the email must be confirmed),
asks which organisation when the account has several, requires a role that may add computers
(owner, admin, member) and a free computer slot on the plan, and issues the computer credential.
The licence names the signed-in person; the website lists the computer with that person. Signing in
again on the same computer replaces its credential (pending usage is uploaded first). The computer
is signed out when that person's password is changed or reset, their account is disabled, staff
sign them out everywhere, or they leave the organisation. Forgot password and Create account
open the website.

**Signing in with a code** (RFC 8628 device authorization), the alternative. The desktop asks for a code
(`/v1/device/authorize`) and shows it with a link to `/link?code=…`; a signed-in member approves it
for an organisation on the website (subject to the plan's computer limit); the desktop polls
`/v1/device/token` (honouring `slow_down`) and receives a device token once. The token is stored
in the engine's encrypted secret store and sent as a Bearer token. Unlinking on either side revokes
it; re-linking the same installation replaces its old link.

**Licence.** `/v1/device/entitlement` returns `mfe1.<payload>.<signature>`: an Ed25519-signed
statement of the organisation, computer, plan, features and the auto-director allowance, valid for
24 h, then usable offline until 7 days after issue (`graceUntil`). The desktop verifies the
signature with public keys pinned into release builds (`cloud.json`; development builds learn
the keys from `/v1/keys` on first link), checks the computer id and the validity window, and keeps
working offline inside the window. It refreshes every 15 minutes while online.

**Usage.** The engine meters automatic direction once per second. A second counts only when
automation owns the camera (armed, not manually taken over, no emergency stop), the director is
in an Observer mode other than Off (all three use hours at the same rate), a real observer control adapter is connected, telemetry is live
(not simulated, a packet within 15 s) and the computer is linked. Continuous time becomes records
that close on map or session change, every five minutes, and when billing stops; a gap in ticks
(sleep) is never billed. Records are stored locally (SQLite `cloud_usage`), uploaded every two
minutes and before each licence refresh, and accepted idempotently (`(device, recordId)`). The
server rejects records that are longer than their interval, end in the future (more than 5 min
skew) or are older than 60 days.

**Allowance.** For the current period (the Stripe billing period on a paid plan, the calendar
month otherwise):
`remaining = max(0, included − used) + available credits − overage not yet covered by credits`.
Usage beyond the included hours draws on credits (hour packs and staff grants) at upload time,
earliest expiry first, under a per-organisation row lock. Overage is not sold: when hours run out,
re-arming is refused until hours are added. An admin can reset the current period's usage to zero
(`usage_resets`): the reset stores the period's used seconds and the credit seconds already spent,
and both are subtracted, so the included hours are available again while spent credits stay spent.
Usage records are never deleted.

**The gate.** The desktop consults the licence when automatic direction is *armed* (resume, or
choosing an Observer mode while armed): it needs a linked computer, a valid or in-grace
licence, the plan's `autoDirector` feature (and `fullActionObserver` for Full Action Observer), and
remaining hours (the licence's figure minus usage the website had not seen yet, including the open
segment). If not, the request fails with HTTP 402 and a plain reason, shown in the console.
**Automation already running is never cut mid-map**: when hours run out (or the licence lapses), it
continues to the end of the map and hands the camera back to the operator at the map change (audited
as `cloud.allowance_takeover`). If the plan stops including Full Action Observer, the program
switches to Observer & Cinematics at the map change (`cloud.observer_mode_reduced`).

**Account sync.** Every computer linked to an organisation sees and edits the same players,
teams, rosters, events, matches, maps, vetoes, assets and imported HUDs (contract:
`packages/cloud-contracts`, "account sync"; server: `services/cloud-api/src/routes/sync.ts`,
migration 6). Each local record is an *item* keyed by kind and id (the same id on every computer);
files it needs (HUD packages, logos, photos) are *blobs*, stored once per organisation by SHA-256
(`bytea` in Postgres). All routes use the computer's device token and only ever see its own
organisation's items and files.

- `PUT /v1/sync/blobs/<sha256>` uploads a file first: raw bytes (`application/octet-stream`) up to
  60 MB. The body is read only after the device token is checked, and never beyond 60 MB (a
  declared length over it is refused at once, 413). The SHA-256 must match the name (else 400). A
  file the organisation already has is answered 204 without reading the body. An upload that would
  take the organisation's files over its quota (2 GB, `MF_SYNC_QUOTA_BYTES`) gets 413
  `quota_exceeded`.
- `POST /v1/sync/push` sends up to 200 changes; all are handled in one transaction. Its body is
  also read only after the token is checked, up to 54,067,200 bytes (200 records of 256 KB plus
  room for the rest of each change). A change is *stale* when another computer changed the item
  after the version this one had (`baseSeq`) with a later edit time: the last edit wins, and the
  newer item comes back to apply locally. An edit time ahead of the server's clock counts as the
  server's, so a computer whose clock runs fast can't win every conflict. A change is *rejected*
  when its record is over 256 KB (`too_large <bytes>`) or names a file not uploaded yet
  (`missing_blob <sha256>`). Otherwise it is *applied* with the organisation's next `seq`. A
  deletion is kept as a tombstone (`data: null`) so the other computers delete the item too.
- `GET /v1/sync/changes?since=<seq>&limit=<n>` lists the organisation's items changed after a
  cursor, oldest first (500 by default, at most 1000; `more` when another page waits). Computers
  poll it every few seconds (index on `(org_id, seq)`) and fetch files with
  `GET /v1/sync/blobs/<sha256>`. `GET /v1/sync/status` (and, for members on the website,
  `GET /v1/orgs/<orgId>/sync`) counts live items per kind, the bytes of files and the quota; the
  organisation's dashboard shows it.

Seqs are handed out under a per-organisation lock: the organisation's `sync_counters` row, taken
with `SELECT … FOR UPDATE` at the start of every push, file upload and clean-up and held until
commit. Pushes from several computers therefore take seqs one transaction at a time and commit in
seq order. Seqs are unique (a unique index backs this) and a computer polling with its cursor
never skips a change that commits later with a lower seq. This was checked on Postgres 16 with six
computers pushing 30 batches at once while another polled. Files no live item names are deleted
once their last upload is more than an hour old, which leaves time to upload files before the push
that names them. This runs after a push, at most once a minute per organisation. Sync requests are
rate-limited per computer (600 a minute).

**Program download.** An installer placed in `MF_DOWNLOAD_DIR` (`MatchframeEsports-Setup-<version>.exe`)
is served by the website at `/downloads/…`; `/v1/downloads` reports the newest version with its
SHA-256, shown in the signed-in area. Alternatively `MF_DOWNLOAD_WINDOWS_URL` points at an external
file host. The installer is built by the **Windows program (.exe)** GitHub Actions workflow, which
also installs and smoke-tests it on Windows.

## Trust boundaries

| Boundary | Controls |
|---|---|
| Browser ↔ website | HttpOnly SameSite=Lax session cookie (Secure on https), Origin check on every cookie-authenticated mutation, rate limits on signup/login/email/linking, enumeration-safe login and reset, single-use hashed email tokens, role checks per organisation, CSP and security headers on the website. |
| Desktop ↔ API | Device token (random, stored hashed server-side, encrypted at rest on the desktop), revocable from the website; licences signed with Ed25519 and verified offline against pinned keys; usage validated and idempotent server-side; synced items and files scoped to the computer's organisation, with upload bodies read only after the token is checked and only up to their limits. |
| Stripe ↔ API | Webhook signatures verified with the endpoint secret; events stored once; billing state only changes from verified events or direct reads from Stripe; customer creation is idempotent per organisation. |
| Staff | Two staff roles. Support can view accounts and organisations, verify emails, send reset links, sign users out, clear an account's sign-in and email lockouts (the in-memory rate-limit counters for its email address, user id and the addresses its browsers signed in from), sign an organisation's computers out (one or all, to free the computer limit) and work the support inbox; admin can also give staff roles, disable accounts, edit users, grant hours, reset a period's usage, set or remove subscription overrides and edit the catalogue. The first admins come from `MF_STAFF_EMAILS` and cannot be demoted or disabled from the website; nobody can change their own role. Disabled accounts cannot sign in. Every staff action is audited. |

**What the licence does not do.** The gate runs on the customer's computer. It stops honest
mistakes and casual misuse, and pinned keys stop a build from trusting a fake server, but anyone who
modifies the desktop app can bypass a client-side check; it is a licensing control, not DRM. The
server-side usage record is the billing source of truth.

## Not verified here

Real Stripe accounts, real SMTP delivery and a public deployment were not available in the build
environment. Billing is tested with the real Stripe SDK against a local Stripe API stub with real
webhook signatures; email with the outbox table; Postgres with a real Postgres 16 server and with
PGlite; the desktop ↔ website path with both real servers in one test. The official `stripe-mock`
binary could not be used (running the downloaded binary was not permitted in this environment).

Reference: [deployment](../operations/cloud-deployment.md), [routes](cloud-api-routes.md),
[OpenAPI](cloud-openapi.json), [ADR-016](decisions.md#adr-016--hosted-website-and-cloud-api-for-accounts-billing-and-auto-director-hours).
