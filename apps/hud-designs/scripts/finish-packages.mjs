// Completes dist/<hud>/ as HUD packages: manifest, thumbnail, README and licences next to each built page.
import { copyFileSync, existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const shared = [join(root, "..", "hud-template", "package-files", "LICENSE-lexogrine.txt"), join(root, "package-files", "OFL-fonts.txt")];
// `node scripts/finish-packages.mjs vector` completes one package; no argument, both.
const huds = process.argv.length > 2 ? process.argv.slice(2) : ["vector", "lineup"];
for (const hud of huds) {
  const from = join(root, "package-files", hud);
  const to = join(root, "dist", hud);
  if (!existsSync(to)) throw new Error(`dist/${hud} missing: build it first`);
  for (const name of readdirSync(from)) copyFileSync(join(from, name), join(to, name));
  for (const file of shared) copyFileSync(file, join(to, file.split(/[\\/]/).pop()));
  console.log(`HUD package written to ${to}`);
}
