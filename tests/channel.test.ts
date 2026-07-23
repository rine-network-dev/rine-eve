import { describe, expect, it } from "vitest";
import {
	type InboundDeps,
	processCompletion,
	processFailure,
	processInbound,
} from "../src/channel.js";
import { decodeReplyToken, encodeReplyToken } from "../src/inbound.js";
import { signRineBody } from "../src/hmac.js";
import { fakeClient, makeMsg } from "./helpers.js";

const SECRET = "whsec";
const MSG_ID = "11111111-1111-1111-1111-111111111111";

// The EXACT body the rine server posts (worker/delivery.py:_build_payload).
const serverBody = (id = MSG_ID) =>
	Buffer.from(
		JSON.stringify({
			message_id: id,
			agent_id: "33333333-3333-3333-3333-333333333333",
			event: "message.received",
			timestamp: "2026-06-19T00:00:00Z",
		}),
	);

interface SendRec {
	calls: {
		input: { message: string; context?: string[] };
		opts: { continuationToken: string };
	}[];
	send: InboundDeps["send"];
}
function recSend(): SendRec {
	const calls: SendRec["calls"] = [];
	return {
		calls,
		send: async (input, opts) => {
			calls.push({ input, opts });
			return { id: "s" };
		},
	};
}

/** Build InboundDeps with a correctly-signed body + sensible defaults. */
function mkDeps(over: Partial<InboundDeps> & { client: InboundDeps["client"]; send: InboundDeps["send"] }): InboundDeps {
	const raw = over.raw ?? serverBody();
	return {
		raw,
		signature: over.signature ?? signRineBody(raw, SECRET),
		secret: "secret" in over ? over.secret : SECRET,
		acceptUnverified: false,
		maxBodyBytes: 512 * 1024,
		ignoreTypes: ["rine.v1.task_response", "rine.v1.error"],
		...over,
	};
}

