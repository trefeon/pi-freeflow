/**
 * Relay reachability probe: verifies a deployed relay answers requests
 * by issuing a minimal round trip through it and timing the response.
 */

export interface RelayProbeResult {
	ok: boolean;
	status: number;
	latencyMs: number;
	error?: string;
}

/**
 * Probe a relay endpoint to confirm it is reachable.
 *
 * Sends a minimal request to `<url>/v1/models` carrying the x-relay-target /
 * x-relay-path headers the relay expects, timing the round trip. Never
 * throws: network failures, timeouts, and non-2xx statuses are all reported
 * on the returned result instead.
 */
export async function probeRelay(url: string): Promise<RelayProbeResult> {
	const cleanUrl = url.trim().replace(/\/+$/, "");
	const start = Date.now();
	try {
		const res = await fetch(`${cleanUrl}/v1/models`, {
			headers: {
				"x-relay-target": "https://opencode.ai",
				"x-relay-path": "/v1/models",
			},
			signal: AbortSignal.timeout(5_000),
		});
		return { ok: res.ok, status: res.status, latencyMs: Date.now() - start };
	} catch (e) {
		return {
			ok: false,
			status: 0,
			latencyMs: Date.now() - start,
			error: (e as Error)?.message || String(e),
		};
	}
}
