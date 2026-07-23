/**
 * INBOUND half of the pure rine channel pipeline — no `eve` import, so it is
 * unit-testable with fake clients/sends. `channel.ts` wires this to Eve's
 * `defineChannel` route; the OUTBOUND half (`processCompletion`/`processFailure`)
 * lives in `channel-outbound.ts`.
 *
 *   - INBOUND (`processInbound`): HMAC-verify (transport auth) → parse → dedupe
 *     → `client.read(id)` to HPKE-decrypt + verify the sender's Ed25519 signature
 *     (content auth) → loop-guard → mark delivered → start/resume the session.
 *
 * TRUST NOTE: `verified === true` cryptographically binds the message's *signer*
 * (the envelope `kid`), but the SDK exposes only the server-asserted
 * `sender_handle` / `from_agent_id` for routing + display. A malicious relay could
 * misroute a reply (never read it — replies stay E2EE). Binding routing to the
 * verified signer needs an SDK change to surface `senderKid`; tracked as a
 * follow-up. Matches the sibling rine connectors' behavior.
 */

import { asMessageUuid } from "@rine-network/sdk";
import type { AsyncRineClient } from "@rine-network/sdk";
import { renderMessageBody, senderLabel, verifiedNote } from "./format.js";
import { renderTranscriptContext } from "./transcript.js";
import { verifyRineSignature } from "./hmac.js";
import {
	encodeReplyToken,
	messageIdFromWebhook,
	rememberSeen,
} from "./inbound.js";
import type { DecryptedMessage } from "./types.js";
import { handleX402Inbound, isX402Frame } from "./x402.js";

/** Minimal `send` surface the inbound handler needs (Eve's route `send`). */
export type ChannelSend = (
	input: { message: string; context?: string[] },
	opts: { auth: null; continuationToken: string },
) => Promise<unknown>;

/** The line of context handed to the model so it knows who/where the message is from. */
export function senderContextLine(msg: DecryptedMessage): string {
	const where = msg.group_handle ? ` in group ${msg.group_handle}` : "";
	return `Inbound rine message from ${senderLabel(msg)}${where} (type ${msg.type}, ${verifiedNote(msg)}). Your reply is delivered back to the sender over rine.`;
}

export interface InboundDeps {
	/** Raw request body bytes. */
	raw: Buffer;
	/** The `x-rine-signature` header value. */
	signature: string | undefined;
	/** The HMAC secret (`RINE_WEBHOOK_SECRET`), or undefined if unset. */
	secret: string | undefined;
	client: AsyncRineClient;
	send: ChannelSend;
	acceptUnverified: boolean;
	maxBodyBytes: number;
	/** Inbound types to ignore (loop guard). */
	ignoreTypes: readonly string[];
	/**
	 * Opt-in auto-pay (default OFF). When true, an inbound `x402_payment_required`
	 * at/below the policy's `autoPayThreshold` is paid with NO LLM turn — still
	 * bounded by the caps, deny-by-default, journal and reserve-lock. Any decline
	 * falls back to surfacing the quote to the model.
	 */
	autoPay?: boolean;
	/** Bounded set of already-handled message ids (dedupe across retries/replays). */
	seen?: Set<string>;
	/**
	 * Approximate token budget for the role-tagged transcript push-injected into the
	 * session context. When unset, only the sender line is injected.
	 */
	threadContextTokenBudget?: number;
}

/** Cap on turns fetched for the push-injected transcript. */
const THREAD_FETCH_LIMIT = 50;

/**
 * The inbound pipeline. Returns the HTTP {@link Response} the route should send.
 * Status codes are retry-aware: `5xx` = transient (caller should retry),
 * `4xx` = terminal drop, `2xx` = accepted/benign-ignore.
 */
