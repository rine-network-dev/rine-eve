/**
 * The 2 x402 payment tool factories: `rine_pay` (payer) and `rine_fulfill`
 * (payee). Thin adapters over the ts-sdk `client.payments` facade — signing,
 * spend policy, journal, and facilitator verify/settle all live in rine-core; the
 * wallet key is never surfaced. Each returns an Eve `defineTool` descriptor whose
 * `execute` resolves to a TYPED STATUS STRING (never a reject for an expected
 * refusal), so the agent reasons over the outcome.
 *
 * `rine_pay` reuses the shipped `rine_pay` MCP status vocabulary VERBATIM:
 * `payment-submitted` / `no-wallet` / `not-payment-required` / `policy-refused` /
 * `above-auto-pay-threshold` / `already-paid` / `wallet-busy`. `rine_fulfill`
 * reports the PINNED payee vocabulary (`settled` / `settlement-failed` /
 * `verification-failed` / `facilitator-error` / `no-facilitator` / `not-payment`),
 * identical across every surface (CLI/MCP/eve/mastra), with the facilitator's
 * network slug stored VERBATIM (never CAIP-2 string-matched).
 */

import {
	FACILITATOR_PRESET,
	type FacilitatorConfig,
	type PaymentRequirements,
	X402Error,
	X402FacilitatorError,
	X402_ERROR,
	X402_MESSAGE_TYPE,
	asMessageUuid,
} from "@rine-network/sdk";
import type { FulfillResult } from "@rine-network/sdk";
import { defineTool } from "eve/tools";
import { STRING_OUTPUT, jsonSchema } from "../_zod.js";
import { fulfillInput, payInput } from "../schemas.js";
import {
	type RineToolOpts,
	approvalGate,
	makeExecute,
} from "../tool.js";

/** The `rine_pay` terminal statuses, reused verbatim from the MCP payer tool. */
const PAY_STATUS = {
	SUBMITTED: "payment-submitted",
	NO_WALLET: "no-wallet",
	NOT_PAYMENT_REQUIRED: "not-payment-required",
	POLICY_REFUSED: "policy-refused",
	ABOVE_AUTO_PAY_THRESHOLD: "above-auto-pay-threshold",
	ALREADY_PAID: "already-paid",
	WALLET_BUSY: "wallet-busy",
} as const;

/**
 * The `rine_fulfill` payee statuses — PINNED across every surface (CLI/MCP/eve/
 * mastra) so an LLM or operator script parses one vocabulary everywhere. Mirrors
 * the MCP `rine_fulfill` reference set; eve emits the subset it can reach (the
 * ts-sdk `fulfill` facade owns decryption, so `no-keys` never surfaces here).
 */
const FULFILL_STATUS = {
	SETTLED: "settled",
	SETTLEMENT_FAILED: "settlement-failed",
	VERIFICATION_FAILED: "verification-failed",
	FACILITATOR_ERROR: "facilitator-error",
	NO_FACILITATOR: "no-facilitator",
	NOT_PAYMENT: "not-payment",
} as const;

/** `<status> — <detail>`: the stable, parseable typed-status line. */
function status(word: string, detail: string): string {
	return `${word} — ${detail}`;
}

/** Atomic-unit amount of a requirement (x402 V2 `amount`, else V1 spelling). */
function requirementSummary(r: PaymentRequirements): string {
	const amount = r.amount ?? r.maxAmountRequired ?? "?";
	return `${amount} of ${r.asset} on ${r.network} → ${r.payTo}`;
}

/** Map an x402 pay refusal to its typed status line (parity with MCP rine_pay). */
function mapPayError(err: unknown, autoPay: boolean): string {
	if (err instanceof X402Error) {
		switch (err.code) {
			case X402_ERROR.ALREADY_PAID:
				return status(
					PAY_STATUS.ALREADY_PAID,
					`${err.message}. Pass allowRepay to pay it again.`,
				);
			case X402_ERROR.WALLET_BUSY:
				return status(PAY_STATUS.WALLET_BUSY, err.message);
			case X402_ERROR.PER_TX_CAP_EXCEEDED:
				// The payer's auto-pay gate raises this code when a quote is above the
				// autoPayThreshold; a genuine per-tx cap surfaces as no-acceptable-req.
				if (autoPay) {
					return status(
						PAY_STATUS.ABOVE_AUTO_PAY_THRESHOLD,
						`${err.message}. Re-run without autoPay to authorize explicitly.`,
					);
				}
				return status(PAY_STATUS.POLICY_REFUSED, err.message);
			default:
				return status(PAY_STATUS.POLICY_REFUSED, err.message);
		}
	}
	// Unexpected (network / transport): let makeExecute's formatError render it.
	throw err;
}

