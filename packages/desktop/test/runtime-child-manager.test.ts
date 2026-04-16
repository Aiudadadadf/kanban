import { type ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import http from "node:http";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	RuntimeChildManager,
	buildFilteredEnv,
	resolveCliPath,
} from "../src/runtime-child.js";

// ---------------------------------------------------------------------------
// Mock http.get so health checks resolve immediately in unit tests
// ---------------------------------------------------------------------------

vi.mock("node:http", async () => {
	const actual = await vi.importActual<typeof import("node:http")>("node:http");
	return {
		...actual,
		default: {
			...actual,
			get: vi.fn((_opts: unknown, cb: (res: { resume: () => void }) => void) => {
				cb({ resume: () => {} });
				const req = new EventEmitter();
				return req;
			}),
		},
	};
});

// ---------------------------------------------------------------------------
// Mock ChildProcess factory
// ---------------------------------------------------------------------------

interface MockChild extends EventEmitter {
	pid: number;
	connected: boolean;
	killed: boolean;
	kill: ReturnType<typeof vi.fn>;
	stdout: EventEmitter | null;
	stderr: EventEmitter | null;
	/** Simulate the child process exiting. */
	simulateExit(code: number | null, signal: string | null): void;
}

function createMockChild(pid = 12345): MockChild {
	const child = new EventEmitter() as MockChild;
	child.pid = pid;
	child.connected = true;
	child.killed = false;
	child.kill = vi.fn(() => {
		child.killed = true;
		child.connected = false;
	});
	child.stdout = new EventEmitter();
	child.stderr = new EventEmitter();
	child.simulateExit = (code, signal) => {
		child.connected = false;
		child.emit("exit", code, signal);
	};
	return child;
}

/** Creates a spawnFn mock that returns the given mock child. */
function createSpawnFn(child: MockChild) {
	return vi.fn(() => child) as unknown as typeof spawn;
}

// ---------------------------------------------------------------------------
// Default test config
// ---------------------------------------------------------------------------

const TEST_CONFIG = {
	host: "127.0.0.1" as const,
	port: 3484,
};

const CLI_PATH = "/path/to/kanban";

// ---------------------------------------------------------------------------
// buildFilteredEnv
// ---------------------------------------------------------------------------

describe("buildFilteredEnv", () => {
	it("includes only allowed environment variables", () => {
		const original = { ...process.env };
		try {
			process.env.PATH = "/usr/bin";
			process.env.HOME = "/home/user";
			process.env.KANBAN_RUNTIME_PORT = "3484";
			process.env.SECRET_KEY = "should-not-appear";
			process.env.OCA_API_KEY = "oca-provider-key";
			process.env.ELECTRON_RUN_AS_NODE = "1";

			const env = buildFilteredEnv();
			const pathEntries = env.PATH?.split(":") ?? [];
			expect(pathEntries).toContain("/usr/bin");
			if (process.platform === "darwin") {
				expect(pathEntries).toEqual(
					expect.arrayContaining([
						"/opt/homebrew/bin",
						"/opt/homebrew/sbin",
						"/usr/local/bin",
						"/usr/local/sbin",
					]),
				);
			}
			if (process.platform === "linux") {
				expect(pathEntries).toEqual(
					expect.arrayContaining(["/usr/local/bin", "/snap/bin"]),
				);
			}
			expect(env.HOME).toBe("/home/user");
			expect(env.KANBAN_RUNTIME_PORT).toBe("3484");
			expect(env.OCA_API_KEY).toBe("oca-provider-key");
			expect(env.SECRET_KEY).toBeUndefined();
			expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined();
		} finally {
			process.env = original;
		}
	});

	it("omits keys that are not set in process.env", () => {
		const original = { ...process.env };
		try {
			delete process.env.XDG_RUNTIME_DIR;
			const env = buildFilteredEnv();
			expect(env.XDG_RUNTIME_DIR).toBeUndefined();
		} finally {
			process.env = original;
		}
	});
});

// ---------------------------------------------------------------------------
// resolveCliPath
// ---------------------------------------------------------------------------

describe("resolveCliPath", () => {
	it("replaces app.asar with app.asar.unpacked", () => {
		const input = `/foo${path.sep}app.asar${path.sep}bin${path.sep}kanban`;
		const result = resolveCliPath(input);
		expect(result).toBe(
			`/foo${path.sep}app.asar.unpacked${path.sep}bin${path.sep}kanban`,
		);
	});

	it("returns path unchanged when app.asar is not present", () => {
		const input = "/foo/bar/bin/kanban";
		expect(resolveCliPath(input)).toBe(input);
	});
});

// ---------------------------------------------------------------------------
// RuntimeChildManager
// ---------------------------------------------------------------------------

