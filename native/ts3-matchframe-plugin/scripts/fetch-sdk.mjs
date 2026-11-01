// Downloads the TeamSpeak 3 Client Plugin SDK headers the plugin is built against (sdk.json: the
// official repository at a pinned commit) into native/ts3-matchframe-plugin/.sdk/, and checks each
// file's SHA-256. The headers are TeamSpeak's (all rights reserved) and are never committed.
//
//   node native/ts3-matchframe-plugin/scripts/fetch-sdk.mjs [--from <local checkout of the SDK>]
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const sdk = JSON.parse(readFileSync(join(root, "sdk.json"), "utf8"));
const out = join(root, ".sdk");
const fromArg = process.argv.indexOf("--from");
const from = fromArg > 0 ? process.argv[fromArg + 1] : null;

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");
const base = `https://raw.githubusercontent.com/${sdk.repository.replace("https://github.com/", "")}/${sdk.commit}/`;

let fetched = 0;
for (const [file, hash] of Object.entries(sdk.files)) {
  const dest = join(out, file);
  if (existsSync(dest) && sha256(readFileSync(dest)) === hash) continue;
  let body;
  if (from) body = readFileSync(join(from, file));
  else {
    const r = await fetch(base + file);
    if (!r.ok) throw new Error(`${file}: HTTP ${r.status} from ${base + file}`);
    body = Buffer.from(await r.arrayBuffer());
  }
  const got = sha256(body);
  if (got !== hash) throw new Error(`${file}: SHA-256 ${got}, expected ${hash} (commit ${sdk.commit})`);
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, body);
  fetched++;
}
console.log(`TeamSpeak plugin SDK headers (API ${sdk.pluginApi}, ${sdk.commit.slice(0, 7)}): ${fetched} fetched, all checked, in ${join(out, "include")}`);
