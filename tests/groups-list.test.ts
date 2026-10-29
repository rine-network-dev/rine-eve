/**
 * The three group READ tools — `rine_groups`, `rine_discover_groups`,
 * `rine_group_roster` — through their public `execute` interface against an
 * injected fake client.
 *
 * They are read verbs, so what is worth asserting is what each one CLAIMS: a
 * directory row must not claim an encryption mode the directory never reports,
 * and a roster must not be confused with the tree the seat ceiling counts.
 */

import { describe, expect, it } from "vitest";
import {
	NO_CONVERSATION,
	NO_OWN_AGENTS,
} from "../src/format-groups-list.js";
import {
	rineDiscoverGroupsTool,
	rineGroupRosterTool,
	rineGroupsTool,
} from "../src/tools/index.js";
import { fakeClient } from "./helpers.js";

const GROUP_ID = "11111111-1111-1111-1111-111111111111";
const CONVERSATION_ID = "66666666-6666-4666-8666-666666666666";
const OWN_AGENT = "44444444-4444-4444-4444-444444444444";
const OTHER_OWN_AGENT = "55555555-5555-4555-8555-555555555555";

// biome-ignore lint/suspicious/noExplicitAny: descriptor execute is (input, ctx).
const run = (tool: any, input: unknown) => tool.execute(input, {});

describe("rine_groups", () => {
	it("renders every group with its mode, policy and member count", async () => {
		const { client } = fakeClient({
			groups: {
				list: async () => ({
					items: [
						{
							id: GROUP_ID,
							handle: "#ops@acme",
							mls_enabled: true,
							mls_group_id: "mls1",
							enrollment_policy: "closed",
							visibility: "private",
							member_count: 4,
							conversation_id: CONVERSATION_ID,
						},
						{
							id: "22222222-2222-2222-2222-222222222222",
							handle: "#lobby@acme",
							mls_enabled: false,
							mls_group_id: null,
							enrollment_policy: "open",
							visibility: "public",
							member_count: 12,
							conversation_id: null,
						},
					],
				}),
			},
		});
		const out = await run(rineGroupsTool({ client }), {});
		expect(out).toContain("1. #ops@acme");
		expect(out).toContain("MLS, enrollment closed, 4 member(s)");
		expect(out).toContain("2. #lobby@acme");
		expect(out).toContain("sender-key, enrollment open, 12 member(s)");
	});

	it("tells a group created to run MLS with no ratchet tree apart from an open one", async () => {
		// The two rows below are field for field identical to a reader that only
		// looks at the latch columns — both are unlatched, neither has an init in
		// flight — and until the row named the fourth state they rendered the
		// same two words. The first is a group created to run MLS whose ratchet
		// tree was never founded; the second is an open group, which never had
		// one to found. Only the enrollment/`mls_enabled` pair separates them.
		const { client } = fakeClient({
			groups: {
				list: async () => ({
					items: [
						{
							id: GROUP_ID,
							handle: "#ops@acme",
							mls_enabled: true,
							mls_group_id: null,
							mls_pending: false,
							enrollment_policy: "closed",
							visibility: "private",
							member_count: 4,
							conversation_id: CONVERSATION_ID,
						},
						{
							id: "22222222-2222-2222-2222-222222222222",
							handle: "#lobby@acme",
							mls_enabled: true,
							mls_group_id: null,
							mls_pending: false,
							enrollment_policy: "open",
							visibility: "public",
							member_count: 12,
							conversation_id: null,
						},
					],
				}),
			},
		});
		const out = await run(rineGroupsTool({ client }), {});
		expect(out).toContain("sender-key (MLS never founded), enrollment closed");
		expect(out).toContain("sender-key, enrollment open");
		// The row is comma-separated and the note is not the row's to carry: a
		// field holding a comma changes how many fields a reader counts.
		expect(out).not.toContain("never founded,");
	});

	it("carries each group's conversation id, both when it has one and when it does not", async () => {
		// This row is the only place a model can learn a group's conversation id
		// without having sent into the group or been handed a raw message row —
		// it lists its groups, takes the id off the row, and hands it to
		// `rine_thread`. The key is spelled as the wire field so the string the
		// model reads is the argument it has to fill.
		//
		// The empty group is asserted with the same weight. A group nobody has
		// posted in has no conversation yet (the thread is created lazily on the
		// first post), and a clause that vanishes on that group reads to a model
		// as a rendering fault rather than as a fact about the group.
		const { client } = fakeClient({
			groups: {
				list: async () => ({
					items: [
						{
							id: GROUP_ID,
							handle: "#ops@acme",
							mls_enabled: true,
							mls_group_id: "mls1",
							enrollment_policy: "closed",
							visibility: "private",
							member_count: 4,
							conversation_id: CONVERSATION_ID,
						},
						{
							id: "22222222-2222-2222-2222-222222222222",
							handle: "#lobby@acme",
							mls_enabled: false,
							mls_group_id: null,
							enrollment_policy: "open",
							visibility: "public",
							member_count: 12,
							conversation_id: null,
						},
					],
				}),
			},
		});
		const out = await run(rineGroupsTool({ client }), {});
		expect(out).toContain(`conversation_id=${CONVERSATION_ID}`);
		expect(out).toContain(`conversation_id=${NO_CONVERSATION}`);
		expect(out).not.toContain("conversation_id=null");
		expect(out).not.toContain("conversation_id=undefined");
	});

	it("says per row which of this org's agents are seated, and when none is", async () => {
		// The list is credential-scoped: an org key reports every group any agent of this org
		// is in. Before this clause a row was not proof that the agent this host
		// acts as may post there, and the only way to find out was to try and be
		// refused. The empty arm is asserted with the same weight as the seated
		// one — it is the row a model most needs to read correctly, and a clause
		// that vanished there would read as a rendering fault rather than as the
		// fact that a send would be refused.
		const { client } = fakeClient({
			groups: {
				list: async () => ({
					items: [
						{
							id: GROUP_ID,
							handle: "#ops@acme",
							mls_enabled: true,
							mls_group_id: "mls1",
							enrollment_policy: "closed",
							visibility: "private",
							member_count: 4,
							conversation_id: CONVERSATION_ID,
							member_agent_ids: [OWN_AGENT, OTHER_OWN_AGENT],
						},
						{
							id: "22222222-2222-2222-2222-222222222222",
							handle: "#lobby@acme",
							mls_enabled: false,
							mls_group_id: null,
							enrollment_policy: "open",
							visibility: "public",
							member_count: 12,
							conversation_id: null,
							member_agent_ids: [],
						},
					],
				}),
			},
		});
		const out = await run(rineGroupsTool({ client }), {});
		// The fake answers an empty handle map, which is what a real client
		// answers when `GET /agents` fails: every id falls to case 2 and prints
		// as itself. The resolved case is asserted below.
		expect(out).toContain(`your agents: ${OWN_AGENT}, ${OTHER_OWN_AGENT}`);
		expect(out).toContain(`your agents: ${NO_OWN_AGENTS}`);
		// `member_count` is the WHOLE roster and stays untouched: the new clause
		// is this org's share of it, not a replacement for it.
		expect(out).toContain("4 member(s)");
		expect(out).toContain("12 member(s)");
	});

	it("names the seated agents by handle, not by UUID", async () => {
		// A model reads its own handle on every other surface and has never
		// seen its UUID, so a row of UUIDs could not be acted on. An id this
		// org's list does not carry still prints as itself — degraded, not lost.
		const { client } = fakeClient({
			agentHandles: async () => new Map([[OWN_AGENT, "ops@acme"]]),
			groups: {
				list: async () => ({
					items: [
						{
							id: GROUP_ID,
							handle: "#ops@acme",
							mls_enabled: false,
							mls_group_id: null,
							enrollment_policy: "closed",
							visibility: "private",
							member_count: 4,
							conversation_id: CONVERSATION_ID,
							member_agent_ids: [OWN_AGENT, OTHER_OWN_AGENT],
						},
					],
				}),
			},
		});
		const out = await run(rineGroupsTool({ client }), {});
		expect(out).toContain(`your agents: ops@acme, ${OTHER_OWN_AGENT}`);
		expect(out).not.toContain(OWN_AGENT);
	});

	it("reports the empty state rather than an empty string", async () => {
		const { client } = fakeClient({
			groups: { list: async () => ({ items: [] }) },
		});
		expect(await run(rineGroupsTool({ client }), {})).toBe(
			"This agent belongs to no groups.",
		);
	});
});

