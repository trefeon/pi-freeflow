// Live-process stress for the lease-only retire policy.
// Idle-with-clients holds; zero-clients shuts down with the `no clients` label.
//
// Run: bun scripts/stress-idle-shutdown.ts
// Isolation: fresh loopback port + sandboxed DATA_DIR under os.tmpdir() per
// boot. Never touches :28180, the live daemon, or real ~/.pi/agent state.
// Loopback control traffic only; zero upstream/relayed (/v1/*) requests.
//
// Env keys are never hardcoded: the PORT key is parsed out of
// src/config.ts source (same convention as scripts/stress.ts) and every
// other key is imported from src/config.ts.

import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
	DATA_DIR_ENV,
	DAEMON_GC_MS_ENV,
	DAEMON_GRACE_MS_ENV,
	DAEMON_HEARTBEAT_MS_ENV,
	DAEMON_TTL_MS_ENV,
	HOST,
} from "../src/config.ts";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// ── PORT env key: single source of truth is src/config.ts ──
const cfgSrc = fs.readFileSync(path.join(ROOT, "src", "config.ts"), "utf8");
const portEnvMatch = cfgSrc.match(/process\.env\.([A-Za-z0-9_]+_PORT)/);
if (!portEnvMatch) throw new Error("PORT env key not found in src/config.ts");
const PORT_ENV = portEnvMatch[1];

// ── Short clock so the whole run finishes in ~1min ──
const TTL_MS = 3_000;
const HEARTBEAT_MS = 1_000;
const GC_MS = 1_000;
const GRACE_MS = 5_000;

const TRANSCRIPT = path.join(os.tmpdir(), `ff-idle-stress-transcript-${process.pid}.log`);
const t0 = Date.now();
function ts(): string {
	return `[${new Date().toISOString()} +${Date.now() - t0}ms]`;
}
function log(line: string): void {
	const row = `${ts()} ${line}`;
	console.log(row);
	fs.appendFileSync(TRANSCRIPT, `${row}\n`, "utf8");
}

type PhaseResult = { name: string; ok: boolean; ms: number; detail: string };
const phases: PhaseResult[] = [];
async function phase(name: string, fn: () => Promise<string>): Promise<void> {
	const start = Date.now();
	try {
		const detail = await fn();
		phases.push({ name, ok: true, ms: Date.now() - start, detail });
		log(`PASS ${name} (${Date.now() - start}ms) ${detail}`);
	} catch (e) {
		phases.push({ name, ok: false, ms: Date.now() - start, detail: String(e) });
		log(`FAIL ${name} (${Date.now() - start}ms) ${String(e)}`);
	}
}
function assert(cond: unknown, msg: string): asserts cond {
	if (!cond) throw new Error(`assert: ${msg}`);
}
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function pickFreePort(): Promise<number> {
	return new Promise((res, rej) => {
		const s = net.createServer();
		s.once("error", rej);
		s.listen(0, HOST, () => {
			const a = s.address();
			const p = typeof a === "object" && a ? a.port : 0;
			s.close(() => res(p));
		});
	});
}

