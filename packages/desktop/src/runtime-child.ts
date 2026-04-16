/**
 * RuntimeChildManager — launches the Kanban CLI as a subprocess.
 *
 * Flow:
 *   1. Spawn `kanban --no-open --port <port> --host <host>`
 *   2. Poll the runtime HTTP endpoint until reachable
 *   3. Resolve `start()` with the runtime URL
 *   4. On shutdown: SIGTERM → force-kill after timeout
 *
 * Deliberately does NOT:
 * - No in-process runtime imports — the CLI subprocess is a separate process.
 * - No IPC messages — lifecycle is managed via process signals.
 * - No auto-restart — on crash the manager emits "crashed" and stops.
 *   The main process decides whether to show a disconnected screen or
 *   offer a manual restart button.
 * - No window management — no knowledge of BrowserWindows.
 *
 * Environment forwarding:
 * - The child inherits filtered env plus KANBAN_DESKTOP=1.
 * - PATH is enriched with common tool directories that macOS/Linux/Windows
 *   GUI apps miss (Homebrew, npm global, etc.) — see AGENTS.md on why
 *   we avoid interactive shell launches.
 * - Node heap is set to 4096 MB via NODE_OPTIONS to give the runtime
 *   sufficient headroom for multi-agent workloads.
 */

import { type ChildProcess, execSync, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import http from "node:http";
import path, { join } from "node:path";

import type { RuntimeChildConfig } from "./runtime-child-config.js";

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

export interface RuntimeChildManagerEvents {
	ready: (url: string) => void;
	error: (message: string) => void;
	/**
	 * Emitted when the subprocess exits without a prior `shutdown()` call.
	 * The `stderrTail` argument is the last ~8 KB of what the child wrote
	 * to stderr, useful for surfacing startup failures.
	 */
	crashed: (exitCode: number | null, signal: string | null, stderrTail: string) => void;
}

export interface RuntimeChildManagerOptions {
	/** Path to the Kanban CLI binary (e.g. `Resources/bin/kanban`). */
	cliPath: string;
	/** Timeout in ms to wait for graceful shutdown before force-killing. Default: 5 000. */
	shutdownTimeoutMs?: number;
	/** Interval in ms between HTTP health-check polls. Default: 200. */
	pollIntervalMs?: number;
	/** Timeout in ms to wait for the runtime to become reachable. Default: 30 000. */
	startupTimeoutMs?: number;
	/**
	 * V8 `--max-old-space-size` for the child process, in MB. Default: 4 096.
	 * The runtime hosts all agent sessions, message repositories, and PTY
	 * processes in one Node process, so generous headroom matters for
	 * multi-agent workloads. Lower this only if you know the machine is
	 * memory-constrained.
	 */
	maxOldSpaceMb?: number;
	/**
	 * Override for `child_process.spawn` — used in tests to inject a mock.
	 * Must match the signature of `child_process.spawn`.
	 */
	spawnFn?: typeof spawn;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

/** Default V8 heap limit in MB for the runtime child process. */
const DEFAULT_MAX_OLD_SPACE_MB = 4096;

/**
 * Maximum bytes of stderr retained for crash diagnostics. Kept small because
 * the buffer lives for the lifetime of the subprocess and is handed to the
 * `crashed` listener on exit.
 */
const STDERR_TAIL_MAX_BYTES = 8192;

// ---------------------------------------------------------------------------
// Allowed environment variables forwarded to the child process.
// ---------------------------------------------------------------------------

const ALLOWED_ENV_KEYS: ReadonlySet<string> = new Set([
	"PATH",
	"PATHEXT",
	"HOME",
	"USERPROFILE",
	"HOMEDRIVE",
	"HOMEPATH",
	"SYSTEMROOT",
	"COMSPEC",
	"TMPDIR",
	"TEMP",
	"TMP",
	"LANG",
	"LC_ALL",
	"LC_CTYPE",
	"NODE_ENV",
	"SHELL",
	"TERM",
	"APPDATA",
	"LOCALAPPDATA",
	"PROGRAMFILES",
	"ProgramFiles(x86)",
	"ProgramData",
	"SYSTEMDRIVE",
	"XDG_RUNTIME_DIR",
	"XDG_CONFIG_HOME",
	"XDG_DATA_HOME",
]);

/** Prefixes that are always forwarded to the runtime child. */
const ALLOWED_ENV_PREFIXES: readonly string[] = [
	"KANBAN_",
	"ANTHROPIC_",
	"OPENAI_",
	"OPENROUTER_",
	"GOOGLE_",
	"GEMINI_",
	"AWS_",
	"AZURE_",
	"MISTRAL_",
	"DEEPSEEK_",
	"GROQ_",
	"XAI_",
	"FIREWORKS_",
	"TOGETHER_",
	"COHERE_",
	"PERPLEXITY_",
	"CEREBRAS_",
	"OCA_",
	"CLINE_",
];

/**
 * Build extra PATH directories for Windows.
 *
 * Windows GUI apps inherit the system PATH, but common developer tool
 * install locations (npm global, Node.js user install, Git for Windows)
 * may not be present. We add well-known directories so agent shell
 * sessions can find binaries like `kanban`, `git`, `node`, etc.
 */
function getWindowsExtraPathDirs(): string[] {
	const dirs: string[] = [];
	const localAppData = process.env.LOCALAPPDATA;
	const appData = process.env.APPDATA;
	const programFiles = process.env.ProgramFiles;
	const programFilesX86 = process.env["ProgramFiles(x86)"];
	// npm global installs
	if (appData) dirs.push(join(appData, "npm"));
	// Node.js user install
	if (localAppData) dirs.push(join(localAppData, "Programs", "nodejs"));
	// Scoop (common Windows package manager)
	if (localAppData) dirs.push(join(localAppData, "Microsoft", "WinGet", "Packages"));
	// Git for Windows
	if (programFiles) dirs.push(join(programFiles, "Git", "cmd"));
	if (programFilesX86) dirs.push(join(programFilesX86, "Git", "cmd"));
	return dirs.filter(Boolean);
}

/**
 * Standard PATH directories to add when running as a desktop GUI app.
 *
 * macOS GUI apps inherit the system PATH from launchd, which typically only
 * includes /usr/bin:/bin:/usr/sbin:/sbin. This misses Homebrew, nvm, and
 * other user-installed tool directories. We append common locations so
 * agent shell sessions can find binaries like `kanban`, `git`, `node`, etc.
 */
const EXTRA_PATH_DIRS: readonly string[] =
	process.platform === "darwin"
		? [
				"/opt/homebrew/bin",
				"/opt/homebrew/sbin",
				"/usr/local/bin",
				"/usr/local/sbin",
				"/usr/bin",
				"/bin",
				"/usr/sbin",
				"/sbin",
			]
		: process.platform === "linux"
			? ["/usr/local/bin", "/snap/bin", "/usr/bin", "/bin"]
			: process.platform === "win32"
				? getWindowsExtraPathDirs()
				: [];

/** Build a filtered copy of `process.env` containing only allowed keys. */
export function buildFilteredEnv(): NodeJS.ProcessEnv {
	const filtered: NodeJS.ProcessEnv = {};

	// Forward exact-match allowed keys.
	for (const key of ALLOWED_ENV_KEYS) {
		if (process.env[key] !== undefined) {
			filtered[key] = process.env[key];
		}
	}

	// Forward keys matching allowed prefixes (provider API keys, KANBAN_*, etc.).
	for (const key of Object.keys(process.env)) {
		if (filtered[key] !== undefined) continue;
		for (const prefix of ALLOWED_ENV_PREFIXES) {
			if (key.startsWith(prefix)) {
				filtered[key] = process.env[key];
				break;
			}
		}
	}

	// Enrich PATH with common directories that macOS GUI apps miss.
	if (EXTRA_PATH_DIRS.length > 0) {
		const currentPath = filtered.PATH ?? "";
		const pathParts = new Set(currentPath.split(path.delimiter).filter(Boolean));
		for (const dir of EXTRA_PATH_DIRS) {
			pathParts.add(dir);
		}
		filtered.PATH = [...pathParts].join(path.delimiter);
	}

	return filtered;
}

/**
 * Resolve the CLI path for production builds.
 * Swaps `app.asar` → `app.asar.unpacked` so spawn() can access the file.
 */
export function resolveCliPath(rawPath: string): string {
	return rawPath.replace(
		`${path.sep}app.asar${path.sep}`,
		`${path.sep}app.asar.unpacked${path.sep}`,
	);
}

/** Kill a process tree. Uses `taskkill /T /F` on Windows. */
function treeKill(pid: number, signal: NodeJS.Signals = "SIGTERM"): void {
	if (process.platform === "win32") {
		try {
			execSync(`taskkill /T /F /PID ${pid}`, { stdio: "ignore" });
		} catch {
			/* process may already be dead */
		}
	} else {
		try {
			process.kill(pid, signal);
		} catch {
			/* ESRCH — already exited */
		}
	}
}

// ---------------------------------------------------------------------------
// Health check — poll until the runtime HTTP server responds
// ---------------------------------------------------------------------------

/**
 * Poll an HTTP endpoint until it returns a successful response.
 * Resolves when the server is reachable, rejects on timeout.
 */
function waitForReady(
	host: string,
	port: number,
	pollIntervalMs: number,
	timeoutMs: number,
	signal: AbortSignal,
): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		const deadline = Date.now() + timeoutMs;

		const check = () => {
			if (signal.aborted) {
				reject(new Error("Health check aborted"));
				return;
			}
			if (Date.now() > deadline) {
				reject(new Error(`Runtime did not become reachable within ${timeoutMs}ms`));
				return;
			}

			const req = http.get({ host, port, path: "/", timeout: 2_000 }, (res) => {
				// Any response means the server is up — consume the body.
				res.resume();
				resolve();
			});
			req.on("error", () => {
				// Connection refused, socket hang up, etc. — retry after interval.
				setTimeout(check, pollIntervalMs);
			});
			req.on("timeout", () => {
				req.destroy();
				setTimeout(check, pollIntervalMs);
			});
		};

		check();
	});
}

