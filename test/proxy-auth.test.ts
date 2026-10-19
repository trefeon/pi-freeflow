/**
 * Local-proxy authorization gate (2026-10-19 review, finding 3).
 *
 * Loopback is not an authorization boundary: any local process can connect to
 * the daemon port, and it spends the user's Cline logins and relay credentials
 * on the caller's behalf. These tests pin the contract:
 *
 *  - `<data dir>/token` is created by the proxy at startup: 32 random bytes as
 *    64 hex chars, mode 0600, no trailing newline.
 *  - Every `/v1/*` and `/_*` route requires `Authorization: Bearer <token>`;
 *    anything else gets 401 and never reaches upstream.
 *  - `GET /health` is the one unauthenticated route and answers exactly
 *    `{ok, service, port, version}` — the identity probe attach/reclaim uses.
 *  - The Host header must name this loopback listener (403 otherwise).
 *  - Lease registration is capped: over-long ids 400, registry overflow 429.
 *  - `buildProviderConfig` hands the host the token as `apiKey`.
 *  - `killPortHolder` identifies the holder first and never kills a process
 *    that answers /health as a foreign service.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http, { createServer } from "node:http";
import { once } from "node:events";
import { DEFAULT_PORT, HOST, PKG_VERSION, resolvePort, resolveTokenPath } from "../src/config.ts";
import { ensureToken, readToken } from "../src/token.ts";
import { isAllowedHostHeader, killPortHolder, probePortHolder, startProxy } from "../src/proxy.ts";
import { MAX_CLIENTS, MAX_CLIENT_ID_LENGTH, _resetLeaseStateForTest, getLeaseCount } from "../src/lease.ts";
import { buildProviderConfig } from "../src/index.ts";
import { authHeaders } from "./_auth.ts";

const PROXY_PORT_ENV = "PI_FREEFLOW_PORT";

/** Raw request with explicit control over method/headers (including Host). */
async function rawRequest(
	port: number,
	opts: { path: string; method?: string; headers?: Record<string, string>; body?: string },
): Promise<{ status: number; body: string }> {
	const { promise, resolve, reject } = Promise.withResolvers<{ status: number; body: string }>();
	const req = http.request(
		{ host: HOST, port, path: opts.path, method: opts.method ?? "GET", headers: opts.headers },
		(res) => {
			const chunks: Buffer[] = [];
			res.on("data", (chunk: Buffer) => chunks.push(chunk));
			res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
		},
	);
	req.on("error", reject);
	if (opts.body !== undefined) req.write(opts.body);
	req.end();
	return promise;
}

/** Token-authenticated JSON POST to the local proxy. */
async function jsonPost(
	port: number,
	path: string,
	payload: Record<string, unknown>,
): Promise<{ status: number; body: string }> {
	return await rawRequest(port, {
		path,
		method: "POST",
		headers: { "content-type": "application/json", ...authHeaders() },
		body: JSON.stringify(payload),
	});
}

function closeServer(server: http.Server | null): Promise<void> {
	if (!server) return Promise.resolve();
	const { promise, resolve } = Promise.withResolvers<void>();
	server.close(() => resolve());
	return promise;
}

// ── 1. Token file ───────────────────────────────────────────────────────────

test("proxy start writes a 32-byte hex token at 0600 and reuses it", async () => {
	const { server } = await startProxy(0);
	try {
		const file = resolveTokenPath();
		const stat = fs.statSync(file);
		assert.ok(stat.isFile(), "the proxy must create the token file at startup");
		const raw = fs.readFileSync(file, "utf8");
		const token = readToken();
		assert.ok(token, "readToken must return the created token");
		assert.match(token, /^[0-9a-f]{64}$/, "32 random bytes rendered as hex");
		assert.equal(raw, token, "the file holds exactly the token — no trailing newline, no wrapper");
		if (process.platform === "win32") {
			// Windows reports a synthesized 0o666 for every writable file; ACLs
			// are not visible through stat(), so the mode is asserted on POSIX.
		} else {
			assert.equal(stat.mode & 0o777, 0o600, "the token file must be owner-only");
		}

		// A second startProxy call reuses the same installation token.
		const second = await startProxy(0);
		try {
			assert.equal(readToken(), token, "an existing token must never be regenerated");
			assert.equal(fs.readFileSync(file, "utf8"), token);
		} finally {
			await closeServer(second.server);
		}
	} finally {
		await closeServer(server);
	}
});

