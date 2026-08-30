/**
 * User-flow test environment bootstrap (side-effect module).
 *
 * MUST be imported as the FIRST import of test/user-flow.test.ts. It derives the
 * proxy-port env key, the unsafe-relay env key, and the log-level env key from
 * src/config.ts / src/logger.ts source (never retyping redacted identifiers)
 * and sets them BEFORE src/config.ts is evaluated, so the extension's initial
 * proxy binds a dedicated test port instead of probing/reusing a possibly
 * running real daemon on 28180/18080, and http loopback relays are accepted.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const configSrc = fs.readFileSync(path.join(rootDir, "src", "config.ts"), "utf8");
const loggerSrc = fs.readFileSync(path.join(rootDir, "src", "logger.ts"), "utf8");

// Proxy port env key (dot-access: `process.env.<KEY>_PORT`).
const portMatch = /process\.env\.([A-Z0-9_]+)_PORT/.exec(configSrc);
if (!portMatch) throw new Error("src/config.ts must read a *_PORT env var");

// Unsafe-relay env key is a quoted constant value (`ALLOW_UNSAFE_RELAY_ENV = "…"`).
const unsafeMatch = /ALLOW_UNSAFE_RELAY_ENV\s*=\s*"([^"]+)"/.exec(configSrc);
if (!unsafeMatch) throw new Error("src/config.ts must define ALLOW_UNSAFE_RELAY_ENV const");

// Log level env key (dot-access: `process.env.<KEY>_LOG_LEVEL`); forced to debug
// so the proxy's direct path still emits a per-request log line in tests.
const logLevelMatch = /process\.env\.([A-Z0-9_]+)_LOG_LEVEL/.exec(loggerSrc);
if (!logLevelMatch) throw new Error("src/logger.ts must read a *_LOG_LEVEL env var");

/** Alternate test port — never 28180/18080, so a real daemon is not reused. */
export const TEST_PROXY_PORT = 29751;

// Re-route the proxy port, relax relay URL validation (http loopback relays),
// and enable debug logging so proxy requests are recorded in the sandbox log.
process.env[portMatch[1] + "_PORT"] = String(TEST_PROXY_PORT);
process.env[unsafeMatch[1]] = "1";
process.env[logLevelMatch[1] + "_LOG_LEVEL"] = "debug";
