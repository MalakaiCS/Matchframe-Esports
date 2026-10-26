import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";
import type { KeyObject } from "node:crypto";
import type { EntitlementPayload } from "./index.ts";
import { EntitlementPayload as EntitlementSchema } from "./index.ts";

/**
 * Entitlement tokens: `mfe1.<base64url(JSON payload)>.<base64url(Ed25519 signature)>`. The
 * signature covers `mfe1.<payload>`. The desktop app verifies offline against pinned public keys
 * (keyed by `kid`, so keys can rotate). Node-only module.
 */
const PREFIX = "mfe1";

const b64url = (b: Buffer) => b.toString("base64url");

export function keyId(publicKey: KeyObject | string): string {
  const k = typeof publicKey === "string" ? createPublicKey(publicKey) : publicKey;
  return createHash("sha256").update(k.export({ type: "spki", format: "der" })).digest("hex").slice(0, 16);
}

export function generateSigningKey(): { privateKeyPem: string; publicKeyPem: string; kid: string } {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
    kid: keyId(publicKey),
  };
}

export function signEntitlement(payload: EntitlementPayload, privateKeyPem: string): string {
  const body = b64url(Buffer.from(JSON.stringify(EntitlementSchema.parse(payload)), "utf8"));
  const signed = `${PREFIX}.${body}`;
  const sig = sign(null, Buffer.from(signed, "utf8"), createPrivateKey(privateKeyPem));
  return `${signed}.${b64url(sig)}`;
}

export type EntitlementCheck =
  | { ok: true; payload: EntitlementPayload; state: "valid" | "grace" }
  | { ok: false; reason: "malformed" | "unknown_key" | "bad_signature" | "expired" | "wrong_device"; payload?: EntitlementPayload };

/**
 * Verifies signature, key id and validity window. `valid` until expiresAt; `grace` (offline
 * tolerance) until graceUntil; `expired` after. Never throws.
 */
export function verifyEntitlement(token: string, publicKeys: Record<string, string>, now: Date, expectDeviceId?: string): EntitlementCheck {
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== PREFIX) return { ok: false, reason: "malformed" };
  let payload: EntitlementPayload;
  try {
    payload = EntitlementSchema.parse(JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")));
  } catch {
    return { ok: false, reason: "malformed" };
  }
  const pem = publicKeys[payload.kid];
  if (!pem) return { ok: false, reason: "unknown_key", payload };
  let good: boolean;
  try {
    good = verify(null, Buffer.from(`${parts[0]}.${parts[1]}`, "utf8"), createPublicKey(pem), Buffer.from(parts[2]!, "base64url"));
  } catch {
    good = false;
  }
  if (!good) return { ok: false, reason: "bad_signature", payload };
  if (expectDeviceId && payload.deviceId !== expectDeviceId) return { ok: false, reason: "wrong_device", payload };
  const t = now.getTime();
  if (t < Date.parse(payload.expiresAt)) return { ok: true, payload, state: "valid" };
  if (t < Date.parse(payload.graceUntil)) return { ok: true, payload, state: "grace" };
  return { ok: false, reason: "expired", payload };
}
