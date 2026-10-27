import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { EntitlementPayload } from "@matchframe/cloud-contracts";
import { CloudApp } from "../src/app.ts";
import { loadCloudConfig } from "../src/config.ts";
import { PgliteSql } from "../src/db/sql.ts";
import { startCloudServer } from "../src/server.ts";
import { Client, freePort } from "./http.ts";

const PASSWORD = "correct horse battery";
const INSTALL_A = "install-aaaaaaaaaaaaaaaa";
const INSTALL_B = "install-bbbbbbbbbbbbbbbb";

describe("program sign-in with the website's email and password (/v1/device/login)", () => {
  let app: CloudApp;
  let close: () => Promise<void>;
  let base: string;

  const lastEmail = async (to: string) => (await app.sql.query<{ body_text: string }>("SELECT body_text FROM outbox_emails WHERE to_addr = $1 ORDER BY id DESC LIMIT 1", [to])).rows[0]!;
  const tokenFrom = (text: string) => /token=([A-Za-z0-9_-]+)/.exec(text)![1]!;

  async function signup(email: string, verify = true): Promise<{ client: Client; userId: string; orgId: string }> {
    const client = new Client(base);
    const r = await client.req<{ userId: string; orgId: string }>("POST", "/v1/auth/signup", { email, password: PASSWORD, displayName: email.split("@")[0], orgName: `${email.split("@")[0]} Org` });
    expect(r.status).toBe(201);
    if (verify) expect((await client.req("POST", "/v1/auth/verify-email", { token: tokenFrom((await lastEmail(email)).body_text) })).status).toBe(200);
    return { client, ...r.data };
  }

  /** The program has no cookies and sends no Origin header. */
  const program = () => new Client(base, null);
  const deviceLogin = (body: Record<string, unknown>) =>
    program().req<{ deviceToken: string; deviceId: string; orgId: string; orgName: string; user: { email: string; displayName: string }; error: string; message: string; detail: { orgs: { id: string; name: string; role: string; planName: string }[] } }>("POST", "/v1/device/login", {
      deviceName: "Production PC",
      platform: "win32",
      appVersion: "0.1.1",
      installId: INSTALL_A,
      password: PASSWORD,
      ...body,
    });
  const entitlement = (token: string) => program().req<{ payload: EntitlementPayload; error: string }>("POST", "/v1/device/entitlement", undefined, { authorization: `Bearer ${token}` });

  beforeAll(async () => {
    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    app = new CloudApp(loadCloudConfig({}, { publicUrl: base, port, staffEmails: ["admin@example.com"] }), { sql: new PgliteSql(), rateLimitScale: 100 });
    await app.init();
    ({ close } = await startCloudServer(app));
  });

  afterAll(async () => {
    await close?.();
    await app?.close();
  });

  it("checks the password like the website, requires a verified email, and returns the computer's credential", async () => {
    const pending = await signup("pending@example.com", false);
    expect(await deviceLogin({ email: "pending@example.com", password: "wrong password" }).then((r) => [r.status, r.data.error])).toEqual([401, "invalid_credentials"]);
    expect(await deviceLogin({ email: "nobody@example.com" }).then((r) => [r.status, r.data.error])).toEqual([401, "invalid_credentials"]);
    expect(await deviceLogin({ email: "pending@example.com" }).then((r) => [r.status, r.data.error])).toEqual([403, "email_unverified"]);
    expect((await pending.client.req("POST", "/v1/auth/verify-email", { token: tokenFrom((await lastEmail("pending@example.com")).body_text) })).status).toBe(200);

    const ok = await deviceLogin({ email: "Pending@Example.com" });
    expect(ok.status).toBe(200);
    expect(ok.data).toMatchObject({ orgId: pending.orgId, orgName: "pending Org", user: { email: "pending@example.com", displayName: "pending" } });
    expect(ok.data.deviceToken).toMatch(/^mfd_/);

    // The licence names who the computer is signed in as; the website lists the computer with that person.
    const ent = await entitlement(ok.data.deviceToken);
    expect(ent.data.payload.user).toEqual({ id: pending.userId, email: "pending@example.com", displayName: "pending" });
    const devices = await pending.client.req<{ id: string; approvedBy: string; revokedAt: string | null }[]>("GET", `/v1/orgs/${pending.orgId}/devices`);
    expect(devices.data).toEqual([expect.objectContaining({ id: ok.data.deviceId, approvedBy: "pending", revokedAt: null })]);

    // Signing in again on the same install replaces its credential; another install hits the Free plan's limit.
    const again = await deviceLogin({ email: "pending@example.com" });
    expect(again.status).toBe(200);
    expect((await entitlement(ok.data.deviceToken)).status).toBe(401);
    expect(await deviceLogin({ email: "pending@example.com", installId: INSTALL_B }).then((r) => [r.status, r.data.error])).toEqual([409, "device_limit"]);
  });

  it("asks which organisation when the account has several; refuses roles that cannot add computers", async () => {
    const multi = await signup("multi@example.com");
    const second = await multi.client.req<{ id: string }>("POST", "/v1/orgs", { name: "Second Org" });
    expect(second.status).toBe(200);
    const choose = await deviceLogin({ email: "multi@example.com" });
    expect([choose.status, choose.data.error]).toEqual([409, "choose_org"]);
    expect(choose.data.detail.orgs.map((o) => [o.name, o.role, o.planName])).toEqual([
      ["multi Org", "owner", "Free"],
      ["Second Org", "owner", "Free"],
    ]);
    const picked = await deviceLogin({ email: "multi@example.com", orgId: second.data.id });
    expect([picked.status, picked.data.orgName]).toEqual([200, "Second Org"]);
    expect((await deviceLogin({ email: "multi@example.com", orgId: "org_someone_else" })).status).toBe(404);

    const billing = await signup("billing@example.com");
    await app.sql.query("UPDATE memberships SET role = 'billing' WHERE user_id = $1", [billing.userId]);
    expect(await deviceLogin({ email: "billing@example.com" }).then((r) => [r.status, r.data.error])).toEqual([403, "forbidden"]);
  });

  it("signs computers out when the password changes or is reset, the account is disabled, or the person leaves the organisation", async () => {
    const u = await signup("owner@example.com");
    const signIn = async (installId = INSTALL_A) => {
      const r = await deviceLogin({ email: "owner@example.com", installId });
      expect(r.status).toBe(200);
      return r.data.deviceToken;
    };

    let token = await signIn();
    const changed = await u.client.req<{ computersSignedOut: number }>("POST", "/v1/auth/change-password", { currentPassword: PASSWORD, newPassword: "an even better password" });
    expect(changed.data.computersSignedOut).toBe(1);
    expect(await entitlement(token).then((r) => [r.status, r.data.error])).toEqual([401, "device_revoked"]);
    expect((await u.client.req("POST", "/v1/auth/change-password", { currentPassword: "an even better password", newPassword: PASSWORD })).status).toBe(200);

    token = await signIn();
    expect((await program().req("POST", "/v1/auth/request-password-reset", { email: "owner@example.com" })).status).toBe(200);
    expect((await program().req("POST", "/v1/auth/reset-password", { token: tokenFrom((await lastEmail("owner@example.com")).body_text), password: PASSWORD })).status).toBe(200);
    expect((await entitlement(token)).status).toBe(401);

    const admin = await signup("admin@example.com");
    token = await signIn();
    expect((await admin.client.req("POST", `/v1/admin/users/${u.userId}/sign-out`)).data).toEqual({ revoked: 0, computers: 1 });
    expect((await entitlement(token)).status).toBe(401);

    token = await signIn();
    expect((await admin.client.req("POST", `/v1/admin/users/${u.userId}/disable`, { reason: "support test" })).status).toBe(200);
    expect((await entitlement(token)).status).toBe(401);
    expect(await deviceLogin({ email: "owner@example.com" }).then((r) => [r.status, r.data.error])).toEqual([403, "account_disabled"]);
    expect((await admin.client.req("POST", `/v1/admin/users/${u.userId}/enable`)).status).toBe(200);

    // Leaving an organisation signs out only that organisation's computers.
    const login = new Client(base);
    expect((await login.req("POST", "/v1/auth/login", { email: "owner@example.com", password: PASSWORD })).status).toBe(200);
    const other = await login.req<{ id: string }>("POST", "/v1/orgs", { name: "Other Org" });
    const inOwn = await deviceLogin({ email: "owner@example.com", orgId: u.orgId });
    const inOther = await deviceLogin({ email: "owner@example.com", orgId: other.data.id, installId: INSTALL_B });
    expect([inOwn.status, inOther.status]).toEqual([200, 200]);
    await app.sql.query("INSERT INTO memberships (org_id, user_id, role) SELECT $1, id, 'owner' FROM users WHERE email = 'admin@example.com'", [other.data.id]);
    expect((await login.req("DELETE", `/v1/orgs/${other.data.id}/members/${u.userId}`)).status).toBe(200);
    expect((await entitlement(inOther.data.deviceToken)).status).toBe(401);
    expect((await entitlement(inOwn.data.deviceToken)).status).toBe(200);
  });
});
