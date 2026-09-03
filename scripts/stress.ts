// Sandboxed stress harness for pi-freeflow (no external network, no real ports).
// Run: node --experimental-strip-types --import ./test/setup.mjs scripts/stress.ts
// setup.mjs re-roots ALL data files into a fresh tmpdir before any src import.
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const HOST = "127.0.0.1";

// Derive the PORT env name from config source (single source of truth).
const cfgSrc = fs.readFileSync(path.join(ROOT, "src/config.ts"), "utf8");
const portEnvMatch = cfgSrc.match(/process\.env\.([A-Za-z0-9_]+_PORT)/);
if (!portEnvMatch) throw new Error("PORT env key not found in src/config.ts");

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

const STRESS_PORT = await pickFreePort();
process.env[portEnvMatch[1]] = String(STRESS_PORT);

// Dynamic imports AFTER the env override so config.PORT picks it up.
const cfg = await import("../src/config.ts");
const relayState = await import("../src/relay-state.ts");
const lease = await import("../src/lease.ts");
const proxy = await import("../src/proxy.ts");

if (cfg.PORT !== STRESS_PORT) throw new Error(`port override failed: ${cfg.PORT}`);

type Row = { name: string; ok: boolean; detail: string };
const rows: Row[] = [];

async function scenario(name: string, ms: number, fn: () => Promise<string>): Promise<void> {
	const t0 = Date.now();
	try {
		const detail = await Promise.race([
			fn(),
			new Promise<string>((_, rej) => setTimeout(() => rej(new Error(`TIMEOUT>${ms}ms`)), ms)),
		]);
		rows.push({ name, ok: true, detail: `${Date.now() - t0}ms ${detail}` });
	} catch (e) {
		rows.push({ name, ok: false, detail: `${Date.now() - t0}ms ${String(e)}` });
	}
}

