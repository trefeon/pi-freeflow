/**
 * Unit tests for the relay reachability probe (src/probe.ts).
 *
 * globalThis.fetch is stubbed per test and restored in a finally block, so
 * no real network traffic leaves the machine. Covers success, non-2xx
 * status, network rejection, an abort (AbortError), and URL normalization.
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
 canonicalizeIpv6Block,
 egressIdentityKey,
 parseTraceResponse,
 probePoolEgress,
 probeRelay,
 probeRelayEgress,
} from "../src/probe.ts";

/** Minimal stand-in Response: probeRelay only reads ok and status. */
function fakeResponse(ok: boolean, status: number): Response {
 return { ok, status } as Response;
}

/** Resolve the URL string from whatever RequestInfo fetch receives. */
function requestUrl(input: RequestInfo | URL): string {
 if (typeof input === "string") return input;
 if (input instanceof URL) return input.href;
 return input.url;
}

test("probeRelay reports ok + latency for a 200 and sends the expected request", async () => {
 const realFetch = globalThis.fetch;
 try {
  let calledUrl = "";
  let calledInit: RequestInit | undefined;
  globalThis.fetch = (async (
   input: RequestInfo | URL,
   init?: RequestInit,
  ) => {
   calledUrl = requestUrl(input);
   calledInit = init;
   return fakeResponse(true, 200);
  }) as typeof fetch;

  const result = await probeRelay("https://relay.example.com/");

  assert.equal(result.ok, true);
  assert.equal(result.status, 200);
  assert.ok(result.latencyMs >= 0);
  assert.equal(result.error, undefined);
  // URL is <relay>/v1/models with trailing slash stripped
  assert.equal(calledUrl, "https://relay.example.com/v1/models");
  const headers = (calledInit?.headers ?? {}) as Record<string, string>;
  assert.equal(headers["x-relay-target"], "https://opencode.ai");
  assert.equal(headers["x-relay-path"], "/inference/v1/models");
  assert.ok(headers["User-Agent"]?.startsWith("opencode/"), "must include opencode User-Agent");
  assert.ok(headers["x-opencode-session"]?.startsWith("ses_"), "must include ses_ OpenCode session");
  assert.match(headers["x-opencode-request"] ?? "", /^msg_[0-9A-Za-z]{26}$/, "must send a fresh msg_* request id (live lane)");
  assert.equal(headers["x-opencode-client"], "cli");
  assert.ok(typeof headers["x-opencode-project"] === "string" && headers["x-opencode-project"].length > 0);
 } finally {
  globalThis.fetch = realFetch;
 }
});

test("probeRelay reports a non-2xx status as not ok", async () => {
 const realFetch = globalThis.fetch;
 try {
  globalThis.fetch = (async () =>
   fakeResponse(false, 403)) as typeof fetch;

  const result = await probeRelay("https://relay.example.com");

  assert.equal(result.ok, false);
  assert.equal(result.status, 403);
  assert.ok(result.latencyMs >= 0);
  assert.equal(result.error, undefined);
 } finally {
  globalThis.fetch = realFetch;
 }
});

test("probeRelay reports ok:false with an error when fetch rejects (network error)", async () => {
 const realFetch = globalThis.fetch;
 try {
  globalThis.fetch = (async () => {
   throw new Error("network down");
  }) as typeof fetch;

  const result = await probeRelay("https://relay.example.com");

  assert.equal(result.ok, false);
  assert.equal(result.status, 0);
  assert.equal(result.error, "network down");
  assert.ok(result.latencyMs >= 0);
 } finally {
  globalThis.fetch = realFetch;
 }
});

test("probeRelay reports ok:false with an error when the request aborts (AbortError)", async () => {
 const realFetch = globalThis.fetch;
 try {
  globalThis.fetch = (async () => {
   throw Object.assign(new Error("The operation was aborted."), {
    name: "AbortError",
   });
  }) as typeof fetch;

  const result = await probeRelay("https://relay.example.com");

  assert.equal(result.ok, false);
  assert.equal(result.status, 0);
  assert.equal(result.error, "The operation was aborted.");
 } finally {
  globalThis.fetch = realFetch;
 }
});

