#!/usr/bin/env node
// Writes config/cloud.json for a release build of the Matchframe program: the website's address and
// its licence public keys, read from the live website. The program then talks only to that website
// and trusts only licences signed with those keys.
//   node scripts/write-cloud-config.mjs https://matchframe.example
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
/* global AbortSignal */

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const fail = (msg) => {
  console.error(`write-cloud-config: ${msg}`);
  process.exit(1);
};
const raw = (process.argv[2] ?? process.env.MATCHFRAME_WEBSITE_URL ?? "").trim();
const url = (/^[a-z]+:\/\//i.test(raw) ? raw : `https://${raw}`).replace(/\/+$/, "");
if (!raw || !/^https:\/\/[^\s/]+/.test(url)) fail("give the website's https:// address");

const get = async (path) => {
  const res = await fetch(url + path, { signal: AbortSignal.timeout(20_000) }).catch((e) => fail(`cannot reach ${url}${path}: ${e.message}`));
  if (!res.ok) fail(`${url}${path} answered HTTP ${res.status}`);
  return res.json();
};
const health = await get("/v1/health");
if (!health.ok) fail(`${url} is not healthy: ${JSON.stringify(health)}`);
const keys = await get("/v1/keys");
if (keys.ephemeral) fail(`${url} signs licences with a temporary key (in-memory database); give it a database first`);
if (!keys.keys || Object.keys(keys.keys).length === 0) fail(`${url} published no licence keys`);
const out = join(root, "config", "cloud.json");
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify({ url, publicKeys: keys.keys }, null, 2) + "\n");
console.log(`wrote ${out}: ${url}, keys ${Object.keys(keys.keys).join(", ")} (current ${keys.current})`);
