# Deploying the Matchframe website and cloud API

The website (payments, subscriptions, auto-director hours usage, account and team management,
staff admin, and the program download) and its API are one service: `services/cloud-api` serves the API under `/v1/*` and the built website
(`apps/cloud-web`) for every other path. It needs Postgres, and optionally Stripe and SMTP. The
desktop app keeps working without it: HUDs, manual and advisory direction, replays and the
simulation never need an account. Automatic direction on live matches needs a linked computer
with auto-director hours (see [cloud architecture](../architecture/cloud.md)).

## 1. Generate the licence signing key

```sh
pnpm cloud:keygen
```

It prints `MF_CLOUD_SIGNING_KEY` (private, goes only into the server's secret environment) and a
`config/cloud.json` snippet with the public key. Put that file, with your website address, into
the desktop release build (it is shipped with the installer and pins the key, so licences from any
other server are refused). Without a signing key the server makes an ephemeral one on every start,
which logs out every computer's licence on restart: never run production like that.

**Rotation:** generate a new key, move the old public key into `MF_CLOUD_EXTRA_PUBLIC_KEYS` (PEMs
separated by `|||`) and keep both public keys in `config/cloud.json` until every installed desktop
has updated, then remove the old one.

## 2. Run it

### Docker Compose (Postgres included)

```sh
cp config/cloud.env.example config/cloud.env     # fill in the values
docker compose -f docker-compose.cloud.yml --env-file config/cloud.env up -d --build
```

The service listens on `127.0.0.1:8080`. Put a TLS-terminating reverse proxy (Caddy, nginx, a
cloud load balancer) in front of it and set `MF_CLOUD_PUBLIC_URL` to the public `https://` address:
it is used in emails, Stripe return URLs and the desktop link page, and turns on `Secure` cookies.

### Railway

Railway builds the same Dockerfile and provides Postgres, HTTPS and the domain. Configure the
service in the dashboard: Railway has deprecated `railway.json`/`railway.toml` (Config as Code) —
new services cannot use it and existing files stop being read on 2026-12-01 — so this repository
does not ship one.

1. **New Project → Deploy from GitHub repo** → this repository and the branch to deploy. Leave the
   service's *Root Directory* empty: the Dockerfile builds from the repository root.
2. Service **Variables**: `RAILWAY_DOCKERFILE_PATH=services/cloud-api/Dockerfile`.
3. **New → Database → PostgreSQL**, then in the website service:
   `DATABASE_URL=${{Postgres.DATABASE_URL}}`.
4. Service **Settings → Networking → Generate Domain** (the server listens on the `PORT` Railway
   provides; if asked for a port, it is the value of `PORT`, 8080 by default). Add a custom domain
   there later; Railway issues the certificate.
5. Service **Settings → Deploy → Healthcheck Path**: `/v1/health` (Railway ignores the Dockerfile's
   `HEALTHCHECK`).
6. Variables: `MF_CLOUD_PUBLIC_URL` (the `https://` domain), `MF_CLOUD_SIGNING_KEY` (step 1 above),
   `MF_STAFF_EMAILS`, and later the Stripe and SMTP variables (sections 3 and 4).
7. Check `https://<domain>/v1/health`: `"database":"postgres"` and `"ephemeralSigningKey":false`.

Program download on Railway: a public GitHub release is the simplest host for the installer (see
section 5): set `MF_DOWNLOAD_WINDOWS_URL`, `MF_DOWNLOAD_WINDOWS_SHA256` and `MF_DOWNLOAD_VERSION`.
To serve it from Railway instead, attach a volume at `/downloads`, set `MF_DOWNLOAD_DIR=/downloads`
and upload the file with `railway volume files upload`.

### Image only (managed Postgres)

```sh
docker build -f services/cloud-api/Dockerfile -t matchframe-cloud .
docker run -d -p 8080:8080 --env-file config/cloud.env -e DATABASE_URL=postgres://… matchframe-cloud
```

Migrations run automatically at start (one schema version table; safe to restart). The container
runs as the unprivileged `node` user and has a health check on `/v1/health`.

### Without Docker

```sh
pnpm install
pnpm --filter @matchframe/cloud-web build
pnpm --filter @matchframe/cloud-api bundle       # services/cloud-api/dist/server.mjs
DATABASE_URL=postgres://… MF_CLOUD_WEB_DIR=apps/cloud-web/dist node services/cloud-api/dist/server.mjs
```

For a quick local trial, `pnpm cloud` runs from source with an in-process PGlite database
(`MF_CLOUD_PGLITE_DIR` to keep data) and `MF_DEV_LOG_EMAILS=1` prints emails to the console.

## 3. Stripe

1. Create products and **recurring monthly prices** for the paid plans (placeholders: Pro, Studio)
   and **one-time prices** for the hour packs (10 h, 50 h). Prices and included hours are
   placeholders in `services/cloud-api/src/domain/plans.ts`; staff can edit the catalogue later on
   the website's admin pages.
2. Put the price ids in `STRIPE_PRICE_PRO`, `STRIPE_PRICE_STUDIO`, `STRIPE_PRICE_PACK_10`,
   `STRIPE_PRICE_PACK_50`. They fill in catalogue entries that have no price yet at each start; a
   price staff set on the admin page is never overwritten.
3. Add a webhook endpoint `https://<website>/v1/stripe/webhook` with the events
   `checkout.session.completed`, `checkout.session.async_payment_succeeded`,
   `customer.subscription.created`, `customer.subscription.updated`,
   `customer.subscription.deleted` and `invoice.payment_failed`. Put its signing secret in
   `STRIPE_WEBHOOK_SECRET`. Events are verified, stored and applied once (replays are ignored);
   failures are listed on the staff **Stripe events** page.
4. Enable the **customer portal** (Settings → Billing → Customer portal) with plan changes,
   payment-method updates and cancellation; the website opens it for the organisation's billing
   managers.
5. Test mode first: `sk_test_…` keys and the Stripe CLI (`stripe listen --forward-to
   localhost:8080/v1/stripe/webhook`).

`past_due` subscriptions keep their plan during Stripe's retry period; when a subscription ends the
organisation falls back to the free plan at once. Hour packs are valid for 365 days by default and
are used after the plan's included hours, earliest expiry first.

## 4. Email

Set `SMTP_URL` (`smtps://user:password@smtp.example.com:465`) and `MF_MAIL_FROM` on a domain
with SPF/DKIM. Every email is also recorded in the `outbox_emails` table, so verification, reset and
invitation links can be recovered by staff if delivery fails.

## 5. Publishing the Windows program (.exe)

1. Build it: push a `v*` tag (the **Windows program (.exe)** workflow builds, installs and
   smoke-tests the installer on Windows and attaches it to a **draft** GitHub release), or download
   the `matchframe-windows-<commit>` artifact from any workflow run, or run `pnpm package:win`.
   Configure `CSC_LINK`/`CSC_KEY_PASSWORD` repository secrets to sign it; unsigned builds trigger
   SmartScreen warnings.
2. Release builds should include `config/cloud.json` (website address + pinned licence public key,
   see step 1) before building.
3. Put `MatchframeEsports-Setup-<version>.exe` into the directory named by `MF_DOWNLOAD_DIR` (a
   volume in Docker). The website serves the newest version at `/downloads/<file>` and shows its
   version and SHA-256 to signed-in accounts. Keep older installers there only as long as you want
   them downloadable by direct link. Alternatively set `MF_DOWNLOAD_WINDOWS_URL` (+
   `MF_DOWNLOAD_WINDOWS_SHA256`) to an external file host.

## 6. Environment reference

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `MF_CLOUD_PUBLIC_URL` | yes | `http://127.0.0.1:8080` | Public website address (emails, Stripe returns, desktop link page, Secure cookies when https) |
| `DATABASE_URL` | yes (production) | — | Postgres connection string; without it an in-process PGlite database is used |
| `MF_CLOUD_PGLITE_DIR` | no | in memory | PGlite data directory for trials |
| `MF_CLOUD_SIGNING_KEY` | yes (production) | ephemeral | Ed25519 private key (PEM, `\n` escapes allowed) that signs desktop licences |
| `MF_CLOUD_EXTRA_PUBLIC_KEYS` | no | — | Older public keys still accepted during rotation (`|||`-separated PEMs) |
| `MF_CLOUD_HOST`, `MF_CLOUD_PORT` / `PORT` | no | `127.0.0.1`, `8080` (image: host `0.0.0.0`; port from `PORT` when the platform sets it) | Listen address |
| `MF_CLOUD_WEB_DIR` | no | `apps/cloud-web/dist` (image: `/app/web`) | Built website |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | for billing | — | Without them plans are shown but not purchasable |
| `STRIPE_PRICE_PRO`, `STRIPE_PRICE_STUDIO`, `STRIPE_PRICE_PACK_10`, `STRIPE_PRICE_PACK_50` | for billing | — | Stripe price ids for the default catalogue |
| `SMTP_URL`, `MF_MAIL_FROM` | recommended | outbox only | Email delivery |
| `MF_STAFF_EMAILS` | no | — | Comma-separated accounts that become staff when they sign up or log in |
| `MF_ENTITLEMENT_TTL_HOURS` | no | `24` | Licence validity before the desktop must refresh |
| `MF_OFFLINE_GRACE_DAYS` | no | `7` | How long a computer keeps working offline after its last successful licence refresh |
| `MF_DOWNLOAD_DIR` | recommended | — | Directory with `MatchframeEsports-Setup-<version>.exe` installers served at `/downloads/` (newest shown with its SHA-256) |
| `MF_DOWNLOAD_VERSION`, `MF_DOWNLOAD_WINDOWS_URL`, `MF_DOWNLOAD_WINDOWS_SHA256`, `MF_DOWNLOAD_NOTES_URL` | no | — | External installer URL instead of `MF_DOWNLOAD_DIR`; release notes link |
| `MF_DEV_LOG_EMAILS` | no | off | `1` prints emails to the console (development only) |

Desktop side: `MATCHFRAME_CLOUD_URL` and `MATCHFRAME_CLOUD_PUBLIC_KEYS` (or the shipped
`cloud.json`) pin the website and keys; `MATCHFRAME_CLOUD_ENFORCEMENT=off` lets development builds
arm automatic direction without an account.

## 7. Operations

- **Backups:** back up Postgres (`pg_dump` or the provider's point-in-time recovery). Usage records,
  credits, Stripe event history and the audit log are all in the database; the service itself is
  stateless.
- **Scaling:** run more than one instance behind the proxy if needed. Usage ingestion takes a
  per-organisation row lock, so concurrent uploads from several computers cannot double-spend
  credits (verified on Postgres 16 with six concurrent computers). Rate limits are per instance.
- **Monitoring:** `/v1/health` reports database kind, billing and email configuration and the
  signing key id; the staff pages show organisations, usage, credits, audit and Stripe events.
- **Support credits:** staff can grant auto-director hours to an organisation (trial extensions,
  outage compensation); grants are audited.
