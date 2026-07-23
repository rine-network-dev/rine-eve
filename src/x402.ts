/**
 * x402 payment-aware inbound re-surfacing for the rine channel.
 *
 * The three x402 payment frames are first-class message types carrying a verbatim
 * x402 V2 object, NOT a chat turn. v1.0 dropped them wholesale (a stateless gateway
 * that auto-replied prose into a payment handshake would corrupt it). v1.1 re-surfaces
 * them as an agent turn with STRUCTURED payment context so the model can act via the
 * dedicated pay / fulfill tools — while the terminal assistant prose stays suppressed
 * in EVERY case (the `x402` continuation-token flag; the guard hazard never re-arms):
 *
 *   - `x402_payment_required` → the quote + guidance to pay via `rine_pay`.
 *   - `x402_payment`          → the signed authorization + guidance to `rine_fulfill`.
 *   - `x402_receipt`          → the settlement outcome, informational (no reply).
 *
 * Auto-pay (opt-in, DEFAULT OFF): when enabled, a `payment_required` at/below the
 * policy's `autoPayThreshold` is paid with NO LLM turn — still bounded by the policy
 * caps, deny-by-default, journal and reserve-lock (all in rine-core). Any decline
 * falls back to surfacing the quote to the model.
 */

import { X402Error, X402_MESSAGE_TYPE } from "@rine-network/sdk";
import type {
	PaymentPayload,
	PaymentRequired,
	PaymentRequirements,
	SettlementResponse,
} from "@rine-network/sdk";
import type { InboundDeps } from "./channel-core.js";
import { senderLabel, verifiedNote } from "./format.js";
import { encodeReplyToken, rememberSeen } from "./inbound.js";
import type { DecryptedMessage } from "./types.js";

/** The three x402 frame types this module re-surfaces. */
export const X402_FRAME_TYPES = [
	X402_MESSAGE_TYPE.PAYMENT_REQUIRED,
	X402_MESSAGE_TYPE.PAYMENT,
	X402_MESSAGE_TYPE.RECEIPT,
] as const;

const X402_FRAME_SET = new Set<string>(X402_FRAME_TYPES);

/** Whether a message type is one of the three x402 payment frames. */
export function isX402Frame(type: string): boolean {
	return X402_FRAME_SET.has(type);
}

/** Atomic-unit amount of a requirement (x402 V2 `amount`, else V1 spelling). */
function requirementAmount(r: PaymentRequirements): string {
	return r.amount ?? r.maxAmountRequired ?? "?";
}

/** One `accepts[]` requirement as a compact model-readable line. */
function requirementLine(r: PaymentRequirements): string {
	return `${requirementAmount(r)} of ${r.asset} on ${r.network} → ${r.payTo}`;
}

/**
 * The structured payment body handed to the model as the turn's primary message.
 * Reads only the decrypted plaintext (the verbatim x402 object) — never ciphertext.
 */
export function renderX402Body(msg: DecryptedMessage): string {
	const p = msg.plaintext as Record<string, unknown> | null | undefined;
	if (msg.type === X402_MESSAGE_TYPE.PAYMENT_REQUIRED) {
		const pr = (p ?? {}) as PaymentRequired;
		const accepts = Array.isArray(pr.accepts) ? pr.accepts : [];
		const opts =
			accepts.length > 0
				? accepts.map((r) => `  - ${requirementLine(r)}`).join("\n")
				: "  (no acceptable requirements advertised)";
		const res = pr.resource?.description ?? pr.resource?.url;
		return `x402 payment request. Accepted ways to pay:\n${opts}${
			res ? `\nfor: ${res}` : ""
		}`;
	}
	if (msg.type === X402_MESSAGE_TYPE.PAYMENT) {
		const pp = (p ?? {}) as PaymentPayload;
		const acc = pp.accepted;
		const from = pp.payload?.authorization?.from ?? "unknown payer";
		return `x402 signed payment authorization from ${from}${
			acc ? ` for ${requirementLine(acc)}` : ""
		}.`;
	}
	// receipt
	const sr = (p ?? {}) as SettlementResponse;
	const outcome = sr.success ? "settled" : "failed";
	const detail = sr.success
		? `tx ${sr.transaction} on ${sr.network}`
		: `reason: ${sr.errorReason ?? "unknown"}`;
	return `x402 settlement receipt — ${outcome} (${detail}).`;
}