describe("rine_discover_groups", () => {
	it("passes the query through and renders each public group", async () => {
		let seen: unknown;
		const { client } = fakeClient({
			discoverGroups: async (opts: unknown) => {
				seen = opts;
				return {
					items: [
						{
							id: GROUP_ID,
							name: "Ops",
							handle: "#ops@acme",
							description: "shift handover",
							enrollment_policy: "open",
							visibility: "public",
							member_count: 9,
						},
					],
				};
			},
		});
		const out = await run(rineDiscoverGroupsTool({ client }), { q: "ops" });
		expect(seen).toEqual({ q: "ops", limit: 10 });
		expect(out).toContain("1. #ops@acme");
		expect(out).toContain("enrollment open, 9 member(s)");
		expect(out).toContain("shift handover");
	});

	it("says what the list is before the rows, so it cannot be read as a membership list", async () => {
		// `rine_groups` above prints near-identical numbered rows and every one
		// of those IS a group this org holds a seat in. This route carries no
		// identity at all, so no row here can answer that question — and two
		// numbered lists told apart by nothing but the tool's own name is how a
		// directory hit gets read as a seat.
		const { client } = fakeClient({
			discoverGroups: async () => ({
				items: [
					{
						id: GROUP_ID,
						name: "Ops",
						handle: "#ops@acme",
						enrollment_policy: "closed",
						visibility: "public",
						member_count: 2,
					},
				],
			}),
		});
		const out = await run(rineDiscoverGroupsTool({ client }), {});
		expect(out.split("\n")[0]).toBe(
			"1 public group(s) found in the directory. A row here is a group that exists, not a group this agent is in:",
		);
		expect(out).toContain("1. #ops@acme");
		// The header states what the caller is looking at and names no verb —
		// which tool to reach for next is the tool description's sentence.
		expect(out).not.toContain("rine_group_join");
	});

	it("names the verb that acts on a row it found", () => {
		// This is the one tool on this surface that returns groups the calling
		// org holds no seat in, and the route it reads carries no identity — so
		// a row here can never say whether the agent is in the group, and the
		// description is the only place the next step can be stated. The
		// assertion is the verb, not the wording around it.
		const { client } = fakeClient({});
		const description = rineDiscoverGroupsTool({ client }).description ?? "";
		expect(description).toContain("rine_group_join");
		expect(description).toContain("not a group your agent is in");
	});

	it("claims no encryption mode — the directory reports none", async () => {
		const { client } = fakeClient({
			discoverGroups: async () => ({
				items: [
					{
						id: GROUP_ID,
						name: "Ops",
						handle: "#ops@acme",
						enrollment_policy: "closed",
						visibility: "public",
						member_count: 2,
					},
				],
			}),
		});
		const out = await run(rineDiscoverGroupsTool({ client }), {});
		expect(out).not.toContain("MLS");
		expect(out).not.toContain("sender-key");
	});

	it("reports the empty state rather than an empty string", async () => {
		const { client } = fakeClient({
			discoverGroups: async () => ({ items: [] }),
		});
		expect(await run(rineDiscoverGroupsTool({ client }), {})).toBe(
			"No public groups matched.",
		);
	});
});

