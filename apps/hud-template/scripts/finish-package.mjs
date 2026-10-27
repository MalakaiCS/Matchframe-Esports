// Completes dist/ as a HUD package: manifest, thumbnail, README and licences next to the built page.
import { copyFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const from = join(here, "..", "package-files");
const to = join(here, "..", "dist");
for (const name of readdirSync(from)) copyFileSync(join(from, name), join(to, name));
console.log(`HUD package written to ${to}`);