test("probeRelay trims whitespace and strips trailing slashes from the URL", async () => {
 const realFetch = globalThis.fetch;
 try {
  let calledUrl = "";
  globalThis.fetch = (async (input: RequestInfo | URL) => {
   calledUrl = requestUrl(input);
   return fakeResponse(true, 200);
  }) as typeof fetch;

  const result = await probeRelay("  https://relay.example.com///  ");

  assert.equal(result.ok, true);
  assert.equal(calledUrl, "https://relay.example.com/v1/models");
 } finally {
  globalThis.fetch = realFetch;
 }
});

test("probeRelay sends direct opencode request without relay headers when target is opencode", async () => {
 const realFetch = globalThis.fetch;
 try {
  let calledUrl = "";
  let calledInit: RequestInit | undefined;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
   calledUrl = requestUrl(input);
   calledInit = init;
   return fakeResponse(true, 200);
  }) as typeof fetch;

  const result = await probeRelay("opencode");

  assert.equal(result.ok, true);
  assert.equal(calledUrl, "https://opencode.ai/inference/v1/models");
  const headers = (calledInit?.headers ?? {}) as Record<string, string>;
  assert.equal(headers["x-relay-target"], undefined, "direct opencode probe must not set x-relay-target");
  assert.ok(headers["User-Agent"]?.startsWith("opencode/"));
  assert.ok(headers["x-opencode-session"]?.startsWith("ses_"));
 } finally {
  globalThis.fetch = realFetch;
 }
});

test("probeRelay supports chat endpoint mode with ping payload and spoofing", async () => {
 const realFetch = globalThis.fetch;
 try {
  let calledUrl = "";
  let calledInit: RequestInit | undefined;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
   calledUrl = requestUrl(input);
   calledInit = init;
   return fakeResponse(true, 200);
  }) as typeof fetch;

  const result = await probeRelay("https://relay.example.com", "my-secret", {
   endpoint: "chat",
   model: "nemotron-3.5-lightning-free",
  });

  assert.equal(result.ok, true);
  assert.equal(calledUrl, "https://relay.example.com/inference/openai/v1/chat/completions", "relay probe rides the default compat lane");
  assert.equal(calledInit?.method, "POST");
  const headers = (calledInit?.headers ?? {}) as Record<string, string>;
  assert.equal(headers["x-relay-target"], "https://opencode.ai");
  assert.equal(headers["x-relay-path"], "/inference/openai/v1/chat/completions", "relay path follows the compat lane");
  assert.equal(headers["x-relay-auth"], "my-secret");
  assert.equal(headers["content-type"], "application/json");
  assert.ok(headers["x-opencode-session"]?.startsWith("ses_"));

  const parsedBody = JSON.parse(String(calledInit?.body));
  assert.equal(parsedBody.model, "nemotron-3.5-lightning-free");
  assert.equal(parsedBody.max_tokens, 1);
  // A probe must carry the same body-side gate as real traffic: without the env
  // block upstream answers 429 and a working relay would be graded as broken.
  const systemText = String(parsedBody.messages[0].content);
  assert.equal(systemText.match(/<env>[\s\S]*?<\/env>/g)?.length, 1);
  assert.match(systemText, /Working directory:/);
  assert.equal(parsedBody.stream, true);
 } finally {
  globalThis.fetch = realFetch;
 }
});

test("probeRelay supports direct opencode in chat endpoint mode", async () => {
 const realFetch = globalThis.fetch;
 try {
  let calledUrl = "";
  let calledInit: RequestInit | undefined;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
   calledUrl = requestUrl(input);
   calledInit = init;
   return fakeResponse(true, 200);
  }) as typeof fetch;

  const result = await probeRelay("direct", undefined, {
   endpoint: "chat",
  });

  assert.equal(result.ok, true);
  assert.equal(calledUrl, "https://opencode.ai/inference/openai/v1/chat/completions", "direct probe rides the default compat lane");
  assert.equal(calledInit?.method, "POST");
  const headers = (calledInit?.headers ?? {}) as Record<string, string>;
  assert.equal(headers["x-relay-target"], undefined);
  assert.ok(headers["x-opencode-session"]?.startsWith("ses_"));
  const parsedBody = JSON.parse(String(calledInit?.body));
  assert.equal(parsedBody.model, "nemotron-3.5-lightning-free");
 } finally {
  globalThis.fetch = realFetch;
 }
});

