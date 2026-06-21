/**
 * Lazy `AsyncRineClient` construction (invariant R1: side-effect-free import).
 *
 * No client is built at module load. The SDK client is created the first time a
 * tool's `execute` (or a channel handler) actually fires, then memoized per
 * distinct `(configDir, apiUrl)` pair so every rine surface in one Eve process
 * shares ONE client (the client holds no sockets, so sharing is cheap and keeps
 * the OAuth token cache warm). The acting `agent` is applied per-call via a cheap
 * derived `client.withAgent(...)`, never a separate base client.
 *
 * Two footguns the SDK leaves to the caller are closed here:
 *   - `configDir` defaults to `""` in the SDK constructor → it would silently
 *     read/write keys against `process.cwd()`. We resolve it via
 *     `resolveConfigDir()` (env `RINE_CONFIG_DIR` → `~/.config/rine` → cwd/.rine).
 *   - the SDK ignores `RINE_API_URL`; we resolve `apiUrl` via `resolveApiUrl()`.
 */

import { resolveApiUrl, resolveConfigDir } from "@rine-network/core";
import { AsyncRineClient } from "@rine-network/sdk";

/** Per-call client overrides; when omitted, env/config resolution applies. */
export interface RineClientOpts {
	/** Explicit config dir; when omitted, `resolveConfigDir()` is used. */
	configDir?: string;
	/** Explicit API URL; when omitted, `resolveApiUrl()` is used. */
	apiUrl?: string;
	/** Acting agent (handle/name/UUID) sent as `X-Rine-Agent` on every request. */
	agent?: string;
}

const clientCache = new Map<string, AsyncRineClient>();

function cacheKey(configDir: string, apiUrl: string): string {
	return `${configDir} ${apiUrl}`;
}

/**
 * Get (or lazily build + memoize) the shared `AsyncRineClient` for `opts`,
 * already scoped to `opts.agent` when present. Call ONLY from inside a tool
 * `execute` / a channel handler — never at module top level (R1).
 */
export function getRineClient(opts: RineClientOpts = {}): AsyncRineClient {
	const configDir = opts.configDir ?? resolveConfigDir();
	const apiUrl = opts.apiUrl ?? resolveApiUrl();
	const key = cacheKey(configDir, apiUrl);

	let base = clientCache.get(key);
	if (!base) {
		base = new AsyncRineClient({ configDir, apiUrl });
		clientCache.set(key, base);
	}

	// `withAgent` returns a cheap derived client sharing creds + token cache.
	return opts.agent ? base.withAgent(opts.agent) : base;
}

/** Test-only: drop all memoized clients (not part of the public surface). */
export function _resetClientCache(): void {
	clientCache.clear();
}
