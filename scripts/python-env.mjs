// Shared resolution of the Python interpreter and worker module path for the offline pipeline.
import { existsSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const workersDir = join(repoRoot, "workers");
export const workerPackageDirs = ["common", "demo-parser", "features", "training", "evaluation"].map((d) => join(workersDir, d));

/** MATCHFRAME_PYTHON, then workers/.venv, then python3/python on PATH. */
export function resolvePython() {
  if (process.env.MATCHFRAME_PYTHON) return process.env.MATCHFRAME_PYTHON;
  const venv = process.platform === "win32" ? join(workersDir, ".venv", "Scripts", "python.exe") : join(workersDir, ".venv", "bin", "python");
  if (existsSync(venv)) return venv;
  return process.platform === "win32" ? "python" : "python3";
}

export function pythonEnv() {
  const existing = process.env.PYTHONPATH ? [process.env.PYTHONPATH] : [];
  return { ...process.env, PYTHONPATH: [...workerPackageDirs, ...existing].join(delimiter), PYTHONUNBUFFERED: "1" };
}