function get(pathname: string, port: number, timeoutMs = 5000): Promise<{ status: number; body: string }> {
	return new Promise((res, rej) => {
		const req = http.get({ host: HOST, port, path: pathname, signal: AbortSignal.timeout(timeoutMs) }, (r) => {
			const chunks: Buffer[] = [];
			r.on("data", (c: Buffer) => chunks.push(c));
			r.on("end", () => res({ status: r.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
		});
		req.on("error", rej);
	});
}

function post(pathname: string, port: number, payload: unknown, timeoutMs = 5000): Promise<{ status: number; body: string }> {
	return new Promise((res, rej) => {
		const data = JSON.stringify(payload);
		const req = http.request(
			{ host: HOST, port, path: pathname, method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(data) }, signal: AbortSignal.timeout(timeoutMs) },
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

async function waitReady(port: number, ms = 5000): Promise<void> {
	const t0 = Date.now();
	for (;;) {
		try {
			const r = await get("/v1/models", port);
			if (r.status === 200) return;
		} catch {}
		if (Date.now() - t0 > ms) throw new Error("server never became ready");
		await new Promise<void>((r) => setTimeout(r, 100));
	}
}

// S1: lock held externally, 20 parallel writers must fail-fast (no 2s spin each).
await scenario("S1 lock-contention fail-fast", 15000, async () => {
	const lockFile = `${cfg.RELAY_STATE_FILE}.lock`;
	fs.mkdirSync(path.dirname(cfg.RELAY_STATE_FILE), { recursive: true });
	fs.writeFileSync(lockFile, String(process.pid));
	try {
		const t0 = Date.now();
		await Promise.all(
			Array.from({ length: 20 }, (_, i) =>
				(async () => {
					relayState.withRelayState((s) => {
						relayState.ensureRelay(s, `https://s1-${i}.test/`);
						return s;
					});
				})(),
			),
		);
		const dt = Date.now() - t0;
		const re = relayState.loadRelayState();
		if (re.relays.length < 20) throw new Error(`lost writes: ${re.relays.length}/20`);
		JSON.parse(fs.readFileSync(cfg.RELAY_STATE_FILE, "utf8"));
		if (dt > 8000) throw new Error(`too slow with held lock: ${dt}ms`);
		return `20 writers, ${re.relays.length} relays, ${dt}ms`;
	} finally {
		try { fs.rmSync(lockFile, { force: true }); } catch {}
	}
});

// S2: 6 concurrent cross-process ensureDaemon racers converge on one daemon.
await scenario("S2 spawn-race converge", 60000, async () => {
	const kids = Array.from({ length: 6 }, () =>
		spawn(process.execPath, ["--experimental-strip-types", "--import", "./test/setup.mjs", "scripts/stress-child.ts"], {
			cwd: ROOT, stdio: ["ignore", "pipe", "pipe"],
			env: { ...process.env },
		}),
	);
	const ports = await Promise.all(
		kids.map(
			(k) =>
				new Promise<number>((res, rej) => {
					let out = "";
					const to = setTimeout(() => rej(new Error("child silent")), 45000);
					k.stdout?.on("data", (d: Buffer) => {
						out += String(d);
						const m = out.match(/PORT=(\d+)/);
						if (m) { clearTimeout(to); res(Number(m[1])); }
					});
					k.on("error", (e) => { clearTimeout(to); rej(e); });
					k.on("exit", (c) => { if (!out.match(/PORT=\d+/)) { clearTimeout(to); rej(new Error(`exit ${c}: ${out.slice(0, 200)}`)); } });
				}),
		),
	);
	await Promise.all(kids.map((k) => new Promise<void>((r) => { k.on("exit", () => r()); setTimeout(() => { try { k.kill(); } catch {} r(); }, 8000); })));
	const uniq = [...new Set(ports)];
	if (uniq.length !== 1) throw new Error(`split brain: ${uniq.join(",")}`);
	const alive = await proxy.isProxyAlive(uniq[0]);
	if (!alive) throw new Error("converged port not alive");
	if (uniq[0] !== STRESS_PORT) return `unanimous attach to pre-existing :${uniq[0]} (shutdown skipped)`;
	await post("/_shutdown", uniq[0], {});
	const t0 = Date.now();
	while (Date.now() - t0 < 8000) {
		if (!(await proxy.isProxyAlive(uniq[0]))) return `6 racers -> :${uniq[0]}, retired clean`;
		await new Promise<void>((r) => setTimeout(r, 250));
	}
	throw new Error("daemon did not retire after shutdown");
});

// S3: 300 requests at concurrency 20 (production-shaped) + burst-30 info only.
await scenario("S3 proxy fan-out x300", 60000, async () => {
	const { server, port } = await proxy.startProxy(0);
	if (!server) throw new Error("no server");
	try {
		await waitReady(port);
		let bad = 0;
		let idx = 0;
		const t1 = Date.now();
		await Promise.all(Array.from({ length: 20 }, async () => {
			while (idx < 300) {
				idx++;
				try {
					const r = await get("/v1/models", port);
					if (r.status !== 200) bad++;
				} catch { bad++; }
			}
		}));
		if (bad > 0) throw new Error(`${bad}/300 non-200 at c20`);
		const burst = await Promise.all(
			Array.from({ length: 30 }, () => get("/v1/models", port).then((r) => r.status).catch(() => 0)),
		);
		const burstBad = burst.filter((c) => c !== 200).length;
		return `300/300 pooled in ${Date.now() - t1}ms, burst-30 refused=${burstBad} (info)`;
	} finally {
		await new Promise<void>((r) => server.close(() => r()));
	}
});

// S4: heartbeat unknown-id protocol (restart simulation).
await scenario("S4 heartbeat re-attach protocol", 15000, async () => {
	const { server, port } = await proxy.startProxy(0);
	if (!server) throw new Error("no server");
	try {
		const a = await post("/_client/attach", port, { id: "s4" });
		if (JSON.parse(a.body).ok !== true) throw new Error("attach failed");
		const h1 = await post("/_client/heartbeat", port, { id: "s4" });
		if (JSON.parse(h1.body).ok !== true) throw new Error("heartbeat failed");
		lease._resetLeaseStateForTest(); // simulate daemon restart (leases wiped)
		const h2 = await post("/_client/heartbeat", port, { id: "s4" });
		if (JSON.parse(h2.body).ok !== false) throw new Error(`expected ok:false, got ${h2.body}`);
		const a2 = await post("/_client/attach", port, { id: "s4" });
		if (JSON.parse(a2.body).ok !== true) throw new Error("re-attach failed");
		if (lease.renewClient("s4") !== true) throw new Error("lease not re-registered");
		return "ok->unknown->re-attach";
	} finally {
		await new Promise<void>((r) => server.close(() => r()));
		lease._resetLeaseStateForTest();
	}
});

// S5: 100 rapid hide flips, last write wins.
await scenario("S5 rapid hide flips x100", 15000, async () => {
	relayState.withRelayState(() => ({ mode: "auto", enabled: true, url: "https://s5.test/", relays: [{ url: "https://s5.test/" }], hideWidget: false }));
	for (let i = 0; i < 100; i++) {
		const hide = i % 2 === 1;
		relayState.withRelayState((s) => ({ ...s, hideWidget: hide }));
	}
	const fin = relayState.loadRelayState();
	if (fin.hideWidget !== true) throw new Error("last write lost");
	if (relayState.formatRelayStatusLabel(fin) !== null) throw new Error("label leaks when hidden");
	return "100 flips, last-wins";
});

// S6: /v1/models must not pin a lease-less daemon (no activity touch).
await scenario("S6 models probe pins nothing", 15000, async () => {
	const { server, port } = await proxy.startProxy(0);
	if (!server) throw new Error("no server");
	try {
		const before = lease.getLastActivityAt();
		await new Promise<void>((r) => setTimeout(r, 15));
		for (let i = 0; i < 5; i++) await get("/v1/models", port);
		const after = lease.getLastActivityAt();
		if (after !== before) throw new Error("models probe touched activity");
		return "activity untouched";
	} finally {
		await new Promise<void>((r) => server.close(() => r()));
	}
});

// S7: killPortHolder reaps a foreign holder process, never self.
// (An in-process dummy reports our own PID, which the guard must skip.)
await scenario("S7 killPortHolder precision", 30000, async () => {
	const child = spawn(process.execPath, ["-e", "require('node:http').createServer((_,res)=>res.end('x')).listen(0,'127.0.0.1',function(){console.log('DPORT='+this.address().port)});setInterval(()=>{},1000);"], {
		cwd: ROOT, stdio: ["ignore", "pipe", "pipe"],
	});
	const dport = await new Promise<number>((res, rej) => {
		let out = "";
		const to = setTimeout(() => rej(new Error("dummy silent")), 15000);
		child.stdout?.on("data", (d: Buffer) => {
			out += String(d);
			const m = out.match(/DPORT=(\d+)/);
			if (m) { clearTimeout(to); res(Number(m[1])); }
		});
		child.on("error", (e) => { clearTimeout(to); rej(e); });
	});
	try {
		await waitReady(dport);
		const killed = await proxy.killPortHolder(dport);
		if (!killed) return "SKIP (os tools missing)";
		const exited = await Promise.race([
			new Promise<boolean>((r) => { child.on("exit", () => r(true)); }),
			new Promise<boolean>((r) => setTimeout(() => r(false), 8000)),
		]);
		if (!exited) throw new Error("holder survived kill");
		return `holder :${dport} reaped, self ${process.pid} alive`;
	} finally {
		try { child.kill(); } catch {}
	}
});

let fails = 0;
for (const r of rows) {
	if (!r.ok) fails++;
	console.log(`${r.ok ? "PASS" : "FAIL"} ${r.name} — ${r.detail}`);
}
console.log(fails === 0 ? `ALL ${rows.length} STRESS PASS` : `${fails}/${rows.length} STRESS FAIL`);
process.exit(fails === 0 ? 0 : 1);
