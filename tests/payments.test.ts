import {
	X402Error,
	X402FacilitatorError,
	X402_MESSAGE_TYPE,
} from "@rine-network/sdk";
import { afterEach, describe, expect, it } from "vitest";
import { rineFulfillTool, rinePayTool } from "../src/tools/payments.js";
import { fakeClient, makeMsg } from "./helpers.js";

// Call a tool descriptor's execute with raw model input (ctx ignored).
// biome-ignore lint/suspicious/noExplicitAny: descriptor execute is (input, ctx).
const run = (tool: any, input: unknown) => tool.execute(input, {});

const quote = (over = {}) =>
	makeMsg({ type: X402_MESSAGE_TYPE.PAYMENT_REQUIRED, ...over });
const paymentMsg = (over = {}) => makeMsg({ type: X402_MESSAGE_TYPE.PAYMENT, ...over });

describe("rine_pay tool (payer, typed statuses)", () => {
	it("payment-submitted on success, with the paid requirement summary", async () => {
		const { client, payments } = fakeClient({ read: async () => quote() });
		const out = await run(rinePayTool({ client }), {
			messageId: "11111111-1111-1111-1111-111111111111",
		});
		expect(out).toContain("payment-submitted —");
		expect(out).toContain("pay-1");
		expect(out).toContain("0xUSDC");
		// Defaults flow through to the SDK.
		const opts = payments.pays[0]?.opts as { emitMarker: boolean; autoPay: boolean };
		expect(opts.emitMarker).toBe(true);
		expect(opts.autoPay).toBe(false);
	});

	it("not-payment-required when the message is not a quote", async () => {
		const { client } = fakeClient({
			read: async () => makeMsg({ type: "rine.v1.task_request" }),
		});
		const out = await run(rinePayTool({ client }), { messageId: "11111111-1111-1111-1111-111111111111" });
		expect(out).toContain("not-payment-required —");
	});

	it("no-wallet when no wallet key is configured", async () => {
		const { client } = fakeClient({
			read: async () => quote(),
			payments: {
				walletAddress: async () => {
					throw new Error("ENOENT: wallet.key");
				},
			},
		});
		const out = await run(rinePayTool({ client }), { messageId: "11111111-1111-1111-1111-111111111111" });
		expect(out).toContain("no-wallet —");
	});

	it("policy-refused on a deny-by-default (no policy)", async () => {
		const { client } = fakeClient({
			read: async () => quote(),
			payments: {
				pay: async () => {
					throw new X402Error("no-policy", "No spend policy configured");
				},
			},
		});
		const out = await run(rinePayTool({ client }), { messageId: "11111111-1111-1111-1111-111111111111" });
		expect(out).toContain("policy-refused —");
	});

	it("above-auto-pay-threshold when auto_pay is set and the quote exceeds the threshold", async () => {
		const { client } = fakeClient({
			read: async () => quote(),
			payments: {
				pay: async () => {
					throw new X402Error("per-tx-cap-exceeded", "Quote exceeds autoPayThreshold (5.00)");
				},
			},
		});
		const out = await run(rinePayTool({ client }), { messageId: "11111111-1111-1111-1111-111111111111", autoPay: true });
		expect(out).toContain("above-auto-pay-threshold —");
	});

	it("already-paid on a repeat pay without allowRepay", async () => {
		const { client } = fakeClient({
			read: async () => quote(),
			payments: {
				pay: async () => {
					throw new X402Error("already-paid", "already paid today");
				},
			},
		});
		const out = await run(rinePayTool({ client }), { messageId: "11111111-1111-1111-1111-111111111111" });
		expect(out).toContain("already-paid —");
	});

	it("wallet-busy on a concurrent wallet lock", async () => {
		const { client } = fakeClient({
			read: async () => quote(),
			payments: {
				pay: async () => {
					throw new X402Error("wallet-busy", "another payment is in progress");
				},
			},
		});
		const out = await run(rinePayTool({ client }), { messageId: "11111111-1111-1111-1111-111111111111" });
		expect(out).toContain("wallet-busy —");
	});

	it("inauthentic-quote when the quote's envelope was not signed by its sender", async () => {
		const { client } = fakeClient({
			read: async () => quote(),
			payments: {
				pay: async () => {
					throw new X402Error("inauthentic-sender", "signed by someone else");
				},
			},
		});
		const out = await run(rinePayTool({ client }), { messageId: "11111111-1111-1111-1111-111111111111" });
		expect(out).toContain("inauthentic-quote —");
	});

	it("sender-unverifiable when the quote's sender key could not be read", async () => {
		const { client } = fakeClient({
			read: async () => quote(),
			payments: {
				pay: async () => {
					throw new X402Error("sender-unverifiable", "signing key could not be checked");
				},
			},
		});
		const out = await run(rinePayTool({ client }), { messageId: "11111111-1111-1111-1111-111111111111" });
		expect(out).toContain("sender-unverifiable —");
		expect(out).not.toContain("inauthentic-quote");
	});

	it("an unexpected error becomes a plain string (never a reject)", async () => {
		const { client } = fakeClient({
			read: async () => quote(),
			payments: {
				pay: async () => {
					throw new Error("network down");
				},
			},
		});
		const out = await run(rinePayTool({ client }), { messageId: "11111111-1111-1111-1111-111111111111" });
		expect(out).toBe("network down");
	});
});