// ---------------------------------------------------------------------------
// RuntimeChildManager
// ---------------------------------------------------------------------------

/**
 * Typed event overloads via declaration merging. Zero runtime cost; gives
 * `on` / `once` / `off` / `emit` proper signatures for
 * {@link RuntimeChildManagerEvents} without needing a third-party typed
 * emitter package.
 */
export interface RuntimeChildManager {
	on<E extends keyof RuntimeChildManagerEvents>(
		event: E,
		listener: RuntimeChildManagerEvents[E],
	): this;
	once<E extends keyof RuntimeChildManagerEvents>(
		event: E,
		listener: RuntimeChildManagerEvents[E],
	): this;
	off<E extends keyof RuntimeChildManagerEvents>(
		event: E,
		listener: RuntimeChildManagerEvents[E],
	): this;
	emit<E extends keyof RuntimeChildManagerEvents>(
		event: E,
		...args: Parameters<RuntimeChildManagerEvents[E]>
	): boolean;
}

export class RuntimeChildManager extends EventEmitter {
	private readonly opts: {
		cliPath: string;
		shutdownTimeoutMs: number;
		pollIntervalMs: number;
		startupTimeoutMs: number;
		maxOldSpaceMb: number;
		spawnFn: typeof spawn;
	};

	private child: ChildProcess | null = null;
	private shutdownRequested = false;
	private disposed = false;
	private abortController: AbortController | null = null;

