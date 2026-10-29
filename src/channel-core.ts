/**
 * INBOUND half of the pure rine channel pipeline — no `eve` import, so it is
 * unit-testable with fake clients/sends. `channel.ts` wires this to Eve's
 * `defineChannel` route; the OUTBOUND half (`processCompletion`/`processFailure`)
 * lives in `channel-outbound.ts`.
 *
 *   - INBOUND (`processInbound`): HMAC-verify (transport auth) → parse → dedupe
 *     → `client.read(id, { peek: true })` to HPKE-decrypt + verify the sender's
 *     Ed25519 signature (content auth) → loop-guard → ack → start/resume the session.
 *
 * The read PEEKS: it suppresses the server's delivery mark, so nothing is consumed
 * as a side effect of looking at it. Consuming a row is {@link ackDelivery}'s job,
 * and every terminal exit below either calls it or deliberately does not — the
 * block above the read says which, and why.
 *
 * TRUST NOTE: `verified === true` means the envelope signature checked out AND the
 * signing key it names belongs to the agent the server authenticated as the sender.
 * The `from_agent_id` this module routes and displays therefore IS the signer: a
 * peer cannot re-seal another agent's signed content and have it render here as
 * verified content of its own. Two limits remain. `sender_handle` is the server's
 * rendering of that agent id, so routing stays on the id. And the signature covers
 * the payload only — not this recipient, and no nonce — so an agent re-sending
 * content it signed earlier produces a copy that verifies as its own; the message
 * `id` is the de-duplication key (what the dedupe step above uses).
 */

