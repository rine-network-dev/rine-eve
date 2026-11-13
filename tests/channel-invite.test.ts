import { describe, expect, it } from "vitest";
import {
	DEFAULT_IGNORE_TYPES,
	type InboundDeps,
	processCompletion,
	processFailure,
	processInbound,
} from "../src/channel.js";
import { signRineBody } from "../src/hmac.js";
import { decodeReplyToken } from "../src/inbound.js";
import { fakeClient, makeMsg } from "./helpers.js";

/**
 * A group invite wakes a turn, but the turn never answers the inviter in prose: the invite
 * is a control frame its sender's ingest parses as JSON. The model acts through its tools.
 */

const SECRET = "whsec";
const MSG_ID = "11111111-1111-1111-1111-111111111111";

const raw = Buffer.from(
	JSON.stringify({
		message_id: MSG_ID,
		agent_id: "33333333-3333-3333-3333-333333333333",
		event: "message.received",
		timestamp: "2026-11-02T00:00:00Z",
	}),
);

async function inboundOf(type: string, groupHandle: string | null = null) {
	const { client, replies, sends } = fakeClient({
		read: async () => makeMsg({ type, group_handle: groupHandle }),
	});
	const calls: { message: string; token: string }[] = [];
	const deps: InboundDeps = {
		raw,
		signature: signRineBody(raw, SECRET),
		secret: SECRET,
		acceptUnverified: false,
		maxBodyBytes: 512 * 1024,
		ignoreTypes: DEFAULT_IGNORE_TYPES,
		client,
		send: async (input, opts) => {
			calls.push({ message: input.message, token: opts.continuationToken });
			return { id: "s" };
		},
	};
	const res = await processInbound(deps);
	return { res, calls, client, replies, sends };
}

describe("a group invite", () => {
	it("test_inbound_when_a_group_invite_arrives_then_the_turn_wakes_with_a_no_reply_token", async () => {
		const { res, calls } = await inboundOf("rine.v1.group_invite");

		expect(res.status).toBe(200);
		expect(calls).toHaveLength(1);
		expect(calls[0]?.message).toContain("Group invite from alice@acme.");
		expect(decodeReplyToken(calls[0]?.token)?.noReply).toBe(true);
	});

	it("test_completion_when_the_turn_was_woken_by_an_invite_then_the_final_text_is_not_sent", async () => {
		const { calls, client, replies, sends } = await inboundOf("rine.v1.group_invite");

		await processCompletion({
			finishReason: "stop",
			message: "Thanks, I would love to join!",
			continuationToken: calls[0]?.token ?? "",
			client,
			replyMessageType: "rine.v1.task_response",
		});

		expect(replies).toHaveLength(0);
		expect(sends).toHaveLength(0);
	});

	it("test_failure_when_the_turn_was_woken_by_an_invite_then_no_error_notice_is_sent", async () => {
		const { calls, client, replies, sends } = await inboundOf("rine.v1.group_invite");

		await processFailure(calls[0]?.token ?? "", client);

		expect(replies).toHaveLength(0);
		expect(sends).toHaveLength(0);
	});

	it("test_inbound_when_an_ordinary_message_arrives_then_its_final_text_is_still_replied", async () => {
		const { calls, client, replies } = await inboundOf("rine.v1.task_request");

		expect(decodeReplyToken(calls[0]?.token)?.noReply).toBeUndefined();
		await processCompletion({
			finishReason: "stop",
			message: "done",
			continuationToken: calls[0]?.token ?? "",
			client,
			replyMessageType: "rine.v1.task_response",
		});
		expect(replies).toHaveLength(1);
	});
});
