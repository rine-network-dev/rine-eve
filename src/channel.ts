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
import { processInbound } from "./channel-core.js";
import type { ChannelSend } from "./channel-core.js";
import { processCompletion, processFailure } from "./channel-outbound.js";
import { getRineClient } from "./client.js";

export { processInbound, senderContextLine } from "./channel-core.js";
export { processCompletion, processFailure } from "./channel-outbound.js";
export type { ChannelSend, InboundDeps } from "./channel-core.js";
export type { CompletionDeps } from "./channel-outbound.js";

const DEFAULT_INBOUND_PATH = "/rine/v1/inbound";
const DEFAULT_REPLY_TYPE = "rine.v1.task_response";
const DEFAULT_MAX_BODY_BYTES = 512 * 1024;
/** Default token budget for the push-injected transcript (≈8000 chars). */
const DEFAULT_THREAD_CONTEXT_TOKEN_BUDGET = 2000;
/**
 * Message types never auto-replied to (loop guard): the connector's OWN
 * outbound types (task_response/error/receipt), so two rine-eve agents don't
 * auto-reply to each other forever.
 *
 * The three x402 payment frames are NOT here: v1.1 re-surfaces them as
 * payment-aware agent turns, routed by `handleX402Inbound` with the prose
 * auto-reply suppressed (the `x402` continuation-token flag), never by the generic
 * assistant reply. Adding them here would revert to the v1.0 silent-drop behavior.
 */
export const DEFAULT_IGNORE_TYPES = [
	"rine.v1.task_response",
	"rine.v1.error",
	"rine.v1.receipt",
];

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
	 * into the stateless Eve session context on each inbound. Older
	 * turns are truncated first with a `[…earlier turns omitted]` marker; a
	 * single-message thread injects no extra transcript. Default ~2000 tokens.
	 */
	threadContextTokenBudget?: number;
	/** A pre-built client (tests / advanced use); otherwise env-resolved lazily. */
	client?: AsyncRineClient;
	/**
	 * x402 payment behavior. `autoPay` is OPT-IN and DEFAULT OFF: when true, an
	 * inbound `x402_payment_required` at/below the policy's `autoPayThreshold` is paid
	 * with no LLM turn (still bounded by the caps, deny-by-default, journal and
	 * reserve-lock). Off ⇒ every quote is surfaced to the agent, which pays via
	 * `rine_pay`. Falls back to `RINE_X402_AUTO_PAY` (`1`/`true`) when unset.
	 */
	payments?: { autoPay?: boolean };
}

/** Whether an env flag is truthy (`1` / `true`, case-insensitive). */
function envFlag(value: string | undefined): boolean {
	return value === "1" || value?.toLowerCase() === "true";
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
	const autoPay =
		opts.payments?.autoPay ?? envFlag(process.env.RINE_X402_AUTO_PAY);
	// Per-channel idempotency window (this runtime instance only).
	const seen = new Set<string>();

	// Lazy, memoized client: never built at module load.
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
					autoPay,
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