/** `rine_pay` — pay a received x402 quote in-thread (payer). */
export function rinePayTool(opts: RineToolOpts = {}) {
	return defineTool({
		description:
			"Pay a received x402 payment request (rine.v1.x402_payment_required) in-thread. Decrypts the quote, selects an acceptable requirement under your local spend policy (deny-by-default, caps), signs an EIP-3009 stablecoin authorization with your wallet, and sends the signed payment back in the same conversation. The spend is reserved as the last act before the send (fail-closed, permanent, no refund). Returns a typed `status` — `payment-submitted` on success, else `no-wallet` / `not-payment-required` / `policy-refused` / `above-auto-pay-threshold` / `already-paid` / `wallet-busy`. Does NOT wait for settlement; the receipt arrives later as an ordinary inbox message.",
		inputSchema: jsonSchema(payInput),
		outputSchema: STRING_OUTPUT,
		needsApproval: approvalGate(opts),
		execute: makeExecute(payInput, opts, async (client, i) => {
			const msg = await client.read(asMessageUuid(i.messageId));
			if (msg.type !== X402_MESSAGE_TYPE.PAYMENT_REQUIRED) {
				return status(
					PAY_STATUS.NOT_PAYMENT_REQUIRED,
					`message ${i.messageId} is type '${msg.type}', not an x402 payment request.`,
				);
			}
			// no-wallet pre-check: walletAddress() reads the local key without ever
			// returning key material. A missing key means no wallet is configured.
			try {
				await client.payments.walletAddress();
			} catch {
				return status(
					PAY_STATUS.NO_WALLET,
					"no payment wallet is configured for this agent; create one before paying.",
				);
			}
			try {
				const res = await client.payments.pay(msg, {
					autoPay: i.autoPay,
					emitMarker: i.emitMarker,
					allowRepay: i.allowRepay,
				});
				return status(
					PAY_STATUS.SUBMITTED,
					`sent x402 payment ${res.payment.id} (${requirementSummary(res.requirement)}). The settlement receipt will arrive as a later inbox message.`,
				);
			} catch (err) {
				return mapPayError(err, i.autoPay);
			}
		}),
	});
}

/**
 * Resolve the facilitator config from factory opts or `RINE_FACILITATOR`. A
 * `null` return means none is configured (surfaced as `no-facilitator`). An
 * unrecognised reference — neither a preset name nor an `http(s)://` base URL —
 * throws an actionable config error instead of being handed to `fetch` as a
 * bogus URL: parity with the CLI/MCP `resolveFacilitator`, so a typo like
 * `payia` surfaces as a config error naming the bad value, not an opaque
 * `facilitator-error` from a doomed network call.
 */
function resolveFacilitator(opts: RineToolOpts): FacilitatorConfig | null {
	const ref = opts.facilitator ?? process.env.RINE_FACILITATOR;
	if (!ref) return null;
	const headers = opts.facilitatorHeaders;
	const preset = (FACILITATOR_PRESET as Record<string, FacilitatorConfig>)[ref];
	if (preset) return headers ? { ...preset, headers } : preset;
	if (!/^https?:\/\//.test(ref)) {
		throw new Error(
			`Unknown facilitator '${ref}'. Use a preset (${Object.keys(
				FACILITATOR_PRESET,
			).join(" | ")}) or an http(s):// base URL.`,
		);
	}
	// Otherwise treat the reference as an explicit facilitator base URL.
	return headers ? { url: ref, headers } : { url: ref };
}

/** Render a settle-first {@link FulfillResult} to a typed outcome line. */
function renderFulfill(res: FulfillResult): string {
	if (!res.verification.isValid) {
		return status(
			FULFILL_STATUS.VERIFICATION_FAILED,
			`verification failed (${res.verification.invalidReason ?? "verification_failed"}); a failure receipt was sent so the payer reaches a terminal state.`,
		);
	}
	const s = res.settlement;
	if (s?.success) {
		// The facilitator echoes the v1 network slug verbatim — never CAIP-2-matched.
		return status(
			FULFILL_STATUS.SETTLED,
			`receipt sent; tx ${s.transaction} on ${s.network}${s.payer ? `, payer ${s.payer}` : ""}.`,
		);
	}
	return status(
		FULFILL_STATUS.SETTLEMENT_FAILED,
		`settlement did not succeed (${s?.errorReason ?? "unknown"}); receipt sent.`,
	);
}

/** `rine_fulfill` — verify + settle a received payment and send the receipt (payee). */
export function rineFulfillTool(opts: RineToolOpts = {}) {
	return defineTool({
		description:
			"Fulfill a received x402 payment (rine.v1.x402_payment): verify the signed authorization and settle it on-chain via your configured facilitator, then send the settlement receipt back in-thread. Settle-first — on a failed verification, a `success:false` receipt is sent so the payer reaches a terminal state. Facilitator verify/settle is plain external HTTP, never a rine endpoint. Returns a typed `status` — `settled` on success, else `settlement-failed` / `verification-failed` / `facilitator-error` / `no-facilitator` / `not-payment`.",
		inputSchema: jsonSchema(fulfillInput),
		outputSchema: STRING_OUTPUT,
		needsApproval: approvalGate(opts),
		execute: makeExecute(fulfillInput, opts, async (client, i) => {
			const msg = await client.read(asMessageUuid(i.messageId));
			if (msg.type !== X402_MESSAGE_TYPE.PAYMENT) {
				return status(
					FULFILL_STATUS.NOT_PAYMENT,
					`message ${i.messageId} is type '${msg.type}', not an x402 payment authorization.`,
				);
			}
			const facilitator = resolveFacilitator(opts);
			if (!facilitator) {
				return status(
					FULFILL_STATUS.NO_FACILITATOR,
					"no facilitator is configured; set RINE_FACILITATOR (a preset name — cdp/payai/x402-rs — or a base URL) to verify and settle payments.",
				);
			}
			try {
				const res = await client.payments.fulfill(msg, {
					facilitator,
					emitMarker: i.emitMarker,
				});
				return renderFulfill(res);
			} catch (err) {
				if (err instanceof X402FacilitatorError) {
					return status(FULFILL_STATUS.FACILITATOR_ERROR, err.message);
				}
				throw err;
			}
		}),
	});
}
