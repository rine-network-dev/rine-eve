/**
 * Visibility is stated rather than guessed on the Eve surface, and admission
 * is plural.
 *
 * These assert what a model sees — the schema it reads before it calls, the
 * arguments that reach the SDK, and the sentence it gets back — rather than the
 * shape of the code that produces them.
 */

import { describe, expect, it } from "vitest";
import {
	VISIBILITY_REQUIRED,
	groupCreateInput,
	groupInviteInput,
} from "../src/schemas-groups.js";
import {
	rineGroupCreateTool,
	rineGroupInviteTool,
	rineGroupRemoveTool,
} from "../src/tools/index.js";
import { fakeClient } from "./helpers.js";

const GROUP_ID = "11111111-1111-1111-1111-111111111111";
const AGENT_A = "22222222-2222-4222-8222-222222222222";
const AGENT_B = "33333333-3333-4333-8333-333333333333";

// biome-ignore lint/suspicious/noExplicitAny: descriptor execute is (input, ctx).
const run = (tool: any, input: unknown) => tool.execute(input, {});

const groupJson = (over: Record<string, unknown> = {}) => ({
	id: GROUP_ID,
	name: "Ops",
	handle: "#ops@acme",
	enrollment_policy: "closed",
	visibility: "private",
	mls_enabled: false,
	mls_group_id: null,
	mls_pending: false,
	...over,
});

describe("visibility is required, with no default anywhere", () => {
	it("refuses a create that names no visibility, in rine's words", () => {
		const parsed = groupCreateInput.safeParse({ name: "Ops" });
		expect(parsed.success).toBe(false);
		// Not a bare zod "Required": the refusal names both choices and what each
		// one does, so a model can pick without reading the docs.
		const message = parsed.success ? "" : parsed.error.issues[0]?.message;
		expect(message).toBe(VISIBILITY_REQUIRED);
		expect(message).toContain("dir.rine.network");
		expect(message).toContain("member-joined signal is off");
	});

	it("reaches the model as a tool error, not as a thrown zod dump", async () => {
		const { client } = fakeClient({
			groups: { create: async () => groupJson() },
		});
		const out = await run(rineGroupCreateTool({ client }), { name: "Ops" });
		expect(out).toContain("dir.rine.network");
		expect(out).not.toContain("Required");
	});

	it("passes through the visibility that was named", async () => {
		let seen: Record<string, unknown> | undefined;
		const { client } = fakeClient({
			groups: {
				create: async (_name: string, opts: Record<string, unknown>) => {
					seen = opts;
					return groupJson({ visibility: "public" });
				},
			},
		});
		await run(rineGroupCreateTool({ client }), {
			name: "Ops",
			visibility: "public",
		});
		expect(seen?.visibility).toBe("public");
	});

	it("test_create_when_a_vote_window_is_named_then_the_hours_reach_the_sdk", async () => {
		// Declaring the field is what the schema test proves. Drop the line that
		// maps it onto the SDK call and this tool still accepts
		// `voteDurationHours: 6`, still reports success, and founds the group on
		// the server's 72-hour default — a window wrong by 12x with every suite
		// green.
		let seen: Record<string, unknown> | undefined;
		const { client } = fakeClient({
			groups: {
				create: async (_name: string, opts: Record<string, unknown>) => {
					seen = opts;
					return groupJson({ enrollment_policy: "majority" });
				},
			},
		});
		await run(rineGroupCreateTool({ client }), {
			name: "Ops",
			visibility: "private",
			enrollment: "majority",
			voteDurationHours: 6,
		});
		expect(seen?.voteDurationHours).toBe(6);
	});
});