	constructor(options: RuntimeChildManagerOptions) {
		super();
		this.opts = {
			cliPath: options.cliPath,
			shutdownTimeoutMs: options.shutdownTimeoutMs ?? 5_000,
			pollIntervalMs: options.pollIntervalMs ?? 200,
			startupTimeoutMs: options.startupTimeoutMs ?? 30_000,
			maxOldSpaceMb: options.maxOldSpaceMb ?? DEFAULT_MAX_OLD_SPACE_MB,
			spawnFn: options.spawnFn ?? spawn,
		};
	}

	/** Start the CLI subprocess. Resolves with the runtime URL when reachable. */
	async start(config: RuntimeChildConfig): Promise<string> {
		if (this.disposed) throw new Error("RuntimeChildManager has been disposed");
		if (this.child) throw new Error("Child process is already running");
		this.shutdownRequested = false;
		return this.spawnChild(config);
	}

	/** Graceful shutdown via SIGTERM; force-kills after shutdownTimeoutMs. */
	async shutdown(): Promise<void> {
		if (!this.child) return;
		this.shutdownRequested = true;

		// Abort any pending health check.
		this.abortController?.abort();

		return new Promise<void>((resolve) => {
			const forceTimer = setTimeout(() => {
				this.forceKill();
				resolve();
			}, this.opts.shutdownTimeoutMs);

			if (this.child) {
				this.child.once("exit", () => {
					clearTimeout(forceTimer);
					resolve();
				});
			}

			// Send SIGTERM to the child process tree.
			const pid = this.child?.pid;
			if (pid !== undefined) {
				treeKill(pid, "SIGTERM");
			}
		});
	}

