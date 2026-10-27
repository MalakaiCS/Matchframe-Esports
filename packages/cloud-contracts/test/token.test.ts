import { describe, expect, it } from "vitest";
import type { EntitlementPayload } from "../src/index.ts";
import { generateSigningKey, keyId, signEntitlement, verifyEntitlement } from "../src/token.ts";

function payload(kid: string, over: Partial<EntitlementPayload> = {}): EntitlementPayload {
  return {
    v: 1,
    iss: "https://cloud.test",
    kid,
    orgId: "org_1",
    orgName: "Test Org",
    deviceId: "dev_1",
    plan: { id: "pro", name: "Pro" },
    subscriptionStatus: "active",
    features: { autoDirector: true, learnedDirectorShadow: true, maxDevices: 3, maxMembers: 5 },
    autoDirector: { periodStart: "2026-10-01T00:00:00.000Z", periodEnd: "2026-11-01T00:00:00.000Z", includedSeconds: 144000, creditSeconds: 0, usedSeconds: 3600, remainingSeconds: 140400, overageAllowed: false },
    issuedAt: "2026-10-26T10:00:00.000Z",
    expiresAt: "2026-10-27T10:00:00.000Z",
    graceUntil: "2026-11-02T10:00:00.000Z",
    ...over,
  };
}

describe("entitlement tokens", () => {
  const key = generateSigningKey();
  const keys = { [key.kid]: key.publicKeyPem };

  it("signs and verifies, with valid → grace → expired windows", () => {
    expect(keyId(key.publicKeyPem)).toBe(key.kid);
    const token = signEntitlement(payload(key.kid), key.privateKeyPem);
    expect(token.startsWith("mfe1.")).toBe(true);
    const v = verifyEntitlement(token, keys, new Date("2026-10-26T12:00:00Z"), "dev_1");
    expect(v.ok && v.state).toBe("valid");
    const g = verifyEntitlement(token, keys, new Date("2026-10-30T12:00:00Z"));
    expect(g.ok && g.state).toBe("grace");
    expect(verifyEntitlement(token, keys, new Date("2026-11-03T00:00:00Z"))).toMatchObject({ ok: false, reason: "expired" });
  });

  it("rejects tampering, unknown keys, other devices and garbage", () => {
    const token = signEntitlement(payload(key.kid), key.privateKeyPem);
    const [p, body, sig] = token.split(".");
    const forged = JSON.parse(Buffer.from(body!, "base64url").toString());
    forged.autoDirector.remainingSeconds = 999999999;
    const tampered = `${p}.${Buffer.from(JSON.stringify(forged)).toString("base64url")}.${sig}`;
    expect(verifyEntitlement(tampered, keys, new Date("2026-10-26T12:00:00Z"))).toMatchObject({ ok: false, reason: "bad_signature" });
    const other = generateSigningKey();
    const foreign = signEntitlement(payload(other.kid), other.privateKeyPem);
    expect(verifyEntitlement(foreign, keys, new Date("2026-10-26T12:00:00Z"))).toMatchObject({ ok: false, reason: "unknown_key" });
    expect(verifyEntitlement(token, keys, new Date("2026-10-26T12:00:00Z"), "dev_2")).toMatchObject({ ok: false, reason: "wrong_device" });
    expect(verifyEntitlement("not.a.token", keys, new Date())).toMatchObject({ ok: false, reason: "malformed" });
  });
});
