// Packs the built plugin into a TeamSpeak 3 add-on package (.ts3_plugin: a zip with package.ini and
// plugins/<binary>) that the TeamSpeak 3 client installs with a double-click, in
// native/ts3-matchframe-plugin/dist/, next to the binaries themselves and plugin.json.
//
//   node native/ts3-matchframe-plugin/scripts/package.mjs <built binary> [<another platform's binary>...]
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const repo = join(root, "..", "..");
const { zipSync, strToU8 } = createRequire(join(repo, "services", "local-engine", "package.json"))("fflate");
const binaries = process.argv.slice(2);
if (binaries.length === 0) throw new Error("usage: package.mjs <built plugin binary>...");

const version = /project\(matchframe_comms VERSION ([0-9.]+)/.exec(readFileSync(join(root, "CMakeLists.txt"), "utf8"))[1];
const platformOf = (file) => {
  const m = /^matchframe_comms_(win64|win32|linux_amd64|linux_x86|mac)\.(dll|so|dylib)$/.exec(basename(file));
  if (!m) throw new Error(`${basename(file)}: expected matchframe_comms_<platform>.<dll|so|dylib>`);
  return m[1];
};
const platforms = binaries.map(platformOf);
const ini = [
  "Name = Matchframe Team Comms",
  "Type = Plugin",
  "Author = Matchframe Esports",
  `Version = ${version}`,
  `Platforms = ${platforms.join(", ")}`,
  'Description = "Sends each team member\'s voice, separately, to Matchframe Esports on this computer for a delayed broadcast and recording. Only the tabs Matchframe manages are captured; their microphones stay off and their sound is not played here."',
  "",
].join("\r\n");

const out = join(root, "dist");
mkdirSync(out, { recursive: true });
const files = { "package.ini": strToU8(ini) };
for (const b of binaries) files[`plugins/${basename(b)}`] = new Uint8Array(readFileSync(b));
const pkg = join(out, "matchframe-team-comms.ts3_plugin");
writeFileSync(pkg, zipSync(files, { level: 9 }));
const sha = (f) => createHash("sha256").update(readFileSync(f)).digest("hex");
const entries = [{ file: basename(pkg), sha256: sha(pkg) }];
for (const b of binaries) {
  copyFileSync(b, join(out, basename(b)));
  entries.push({ file: basename(b), platform: platformOf(b), sha256: sha(b) });
}
const sdk = JSON.parse(readFileSync(join(root, "sdk.json"), "utf8"));
writeFileSync(join(out, "plugin.json"), JSON.stringify({ built: true, version, pluginApi: sdk.pluginApi, sdkCommit: sdk.commit, files: entries }, null, 2));
console.log(`TeamSpeak plugin ${version} (${platforms.join(", ")}) packed: ${pkg}`);
