/**
 * The 5 messaging tool factories: `rine_send`, `rine_send_and_wait`,
 * `rine_check_inbox`, `rine_read`, `rine_reply`. Each returns an Eve `defineTool`
 * descriptor — one `AsyncRineClient` call rendered to a string, wrapped by
 * `makeExecute` (lazy env client + formatError). The runtime tool NAME comes from
 * the filename slug of the scaffolded `agent/tools/<name>.ts`, not from here.
 *
 * R4 holds throughout: renderers read only plaintext/decrypt_error/verification,
 * never the ciphertext envelope. `read`/`check_inbox` add a `toModelOutput`
 * redactor as defence-in-depth.
 */

import { asMessageUuid } from "@rine-network/sdk";
import { defineTool } from "eve/tools";
import { STRING_OUTPUT, jsonSchema } from "../_zod.js";
import { GROUP_ON_WAIT_MESSAGE, isGroupUnsupportedOnWait } from "../errors.js";
import {
	renderInbox,
	renderMessageBody,
	renderSingleMessage,
	renderThread,
	verifiedNote,
} from "../format.js";
import {
	checkInboxInput,
	readInput,
	replyInput,
	sendAndWaitInput,
	sendInput,
	threadInput,
} from "../schemas.js";
import {
	type RineToolOpts,
	approvalGate,
	asRecipient,
	makeExecute,
	redactToText,
} from "../tool.js";

/** `rine_send` — send a 1:1 or `#`-group message (the SDK auto-routes groups). */
export function rineSendTool(opts: RineToolOpts = {}) {
	return defineTool({
		description:
			"Send an end-to-end-encrypted message to another agent (`name@org` / UUID) or, with a `#`-prefixed handle, to a whole group over its E2EE channel. This is a real, irreversible network action: the message is delivered to a live recipient. Returns the new message id and conversation id.",
		inputSchema: jsonSchema(sendInput),
		outputSchema: STRING_OUTPUT,
		needsApproval: approvalGate(opts),
		execute: makeExecute(sendInput, opts, async (client, i) => {
			const msg = await client.send(
				asRecipient(i.to),
				{ text: i.body },
				{ type: i.messageType, idempotencyKey: i.idempotencyKey },
			);
			return `Sent message ${msg.id} to ${i.to} (conversation ${msg.conversation_id}).`;
		}),
	});
}

/** `rine_send_and_wait` — 1:1 send that blocks for a reply (ms timeout). */
export function rineSendAndWaitTool(opts: RineToolOpts = {}) {
	return defineTool({
		description:
			"Send an end-to-end-encrypted message to a single agent (`name@org` / UUID) and block up to `waitSeconds` for a reply, returning the decrypted reply if one arrives. 1:1 only — use rine_send for groups. This is a real, irreversible network action.",
		inputSchema: jsonSchema(sendAndWaitInput),
		outputSchema: STRING_OUTPUT,
		needsApproval: approvalGate(opts),
		execute: makeExecute(sendAndWaitInput, opts,
			async (client, i) => {
				try {
					const { sent, reply } = await client.sendAndWait(
						asRecipient(i.to),
						{ text: i.body },
						{ timeout: i.waitSeconds * 1000, type: i.messageType },
					);
					if (!reply) {
						return `Sent ${sent.id}; no reply within ${i.waitSeconds}s.`;
					}
					return `Reply: ${renderMessageBody(reply)} (${verifiedNote(reply)})`;
				} catch (err) {
					// The group-handle case is a plain Error thrown BEFORE any HTTP
					// call — translate it to the 1:1-only guidance, not a stack trace.
					if (isGroupUnsupportedOnWait(err)) return GROUP_ON_WAIT_MESSAGE;
					throw err;
				}
			},
		),
	});
}

/**
 * `rine_check_inbox` — poll the newest new messages, decrypt them, then
 * best-effort `markDelivered` the decryptable ids so a later check returns only
 * newer mail. On ack failure: warn but still return the reads.
 */
export function rineCheckInboxTool(opts: RineToolOpts = {}) {
	return defineTool({
		description:
			"Fetch and decrypt your newest unread messages (1:1 and group), then mark them delivered so a later check returns only newer mail. Returns a numbered list of decrypted messages, or 'No new messages.'.",
		inputSchema: jsonSchema(checkInboxInput),
		outputSchema: STRING_OUTPUT,
		toModelOutput: redactToText,
		execute: makeExecute(checkInboxInput, opts,
			async (client, i) => {
				const page = await client.inbox({ status: "new", limit: i.limit });
				const items = page.items;
				const rendered = renderInbox(items);

				// Ack only the messages we could actually decrypt; a broken envelope
				// stays "new" so a future poll can retry after key recovery.
				const decryptableIds = items
					.filter((m) => !m.decrypt_error)
					.map((m) => m.id);
				if (decryptableIds.length === 0) return rendered;

				try {
					await client.markDelivered(decryptableIds);
					return rendered;
				} catch {
					return `${rendered}\n[WARN] could not mark messages delivered; they may reappear on the next check.`;
				}
			},
		),
	});
}

/** `rine_read` — fetch + decrypt one message by id. */
export function rineReadTool(opts: RineToolOpts = {}) {
	return defineTool({
		description:
			"Fetch and decrypt a single message by its UUID. Returns the sender, type, decrypted body, and signature status.",
		inputSchema: jsonSchema(readInput),
		outputSchema: STRING_OUTPUT,
		toModelOutput: redactToText,
		execute: makeExecute(readInput, opts, async (client, i) => {
			const msg = await client.read(asMessageUuid(i.messageId));
			return renderSingleMessage(msg);
		}),
	});
}

/** `rine_thread` — fetch the both-sided, decrypted transcript of a conversation. */
export function rineThreadTool(opts: RineToolOpts = {}) {
	return defineTool({
		description:
			"Fetch the both-sided, decrypted transcript of a conversation by its UUID. Returns every turn (yours and the peer's) ordered oldest→newest, each role-tagged (`[sent] you:` / `[received] handle:`). A turn you cannot decrypt renders `[unavailable]`. Use to recover the full context of a conversation on demand.",
		inputSchema: jsonSchema(threadInput),
		outputSchema: STRING_OUTPUT,
		toModelOutput: redactToText,
		execute: makeExecute(threadInput, opts, async (client, i) => {
			const entries = await client.thread(i.conversationId, { limit: i.limit });
			return renderThread(entries);
		}),
	});
}

/** `rine_reply` — reply to a message, threading into the same conversation. */
export function rineReplyTool(opts: RineToolOpts = {}) {
	return defineTool({
		description:
			"Send an end-to-end-encrypted reply to a message (by its UUID), threading into the same conversation. This is a real, irreversible network action. Returns the reply's message id.",
		inputSchema: jsonSchema(replyInput),
		outputSchema: STRING_OUTPUT,
		needsApproval: approvalGate(opts),
		execute: makeExecute(replyInput, opts, async (client, i) => {
			const reply = await client.reply(
				asMessageUuid(i.messageId),
				{ text: i.body },
				{ type: i.messageType },
			);
			return `Replied to ${i.messageId} -> ${reply.id}.`;
		}),
	});
}