describe("rine_group_roster", () => {
	it("renders handle, role and join date, resolving a handle to a UUID first", async () => {
		let seenGroupId: unknown;
		const { client } = fakeClient({
			groups: {
				list: async () => ({
					items: [{ id: GROUP_ID, handle: "#ops@acme", member_count: 2 }],
				}),
				members: async (groupId: unknown) => {
					seenGroupId = groupId;
					return {
						items: [
							{
								group_id: GROUP_ID,
								agent_id: "a1",
								agent_handle: "ana@acme",
								role: "admin",
								joined_at: "2026-06-01T00:00:00Z",
							},
							{
								group_id: GROUP_ID,
								agent_id: "a2",
								agent_handle: null,
								role: "member",
								joined_at: "2026-06-02T00:00:00Z",
							},
						],
					};
				},
			},
		});
		const out = await run(rineGroupRosterTool({ client }), {
			group: "#ops@acme",
		});
		expect(seenGroupId).toBe(GROUP_ID);
		expect(out).toContain("1. ana@acme — admin, joined 2026-06-01");
		// No handle on the wire falls back to the agent id, never to blank.
		expect(out).toContain("2. a2 — member, joined 2026-06-02");
	});

	it("marks this org's own rows and hides none of the others", async () => {
		// `is_own_org` is a MARKER, never a filter. The roster is the whole
		// group across every org, and the mark only says which of those seats
		// this host could act as. A renderer that dropped the unmarked rows
		// would contradict `member_count`, which counts them.
		const { client } = fakeClient({
			groups: {
				list: async () => ({
					items: [{ id: GROUP_ID, handle: "#ops@acme", member_count: 2 }],
				}),
				members: async () => ({
					items: [
						{
							group_id: GROUP_ID,
							agent_id: OWN_AGENT,
							agent_handle: "ana@acme",
							role: "admin",
							joined_at: "2026-06-01T00:00:00Z",
							is_own_org: true,
						},
						{
							group_id: GROUP_ID,
							agent_id: "a-other",
							agent_handle: "bo@beta",
							role: "member",
							joined_at: "2026-06-02T00:00:00Z",
							is_own_org: false,
						},
					],
				}),
			},
		});
		const out = await run(rineGroupRosterTool({ client }), {
			group: "#ops@acme",
		});
		expect(out).toContain("1. ana@acme — admin, joined 2026-06-01 (yours)");
		// Present, and unmarked — the other org's seat is still a member.
		expect(out).toContain("2. bo@beta — member, joined 2026-06-02");
		expect(out).not.toContain("bo@beta — member, joined 2026-06-02 (yours)");
	});

	it("reports a group this agent is not in rather than an empty roster", async () => {
		const { client } = fakeClient({
			groups: { list: async () => ({ items: [] }) },
		});
		const out = await run(rineGroupRosterTool({ client }), {
			group: "#nope@acme",
		});
		// This package no longer mints a group 404 of its own — the SDK's
		// resolver refuses, in the sentence every rine surface refuses in, and
		// `formatError` appends only the verb that can still find something new.
		expect(out).toContain("Group not found: #nope@acme");
		expect(out).toContain("rine_discover_groups");
		expect(out).not.toContain("rine_groups");
	});
});
