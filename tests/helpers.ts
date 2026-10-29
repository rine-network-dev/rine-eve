import { unknownGroupRefusal } from "@rine-network/core";
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
		encryption_version: "hpke-hybrid-v2",
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

/**
 * The `groups.resolveRef` a verb-behaviour test gets when it names none.
 *
 * 🔴 It is a FIXTURE SERVER, not a passthrough. It never answers with the
 * reference it was handed — it matches the reference against the rows the test
 * itself put in `groups.list()`, answers with the whole `ResolvedGroup` record
 * (id, handle, the caller's own spelling, and the row), and refuses anything
 * else with `rine-core`'s own `unknownGroupRefusal` rather than a sentence
 * retyped here. A stub shaped `resolveRef: async (ref) => ref` would make every
 * one of these tests pass without a resolution having happened, and would hide
 * a call site that hands a verb `.id` where the contract wants the record.
 *
 * The resolution LADDER is not what these tests are for and is not proven here:
 * that runs against real HTTP in `groups-fetch.test.ts`, which is also where
 * the fold — one group read, not two — is measured. Here the resolve is a
 * fixture so that the verb's own behaviour is the only thing under test.
 *
 * 🔴 It is STRICTER than the shipped ladder, and a refusal from it is therefore
 * not a product fact. Two rungs are deliberately not modelled: a BARE local
 * name (`ops`), which production resolves against the org's list, and handle
 * normalisation (`ops` → `#ops@acme`). A test that names a group any way other
 * than by its exact id or exact handle will be refused HERE and accepted by the
 * product — write it in `groups-fetch.test.ts` instead of recording the refusal.
 */
function fixtureResolveRef(list: () => Promise<{ items: GroupRowFixture[] }>) {
	return async (ref: string) => {
		const { items } = await list();
		const row = items.find((g) => g.id === ref || g.handle === ref);
		if (!row) throw new Error(unknownGroupRefusal(items as never, ref));
		return { id: row.id, handle: row.handle, spelling: ref, row };
	};
}

/** The fields the fixture resolver reads off a test's own group rows. */
interface GroupRowFixture {
	id: string;
	handle: string;
	[k: string]: unknown;
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
	const { payments: paymentsOver, groups: groupsOver, ...restOver } = over;
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
	// 🔴 Merged, never replaced. A suite that overrides `groups` names the two
	// or three verbs it is testing; if that object replaced the base wholesale it
	// would also silently drop `resolveRef`, which every group tool now calls
	// first, and the suite would fail on the resolve rather than on its subject.
	const groupsFake: Record<string, unknown> = {
		// One default row, so a suite testing a verb rather than a resolution
		// does not have to restate the org's groups to get past the resolve.
		list: async () => ({
			items: [
				{
					id: "11111111-1111-1111-1111-111111111111",
					handle: "#ops@acme",
					enrollment_policy: "closed",
					visibility: "private",
					mls_enabled: true,
					mls_group_id: "mls-1",
				},
			] as GroupRowFixture[],
		}),
		...((groupsOver as Record<string, unknown> | undefined) ?? {}),
	};
	if (!("resolveRef" in groupsFake)) {
		groupsFake.resolveRef = fixtureResolveRef(
			groupsFake.list as () => Promise<{ items: GroupRowFixture[] }>,
		);
	}
	const base: Record<string, unknown> = {
		groups: groupsFake,
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
		// Every group renderer asks the client for this org's id→handle
		// map. The default answers an empty one — case 2 for every id, which is
		// what a real client answers when `GET /agents` fails — so a test that
		// does not care about handles reads UUIDs rather than a TypeError. A
		// test that does care overrides it.
		agentHandles: async () => new Map<string, string>(),
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
