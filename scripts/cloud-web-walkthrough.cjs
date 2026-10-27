// Walks the Matchframe website (apps/cloud-web) against a running cloud API and saves screenshots.
//
//   pnpm --filter @matchframe/cloud-web build
//   MF_CLOUD_PORT=8080 MF_CLOUD_PUBLIC_URL=http://127.0.0.1:8080 MF_CLOUD_WEB_DIR=apps/cloud-web/dist \
//     MF_DEV_LOG_EMAILS=1 MF_STAFF_EMAILS=admin@example.com MF_SUPPORT_EMAIL=help@example.com pnpm cloud > cloud.log 2>&1 &
//   MF_CLOUD_LOG=cloud.log node scripts/cloud-web-walkthrough.cjs [--stripe-enabled]
//
// Needs a fresh (in-memory) API: it signs up owner@, producer@, admin@ and spam@example.com, sends a
// contact-form message, promotes producer@ to support staff and checks the support view. Set
// MF_DOWNLOAD_WINDOWS_URL / MF_DOWNLOAD_WINDOWS_SHA256 on the API to capture the published download. Emailed links
// are read from the API's console output (MF_DEV_LOG_EMAILS=1). Device linking is driven through
// the desktop endpoints (/v1/device/*) with fetch, as the desktop app would. Every page is checked
// for console errors, failed requests, unexpected HTTP errors and horizontal scrolling at 390 px.
// --stripe-enabled only captures the purchasable state (run the API with fake STRIPE_* values).
const { chromium } = require("playwright");
const { randomUUID } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const BASE = process.env.MF_BASE ?? "http://127.0.0.1:8080";
const LOG = process.env.MF_CLOUD_LOG;
const OUT = path.resolve(process.env.MF_SHOTS ?? path.join(__dirname, "..", "docs", "screenshots", "cloud"));
const STRIPE_MODE = process.argv.includes("--stripe-enabled");
const PASSWORD = "correct horse battery";
const DESKTOP = { width: 1440, height: 900 };
const MOBILE = { width: 390, height: 844 };

/** Public pages captured signed out (desktop), and the subset also captured at 390 px. */
const PUBLIC_PAGES = [
  ["/", "home"],
  ["/features", "features"],
  ["/features/huds", "feature-huds", { full: false }],
  ["/features/auto-director", "feature-auto-director"],
  ["/features/cameras", "feature-cameras", { full: false }],
  ["/features/utility-tracking", "feature-utility-tracking", { full: false }],
  ["/features/obs-replays", "feature-obs-replays", { full: false }],
  ["/features/match-admin", "feature-match-admin", { full: false }],
  ["/features/multi-pc", "feature-multi-pc", { full: false }],
  ["/how-it-works", "how-it-works"],
  ["/requirements", "requirements"],
  ["/use-cases", "use-cases"],
  ["/pricing", "pricing"],
  ["/faq", "faq"],
  ["/help", "help"],
  ["/help/installing-the-program", "help-article"],
  ["/contact", "contact"],
  ["/about", "about"],
  ["/security", "security"],
  ["/status", "status"],
  ["/changelog", "changelog"],
  ["/legal", "legal"],
  ["/legal/terms", "legal-terms"],
  ["/legal/privacy", "legal-privacy", { full: false }],
];
const PUBLIC_MOBILE = ["/", "/features", "/features/auto-director", "/how-it-works", "/requirements", "/use-cases", "/pricing", "/faq", "/help", "/contact", "/status", "/legal/terms"];

const problems = [];
const visited = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function log(...a) {
  console.log("•", ...a);
}

/** Latest emailed link of a kind (verify-email | reset-password | invite) for an address, from the API log. */
async function emailLink(to, kind, notBefore = 0) {
  for (let i = 0; i < 40; i++) {
    const text = fs.readFileSync(LOG, "utf8");
    const blocks = text.split("[cloud-api] email (outbox only) to ").slice(1);
    const matches = [];
    for (const b of blocks) {
      if (!b.startsWith(`${to}:`)) continue;
      const m = new RegExp(`https?://[^\\s]+/${kind}\\?token=[A-Za-z0-9_-]+`).exec(b);
      if (m) matches.push(m[0]);
    }
    if (matches.length > notBefore) return matches[matches.length - 1].replace(/^https?:\/\/[^/]+/, "");
    await sleep(250);
  }
  throw new Error(`no ${kind} email for ${to}`);
}

