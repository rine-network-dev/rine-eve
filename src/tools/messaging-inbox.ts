/**
 * `rine_inbox`, the one messaging tool that acknowledges what it returns. Split out of
 * `./messaging.ts`, which holds the other five.
 */

import { isSettled } from "@rine-network/sdk";
import { defineTool } from "eve/tools";
import { STRING_OUTPUT, jsonSchema } from "../_zod.js";
import { renderInbox } from "../format.js";
import { inboxInput } from "../schemas.js";
import { type RineToolOpts, makeExecute, redactToText } from "../tool.js";

/**
 * `rine_inbox` — poll the inbox under one status filter, decrypt what it
 * returns, and on the `new` path best-effort `markDelivered` the decryptable
 * ids so a later check returns only newer mail. On ack failure: warn but still
 * return the reads.
 */
export function rineInboxTool(opts: RineToolOpts = {}) {
	return defineTool({
		description:
			"Fetch and decrypt messages from your inbox (1:1 and group). Defaults to `status: \"new\"` — the mail this agent has not acknowledged yet — and marks delivered only the messages it settled (opened, sent in cleartext, or refused for a failed sender signature, which never heals), so a later check returns only newer mail. A message it could not decrypt stays `new` and is returned again with its decrypt error. `delivered`, `read` and `all` re-read mail that was already acknowledged and mark nothing. Returns a numbered list of decrypted messages, or 'No new messages.' when nothing matched.",
		inputSchema: jsonSchema(inboxInput),
		outputSchema: STRING_OUTPUT,
		toModelOutput: redactToText,
		execute: makeExecute(inboxInput, opts, async (client, i) => {
			// `all` is a tool-layer value: the server's filter is a three-value
			// literal and "everything" is the ABSENCE of the parameter, so it is
			// translated to an omitted `status` rather than forwarded.
			const page = await client.inbox({
				status: i.status === "all" ? undefined : i.status,
				limit: i.limit,
			});
			const items = page.items;
			const rendered = renderInbox(items);

			// Ack on the `new` path only. Every other filter is a re-read of mail
			// this agent has already acknowledged, so there is nothing to move —
			// and acking there would consume messages the caller asked only to see.
			if (i.status !== "new") return rendered;

			// Ack only the messages that settled: opened, cleartext, or refused for
			// a failed sender signature (which never heals). A broken envelope
			// stays "new" so a future poll can retry after key recovery. A hidden
			// key-material frame follows the same rule: it is never shown, but one
			// that did not open has not yet delivered its key.
			const settledIds = items.filter(isSettled).map((m) => m.id);
			if (settledIds.length === 0) return rendered;

			try {
				await client.markDelivered(settledIds);
				return rendered;
			} catch {
				return `${rendered}\n[WARN] could not mark messages delivered; they may reappear on the next check.`;
			}
		}),
	});
}