function get(pathname: string, port: number, timeoutMs = 5000): Promise<{ status: number; body: string }> {
	return new Promise((res, rej) => {
		const req = http.get(
			{ host: HOST, port, path: pathname, signal: AbortSignal.timeout(timeoutMs) },
			(r) => {
				const chunks: Buffer[] = [];
				r.on("data", (c: Buffer) => chunks.push(c));
				r.on("end", () => res({ status: r.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
			},
		);
		req.on("error", rej);
	});
}

function post(pathname: string, port: number, payload: unknown, timeoutMs = 5000): Promise<{ status: number; body: string }> {
	return new Promise((res, rej) => {
		const data = JSON.stringify(payload);
		const req = http.request(
			{
				host: HOST,
				port,
				path: pathname,
				method: "POST",
				headers: { "content-type": "application/json", "content-length": Buffer.byteLength(data) },
				signal: AbortSignal.timeout(timeoutMs),
			},
			(r) => {
				const chunks: Buffer[] = [];
				r.on("data", (c: Buffer) => chunks.push(c));
				r.on("end", () => res({ status: r.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
			},
		);
		req.on("error", rej);
		req.end(data);
	});
}

interface DaemonHandle {
	child: ChildProcess;
	port: number;
	dataDir: string;
	stdout: string;
	stderr: string;
	exited: Promise<number | null>;
}

async function bootDaemon(): Promise<DaemonHandle> {
	const port = await pickFreePort();
	const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ff-idle-stress-"));
	assert(port !== 28180, `picked test port collides with live daemon (got ${port})`);
	const child = spawn(process.execPath, [path.join(ROOT, "src", "daemon.ts")], {
		cwd: ROOT,
		windowsHide: true,
		env: {
			...process.env,
			[PORT_ENV]: String(port),
			[DATA_DIR_ENV]: dataDir,
			[DAEMON_TTL_MS_ENV]: String(TTL_MS),
			[DAEMON_HEARTBEAT_MS_ENV]: String(HEARTBEAT_MS),
			[DAEMON_GC_MS_ENV]: String(GC_MS),
			[DAEMON_GRACE_MS_ENV]: String(GRACE_MS),
		},
	});
	let stdout = "";
	let stderr = "";
	child.stdout?.on("data", (c: Buffer) => {
		stdout += c.toString("utf8");
	});
	child.stderr?.on("data", (c: Buffer) => {
		stderr += c.toString("utf8");
	});
	const exited = new Promise<number | null>((res) => {
		child.on("exit", (code) => res(code));
	});
	const h: DaemonHandle = { child, port, dataDir, stdout: "", stderr: "", exited };
	// Keep live views of captured output.
	Object.defineProperties(h, {
		stdout: { get: () => stdout },
		stderr: { get: () => stderr },
	});
	// Wait for /_health.
	const start = Date.now();
	for (;;) {
		if (child.exitCode !== null) {
			throw new Error(`daemon on :${port} exited during boot (code=${child.exitCode}) stdout=${stdout.slice(-500)} stderr=${stderr.slice(-500)}`);
		}
		try {
			const r = await get("/_health", port, 2000);
			if (r.status === 200) break;
		} catch {}
		if (Date.now() - start > 20_000) throw new Error(`daemon on :${port} never became ready`);
		await sleep(200);
	}
	return h;
}

async function health(port: number): Promise<{ status: number; json: Record<string, unknown> }> {
	const r = await get("/_health", port);
	let json: Record<string, unknown> = {};
	try {
		json = JSON.parse(r.body) as Record<string, unknown>;
	} catch {}
	return { status: r.status, json };
}

interface BeatClient {
	id: string;
	timer: ReturnType<typeof setInterval> | null;
}
async function attach(port: number, id: string, beat: boolean): Promise<BeatClient> {
	const r = await post("/_client/attach", port, { id });
	assert(r.status === 200 && JSON.parse(r.body).ok === true, `attach ${id} failed: ${r.status} ${r.body}`);
	const c: BeatClient = { id, timer: null };
	if (beat) {
		c.timer = setInterval(() => {
			post("/_client/heartbeat", port, { id }).catch(() => {});
		}, HEARTBEAT_MS);
	}
	return c;
}
async function detach(port: number, c: BeatClient): Promise<void> {
	if (c.timer) {
		clearInterval(c.timer);
		c.timer = null;
	}
	const r = await post("/_client/detach", port, { id: c.id });
	assert(r.status === 200, `detach ${c.id} failed: ${r.status} ${r.body}`);
}

function readSandboxLog(dataDir: string): string {
	const p = path.join(dataDir, "pi-freeflow.log");
	try {
		return fs.readFileSync(p, "utf8");
	} catch {
		return "";
	}
}

async function waitExit(h: DaemonHandle, budgetMs: number): Promise<number | null> {
	return Promise.race([h.exited, sleep(budgetMs).then(() => h.child.exitCode)]);
}

const strays: DaemonHandle[] = [];
function killStray(h: DaemonHandle): void {
	try {
		if (h.child.exitCode === null) h.child.kill("SIGKILL");
	} catch {}
}
try {
	let keepA: BeatClient | null = null;
	// ── Phase A: 3 attached heartbeat clients, zero proxied requests, idle 3+ grace windows ──
	const d1 = await bootDaemon();
	strays.push(d1);
	log(`boot A: daemon on :${d1.port}, dataDir=${d1.dataDir}`);
	await phase("(a) idle-with-clients holds", async () => {
		const c1 = await attach(d1.port, "stress-a-1", true);
		const c2 = await attach(d1.port, "stress-a-2", true);
		const c3 = await attach(d1.port, "stress-a-3", true);
		try {
			await sleep(GRACE_MS * 3 + 1_000); // 16s ≈ 3.2 grace windows, heartbeats only
			assert(d1.child.exitCode === null, "daemon exited while 3 clients attached");
			const h = await health(d1.port);
			assert(h.status === 200, `/_health status ${h.status}`);
			assert(h.json.clients === 3, `expected 3 leases, got ${JSON.stringify(h.json.clients)}`);
			const leases = h.json.leases !== null && typeof h.json.leases === "object" ? h.json.leases : {};
			const keys = Object.keys(leases);
			assert(keys.length === 3, `expected 3 lease keys, got ${keys.length}`);
			return `alive after ${GRACE_MS * 3 + 1_000}ms idle, clients=3`;
		} finally {
			await detach(d1.port, c2);
			await detach(d1.port, c3);
		// c1 stays attached for phase (b).
		keepA = c1;
		}
	});

	// ── Phase B: 1 lease left, idle past grace → still alive ──
	await phase("(b) partial detach holds", async () => {
		assert(keepA !== null, "phase (a) did not hand off a client");
		await sleep(GRACE_MS + 2_000); // past one full grace window with 1 lease
		assert(d1.child.exitCode === null, "daemon exited while 1 client attached");
		const h = await health(d1.port);
		assert(h.status === 200, `/_health status ${h.status}`);
		assert(h.json.clients === 1, `expected 1 lease, got ${JSON.stringify(h.json.clients)}`);
		return `alive after ${GRACE_MS + 2_000}ms idle, clients=1`;
	});

	// ── Phase C: detach last → self-exit within grace+margin with the new label ──
	await phase("(c) zero-clients retires", async () => {
		assert(keepA !== null, "phase (a) did not hand off a client");
		await detach(d1.port, keepA);
		const code = await waitExit(d1, GRACE_MS + 10_000);
		assert(code !== null, `daemon still alive ${GRACE_MS + 10_000}ms after last detach`);
		assert(code === 0, `daemon exit code ${code}, expected 0`);
		await sleep(300); // let the log flush settle
		const logText = readSandboxLog(d1.dataDir) + d1.stdout + d1.stderr;
		assert(logText.includes("daemon retiring: no clients"), "retire label `daemon retiring: no clients` not found in daemon output");
		assert(!logText.includes("no clients and idle"), "old `no clients and idle` label still present");
		return `self-exited code=0, new label confirmed, old label absent`;
	});
	strays.splice(strays.indexOf(d1), 1);
	killStray(d1);

	// ── Phase D: fresh boot, attach inside the grace window → survives (boot-race guard) ──
	const d2 = await bootDaemon();
	strays.push(d2);
	log(`boot D: daemon on :${d2.port}, dataDir=${d2.dataDir}`);
	await phase("(d) boot-race re-attach survives", async () => {
		await sleep(2_000); // partway into the grace window, still lease-less
		const c = await attach(d2.port, "stress-d-1", true);
		try {
			await sleep(GRACE_MS + 2_000); // lease-less age must not count pre-attach time
			assert(d2.child.exitCode === null, "fresh daemon retired despite attach inside grace window");
			const h = await health(d2.port);
			assert(h.status === 200, `/_health status ${h.status}`);
			assert(h.json.clients === 1, `expected 1 lease, got ${JSON.stringify(h.json.clients)}`);
			return `alive after grace window with in-window attach, clients=1`;
		} finally {
			await detach(d2.port, c);
		}
	});
	// Cleanup: the phase-D daemon must also retire on its own once lease-less.
	const d2code = await waitExit(d2, GRACE_MS + 10_000);
	log(`cleanup: phase-D daemon self-exit code=${d2code}`);
	strays.splice(strays.indexOf(d2), 1);
	killStray(d2);
} finally {
	for (const h of strays) killStray(h);
}

const fails = phases.filter((p) => !p.ok).length;
log(fails === 0 ? `ALL ${phases.length} IDLE-SHUTDOWN PASS` : `${fails}/${phases.length} IDLE-SHUTDOWN FAIL`);
log(`transcript: ${TRANSCRIPT}`);
process.exit(fails === 0 ? 0 : 1);