describe("the create head says what the group it just made actually runs", () => {
	it("names the fourth state when the SDK hands back an unlatched MLS group", async () => {
		// No init was attempted and none failed: the row is all there is, and it
		// says the group was created to run MLS and has no latch.
		//
		// Every other field on that group matches an open group's, so a head
		// that only said "sender-key" would be true and would still leave the
		// agent believing it had made the group it asked for.
		const { client } = fakeClient({
			groups: { create: async () => groupJson({ mls_enabled: true }) },
		});
		const out = await run(rineGroupCreateTool({ client }), {
			name: "Ops",
			visibility: "private",
		});
		expect(out).toContain("Created group #ops@acme");
		expect(out).toContain("sender-key E2EE");
		expect(out).toContain("ratchet tree was never founded");
		// No verb is named, because this surface has none that would act.
		expect(out).toContain("No verb on this surface founds it");
		expect(out).not.toMatch(/broken|frozen|failed|cannot carry|holds no keys/i);
		// The note carries the fact, so the mode field does not repeat it.
		expect(out).not.toContain("(MLS never founded)");
	});

	it("a founding that landed is MLS even when the re-read after it was refused", async () => {
		// 🔴 The row is a lie here and only the create RESULT says so. When the
		// init lands and the re-read that follows it is refused, `create` hands
		// back the PRE-init row: the tree IS founded, `mls_group_id` IS latched
		// server-side, and the server refuses a sender-key send into this group
		// — while every MLS predicate on that row reads "never founded".
		const { client } = fakeClient({
			groups: {
				create: async () => ({
					...groupJson({ mls_enabled: true }),
					mlsAdmission: { epoch: 1, commits: 1, added: 0, outcomes: [] },
				}),
			},
		});
		const out = await run(rineGroupCreateTool({ client }), {
			name: "Ops",
			visibility: "private",
		});
		expect(out).toBe(
			`Created group #ops@acme (id ${GROUP_ID}, MLS E2EE, enrollment closed).`,
		);
	});

	it("a founding this client watched fail is not told it runs sender keys", async () => {
		// 🔴 `mlsInit` means the attempt did not land, and if its init POST
		// reached the server first the group is MLS-frozen: every non-MLS send
		// into it is refused until the server clears the half-started init. The
		// never-founded note promises sender-key sealing, which is exactly the
		// half this state cannot promise, so it must not be reused here.
		const { client } = fakeClient({
			groups: {
				create: async () => ({
					...groupJson({ mls_enabled: true }),
					mlsInit: { ok: false, reason: "Only the designated admin" },
				}),
			},
		});
		const out = await run(rineGroupCreateTool({ client }), {
			name: "Ops",
			visibility: "private",
		});
		expect(out).toContain("MLS (founding failed) E2EE");
		expect(out).toContain("has not got the MLS it was created for");
		expect(out).toContain("refuses every non-MLS send here");
		expect(out).not.toContain("its messages are sealed with sender keys");
		expect(out).not.toContain("never founded");
	});

	it("leaves an ordinary sender-key create saying exactly what it said before", async () => {
		// The group created WITHOUT MLS never had a ratchet tree to found, and a
		// note about one it was never promised would be an invention.
		const { client } = fakeClient({
			groups: { create: async () => groupJson() },
		});
		const out = await run(rineGroupCreateTool({ client }), {
			name: "Ops",
			visibility: "private",
		});
		expect(out).toBe(
			`Created group #ops@acme (id ${GROUP_ID}, sender-key E2EE, enrollment closed).`,
		);
	});
});

describe("a roster invites, and reports per agent", () => {
	it("sends members and reports one outcome each", async () => {
		let seen: Record<string, unknown> | undefined;
		const { client } = fakeClient({
			groups: {
				create: async (_name: string, opts: Record<string, unknown>) => {
					seen = opts;
					return {
						...groupJson(),
						roster: {
							invited: 1,
							skipped: 1,
							entries: [
								{ agent_id: AGENT_A, status: "invited", reason: null },
								{
									agent_id: AGENT_B,
									status: "skipped",
									reason: "already_a_member",
								},
							],
						},
					};
				},
			},
		});
		const out = await run(rineGroupCreateTool({ client }), {
			name: "Ops",
			visibility: "private",
			members: [AGENT_A, AGENT_B],
		});
		expect(seen?.members).toEqual([AGENT_A, AGENT_B]);
		expect(out).toContain("1 of 2 reached; 1 new invitation to accept.");
		// The fact, not the wire token — a raw `not_applicable` read as a
		// refusal on exactly the groups it is not one for.
		expect(out).toContain(`${AGENT_B}: already a member of this group`);
		// A roster mints invitations and seats nobody.
		expect(out).toContain("nobody is a member until they join");
	});

	it("sends no members and reports no roster when none was named", async () => {
		let seen: Record<string, unknown> | undefined;
		const { client } = fakeClient({
			groups: {
				create: async (_name: string, opts: Record<string, unknown>) => {
					seen = opts;
					return groupJson();
				},
			},
		});
		const out = await run(rineGroupCreateTool({ client }), {
			name: "Ops",
			visibility: "private",
		});
		expect(seen).not.toHaveProperty("members");
		expect(out).not.toContain("Roster invited");
	});
});

