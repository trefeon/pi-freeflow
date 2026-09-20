import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	BUNDLED_CLINE_WORKOS_CLIENT_ID,
	CLINE_WORKOS_CLIENT_ID_ENV,
	deriveExpiry,
	pollDeviceToken,
	refreshClineToken,
	registerClineToken,
	resolveClineWorkosClientId,
	startDeviceAuth,
	toApiKey,
	ClineAuthError,
	type FetchImpl,
} from "../src/cline-device-auth.ts";

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

function b64url(obj: unknown): string {
	return Buffer.from(JSON.stringify(obj), "utf8").toString("base64url");
}

describe("toApiKey", () => {
	it("adds the workos: prefix once", () => {
		assert.equal(toApiKey("abc"), "workos:abc");
		assert.equal(toApiKey("workos:abc"), "workos:abc");
		assert.equal(toApiKey("WorkOS:abc"), "WorkOS:abc");
		assert.equal(toApiKey("  abc  "), "workos:abc");
	});
});

describe("client id", () => {
	it("bundles the prod default and lets the env win", () => {
		assert.equal(BUNDLED_CLINE_WORKOS_CLIENT_ID, "client_01K3A541FN8TA3EPPHTD2325AR");
		const prev = process.env[CLINE_WORKOS_CLIENT_ID_ENV];
		process.env[CLINE_WORKOS_CLIENT_ID_ENV] = "client_override";
		try {
			assert.equal(resolveClineWorkosClientId(), "client_override");
		} finally {
			if (prev === undefined) delete process.env[CLINE_WORKOS_CLIENT_ID_ENV];
			else process.env[CLINE_WORKOS_CLIENT_ID_ENV] = prev;
		}
		assert.equal(resolveClineWorkosClientId(), BUNDLED_CLINE_WORKOS_CLIENT_ID);
	});
});

describe("deriveExpiry", () => {
	it("prefers explicit server expiry, then JWT exp, then expired", () => {
		const jwt = `h.${b64url({ exp: 4_000_000_000 })}.s`;
		assert.equal(deriveExpiry(1_700_000_000_000, jwt), 1_700_000_000_000);
		assert.equal(deriveExpiry(undefined, jwt), 4_000_000_000_000);
		assert.ok(deriveExpiry(undefined, "opaque") <= Date.now());
	});
});

describe("startDeviceAuth", () => {
	it("posts client_id and maps the device response", async () => {
		let seenBody = "";
		const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
			seenBody = String(init?.body ?? "");
			return jsonResponse({
				device_code: "dev-1",
				user_code: "USER-1",
				verification_uri: "https://x.example/activate",
				verification_uri_complete: "https://x.example/activate?code=USER-1",
				expires_in: 600,
				interval: 5,
			});
		}) as FetchImpl;
		const out = await startDeviceAuth("https://api.workos.com", fetchImpl);
		assert.equal(out.deviceCode, "dev-1");
		assert.equal(out.userCode, "USER-1");
		assert.ok(out.verificationUriComplete?.includes("USER-1"));
		assert.match(seenBody, /client_id=/);
	});

	it("throws ClineAuthError on non-ok", async () => {
		const fetchImpl = (async () =>
			jsonResponse({ error: "bad", error_description: "nope" }, 400)) as FetchImpl;
		await assert.rejects(startDeviceAuth("https://b.example", fetchImpl), (e: unknown) => {
			if (!(e instanceof ClineAuthError)) throw e;
			assert.equal(e.name, "ClineAuthError");
			assert.equal(e.status, 400);
			return true;
		});
	});

	it("throws on malformed device response", async () => {
		const fetchImpl = (async () => jsonResponse({ device_code: "only" })) as FetchImpl;
		await assert.rejects(
			startDeviceAuth("https://b.example", fetchImpl),
			/Invalid WorkOS device authorization response/,
		);
	});
});

