/**
 * pi-freeflow — Pi & Oh My Pi (OMP) Extension Entrypoint
 *
 * Lightweight bridge re-exporting the modular codebase rooted in src/
 */

import { checkForUpdateInBackground } from "../src/update-checker.ts";
import originalDefault from "../src/index.ts";
import type { ExtensionAPI } from "../src/types.ts";

export default async function (pi: ExtensionAPI): Promise<void> {
	try {
		const r = checkForUpdateInBackground() as unknown as Promise<void> | void;
		if (r && typeof (r as Promise<void>).catch === "function") {
			(r as Promise<void>).catch(() => {});
		}
	} catch {
		// swallow — never block activation
	}
	return originalDefault(pi);
}

export * from "../src/index.ts";