describe("plural invite, singular untouched", () => {
	it("hands the SDK an array and reports one outcome per agent", async () => {
		let seenTarget: unknown;
		const { client } = fakeClient({
			groups: {
				invite: async (_g: unknown, target: unknown) => {
					seenTarget = target;
					return {
						invited: 1,
						skipped: 1,
						entries: [
							{ agent_id: AGENT_A, status: "invited", reason: null },
							{ agent_id: AGENT_B, status: "skipped", reason: "agent_revoked" },
						],
					};
				},
			},
		});
		const out = await run(rineGroupInviteTool({ client }), {
			group: GROUP_ID,
			agentsToInvite: [AGENT_A, AGENT_B],
		});
		expect(seenTarget).toEqual([AGENT_A, AGENT_B]);
		expect(out).toContain("1 of 2 reached; 1 new invitation to accept.");
		expect(out).toContain(
			`${AGENT_B}: that agent's identity is revoked, so it can join nothing`,
		);
	});

	// This guard is updated deliberately rather than deleted. The singular route's
	// promise is that it still hands over ONE id and answers one row — that half
	// is unchanged and still asserted. What changed is the sentence: `(status
	// invited)` printed the wire word, and the same tool can now answer `(status
	// pending)`, which claims an invitation that was not minted.
	it("leaves the singular invite handing over one id, and names what it minted", async () => {
		let seenTarget: unknown;
		const { client } = fakeClient({
			groups: {
				invite: async (_g: unknown, target: unknown) => {
					seenTarget = target;
					return { status: "invited", request_id: null };
				},
			},
		});
		const out = await run(rineGroupInviteTool({ client }), {
			group: GROUP_ID,
			agentToInvite: AGENT_A,
		});
		expect(seenTarget).toBe(AGENT_A);
		expect(out).toBe(
			`Invited ${AGENT_A} to ${GROUP_ID}. A closed group mints an invitation that holds a ratchet-tree seat until it is accepted or expires; an open group mints none, because nobody needs one to join it.`,
		);
	});

	it("refuses both targets, or neither, before anything reaches the SDK", async () => {
		let called = 0;
		const { client } = fakeClient({
			groups: {
				invite: async () => {
					called++;
					return { status: "invited", request_id: null };
				},
			},
		});
		const tool = rineGroupInviteTool({ client });
		const both = await run(tool, {
			group: GROUP_ID,
			agentToInvite: AGENT_A,
			agentsToInvite: [AGENT_B],
		});
		const neither = await run(tool, { group: GROUP_ID });
		for (const out of [both, neither]) {
			expect(out).toContain("Name exactly one of agentToInvite");
		}
		expect(called).toBe(0);
	});

	it("accepts a batch of at least two agents — the point of the field", () => {
		const parsed = groupInviteInput.parse({
			group: GROUP_ID,
			agentsToInvite: [AGENT_A, AGENT_B],
		});
		expect(parsed.agentsToInvite).toHaveLength(2);
	});
});

describe("the removal sentence is the SDK's, and true per group type", () => {
	it("prints what actually happened rather than composing a second sentence", async () => {
		const { client } = fakeClient({
			groups: {
				removeMember: async () => ({
					left: false,
					encryption: "sender-key",
					localStateRetired: false,
					message:
						"Removed X from group #ops@acme. An open group has no cryptographic eviction: they stop receiving this group's traffic from the server, and what bounds their reach into its later traffic is each remaining member rotating their sender key on their next send.",
				}),
			},
		});
		const out = await run(rineGroupRemoveTool({ client }), {
			group: GROUP_ID,
			agentId: AGENT_A,
		});
		expect(out).toContain("no cryptographic eviction");
		// The shipped sentence was false for an open group and must not survive.
		expect(out).not.toContain("only way back in");
	});
});
