/**
 * The group tools at the wire: proven against a REAL `AsyncRineClient` over a
 * routed `fetch`.
 *
 * Everything asserted here is a claim about REQUESTS, which is the one class of
 * claim this package's client-level fakes cannot make (see `fetch-harness.ts`).
 * Three things are under test and nothing else:
 *
 *   1. the resolve happens, against the shipped ladder — a UUID reads the
 *      group's own row, a name reads the org's list;
 *   2. the FOLD — a verb handed the resolve's record reads the group
 *      once, not twice, and a naive migration to `resolveRef(...).id` is what
 *      that assertion catches;
 *   3. the refusals — a 404 and a 403 on the group's own row are byte-identical
 *      to the caller, and a 500 is not swallowed into either.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Hoisted above the imports below: the client authenticates without key
// material on disk, and nothing else about `@rine-network/core` is faked — the
// resolve ladder, the path literals and the refusal sentences are the real ones.
vi.mock("@rine-network/core", async () => {
	const actual =
		await vi.importActual<typeof import("@rine-network/core")>(
			"@rine-network/core",
		);
	return {
		...actual,
		getOrRefreshToken: vi.fn(async () => "stub-token"),
	};
});

import { _resetClientCache, getRineClient } from "../src/client.js";
import {
	rineGroupInspectTool,
	rineGroupLeaveTool,
	rineGroupRosterTool,
} from "../src/tools/index.js";
import {
	type RouteAnswer,
	barePath,
	groupReads,
	groupRowFixture,
	routedFetch,
} from "./fetch-harness.js";

const API = "https://api.test";
const GROUP_ID = "11111111-1111-1111-1111-111111111111";
const ROW = groupRowFixture();

// biome-ignore lint/suspicious/noExplicitAny: descriptor execute is (input, ctx).
const run = (tool: any, input: unknown) => tool.execute(input, {});

function harness(routes: Record<string, RouteAnswer>) {
	const { fetch, requests } = routedFetch(API, routes);
	vi.stubGlobal("fetch", fetch);
	_resetClientCache();
	const client = getRineClient({ configDir: "/tmp/eve-test", apiUrl: API });
	return { client, requests };
}

const AGENTS_PAGE = { items: [], next_cursor: null };
// The acting agent as the server lists it: `leave` resolves the leaver through
// `messages.resolveSenderId`, so a page with no rows kills the verb before it
// ever writes, and every assertion after that point measures nothing.
const SELF_AGENT_PAGE = {
	items: [
		{
			id: "22222222-2222-4222-8222-222222222222",
			name: "eve",
			handle: "eve@acme",
			created_at: "2026-01-01T00:00:00.000Z",
		},
	],
	next_cursor: null,
};
const OWN_GROUPS = { items: [ROW], next_cursor: null };

beforeEach(() => _resetClientCache());
afterEach(() => {
	vi.unstubAllGlobals();
	_resetClientCache();
});

describe("rine_group_inspect", () => {
	it("test_inspect_when_given_a_uuid_reads_the_group_row_once", async () => {
		const { client, requests } = harness({
			[`GET /groups/${GROUP_ID}`]: ROW,
			"GET /agents": AGENTS_PAGE,
		});
		const out = await run(rineGroupInspectTool({ client }), { group: GROUP_ID });

		// The row the resolve already read IS what this tool renders. One read —
		// a migration that resolved to an id and then bought the row again would
		// score 2 here, and the old `groups.list()` search would have paid the
		// unpaginated list for a caller who named a UUID.
		expect(groupReads(requests, GROUP_ID)).toBe(1);
		expect(
			requests.filter((r) => barePath(r.path) === "/groups"),
		).toHaveLength(0);
		expect(out).toContain("#ops@acme");
	});

	it("test_inspect_when_given_a_bare_name_reads_the_org_list_once", async () => {
		const { client, requests } = harness({
			"GET /groups": OWN_GROUPS,
			"GET /agents": AGENTS_PAGE,
		});
		const out = await run(rineGroupInspectTool({ client }), { group: "ops" });

		expect(groupReads(requests, GROUP_ID)).toBe(1);
		expect(out).toContain("#ops@acme");
	});
});

describe("the resolve fold", () => {
	it("test_leave_when_handed_the_resolved_record_reads_the_group_once", async () => {
		// `leave` reads the group BEFORE it writes, so the resolve's row is the
		// answer and the verb spends no `GET /groups/{id}` of its own. This is the
		// assertion a `resolveRef(...).id` call site fails.
		//
		// 🔴 `GET /agents` is routed and the call is NOT swallowed. `leave` →
		// `resolveLeaver` → `messages.resolveSenderId` needs the agent list, so
		// with that route missing the verb threw before it ever reached the write
		// — and `groupReads() === 1` was counting the resolve alone, which the
		// `.id` mutation this test names passes just as happily.
		const { client, requests } = harness({
			[`GET /groups/${GROUP_ID}`]: groupRowFixture({
				mls_enabled: false,
				mls_group_id: null,
			}),
			"GET /agents": SELF_AGENT_PAGE,
			[`DELETE /groups/${GROUP_ID}/members/me`]: {
				message: "Left #ops@acme.",
			},
			[`POST /groups/${GROUP_ID}/leave`]: { message: "Left #ops@acme." },
		});
		await run(rineGroupLeaveTool({ client }), { group: GROUP_ID });

		expect(groupReads(requests, GROUP_ID)).toBe(1);
		// The write really ran: a fold assertion over a verb that died early is
		// a measurement of nothing.
		expect(
			requests.some(
				(r) => r.method !== "GET" && r.path.startsWith(`/groups/${GROUP_ID}`),
			),
		).toBe(true);
	});

	it("test_roster_when_given_a_uuid_addresses_members_by_the_resolved_id", async () => {
		const { client, requests } = harness({
			[`GET /groups/${GROUP_ID}`]: ROW,
			[`GET /groups/${GROUP_ID}/members`]: { items: [], next_cursor: null },
		});
		await run(rineGroupRosterTool({ client }), { group: GROUP_ID });

		// `/groups/undefined/members` is what a harness that answered one shape for
		// every route used to produce, and it read as a pass.
		expect(requests.map((r) => r.path)).toContain(`/groups/${GROUP_ID}/members`);
	});
});

describe("refusals reach the caller unchanged", () => {
	// 🔴 The roster this refusal prints must NOT contain the id being refused.
	// With the refused group in the org list, a ladder that ever gained a
	// list-fallback rung would render it successfully on BOTH calls and the
	// equality below would hold on two successes — the property would stop
	// being tested with nothing turning red.
	const OTHER_GROUP = groupRowFixture({
		id: "33333333-3333-3333-3333-333333333333",
		handle: "#billing@acme",
	});

	const refusalFor = async (status: number) => {
		const { client } = harness({
			[`GET /groups/${GROUP_ID}`]: { status, detail: "nope" },
			"GET /groups": { items: [OTHER_GROUP], next_cursor: null },
			"GET /agents": AGENTS_PAGE,
		});
		return await run(rineGroupInspectTool({ client }), { group: GROUP_ID });
	};

	it("test_group_row_when_refused_404_or_403_answers_byte_identically", async () => {
		// Whether the id belongs to somebody else's group or to no group at all is
		// not the caller's business and must not be inferable from the sentence.
		const refused = await refusalFor(404);
		// Both answers are REFUSALS, not two equal successes.
		expect(refused).toContain("Group not found");
		expect(refused).toBe(await refusalFor(403));
	});

	it("test_group_row_when_refused_names_the_roster_and_no_group_verb", async () => {
		const out = await refusalFor(404);
		expect(out).toContain("Name one of these groups:");
		// The refusal is already printing the roster, so telling the model to
		// go and fetch it is a loop this surface removed. Only the directory search
		// can still find something new.
		expect(out).not.toContain("rine_groups");
		expect(out).toContain("rine_discover_groups");
	});

	it("test_group_row_when_the_server_500s_propagates_the_500", async () => {
		const { client } = harness({
			[`GET /groups/${GROUP_ID}`]: { status: 500, detail: "boom" },
			"GET /agents": AGENTS_PAGE,
		});
		const out = await run(rineGroupInspectTool({ client }), { group: GROUP_ID });
		expect(out).toContain("500");
		expect(out).not.toContain("Name one of these groups:");
	});
});
