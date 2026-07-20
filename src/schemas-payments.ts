/**
 * Zod input schemas for the 2 x402 payment tools (split out of `schemas.ts` to
 * hold the ~200-LOC budget — one file per domain). Same authoring rules: rich
 * `.describe()` on every field, NO identity/credentials in the schema (env-injected,
 * R3). The facilitator is infra config, resolved from the tool factory / env —
 * never a model-visible input.
 */

import { z } from "zod";

export const payInput = z.object({
	messageId: z
		.string()
		.describe(
			"The UUID of the received `rine.v1.x402_payment_required` quote to pay. The signed payment is sent back in the same conversation.",
		),
	autoPay: z
		.boolean()
		.default(false)
		.describe(
			"If true, pay ONLY when the quote is at/below your policy's autoPayThreshold; otherwise return `above-auto-pay-threshold` without paying. Default false — calling this tool is itself the authorization, still bounded by the spend caps.",
		),
	emitMarker: z
		.boolean()
		.default(true)
		.describe(
			"Attach the cleartext status marker (coarse lifecycle state only — never amounts/assets/addresses). Default true; set false for a fully-sealed payment.",
		),
	allowRepay: z
		.boolean()
		.default(false)
		.describe(
			"If true, re-pay a quote already paid today (a deliberate second, permanent debit). Default false — a repeat pay of the same messageId returns `already-paid` without spending.",
		),
});

export const fulfillInput = z.object({
	messageId: z
		.string()
		.describe(
			"The UUID of the received `rine.v1.x402_payment` (signed authorization) to fulfill. Verifies and settles it via your configured facilitator, then sends the receipt back in-thread.",
		),
	emitMarker: z
		.boolean()
		.default(true)
		.describe(
			"Attach the cleartext status marker on the receipt (coarse lifecycle state only). Default true.",
		),
});
