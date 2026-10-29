/**
 * What the model already said, through a rine tool, during the turn an inbound
 * message started.
 *
 * The channel answers a turn by sending its final text. When the model has already
 * answered the same message with `rine_reply`, or sent into the same conversation
 * or group with `rine_send` / `rine_send_and_wait`, that second message is a
 * duplicate the peer pays for. The tools write what they delivered here and the
 * channel reads it before it sends.
 *
 * Only a call that returned is recorded, so a failed call never suppresses the
 * channel's answer. The ledger lives on `globalThis` because the tools and the
 * channel are loaded as separate modules by the host. It is bounded by age and size.
 */

import { REF_CLASS, classifyReference } from "@rine-network/core";
import type { ReplyContext } from "./inbound.js";

const STATE = Symbol.for("@rine-network/eve.toolAnswers");
const TTL_MS = 10 * 60_000;
const MAX_ENTRIES = 1000;

/** The part of Eve's session context that names the turn a call belongs to. */
export interface TurnContext {
	readonly session?: { readonly id: string; readonly turn: { readonly id: string } };
}

/** What a delivered tool message says about where it went. */
export interface DeliveredMessage {
	conversation_id: string;
	group_handle?: string | null;
	recipient_handle?: string | null;
}

const ledger = ((globalThis as { [STATE]?: Map<string, number> })[STATE] ??= new Map<
	string,
	number
>());

/**
 * Entries are scoped to the Eve turn that made them, so a send in one turn never
 * answers another turn's inbound, and a new inbound never erases a turn still
 * running. A call with no context (a unit test) shares the empty scope.
 */
const scopeOf = (ctx: TurnContext | undefined) =>
	ctx?.session ? `${ctx.session.id}/${ctx.session.turn.id}` : "";

const repliedKey = (scope: string, messageId: string) => `${scope}|reply:${messageId}`;
const conversationKey = (scope: string, conversationId: string) =>
	`${scope}|conversation:${conversationId}`;
const groupKey = (scope: string, handle: string) => `${scope}|group:${handle.toLowerCase()}`;
const peerKey = (scope: string, handle: string) => `${scope}|peer:${handle.toLowerCase()}`;

function remember(key: string): void {
	const now = Date.now();
	ledger.delete(key);
	ledger.set(key, now);
	for (const [k, at] of ledger) {
		if (now - at <= TTL_MS && ledger.size <= MAX_ENTRIES) break;
		ledger.delete(k);
	}
}

/** `rine_reply` delivered a reply to this message. */
export function noteReplied(messageId: string, ctx?: TurnContext): void {
	remember(repliedKey(scopeOf(ctx), messageId));
}

/**
 * `rine_send` or `rine_send_and_wait` delivered this message. A 1:1 send always opens
 * a conversation of its own, so what ties it to the inbound is the peer it went to.
 */
export function noteSent(sent: DeliveredMessage, ctx?: TurnContext): void {
	const scope = scopeOf(ctx);
	remember(conversationKey(scope, sent.conversation_id));
	if (sent.group_handle) remember(groupKey(scope, sent.group_handle));
	if (sent.recipient_handle) remember(peerKey(scope, sent.recipient_handle));
}

/**
 * Why a tool already answered the turn this token started, or undefined when none did.
 * An entry past its age limit counts for nothing.
 */
export function toolAnswer(rc: ReplyContext, ctx?: TurnContext): string | undefined {
	const scope = scopeOf(ctx);
	const fresh = (key: string) => Date.now() - (ledger.get(key) ?? -Infinity) <= TTL_MS;
	if (rc.messageId && fresh(repliedKey(scope, rc.messageId))) {
		return `rine_reply already answered message ${rc.messageId}`;
	}
	if (fresh(conversationKey(scope, rc.conversationId))) {
		return `a rine tool already sent into conversation ${rc.conversationId}`;
	}
	if (classifyReference(rc.replyTarget) === REF_CLASS.group) {
		if (fresh(groupKey(scope, rc.replyTarget))) {
			return `a rine tool already sent to group ${rc.replyTarget}`;
		}
	} else if (fresh(peerKey(scope, rc.replyTarget))) {
		return `a rine tool already sent to ${rc.replyTarget}`;
	}
	return undefined;
}
