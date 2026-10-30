import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import * as http from "node:http";
import os from "node:os";
import path from "node:path";
import { ZEN_TRANSPORT_ENV } from "../src/config.ts";
import {
	_resetZenTransportForTest,
	fetchZenDirectViaSidecar,
	findBunOnPath,
	parseBunVersion,
	probeBunVersion,
	resolveZenSidecarScript,
	resolveZenTransport,
	type ZenSpawnSyncResult,
} from "../src/zen-transport.ts";

const savedTransportFlag = process.env[ZEN_TRANSPORT_ENV];
afterEach(() => {
	if (savedTransportFlag === undefined) delete process.env[ZEN_TRANSPORT_ENV];
	else process.env[ZEN_TRANSPORT_ENV] = savedTransportFlag;
	_resetZenTransportForTest();
});

function stubSpawn(stdout: string, counter?: { calls: number }): (command: string, args: readonly string[], options: { encoding: "utf8"; timeout: number; windowsHide: boolean; shell?: boolean }) => ZenSpawnSyncResult {
	return (_command: string, _args: readonly string[]) => {
		if (counter) counter.calls += 1;
		return { status: 0, stdout };
	};
}

function writeScript(dir: string, name: string, body: string): string {
	const file = path.join(dir, name);
	fs.writeFileSync(file, body, "utf8");
	return file;
}

describe("zen transport detection (default OFF)", () => {
	it("flag unset resolves node without spawning", () => {
		delete process.env[ZEN_TRANSPORT_ENV];
		const counter = { calls: 0 };
		const status = resolveZenTransport({ bunPath: "/fake/bun", spawnImpl: stubSpawn("1.2.5\n", counter) });
		assert.equal(status.mode, "node");
		assert.equal(status.bunVersion, null);
		assert.equal(status.bunPath, null);
		assert.equal(status.reason, "transport-flag-off");
		assert.equal(counter.calls, 0, "default path must never probe");
	});

	it("unknown flag value stays node", () => {
		process.env[ZEN_TRANSPORT_ENV] = "bun";
		const status = resolveZenTransport({ bunPath: "/fake/bun", spawnImpl: stubSpawn("1.2.5\n") });
		assert.equal(status.mode, "node");
	});

	it("flag on with bun >= 1.1 resolves bun-sidecar", () => {
		process.env[ZEN_TRANSPORT_ENV] = "bun-sidecar";
		const status = resolveZenTransport({ bunPath: "/fake/bun", spawnImpl: stubSpawn("1.2.5\n") });
		assert.equal(status.mode, "bun-sidecar");
		assert.equal(status.bunVersion, "1.2.5");
		assert.equal(status.bunPath, "/fake/bun");
	});

	it("flag on with absent bun degrades to node", () => {
		process.env[ZEN_TRANSPORT_ENV] = "bun-sidecar";
		const counter = { calls: 0 };
		const status = resolveZenTransport({ bunPath: null, spawnImpl: stubSpawn("1.2.5\n", counter) });
		assert.equal(status.mode, "node");
		assert.equal(status.reason, "bun-absent");
		assert.equal(counter.calls, 0, "no binary means no probe");
	});

	it("flag on with old bun degrades to node", () => {
		process.env[ZEN_TRANSPORT_ENV] = "bun-sidecar";
		const status = resolveZenTransport({ bunPath: "/fake/bun", spawnImpl: stubSpawn("1.0.9\n") });
		assert.equal(status.mode, "node");
		assert.equal(status.bunVersion, null);
	});

	it("flag on with failing probe degrades to node", () => {
		process.env[ZEN_TRANSPORT_ENV] = "bun-sidecar";
		const status = resolveZenTransport({
			bunPath: "/fake/bun",
			spawnImpl: () => { throw new Error("ENOENT"); },
		});
		assert.equal(status.mode, "node");
		assert.equal(status.reason, "bun-probe-failed");
	});

	it("probe memoizes for 60s", () => {
		const counter = { calls: 0 };
		const impl = stubSpawn("1.2.5\n", counter);
		assert.equal(probeBunVersion({ execPath: "/fake/bun", spawnImpl: impl }), "1.2.5");
		assert.equal(probeBunVersion({ execPath: "/fake/bun", spawnImpl: impl }), "1.2.5");
		assert.equal(counter.calls, 1);
		_resetZenTransportForTest();
		assert.equal(probeBunVersion({ execPath: "/fake/bun", spawnImpl: impl }), "1.2.5");
		assert.equal(counter.calls, 2);
	});
});