	/** Dispose: kill child and prevent further use. */
	async dispose(): Promise<void> {
		this.disposed = true;
		await this.shutdown();
		this.removeAllListeners();
	}

	/** Whether a child process is currently running. */
	get running(): boolean {
		return this.child !== null;
	}

	/** PID of the child process, or `null` if not running. */
	get pid(): number | null {
		return this.child?.pid ?? null;
	}

	// -- Internals ----------------------------------------------------------

	private async spawnChild(config: RuntimeChildConfig): Promise<string> {
		const cliPath = resolveCliPath(this.opts.cliPath);
		const url = `http://${config.host}:${config.port}`;

		const env = buildFilteredEnv();
		env.KANBAN_DESKTOP = "1";

		// Set heap limit via NODE_OPTIONS.
		const existingNodeOpts = env.NODE_OPTIONS ?? "";
		env.NODE_OPTIONS = `${existingNodeOpts} --max-old-space-size=${this.opts.maxOldSpaceMb}`.trim();

		const args = [
			"--no-open",
			"--port",
			String(config.port),
			"--host",
			config.host,
		];

		const child = this.opts.spawnFn(cliPath, args, {
			stdio: ["ignore", "pipe", "pipe"],
			env,
			// Detach on Windows so treeKill can reach grandchildren.
			detached: process.platform === "win32",
		});
		this.child = child;

		// Drain stdout so the child doesn't block on a full OS pipe buffer.
		child.stdout?.on("data", () => {});

		// Keep a rolling tail of stderr for crash diagnostics. Without this
		// the `crashed` event carries no information about WHY the CLI
		// subprocess died — which is the single most common question during
		// dogfooding of a new build.
		let stderrTail = "";
		child.stderr?.on("data", (chunk: Buffer) => {
			stderrTail += chunk.toString("utf8");
			if (stderrTail.length > STDERR_TAIL_MAX_BYTES) {
				stderrTail = stderrTail.slice(-STDERR_TAIL_MAX_BYTES);
			}
		});

		child.on("exit", (code, signal) => {
			this.child = null;
			if (!this.shutdownRequested) {
				this.emit("crashed", code, signal, stderrTail);
			}
		});

		child.on("error", (err) => {
			this.child = null;
			this.emit("error", err.message);
		});

		// Poll until the runtime HTTP server is reachable.
		this.abortController = new AbortController();
		try {
			await waitForReady(
				config.host,
				config.port,
				this.opts.pollIntervalMs,
				this.opts.startupTimeoutMs,
				this.abortController.signal,
			);
		} catch (error) {
			// If the child exited before becoming reachable, clean up.
			if (this.child) {
				this.forceKill();
			}
			throw error;
		}

		this.emit("ready", url);
		return url;
	}

	// -- Force-kill ---------------------------------------------------------

	private forceKill(): void {
		if (!this.child) return;
		const pid = this.child.pid;
		if (pid !== undefined) treeKill(pid, "SIGKILL");
		try {
			this.child.kill("SIGKILL");
		} catch {
			/* already dead */
		}
	}
}
