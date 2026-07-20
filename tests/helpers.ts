import type { AsyncRineClient } from "@rine-network/sdk";
import type { DecryptedMessage } from "../src/types.js";

/** A decrypted-message fixture with sensible defaults; override per test. */
export function makeMsg(over: Partial<DecryptedMessage> = {}): DecryptedMessage {
	return {
		id: "11111111-1111-1111-1111-111111111111",
		conversation_id: "22222222-2222-2222-2222-222222222222",
		from_agent_id: "33333333-3333-3333-3333-333333333333",
		sender_handle: "alice@acme",
		type: "rine.v1.task_request",
		content_type: "application/json",
		plaintext: { text: "hello there" },
		verified: true,
		verification_status: "verified",
		decrypt_error: null,
		group_handle: null,
		group_id: null,
		encryption_version: "hpke-v1",
		created_at: "2026-06-19T00:00:00Z",
		metadata: {},
		...over,
		// biome-ignore lint/suspicious/noExplicitAny: fixture cast for SDK type drift.
	} as any;
}

/** Recorded outbound send call. */
export interface SendCall {
	to: unknown;
	payload: unknown;
	opts: unknown;
}

/** Recorded outbound reply call (the in-place reply endpoint). */
export interface ReplyCall {
	messageId: unknown;
	payload: unknown;
	opts: unknown;
}

/** Recorded `client.payments.*` calls (x402 pay / fulfill tools + auto-pay). */
export interface PaymentCalls {
	pays: { quote: unknown; opts: unknown }[];
	fulfills: { payment: unknown; opts: unknown }[];
	walletChecks: number;
}

/** Build a fake AsyncRineClient capturing calls; override any method. */
export function fakeClient(over: Partial<Record<string, unknown>> = {}): {
	client: AsyncRineClient;
	sends: SendCall[];
	replies: ReplyCall[];
	delivered: string[][];
	payments: PaymentCalls;
} {
	const sends: SendCall[] = [];
	const replies: ReplyCall[] = [];
	const delivered: string[][] = [];
	const payments: PaymentCalls = { pays: [], fulfills: [], walletChecks: 0 };
	const { payments: paymentsOver, ...restOver } = over;
	const basePayments: Record<string, unknown> = {
		walletAddress: async () => {
			payments.walletChecks++;
			return "0xWALLETADDRESS";
		},
		pay: async (quote: unknown, opts: unknown) => {
			payments.pays.push({ quote, opts });
			return {
				payment: { id: "pay-1", conversation_id: "c" },
				requirement: {
					scheme: "exact",
					network: "eip155:84532",
					amount: "10000",
					asset: "0xUSDC",
					payTo: "0xPAYEE",
					maxTimeoutSeconds: 60,
					extra: { name: "USDC", version: "2" },
				},
				paymentPayload: {},
			};
		},
		fulfill: async (payment: unknown, opts: unknown) => {
			payments.fulfills.push({ payment, opts });
			return {
				verification: { isValid: true },
				settlement: {
					success: true,
					transaction: "0xTX",
					network: "base-sepolia",
					payer: "0xPAYER",
				},
				receipt: { id: "receipt-1", conversation_id: "c" },
			};
		},
		...((paymentsOver as Record<string, unknown> | undefined) ?? {}),
	};
	const base: Record<string, unknown> = {
		send: async (to: unknown, payload: unknown, opts: unknown) => {
			sends.push({ to, payload, opts });
			return { id: "rrrrrrrr-rrrr-rrrr-rrrr-rrrrrrrrrrrr", conversation_id: "c" };
		},
		reply: async (messageId: unknown, payload: unknown, opts: unknown) => {
			replies.push({ messageId, payload, opts });
			return { id: "rrrrrrrr-rrrr-rrrr-rrrr-rrrrrrrrrrrr", conversation_id: "c" };
		},
		markDelivered: async (ids: string[]) => {
			delivered.push(ids);
		},
		thread: async () => [],
		withAgent() {
			return this;
		},
		...restOver,
		payments: basePayments,
	};
	return {
		// biome-ignore lint/suspicious/noExplicitAny: structural fake.
		client: base as any,
		sends,
		replies,
		delivered,
		payments,
	};
}