const emailCount = (to, kind) => {
  const text = fs.readFileSync(LOG, "utf8");
  return text.split("[cloud-api] email (outbox only) to ").slice(1).filter((b) => b.startsWith(`${to}:`) && b.includes(`/${kind}?token=`)).length;
};

async function api(method, p, body, headers = {}) {
  const res = await fetch(BASE + p, { method, headers: { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let data = text;
  try {
    data = JSON.parse(text);
  } catch {
    // not JSON
  }
  return { status: res.status, data };
}

/** Desktop side of linking: start, returning the user code and device code. */
async function deviceAuthorize(deviceName) {
  const r = await api("POST", "/v1/device/authorize", { deviceName, platform: "win32", appVersion: "0.1.0", installId: randomUUID().replace(/-/g, "") });
  if (r.status !== 200) throw new Error(`authorize failed ${r.status} ${JSON.stringify(r.data)}`);
  return r.data;
}

async function devicePoll(deviceCode) {
  for (let i = 0; i < 6; i++) {
    const r = await api("POST", "/v1/device/token", { deviceCode });
    if (r.status === 200) return r.data;
    if (r.data.error !== "authorization_pending" && r.data.error !== "slow_down") throw new Error(`token: ${JSON.stringify(r.data)}`);
    await sleep(5200);
  }
  throw new Error("device was never approved");
}

/** Uploads auto-director records (minutes each, spread over past days in the current month). */
async function uploadUsage(deviceToken, sessions) {
  const now = Date.now();
  const records = sessions.map(([daysAgo, minutes, map]) => {
    const start = new Date(now - daysAgo * 86_400_000 - minutes * 60_000 - 3_600_000);
    return { recordId: randomUUID(), kind: "auto_director", startedAt: start.toISOString(), endedAt: new Date(start.getTime() + minutes * 60_000).toISOString(), seconds: minutes * 60, sessionId: `s-${daysAgo}`, matchRef: map ? `Northside Cup — ${map}` : null, mapName: map ?? null, appVersion: "0.1.0" };
  });
  const r = await api("POST", "/v1/device/usage", { records }, { authorization: `Bearer ${deviceToken}` });
  if (r.status !== 200 || r.data.accepted.length !== records.length) throw new Error(`usage upload: ${JSON.stringify(r.data)}`);
  await api("POST", "/v1/device/entitlement", undefined, { authorization: `Bearer ${deviceToken}`, "x-matchframe-version": "0.1.0" });
}

/** expected: "METHOD /path STATUS" entries for responses a step provokes on purpose (e.g. a 409 device_limit). */
function isExpected(expected, method, url, status) {
  const p = new URL(url).pathname;
  return expected.some((e) => {
    const [m, ep, st] = e.split(" ");
    return (method === "*" || m === "*" || m === method) && p.startsWith(ep) && String(status) === st;
  });
}

function watch(page, label, expected) {
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    const text = m.text();
    const url = m.location()?.url ?? "";
    // Chrome logs every 4xx fetch as "Failed to load resource"; accept the ones the step expects.
    const st = /status of (\d+)/.exec(text)?.[1];
    if (st && url && isExpected(expected, "*", url, st)) return;
    problems.push(`[${label}] console error: ${text} ${url}`);
  });
  page.on("pageerror", (e) => problems.push(`[${label}] page error: ${e.message}`));
  page.on("requestfailed", (r) => {
    // Navigating away (e.g. a download link) aborts in-flight requests; those aren't failures.
    if (r.failure()?.errorText.includes("ERR_ABORTED")) return;
    problems.push(`[${label}] request failed: ${r.method()} ${r.url()} ${r.failure()?.errorText}`);
  });
  page.on("response", (r) => {
    if (r.status() < 400) return;
    if (isExpected(expected, r.request().method(), r.url(), r.status())) return;
    problems.push(`[${label}] HTTP ${r.request().method()} ${new URL(r.url()).pathname} ${r.status()}`);
  });
}

async function shot(page, name, opts = {}) {
  await page.waitForLoadState("networkidle").catch(() => undefined);
  if (opts.full ?? true) {
    // Scroll through the page once so lazily loaded screenshots are in the capture.
    await page.evaluate(async () => {
      for (let y = 0; y < document.documentElement.scrollHeight; y += 700) {
        window.scrollTo(0, y);
        await new Promise((r) => setTimeout(r, 40));
      }
      window.scrollTo(0, 0);
    });
    await page.waitForLoadState("networkidle").catch(() => undefined);
  }
  await sleep(150);
  const vw = page.viewportSize();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  // Full-page captures draw sticky elements where they are, so start from the top.
  if (opts.full ?? true) await page.evaluate(() => window.scrollTo(0, 0));
  if (overflow > 1) problems.push(`[${name}] horizontal overflow of ${overflow}px at ${vw.width}px`);
  const file = path.join(OUT, `${name}.jpg`);
  const full = opts.full ?? true;
  const height = await page.evaluate(() => document.documentElement.scrollHeight);
  const maxH = vw.width < 600 ? 3000 : 2300;
  // Full page, cut at maxH so very long pages stay readable and small.
  await page.screenshot({ path: file, type: "jpeg", quality: opts.quality ?? 55, fullPage: full, clip: full && height > maxH ? { x: 0, y: 0, width: vw.width, height: maxH } : undefined });
  const kb = Math.round(fs.statSync(file).size / 1024);
  visited.push(`${name}.jpg (${vw.width}×${vw.height}, ${kb} KB)`);
  if (kb > 400) problems.push(`[${name}] screenshot is ${kb} KB`);
  log(`screenshot ${name}.jpg ${kb} KB`);
}

async function go(page, p) {
  await page.goto(BASE + p, { waitUntil: "networkidle" });
}

async function signUp(page, { name, email, org }, query = "") {
  await go(page, `/signup${query}`);
  await page.getByLabel("Your name").fill(name);
  if (email) await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(PASSWORD);
  await page.getByLabel("Team or organisation name").fill(org);
  await page.getByRole("button", { name: "Create account" }).click();
  await page.waitForURL(/\/(orgs|invite)/);
  await page.waitForLoadState("networkidle");
}

async function verify(page, email) {
  await go(page, await emailLink(email, "verify-email"));
  await page.getByText("Email address confirmed").waitFor();
}

async function newPage(browser, label, viewport, expected = [], colorScheme = "light") {
  const ctx = await browser.newContext({ viewport, colorScheme, locale: "en-US", timezoneId: "Europe/London" });
  const page = await ctx.newPage();
  watch(page, label, expected);
  return { ctx, page };
}

async function stripeEnabled(browser) {
  // Requires the API to run with STRIPE_SECRET_KEY=sk_test_x STRIPE_WEBHOOK_SECRET=whsec_x STRIPE_PRICE_PRO=price_x.
  const { page } = await newPage(browser, "stripe", DESKTOP);
  await go(page, "/pricing");
  await shot(page, "pricing-stripe-enabled");
  await signUp(page, { name: "Riley", email: "billing-demo@example.com", org: "Northside Broadcast" });
  await verify(page, "billing-demo@example.com");
  await page.goto(`${BASE}/orgs`, { waitUntil: "networkidle" });
  await page.getByRole("link", { name: "Billing & Subscription" }).first().click();
  await page.getByRole("heading", { name: "Choose a plan" }).waitFor();
  await shot(page, "billing-stripe-enabled");
}

async function main() {
  if (!LOG) throw new Error("set MF_CLOUD_LOG to the API's console log file");
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch();
  if (STRIPE_MODE) {
    await stripeEnabled(browser);
    await browser.close();
    return report();
  }

  // ------------------------------------------------------------ public pages, signed out
  const pub = await newPage(browser, "public", DESKTOP);
  for (const [p, n, opts] of PUBLIC_PAGES) {
    await go(pub.page, p);
    await pub.page.locator("h1").first().waitFor();
    await shot(pub.page, n, opts);
  }
  await go(pub.page, "/");
  await pub.page.getByRole("button", { name: "Product" }).click();
  await shot(pub.page, "nav-product-menu", { full: false });
  await go(pub.page, "/faq");
  await pub.page.getByRole("searchbox", { name: "Filter questions" }).fill("SmartScreen");
  await pub.page.getByText(/questions match/).waitFor();
  await shot(pub.page, "faq-filtered", { full: false });
  // Contact form (signed out): lands in the staff support inbox.
  await go(pub.page, "/contact?topic=sales");
  await pub.page.getByLabel("Your name", { exact: true }).fill("Jo Rivera");
  await pub.page.getByLabel("Email", { exact: true }).fill("jo@league.example");
  await pub.page.getByLabel("Message", { exact: true }).fill("We run a 16-team league with two broadcasts each week. Which plan fits, and can we add hours for playoff weeks?");
  await pub.page.getByRole("button", { name: "Send message" }).click();
  await pub.page.getByText("Thanks, we've received your message").waitFor();
  await shot(pub.page, "contact-sent", { full: false });
  await go(pub.page, "/no-such-page");
  await shot(pub.page, "not-found", { full: false });
  const pubDark = await newPage(browser, "public-dark", DESKTOP, [], "dark");
  for (const [p, n] of [
    ["/", "home-dark"],
    ["/features", "features-dark"],
    ["/pricing", "pricing-dark"],
  ]) {
    await go(pubDark.page, p);
    await shot(pubDark.page, n, { full: false });
  }

  // ------------------------------------------------------------ owner signs up
  const owner = await newPage(browser, "owner", DESKTOP, ["POST /v1/device-link/approve 409", "GET /v1/device-link/BBBB-BBBB 404", "POST /v1/auth/login 401"]);
  const op = owner.page;
  await go(op, "/signup");
  await op.getByRole("button", { name: "Create account" }).click();
  await op.getByText("Please fix the highlighted fields.").waitFor();
  await shot(op, "signup-validation");
  await signUp(op, { name: "Riley Park", email: "owner@example.com", org: "Northside Broadcast" });
  await op.getByText("Verify your email address").first().waitFor();
  await shot(op, "dashboard-unverified");

  // Linking needs a verified email: show the disabled state first.
  const d0 = await deviceAuthorize("OBSERVER-01");
  await go(op, `/link?code=${d0.userCode}`);
  await op.getByText("A computer wants to link to your account").waitFor();
  await shot(op, "link-unverified");

  await verify(op, "owner@example.com");
  await shot(op, "verify-email");

  // ------------------------------------------------------------ device linking end to end
  await go(op, `/link?code=${d0.userCode}`);
  await op.getByRole("button", { name: "Approve and link" }).waitFor();
  await shot(op, "link-pending");
  await op.getByRole("button", { name: "Approve and link" }).click();
  await op.getByText("OBSERVER-01 is approved").waitFor();
  await shot(op, "link-approved");
  const tok = await devicePoll(d0.deviceCode);
  log(`device linked: ${tok.deviceId} → ${tok.orgName}`);
  await uploadUsage(tok.deviceToken, [
    [9, 14, "de_mirage"],
    [8, 10, "de_inferno"],
    [6, 8, "de_nuke"],
    [5, 16, "de_ancient"],
    [3, 11, "de_anubis"],
    [1, 13, "de_mirage"],
  ]);

  // Free plan: one computer. A second install is refused with device_limit.
  const d1 = await deviceAuthorize("REPLAY-PC");
  await go(op, `/link?code=${d1.userCode.replace("-", "").toLowerCase()}`);
  await op.getByRole("button", { name: "Approve and link" }).click();
  await op.getByText("This organisation has no free computer slot").waitFor();
  await shot(op, "link-device-limit");

  await go(op, "/link?code=BBBB-BBBB");
  await op.getByText("This code can't be used").waitFor();
  await shot(op, "link-invalid-code", { full: false });

  // ------------------------------------------------------------ signed-in pages
  await go(op, "/dashboard");
  await op.waitForURL(/\/orgs\/org_/);
  const orgPath = new URL(op.url()).pathname;
  await op.getByText("remaining this period").waitFor();
  await shot(op, "dashboard");
  await go(op, `${orgPath}/usage`);
  await op.getByRole("heading", { name: "Daily auto-director time" }).waitFor();
  await shot(op, "usage");
  // CSV download works through the same cookie.
  const csv = await op.evaluate(async (p) => (await fetch(`${p}?format=csv`, { credentials: "same-origin" })).text(), `/v1${orgPath}/usage`);
  if (!csv.startsWith("started_at,ended_at,seconds,computer,map,match")) problems.push(`[usage] CSV looks wrong: ${csv.slice(0, 80)}`);
  await go(op, `${orgPath}/computers`);
  await shot(op, "computers");
  await go(op, `${orgPath}/billing`);
  await op.getByRole("heading", { name: "Choose a plan" }).waitFor();
  await shot(op, "billing-payments-not-configured");
  await go(op, `${orgPath}/billing?checkout=cancelled`);
  await op.getByText("Checkout cancelled").waitFor();
  await shot(op, "billing-checkout-cancelled", { full: false });

  await go(op, `${orgPath}/team`);
  await op.getByLabel("Email").fill("producer@example.com");
  await op.getByLabel("Role", { exact: true }).selectOption("member");
  await op.getByRole("button", { name: "Send invitation" }).click();
  await op.getByText("Invitation sent to producer@example.com").waitFor();
  await shot(op, "team");
  await go(op, "/download");
  await op.getByText("SHA-256 checksum").waitFor();
  await shot(op, "download");
  // A second browser signs in as the owner, so the account page lists two sessions.
  const owner2 = await newPage(browser, "owner-second-browser", DESKTOP, ["GET /v1/auth/me 401"]);
  await go(owner2.page, "/login");
  await owner2.page.getByLabel("Email").fill("owner@example.com");
  await owner2.page.getByLabel("Password").fill(PASSWORD);
  await owner2.page.getByRole("button", { name: "Sign in" }).click();
  await owner2.page.waitForURL(/\/orgs\//);
  await go(op, "/account");
  await op.getByText("This device").waitFor();
  await shot(op, "account");
  await op.locator("#sessions").scrollIntoViewIfNeeded();
  await shot(op, "account-sessions", { full: false });
  await op.getByRole("button", { name: "Sign out all other sessions" }).click();
  await op.getByRole("dialog").getByRole("button", { name: "Sign out others" }).click();
  await op.getByText("Signed out 1 other session.").waitFor();
  const [download] = await Promise.all([op.waitForEvent("download"), op.getByRole("button", { name: "Download my data" }).click()]);
  if (!/^matchframe-account-\d{4}-\d{2}-\d{2}\.json$/.test(download.suggestedFilename())) problems.push(`[account] export file name: ${download.suggestedFilename()}`);
  const exported = JSON.parse(fs.readFileSync(await download.path(), "utf8"));
  if (!JSON.stringify(exported).includes("owner@example.com")) problems.push("[account] export doesn't contain the account email");
  await owner2.page.goto(`${BASE}/account`, { waitUntil: "networkidle" });
  await owner2.page.waitForURL(/\/login/);

  // Owner opens the producer's invitation: wrong account.
  const inviteLink = await emailLink("producer@example.com", "invite");
  await go(op, inviteLink);
  await op.getByText("This invitation is for a different email").waitFor();
  await shot(op, "invite-wrong-account");

  // ------------------------------------------------------------ invitee joins
  const prod = await newPage(browser, "producer", DESKTOP, ["POST /v1/auth/login 401"]);
  const pp = prod.page;
  await go(pp, inviteLink);
  await pp.getByText("Sign in or create an account").waitFor();
  await shot(pp, "invite-signed-out");
  await pp.getByRole("link", { name: "Create an account" }).click();
  await pp.waitForURL(/\/signup/);
  await signUp(pp, { name: "Sam Ortega", email: null, org: "Sam's productions" }, new URL(pp.url()).search);
  await verify(pp, "producer@example.com");
  await go(pp, inviteLink);
  await pp.getByRole("button", { name: /Accept and join/ }).click();
  await pp.waitForURL(new RegExp(`${orgPath}$`));
  await pp.getByText("Your role: Member").waitFor();
  await shot(pp, "dashboard-member");
  await go(pp, `${orgPath}/billing`);
  await pp.getByText("Billing is hidden for your role").waitFor();
  await shot(pp, "billing-member-role", { full: false });
  await go(pp, `${orgPath}/team`);
  await shot(pp, "team-member-role");

  // Password reset (signs out every session of the account).
  await pp.getByRole("button", { name: "Sign out" }).click();
  await pp.waitForURL(/\/login/);
  await go(pp, "/forgot-password");
  const before = emailCount("producer@example.com", "reset-password");
  await pp.getByLabel("Email").fill("producer@example.com");
  await pp.getByRole("button", { name: "Send reset link" }).click();
  await pp.getByText("Check your email").waitFor();
  await shot(pp, "forgot-password", { full: false });
  await go(pp, await emailLink("producer@example.com", "reset-password", before));
  await pp.getByLabel("New password", { exact: true }).fill("a brand new password");
  await pp.getByLabel("Repeat the new password").fill("a brand new password");
  await pp.getByRole("button", { name: "Set new password" }).click();
  await pp.waitForURL(/\/login\?reset=1/);
  await pp.getByLabel("Email").fill("producer@example.com");
  await pp.getByLabel("Password").fill("wrong password!");
  await pp.getByRole("button", { name: "Sign in" }).click();
  await pp.getByText("Email or password is incorrect.").waitFor();
  await shot(pp, "login-error", { full: false });
  await pp.getByLabel("Password").fill("a brand new password");
  await pp.getByRole("button", { name: "Sign in" }).click();
  await pp.waitForURL(/\/orgs\//);

  // ------------------------------------------------------------ staff console (bootstrap admin)
  const spam = await api("POST", "/v1/auth/signup", { email: "spam@example.com", password: PASSWORD, displayName: "Bulk Inviter", orgName: "Spam Co" }, { origin: BASE });
  if (spam.status !== 200 && spam.status !== 201) problems.push(`[staff] signup spam@ via API: ${spam.status} ${JSON.stringify(spam.data)}`);
  const staff = await newPage(browser, "staff", DESKTOP);
  const sp = staff.page;
  await signUp(sp, { name: "Matchframe Support", email: "admin@example.com", org: "Matchframe Staff" });
  await verify(sp, "admin@example.com");
  await go(sp, "/admin");
  await sp.getByText("Monthly recurring revenue").waitFor();
  await shot(sp, "admin-overview");

  await go(sp, "/admin/users");
  await sp.getByText(/Showing 1–\d+ of \d+ users/).waitFor();
  await shot(sp, "admin-users");
  await sp.getByRole("button", { name: "Staff" }).click();
  await sp.getByText(/Showing 1–1 of 1 users/).waitFor();
  await sp.getByRole("button", { name: "All" }).click();
  await sp.getByLabel("Search users").fill("producer");
  await sp.getByRole("button", { name: "Search" }).click();
  await sp.getByRole("link", { name: "Sam Ortega" }).click();
  await sp.getByRole("heading", { name: "Sam Ortega" }).waitFor();
  await shot(sp, "admin-user-detail");
  await sp.getByLabel("Staff role").selectOption("support");
  await sp.getByRole("button", { name: "Save staff role" }).click();
  await sp.getByRole("dialog").getByRole("button", { name: "Save staff role" }).click();
  await sp.getByText("Staff role set to support.").waitFor();
  await shot(sp, "admin-user-staff-role", { full: false });

  // Disable an account; it can no longer sign in.
  await go(sp, "/admin/users?q=spam");
  await sp.getByRole("link", { name: "Bulk Inviter" }).click();
  await sp.getByRole("button", { name: "Disable account" }).click();
  await sp.getByRole("dialog").getByLabel("Reason (recorded in the audit log)").fill("Mass invitations to unrelated addresses");
  await shot(sp, "admin-disable-dialog", { full: false });
  await sp.getByRole("dialog").getByRole("button", { name: "Disable account" }).click();
  await sp.getByText("This account is disabled").waitFor();
  await shot(sp, "admin-user-disabled");
  const blocked = await newPage(browser, "disabled-login", DESKTOP, ["POST /v1/auth/login 403"]);
  await go(blocked.page, "/login");
  await blocked.page.getByLabel("Email").fill("spam@example.com");
  await blocked.page.getByLabel("Password").fill(PASSWORD);
  await blocked.page.getByRole("button", { name: "Sign in" }).click();
  await blocked.page.getByText(/This account has been disabled/).waitFor();
  await shot(blocked.page, "login-disabled", { full: false });

  // Organisations: search, detail, grant hours.
  await go(sp, "/admin/orgs");
  await sp.getByLabel("Search organisations").fill("northside");
  await sp.getByRole("button", { name: "Search" }).click();
  await sp.getByRole("link", { name: "Northside Broadcast" }).first().waitFor();
  await shot(sp, "admin-orgs");
  await sp.getByRole("link", { name: "Northside Broadcast" }).first().click();
  await sp.getByRole("heading", { name: "Northside Broadcast" }).waitFor();
  await sp.getByRole("button", { name: "Grant hours" }).first().click();
  const grant = sp.getByRole("dialog");
  await grant.getByLabel("Hours", { exact: true }).fill("5");
  await grant.getByLabel("Note (shown to the organisation)").fill("Launch-week support credit");
  await shot(sp, "admin-grant-hours", { full: false });
  await grant.getByRole("button", { name: "Grant hours" }).click();
  await sp.getByText("Granted 5 h to Northside Broadcast.").waitFor();
  await shot(sp, "admin-org-detail");

  // Support inbox: the contact-form message from earlier.
  await go(sp, "/admin/inbox");
  await sp.getByText(/16-team league/).waitFor();
  await shot(sp, "admin-inbox");
  await sp.getByRole("button", { name: "Mark handled" }).first().click();
  await sp.getByText(/marked handled/).waitFor();

  // Email log (no SMTP here: emails are logged, resending explains why nothing was sent).
  await go(sp, "/admin/emails");
  await sp.getByText("Email delivery isn't configured").waitFor();
  await shot(sp, "admin-emails");
  await sp.getByRole("button", { name: /^Resend/ }).first().click();
  await sp.getByText(/Not resent:/).waitFor();

  // Catalogue edit, audit, Stripe events.
  await go(sp, "/admin/catalog");
  await sp.getByRole("button", { name: "Edit Pro" }).click();
  await sp.getByLabel("Stripe price id").fill("price_1PRO_demo");
  await shot(sp, "admin-catalog");
  await sp.getByRole("button", { name: "Save plan" }).click();
  await sp.getByText("Plan “Pro” saved.").waitFor();
  await go(sp, "/admin/stripe");
  await sp.getByText("No Stripe webhook events received yet").waitFor();
  await go(sp, "/admin/audit");
  await sp.getByText("admin.plan_saved").first().waitFor();
  await shot(sp, "admin-audit");
  // Restore the catalogue entry (no Stripe price) so billing shows the unconfigured state consistently.
  await go(sp, "/admin/catalog");
  await sp.getByRole("button", { name: "Edit Pro" }).click();
  await sp.getByLabel("Stripe price id").fill("");
  await sp.getByRole("button", { name: "Save plan" }).click();
  await sp.getByText("Plan “Pro” saved.").waitFor();

  // ------------------------------------------------------------ support staff view (producer@ was promoted above)
  await go(pp, "/admin");
  await pp.getByRole("navigation", { name: "Staff console" }).waitFor();
  await pp.getByText("Monthly recurring revenue").waitFor();
  await go(pp, "/admin/users?q=owner");
  await pp.getByRole("link", { name: "Riley Park" }).click();
  await pp.getByRole("heading", { name: "Riley Park" }).waitFor();
  await pp.getByText("Admin staff only").waitFor();
  if ((await pp.getByRole("button", { name: "Disable account" }).count()) > 0) problems.push("[support] Disable account is offered to support staff");
  if ((await pp.getByLabel("Staff role").count()) > 0) problems.push("[support] staff role select is offered to support staff");
  await shot(pp, "admin-support-user-detail");
  await go(pp, "/admin/catalog");
  await pp.getByText(/creating and editing plans and hour packs is hidden/).waitFor();
  if ((await pp.getByRole("button", { name: /^Edit/ }).count()) > 0) problems.push("[support] catalogue edit offered to support staff");
  await shot(pp, "admin-support-catalog", { full: false });
  await go(pp, "/admin/stripe");
  await pp.getByText(/only shown to admins/).waitFor();

  // Owner sees the granted credit.
  await go(op, `${orgPath}/billing`);
  await op.getByText("Launch-week support credit").waitFor();
  await shot(op, "billing-credits");

  // ------------------------------------------------------------ over the limit (second organisation)
  await go(op, "/account");
  await op.getByLabel("New organisation name").fill("Overtime Esports");
  await op.getByRole("button", { name: "Create organisation" }).click();
  await op.waitForURL((u) => u.pathname.startsWith("/orgs/") && u.pathname !== orgPath);
  await op.getByRole("heading", { name: "Overtime Esports" }).waitFor();
  const otPath = new URL(op.url()).pathname;
  const d2 = await deviceAuthorize("STAGE-PC");
  await go(op, `/link?code=${d2.userCode}`);
  await op.getByRole("radio", { name: /Overtime Esports/ }).check();
  await op.getByRole("button", { name: "Approve and link" }).click();
  await op.getByText("STAGE-PC is approved").waitFor();
  const tok2 = await devicePoll(d2.deviceCode);
  await uploadUsage(tok2.deviceToken, [
    [2, 70, "de_dust2"],
    [1, 62, "de_vertigo"],
  ]);
  await go(op, otPath);
  await op.getByText("over the limit").first().waitFor();
  await shot(op, "dashboard-over-limit");
  const darkOwner = await newPage(browser, "owner-dark", DESKTOP, [], "dark");
  await darkOwner.ctx.addCookies(await owner.ctx.cookies());
  await go(darkOwner.page, orgPath);
  await darkOwner.page.getByText("remaining this period").waitFor();
  await shot(darkOwner.page, "dashboard-dark", { full: false });

  // ------------------------------------------------------------ 390 px
  const mob = await newPage(browser, "mobile", MOBILE, ["POST /v1/auth/login 401"]);
  const mp = mob.page;
  for (const p of PUBLIC_MOBILE) {
    await go(mp, p);
    await mp.locator("h1").first().waitFor();
    await shot(mp, `${PUBLIC_PAGES.find(([q]) => q === p)[1]}-mobile`);
  }
  for (const [p, n] of [
    ["/login", "login-mobile"],
    ["/signup", "signup-mobile"],
  ]) {
    await go(mp, p);
    await shot(mp, n);
  }
  await mp.getByRole("button", { name: "Menu" }).click();
  await mp.getByRole("button", { name: "Product" }).click();
  await shot(mp, "nav-menu-mobile", { full: false });
  await mob.ctx.addCookies(await owner.ctx.cookies());
  const d3 = await deviceAuthorize("CASTER-LAPTOP");
  await go(mp, `/link?code=${d3.userCode}`);
  await mp.getByRole("button", { name: "Approve and link" }).waitFor();
  await shot(mp, "link-pending-mobile");
  for (const [p, n] of [
    [orgPath, "dashboard-mobile"],
    [`${orgPath}/usage`, "usage-mobile"],
    [`${orgPath}/billing`, "billing-mobile"],
    [`${orgPath}/computers`, "computers-mobile"],
    [`${orgPath}/team`, "team-mobile"],
    ["/download", "download-mobile"],
    ["/account", "account-mobile"],
    [otPath, "dashboard-over-limit-mobile"],
  ]) {
    await go(mp, p);
    await shot(mp, n);
  }
  await mp.getByRole("button", { name: "Menu" }).click();
  await shot(mp, "app-menu-mobile", { full: false });
  const smob = await newPage(browser, "staff-mobile", MOBILE);
  await smob.ctx.addCookies(await staff.ctx.cookies());
  await go(smob.page, "/admin");
  await smob.page.getByText("Monthly recurring revenue").waitFor();
  await shot(smob.page, "admin-mobile");
  await go(smob.page, "/admin/users");
  await smob.page.getByText(/Showing 1–/).waitFor();
  await shot(smob.page, "admin-users-mobile");
  await smob.page.getByRole("link", { name: "Sam Ortega" }).click();
  await smob.page.getByRole("heading", { name: "Sam Ortega" }).waitFor();
  await shot(smob.page, "admin-user-detail-mobile");
  await smob.page.getByRole("button", { name: "Menu" }).click();
  await shot(smob.page, "admin-menu-mobile", { full: false });

  await browser.close();
  report();
}

function report() {
  console.log(`\nScreenshots in ${OUT}:\n  ${visited.join("\n  ")}`);
  if (problems.length) {
    console.log(`\n${problems.length} problem(s):\n  ${problems.join("\n  ")}`);
    process.exitCode = 1;
  } else console.log("\nNo console errors, failed requests, unexpected HTTP errors or horizontal overflow.");
}

main().catch((e) => {
  console.error(e);
  report();
  process.exit(1);
});