describe("parseBunVersion", () => {
	it("accepts bare and noisy semver, floors below 1.1", () => {
		assert.equal(parseBunVersion("1.2.5\n"), "1.2.5");
		assert.equal(parseBunVersion("bun 1.4.4 (revision abc)"), "1.4.4");
		assert.equal(parseBunVersion("1.1.0"), "1.1.0");
		assert.equal(parseBunVersion("1.0.9"), null);
		assert.equal(parseBunVersion("no version here"), null);
		assert.equal(parseBunVersion(""), null);
		assert.equal(parseBunVersion(null), null);
		assert.equal(parseBunVersion(42), null);
	});
});

describe("findBunOnPath", () => {
	it("finds an executable bun, ignores missing dirs and empty PATH", () => {
		assert.equal(findBunOnPath(""), null);
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ff-zen-path-"));
		try {
			if (process.platform === "win32") {
				const shim = path.join(dir, "bun.cmd");
				fs.writeFileSync(shim, "@echo 1.2.5\r\n", "utf8");
				const found = findBunOnPath(dir);
				assert.ok(found !== null, "bun.cmd shim must resolve on Windows");
				assert.equal(found.toLowerCase(), shim.toLowerCase(), "PATHEXT case is env-dependent");
			} else {
				const bin = path.join(dir, "bun");
				fs.writeFileSync(bin, "#!/bin/sh\necho 1.2.5\n", { mode: 0o755 });
				assert.equal(findBunOnPath(dir), bin);
				fs.chmodSync(bin, 0o644);
				assert.equal(findBunOnPath(dir), null, "non-executable must not match on POSIX");
			}
			assert.equal(findBunOnPath(path.join(dir, "nope")), null);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("detects and probes a bun binary under a path with spaces", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ff zen spaced "));
		try {
			if (process.platform === "win32") {
				fs.writeFileSync(path.join(dir, "bun.cmd"), "@echo 1.4.4\r\n", "utf8");
			} else {
				fs.writeFileSync(path.join(dir, "bun"), "#!/bin/sh\necho 1.4.4\n", { mode: 0o755 });
			}
			process.env[ZEN_TRANSPORT_ENV] = "bun-sidecar";
			const status = resolveZenTransport({ envPath: dir });
			assert.equal(status.mode, "bun-sidecar", `spaced bun path must resolve; reason=${status.reason}`);
			assert.equal(status.bunVersion, "1.4.4");
			assert.ok(status.bunPath !== null && status.bunPath.includes("ff zen spaced"));
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("sidecar framing (offline, no bun required)", () => {
	it("bridge passes SSE bytes through untouched and forwards headers verbatim", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ff-zen-echo-"));
		try {
			const echo = writeScript(dir, "echo.mjs", [
				"const chunks = [];",
				"for await (const c of process.stdin) chunks.push(c);",
				"const frame = JSON.parse(Buffer.concat(chunks).toString(\"utf8\"));",
				"const seen = Object.keys(frame.headers || {}).some((k) => k.toLowerCase() === \"x-relay-auth\");",
				"process.stdout.write(JSON.stringify({ status: 200, headers: { \"content-type\": \"text/event-stream\", \"x-got-relay-auth\": seen ? \"yes\" : \"no\" } }) + \"\\n\");",
				"process.stdout.write(\"data: hello\\n\\n\");",
			].join("\n") + "\n");
			const res = await fetchZenDirectViaSidecar(
				"https://example.invalid/x",
				{ method: "POST", headers: { authorization: "Bearer public", "x-relay-auth": "s3cr3t" }, body: Buffer.from("{}"), headerTimeoutMs: 5000 },
				{ runtimePath: process.execPath, scriptPath: echo },
			);
			assert.equal(res.status, 200);
			assert.equal(res.headers.get("content-type"), "text/event-stream");
			assert.equal(res.headers.get("x-got-relay-auth"), "yes", "strip is the sidecar's job, the bridge forwards verbatim");
			assert.equal(await res.text(), "data: hello\n\n");
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("real zen-sidecar.ts serves a loopback fetch, strips x-relay-auth, never echoes secrets", async () => {
		let seen: http.IncomingHttpHeaders = {};
		const server = http.createServer((req, res) => {
			seen = { ...req.headers };
			res.writeHead(200, { "content-type": "text/event-stream" });
			res.end("data: hi\n\n");
		});
		await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
		try {
			const addr = server.address();
		assert.ok(addr !== null && typeof addr === "object", "server has a bound address");
		const port = addr.port;
			const frame = {
				url: `http://127.0.0.1:${port}/x`,
				method: "POST",
				headers: { authorization: "Bearer public", "x-relay-auth": "topsecret-value", "content-type": "application/json" },
				bodyB64: Buffer.from("{\"model\":\"m\"}").toString("base64"),
				headerTimeoutMs: 10000,
			};
			// Async spawn only: the loopback server lives on this process's event
			// loop, so a blocking spawnSync wait would deadlock the fetch.
			const child = spawn(process.execPath, ["--experimental-strip-types", resolveZenSidecarScript()], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
			const sideStdout = child.stdout;
			const sideStdin = child.stdin;
			const sideStderr = child.stderr;
			assert.ok(sideStdout !== null && sideStdin !== null && sideStderr !== null, "sidecar stdio must be piped");
			const stdoutChunks: Buffer[] = [];
			let stderr = "";
			sideStdout.on("data", (c: Buffer) => stdoutChunks.push(c));
			sideStderr.on("data", (c: Buffer) => { stderr += c.toString("utf8"); });
			const exitCode: number | null = await new Promise((resolveExit) => {
				child.on("error", () => resolveExit(-1));
				child.on("exit", (code) => resolveExit(code));
				sideStdin.end(JSON.stringify(frame), "utf8");
				setTimeout(() => { try { child.kill("SIGKILL"); } catch { } resolveExit(null); }, 15000);
			});
			const stdout = Buffer.concat(stdoutChunks).toString("utf8");
			assert.equal(exitCode, 0, `sidecar stderr: ${stderr}`);
			const nl = stdout.indexOf("\n");
			assert.ok(nl > 0, "header frame line present");
			const head = JSON.parse(stdout.slice(0, nl)) as { status?: unknown; headers?: unknown };
			assert.equal(head.status, 200);
			assert.equal(stdout.slice(nl + 1), "data: hi\n\n", "SSE body passes through untouched");
			assert.equal(seen["authorization"], "Bearer public");
			assert.equal(seen["x-relay-auth"], undefined, "x-relay-auth must be asserted-and-stripped");
			assert.ok(!stderr.includes("topsecret-value"), "stderr must never echo secrets");
			assert.ok(!stderr.includes("{\"model\""), "stderr must never echo the body");
		} finally {
			await new Promise<void>((r) => server.close(() => r()));
		}
	});

	it("header timeout rejects and kills the hung child", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ff-zen-hang-"));
		const beat = path.join(dir, "beat");
		const savedBeat = process.env["FF_TEST_SIDECAR_HEARTBEAT"];
		try {
			const hang = writeScript(dir, "hang.mjs", [
				"import fs from \"node:fs\";",
				"const f = process.env.FF_TEST_SIDECAR_HEARTBEAT;",
				"process.stdin.resume();",
				"setInterval(() => { try { fs.writeFileSync(f, String(Date.now())); } catch { } }, 50);",
			].join("\n") + "\n");
			process.env["FF_TEST_SIDECAR_HEARTBEAT"] = beat;
			await assert.rejects(
				fetchZenDirectViaSidecar(
					"https://example.invalid/x",
					{ method: "POST", headers: {}, body: Buffer.from("{}"), headerTimeoutMs: 250 },
					{ runtimePath: process.execPath, scriptPath: hang },
				),
				(err: unknown) => err instanceof Error && err.name === "AbortError",
				"timeout must reject like the Node header wait",
			);
			const mtimeAtReject = fs.statSync(beat).mtimeMs;
			// Real-timer exception: proves a live child dies on header timeout —
			// fake timers cannot advance a real process kill, so the platform
			// clock is the assertion here.
			await new Promise<void>((r) => setTimeout(r, 600));
			assert.equal(fs.statSync(beat).mtimeMs, mtimeAtReject, "hung child must be killed on header timeout");
		} finally {
			if (savedBeat === undefined) delete process.env["FF_TEST_SIDECAR_HEARTBEAT"];
			else process.env["FF_TEST_SIDECAR_HEARTBEAT"] = savedBeat;
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("exit before headers rejects (caller degrades to node fetch)", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ff-zen-exit-"));
		try {
			const early = writeScript(dir, "exit1.mjs", "process.stdin.resume();\nprocess.exit(1);\n");
			await assert.rejects(
				fetchZenDirectViaSidecar(
					"https://example.invalid/x",
					{ method: "POST", headers: {}, body: Buffer.from("{}"), headerTimeoutMs: 5000 },
					{ runtimePath: process.execPath, scriptPath: early },
				),
				/before headers/,
			);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("body keeps streaming past the header timeout once headers arrived", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ff-zen-late-body-"));
		try {
			const late = writeScript(dir, "late.mjs", [
				"process.stdin.resume();",
				"process.stdout.write(JSON.stringify({ status: 200, headers: { \"content-type\": \"text/event-stream\" } }) + \"\\n\");",
				"setTimeout(() => { process.stdout.write(\"data: late\\n\\n\"); }, 400);",
				"setTimeout(() => { process.exit(0); }, 600);",
			].join("\n") + "\n");
			const res = await fetchZenDirectViaSidecar(
				"https://example.invalid/x",
				{ method: "POST", headers: {}, body: Buffer.from("{}"), headerTimeoutMs: 150 },
				{ runtimePath: process.execPath, scriptPath: late },
			);
			assert.equal(res.status, 200);
			assert.equal(await res.text(), "data: late\n\n", "header deadline must not cut a live body");
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("non-zero exit mid-body errors the stream instead of a clean EOF", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ff-zen-midbody-"));
		try {
			const die = writeScript(dir, "die.mjs", [
				"process.stdin.resume();",
				"process.stdout.write(JSON.stringify({ status: 200, headers: { \"content-type\": \"text/event-stream\" } }) + \"\\n\");",
				"process.stdout.write(\"data: partial\\n\\n\");",
				"setTimeout(() => { process.exit(1); }, 150);",
			].join("\n") + "\n");
			const res = await fetchZenDirectViaSidecar(
				"https://example.invalid/x",
				{ method: "POST", headers: {}, body: Buffer.from("{}"), headerTimeoutMs: 5000 },
				{ runtimePath: process.execPath, scriptPath: die },
			);
			await assert.rejects(res.text(), /exited \(1\) mid-body/, "a dead child must never look like a complete answer");
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("null-body statuses resolve without a body and drop framing headers", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ff-zen-nullbody-"));
		try {
			for (const status of [204, 205, 304]) {
				const script = writeScript(dir, `null-${status}.mjs`, [
					"process.stdin.resume();",
					`process.stdout.write(JSON.stringify({ status: ${status}, headers: { "content-length": "5", "transfer-encoding": "chunked", "x-null": "1" } }) + "\\n");`,
				].join("\n") + "\n");
				const res = await fetchZenDirectViaSidecar(
					"https://example.invalid/x",
					{ method: "POST", headers: {}, body: Buffer.from("{}"), headerTimeoutMs: 5000 },
					{ runtimePath: process.execPath, scriptPath: script },
				);
				assert.equal(res.status, status);
				assert.equal(res.headers.get("content-length"), null, "framing headers must not survive a null body");
				assert.equal(res.headers.get("transfer-encoding"), null);
				assert.equal(res.headers.get("x-null"), "1");
				assert.equal(await res.text(), "");
			}
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});

function runSidecar(frame: unknown, runtimePath = process.execPath, runtimeArgs = ["--experimental-strip-types"]): Promise<{ code: number | null; stdout: string; stderr: string }> {
	return new Promise((resolve) => {
		const child = spawn(runtimePath, [...runtimeArgs, resolveZenSidecarScript()], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
		const out: Buffer[] = [];
		let err = "";
		let settled = false;
		const finish = (code: number | null): void => {
			if (settled) return;
			settled = true;
			resolve({ code, stdout: Buffer.concat(out).toString("utf8"), stderr: err });
		};
		child.stdout?.on("data", (c: Buffer) => out.push(c));
		child.stderr?.on("data", (c: Buffer) => { err += c.toString("utf8"); });
		child.on("error", () => finish(-1));
		child.on("exit", (code) => finish(code));
		child.stdin?.end(JSON.stringify(frame), "utf8");
		setTimeout(() => { try { child.kill("SIGKILL"); } catch { } finish(null); }, 15000).unref();
	});
}

describe("sidecar URL gate", () => {
	it("rejects plain http off loopback, prefix hosts, and embedded credentials", async () => {
		for (const url of ["http://localhost.evil.com/x", "http://127.0.0.1.evil.com/x", "https://user:pass@example.com/x"]) {
			const run = await runSidecar({
				url,
				method: "POST",
				headers: {},
				bodyB64: "",
				headerTimeoutMs: 1000,
			});
			assert.equal(run.code, 2, `${url} must be refused before any fetch; stderr: ${run.stderr}`);
			assert.match(run.stderr, /bad url/);
		}
	});
});

describe("sidecar under Bun (opt-in, skipped when Bun is absent)", () => {
	const bunPath = findBunOnPath();
	const bunVersion = bunPath === null ? null : probeBunVersion({ execPath: bunPath });
	it("serves a loopback fetch through the real Bun stack", { skip: bunVersion === null ? "Bun 1.1+ not installed" : false }, async () => {
		const server = http.createServer((_req, res) => {
			res.writeHead(200, { "content-type": "text/event-stream" });
			res.end("data: bun\n\n");
		});
		await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
		try {
			const addr = server.address();
			assert.ok(addr !== null && typeof addr === "object", "server has a bound address");
			const run = await runSidecar({
				url: `http://127.0.0.1:${addr.port}/x`,
				method: "POST",
				headers: { "content-type": "application/json" },
				bodyB64: Buffer.from("{\"model\":\"m\"}").toString("base64"),
				headerTimeoutMs: 10000,
			}, bunPath as string, []);
			assert.equal(run.code, 0, `bun sidecar stderr: ${run.stderr}`);
			const nl = run.stdout.indexOf("\n");
			assert.ok(nl > 0, "header frame line present");
			const head = JSON.parse(run.stdout.slice(0, nl)) as { status?: unknown };
			assert.equal(head.status, 200);
			assert.equal(run.stdout.slice(nl + 1), "data: bun\n\n");
		} finally {
			await new Promise<void>((r) => server.close(() => r()));
		}
	});
});
