/**
 * OUTBOUND half of the pure rine channel pipeline — no `eve` import, so it is
 * unit-testable with fake clients. `channel.ts` wires these to Eve's
 * `message.completed` / failure events; the INBOUND half lives in `channel-core.ts`.
 *
 * On a terminal assistant message, reply back over rine IN-PLACE via the reply
 * endpoint, preserving the inbound conversation; falls back to
 * `parentConversationId` for legacy tokens. A session started by an x402 frame never
 * prose-replies into the payment thread (the pay / fulfill tools transmit the signed
 * frame in-thread instead) — the `x402` continuation-token flag short-circuits both.
 * A turn a rine tool already answered (see `turn-replies.ts`) sends no final text either.
 */

import { asMessageUuid } from "@rine-network/sdk";
import type { AsyncRineClient } from "@rine-network/sdk";
import { decodeReplyToken } from "./inbound.js";
import { asRecipient } from "./tool.js";
import { type TurnContext, toolAnswer } from "./turn-replies.js";

export interface CompletionDeps {
	finishReason: string;
	message: string | null;
	continuationToken: string;
	client: AsyncRineClient;
	replyMessageType: string;
	/** Eve's session context for the event, which names the turn the tools ran in. */
	ctx?: TurnContext;
}

/**
 * Outbound for `message.completed`: every TERMINAL assistant message (any
 * `finishReason` except the intermediate `tool-calls`) with text becomes a
 * reply. When the continuation token carries the inbound message id we reply
 * IN-PLACE via the reply endpoint (same conversation, no fork) keeping the
 * connector's `replyMessageType` unchanged — type-preserving, so terminal/wake
 * semantics are exactly as before. Legacy tokens (no message id) fall back to the
 * historical `send()+parentConversationId` path. No-ops for non-rine sessions
 * (token not ours) or empty messages.
 */
export async function processCompletion(deps: CompletionDeps): Promise<void> {
	if (deps.finishReason === "tool-calls") return;
	if (!deps.message) return;
	const rc = decodeReplyToken(deps.continuationToken);
	if (!rc) return;
	// A session started by an x402 frame never prose-replies into the payment
	// thread — the pay / fulfill tools transmit the signed frame in-thread instead.
	if (rc.x402) return;
	// The model already answered through a rine tool: a second message is a duplicate.
	const answered = toolAnswer(rc, deps.ctx);
	if (answered) {
		console.info(`rine: no auto-reply for the turn's final text (${answered})`);
		return;
	}
	if (rc.messageId) {
		await deps.client.reply(
			asMessageUuid(rc.messageId),
			{ text: deps.message },
			{ type: deps.replyMessageType },
		);
		return;
	}
	await deps.client.send(
		asRecipient(rc.replyTarget),
		{ text: deps.message },
		{ type: deps.replyMessageType, parentConversationId: rc.conversationId },
	);
}

/**
 * Best-effort error notice back to the sender on a terminal session failure.
 * Replies IN-PLACE (reply endpoint, same conversation) keeping the `rine.v1.error`
 * type; falls back to `send()+parentConversationId` for legacy tokens.
 */
export async function processFailure(
	continuationToken: string,
	client: AsyncRineClient,
): Promise<void> {
	const rc = decodeReplyToken(continuationToken);
	if (!rc) return;
	// An x402 session never emits prose into the payment thread — not even an error
	// notice (it would corrupt the handshake); the tool surfaces failures itself.
	if (rc.x402) return;
	const text = "Sorry — I hit an internal error handling your request.";
	if (rc.messageId) {
		await client.reply(asMessageUuid(rc.messageId), { text }, { type: "rine.v1.error" });
		return;
	}
	await client.send(
		asRecipient(rc.replyTarget),
		{ text },
		{ type: "rine.v1.error", parentConversationId: rc.conversationId },
	);
}
