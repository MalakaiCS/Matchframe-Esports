# Deploying the Matchframe website and cloud API

The website (payments, subscriptions, auto-director hours usage, account and team management,
staff admin, and the program download) and its API are one service: `services/cloud-api` serves the API under `/v1/*` and the built website
(`apps/cloud-web`) for every other path. It needs Postgres, and optionally Stripe and SMTP. The
program signs in to it with the same accounts (email and password, or a code approved on the
website) and then works offline for up to 7 days after each check. Automatic direction on live
matches uses the organisation's auto-director hours (see [cloud architecture](../architecture/cloud.md)).

## 1. The licence signing key

The website signs desktop licences with an Ed25519 key. **By default it creates the key on first
start and stores it in the database** (table `signing_keys`), so nothing needs to be generated and
it stays the same across restarts and redeploys. Back up the database: losing it (or the key)
means every computer has to link again.

To keep the private key outside the database instead (stronger separation if database backups
leak), run `pnpm cloud:keygen` and set the private key it prints as `MF_CLOUD_SIGNING_KEY` (it then
takes precedence).

**Pinning the key in desktop releases.** `config/cloud.json` (`{ "url": …, "publicKeys": { kid: PEM } }`)
is shipped with the installer and makes the program refuse licences from any other server. Get the
public key from the running website: `https://<website>/v1/keys` returns `{"keys": {kid: PEM}, …}`;
copy `keys` into `publicKeys` together with the website address (or use the snippet printed by
`pnpm cloud:keygen` when you set the key yourself). Commit the file, then publish a release.

**Rotation:** with `MF_CLOUD_SIGNING_KEY`, generate a new key, move the old public key into
`MF_CLOUD_EXTRA_PUBLIC_KEYS` (PEMs separated by `|||`) and keep both public keys in
`config/cloud.json` until every installed program has updated. With a database key, set
`retired_at` on the old row after inserting or configuring the new one; unretired keys stay
published.

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
   service's *Root Directory* empty. Railway uses the `Dockerfile` at the repository root
   automatically; if the build log shows "Railpack", the service is not building that file
   (check the branch, and remove any `RAILWAY_DOCKERFILE_PATH` variable pointing elsewhere).
2. **New → Database → PostgreSQL**, then in the website service:
   `DATABASE_URL=${{Postgres.DATABASE_URL}}`.
3. Set `MF_CLOUD_PUBLIC_URL` (the `https://` domain from step 4). In production the server refuses
   to start without `DATABASE_URL` and `MF_CLOUD_PUBLIC_URL` and says which is missing in the
   deploy log, rather than running with an in-memory database. The licence signing key is created
   and stored in the database automatically (section 1).
4. Service **Settings → Networking → Generate Domain** (the server listens on the `PORT` Railway
   provides; if asked for a port, it is the value of `PORT`, 8080 by default). Add a custom domain
   there later; Railway issues the certificate.
5. Service **Settings → Deploy → Healthcheck Path**: `/v1/health` (Railway ignores the Dockerfile's
   `HEALTHCHECK`).
6. Variables: `MF_STAFF_EMAILS`, and later the Stripe and SMTP variables (sections 3 and 4). After
   generating the domain, make sure `MF_CLOUD_PUBLIC_URL` is that `https://` address.
7. Check `https://<domain>/v1/health`: `"database":"postgres"`, `"signingKeySource":"database"`
   (or `"environment"`) and `"ephemeralSigningKey":false`.

Program download on Railway: a public GitHub release is the simplest host for the installer (see
section 5): set `MF_DOWNLOAD_WINDOWS_URL`, `MF_DOWNLOAD_WINDOWS_SHA256` and `MF_DOWNLOAD_VERSION`.
To serve it from Railway instead, attach a volume at `/downloads`, set `MF_DOWNLOAD_DIR=/downloads`
and upload the file with `railway volume files upload`.

### Image only (managed Postgres)