describe("pollDeviceToken", () => {
	it("requires deviceCode", async () => {
		await assert.rejects(pollDeviceToken("https://b.example", ""), /deviceCode is required/);
	});

	it("returns tokens on success", async () => {
		const fetchImpl = (async () =>
			jsonResponse({ access_token: "a", refresh_token: "r" })) as FetchImpl;
		const out = await pollDeviceToken("https://b.example", "dev-1", 5, {
			fetchImpl,
			maxWaitMs: 5_000,
		});
		assert.deepEqual(out, { accessToken: "a", refreshToken: "r" });
	});

	it("polls through pending then succeeds", async () => {
		let calls = 0;
		const fetchImpl = (async () => {
			calls += 1;
			if (calls === 1) return jsonResponse({ error: "authorization_pending" }, 400);
			return jsonResponse({ access_token: "a", refresh_token: "r" });
		}) as FetchImpl;
		const out = await pollDeviceToken("https://b.example", "dev-1", 1, {
			fetchImpl,
			timeoutMs: 5_000,
			maxWaitMs: 30_000,
		});
		assert.equal(out.accessToken, "a");
		assert.equal(calls, 2);
	});

	it("backs off on slow_down (extra delay, still succeeds)", async () => {
		const delays: number[] = [];
		const origSetTimeout = globalThis.setTimeout;
		// @ts-expect-error capture delay args only
		globalThis.setTimeout = (fn: (...a: never[]) => void, ms?: number, ...rest: never[]) => {
			delays.push(ms ?? 0);
			return origSetTimeout(fn, 0, ...rest);
		};
		try {
			let calls = 0;
			const fetchImpl = (async () => {
				calls += 1;
				if (calls === 1) return jsonResponse({ error: "slow_down" }, 400);
				return jsonResponse({ access_token: "a", refresh_token: "r" });
			}) as FetchImpl;
			const out = await pollDeviceToken("https://b.example", "dev-1", 1, {
				fetchImpl,
				timeoutMs: 5_000,
				maxWaitMs: 30_000,
			});
			assert.equal(out.refreshToken, "r");
			assert.equal(delays[0], 2000);
		} finally {
			globalThis.setTimeout = origSetTimeout;
		}
	});

	it("maps denied to ClineAuthError with errorCode", async () => {
		const fetchImpl = (async () =>
			jsonResponse({ error: "access_denied", error_description: "user said no" }, 400)) as FetchImpl;
		const err = await pollDeviceToken("https://b.example", "dev-1", 5, {
			fetchImpl,
			maxWaitMs: 5_000,
		}).catch((e: unknown) => e);
		if (!(err instanceof ClineAuthError)) throw err;
		assert.equal(err.errorCode, "access_denied");
	});

	it("maps expired_token to ClineAuthError", async () => {
		const fetchImpl = (async () => jsonResponse({ error: "expired_token" }, 400)) as FetchImpl;
		await assert.rejects(
			pollDeviceToken("https://b.example", "dev-1", 5, { fetchImpl, maxWaitMs: 5_000 }),
			(e: unknown) => {
				assert.ok(e && typeof e === "object" && "errorCode" in e);
				assert.equal(e.errorCode, "expired_token");
				return true;
			},
		);
	});

	it("honours cooperative cancel", async () => {
		const controller = new AbortController();
		const fetchImpl = (async () => {
			controller.abort();
			return jsonResponse({ error: "authorization_pending" }, 400);
		}) as FetchImpl;
		await assert.rejects(
			pollDeviceToken("https://b.example", "dev-1", 5, {
				fetchImpl,
				maxWaitMs: 30_000,
				signal: controller.signal,
			}),
			(e: unknown) => {
				assert.ok(e && typeof e === "object" && "errorCode" in e);
				assert.equal(e.errorCode, "cancelled");
				return true;
			},
		);
	});
});

function tokenData(overrides: Record<string, unknown> = {}): unknown {
	return {
		success: true,
		data: {
			accessToken: "access-1",
			refreshToken: "refresh-1",
			tokenType: "Bearer",
			expiresAt: new Date(Date.now() + 3600_000).toISOString(),
			userInfo: { email: "a@example.com", clineUserId: "acct-1" },
			...overrides,
		},
	};
}

describe("registerClineToken", () => {
	it("maps the register response to credentials", async () => {
		const fetchImpl = (async () => jsonResponse(tokenData())) as FetchImpl;
		const creds = await registerClineToken("https://api.example", "workos-a", "workos-r", fetchImpl);
		assert.equal(creds.access, "access-1");
		assert.equal(creds.refresh, "refresh-1");
		assert.equal(creds.accountId, "acct-1");
		assert.ok(creds.expires > Date.now());
	});

	it("requires both tokens", async () => {
		const fetchImpl = (async () => jsonResponse(tokenData())) as FetchImpl;
		await assert.rejects(
			registerClineToken("https://api.example", "", "r", fetchImpl),
			/accessToken and refreshToken are required/,
		);
	});

	it("throws ClineAuthError on non-ok", async () => {
		const fetchImpl = (async () => new Response("bad", { status: 401 })) as FetchImpl;
		await assert.rejects(registerClineToken("https://api.example", "a", "r", fetchImpl), (e: unknown) => {
			if (!(e instanceof ClineAuthError)) throw e;
			assert.equal(e.name, "ClineAuthError");
			assert.equal(e.status, 401);
			return true;
		});
	});
});

describe("refreshClineToken", () => {
	it("falls back to the passed refresh token and derives JWT expiry", async () => {
		const jwt = `h.${b64url({ exp: 4_000_000_000 })}.s`;
		const fetchImpl = (async () =>
			jsonResponse(
				tokenData({ accessToken: jwt, refreshToken: undefined, expiresAt: "not-a-date" }),
			)) as FetchImpl;
		const creds = await refreshClineToken("https://api.example", "keep-me", fetchImpl);
		assert.equal(creds.refresh, "keep-me");
		assert.equal(creds.expires, 4_000_000_000_000);
	});

	it("throws ClineAuthError on non-ok", async () => {
		const fetchImpl = (async () => new Response("gone", { status: 410 })) as FetchImpl;
		await assert.rejects(refreshClineToken("https://api.example", "r", fetchImpl), (e: unknown) => {
			assert.ok(e && typeof e === "object" && "status" in e);
			assert.equal(e.status, 410);
			return true;
		});
	});
});
