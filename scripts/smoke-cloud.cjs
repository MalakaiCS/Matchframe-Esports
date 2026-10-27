// Helpers for the program smoke tests: a local Matchframe website (cloud API from source, in-memory
// database) with verified accounts, and signing in through the program's sign-in screen.
const { spawn } = require("node:child_process");
const { join } = require("node:path");

const waitFor = async (fn, ms = 60000) => {
  const end = Date.now() + ms;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch {
      // retry
    }
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 250));
  }
};

async function startCloud({ repo, port }) {
  const base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ["--import", "tsx", join(repo, "services/cloud-api/src/main.ts")], {
    cwd: repo,
    env: { ...process.env, NODE_ENV: "development", MF_CLOUD_HOST: "127.0.0.1", MF_CLOUD_PORT: String(port), MF_CLOUD_PUBLIC_URL: base, MF_DEV_LOG_EMAILS: "1", DATABASE_URL: "", MF_CLOUD_PGLITE_DIR: "", MF_CLOUD_SIGNING_KEY: "" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout.on("data", (d) => (log += d));
  child.stderr.on("data", (d) => (log += d));
  try {
    await waitFor(() => fetch(`${base}/v1/health`).then((r) => r.ok), 90000);
  } catch (e) {
    child.kill();
    throw new Error(`local website did not start: ${log.slice(-2000)}`, { cause: e });
  }
  const keys = (await fetch(`${base}/v1/keys`).then((r) => r.json())).keys;

  /** Signs up and confirms the email (the link is read from the development email log). */
  async function account(email, password, orgName) {
    const res = await fetch(`${base}/v1/auth/signup`, { method: "POST", headers: { "content-type": "application/json", origin: base }, body: JSON.stringify({ email, password, displayName: email.split("@")[0], orgName }) });
    if (res.status !== 201) throw new Error(`signup failed: HTTP ${res.status} ${await res.text()}`);
    const token = await waitFor(() => {
      const at = log.lastIndexOf(`to ${email}:`);
      return at >= 0 ? /verify-email\?token=([A-Za-z0-9_-]+)/.exec(log.slice(at))?.[1] : null;
    }, 15000);
    const v = await fetch(`${base}/v1/auth/verify-email`, { method: "POST", headers: { "content-type": "application/json", origin: base }, body: JSON.stringify({ token }) });
    if (v.status !== 200) throw new Error(`verification failed: HTTP ${v.status}`);
  }

  return { base, keys, account, stop: () => child.kill("SIGTERM"), log: () => log };
}

/** Fills in the program's sign-in screen and waits for the console. */
async function signInThroughGate(win, email, password) {
  await waitFor(() => win.evaluate(() => document.body.innerText.includes("Sign in to Matchframe")), 90000);
  await win.fill('input[type="email"]', email);
  await win.fill('input[type="password"]', password);
  await win.click('button[type="submit"]');
  await waitFor(() => win.evaluate(() => document.querySelectorAll("nav a").length > 5), 60000);
}

module.exports = { startCloud, signInThroughGate, waitFor };