export async function processInbound(deps: InboundDeps): Promise<Response> {
	if (!deps.secret) {
		return new Response("rine channel not configured: RINE_WEBHOOK_SECRET unset", {
			status: 503,
		});
	}
	if (deps.raw.length > deps.maxBodyBytes) {
		return new Response("payload too large", { status: 413 });
	}
	if (!verifyRineSignature(deps.raw, deps.signature, deps.secret)) {
		return new Response("invalid signature", { status: 401 });
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(deps.raw.toString("utf-8"));
	} catch {
		return new Response("bad json", { status: 400 });
	}
	const messageId = messageIdFromWebhook(parsed);
	if (!messageId) return new Response("ignored", { status: 202 });

	// Idempotency: a replayed / retried / duplicated delivery for an id we already
	// handled is acked without re-reading or re-replying.
	if (deps.seen?.has(messageId)) return new Response("duplicate", { status: 200 });

	// Re-fetch by id: HPKE-decrypt + verify the sender signature client-side. We
	// never trust the webhook body's ciphertext — only its (HMAC-signed) id.
	let msg: DecryptedMessage;
	try {
		msg = await deps.client.read(asMessageUuid(messageId));
	} catch {
		// Transient (network / not-yet-readable) → 5xx so the caller retries.
		return new Response("read failed", { status: 503 });
	}
	if (msg.decrypt_error) return new Response("undecryptable", { status: 422 });
	if (!msg.verified && !deps.acceptUnverified) {
		return new Response("unverified sender signature", { status: 422 });
	}
	// Loop guard: never auto-reply to our own outbound types — only AFTER the
	// signature check, so a forged type can't suppress a real message.
	if (deps.ignoreTypes.includes(msg.type)) {
		rememberSeen(deps.seen, messageId);
		return new Response("ignored type", { status: 202 });
	}
	// x402 payment-aware re-surface: a payment frame becomes a structured
	// agent turn (optionally auto-paid) — never a prose auto-reply into the thread.
	if (isX402Frame(msg.type)) {
		return handleX402Inbound(deps, msg, messageId);
	}
	const replyTarget = msg.group_handle ?? msg.sender_handle;
	if (!replyTarget) return new Response("no reply target", { status: 422 });

	// Only 1:1 inbound threads the message id (→ in-place reply). A
	// GROUP reply must broadcast to every member via send(group_handle): the reply
	// endpoint is a strict 1:1 reply (re-seals to the original sender only), so
	// threading `m` for a group message would deliver a private reply no other
	// member can decrypt. Leaving `m` undefined for groups keeps the broadcast
	// send()+parentConversationId path in processCompletion/processFailure.
	const token = msg.group_handle
		? encodeReplyToken(msg.conversation_id, replyTarget)
		: encodeReplyToken(msg.conversation_id, replyTarget, msg.id);
	// Ack delivery BEFORE starting the turn so a concurrent retry dedupes server-side
	// too (the in-memory `seen` only covers this instance).
	await deps.client.markDelivered([msg.id]).catch(() => {});
	rememberSeen(deps.seen, messageId);
	// The Eve session is stateless per inbound, so push-inject the recent
	// thread as role-tagged context for cross-turn memory. The sender/where line stays
	// FIRST. Best-effort: a thread fetch failure must NOT block delivery — fall back to
	// just the sender line. The current inbound was already read+persisted (:107), so it
	// is the NEWEST entry in the fetched window; we drop it before injection so the
	// transcript holds only PRIOR turns (the current turn already rides in `message`).
	// A single-message thread (only the just-received inbound) thus adds no transcript.
	const context = [senderContextLine(msg)];
	if (deps.threadContextTokenBudget != null) {
		const entries = await deps.client
			.thread(msg.conversation_id, { limit: THREAD_FETCH_LIMIT })
			.catch(() => []);
		const priorTurns = entries.slice(0, -1);
		if (priorTurns.length > 0) {
			context.push(
				...renderTranscriptContext(priorTurns, deps.threadContextTokenBudget),
			);
		}
	}
	await deps.send(
		{ message: renderMessageBody(msg), context },
		{ auth: null, continuationToken: token },
	);
	return new Response("ok", { status: 200 });
}
