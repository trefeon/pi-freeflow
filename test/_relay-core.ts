/**
 * Test helper: execute the generated relay-template core instead of matching
 * its source text, so the SSRF whitelist, private-host guard and path resolver
 * are asserted as behavior.
 *
 * Mirrors the coreOf/loadCore pattern in test/deploy-templates.test.ts, shared
 * so every test file that cares about the guards runs all three templates
 * through the same loader.
 */
export type RelayCore = {
	resolveRelayTarget: (
		target: string,
		relayPath: unknown,
	) => { ok: boolean; url?: string; status?: number; reason?: string };
	isPrivateHostname: (host: unknown) => boolean;
	relayHandler: (req: { method: string; headers: Headers; body?: BodyInit | null }) => Promise<Response>;
};

/** Compile one generated template's shared core; the platform wrapper is dropped. */
export function loadRelayCore(src: string): RelayCore {
	for (const marker of ["\nexport const config", "\nexport default", "\nDeno.serve"]) {
		const at = src.indexOf(marker);
		if (at !== -1) {
			const core = src.slice(0, at);
			const fn = new Function(`${core}; return { resolveRelayTarget, isPrivateHostname, relayHandler };`);
			return fn() as RelayCore;
		}
	}
	throw new Error("unknown relay template wrapper");
}
