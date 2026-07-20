import { X402_MESSAGE_TYPE } from "@rine-network/sdk";
import { describe, expect, it } from "vitest";
import {
	X402_FRAME_TYPES,
	isX402Frame,
	renderX402Body,
	x402GuidanceLine,
} from "../src/x402.js";
import { makeMsg } from "./helpers.js";

describe("isX402Frame", () => {
	it("classifies exactly the three x402 frame types", () => {
		for (const t of X402_FRAME_TYPES) expect(isX402Frame(t)).toBe(true);
		expect(isX402Frame("rine.v1.task_request")).toBe(false);
		expect(isX402Frame("rine.v1.task_response")).toBe(false);
	});
});

describe("renderX402Body — structured payment context, no ciphertext", () => {
	it("renders a quote's accepted requirements and resource", () => {
		const msg = makeMsg({
			type: X402_MESSAGE_TYPE.PAYMENT_REQUIRED,
			plaintext: {
				x402Version: 2,
				resource: { description: "a market report" },
				accepts: [
					{ amount: "10000", asset: "0xUSDC", network: "eip155:84532", payTo: "0xPAYEE" },
				],
			},
		});
		const body = renderX402Body(msg);
		expect(body).toContain("x402 payment request");
		expect(body).toContain("10000 of 0xUSDC on eip155:84532 → 0xPAYEE");
		expect(body).toContain("a market report");
	});

	it("renders a payment's payer and requirement", () => {
		const msg = makeMsg({
			type: X402_MESSAGE_TYPE.PAYMENT,
			plaintext: {
				accepted: { amount: "10000", asset: "0xUSDC", network: "eip155:84532", payTo: "0xP" },
				payload: { authorization: { from: "0xPAYER" } },
			},
		});
		expect(renderX402Body(msg)).toContain("authorization from 0xPAYER");
	});

	it("renders a settlement receipt outcome verbatim", () => {
		const msg = makeMsg({
			type: X402_MESSAGE_TYPE.RECEIPT,
			plaintext: { success: true, transaction: "0xTX", network: "base-sepolia", payer: "0xP" },
		});
		const body = renderX402Body(msg);
		expect(body).toContain("settled");
		expect(body).toContain("0xTX on base-sepolia");
	});

	it("falls back to `maxAmountRequired` when `amount` is absent (x402 V1)", () => {
		const msg = makeMsg({
			type: X402_MESSAGE_TYPE.PAYMENT_REQUIRED,
			plaintext: {
				accepts: [{ maxAmountRequired: "500", asset: "0xEURC", network: "eip155:8453", payTo: "0xE" }],
			},
		});
		expect(renderX402Body(msg)).toContain("500 of 0xEURC");
	});
});

describe("x402GuidanceLine — per-type routing guidance", () => {
	it("points a quote at rine_pay and forbids a text reply", () => {
		const line = x402GuidanceLine(makeMsg({ type: X402_MESSAGE_TYPE.PAYMENT_REQUIRED }));
		expect(line).toContain("rine_pay");
		expect(line).toContain("Do NOT send a text reply");
	});

	it("points a payment at rine_fulfill", () => {
		const line = x402GuidanceLine(makeMsg({ type: X402_MESSAGE_TYPE.PAYMENT }));
		expect(line).toContain("rine_fulfill");
	});

	it("marks a receipt as informational", () => {
		const line = x402GuidanceLine(makeMsg({ type: X402_MESSAGE_TYPE.RECEIPT }));
		expect(line).toContain("informational");
	});
});
