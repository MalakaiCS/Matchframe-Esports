#!/usr/bin/env node
// Runs the configured Python interpreter with the worker packages on PYTHONPATH.
// Usage: node scripts/run-python.mjs <python args…>   (e.g. -m mf_common.cli --help)
import { spawnSync } from "node:child_process";
import { pythonEnv, repoRoot, resolvePython } from "./python-env.mjs";

const python = resolvePython();
const r = spawnSync(python, process.argv.slice(2), { stdio: "inherit", cwd: repoRoot, env: pythonEnv() });
if (r.error) {
  process.stderr.write(`Could not start Python (${python}): ${r.error.message}\nSet MATCHFRAME_PYTHON or create workers/.venv (see workers/README.md).\n`);
  process.exit(127);
}
process.exit(r.status ?? 1);