describe("channel inbound (processInbound)", () => {
	it("200 + reads + starts a session for the REAL server body shape", async () => {
		let readId: unknown;
		const { client, delivered } = fakeClient({
			read: async (id: unknown) => {
				readId = id;
				return makeMsg({ verified: true });
			},
		});
		const r = recSend();
		const res = await processInbound(mkDeps({ client, send: r.send }));
		expect(res.status).toBe(200);
		expect(String(readId)).toBe(MSG_ID); // proves message_id was parsed (regression for the critical bug)
		expect(r.calls.length).toBe(1);
		const rc = decodeReplyToken(r.calls[0]?.opts.continuationToken ?? "");
		expect(rc?.replyTarget).toBe("alice@acme");
		// The inbound message id is threaded into the token so the reply lands
		// in-place rather than forking a child conversation.
		expect(rc?.messageId).toBe(MSG_ID);
		expect(delivered[0]).toEqual([MSG_ID]);
	});

	it("503 when the webhook secret is unset", async () => {
		const { client } = fakeClient({ read: async () => makeMsg() });
		const r = recSend();
		const res = await processInbound(mkDeps({ client, send: r.send, secret: undefined }));
		expect(res.status).toBe(503);
	});

	it("401 on an invalid HMAC signature", async () => {
		const { client } = fakeClient({ read: async () => makeMsg() });
		const r = recSend();
		const res = await processInbound(mkDeps({ client, send: r.send, signature: "sha256=bad" }));
		expect(res.status).toBe(401);
		expect(r.calls.length).toBe(0);
	});

	it("413 when the body exceeds the cap", async () => {
		const { client } = fakeClient({ read: async () => makeMsg() });
		const r = recSend();
		const res = await processInbound(mkDeps({ client, send: r.send, maxBodyBytes: 4 }));
		expect(res.status).toBe(413);
	});

	it("202 (ignored) when no message id is present", async () => {
		const raw = Buffer.from(JSON.stringify({ nope: true }));
		const { client } = fakeClient({ read: async () => makeMsg() });
		const r = recSend();
		const res = await processInbound(mkDeps({ raw, client, send: r.send }));
		expect(res.status).toBe(202);
		expect(r.calls.length).toBe(0);
	});

	it("503 (retryable) when read fails transiently", async () => {
		const { client } = fakeClient({
			read: async () => {
				throw new Error("network");
			},
		});
		const r = recSend();
		const res = await processInbound(mkDeps({ client, send: r.send }));
		expect(res.status).toBe(503);
		expect(r.calls.length).toBe(0);
	});

	it("422 (terminal) for an undecryptable message", async () => {
		const { client } = fakeClient({
			// biome-ignore lint/suspicious/noExplicitAny: fixture
			read: async () => makeMsg({ decrypt_error: "no key" } as any),
		});
		const r = recSend();
		const res = await processInbound(mkDeps({ client, send: r.send }));
		expect(res.status).toBe(422);
		expect(r.calls.length).toBe(0);
	});

	it("422 + no session for an unverified sender signature", async () => {
		const { client } = fakeClient({
			// biome-ignore lint/suspicious/noExplicitAny: fixture
			read: async () => makeMsg({ verified: false, verification_status: "unverifiable" } as any),
		});
		const r = recSend();
		const res = await processInbound(mkDeps({ client, send: r.send }));
		expect(res.status).toBe(422);
		expect(r.calls.length).toBe(0);
	});

	it("202 (loop guard) ignores the connector's own reply types", async () => {
		const { client } = fakeClient({
			read: async () => makeMsg({ verified: true, type: "rine.v1.task_response" }),
		});
		const r = recSend();
		const res = await processInbound(mkDeps({ client, send: r.send }));
		expect(res.status).toBe(202);
		expect(r.calls.length).toBe(0); // no auto-reply loop
	});

	it("dedupes a replayed delivery (same id) without re-reading or re-replying", async () => {
		let reads = 0;
		const { client } = fakeClient({
			read: async () => {
				reads++;
				return makeMsg({ verified: true });
			},
		});
		const r = recSend();
		const seen = new Set<string>();
		const first = await processInbound(mkDeps({ client, send: r.send, seen }));
		const second = await processInbound(mkDeps({ client, send: r.send, seen }));
		expect(first.status).toBe(200);
		expect(second.status).toBe(200);
		expect(reads).toBe(1);
		expect(r.calls.length).toBe(1);
	});

	it("routes a group message's reply target to the group handle and does NOT thread msg.id", async () => {
		const { client } = fakeClient({
			read: async () => makeMsg({ verified: true, group_handle: "#ops@acme", group_id: "g1" }),
		});
		const r = recSend();
		await processInbound(mkDeps({ client, send: r.send }));
		const rc = decodeReplyToken(r.calls[0]?.opts.continuationToken ?? "");
		expect(rc?.replyTarget).toBe("#ops@acme");
		// A group inbound must NOT carry the inbound message id: the reply endpoint is a
		// strict 1:1 reply, so the group reply has to broadcast via send(group_handle).
		// Omitting `m` keeps processCompletion on the broadcast send() path.
		expect(rc?.messageId).toBeUndefined();
	});
});

/** A ThreadEntry fixture (camelCase SDK shape). */
const tEntry = (over: Record<string, unknown> = {}) => ({
	direction: "received",
	senderHandle: "alice@acme",
	text: "hi",
	verificationStatus: "verified",
	type: "rine.v1.task_request",
	createdAt: "2026-06-20T00:00:00Z",
	...over,
});