// ── 2. Unauthenticated callers get 401 and never reach upstream ─────────────

test("every /v1/* and /_* route rejects a caller without the token", async () => {
	const { server, port } = await startProxy(0);
	const url = (path: string): string => `http://${HOST}:${port}${path}`;
	const chatBody = JSON.stringify({ model: "nemotron-3.5-super-vl-free", messages: [{ role: "user", content: "hi" }] });
	try {
		const cases: Array<{ method: string; path: string; init?: RequestInit }> = [
			{ method: "GET", path: "/v1/models" },
			{
				method: "POST",
				path: "/v1/chat/completions",
				init: { headers: { "content-type": "application/json" }, body: chatBody },
			},
			{ method: "POST", path: "/_shutdown" },
			{ method: "GET", path: "/_health" },
			{
				method: "POST",
				path: "/_client/attach",
				init: { headers: { "content-type": "application/json" }, body: JSON.stringify({ id: "unauthenticated" }) },
			},
		];
		for (const probe of cases) {
			const anonymous = await fetch(url(probe.path), { method: probe.method, ...probe.init });
			assert.equal(anonymous.status, 401, `${probe.method} ${probe.path} must require the token`);
			const foreign = await fetch(url(probe.path), {
				method: probe.method,
				...probe.init,
				headers: { ...(probe.init?.headers as Record<string, string> | undefined), authorization: `Bearer ${"0".repeat(64)}` },
			});
			assert.equal(foreign.status, 401, `${probe.method} ${probe.path} must reject a foreign token`);
		}
		assert.equal(getLeaseCount(), 0, "a rejected attach must not register a lease");

		// Positive control: the installation token opens the same routes.
		const models = await fetch(url("/v1/models"), { headers: { ...authHeaders() } });
		assert.equal(models.status, 200);
		const lease = await jsonPost(port, "/_client/attach", { id: "authorized-client" });
		assert.equal(lease.status, 200);
		assert.equal(getLeaseCount(), 1);
		const health = await fetch(url("/_health"), { headers: { ...authHeaders() } });
		assert.equal(health.status, 200);
	} finally {
		_resetLeaseStateForTest();
		await closeServer(server);
	}
});

test("an unauthorized chat request is refused before any upstream call", async () => {
	const { server, port } = await startProxy(0);
	const localPrefix = `http://${HOST}:${port}`;
	const realFetch = globalThis.fetch.bind(globalThis);
	const body = JSON.stringify({ model: "nemotron-3.5-super-vl-free", messages: [{ role: "user", content: "hi" }] });
	let upstreamCalls = 0;
	const fetchMock = test.mock.method(globalThis, "fetch", async (url: unknown, init?: RequestInit) => {
		assert.ok(!String(url).startsWith(localPrefix), "the scenario only mocks upstream traffic");
		upstreamCalls += 1;
		return new Response(JSON.stringify({ id: "chatcmpl-auth", choices: [{ message: { content: "ok" } }] }), {
			status: 200,
			headers: { "content-type": "application/json" },
		});
	});
	try {
		const denied = await realFetch(`${localPrefix}/v1/chat/completions`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body,
		});
		assert.equal(denied.status, 401);
		assert.equal(upstreamCalls, 0, "an unauthorized caller must not spend upstream quota or relay credentials");

		const allowed = await realFetch(`${localPrefix}/v1/chat/completions`, {
			method: "POST",
			headers: { "content-type": "application/json", ...authHeaders() },
			body,
		});
		assert.equal(allowed.status, 200);
		const json = (await allowed.json()) as { id?: string };
		assert.equal(json.id, "chatcmpl-auth");
		assert.equal(upstreamCalls, 1, "the authorized request is the one that reaches upstream");
	} finally {
		fetchMock.mock.restore();
		await closeServer(server);
	}
});

