import { createHash, randomBytes, randomUUID } from "node:crypto";

export const newId = (prefix: string) => `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 20)}`;

/** Opaque secret for cookies/links/device credentials; only its SHA-256 is stored. */
export const newSecret = (bytes = 32) => randomBytes(bytes).toString("base64url");
export const hashSecret = (s: string) => createHash("sha256").update(s).digest("hex");

/** Human-typable device link code from an alphabet without vowels or look-alikes: XXXX-XXXX. */
const CODE_ALPHABET = "BCDFGHJKLMNPQRSTVWXZ";
export function newUserCode(): string {
  const b = randomBytes(8);
  let out = "";
  for (let i = 0; i < 8; i++) out += CODE_ALPHABET[b[i]! % CODE_ALPHABET.length];
  return `${out.slice(0, 4)}-${out.slice(4)}`;
}
export const normalizeUserCode = (c: string) => {
  const s = c.toUpperCase().replace(/[^A-Z]/g, "");
  return s.length === 8 ? `${s.slice(0, 4)}-${s.slice(4)}` : s;
};
