/**
 * Dev inbound pump — `npx @rine-network/eve relay`.
 *
 * `eve dev` has no public URL for the rine server to POST to, so this tiny pump
 * stands in for the cloud webhook: it polls the agent's inbox and re-POSTs each
 * new message — HMAC-signed with `RINE_WEBHOOK_SECRET` — to the LOCAL channel
 * route. It deliberately reuses the SAME inbound route + HMAC + decrypt path as
 * production; the relay only replaces the transport that carries the
 * notification, never the message handling. The body carries just the id +
 * routing fields; the channel re-reads + decrypts by id, exactly as in prod.
 */

import { resolveApiUrl } from "@rine-network/core";
import type { AsyncRineClient } from "@rine-network/sdk";
import { getRineClient } from "./client.js";
import { signRineBody } from "./hmac.js";
import type { DecryptedMessage } from "./types.js";

const DEFAULT_TARGET = "http://localhost:3000";
const DEFAULT_INBOUND_PATH = "/rine/v1/inbound";
const DEFAULT_INTERVAL_MS = 3000;

/**
 * Build the notification body the channel expects — byte-identical in shape to the
 * rine server's standard (`payload_format="rine"`) delivery
 * (`worker/delivery.py:_build_payload`), so the dev relay and prod drive ONE parse
 * path. Only `message_id` is load-bearing (the channel re-reads + decrypts by id).
 */
export function buildRelayBody(msg: DecryptedMessage, agentId = ""): string {
	return JSON.stringify({
		message_id: msg.id,
		agent_id: agentId,
		event: "message.received",
		timestamp: msg.created_at ?? "",
	});
}

/** A minimal `fetch` shape so tests can inject a stub. */
export type FetchLike = (
	url: string,
	init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ status: number }>;

export interface DrainDeps {
	client: AsyncRineClient;
	target: string;
	secret: string;
	seen: Set<string>;
	fetchImpl: FetchLike;
	log: (line: string) => void;
	limit?: number;
}

/**
 * One inbox-drain pass: fetch new messages, POST each unseen one (signed) to the
 * local route. Returns how many were forwarded. Pure of timers so it is testable.
 */
export async function drainOnce(deps: DrainDeps): Promise<number> {
	const page = await deps.client.inbox({ status: "new", limit: deps.limit ?? 50 });
	let forwarded = 0;
	for (const msg of page.items) {
		if (deps.seen.has(msg.id)) continue;
		const body = buildRelayBody(msg);
		try {
			const res = await deps.fetchImpl(deps.target, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					"x-rine-signature": signRineBody(body, deps.secret),
				},
				body,
			});
			if (res.status >= 200 && res.status < 300) {
				deps.seen.add(msg.id);
				forwarded++;
			} else if (res.status >= 400 && res.status < 500) {
				// Terminal drop (e.g. unverified / undecryptable / ignored type) —
				// retrying won't change the outcome, so stop re-POSTing this id.
				deps.seen.add(msg.id);
				deps.log(`relay: ${deps.target} dropped ${msg.id} (${res.status})`);
			} else {
				// 5xx — transient (channel not configured / read failed). Leave it
				// unseen so the next poll retries.
				deps.log(`relay: ${deps.target} transient ${res.status} for ${msg.id}`);
			}
		} catch (err) {
			deps.log(
				`relay: POST failed for ${msg.id}: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}
	return forwarded;
}

/** Options for {@link runRelay}. */
export interface RelayOptions {
	/** Base URL of the local `eve dev` server (default `http://localhost:3000`). */
	target?: string;
	/** Inbound path (default `RINE_INBOUND_PATH` env or `/rine/v1/inbound`). */
	path?: string;
	/** Poll interval in ms (default 3000). */
	intervalMs?: number;
	agent?: string;
	apiUrl?: string;
	configDir?: string;
	/** Abort to stop the loop (defaults to SIGINT). */
	signal?: AbortSignal;
	log?: (line: string) => void;
}

const sleep = (ms: number, signal?: AbortSignal) =>
	new Promise<void>((resolve) => {
		const t = setTimeout(resolve, ms);
		signal?.addEventListener("abort", () => {
			clearTimeout(t);
			resolve();
		}, { once: true });
	});

/** Run the dev relay loop until aborted. */
export async function runRelay(opts: RelayOptions = {}): Promise<void> {
	const log = opts.log ?? ((l: string) => process.stdout.write(`${l}\n`));
	const secret = process.env.RINE_WEBHOOK_SECRET;
	if (!secret) {
		throw new Error(
			"RINE_WEBHOOK_SECRET unset — set it to any shared dev secret (the channel reads the same env to verify the relay's signature).",
		);
	}
	const base = (opts.target ?? process.env.RINE_RELAY_TARGET ?? DEFAULT_TARGET).replace(/\/$/, "");
	const path = opts.path ?? process.env.RINE_INBOUND_PATH ?? DEFAULT_INBOUND_PATH;
	const target = `${base}${path}`;
	// Guard against a NaN/zero interval (e.g. `--interval abc`) that would hot-loop
	// the server; floor at 500 ms.
	const wanted = opts.intervalMs;
	const interval = Math.max(
		500,
		typeof wanted === "number" && Number.isFinite(wanted) && wanted > 0
			? wanted
			: DEFAULT_INTERVAL_MS,
	);
	const client = getRineClient({
		agent: opts.agent ?? process.env.RINE_AGENT,
		apiUrl: opts.apiUrl,
		configDir: opts.configDir,
	});
	const apiUrl = opts.apiUrl ?? resolveApiUrl();

	const seen = new Set<string>();
	log(`relay: forwarding new rine mail → ${target} (every ${interval}ms, from ${apiUrl})`);
	const signal = opts.signal;
	while (!signal?.aborted) {
		try {
			const n = await drainOnce({
				client,
				target,
				secret,
				seen,
				fetchImpl: (url, init) => fetch(url, init),
				log,
			});
			if (n > 0) log(`relay: forwarded ${n} message(s)`);
		} catch (err) {
			log(`relay: poll error (continuing): ${err instanceof Error ? err.message : String(err)}`);
		}
		// Bound the dedupe set so a long-running relay doesn't grow unboundedly.
		if (seen.size > 5000) seen.clear();
		await sleep(interval, signal);
	}
}
