// Completes dist/ as a HUD package: manifest, thumbnail, README and licences next to the built page.
import { cpSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const from = join(here, "..", "package-files");
const to = join(here, "..", "dist");
// Files and folders (third-party-licenses/) as they are.
cpSync(from, to, { recursive: true });
console.log(`HUD package written to ${to}`);
