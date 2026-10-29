/**
 * An A2A message that arrived as cleartext says so wherever its body is shown or
 * handed to the model: the single read, the inbox row, a reply, and the webhook
 * channel's session. A sealed message renders exactly as before.
 */

import { A2A_CLEARTEXT_NOTICE } from "@rine-network/core";
import { describe, expect, it } from "vitest";
import { processInbound } from "../src/channel.js";
import { signRineBody } from "../src/hmac.js";
import {
	renderInbox,
	renderMessageBody,
	renderSingleMessage,
} from "../src/format.js";
import { fakeClient, makeMsg } from "./helpers.js";

const LEAD = `[${A2A_CLEARTEXT_NOTICE}] `;
const cleartext = (over: Record<string, unknown> = {}) =>
	makeMsg({
		type: "rine.v1.a2a_message",
		encryption_version: "none",
		verified: false,
		verification_status: "unverifiable",
		plaintext: [{ text: "plain" }],
		...over,
	} as never);

describe("A2A cleartext in rendered bodies", () => {
	it("test_render_message_body_when_a2a_cleartext_then_leads_with_notice", () => {
		expect(renderMessageBody(cleartext()).startsWith(LEAD)).toBe(true);
	});

	it("test_render_single_message_when_a2a_cleartext_then_body_carries_notice_and_no_verified_claim", () => {
		const out = renderSingleMessage(cleartext());
		expect(out).toContain(`body: ${LEAD}`);
		expect(out).not.toContain("signature verified");
	});

	it("test_render_inbox_when_a2a_cleartext_then_row_carries_notice", () => {
		expect(renderInbox([cleartext()])).toContain(LEAD);
	});

	it("test_render_message_body_when_sealed_then_unchanged", () => {
		expect(renderMessageBody(makeMsg())).toBe("hello there");
		expect(renderMessageBody(makeMsg({ type: "rine.v1.text", encryption_version: "none" } as never))).toBe(
			"hello there",
		);
	});
});

describe("A2A cleartext through the webhook channel", () => {
	const SECRET = "whsec";
	const raw = Buffer.from(
		JSON.stringify({
			message_id: "11111111-1111-1111-1111-111111111111",
			agent_id: "33333333-3333-3333-3333-333333333333",
			event: "message.received",
			timestamp: "2026-10-13T00:00:00Z",
		}),
	);
	const run = async (acceptUnverified: boolean) => {
		const { client } = fakeClient({ read: async () => cleartext() });
		const messages: string[] = [];
		const res = await processInbound({
			raw,
			signature: signRineBody(raw, SECRET),
			secret: SECRET,
			acceptUnverified,
			maxBodyBytes: 512 * 1024,
			ignoreTypes: ["rine.v1.task_response", "rine.v1.error"],
			client,
			send: async (input: { message: string }) => {
				messages.push(input.message);
				return { id: "s" };
			},
		} as never);
		return { res, messages };
	};

	it("test_channel_when_cleartext_accepted_then_session_message_leads_with_notice", async () => {
		const { res, messages } = await run(true);
		expect(res.status).toBe(200);
		expect(messages[0]?.startsWith(LEAD)).toBe(true);
	});

	it("test_channel_when_cleartext_and_unverified_not_accepted_then_refused_before_the_model", async () => {
		const { res, messages } = await run(false);
		expect(res.status).toBe(422);
		expect(messages).toEqual([]);
	});
});
