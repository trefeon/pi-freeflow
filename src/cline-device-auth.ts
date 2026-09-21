/**
 * Cline WorkOS device-flow auth (extension login, no paste).
 * Mirrors C:/tmp/cline-login-proto/src/cline-auth.ts + reference/cline
 * sdk/packages/core/src/auth/cline.ts (device authorize / poll /
 * register / refresh) and provider-auth-registry.ts (expiry derive,
 * workos: prefix). All network goes through injectable fetchImpl;
 * mocked tests only, no live calls here.
 */

import { fetchWithSystemCA } from "./system-ca-fetch.ts";

export interface OAuthCredentials {
 access: string;
 refresh: string;
 /** Expiration timestamp in milliseconds since epoch. */
 expires: number;
 accountId?: string;
 email?: string;
 metadata?: Record<string, unknown>;
}

export interface DeviceAuth {
 deviceCode: string;
 userCode: string;
 verificationUri: string;
 verificationUriComplete?: string;
 expiresIn: number;
 interval: number;
}

export interface DevicePollTokens {
 accessToken: string;
 refreshToken: string;
}

export interface PollOptions {
 timeoutMs?: number;
 maxWaitMs?: number;
 fetchImpl?: FetchImpl;
 /** Cooperative cancel from the login UI (esc / timeout). */
 signal?: AbortSignal;
}

export const DEFAULT_WORKOS_BASE = "https://api.workos.com";
export const DEFAULT_API_BASE = "https://api.cline.bot";
export const WORKOS_TOKEN_PREFIX = "workos:";

/** Env override for the WorkOS client id (wins over the bundled default). */
export const CLINE_WORKOS_CLIENT_ID_ENV = "PI_FREEFLOW_CLINE_WORKOS_CLIENT_ID";

/**
 * Bundled production client id (reference shared/src/runtime/cline-environment.ts,
 * production entry). Env override wins when set and non-blank.
 */
export const BUNDLED_CLINE_WORKOS_CLIENT_ID = "client_01K3A541FN8TA3EPPHTD2325AR";

export function resolveClineWorkosClientId(): string {
 const fromEnv = process.env[CLINE_WORKOS_CLIENT_ID_ENV]?.trim();
 if (fromEnv) return fromEnv;
 return BUNDLED_CLINE_WORKOS_CLIENT_ID;
}

/**
 * Wire form of a Cline credential. Cline OAuth access tokens are WorkOS JWTs
 * (base64url eyJ header) and must ride as workos:<jwt>; dashboard API keys
 * (clp_ apikey category) go verbatim — prefixing them 401s. Mirrors the
 * 9router getClineAccessToken guard (open-sse/shared/clineAuth.js).
 */
export function isWorkosJwt(token: string): boolean {
 return /^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/.test(token.trim());
}

export function toApiKey(accessToken: string): string {
 const token = accessToken.trim();
 if (token.toLowerCase().startsWith(WORKOS_TOKEN_PREFIX)) return token;
 return isWorkosJwt(token) ? `${WORKOS_TOKEN_PREFIX}${token}` : token;
}

const DEVICE_AUTHORIZATION_PATH = "/user_management/authorize/device";
const AUTHENTICATE_PATH = "/user_management/authenticate";
const REGISTER_PATH = "/api/v1/auth/register";
const REFRESH_PATH = "/api/v1/auth/refresh";

const HTTP_TIMEOUT_MS = 30 * 1000;

export type FetchImpl = (input: string, init?: RequestInit) => Promise<Response>;

function joinUrl(base: string, path: string): string {
 return base.replace(/\/+$/, "") + path;
}

export class ClineAuthError extends Error {
 readonly status?: number;
 readonly errorCode?: string;
 constructor(message: string, opts?: { status?: number; errorCode?: string }) {
  super(message);
  this.name = "ClineAuthError";
  this.status = opts?.status;
  this.errorCode = opts?.errorCode;
 }
}

function toEpochMs(isoDateTime: string): number {
 const epoch = Date.parse(isoDateTime);
 if (Number.isNaN(epoch)) {
  throw new Error(`Invalid expiresAt value: ${isoDateTime}`);
 }
 return epoch;
}

function toSeconds(value: unknown, fallback: number): number {
 if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
 return fallback;
}