```sh
docker build -t matchframe-cloud .
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

1. Build it: on GitHub, **Releases → Draft a new release**, create the tag (e.g. `v0.1.0`) and
   **Publish**. The **Windows program (.exe)** workflow then builds that tag on Windows, installs
   and smoke-tests it, and attaches `MatchframeEsports-Setup-<version>.exe`, the portable zip and
   `SHA256SUMS.txt` to the release (a few minutes after publishing). Alternatively run the workflow manually (Actions → Windows program (.exe) → Run workflow) on
   `main` with a new tag such as `v0.1.3`: it builds `main`'s latest commit and creates the tag
   and the published release on it (notes from `docs/release-notes/<version>-dev.md`), then
   attaches the files. For a tag or release that already exists it builds that tag and only
   attaches the files. A pushed tag alone does not attach anything. You can also download the
   `matchframe-windows-<commit>` artifact from any workflow run, or run `pnpm package:win`.
   Configure `CSC_LINK`/`CSC_KEY_PASSWORD` repository secrets to sign it; unsigned builds trigger
   SmartScreen warnings.
2. The workflow pins the build to the website: it reads the address and licence public keys from
   the live website (`scripts/write-cloud-config.mjs`, written to `config/cloud.json`, which is not
   committed) and refuses a website whose key is temporary. The default is the Railway address;
   set the repository variable `MATCHFRAME_WEBSITE_URL` (Settings → Secrets and variables →
   Actions → Variables) when the website moves, e.g. to a custom domain, then build a new release.
   Builds pinned to an old address keep using it.
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
| `MF_CLOUD_SIGNING_KEY` | no | created once and stored in the database | Ed25519 private key (PEM, `\n` escapes allowed) that signs desktop licences; overrides the database key |
| `MF_CLOUD_EXTRA_PUBLIC_KEYS` | no | — | Older public keys still accepted during rotation (`|||`-separated PEMs) |
| `MF_CLOUD_HOST`, `MF_CLOUD_PORT` / `PORT` | no | `127.0.0.1`, `8080` (image: host `0.0.0.0`; port from `PORT` when the platform sets it) | Listen address |
| `MF_CLOUD_WEB_DIR` | no | `apps/cloud-web/dist` (image: `/app/web`) | Built website |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | for billing | — | Without them plans are shown but not purchasable |
| `STRIPE_PRICE_PRO`, `STRIPE_PRICE_STUDIO`, `STRIPE_PRICE_PACK_10`, `STRIPE_PRICE_PACK_50` | for billing | — | Stripe price ids for the default catalogue |
| `SMTP_URL`, `MF_MAIL_FROM` | recommended | outbox only | Email delivery |
| `MF_STAFF_EMAILS` | no | — | Comma-separated bootstrap admins: these accounts get the admin staff role when they sign up or log in and cannot be demoted, disabled or have their email changed from the website (section 8) |
| `MF_COMPANY_NAME`, `MF_WEBSITE_NAME` | no | `Matchframe Esports`, `Matchframe` | Business and site name used on the legal, about and contact pages |
| `MF_SUPPORT_EMAIL` | recommended | — | Support address shown on the website; contact form messages are also emailed there |
| `MF_COMPANY_ADDRESS` | no | — | Postal address shown in the legal pages and on the contact page |
| `MF_LEGAL_JURISDICTION` | no | generic wording | Governing law named in the terms (e.g. `England and Wales`) |
| `MF_LEGAL_EFFECTIVE_DATE` | no | `2026-10-27` | "Last updated" date of the terms and policies (`YYYY-MM-DD`) |
| `MF_ENTITLEMENT_TTL_HOURS` | no | `24` | Licence validity before the desktop must refresh |
| `MF_OFFLINE_GRACE_DAYS` | no | `7` | How long a computer keeps working offline after its last successful licence refresh |
| `MF_DOWNLOAD_DIR` | recommended | — | Directory with `MatchframeEsports-Setup-<version>.exe` installers served at `/downloads/` (newest shown with its SHA-256) |
| `MF_DOWNLOAD_VERSION`, `MF_DOWNLOAD_WINDOWS_URL`, `MF_DOWNLOAD_WINDOWS_SHA256`, `MF_DOWNLOAD_NOTES_URL` | no | — | External installer URL instead of `MF_DOWNLOAD_DIR`; release notes link |
| `MF_DEV_LOG_EMAILS` | no | off | `1` prints emails to the console (development only) |

Desktop side: `MATCHFRAME_CLOUD_URL` and `MATCHFRAME_CLOUD_PUBLIC_KEYS` (or the shipped
`cloud.json`) pin the website and keys; `MATCHFRAME_SIGN_IN=off` opens development builds without
the sign-in screen; `MATCHFRAME_CLOUD_ENFORCEMENT=off` lets development builds arm automatic
direction without an account.

## 7. Operations

- **Backups:** back up Postgres (`pg_dump` or the provider's point-in-time recovery). Usage records,
  credits, Stripe event history and the audit log are all in the database; the service itself is
  stateless.
- **Scaling:** run more than one instance behind the proxy if needed. Usage ingestion takes a
  per-organisation row lock, so concurrent uploads from several computers cannot double-spend
  credits (verified on Postgres 16 with six concurrent computers). Rate limits are per instance.
- **Monitoring:** `/v1/health` reports database kind, billing and email configuration and the
  signing key id; the staff pages show organisations, usage, credits, audit and Stripe events.
- **Support credits:** admins can grant auto-director hours to an organisation (trial extensions,
  outage compensation); grants are audited.

## 8. Staff and user management

Open **Admin** on the website (shown to staff only). Staff roles:

| | Support | Admin |
|---|---|---|
| Overview, users, organisations (read), audit log, plan catalogue (read) | yes | yes |
| Verify a user's email, resend verification, send a password reset link, sign a user out everywhere | yes | yes |
| Support inbox (contact form messages: mark handled / reopen) and email log | yes | yes |
| Give or remove staff roles, disable and enable accounts, edit a user's name or email | no | yes |
| Grant hours, edit plans and hour packs, Stripe events, resend emails | no | yes |

- The first admin comes from `MF_STAFF_EMAILS` (sign up or log in with that address). Bootstrap
  admins cannot be demoted, disabled or have their email changed from the website; remove the
  address from `MF_STAFF_EMAILS` and redeploy first. Nobody can change their own staff role or
  disable themselves.
- **Disabling** an account signs it out everywhere and refuses sign-in ("this account has been
  disabled") until an admin enables it again; organisations, computers and subscriptions are
  untouched. The reason is shown to staff only.
- **Changing a user's email** makes the new address unverified, sends it a verification link and
  tells the old address.
- Every staff action is recorded in the audit log and shown on the user's page.
- Legal pages (terms, privacy, cookies, refunds, acceptable use, program EULA) are generic
  templates filled with the `MF_COMPANY_*`, `MF_SUPPORT_EMAIL` and `MF_LEGAL_*` values. Have them
  reviewed for your business and jurisdiction before taking payments.