test("probeRelay retries when initial attempts fail and returns ok when a retry succeeds", async () => {
 const realFetch = globalThis.fetch;
 try {
  let calls = 0;
  const retryEvents: Array<{ attempt: number; maxRetries: number; status: number }> = [];
  globalThis.fetch = (async () => {
   calls++;
   if (calls < 3) {
    return fakeResponse(false, 404);
   }
   return fakeResponse(true, 200);
  }) as typeof fetch;

  const result = await probeRelay("https://relay.example.com", "secret", {
   retries: 3,
   retryDelayMs: 10,
   onRetry: (attempt, maxRetries, lastResult) => {
    retryEvents.push({ attempt, maxRetries, status: lastResult.status });
   },
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, 200);
  assert.equal(calls, 3);
  assert.equal(retryEvents.length, 2);
  assert.deepEqual(retryEvents[0], { attempt: 1, maxRetries: 3, status: 404 });
  assert.deepEqual(retryEvents[1], { attempt: 2, maxRetries: 3, status: 404 });
 } finally {
  globalThis.fetch = realFetch;
 }
});

test("probeRelay exhausts retries and returns the last failure if all attempts fail", async () => {
 const realFetch = globalThis.fetch;
 try {
  let calls = 0;
  const retryEvents: number[] = [];
  globalThis.fetch = (async () => {
   calls++;
   return fakeResponse(false, 404);
  }) as typeof fetch;

  const result = await probeRelay("https://relay.example.com", undefined, {
   retries: 2,
   retryDelayMs: 10,
   onRetry: (attempt) => {
    retryEvents.push(attempt);
   },
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, 404);
  assert.equal(calls, 3);
  assert.deepEqual(retryEvents, [1, 2]);
 } finally {
  globalThis.fetch = realFetch;
 }
});

test("probeRelay default chat probe rides the compat lane with stream_options", async () => {
 const realFetch = globalThis.fetch;
 try {
  let calledUrl = "";
  let calledInit: RequestInit | undefined;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
   calledUrl = requestUrl(input);
   calledInit = init;
   return fakeResponse(true, 200);
  }) as typeof fetch;

  const result = await probeRelay("https://relay.example.com", undefined, { endpoint: "chat" });

  assert.equal(result.ok, true);
  assert.equal(calledUrl, "https://relay.example.com/inference/openai/v1/chat/completions");
  const parsedBody = JSON.parse(String(calledInit?.body));
  assert.deepEqual(parsedBody.stream_options, { include_usage: true }, "default probe sends the compat marker");
 } finally {
  globalThis.fetch = realFetch;
 }
});

test("probeRelay openaiCompat:false chat probe covers the plain /v1 fallback lane", async () => {
 const realFetch = globalThis.fetch;
 try {
  let calledUrl = "";
  let calledInit: RequestInit | undefined;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
   calledUrl = requestUrl(input);
   calledInit = init;
   return fakeResponse(true, 200);
  }) as typeof fetch;

  const result = await probeRelay("https://relay.example.com", undefined, { endpoint: "chat", openaiCompat: false });

  assert.equal(result.ok, true);
  assert.equal(calledUrl, "https://relay.example.com/inference/v1/chat/completions");
  const parsedBody = JSON.parse(String(calledInit?.body));
  assert.deepEqual(parsedBody.stream_options, { include_usage: true }, "usage accounting rides both lanes");
  const systemText = String(parsedBody.messages[0].content);
  assert.equal(systemText.match(/<env>[\s\S]*?<\/env>/g)?.length, 1, "plain-lane probe still carries the env block");
 } finally {
  globalThis.fetch = realFetch;
 }
});

test("probeRelay openaiCompat chat probe rides the openai lane with stream_options and env block", async () => {
 const realFetch = globalThis.fetch;
 try {
  let calledUrl = "";
  let calledInit: RequestInit | undefined;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
   calledUrl = requestUrl(input);
   calledInit = init;
   return fakeResponse(true, 200);
  }) as typeof fetch;

  const result = await probeRelay("https://relay.example.com", undefined, {
   endpoint: "chat",
   openaiCompat: true,
  });

  assert.equal(result.ok, true);
  assert.equal(calledUrl, "https://relay.example.com/inference/openai/v1/chat/completions");
  const headers = (calledInit?.headers ?? {}) as Record<string, string>;
  assert.equal(headers["x-relay-target"], "https://opencode.ai");
  assert.equal(headers["x-relay-path"], "/inference/openai/v1/chat/completions");
  const parsedBody = JSON.parse(String(calledInit?.body));
  assert.deepEqual(parsedBody.stream_options, { include_usage: true });
  assert.equal(parsedBody.stream, true);
  const systemText = String(parsedBody.messages[0].content);
  assert.equal(systemText.match(/<env>[\s\S]*?<\/env>/g)?.length, 1, "compat probe still carries the env block");
  assert.match(systemText, /Working directory:/);
 } finally {
  globalThis.fetch = realFetch;
 }
});

