import { z } from "zod";
import { DeviceApproveRequest, DeviceAuthorizeRequest, DeviceLoginRequest, DeviceTokenRequest, UsageBatch } from "@matchframe/cloud-contracts";
import type { DeviceAuthorizeResponse, DeviceLoginOrg, DeviceLoginResponse, DeviceTokenResponse, EntitlementPayload, OrgRole } from "@matchframe/cloud-contracts";
import { signEntitlement } from "@matchframe/cloud-contracts/token";
import type { CloudApp } from "../app.ts";
import { DUMMY_HASH, verifyPassword } from "../auth/passwords.ts";
import { audit } from "../domain/audit.ts";
import { computeAllowance, ingestUsage, orgPlanState } from "../domain/allowance.ts";
import { issueDeviceCredential } from "../domain/devices.ts";
import { roleCan } from "../domain/roles.ts";
import type { Router } from "../http/router.ts";
import { HttpError, reply } from "../http/router.ts";
import { hashSecret, newSecret, newUserCode, normalizeUserCode } from "../ids.ts";

const LINK_TTL_S = 600;
const POLL_INTERVAL_S = 5;

export function registerDeviceRoutes(r: Router, app: CloudApp): void {
  // ---------------------------------------------------------------- desktop side (no cookies)

  r.add("POST", "/v1/device/authorize", { body: DeviceAuthorizeRequest, browserMutation: false, summary: "Desktop: start linking; shows the user code to enter on the website" }, async (ctx) => {
    app.rateLimit(app.limits.deviceAuthorize, `authorize:${ctx.ip}`);
    const deviceCode = newSecret();
    let userCode = newUserCode();
    for (let i = 0; i < 5; i++) {
      try {
        await app.sql.query(
          "INSERT INTO device_auth (device_code_hash, user_code, install_id, device_name, platform, app_version, status, poll_interval, expires_at) VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7, $8)",
          [hashSecret(deviceCode), userCode, ctx.body.installId, ctx.body.deviceName, ctx.body.platform, ctx.body.appVersion, POLL_INTERVAL_S, new Date(app.now().getTime() + LINK_TTL_S * 1000)],
        );
        break;
      } catch (e) {
        if (i === 4 || !String(e).includes("duplicate")) throw e;
        userCode = newUserCode();
      }
    }
    const out: DeviceAuthorizeResponse = { deviceCode, userCode, verificationUri: `${app.cfg.publicUrl}/link`, verificationUriComplete: `${app.cfg.publicUrl}/link?code=${userCode}`, expiresIn: LINK_TTL_S, interval: POLL_INTERVAL_S };
    return out;
  });

  r.add("POST", "/v1/device/token", { body: DeviceTokenRequest, browserMutation: false, summary: "Desktop: poll until the user approves; returns the device credential once" }, async (ctx) => {
    const h = hashSecret(ctx.body.deviceCode);
    const now = app.now();
    return app.sql.transaction(async (tx) => {
      const { rows } = await tx.query<{ status: string; org_id: string | null; approved_by: string | null; install_id: string; device_name: string; platform: string; app_version: string; poll_interval: number; last_poll_at: Date | null; expires_at: Date }>(
        "SELECT status, org_id, approved_by, install_id, device_name, platform, app_version, poll_interval, last_poll_at, expires_at FROM device_auth WHERE device_code_hash = $1 FOR UPDATE",
        [h],
      );
      const a = rows[0];
      const fail = (error: string, status = 400) => reply({ status, json: { error } });
      if (!a || a.status === "consumed" || a.expires_at <= now) return fail("expired_token");
      if (a.status === "denied") return fail("access_denied");
      if (a.last_poll_at && now.getTime() - a.last_poll_at.getTime() < a.poll_interval * 1000 - 250) {
        await tx.query("UPDATE device_auth SET poll_interval = poll_interval + 5, last_poll_at = $2 WHERE device_code_hash = $1", [h, now]);
        return fail("slow_down");
      }
      await tx.query("UPDATE device_auth SET last_poll_at = $2 WHERE device_code_hash = $1", [h, now]);
      if (a.status === "pending") return fail("authorization_pending");
      // Approved: issue the device credential exactly once.
      const { deviceId, token } = await issueDeviceCredential(tx, { orgId: a.org_id!, userId: a.approved_by, installId: a.install_id, name: a.device_name, platform: a.platform, appVersion: a.app_version }, now);
      await tx.query("UPDATE device_auth SET status = 'consumed' WHERE device_code_hash = $1", [h]);
      const org = await tx.query<{ name: string }>("SELECT name FROM orgs WHERE id = $1", [a.org_id]);
      await audit(tx, a.approved_by ?? "device", a.org_id, "device.linked", { deviceId, name: a.device_name });
      const out: DeviceTokenResponse = { deviceId, orgId: a.org_id!, orgName: org.rows[0]!.name, deviceToken: token };
      return out;
    });
  });

  r.add("POST", "/v1/device/login", { body: DeviceLoginRequest, browserMutation: false, summary: "Desktop: sign in with the website's email and password; returns this computer's credential once" }, async (ctx) => {
    const b = ctx.body;
    // Same limits as signing in on the website (shared per-address counter).
    app.rateLimit(app.limits.auth, `device-login:${ctx.ip}`);
    app.rateLimit(app.limits.auth, `login-email:${b.email}`);
    const { rows } = await app.sql.query<{ id: string; email: string; display_name: string; password_hash: string; email_verified_at: Date | null; disabled_at: Date | null }>(
      "SELECT id, email, display_name, password_hash, email_verified_at, disabled_at FROM users WHERE email = $1",
      [b.email],
    );
    const u = rows[0];
    const ok = await verifyPassword(b.password, u?.password_hash ?? DUMMY_HASH);
    if (!u || !ok) throw new HttpError(401, "invalid_credentials", "email or password is incorrect");
    if (u.disabled_at) throw new HttpError(403, "account_disabled", "this account has been disabled; contact Matchframe support");
    if (!u.email_verified_at) throw new HttpError(403, "email_unverified", "confirm your email address first: open the link in the email we sent you (or resend it from the website), then sign in again");
    const m = await app.sql.query<{ org_id: string; name: string; role: OrgRole }>("SELECT m.org_id, o.name, m.role FROM memberships m JOIN orgs o ON o.id = m.org_id WHERE m.user_id = $1 ORDER BY m.created_at", [u.id]);
    if (m.rows.length === 0) throw new HttpError(409, "no_organisation", "your account is not in an organisation yet: create one on the website or accept an invitation, then sign in again");
    let membership = m.rows[0]!;
    if (b.orgId) {
      const chosen = m.rows.find((x) => x.org_id === b.orgId);
      if (!chosen) throw new HttpError(404, "not_found", "you are not a member of that organisation");
      membership = chosen;
    } else if (m.rows.length > 1) {
      const orgs: DeviceLoginOrg[] = [];
      for (const x of m.rows) orgs.push({ id: x.org_id, name: x.name, role: x.role, planName: (await orgPlanState(app.sql, x.org_id, app.now())).plan.name });
      throw new HttpError(409, "choose_org", "choose which organisation this computer belongs to", { orgs });
    }
    if (!roleCan(membership.role, "devices.link")) throw new HttpError(403, "forbidden", `your role (${membership.role}) cannot add computers to ${membership.name}`);
    const now = app.now();
    const st = await orgPlanState(app.sql, membership.org_id, now);
    return app.sql.transaction(async (tx) => {
      // The organisation row lock serialises concurrent sign-ins against the computer limit.
      await tx.query("SELECT id FROM orgs WHERE id = $1 FOR UPDATE", [membership.org_id]);
      const active = await tx.query<{ n: string }>("SELECT count(*) AS n FROM devices WHERE org_id = $1 AND revoked_at IS NULL AND install_id <> $2", [membership.org_id, b.installId]);
      if (Number(active.rows[0]!.n) >= st.plan.features.maxDevices) throw new HttpError(409, "device_limit", `the ${st.plan.name} plan allows ${st.plan.features.maxDevices === 1 ? "1 signed-in computer" : `${st.plan.features.maxDevices} signed-in computers`}; sign one out on the website (Computers) or upgrade`);
      const { deviceId, token } = await issueDeviceCredential(tx, { orgId: membership.org_id, userId: u.id, installId: b.installId, name: b.deviceName, platform: b.platform, appVersion: b.appVersion }, now);
      await audit(tx, u.id, membership.org_id, "device.signed_in", { deviceId, name: b.deviceName, ip: ctx.ip });
      await tx.query("UPDATE users SET last_login_at = $2 WHERE id = $1", [u.id, now]);
      const out: DeviceLoginResponse = { deviceId, orgId: membership.org_id, orgName: membership.name, deviceToken: token, user: { id: u.id, email: u.email, displayName: u.display_name } };
      return out;
    });
  });

  r.add("POST", "/v1/device/entitlement", { browserMutation: false, summary: "Desktop: fetch a signed entitlement (plan, features, auto-director allowance)" }, async (ctx) => {
    const d = await app.requireDevice(ctx);
    const now = app.now();
    const { planState, ...allowance } = await computeAllowance(app.sql, d.orgId, now);
    const org = await app.sql.query<{ name: string }>("SELECT name FROM orgs WHERE id = $1", [d.orgId]);
    const signedInAs = await app.sql.query<{ id: string; email: string; display_name: string }>("SELECT u.id, u.email, u.display_name FROM devices d JOIN users u ON u.id = d.approved_by WHERE d.id = $1", [d.deviceId]);
    const appVersion = typeof ctx.headers["x-matchframe-version"] === "string" ? ctx.headers["x-matchframe-version"].slice(0, 40) : null;
    await app.sql.query("UPDATE devices SET last_seen_at = $2, app_version = COALESCE($3, app_version) WHERE id = $1", [d.deviceId, now, appVersion]);
    const payload: EntitlementPayload = {
      v: 1,
      iss: app.cfg.publicUrl,
      kid: app.kid,
      orgId: d.orgId,
      orgName: org.rows[0]!.name,
      deviceId: d.deviceId,
      plan: { id: planState.plan.id, name: planState.plan.name },
      subscriptionStatus: planState.subscriptionStatus,
      features: planState.plan.features,
      autoDirector: allowance,
      issuedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + app.cfg.entitlementTtlHours * 3_600_000).toISOString(),
      graceUntil: new Date(now.getTime() + app.cfg.offlineGraceDays * 86_400_000).toISOString(),
      user: signedInAs.rows[0] ? { id: signedInAs.rows[0].id, email: signedInAs.rows[0].email, displayName: signedInAs.rows[0].display_name } : null,
    };
    return { token: signEntitlement(payload, app.signingKeyPem), payload };
  });

  r.add("POST", "/v1/device/usage", { body: UsageBatch, browserMutation: false, summary: "Desktop: upload auto-director usage records (idempotent)" }, async (ctx) => {
    const d = await app.requireDevice(ctx);
    const result = await app.sql.transaction((tx) => ingestUsage(tx, d.orgId, d.deviceId, ctx.body.records, app.now()));
    if (result.accepted.length) await audit(app.sql, `device:${d.deviceId}`, d.orgId, "usage.uploaded", { accepted: result.accepted.length, duplicates: result.duplicates.length, rejected: result.rejected.length });
    return result;
  });

  r.add("POST", "/v1/device/unlink", { browserMutation: false, summary: "Desktop: unlink this computer" }, async (ctx) => {
    const d = await app.requireDevice(ctx);
    await app.sql.query("UPDATE devices SET revoked_at = $2 WHERE id = $1", [d.deviceId, app.now()]);
    await audit(app.sql, `device:${d.deviceId}`, d.orgId, "device.unlinked_from_app");
    return { ok: true };
  });

  r.add("GET", "/v1/keys", { summary: "Public keys for verifying entitlements (Ed25519, SPKI PEM by key id)" }, () => ({ keys: app.publicKeys, current: app.kid, ephemeral: app.ephemeralKey }));

  // ---------------------------------------------------------------- website side (session)

  r.add("GET", "/v1/device-link/:userCode", { summary: "Preview a pending link request before approving it" }, async (ctx) => {
    await app.requireUser(ctx);
    app.rateLimit(app.limits.deviceLink, `preview:${ctx.ip}`);
    const { rows } = await app.sql.query<{ device_name: string; platform: string; app_version: string; status: string; expires_at: Date; created_at: Date }>(
      "SELECT device_name, platform, app_version, status, expires_at, created_at FROM device_auth WHERE user_code = $1",
      [normalizeUserCode(ctx.params.userCode!)],
    );
    const a = rows[0];
    if (!a || a.status !== "pending" || a.expires_at <= app.now()) throw new HttpError(404, "invalid_code", "this code is invalid or expired; start linking again in the Matchframe program (Account & Hours)");
    return { deviceName: a.device_name, platform: a.platform, appVersion: a.app_version, requestedAt: a.created_at.toISOString(), expiresAt: a.expires_at.toISOString() };
  });

  r.add("POST", "/v1/device-link/approve", { body: DeviceApproveRequest, summary: "Approve a computer for an organisation" }, async (ctx) => {
    const { user } = await app.requireOrg(ctx, ctx.body.orgId, "devices.link", { verified: true });
    app.rateLimit(app.limits.deviceLink, `approve:${user.id}`);
    const code = normalizeUserCode(ctx.body.userCode);
    const st = await orgPlanState(app.sql, ctx.body.orgId, app.now());
    return app.sql.transaction(async (tx) => {
      const { rows } = await tx.query<{ install_id: string; device_name: string }>("SELECT install_id, device_name FROM device_auth WHERE user_code = $1 AND status = 'pending' AND expires_at > $2 FOR UPDATE", [code, app.now()]);
      const a = rows[0];
      if (!a) throw new HttpError(404, "invalid_code", "this code is invalid or expired; start linking again in the Matchframe program (Account & Hours)");
      const active = await tx.query<{ n: string }>("SELECT count(*) AS n FROM devices WHERE org_id = $1 AND revoked_at IS NULL AND install_id <> $2", [ctx.body.orgId, a.install_id]);
      if (Number(active.rows[0]!.n) >= st.plan.features.maxDevices) throw new HttpError(409, "device_limit", `the ${st.plan.name} plan allows ${st.plan.features.maxDevices === 1 ? "1 linked computer" : `${st.plan.features.maxDevices} linked computers`}; unlink one or upgrade`);
      await tx.query("UPDATE device_auth SET status = 'approved', org_id = $2, approved_by = $3 WHERE user_code = $1", [code, ctx.body.orgId, user.id]);
      await audit(tx, user.id, ctx.body.orgId, "device.link_approved", { deviceName: a.device_name });
      return { approved: true, deviceName: a.device_name };
    });
  });

  r.add("POST", "/v1/device-link/deny", { body: z.object({ userCode: z.string() }), summary: "Refuse a link request" }, async (ctx) => {
    const u = await app.requireUser(ctx);
    await app.sql.query("UPDATE device_auth SET status = 'denied', approved_by = $2 WHERE user_code = $1 AND status = 'pending'", [normalizeUserCode(ctx.body.userCode), u.id]);
    return { denied: true };
  });

  r.add("GET", "/v1/orgs/:orgId/devices", { summary: "Linked computers" }, async (ctx) => {
    await app.requireOrg(ctx, ctx.params.orgId!, "org.view");
    const { rows } = await app.sql.query<{ id: string; name: string; platform: string; app_version: string; created_at: Date; last_seen_at: Date | null; revoked_at: Date | null; approved_by_name: string | null }>(
      "SELECT d.id, d.name, d.platform, d.app_version, d.created_at, d.last_seen_at, d.revoked_at, u.display_name AS approved_by_name FROM devices d LEFT JOIN users u ON u.id = d.approved_by WHERE d.org_id = $1 ORDER BY d.revoked_at NULLS FIRST, d.created_at DESC",
      [ctx.params.orgId!],
    );
    return rows.map((d) => ({ id: d.id, name: d.name, platform: d.platform, appVersion: d.app_version, linkedAt: d.created_at.toISOString(), lastSeenAt: d.last_seen_at?.toISOString() ?? null, revokedAt: d.revoked_at?.toISOString() ?? null, approvedBy: d.approved_by_name }));
  });

  r.add("DELETE", "/v1/orgs/:orgId/devices/:deviceId", { summary: "Unlink a computer (its credential stops working; cached entitlements expire on schedule)" }, async (ctx) => {
    const { user } = await app.requireOrg(ctx, ctx.params.orgId!, "devices.revoke");
    const { rows } = await app.sql.query<{ id: string }>("UPDATE devices SET revoked_at = $3 WHERE id = $2 AND org_id = $1 AND revoked_at IS NULL RETURNING id", [ctx.params.orgId!, ctx.params.deviceId!, app.now()]);
    if (!rows[0]) throw new HttpError(404, "not_found", "device not found or already unlinked");
    await audit(app.sql, user.id, ctx.params.orgId!, "device.revoked", { deviceId: ctx.params.deviceId! });
    return { ok: true };
  });

  r.add("GET", "/v1/orgs/:orgId/usage", { summary: "Auto-director usage: period totals, daily and per-computer breakdown, recent sessions" }, async (ctx) => {
    await app.requireOrg(ctx, ctx.params.orgId!, "usage.view");
    const now = app.now();
    const { planState, ...allowance } = await computeAllowance(app.sql, ctx.params.orgId!, now);
    const from = ctx.query.get("from") ? new Date(ctx.query.get("from")!) : planState.periodStart;
    const to = ctx.query.get("to") ? new Date(ctx.query.get("to")!) : planState.periodEnd;
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || to <= from) throw new HttpError(400, "bad_range", "invalid from/to");
    const daily = await app.sql.query<{ day: string; seconds: string }>("SELECT to_char(date_trunc('day', started_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS day, sum(seconds) AS seconds FROM usage_records WHERE org_id = $1 AND started_at >= $2 AND started_at < $3 GROUP BY 1 ORDER BY 1", [ctx.params.orgId!, from, to]);
    const byDevice = await app.sql.query<{ device_id: string; name: string; seconds: string }>("SELECT u.device_id, d.name, sum(u.seconds) AS seconds FROM usage_records u JOIN devices d ON d.id = u.device_id WHERE u.org_id = $1 AND u.started_at >= $2 AND u.started_at < $3 GROUP BY 1, 2 ORDER BY 3 DESC", [ctx.params.orgId!, from, to]);
    const recent = await app.sql.query<{ record_id: string; device_id: string; name: string; started_at: Date; ended_at: Date; seconds: number; match_ref: string | null; map_name: string | null }>(
      "SELECT u.record_id, u.device_id, d.name, u.started_at, u.ended_at, u.seconds, u.match_ref, u.map_name FROM usage_records u JOIN devices d ON d.id = u.device_id WHERE u.org_id = $1 AND u.started_at >= $2 AND u.started_at < $3 ORDER BY u.started_at DESC LIMIT 200",
      [ctx.params.orgId!, from, to],
    );
    const rows = recent.rows.map((x) => ({ recordId: x.record_id, deviceId: x.device_id, deviceName: x.name, startedAt: x.started_at.toISOString(), endedAt: x.ended_at.toISOString(), seconds: x.seconds, matchRef: x.match_ref, mapName: x.map_name }));
    if (ctx.query.get("format") === "csv") {
      const esc = (v: unknown) => {
        const s = v === null || v === undefined ? "" : String(v);
        return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      };
      const csv = ["started_at,ended_at,seconds,computer,map,match", ...rows.map((x) => [x.startedAt, x.endedAt, x.seconds, x.deviceName, x.mapName, x.matchRef].map(esc).join(","))].join("\n") + "\n";
      return reply({ body: csv, contentType: "text/csv; charset=utf-8", headers: { "content-disposition": `attachment; filename="auto-director-usage.csv"` } });
    }
    return {
      allowance,
      range: { from: from.toISOString(), to: to.toISOString() },
      daily: daily.rows.map((d) => ({ day: d.day, seconds: Number(d.seconds) })),
      byDevice: byDevice.rows.map((d) => ({ deviceId: d.device_id, name: d.name, seconds: Number(d.seconds) })),
      sessions: rows,
    };
  });
}
