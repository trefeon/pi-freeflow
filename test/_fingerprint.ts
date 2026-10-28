/**
 * Test adapter: the fingerprint-injection contract, expressed against the LIVE
 * implementation.
 *
 * The live lane injects the verbatim 11-tool roster
 * (`ensureChat/Responses/MessagesFull11Tools`, via enforceOpencodeFingerprint
 * in production); this wraps that in a pure array-in/array-out shape so the
 * translation tests can stay readable.
 */
import {
	ensureChatFull11Tools,
	ensureMessagesFull11Tools,
	ensureResponsesFull11Tools,
} from "../src/opencode-fingerprint.ts";

export function withFingerprintTools(
	tools: Record<string, unknown>[],
	pathname: string,
): Record<string, unknown>[] {
	const body: Record<string, unknown> = { tools };
	if (pathname.endsWith("/responses")) ensureResponsesFull11Tools(body);
	else if (pathname.endsWith("/messages")) ensureMessagesFull11Tools(body);
	else ensureChatFull11Tools(body);
	return body.tools as Record<string, unknown>[];
}