describe("channel inbound push-injection", () => {
	it("injects the prior-turns transcript after the sender line for a multi-turn thread", async () => {
		const { client } = fakeClient({
			read: async () => makeMsg({ verified: true, plaintext: { text: "turn-three-now" } }),
			thread: async () => [
				tEntry({ direction: "received", senderHandle: "alice@acme", text: "turn-one-fact" }),
				tEntry({ direction: "sent", senderHandle: "me@acme", text: "turn-two-reply" }),
				// Newest row = the current inbound (already read+persisted server-side); it is
				// dropped from the transcript so it isn't duplicated against `message`.
				tEntry({ direction: "received", senderHandle: "alice@acme", text: "turn-three-now" }),
			],
		});
		const r = recSend();
		const res = await processInbound(
			mkDeps({ client, send: r.send, threadContextTokenBudget: 2000 }),
		);
		expect(res.status).toBe(200);
		const ctx = r.calls[0]?.input.context ?? [];
		// Sender line FIRST.
		expect(ctx[0]).toContain("Inbound rine message");
		// Transcript follows — prior turns are recallable (inverse of the Test 3 bug).
		expect(ctx.join("\n")).toContain("turn-one-fact");
		expect(ctx.join("\n")).toContain("[sent] you: turn-two-reply");
		// The current inbound turn appears ONCE (in `message`), not duplicated in the transcript.
		expect(ctx.slice(1).join("\n")).not.toContain("turn-three-now");
		expect(r.calls[0]?.input.message).toContain("turn-three-now");
	});

	it("injects NO transcript for a single-message thread (only sender line)", async () => {
		const { client } = fakeClient({
			read: async () => makeMsg({ verified: true }),
			thread: async () => [tEntry({ text: "the only turn" })],
		});
		const r = recSend();
		await processInbound(
			mkDeps({ client, send: r.send, threadContextTokenBudget: 2000 }),
		);
		const ctx = r.calls[0]?.input.context ?? [];
		expect(ctx).toHaveLength(1);
		expect(ctx[0]).toContain("Inbound rine message");
	});

	it("truncates oldest turns first with the omission marker under a small budget", async () => {
		const long = (n: number) => `turn-${n}-${"x".repeat(200)}`;
		const { client } = fakeClient({
			read: async () => makeMsg({ verified: true }),
			// 10 prior turns + 1 current inbound (newest); the current inbound is sliced
			// off before rendering, so turns 0..9 form the prior-turns transcript.
			thread: async () =>
				Array.from({ length: 11 }, (_, i) =>
					tEntry({ direction: "received", text: i < 10 ? long(i) : "current-inbound" }),
				),
		});
		const r = recSend();
		// ~50 tokens ≈ 200 chars budget — only the newest prior turn(s) + marker fit.
		await processInbound(
			mkDeps({ client, send: r.send, threadContextTokenBudget: 50 }),
		);
		const ctx = r.calls[0]?.input.context ?? [];
		const transcript = ctx.slice(1).join("\n");
		expect(transcript).toContain("[…earlier turns omitted]");
		// Newest prior turn kept, oldest dropped (truncate oldest-first).
		expect(transcript).toContain("turn-9-");
		expect(transcript).not.toContain("turn-0-");
		// The budget dropped most turns, not just a couple.
		const kept = ctx.slice(1).filter((l) => l.includes("[received]"));
		expect(kept.length).toBeLessThan(5);
	});

	it("falls back to the single sender line when the thread fetch rejects (best-effort)", async () => {
		const { client } = fakeClient({
			read: async () => makeMsg({ verified: true }),
			thread: async () => {
				throw new Error("thread fetch failed");
			},
		});
		const r = recSend();
		const res = await processInbound(
			mkDeps({ client, send: r.send, threadContextTokenBudget: 2000 }),
		);
		expect(res.status).toBe(200); // never blocks delivery
		const ctx = r.calls[0]?.input.context ?? [];
		expect(ctx).toHaveLength(1);
		expect(ctx[0]).toContain("Inbound rine message");
	});
});

