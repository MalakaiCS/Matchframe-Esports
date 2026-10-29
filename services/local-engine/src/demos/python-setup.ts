import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { SettingsRepo } from "../db/store.ts";
import type { Logger } from "../logger.ts";

const SETTINGS_KEY = "workers.python";
/** Pythons tried for the environment, in order (`py -3` is the Windows launcher). */
const CANDIDATES: readonly (readonly string[])[] = process.platform === "win32" ? [["py", "-3"], ["python"], ["python3"]] : [["python3"], ["python"]];
const INSTALL_TIMEOUT_MS = 30 * 60_000;

export interface PythonSetupStatus {
  state: "idle" | "running" | "done" | "failed";
  step: string | null;
  log: string[];
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
}

/** Runs a command; resolves with its exit code and output (last 64 kB). */
export type CommandRunner = (cmd: string, args: string[], onLine: (line: string) => void, timeoutMs: number) => Promise<{ code: number | null; output: string }>;

const runCommand: CommandRunner = (cmd, args, onLine, timeoutMs) =>
  new Promise((resolve) => {
    let output = "";
    let buf = "";
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    const timer = setTimeout(() => child.kill(), timeoutMs);
    const take = (d: Buffer) => {
      const text = d.toString("utf8");
      output = (output + text).slice(-65536);
      buf += text;
      const lines = buf.split(/\r?\n/);
      buf = lines.pop() ?? "";
      for (const l of lines) if (l.trim()) onLine(l);
    };
    child.stdout.on("data", take);
    child.stderr.on("data", take);
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ code: null, output: String(e) });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, output });
    });
  });

/**
 * The Python that runs the demo pipeline: chosen by hand, from MATCHFRAME_PYTHON, or the program's
 * own environment in the data folder, which "Set up" makes: it finds Python 3.11+ on this computer,
 * creates a virtual environment there and installs the pipeline's packages into it (nothing is
 * installed into the computer's own Python).
 */
export class PythonSetup {
  private st: PythonSetupStatus = { state: "idle", step: null, log: [], startedAt: null, finishedAt: null, error: null };

  constructor(
    private readonly deps: {
      settings: SettingsRepo;
      logger: Logger;
      dataDir: string;
      workersDir: string | null;
      fromEnv: string | null;
      run?: CommandRunner;
    },
  ) {}

  get envDir(): string {
    return join(this.deps.dataDir, "python-env");
  }

  get envPython(): string {
    return process.platform === "win32" ? join(this.envDir, "Scripts", "python.exe") : join(this.envDir, "bin", "python");
  }

  /** The interpreter in use: chosen by hand, else MATCHFRAME_PYTHON, else the program's environment if set up. */
  interpreter(): string | null {
    const chosen = this.deps.settings.get<string | null>(SETTINGS_KEY, null);
    if (chosen) return chosen;
    if (this.deps.fromEnv) return this.deps.fromEnv;
    return existsSync(this.envPython) ? this.envPython : null;
  }

  choose(path: string | null): void {
    this.deps.settings.set(SETTINGS_KEY, path && path.trim() ? path.trim() : null);
  }

  status(): PythonSetupStatus {
    return { ...this.st, log: [...this.st.log] };
  }

  /** The packages in workers/pyproject.toml's `dependencies`. */
  requirements(): string[] {
    const file = this.deps.workersDir ? join(this.deps.workersDir, "pyproject.toml") : null;
    if (!file || !existsSync(file)) return [];
    const m = /^dependencies\s*=\s*\[([\s\S]*?)\]/m.exec(readFileSync(file, "utf8"));
    return m ? [...m[1]!.matchAll(/"([^"]+)"/g)].map((x) => x[1]!) : [];
  }

  private line(l: string): void {
    this.st.log.push(l.slice(0, 300));
    if (this.st.log.length > 60) this.st.log.splice(0, this.st.log.length - 60);
  }

  /** Starts the setup in the background (returns at once). */
  start(): PythonSetupStatus {
    if (this.st.state === "running") return this.status();
    this.st = { state: "running", step: "Looking for Python", log: [], startedAt: new Date().toISOString(), finishedAt: null, error: null };
    void this.setup().then(
      () => {
        this.st.state = "done";
        this.st.step = "Ready";
        this.st.finishedAt = new Date().toISOString();
        this.deps.logger.info("python environment set up for the demo pipeline", { python: this.envPython });
      },
      (e: unknown) => {
        this.st.state = "failed";
        this.st.error = e instanceof Error ? e.message : String(e);
        this.st.finishedAt = new Date().toISOString();
        this.deps.logger.warn("python setup failed", { error: this.st.error });
      },
    );
    return this.status();
  }

  private async setup(): Promise<void> {
    const run = this.deps.run ?? runCommand;
    const reqs = this.requirements();
    if (!reqs.length) throw new Error("the pipeline's package list (workers/pyproject.toml) was not found");
    let base: readonly string[] | null = null;
    for (const c of CANDIDATES) {
      const r = await run(c[0]!, [...c.slice(1), "-c", "import sys; print('ok' if sys.version_info >= (3, 11) else 'old', sys.version.split()[0])"], () => undefined, 30_000);
      const out = r.output.trim();
      if (r.code === 0 && out.startsWith("ok")) {
        base = c;
        this.line(`Found Python ${out.slice(3)} (${c.join(" ")})`);
        break;
      }
      if (r.code === 0 && out.startsWith("old")) this.line(`${c.join(" ")} is Python ${out.slice(4)}; 3.11 or newer is needed`);
    }
    if (!base) throw new Error("Python 3.11 or newer was not found on this computer. Install it from python.org (tick \"Add python.exe to PATH\"), then press Set up again.");
    this.st.step = "Creating the environment";
    const venv = await run(base[0]!, [...base.slice(1), "-m", "venv", this.envDir], (l) => this.line(l), 5 * 60_000);
    if (venv.code !== 0 || !existsSync(this.envPython)) throw new Error(`could not create the environment: ${venv.output.trim().split("\n").slice(-2).join(" ")}`);
    this.st.step = "Installing packages (a few minutes)";
    const pip = await run(this.envPython, ["-m", "pip", "install", "--disable-pip-version-check", "--no-input", ...reqs], (l) => this.line(l), INSTALL_TIMEOUT_MS);
    if (pip.code !== 0) throw new Error(`installing the packages failed: ${pip.output.trim().split("\n").slice(-2).join(" ")}`);
    this.choose(null);
  }
}