function decodeJwtExpMs(accessToken: string): number | null {
 try {
  const parts = accessToken.split(".");
  if (parts.length < 2) return null;
  const payload = JSON.parse(
   Buffer.from(parts[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"),
  ) as { exp?: unknown };
  if (typeof payload.exp === "number" && payload.exp > 0) return payload.exp * 1000;
  return null;
 } catch {
  return null;
 }
}

// Expiry derivation order (per registry deriveCredentialExpiry):
// explicit server expiry -> JWT exp claim -> already-expired (forces refresh).
export function deriveExpiry(explicitMs: number | undefined, accessToken: string): number {
 if (typeof explicitMs === "number" && Number.isFinite(explicitMs) && explicitMs > 0) return explicitMs;
 return decodeJwtExpMs(accessToken) ?? Date.now() - 1;
}

export async function startDeviceAuth(
 workosBase: string = DEFAULT_WORKOS_BASE,
 fetchImpl: FetchImpl = fetchWithSystemCA,
): Promise<DeviceAuth> {
 const response = await fetchImpl(joinUrl(workosBase, DEVICE_AUTHORIZATION_PATH), {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ client_id: resolveClineWorkosClientId() }),
  signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
 });
 const json = (await response.json().catch(() => ({}))) as Record<string, unknown>;
 if (!response.ok) {
  throw new ClineAuthError(
   `Device authorization failed: ${response.status}` +
   (typeof json.error_description === "string" ? ` - ${json.error_description}` : ""),
   { status: response.status, errorCode: typeof json.error === "string" ? json.error : undefined },
  );
 }
 if (
  typeof json.device_code !== "string" ||
  typeof json.user_code !== "string" ||
  typeof json.verification_uri !== "string"
 ) {
  throw new Error("Invalid WorkOS device authorization response");
 }
 return {
  deviceCode: json.device_code,
  userCode: json.user_code,
  verificationUri: json.verification_uri,
  verificationUriComplete:
   typeof json.verification_uri_complete === "string" ? json.verification_uri_complete : undefined,
  expiresIn: toSeconds(json.expires_in, 300),
  interval: toSeconds(json.interval, 5),
 };
}

function throwDenied(payload: Record<string, unknown>, status: number, fallback: string): never {
 const code = typeof payload.error === "string" ? payload.error : undefined;
 const detail = typeof payload.error_description === "string" ? payload.error_description : fallback;
 throw new ClineAuthError(detail, { status, errorCode: code });
}

export async function pollDeviceToken(
 workosBase: string = DEFAULT_WORKOS_BASE,
 deviceCode = "",
 intervalSeconds = 5,
 options?: PollOptions,
): Promise<DevicePollTokens> {
 if (!deviceCode) throw new Error("deviceCode is required");
 const fetchFn = options?.fetchImpl ?? fetchWithSystemCA;
 const outerSignal = options?.signal;
 const deadline = Date.now() + (options?.maxWaitMs ?? intervalSeconds * 1000 * 60 * 10);
 let interval = Math.max(1, intervalSeconds);
 for (; ;) {
  if (outerSignal?.aborted) {
   throw new ClineAuthError("Device login cancelled", { errorCode: "cancelled" });
  }
  let response: Response;
  try {
   response = await fetchFn(joinUrl(workosBase, AUTHENTICATE_PATH), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
     grant_type: "urn:ietf:params:oauth:grant-type:device_code",
     device_code: deviceCode,
     client_id: resolveClineWorkosClientId(),
    }),
    signal: AbortSignal.timeout(options?.timeoutMs ?? HTTP_TIMEOUT_MS),
   });
  } catch (error) {
   if (outerSignal?.aborted) {
    throw new ClineAuthError("Device login cancelled", { errorCode: "cancelled" });
   }
   if (error instanceof ClineAuthError) throw error;
   if (Date.now() > deadline) throw new Error("WorkOS device authorization timed out");
   await sleepMs(remainingMs(deadline, interval), outerSignal);
   continue;
  }
  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (response.ok) {
   if (typeof payload.access_token !== "string" || typeof payload.refresh_token !== "string") {
    throw new Error("Invalid WorkOS token response");
   }
   return { accessToken: payload.access_token, refreshToken: payload.refresh_token };
  }
  if (payload.error === "authorization_pending") {
   // keep polling at the current interval
  } else if (payload.error === "slow_down") {
   interval += 1;
  } else if (
   payload.error === "access_denied" ||
   payload.error === "expired_token" ||
   payload.error === "invalid_grant"
  ) {
   throwDenied(payload, response.status, `Device login refused (${String(payload.error)})`);
  } else if (response.status >= 500 || response.status === 429) {
   // Transient WorkOS blip: keep polling until the code's own deadline rather
   // than failing a login that would have succeeded seconds later.
  } else {
   throw new ClineAuthError(
    typeof payload.error_description === "string"
     ? String(payload.error_description)
     : `WorkOS token polling failed: ${response.status}`,
    { status: response.status, errorCode: typeof payload.error === "string" ? payload.error : undefined },
   );
  }
  if (Date.now() > deadline) throw new Error("WorkOS device authorization timed out");
  await sleepMs(remainingMs(deadline, interval), outerSignal);
 }
}