describe("channel outbound (processCompletion / processFailure)", () => {
	it("does nothing on the intermediate tool-calls finishReason", async () => {
		const { client, sends } = fakeClient();
		await processCompletion({
			finishReason: "tool-calls",
			message: "intermediate",
			continuationToken: encodeReplyToken("c", "alice@acme"),
			client,
			replyMessageType: "rine.v1.task_response",
		});
		expect(sends.length).toBe(0);
	});

	it("replies IN-PLACE on a terminal finishReason (stop) via the reply endpoint, type-preserving", async () => {
		const { client, sends, replies } = fakeClient();
		await processCompletion({
			finishReason: "stop",
			message: "the answer",
			continuationToken: encodeReplyToken("conv-9", "alice@acme", MSG_ID),
			client,
			replyMessageType: "rine.v1.task_response",
		});
		// In-place reply, NOT a forking send.
		expect(sends.length).toBe(0);
		expect(replies.length).toBe(1);
		expect(String(replies[0]?.messageId)).toBe(MSG_ID);
		expect(replies[0]?.payload).toEqual({ text: "the answer" });
		// Type is unchanged — the connector's replyMessageType, not forced to task_request.
		// biome-ignore lint/suspicious/noExplicitAny: opts shape
		expect((replies[0]?.opts as any).type).toBe("rine.v1.task_response");
		// biome-ignore lint/suspicious/noExplicitAny: opts shape — reply cannot fork.
		expect((replies[0]?.opts as any).parentConversationId).toBeUndefined();
	});

	it("broadcasts a group reply via send(group_handle), never a 1:1 reply", async () => {
		// A group inbound mints a token WITHOUT the message id (channel-core: group path),
		// so completion must broadcast to the group handle so every member can decrypt —
		// a 1:1 reply() would re-seal to the original sender only.
		const { client, sends, replies } = fakeClient();
		await processCompletion({
			finishReason: "stop",
			message: "group answer",
			continuationToken: encodeReplyToken("conv-g", "#ops@acme"),
			client,
			replyMessageType: "rine.v1.task_response",
		});
		expect(replies.length).toBe(0);
		expect(sends.length).toBe(1);
		expect(sends[0]?.to).toBe("#ops@acme");
	});

	it("falls back to send()+parentConversationId for a legacy token (no message id)", async () => {
		const { client, sends, replies } = fakeClient();
		await processCompletion({
			finishReason: "stop",
			message: "the answer",
			continuationToken: encodeReplyToken("conv-9", "alice@acme"),
			client,
			replyMessageType: "rine.v1.task_response",
		});
		expect(replies.length).toBe(0);
		expect(sends.length).toBe(1);
		expect(sends[0]?.to).toBe("alice@acme");
		expect(sends[0]?.payload).toEqual({ text: "the answer" });
		// biome-ignore lint/suspicious/noExplicitAny: opts shape
		expect((sends[0]?.opts as any).parentConversationId).toBe("conv-9");
	});

	it("also replies on other terminal reasons (e.g. length) when text is present", async () => {
		const { client, replies } = fakeClient();
		await processCompletion({
			finishReason: "length",
			message: "truncated answer",
			continuationToken: encodeReplyToken("c", "alice@acme", MSG_ID),
			client,
			replyMessageType: "rine.v1.task_response",
		});
		expect(replies.length).toBe(1);
	});

	it("ignores sessions whose token is not rine-originated", async () => {
		const { client, sends, replies } = fakeClient();
		await processCompletion({
			finishReason: "stop",
			message: "hi",
			continuationToken: "slack:C0123:169",
			client,
			replyMessageType: "rine.v1.task_response",
		});
		expect(sends.length).toBe(0);
		expect(replies.length).toBe(0);
	});

	it("processFailure replies IN-PLACE with an error notice, keeping the error type", async () => {
		const { client, sends, replies } = fakeClient();
		await processFailure(encodeReplyToken("c1", "alice@acme", MSG_ID), client);
		expect(sends.length).toBe(0);
		expect(replies.length).toBe(1);
		expect(String(replies[0]?.messageId)).toBe(MSG_ID);
		// biome-ignore lint/suspicious/noExplicitAny: opts shape
		expect((replies[0]?.opts as any).type).toBe("rine.v1.error");
	});

	it("processFailure falls back to send() for a legacy token (no message id)", async () => {
		const { client, sends, replies } = fakeClient();
		await processFailure(encodeReplyToken("c1", "alice@acme"), client);
		expect(replies.length).toBe(0);
		expect(sends.length).toBe(1);
		// biome-ignore lint/suspicious/noExplicitAny: opts shape
		expect((sends[0]?.opts as any).type).toBe("rine.v1.error");
	});
});
