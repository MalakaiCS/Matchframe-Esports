import { generateSigningKey } from "@matchframe/cloud-contracts/token";

/**
 * Generates an Ed25519 entitlement signing key. The private key goes into the cloud API's secret
 * environment (MF_CLOUD_SIGNING_KEY); the public key is pinned into desktop release builds through
 * config/cloud.json. Nothing is written to disk.
 */
const k = generateSigningKey();
const oneLine = (pem: string) => pem.trim().replace(/\n/g, "\\n");
process.stdout.write(
  [
    "# 1) Cloud API secret environment (keep private; never commit):",
    `MF_CLOUD_SIGNING_KEY="${oneLine(k.privateKeyPem)}"`,
    "",
    "# 2) Desktop release config/cloud.json (public; pins the key so licences from any other server are refused):",
    JSON.stringify({ url: "https://<your website>", publicKeys: { [k.kid]: k.publicKeyPem } }, null, 2),
    "",
    "# When rotating: keep the old public key in MF_CLOUD_EXTRA_PUBLIC_KEYS and in cloud.json until every",
    "# installed desktop has updated, then remove it.",
    "",
  ].join("\n"),
);
