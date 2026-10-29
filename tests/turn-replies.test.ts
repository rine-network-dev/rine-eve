/**
 * A turn the model already answered through a rine tool is not answered a second
 * time with the turn's final text.
 *
 * Measured on a live run: the model called `rine_reply`, then the channel sent the
 * turn's final message as well, 0.75 s later, so the peer received two answers to one
 * message. The decision under test is the channel's own, so every case drives the
 * real tools and the real completion handler against one recording client.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encodeReplyToken } from "../src/inbound.js";
import {
	rineReplyTool,
	rineSendAndWaitTool,
	rineSendTool,
} from "../src/tools/index.js";
import { complete, run, turn, uid, world } from "./turn-replies-world.js";

describe("a rine tool already answered the inbound message", () => {
	let info: ReturnType<typeof vi.spyOn>;
	beforeEach(() => {
		info = vi.spyOn(console, "info").mockImplementation(() => {});
	});
	afterEach(() => info.mockRestore());

	it("sends no final text after rine_reply answered that message, and logs why", async () => {
		const inbound = uid();
		const t = turn();
		const { client, log } = world();
		await run(rineReplyTool({ client }), { messageId: inbound, body: "pong" }, t);
		await complete(client, encodeReplyToken(uid(), "alice@acme", inbound), t);
		expect(log).toEqual([`reply:${inbound}`]);
		expect(info).toHaveBeenCalledTimes(1);
		expect(String(info.mock.calls[0]?.[0])).toContain(inbound);
	});

	it("still answers when the tool replied to a different message", async () => {
		const inbound = uid();
		const other = uid();
		const t = turn();
		const { client, log } = world();
		await run(rineReplyTool({ client }), { messageId: other, body: "pong" }, t);
		await complete(client, encodeReplyToken(uid(), "alice@acme", inbound), t);
		expect(log).toEqual([`reply:${other}`, `reply:${inbound}`]);
		expect(info).not.toHaveBeenCalled();
	});

	it("still answers when the rine_reply call failed", async () => {
		const inbound = uid();
		const t = turn();
		const { client, log, state } = world();
		state.failing = true;
		const out = await run(rineReplyTool({ client }), { messageId: inbound, body: "pong" }, t);
		state.failing = false;
		expect(out).toBe("network down");
		await complete(client, encodeReplyToken(uid(), "alice@acme", inbound), t);
		expect(log).toEqual([`reply:${inbound}`, `reply:${inbound}`]);
	});

	it("sends no final text after rine_send to the peer who wrote in", async () => {
		const t = turn();
		const { client, log } = world();
		await run(rineSendTool({ client }), { to: "alice@acme", body: "pong" }, t);
		await complete(client, encodeReplyToken(uid(), "Alice@Acme", uid()), t);
		expect(log).toEqual(["send:alice@acme"]);
		expect(info).toHaveBeenCalledTimes(1);
	});

	it("still answers when rine_send went to a different peer", async () => {
		const t = turn();
		const { client, log } = world();
		await run(rineSendTool({ client }), { to: "carol@acme", body: "psst" }, t);
		await complete(client, encodeReplyToken(uid(), "alice@acme", uid()), t);
		expect(log).toEqual(["send:carol@acme", expect.stringMatching(/^reply:/)]);
	});

	it("still answers when the rine_send call failed", async () => {
		const t = turn();
		const { client, log, state } = world();
		state.failing = true;
		await run(rineSendTool({ client }), { to: "alice@acme", body: "x" }, t);
		state.failing = false;
		await complete(client, encodeReplyToken(uid(), "alice@acme", uid()), t);
		expect(log).toEqual(["send:alice@acme", expect.stringMatching(/^reply:/)]);
	});

	it("sends no final text after rine_send_and_wait to the peer who wrote in", async () => {
		const t = turn();
		const { client, log } = world();
		await run(rineSendAndWaitTool({ client }), { to: "alice@acme", body: "q", waitSeconds: 1 }, t);
		await complete(client, encodeReplyToken(uid(), "alice@acme", uid()), t);
		expect(log).toEqual(["send:alice@acme"]);
	});

	it("sends no group broadcast after rine_send to that group", async () => {
		const group = `#ops-${uid()}@acme`;
		const t = turn();
		const { client, log } = world({ group_handle: group });
		await run(rineSendTool({ client }), { to: "ops", body: "hello all" }, t);
		await complete(client, encodeReplyToken(uid(), group), t);
		expect(log).toEqual(["send:ops"]);
	});

	it("still broadcasts when rine_send went to a different group", async () => {
		const group = `#ops-${uid()}@acme`;
		const t = turn();
		const { client, log } = world({ group_handle: `#other-${uid()}@acme` });
		await run(rineSendTool({ client }), { to: "other", body: "hi" }, t);
		await complete(client, encodeReplyToken(uid(), group), t);
		expect(log).toEqual(["send:other", `send:${group}`]);
	});
});
