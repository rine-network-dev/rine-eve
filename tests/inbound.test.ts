import { describe, expect, it } from "vitest";
import {
	decodeReplyToken,
	encodeReplyToken,
	messageIdFromWebhook,
} from "../src/inbound.js";

describe("continuation-token codec", () => {
	it("round-trips conversation id + reply target + message id", () => {
		const tok = encodeReplyToken("conv-1", "alice@acme", "msg-1");
		expect(decodeReplyToken(tok)).toEqual({
			conversationId: "conv-1",
			replyTarget: "alice@acme",
			messageId: "msg-1",
		});
	});

	it("decodes a legacy 2-field token with messageId undefined", () => {
		const tok = encodeReplyToken("conv-1", "alice@acme");
		expect(decodeReplyToken(tok)).toEqual({
			conversationId: "conv-1",
			replyTarget: "alice@acme",
			messageId: undefined,
		});
	});

	it("tolerates an Eve channel-name prefix", () => {
		const tok = encodeReplyToken("conv-2", "#ops@acme", "msg-2");
		expect(decodeReplyToken(`rine:${tok}`)).toEqual({
			conversationId: "conv-2",
			replyTarget: "#ops@acme",
			messageId: "msg-2",
		});
	});

	it("returns null for non-rine / malformed tokens", () => {
		expect(decodeReplyToken(undefined)).toBeNull();
		expect(decodeReplyToken("slack:C0123:169.1")).toBeNull();
		expect(decodeReplyToken("r1.not-valid-base64-json")).toBeNull();
	});

	it("survives group handles and odd characters", () => {
		const tok = encodeReplyToken("c|3", "#a:b@acme", "m|9");
		expect(decodeReplyToken(tok)).toEqual({
			conversationId: "c|3",
			replyTarget: "#a:b@acme",
			messageId: "m|9",
		});
	});
});

describe("messageIdFromWebhook", () => {
	it("reads message.id", () => {
		expect(messageIdFromWebhook({ message: { id: "m1" } })).toBe("m1");
	});
	it("reads data.id and top-level id", () => {
		expect(messageIdFromWebhook({ data: { id: "m2" } })).toBe("m2");
		expect(messageIdFromWebhook({ id: "m3" })).toBe("m3");
	});
	it("returns undefined when absent", () => {
		expect(messageIdFromWebhook({})).toBeUndefined();
		expect(messageIdFromWebhook(null)).toBeUndefined();
		expect(messageIdFromWebhook({ message: {} })).toBeUndefined();
	});
});
