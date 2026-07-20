import { X402Error, X402_MESSAGE_TYPE } from "@rine-network/sdk";
import { describe, expect, it } from "vitest";
import {
	DEFAULT_IGNORE_TYPES,
	type InboundDeps,
	processCompletion,
	processFailure,
	processInbound,
} from "../src/channel.js";
import { signRineBody } from "../src/hmac.js";
import { decodeReplyToken, encodeReplyToken } from "../src/inbound.js";
import { fakeClient, makeMsg } from "./helpers.js";

/**
 * x402 v1.1 payment-aware re-surfacing (D1/D2). The three x402 frames are no longer
 * in DEFAULT_IGNORE_TYPES — they become structured agent turns routed to the pay /
 * fulfill tools, while the terminal assistant PROSE stays suppressed in every case
 * (the guard hazard never re-arms). D2 auto-pay is opt-in and default OFF.
 */

const SECRET = "whsec";
const MSG_ID = "11111111-1111-1111-1111-111111111111";

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

/** A verbatim x402 quote plaintext (a PaymentRequired object). */
const quotePlaintext = {
	x402Version: 2,
	resource: { description: "one report" },
	accepts: [
		{
			scheme: "exact",
			network: "eip155:84532",
			amount: "10000",
			asset: "0xUSDC",
			payTo: "0xPAYEE",
			maxTimeoutSeconds: 60,
			extra: { name: "USDC", version: "2" },
		},
	],
};
const paymentPlaintext = {
	x402Version: 2,
	accepted: quotePlaintext.accepts[0],
	payload: { signature: "0xSIG", authorization: { from: "0xPAYER" } },
};
const receiptPlaintext = {
	success: true,
	transaction: "0xTX",
	network: "base-sepolia",
	payer: "0xPAYER",
};

function mkDeps(
	over: Partial<InboundDeps> & { client: InboundDeps["client"]; send: InboundDeps["send"] },
): InboundDeps {
	const raw = over.raw ?? serverBody();
	return {
		raw,
		signature: over.signature ?? signRineBody(raw, SECRET),
		secret: SECRET,
		acceptUnverified: false,
		maxBodyBytes: 512 * 1024,
		ignoreTypes: DEFAULT_IGNORE_TYPES,
		...over,
	};
}

describe("x402 re-surface (D1) — payment frames become tool-driven turns", () => {
	it("payment_required starts a payment-aware session with the pay guidance, no prose reply", async () => {
		const { client, replies, sends, delivered } = fakeClient({
			read: async () =>
				makeMsg({ verified: true, type: X402_MESSAGE_TYPE.PAYMENT_REQUIRED, plaintext: quotePlaintext }),
		});
		const r = recSend();
		const res = await processInbound(mkDeps({ client, send: r.send }));

		expect(res.status).toBe(200);
		expect(r.calls.length).toBe(1);
		// The turn carries the structured quote + pay guidance.
		expect(r.calls[0]?.input.message).toContain("x402 payment request");
		expect((r.calls[0]?.input.context ?? []).join("\n")).toContain("rine_pay");
		// The token is x402-marked so the completion never prose-replies.
		expect(decodeReplyToken(r.calls[0]?.opts.continuationToken ?? "")?.x402).toBe(true);
		// Delivered ack, but NO prose reply / send of any shape.
		expect(delivered[0]).toEqual([MSG_ID]);
		expect(replies.length).toBe(0);
		expect(sends.length).toBe(0);
	});

	it("payment routes to the fulfill guidance", async () => {
		const { client } = fakeClient({
			read: async () =>
				makeMsg({ verified: true, type: X402_MESSAGE_TYPE.PAYMENT, plaintext: paymentPlaintext }),
		});
		const r = recSend();
		await processInbound(mkDeps({ client, send: r.send }));
		expect((r.calls[0]?.input.context ?? []).join("\n")).toContain("rine_fulfill");
	});

	it("receipt surfaces as informational context (no reply expected)", async () => {
		const { client, replies } = fakeClient({
			read: async () =>
				makeMsg({ verified: true, type: X402_MESSAGE_TYPE.RECEIPT, plaintext: receiptPlaintext }),
		});
		const r = recSend();
		await processInbound(mkDeps({ client, send: r.send }));
		const ctx = (r.calls[0]?.input.context ?? []).join("\n");
		expect(ctx).toContain("informational");
		expect(replies.length).toBe(0);
	});

	it("does NOT auto-pay by default — the quote is surfaced instead", async () => {
		const { client, payments } = fakeClient({
			read: async () =>
				makeMsg({ verified: true, type: X402_MESSAGE_TYPE.PAYMENT_REQUIRED, plaintext: quotePlaintext }),
		});
		const r = recSend();
		await processInbound(mkDeps({ client, send: r.send })); // autoPay unset
		expect(payments.pays.length).toBe(0);
		expect(r.calls.length).toBe(1);
	});

	it("dedupes a replayed x402 frame without re-reading", async () => {
		let reads = 0;
		const { client } = fakeClient({
			read: async () => {
				reads++;
				return makeMsg({ verified: true, type: X402_MESSAGE_TYPE.PAYMENT_REQUIRED, plaintext: quotePlaintext });
			},
		});
		const r = recSend();
		const seen = new Set<string>();
		const first = await processInbound(mkDeps({ client, send: r.send, seen }));
		const second = await processInbound(mkDeps({ client, send: r.send, seen }));
		expect(first.status).toBe(200);
		expect(second.status).toBe(200); // duplicate short-circuits before read
		expect(reads).toBe(1);
		expect(r.calls.length).toBe(1);
	});

	it("negative control: a normal task_request is still auto-replied under the default", async () => {
		const { client } = fakeClient({
			read: async () => makeMsg({ verified: true, type: "rine.v1.task_request" }),
		});
		const r = recSend();
		const res = await processInbound(mkDeps({ client, send: r.send }));
		expect(res.status).toBe(200);
		expect(r.calls.length).toBe(1);
		// A normal turn's token is NOT x402-marked (its completion DOES reply).
		expect(
			decodeReplyToken(r.calls[0]?.opts.continuationToken ?? "")?.x402,
		).toBeUndefined();
	});
});