import { isAuthenticityFailure } from "@rine-network/core";
import { asMessageUuid } from "@rine-network/sdk";
import type { AsyncRineClient } from "@rine-network/sdk";
import { renderMessageBody, senderLabel, verifiedNote } from "./format.js";
import { renderTranscriptContext } from "./transcript.js";
import { verifyRineSignature } from "./hmac.js";
import { ackDelivery, encodeReplyToken, messageIdFromWebhook, rememberSeen } from "./inbound.js";
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
 * Re-exported from `inbound.js`, where it lives so that this module's import of
 * `x402.js` (and `x402.js`'s need to ack) do not form a runtime import cycle —
 * that module's docstring has the reason. Re-exported rather than moved out of
 * sight because acking is a step in the pipeline below, and a reader following
 * "who consumes the row" arrives here.
 */
export { ackDelivery };

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
	//
	// 🔴 PEEK, and why it is not optional here. A plain read stamps the row
	// delivered BEFORE this function has decided anything — the server holds no key,
	// so it marks on fetch and there is no un-mark route. That made both refusals
	// below destructive: the `catch` promised the caller a retry against a row
	// already consumed, and an undecryptable envelope — usually the TRANSIENT case,
	// a group sender key that has not arrived yet — was gone for good after exactly
	// one look. `peek` suppresses the mark and nothing else, so a message this
	// connector cannot open yet stays in `status=new` and the rine webhook worker's
	// own bounded retry (`worker/delivery.py::_apply_failure`, 2^attempts backoff up
	// to the job's `max_attempts`) gets further attempts at it.
	//
	// 🔴 That worker bound is the ONLY bound on this surface, by decision: eve is
	// stateless per inbound message, so there is deliberately no set-aside store and
	// no local attempt counter here.
	let msg: DecryptedMessage;
	try {
		msg = await deps.client.read(asMessageUuid(messageId), { peek: true });
	} catch {
		// Transient (network / not-yet-readable) → 5xx so the caller retries. The row
		// was peeked, so it is still `new` and that retry re-reads a real message
		// rather than an already-consumed one.
		return new Response("read failed", { status: 503 });
	}
	// The one arm that refuses WITHOUT acking and WITHOUT `rememberSeen`, so the
	// worker's next attempt re-reads this id instead of short-circuiting on the
	// in-memory dedupe. `422` is kept deliberately — peek already stops the loss,
	// and the status contract documented above (`4xx` terminal, `5xx` transient) is
	// what an operator's relay reads.
	if (msg.decrypt_error) return new Response("undecryptable", { status: 422 });
	if (!msg.verified && !deps.acceptUnverified) {
		// 🔴 `unverifiable` is NOT a refusal — it is the ABSENCE of a verdict, and it
		// heals the moment the sender's signing key can be fetched. This arm used to
		// ack it together with the real refusals, so one badly-timed lookup miss
		// discarded a genuine message for good and said nothing. The previous pass
		// saw it and left it as a call it was "not entitled to take"; this is the
		// answer to that call.
		//
		// Split through core's shared predicate rather than an equality check, per
		// its own docblock — "an equality check against a single member silently
		// accepts the others". Written this way the safe arm is the DEFAULT: a
		// verification status added to the ladder later is retried, not discarded.
		if (!isAuthenticityFailure(msg.verification_status)) {
			// Not acked and not `rememberSeen`, exactly like the `decrypt_error` arm
			// above: the row was peeked, so it is still `new` and a later attempt
			// re-reads a real message instead of short-circuiting on the in-memory
			// dedupe. Same `422` for the reason that arm gives.
			return new Response("sender signature unverifiable", { status: 422 });
		}
		// Acked, exactly as the plain read used to ack it. `invalid` and
		// `sender-mismatch` are properties of the bytes: no later attempt can reach a
		// different verdict, and re-presenting attacker-controlled bytes on a schedule
		// is a log amplifier whose cadence the attacker picks.
		await ackDelivery(deps, msg.id);
		return new Response("unverified sender signature", { status: 422 });
	}
	// Loop guard: never auto-reply to our own outbound types — only AFTER the
	// signature check, so a forged type can't suppress a real message.
	if (deps.ignoreTypes.includes(msg.type)) {
		// Acked: the decision is deterministic in the message's own type, so no later
		// attempt can reach a different one. Before the read peeked, the fetch drained
		// it; leaving it `new` now would pile this connector's own replies up in the
		// inbox listing with nothing to ever clear them.
		await ackDelivery(deps, msg.id);
		rememberSeen(deps.seen, messageId);
		return new Response("ignored type", { status: 202 });
	}
	// x402 payment-aware re-surface: a payment frame becomes a structured
	// agent turn (optionally auto-paid) — never a prose auto-reply into the thread.
	if (isX402Frame(msg.type)) {
		return handleX402Inbound(deps, msg, messageId);
	}
	const replyTarget = msg.group_handle ?? msg.sender_handle;
	if (!replyTarget) {
		// Acked, as the plain read used to: both handles are the server's own
		// rendering of a row it already returned, so a re-read yields the same pair.
		await ackDelivery(deps, msg.id);
		return new Response("no reply target", { status: 422 });
	}

	// Only 1:1 inbound threads the message id (→ in-place reply). A GROUP reply
	// must broadcast to every member via send(group_handle).
	//
	// MEASURED (session 22; pinned by tests/test_group-one-conversation_group0.py
	// `test_reply_when_the_original_is_a_real_group_post_then_the_route_refuses`):
	// a group post has no single recipient (`to_agent_id IS NULL`), so
	// POST /messages/{id}/reply refuses it outright — 404 "Destination agent not
	// found" for the poster's own org, 404 "Message not found" for every other
	// member org. ZERO reply rows are created. So threading `m` here would not
	// deliver a private reply to one member; it would drop the answer and the
	// group would hear nothing at all.
	//
	// 🔴 `refuse_group_post` (`messages_reply_guards.py`, 422) is the server's
	// explicit refusal of a reply to a group post. It sits after the destination
	// lookup that 404s a real group post, so it is not what answers here. Do not
	// read it as the server handling this case and delete this guard.
	//
	// Leaving `m` undefined for groups keeps the broadcast
	// send()+parentConversationId path in processCompletion/processFailure.
	const token = msg.group_handle
		? encodeReplyToken(msg.conversation_id, replyTarget)
		: encodeReplyToken(msg.conversation_id, replyTarget, msg.id);
	// Ack delivery BEFORE starting the turn so a concurrent retry dedupes server-side
	// too (the in-memory `seen` only covers this instance, and a fresh serverless
	// instance starts with none of it).
	//
	// 🔴 That argument is now LOAD-BEARING rather than belt-and-braces: the read
	// peeks, so this call is the ONLY thing that takes the row out of `status=new`.
	await ackDelivery(deps, msg.id);
	rememberSeen(deps.seen, messageId);
	// The Eve session is stateless per inbound, so push-inject the recent
	// thread as role-tagged context for cross-turn memory. The sender/where line stays
	// FIRST. Best-effort: a thread fetch failure must NOT block delivery — fall back to
	// just the sender line. The current inbound was already persisted server-side by
	// the sender's own send, so it is the NEWEST entry in the fetched window (a peeked
	// read changes the delivery mark, never the thread); we drop it before injection so the
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