/** The routing-guidance line: what the model should do, and the do-not-reply rule. */
export function x402GuidanceLine(msg: DecryptedMessage): string {
	const who = senderLabel(msg);
	const note = verifiedNote(msg);
	if (msg.type === X402_MESSAGE_TYPE.PAYMENT_REQUIRED) {
		return `x402 quote from ${who} (${note}). To pay, call rine_pay with message_id ${msg.id} — the spend is bounded by your local policy (deny-by-default, caps). Do NOT send a text reply into this payment thread.`;
	}
	if (msg.type === X402_MESSAGE_TYPE.PAYMENT) {
		return `x402 payment from ${who} (${note}). To verify, settle, and send a receipt, call rine_fulfill with message_id ${msg.id}. Do NOT send a text reply into this payment thread.`;
	}
	return `x402 receipt from ${who} (${note}). This is informational — no reply is expected.`;
}

/**
 * Auto-pay attempt. Returns `null` when the quote was paid (no session needed),
 * or a one-line decline note when auto-pay was refused or errored (the caller then
 * surfaces the quote to the model). A policy refusal / above-threshold quote is a
 * typed {@link X402Error}; anything else (network, wallet) is reported verbatim.
 */
async function tryAutoPay(
	deps: InboundDeps,
	msg: DecryptedMessage,
): Promise<string | null> {
	try {
		await deps.client.payments.pay(msg, { autoPay: true });
		return null;
	} catch (err) {
		if (err instanceof X402Error) {
			return `[auto-pay declined (${err.code}): ${err.message}]`;
		}
		return `[auto-pay failed: ${err instanceof Error ? err.message : String(err)}]`;
	}
}

/** Surface an x402 frame to the model without arming the prose auto-reply. */
async function surfaceX402(
	deps: InboundDeps,
	msg: DecryptedMessage,
	messageId: string,
	note: string | null,
): Promise<Response> {
	const replyTarget = msg.group_handle ?? msg.sender_handle ?? senderLabel(msg);
	await deps.client.markDelivered([msg.id]).catch(() => {});
	rememberSeen(deps.seen, messageId);
	const context = [x402GuidanceLine(msg)];
	if (note) context.push(note);
	// No message id in the token: the pay / fulfill tools reply in-thread themselves.
	// `x402: true` makes `processCompletion` short-circuit so the terminal assistant
	// prose is never replied into the payment thread (the guard hazard stays closed).
	const token = encodeReplyToken(msg.conversation_id, replyTarget, undefined, {
		x402: true,
	});
	await deps.send(
		{ message: renderX402Body(msg), context },
		{ auth: null, continuationToken: token },
	);
	return new Response("ok", { status: 200 });
}

/**
 * Handle a verified inbound x402 frame. `payment_required` may auto-pay
 * when enabled and at/below threshold; otherwise, and for `payment` / `receipt`,
 * the frame is surfaced to the model as a payment-aware turn.
 */
export async function handleX402Inbound(
	deps: InboundDeps,
	msg: DecryptedMessage,
	messageId: string,
): Promise<Response> {
	if (msg.type === X402_MESSAGE_TYPE.PAYMENT_REQUIRED && deps.autoPay) {
		const decline = await tryAutoPay(deps, msg);
		if (decline === null) {
			await deps.client.markDelivered([msg.id]).catch(() => {});
			rememberSeen(deps.seen, messageId);
			return new Response("auto-paid", { status: 200 });
		}
		return surfaceX402(deps, msg, messageId, decline);
	}
	return surfaceX402(deps, msg, messageId, null);
}
