/**
 * Each turn is answered on its own record: a tool send in one turn never silences
 * another turn's final text, and a running turn keeps its record when a second message
 * arrives from the same peer.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { processInbound } from "../src/channel.js";
import { signRineBody } from "../src/hmac.js";
import { encodeReplyToken } from "../src/inbound.js";
import { rineSendTool } from "../src/tools/index.js";
import { fakeClient, makeMsg } from "./helpers.js";
import { SECRET, complete, run, turn, uid, world } from "./turn-replies-world.js";

describe("each turn is answered on its own record", () => {
	beforeEach(() => {
		vi.spyOn(console, "info").mockImplementation(() => {});
	});
	afterEach(() => vi.restoreAllMocks());

	it("answers a later turn from a peer an earlier turn already sent to", async () => {
		const earlier = turn();
		const later = turn();
		const { client, log } = world();
		await run(rineSendTool({ client }), { to: "alice@acme", body: "earlier" }, earlier);
		await complete(client, encodeReplyToken(uid(), "alice@acme", uid()), later);
		expect(log).toEqual(["send:alice@acme", expect.stringMatching(/^reply:/)]);
	});

	it("keeps a running turn's record when a second message arrives from the same peer", async () => {
		const running = turn();
		const second = turn();
		const msgId = uid();
		const { client, log } = world();
		const peer = fakeClient({
			read: async () => makeMsg({ id: msgId, conversation_id: uid(), sender_handle: "alice@acme" }),
		}).client;
		await run(rineSendTool({ client }), { to: "alice@acme", body: "first answer" }, running);
		const raw = Buffer.from(JSON.stringify({ message_id: msgId }));
		let token = "";
		await processInbound({
			raw,
			signature: signRineBody(raw, SECRET),
			secret: SECRET,
			client: peer,
			send: async (_input, opts) => {
				token = opts.continuationToken;
			},
			acceptUnverified: false,
			maxBodyBytes: 512 * 1024,
			ignoreTypes: [],
		});
		await complete(client, encodeReplyToken(uid(), "alice@acme", uid()), running);
		await complete(client, token, second);
		expect(log).toEqual(["send:alice@acme", `reply:${msgId}`]);
	});
});