// ── 3. Host allowlist ───────────────────────────────────────────────────────

test("a foreign Host header is refused, loopback names are accepted", async () => {
	const { server, port } = await startProxy(0);
	try {
		const foreign = await rawRequest(port, {
			path: "/v1/models",
			headers: { host: "evil.example.com", ...authHeaders() },
		});
		assert.equal(foreign.status, 403);
		assert.match(foreign.body, /forbidden host/);

		// The host check runs before the token check: a rebinding attempt never
		// learns whether it guessed a token shape.
		const foreignAnonymous = await rawRequest(port, { path: "/v1/models", headers: { host: "evil.example.com" } });
		assert.equal(foreignAnonymous.status, 403);

		for (const host of [`127.0.0.1:${port}`, "localhost", `[::1]:${port}`]) {
			const ok = await rawRequest(port, { path: "/v1/models", headers: { host, ...authHeaders() } });
			assert.equal(ok.status, 200, `Host ${host} must be accepted`);
		}

		assert.equal(isAllowedHostHeader("127.0.0.1:28180"), true);
		assert.equal(isAllowedHostHeader("localhost"), true);
		assert.equal(isAllowedHostHeader("[::1]:28180"), true);
		assert.equal(isAllowedHostHeader("evil.example.com:28180"), false);
		assert.equal(isAllowedHostHeader("127.0.0.1.evil.com"), false);
		assert.equal(isAllowedHostHeader(undefined), false);
	} finally {
		await closeServer(server);
	}
});

// ── 4. The identity probe leaks nothing ─────────────────────────────────────

test("GET /health is the unauthenticated identity probe with an exact shape", async () => {
	const { server, port } = await startProxy(0);
	try {
		const res = await fetch(`http://${HOST}:${port}/health`);
		assert.equal(res.status, 200);
		assert.deepEqual(await res.json(), {
			ok: true,
			service: "pi-freeflow",
			port,
			version: PKG_VERSION,
		});

		// The rich snapshot on the same port stays gated: no relays, leases or
		// gate state for an unauthenticated local process.
		const rich = await fetch(`http://${HOST}:${port}/_health`);
		assert.equal(rich.status, 401);
		const gated = await fetch(`http://${HOST}:${port}/_health`, { headers: { ...authHeaders() } });
		assert.equal(gated.status, 200);
		const body = (await gated.json()) as { relays?: unknown; leases?: unknown; port?: number };
		assert.ok(Array.isArray(body.relays), "the authenticated caller gets the rich snapshot");
		assert.equal(typeof body.leases, "object");
	} finally {
		await closeServer(server);
	}
});

// ── 5. Lease caps ───────────────────────────────────────────────────────────

test("attach caps the client id length and the registry size", async () => {
	const { server, port } = await startProxy(0);
	_resetLeaseStateForTest();
	try {
		const tooLong = await jsonPost(port, "/_client/attach", { id: "x".repeat(MAX_CLIENT_ID_LENGTH + 1) });
		assert.equal(tooLong.status, 400, "an over-long client id must be rejected");
		assert.equal(getLeaseCount(), 0, "a rejected id must not be stored");

		const atLimit = "y".repeat(MAX_CLIENT_ID_LENGTH);
		const accepted = await jsonPost(port, "/_client/attach", { id: atLimit });
		assert.equal(accepted.status, 200, "an id of exactly the limit is still accepted");
		assert.equal(getLeaseCount(), 1);
		const detach = await jsonPost(port, "/_client/detach", { id: atLimit });
		assert.equal(detach.status, 200);
		assert.equal(getLeaseCount(), 0);

		for (let i = 0; i < MAX_CLIENTS; i++) {
			const attached = await jsonPost(port, "/_client/attach", { id: `client-${i}` });
			assert.equal(attached.status, 200, `attach ${i} must be accepted below the cap`);
		}
		assert.equal(getLeaseCount(), MAX_CLIENTS);

		const overflow = await jsonPost(port, "/_client/attach", { id: "one-too-many" });
		assert.equal(overflow.status, 429, "registry overflow must be answered with 429");
		assert.equal(getLeaseCount(), MAX_CLIENTS, "the rejected client must not be registered");

		// Refreshing a known lease still works at the cap (heartbeats and
		// re-attaches of live sessions must never be starved).
		const refresh = await jsonPost(port, "/_client/attach", { id: "client-0" });
		assert.equal(refresh.status, 200);
		assert.equal(getLeaseCount(), MAX_CLIENTS);
	} finally {
		_resetLeaseStateForTest();
		await closeServer(server);
	}
});

