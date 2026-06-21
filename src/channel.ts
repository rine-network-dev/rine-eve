/**
 * `rineChannel(opts?)` — the rine channel for Eve. Re-export its result as the
 * default export of `agent/channels/rine.ts` (the `init` scaffolder writes that
 * one-line file). Channels cannot ship as bare npm modules, but the framework's
 * own `slackChannel()` uses exactly this factory-then-re-export shape.
 *
 * It makes an Eve agent a first-class, E2EE-reachable citizen of the rine network:
 * inbound rine webhooks start/resume a durable session; the terminal assistant
 * message is encrypted and threaded back over rine. The actual pipeline lives in
 * `channel-core.ts` (pure, testable); this file is the `defineChannel` wiring.
 */

import type { AsyncRineClient } from "@rine-network/sdk";
import { POST, defineChannel } from "eve/channels";
import {
	processCompletion,
	processFailure,
	processInbound,
} from "./channel-core.js";
import type { ChannelSend } from "./channel-core.js";
import { getRineClient } from "./client.js";

export {
	processInbound,
	processCompletion,
	processFailure,
	senderContextLine,
} from "./channel-core.js";
export type { ChannelSend, InboundDeps, CompletionDeps } from "./channel-core.js";

const DEFAULT_INBOUND_PATH = "/rine/v1/inbound";
const DEFAULT_REPLY_TYPE = "rine.v1.task_response";
const DEFAULT_MAX_BODY_BYTES = 512 * 1024;
/** Default token budget for the push-injected transcript (REQ-CTX-01, ≈8000 chars). */
const DEFAULT_THREAD_CONTEXT_TOKEN_BUDGET = 2000;
/** Message types the connector itself emits — never auto-replied to (loop guard, R2). */
const DEFAULT_IGNORE_TYPES = ["rine.v1.task_response", "rine.v1.error", "rine.v1.receipt"];

/** Options for {@link rineChannel}. All optional; identity defaults to env. */
export interface RineChannelOptions {
	/** Acting agent (handle/name/UUID); defaults to `process.env.RINE_AGENT`. */
	agent?: string;
	apiUrl?: string;
	configDir?: string;
	/** Inbound route path; defaults to `RINE_INBOUND_PATH` env or `/rine/v1/inbound`. */
	path?: string;
	/** Act on messages whose sender signature did NOT verify (default false). */
	acceptUnverified?: boolean;
	/** rine message type used for outbound replies (default `rine.v1.task_response`). */
	replyMessageType?: string;
	/**
	 * Inbound message types to ignore (no session, no reply) — the loop guard that
	 * stops two rine-eve agents from auto-replying forever. Defaults to the
	 * connector's own outbound types.
	 */
	ignoreTypes?: readonly string[];
	/** Hard cap on inbound body size before HMAC work (default 512 KiB). */
	maxBodyBytes?: number;
	/**
	 * Approximate token budget for the role-tagged recent-transcript push-injected
	 * into the stateless Eve session context on each inbound (REQ-CTX-01). Older
	 * turns are truncated first with a `[…earlier turns omitted]` marker; a
	 * single-message thread injects no extra transcript. Default ~2000 tokens.
	 */
	threadContextTokenBudget?: number;
	/** A pre-built client (tests / advanced use); otherwise env-resolved lazily. */
	client?: AsyncRineClient;
}

/** Build the rine channel. Default-export the result from `agent/channels/rine.ts`. */
export function rineChannel(opts: RineChannelOptions = {}) {
	const path = opts.path ?? process.env.RINE_INBOUND_PATH ?? DEFAULT_INBOUND_PATH;
	const replyMessageType = opts.replyMessageType ?? DEFAULT_REPLY_TYPE;
	const maxBodyBytes = opts.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
	const acceptUnverified = opts.acceptUnverified ?? false;
	const ignoreTypes = opts.ignoreTypes ?? DEFAULT_IGNORE_TYPES;
	const threadContextTokenBudget =
		opts.threadContextTokenBudget ?? DEFAULT_THREAD_CONTEXT_TOKEN_BUDGET;
	// Per-channel idempotency window (this runtime instance only).
	const seen = new Set<string>();

	// Lazy, memoized client (R1): never built at module load.
	const client = () =>
		opts.client ??
		getRineClient({
			agent: opts.agent ?? process.env.RINE_AGENT,
			apiUrl: opts.apiUrl,
			configDir: opts.configDir,
		});

	return defineChannel({
		routes: [
			POST(path, async (req, { send }) =>
				processInbound({
					raw: Buffer.from(await req.arrayBuffer()),
					signature: req.headers.get("x-rine-signature") ?? undefined,
					secret: process.env.RINE_WEBHOOK_SECRET,
					client: client(),
					send: send as ChannelSend,
					acceptUnverified,
					maxBodyBytes,
					ignoreTypes,
					seen,
					threadContextTokenBudget,
				}),
			),
		],
		events: {
			"message.completed": async (data, channel) => {
				try {
					await processCompletion({
						finishReason: data.finishReason,
						message: data.message,
						continuationToken: channel.continuationToken,
						client: client(),
						replyMessageType,
					});
				} catch {
					// Adapter handlers must not throw on the event-stream write path.
				}
			},
			"session.failed": async (_data, channel) => {
				try {
					await processFailure(channel.continuationToken, client());
				} catch {
					/* best-effort */
				}
			},
		},
	});
}