test("probeRelay openaiCompat direct probe rides the openai URL with stream_options", async () => {
 const realFetch = globalThis.fetch;
 try {
  let calledUrl = "";
  let calledInit: RequestInit | undefined;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
   calledUrl = requestUrl(input);
   calledInit = init;
   return fakeResponse(true, 200);
  }) as typeof fetch;

  const result = await probeRelay("direct", undefined, {
   endpoint: "chat",
   openaiCompat: true,
  });

  assert.equal(result.ok, true);
  assert.equal(calledUrl, "https://opencode.ai/inference/openai/v1/chat/completions");
  const headers = (calledInit?.headers ?? {}) as Record<string, string>;
  assert.equal(headers["x-relay-target"], undefined);
  const parsedBody = JSON.parse(String(calledInit?.body));
  assert.deepEqual(parsedBody.stream_options, { include_usage: true });
 } finally {
  globalThis.fetch = realFetch;
 }
});

test("parseTraceResponse, canonicalizeIpv6Block, and egressIdentityKey normalize exit identities", () => {
	const parsed = parseTraceResponse("fl=999f\nip=2a09:bac5:3a10:00ab::1234\ncolo=SIN\nloc=SG\n");
	assert.deepEqual(parsed, { ip: "2a09:bac5:3a10:00ab::1234", colo: "SIN", loc: "SG" });
	assert.equal(canonicalizeIpv6Block("2a09:bac5:3a10:00ab::1234"), "2a09:bac5:3a10:ab::/64");
	assert.equal(canonicalizeIpv6Block("2a09:bac5:3a10:ab:dead:beef:1:2"), "2a09:bac5:3a10:ab::/64");
	assert.equal(egressIdentityKey("2a09:bac5:3a10:00ab::1234"), "2a09:bac5:3a10:ab::/64");
	assert.equal(egressIdentityKey("203.0.113.42"), "203.0.113.42");
	assert.equal(egressIdentityKey("not-an-ip"), "");
});

test("probeRelayEgress and probePoolEgress detect shared IPv6 /64 blocks across relays", async () => {
	const realFetch = globalThis.fetch;
	try {
		const seenHeaders: Array<Record<string, string>> = [];
		globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
			const u = requestUrl(input);
			const hdrs = (init?.headers ?? {}) as Record<string, string>;
			seenHeaders.push(hdrs);
			if (u.startsWith("https://r1.example.com")) {
				return new Response("ip=2a09:bac5:1:2::11\ncolo=SIN\nloc=SG\n", { status: 200 });
			}
			if (u.startsWith("https://r2.example.com")) {
				return new Response("ip=2a09:bac5:1:2::99\ncolo=SIN\nloc=SG\n", { status: 200 });
			}
			return new Response("ip=198.51.100.7\ncolo=SJC\nloc=US\n", { status: 200 });
		}) as typeof fetch;

		const single = await probeRelayEgress("https://r1.example.com/", "secret-1", { label: "r1" });
		assert.equal(single.ok, true);
		assert.equal(single.egressKey, "2a09:bac5:1:2::/64");
		assert.equal(seenHeaders[0]!["x-relay-target"], "https://opencode.ai");
		assert.equal(seenHeaders[0]!["x-relay-path"], "/cdn-cgi/trace");
		assert.equal(seenHeaders[0]!["x-relay-auth"], "secret-1");

		const report = await probePoolEgress([
			{ url: "https://r1.example.com", label: "r1" },
			{ url: "https://r2.example.com", label: "r2" },
			{ url: "https://r3.example.com", label: "r3" },
		]);
		assert.equal(report.entries.length, 3);
		assert.equal(report.sharedGroups.length, 1);
		assert.equal(report.sharedGroups[0]!.egressKey, "2a09:bac5:1:2::/64");
		assert.deepEqual(
			report.sharedGroups[0]!.relays.map((r) => r.label),
			["r1", "r2"],
		);
	} finally {
		globalThis.fetch = realFetch;
	}
});