describe("RuntimeChildManager", () => {
	let mockChild: MockChild;
	let manager: RuntimeChildManager;

	beforeEach(() => {
		vi.useFakeTimers();
		mockChild = createMockChild();
	});

	afterEach(async () => {
		vi.useRealTimers();
	});

	function createManager(overrides: Record<string, unknown> = {}) {
		return new RuntimeChildManager({
			cliPath: CLI_PATH,
			spawnFn: createSpawnFn(mockChild),
			shutdownTimeoutMs: 5_000,
			...overrides,
		});
	}

	// -----------------------------------------------------------------------
	// Construction
	// -----------------------------------------------------------------------

	it("can be constructed with required options", () => {
		manager = createManager();
		expect(manager).toBeInstanceOf(RuntimeChildManager);
		expect(manager.running).toBe(false);
	});

	// -----------------------------------------------------------------------
	// start()
	// -----------------------------------------------------------------------

	describe("start()", () => {
		it("spawns the CLI and resolves with URL when reachable", async () => {
			const spawnSpy = createSpawnFn(mockChild);
			manager = new RuntimeChildManager({
				cliPath: CLI_PATH,
				spawnFn: spawnSpy,
			});

			const url = await manager.start(TEST_CONFIG);

			expect(url).toBe("http://127.0.0.1:3484");
			expect(manager.running).toBe(true);

			// Verify spawn was called with correct args
			const spawnCall = (spawnSpy as ReturnType<typeof vi.fn>).mock.calls[0];
			expect(spawnCall[0]).toContain("kanban");
			const args = spawnCall[1] as string[];
			expect(args).toContain("--no-open");
			expect(args).toContain("--port");
			expect(args).toContain("3484");
			expect(args).toContain("--host");
			expect(args).toContain("127.0.0.1");
		});

		it("emits 'ready' event with the URL", async () => {
			manager = createManager();
			const readyHandler = vi.fn();
			manager.on("ready", readyHandler);

			await manager.start(TEST_CONFIG);

			expect(readyHandler).toHaveBeenCalledWith("http://127.0.0.1:3484");
		});

		it("throws if already running", async () => {
			manager = createManager();
			await manager.start(TEST_CONFIG);

			await expect(manager.start(TEST_CONFIG)).rejects.toThrow("already running");
		});

		it("throws if disposed", async () => {
			manager = createManager();
			await manager.dispose();
			await expect(manager.start(TEST_CONFIG)).rejects.toThrow("disposed");
		});

		it("sets KANBAN_DESKTOP=1 in child env", async () => {
			const spawnSpy = createSpawnFn(mockChild);
			manager = new RuntimeChildManager({
				cliPath: CLI_PATH,
				spawnFn: spawnSpy,
			});
			await manager.start(TEST_CONFIG);

			const spawnCall = (spawnSpy as ReturnType<typeof vi.fn>).mock.calls[0];
			const options = spawnCall[2] as { env: NodeJS.ProcessEnv };
			expect(options.env.KANBAN_DESKTOP).toBe("1");
		});

		it("sets NODE_OPTIONS with max-old-space-size", async () => {
			const spawnSpy = createSpawnFn(mockChild);
			manager = new RuntimeChildManager({
				cliPath: CLI_PATH,
				spawnFn: spawnSpy,
			});
			await manager.start(TEST_CONFIG);

			const spawnCall = (spawnSpy as ReturnType<typeof vi.fn>).mock.calls[0];
			const options = spawnCall[2] as { env: NodeJS.ProcessEnv };
			expect(options.env.NODE_OPTIONS).toContain("--max-old-space-size=4096");
		});
	});

	// -----------------------------------------------------------------------
	// shutdown()
	// -----------------------------------------------------------------------

	describe("shutdown()", () => {
		it("resolves on child exit", async () => {
			manager = createManager();
			await manager.start(TEST_CONFIG);

			const shutdownPromise = manager.shutdown();
			mockChild.simulateExit(0, null);

			await shutdownPromise;
			expect(manager.running).toBe(false);
		});

		it("force-kills after timeout", async () => {
			manager = createManager({ shutdownTimeoutMs: 100 });
			await manager.start(TEST_CONFIG);

			const shutdownPromise = manager.shutdown();

			vi.advanceTimersByTime(150);

			await shutdownPromise;
			expect(mockChild.kill).toHaveBeenCalledWith("SIGKILL");
		});

		it("is a no-op when no child is running", async () => {
			manager = createManager();
			await manager.shutdown(); // should not throw
		});
	});

	// -----------------------------------------------------------------------
	// No auto-restart — crash emits event and stops
	// -----------------------------------------------------------------------

	describe("no auto-restart", () => {
		it("does not restart after an unexpected crash", async () => {
			let spawnCount = 0;
			const children: MockChild[] = [];
			const spawnFn = vi.fn(() => {
				const child = createMockChild(10000 + spawnCount);
				children.push(child);
				spawnCount++;
				return child;
			}) as unknown as typeof spawn;

			manager = new RuntimeChildManager({
				cliPath: CLI_PATH,
				spawnFn,
			});

			await manager.start(TEST_CONFIG);
			expect(spawnCount).toBe(1);

			// Crash — should NOT auto-restart
			children[0].simulateExit(1, null);
			await vi.advanceTimersByTimeAsync(0);

			expect(spawnCount).toBe(1); // unchanged — no restart
		});

		it("does not restart after graceful shutdown", async () => {
			let spawnCount = 0;
			const children: MockChild[] = [];
			const spawnFn = vi.fn(() => {
				const child = createMockChild(10000 + spawnCount);
				children.push(child);
				spawnCount++;
				return child;
			}) as unknown as typeof spawn;

			manager = new RuntimeChildManager({
				cliPath: CLI_PATH,
				spawnFn,
			});

			await manager.start(TEST_CONFIG);

			const shutdownP = manager.shutdown();
			children[0].simulateExit(0, null);
			await shutdownP;

			await vi.advanceTimersByTimeAsync(0);
			expect(spawnCount).toBe(1); // No restart
		});
	});

	// -----------------------------------------------------------------------
	// env filtering
	// -----------------------------------------------------------------------

	describe("env filtering", () => {
		it("passes filtered env to spawn", async () => {
			const spawnSpy = vi.fn(() => mockChild) as unknown as typeof spawn;
			manager = new RuntimeChildManager({
				cliPath: CLI_PATH,
				spawnFn: spawnSpy,
			});

			await manager.start(TEST_CONFIG);

			const spawnCall = (spawnSpy as ReturnType<typeof vi.fn>).mock.calls[0];
			const options = spawnCall[2] as { env: NodeJS.ProcessEnv };
			expect(options.env.ELECTRON_RUN_AS_NODE).toBeUndefined();
			expect(options.env.PATH).toBeDefined();
		});
	});

	// -----------------------------------------------------------------------
	// dispose()
	// -----------------------------------------------------------------------

	describe("dispose()", () => {
		it("kills child and prevents further start calls", async () => {
			manager = createManager();
			await manager.start(TEST_CONFIG);

			const disposePromise = manager.dispose();
			mockChild.simulateExit(0, null);
			await disposePromise;

			await expect(manager.start(TEST_CONFIG)).rejects.toThrow("disposed");
		});
	});

	// -----------------------------------------------------------------------
	// crashed event
	// -----------------------------------------------------------------------

	describe("crashed event", () => {
		it("emits crashed event on unexpected exit with empty stderr tail", async () => {
			manager = createManager();
			const crashedHandler = vi.fn();
			manager.on("crashed", crashedHandler);

			await manager.start(TEST_CONFIG);
			mockChild.simulateExit(1, null);

			expect(crashedHandler).toHaveBeenCalledWith(1, null, "");
		});

		it("includes recent stderr output in crashed event payload", async () => {
			manager = createManager();
			const crashedHandler = vi.fn();
			manager.on("crashed", crashedHandler);

			await manager.start(TEST_CONFIG);
			mockChild.stderr?.emit("data", Buffer.from("ENOENT: kanban binary\n"));
			mockChild.simulateExit(127, null);

			expect(crashedHandler).toHaveBeenCalledWith(
				127,
				null,
				"ENOENT: kanban binary\n",
			);
		});

		it("truncates stderr tail to a bounded size", async () => {
			manager = createManager();
			const crashedHandler = vi.fn();
			manager.on("crashed", crashedHandler);

			await manager.start(TEST_CONFIG);
			// Emit well over the 8 KB tail cap.
			const longLine = "x".repeat(10_000);
			mockChild.stderr?.emit("data", Buffer.from(longLine));
			mockChild.simulateExit(1, null);

			const [, , tail] = crashedHandler.mock.calls[0] as [unknown, unknown, string];
			expect(tail.length).toBeLessThanOrEqual(8192);
			// The bounded tail should contain the END of the stream, not the start.
			expect(tail.endsWith("x")).toBe(true);
		});

		it("does not emit crashed event on graceful shutdown", async () => {
			manager = createManager();
			const crashedHandler = vi.fn();
			manager.on("crashed", crashedHandler);

			await manager.start(TEST_CONFIG);

			const shutdownP = manager.shutdown();
			mockChild.simulateExit(0, null);
			await shutdownP;

			expect(crashedHandler).not.toHaveBeenCalled();
		});
	});
});