describe("x402 auto-pay (D2) — opt-in, default OFF, threshold-bounded", () => {
	it("auto-pays a quote and skips the session when enabled", async () => {
		const { client, payments, delivered } = fakeClient({
			read: async () =>
				makeMsg({ verified: true, type: X402_MESSAGE_TYPE.PAYMENT_REQUIRED, plaintext: quotePlaintext }),
		});
		const r = recSend();
		const res = await processInbound(mkDeps({ client, send: r.send, autoPay: true }));
		expect(res.status).toBe(200);
		expect(payments.pays.length).toBe(1);
		expect((payments.pays[0]?.opts as { autoPay: boolean }).autoPay).toBe(true);
		expect(r.calls.length).toBe(0); // no LLM turn
		expect(delivered[0]).toEqual([MSG_ID]);
	});

	it("falls back to surfacing when auto-pay is declined (above threshold)", async () => {
		const { client, payments } = fakeClient({
			read: async () =>
				makeMsg({ verified: true, type: X402_MESSAGE_TYPE.PAYMENT_REQUIRED, plaintext: quotePlaintext }),
			payments: {
				pay: async () => {
					throw new X402Error("per-tx-cap-exceeded", "Quote exceeds autoPayThreshold (5.00)");
				},
			},
		});
		const r = recSend();
		await processInbound(mkDeps({ client, send: r.send, autoPay: true }));
		expect(payments.fulfills.length).toBe(0);
		expect(r.calls.length).toBe(1); // surfaced
		const ctx = (r.calls[0]?.input.context ?? []).join("\n");
		expect(ctx).toContain("auto-pay declined");
	});
});

describe("x402 prose suppression — completion/failure never write into a payment thread", () => {
	const x402Token = encodeReplyToken("conv-1", "alice@acme", undefined, { x402: true });

	it("processCompletion short-circuits on an x402 token", async () => {
		const { client, replies, sends } = fakeClient();
		await processCompletion({
			finishReason: "stop",
			message: "I have paid the invoice.",
			continuationToken: x402Token,
			client,
			replyMessageType: "rine.v1.task_response",
		});
		expect(replies.length).toBe(0);
		expect(sends.length).toBe(0);
	});

	it("processFailure short-circuits on an x402 token", async () => {
		const { client, replies, sends } = fakeClient();
		await processFailure(x402Token, client);
		expect(replies.length).toBe(0);
		expect(sends.length).toBe(0);
	});
});
