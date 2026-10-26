# Deploying the Matchframe website and cloud API

The website (signup, billing, team, computers, usage, downloads, staff admin) and its API are one
service: `services/cloud-api` serves the API under `/v1/*` and the built website
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

## 5. Environment reference

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `MF_CLOUD_PUBLIC_URL` | yes | `http://127.0.0.1:8080` | Public website address (emails, Stripe returns, desktop link page, Secure cookies when https) |
| `DATABASE_URL` | yes (production) | — | Postgres connection string; without it an in-process PGlite database is used |
| `MF_CLOUD_PGLITE_DIR` | no | in memory | PGlite data directory for trials |
| `MF_CLOUD_SIGNING_KEY` | yes (production) | ephemeral | Ed25519 private key (PEM, `\n` escapes allowed) that signs desktop licences |
| `MF_CLOUD_EXTRA_PUBLIC_KEYS` | no | — | Older public keys still accepted during rotation (`|||`-separated PEMs) |
| `MF_CLOUD_HOST`, `MF_CLOUD_PORT` (`PORT`) | no | `127.0.0.1`, `8080` (image: `0.0.0.0`) | Listen address |
| `MF_CLOUD_WEB_DIR` | no | `apps/cloud-web/dist` (image: `/app/web`) | Built website |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | for billing | — | Without them plans are shown but not purchasable |
| `STRIPE_PRICE_PRO`, `STRIPE_PRICE_STUDIO`, `STRIPE_PRICE_PACK_10`, `STRIPE_PRICE_PACK_50` | for billing | — | Stripe price ids for the default catalogue |
| `SMTP_URL`, `MF_MAIL_FROM` | recommended | outbox only | Email delivery |
| `MF_STAFF_EMAILS` | no | — | Comma-separated accounts that become staff when they sign up or log in |
| `MF_ENTITLEMENT_TTL_HOURS` | no | `24` | Licence validity before the desktop must refresh |
| `MF_OFFLINE_GRACE_DAYS` | no | `7` | How long a computer keeps working offline after its last successful licence refresh |
| `MF_DOWNLOAD_VERSION`, `MF_DOWNLOAD_WINDOWS_URL`, `MF_DOWNLOAD_WINDOWS_SHA256`, `MF_DOWNLOAD_NOTES_URL` | no | — | Download page |
| `MF_DEV_LOG_EMAILS` | no | off | `1` prints emails to the console (development only) |

Desktop side: `MATCHFRAME_CLOUD_URL` and `MATCHFRAME_CLOUD_PUBLIC_KEYS` (or the shipped
`cloud.json`) pin the website and keys; `MATCHFRAME_CLOUD_ENFORCEMENT=off` lets development builds
arm automatic direction without an account.

## 6. Operations

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
