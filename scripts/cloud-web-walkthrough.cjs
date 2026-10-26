// Walks the Matchframe website (apps/cloud-web) against a running cloud API and saves screenshots.
//
//   pnpm --filter @matchframe/cloud-web build
//   MF_CLOUD_PORT=8080 MF_CLOUD_PUBLIC_URL=http://127.0.0.1:8080 MF_CLOUD_WEB_DIR=apps/cloud-web/dist \
//     MF_DEV_LOG_EMAILS=1 MF_STAFF_EMAILS=admin@example.com pnpm cloud > cloud.log 2>&1 &
//   MF_CLOUD_LOG=cloud.log node scripts/cloud-web-walkthrough.cjs [--stripe-enabled]
//
// Needs a fresh (in-memory) API: it signs up owner@, producer@ and admin@example.com. Set
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
  await sleep(150);
  const vw = page.viewportSize();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  // Full-page captures draw sticky elements where they are, so start from the top.
  if (opts.full ?? true) await page.evaluate(() => window.scrollTo(0, 0));
  if (overflow > 1) problems.push(`[${name}] horizontal overflow of ${overflow}px at ${vw.width}px`);
  const file = path.join(OUT, `${name}.jpg`);
  const full = opts.full ?? true;
  const height = await page.evaluate(() => document.documentElement.scrollHeight);
  const maxH = vw.width < 600 ? 3400 : 2600;
  // Full page, cut at maxH so very long pages stay readable and small.
  await page.screenshot({ path: file, type: "jpeg", quality: opts.quality ?? 72, fullPage: full, clip: full && height > maxH ? { x: 0, y: 0, width: vw.width, height: maxH } : undefined });
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
  for (const [p, n] of [
    ["/", "home"],
    ["/pricing", "pricing"],
  ]) {
    await go(pub.page, p);
    await shot(pub.page, n);
  }
  const pubDark = await newPage(browser, "public-dark", DESKTOP, [], "dark");
  await go(pubDark.page, "/");
  await shot(pubDark.page, "home-dark", { full: false });

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
  await go(op, "/account");
  await shot(op, "account");

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

  // ------------------------------------------------------------ staff
  const staff = await newPage(browser, "staff", DESKTOP);
  const sp = staff.page;
  await signUp(sp, { name: "Matchframe Support", email: "admin@example.com", org: "Matchframe Staff" });
  await verify(sp, "admin@example.com");
  await go(sp, "/admin");
  await sp.getByLabel("Search organisations").fill("northside");
  await sp.getByRole("button", { name: "Search" }).click();
  await sp.getByRole("button", { name: "Grant hours" }).first().waitFor();
  await sp.getByRole("button", { name: "Grant hours" }).first().click();
  await sp.getByLabel("Hours", { exact: true }).fill("5");
  await sp.getByLabel("Note (shown to the organisation)").fill("Launch-week support credit");
  await shot(sp, "admin-grant-hours");
  await sp.getByRole("button", { name: "Grant hours" }).click();
  await sp.getByText("Granted 5 h to Northside Broadcast.").waitFor();
  await shot(sp, "admin-orgs");
  await sp.getByRole("tab", { name: "Catalogue" }).click();
  await sp.getByRole("button", { name: "Edit Pro" }).click();
  await sp.getByLabel("Stripe price id").fill("price_1PRO_demo");
  await shot(sp, "admin-catalog");
  await sp.getByRole("button", { name: "Save plan" }).click();
  await sp.getByText("Plan “Pro” saved.").waitFor();
  await sp.getByRole("tab", { name: "Stripe events" }).click();
  await sp.getByText("No Stripe webhook events received yet").waitFor();
  await sp.getByRole("tab", { name: "Audit log" }).click();
  await sp.getByText("admin.plan_saved").first().waitFor();
  await shot(sp, "admin-audit");
  // Restore the catalogue entry (no Stripe price) so billing shows the unconfigured state consistently.
  await sp.getByRole("tab", { name: "Catalogue" }).click();
  await sp.getByRole("button", { name: "Edit Pro" }).click();
  await sp.getByLabel("Stripe price id").fill("");
  await sp.getByRole("button", { name: "Save plan" }).click();
  await sp.getByText("Plan “Pro” saved.").waitFor();

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
  for (const [p, n] of [
    ["/", "home-mobile"],
    ["/pricing", "pricing-mobile"],
    ["/login", "login-mobile"],
    ["/signup", "signup-mobile"],
  ]) {
    await go(mp, p);
    await shot(mp, n);
  }
  await mp.getByRole("button", { name: "Menu" }).click();
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
  await smob.page.getByText("Northside Broadcast").first().waitFor();
  await shot(smob.page, "admin-mobile");

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