describe("rine_fulfill tool (payee, settle-first)", () => {
	afterEach(() => {
		delete process.env.RINE_FACILITATOR;
	});

	it("settled on a successful verify+settle, network slug rendered verbatim", async () => {
		const { client, payments } = fakeClient({ read: async () => paymentMsg() });
		const out = await run(rineFulfillTool({ client, facilitator: "payai" }), {
			messageId: "11111111-1111-1111-1111-111111111111",
		});
		expect(out).toContain("settled —");
		expect(out).toContain("base-sepolia"); // v1 slug, not CAIP-2
		expect(payments.fulfills.length).toBe(1);
	});

	it("not-payment for the wrong message type", async () => {
		const { client } = fakeClient({
			read: async () => makeMsg({ type: X402_MESSAGE_TYPE.PAYMENT_REQUIRED }),
		});
		const out = await run(rineFulfillTool({ client, facilitator: "payai" }), {
			messageId: "11111111-1111-1111-1111-111111111111",
		});
		expect(out).toContain("not-payment —");
	});

	it("no-facilitator when none is configured", async () => {
		delete process.env.RINE_FACILITATOR;
		const { client } = fakeClient({ read: async () => paymentMsg() });
		const out = await run(rineFulfillTool({ client }), { messageId: "11111111-1111-1111-1111-111111111111" });
		expect(out).toContain("no-facilitator —");
	});

	it("resolves the facilitator from RINE_FACILITATOR (base URL)", async () => {
		process.env.RINE_FACILITATOR = "http://localhost:9999";
		const { client, payments } = fakeClient({ read: async () => paymentMsg() });
		const out = await run(rineFulfillTool({ client }), { messageId: "11111111-1111-1111-1111-111111111111" });
		expect(out).toContain("settled —");
		expect(payments.fulfills.length).toBe(1);
	});

	it("a typo'd facilitator surfaces an actionable config error, never a network call", async () => {
		process.env.RINE_FACILITATOR = "payia"; // typo of `payai`
		const { client, payments } = fakeClient({ read: async () => paymentMsg() });
		const out = await run(rineFulfillTool({ client }), {
			messageId: "11111111-1111-1111-1111-111111111111",
		});
		expect(out).toContain("Unknown facilitator 'payia'");
		expect(out).toContain("payai"); // valid presets listed
		// Never reached the facilitator: no doomed fetch, no fulfill call.
		expect(payments.fulfills.length).toBe(0);
	});

	it("verification-failed on a failed verification (a failure receipt is still sent)", async () => {
		const { client } = fakeClient({
			read: async () => paymentMsg(),
			payments: {
				fulfill: async () => ({
					verification: { isValid: false, invalidReason: "bad-signature" },
					settlement: null,
					receipt: { id: "r1" },
				}),
			},
		});
		const out = await run(rineFulfillTool({ client, facilitator: "payai" }), {
			messageId: "11111111-1111-1111-1111-111111111111",
		});
		expect(out).toContain("verification-failed —");
		expect(out).toContain("bad-signature");
	});

	it("settlement-failed when the facilitator settle returns unsuccessful", async () => {
		const { client } = fakeClient({
			read: async () => paymentMsg(),
			payments: {
				fulfill: async () => ({
					verification: { isValid: true },
					settlement: { success: false, errorReason: "insufficient_funds" },
					receipt: { id: "r1" },
				}),
			},
		});
		const out = await run(rineFulfillTool({ client, facilitator: "payai" }), {
			messageId: "11111111-1111-1111-1111-111111111111",
		});
		expect(out).toContain("settlement-failed —");
		expect(out).toContain("insufficient_funds");
	});

	it("facilitator-error when the facilitator call fails", async () => {
		const { client } = fakeClient({
			read: async () => paymentMsg(),
			payments: {
				fulfill: async () => {
					throw new X402FacilitatorError("facilitator /settle failed with status 502", 502);
				},
			},
		});
		const out = await run(rineFulfillTool({ client, facilitator: "payai" }), {
			messageId: "11111111-1111-1111-1111-111111111111",
		});
		expect(out).toContain("facilitator-error —");
	});

	it("sender-unverifiable when the payer's key could not be read", async () => {
		const { client } = fakeClient({
			read: async () => paymentMsg(),
			payments: {
				fulfill: async () => {
					throw new X402Error("sender-unverifiable", "signing key could not be checked");
				},
			},
		});
		const out = await run(rineFulfillTool({ client, facilitator: "payai" }), {
			messageId: "11111111-1111-1111-1111-111111111111",
		});
		expect(out).toContain("sender-unverifiable —");
	});
});