/**
 * Wait before the next poll, never past the device code's own expiry: a
 * `slow_down` reply grows the interval, and sleeping the full interval after
 * the deadline check would keep a dead login alive for minutes.
 */
function remainingMs(deadline: number, intervalSeconds: number): number {
 return Math.max(0, Math.min(intervalSeconds * 1000, deadline - Date.now()));
}

async function sleepMs(ms: number, signal?: AbortSignal): Promise<void> {
 if (signal?.aborted) throw new ClineAuthError("Device login cancelled", { errorCode: "cancelled" });
 if (!signal) {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  await promise;
  return;
 }
 const { promise, resolve, reject } = Promise.withResolvers<void>();
 const onAbort = (): void => {
  clearTimeout(timer);
  reject(new ClineAuthError("Device login cancelled", { errorCode: "cancelled" }));
 };
 const timer = setTimeout(() => {
  signal.removeEventListener("abort", onAbort);
  resolve();
 }, ms);
 signal.addEventListener("abort", onAbort, { once: true });
 await promise;
}

interface ClineTokenData {
 accessToken: string;
 refreshToken?: string;
 tokenType: string;
 expiresAt: string;
 userInfo?: { email?: string; clineUserId?: string | null };
}

function toCredentials(data: ClineTokenData, fallbackRefresh?: string): OAuthCredentials {
 const refresh = data.refreshToken ?? fallbackRefresh;
 if (!refresh) throw new Error("Token response did not include a refresh token");
 let explicit: number | undefined;
 try {
  explicit = toEpochMs(data.expiresAt);
 } catch {
  explicit = undefined;
 }
 return {
  access: data.accessToken,
  refresh,
  expires: deriveExpiry(explicit, data.accessToken),
  accountId: data.userInfo?.clineUserId ?? undefined,
  email: data.userInfo?.email || undefined,
  metadata: { tokenType: data.tokenType },
 };
}

async function readTokenData(response: Response, message: string): Promise<ClineTokenData> {
 const json = (await response.json().catch(() => ({}))) as {
  success?: boolean;
  data?: ClineTokenData;
 };
 if (!json.success || !json.data?.accessToken) {
  throw new Error(`Invalid token response: ${message}`);
 }
 return json.data;
}

export async function registerClineToken(
 apiBase: string = DEFAULT_API_BASE,
 accessToken = "",
 refreshToken = "",
 fetchImpl: FetchImpl = fetchWithSystemCA,
): Promise<OAuthCredentials> {
 if (!accessToken || !refreshToken) throw new Error("accessToken and refreshToken are required");
 const response = await fetchImpl(joinUrl(apiBase, REGISTER_PATH), {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ accessToken, refreshToken }),
  signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
 });
 if (!response.ok) {
  const text = await response.text().catch(() => "");
  throw new ClineAuthError(`Token registration failed: ${response.status}${text ? ` - ${text}` : ""}`, {
   status: response.status,
  });
 }
 return toCredentials(await readTokenData(response, "register"));
}

export async function refreshClineToken(
 apiBase: string = DEFAULT_API_BASE,
 refreshToken = "",
 fetchImpl: FetchImpl = fetchWithSystemCA,
): Promise<OAuthCredentials> {
 if (!refreshToken) throw new Error("refreshToken is required");
 const response = await fetchImpl(joinUrl(apiBase, REFRESH_PATH), {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ refreshToken, grantType: "refresh_token" }),
  signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
 });
 if (!response.ok) {
  const text = await response.text().catch(() => "");
  throw new ClineAuthError(`Token refresh failed: ${response.status}${text ? ` - ${text}` : ""}`, {
   status: response.status,
  });
 }
 return toCredentials(await readTokenData(response, "refresh"), refreshToken);
}
