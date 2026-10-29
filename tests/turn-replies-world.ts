/**
 * The shared world of the turn-reply suites: one recording client for the tools and the
 * channel, and the ids and contexts Eve hands them for a turn.
 */

import { processCompletion } from "../src/channel.js";
import { fakeClient } from "./helpers.js";

export const SECRET = "whsec";
let n = 0;
/** A fresh uuid-shaped id per call, so no case can see another's ledger entries. */
export const uid = () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;

export type Ctx = { session: { id: string; turn: { id: string } } };
/** The context Eve hands a tool and a channel event for one turn. */
export const turn = (): Ctx => ({ session: { id: uid(), turn: { id: uid() } } });

// biome-ignore lint/suspicious/noExplicitAny: descriptor execute is (input, ctx).
export const run = (tool: any, input: unknown, ctx: Ctx) => tool.execute(input, ctx);

interface Row {
	group_handle?: string | null;
}

/**
 * One client for the tools and the channel, recording every outbound call in order
 * (`reply:<message id>` / `send:<recipient>`). Like the server, a send opens a
 * conversation of its own and names the peer it went to; a group send names the group.
 * While `state.failing` is set every call throws, so a case can fail the tool's call
 * and let the channel's through.
 */
export function world(row: Row = {}) {
	const log: string[] = [];
	const state = { failing: false };
	const made = (to?: unknown) => ({
		id: uid(),
		conversation_id: uid(),
		group_handle: row.group_handle ?? null,
		recipient_handle: row.group_handle ? null : (to as string | undefined),
	});
	const guard = () => {
		if (state.failing) throw new Error("network down");
	};
	const { client } = fakeClient({
		reply: async (id: unknown) => {
			log.push(`reply:${String(id)}`);
			guard();
			return made();
		},
		send: async (to: unknown) => {
			log.push(`send:${String(to)}`);
			guard();
			return made(to);
		},
		sendAndWait: async (to: unknown) => {
			log.push(`send:${String(to)}`);
			guard();
			return { sent: made(to), reply: null };
		},
	});
	return { client, log, state };
}

export async function complete(
	client: ReturnType<typeof world>["client"],
	token: string,
	ctx: Ctx,
) {
	await processCompletion({
		finishReason: "stop",
		message: "the final text",
		continuationToken: token,
		client,
		replyMessageType: "rine.v1.task_response",
		ctx,
	});
}