// ── 6. Host plumbing: the provider carries the token ────────────────────────

test("buildProviderConfig hands the host the installation token as apiKey", () => {
	const token = ensureToken();
	assert.match(token, /^[0-9a-f]{64}$/);
	assert.equal(readToken(), token);
	const config = buildProviderConfig([]);
	assert.equal(config.apiKey, token, "hosts must authenticate to the local proxy with the installation token");
	assert.match(config.baseUrl, /^http:\/\/127\.0\.0\.1:\d+\/v1$/);
});

// ── 7. Port misconfiguration (fractional port crash) ────────────────────────

test("resolvePort rejects a fractional port instead of crashing the daemon bind", () => {
	const prev = process.env[PROXY_PORT_ENV];
	try {
		process.env[PROXY_PORT_ENV] = "28180.5";
		assert.equal(
			resolvePort(),
			DEFAULT_PORT,
			"a fractional port must fall back to the default (net.listen throws ERR_SOCKET_BAD_PORT)",
		);
		process.env[PROXY_PORT_ENV] = "0";
		assert.equal(resolvePort(), DEFAULT_PORT, "0 is not a bindable port");
		process.env[PROXY_PORT_ENV] = "not-a-number";
		assert.equal(resolvePort(), DEFAULT_PORT);
		process.env[PROXY_PORT_ENV] = "28181";
		assert.equal(resolvePort(), 28181, "a well-formed override still applies");
	} finally {
		if (prev === undefined) delete process.env[PROXY_PORT_ENV];
		else process.env[PROXY_PORT_ENV] = prev;
	}
});

// ── 8. Killing is identity-checked ──────────────────────────────────────────

test("killPortHolder leaves a foreign service alone and reaps our own daemon", async () => {
	// A stranger that identifies itself as something else on the same routes.
	const stranger = createServer((_req, res) => {
		const address = stranger.address();
		const port = address && typeof address === "object" ? address.port : 0;
		res.writeHead(200, { "content-type": "application/json" });
		res.end(JSON.stringify({ ok: true, service: "someone-else", port }));
	});
	await new Promise<void>((resolve) => stranger.listen(0, HOST, () => resolve()));
	const address = stranger.address();
	assert.ok(address && typeof address === "object");
	const strangerPort = address.port;
	try {
		assert.equal(await probePortHolder(strangerPort), "foreign", "a different service marker is not ours");
		assert.equal(await killPortHolder(strangerPort), false, "a foreign holder must never be killed");
		assert.ok(stranger.listening, "the foreign process must survive the attempt");
	} finally {
		await closeServer(stranger);
	}

	// A released port is free: nothing to kill, reported as success.
	const released = await startProxy(0);
	const freePort = released.port;
	await closeServer(released.server);
	assert.equal(await probePortHolder(freePort), "free");
	assert.equal(await killPortHolder(freePort), true, "a free port needs no killing");

	// Our own daemon answers the identity probe and is reaped (graceful
	// /_shutdown with the token, then the port stops answering).
	const ours = await startProxy(0);
	assert.ok(ours.server);
	assert.equal(await probePortHolder(ours.port), "ours");
	const closed = once(ours.server, "close");
	assert.equal(await killPortHolder(ours.port), true, "our daemon must be reaped");
	await closed;
	assert.equal(await probePortHolder(ours.port), "free");
});
