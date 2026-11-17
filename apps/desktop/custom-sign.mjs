// Custom code signing hook (ADR-076, docs/operations/code-signing.md). When the Windows workflow finds
// WIN_SIGN_COMMAND it passes this file to electron-builder as win.signtoolOptions.sign, and
// electron-builder calls it for every file it signs (the program, its helpers, the uninstaller, the
// installer). WIN_SIGN_COMMAND is a command line for a certificate authority's signing tool: {file} is
// replaced by the file's path in double quotes (added at the end when there's no {file}). The command
// runs once per file (electron-builder calls once per hash algorithm). It is never printed: it may hold
// credentials.
import { spawnSync } from "node:child_process";

/** @param {{ path: string; isNest?: boolean }} configuration */
export default async function sign(configuration) {
  if (configuration.isNest) return;
  const command = process.env.WIN_SIGN_COMMAND;
  if (!command) throw new Error("WIN_SIGN_COMMAND is not set.");
  const file = `"${configuration.path}"`;
  const line = command.includes("{file}") ? command.split("{file}").join(file) : `${command} ${file}`;
  const r = spawnSync(line, { shell: true, stdio: "inherit", windowsHide: true });
  if (r.error || r.status !== 0) throw new Error(`The signing command failed for ${configuration.path} (${r.error ? r.error.message : `exit code ${r.status}`}).`);
}
