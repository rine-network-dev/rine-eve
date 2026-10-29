/**
 * The ledger of what the tools delivered is bounded: an entry stops counting after
 * ten minutes and the ledger never holds more than a thousand, so a long-lived
 * runtime neither silences a turn on stale news nor grows without end.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { decodeReplyToken, encodeReplyToken } from "../src/inbound.js";
import { noteReplied, noteSent, toolAnswer } from "../src/turn-replies.js";

const TEN_MINUTES = 10 * 60_000;
let n = 0;
const uid = () => `00000000-0000-4000-9000-${String(++n).padStart(12, "0")}`;

function replyContext(messageId: string) {
	const rc = decodeReplyToken(encodeReplyToken(uid(), "alice@acme", messageId));
	if (!rc) throw new Error("token did not decode");
	return rc;
}

describe("the tool-answer ledger", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it("stops counting an entry once it is ten minutes old", () => {
		const id = uid();
		noteReplied(id);
		vi.advanceTimersByTime(TEN_MINUTES - 1);
		expect(toolAnswer(replyContext(id))).toBeDefined();
		vi.advanceTimersByTime(2);
		expect(toolAnswer(replyContext(id))).toBeUndefined();
	});

	it("keeps an entry that was noted again after the first one aged", () => {
		const id = uid();
		noteReplied(id);
		vi.advanceTimersByTime(TEN_MINUTES - 1);
		noteReplied(id);
		vi.advanceTimersByTime(TEN_MINUTES - 1);
		expect(toolAnswer(replyContext(id))).toBeDefined();
	});

	it("forgets the oldest entries past a thousand and keeps the newest", () => {
		const first = uid();
		noteReplied(first);
		for (let i = 0; i < 1000; i++) noteReplied(uid());
		const last = uid();
		noteReplied(last);
		expect(toolAnswer(replyContext(first))).toBeUndefined();
		expect(toolAnswer(replyContext(last))).toBeDefined();
	});

	it("records a send under its conversation, its group and its peer", () => {
		const conversation_id = uid();
		noteSent({ conversation_id, group_handle: "#Ops@acme", recipient_handle: null });
		const viaGroup = decodeReplyToken(encodeReplyToken(uid(), "#ops@acme"));
		expect(viaGroup && toolAnswer(viaGroup)).toContain("group");
		const viaConversation = decodeReplyToken(encodeReplyToken(conversation_id, "bob@acme", uid()));
		expect(viaConversation && toolAnswer(viaConversation)).toContain("conversation");
	});
});
