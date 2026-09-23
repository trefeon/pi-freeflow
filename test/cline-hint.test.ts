/**
	* User-facing wording for Cline marker errors. When a roll tried every saved
	* login and every one of them answered the daily free cap, the hint must say
	* that — the old "for this login" line hides that another login, or another
	* model, is the way out.
	*/
import test from "node:test";
import assert from "node:assert/strict";
import { mapClineError } from "../src/proxy.ts";

/** Captured live 2026-09-22 from a saved login sitting on the daily free cap. */
const LIVE_LIMIT_BODY =
	'{"error":{"code":"INFERENCE_CAP_ERROR","message":"Error 429: Daily free limit reached on model deepseek/deepseek-v4.1-flash. Try again in 20h 4m"}}';

test("mapClineError: a single-login 429 keeps the generic wording", () => {
	const out = JSON.parse(mapClineError(429, LIVE_LIMIT_BODY)) as { hint: string; error: { code: string } };
	assert.equal(out.error.code, "INFERENCE_CAP_ERROR");
	assert.ok(out.hint.includes("for this login"), out.hint);
});

test("mapClineError: an all-logins cap names every login and the nearest reset", () => {
	const resetAt = Date.now() + (20 * 60 + 4) * 60_000;
	const out = JSON.parse(mapClineError(429, LIVE_LIMIT_BODY, { logins: 3, resetAt })) as { hint: string };
	assert.ok(out.hint.includes("used up on all 3 saved logins"), out.hint);
	assert.ok(out.hint.includes("Nearest reset in about 20h 4m"), out.hint);
	assert.ok(out.hint.includes("Switch models"), out.hint);
	assert.ok(out.hint.includes("/freeflow cline login"), out.hint);
});

test("mapClineError: a cap with no stated reset still names the logins", () => {
	const out = JSON.parse(mapClineError(429, LIVE_LIMIT_BODY, { logins: 2, resetAt: null })) as { hint: string };
	assert.ok(out.hint.includes("used up on all 2 saved logins"), out.hint);
	assert.ok(out.hint.includes("Switch models"), out.hint);
	assert.ok(!out.hint.includes("reset"), out.hint);
});

test("mapClineError: other statuses keep their own hint", () => {
	const out = JSON.parse(mapClineError(403, "{}", { logins: 3, resetAt: Date.now() + 60_000 })) as { hint: string };
	assert.ok(out.hint.includes("Cline refused this request"), out.hint);
	assert.ok(!out.hint.includes("saved logins"), out.hint);
});

test("mapClineError: a non-JSON body passes through untouched", () => {
	assert.equal(mapClineError(429, "not json", { logins: 3, resetAt: null }), "not json");
});

test("mapClineError: guidance is visible in error.message, not only the hint sibling", () => {
	const resetAt = Date.now() + (20 * 60 + 4) * 60_000;
	const out = JSON.parse(mapClineError(429, LIVE_LIMIT_BODY, { logins: 3, resetAt })) as {
		hint: string;
		error: { code: string; message: string };
	};
	assert.ok(out.error.message.includes("Daily free limit reached"), "upstream text survives");
	assert.ok(out.error.message.includes("used up on all 3 saved logins"), "guidance is host-visible");
	assert.ok(out.error.message.includes("Switch models"), "next step is host-visible");

	const single = JSON.parse(mapClineError(429, LIVE_LIMIT_BODY)) as {
		hint: string;
		error: { message: string };
	};
	assert.ok(single.error.message.includes("for this login"), single.error.message);
});
