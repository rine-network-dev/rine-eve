/**
 * Handle completion on the Eve surface — a completed handle is reported, not
 * silent.
 *
 * `resolveToUuid` completes a short handle before WebFinger sees it — `peer@acme`
 * is looked up as `peer@acme.rine.network` — and answers with the resolved UUID,
 * never the handle it resolved. The three write verbs that take an agent
 * spelling (create's roster, invite, remove) therefore act on an agent the
 * caller may not have named, and every one of them answers in UUIDs, which agree
 * with the completion rather than with what was typed.
 *
 * 🔴 A LINE, not a key, and that is this surface's shape rather than a choice:
 * every tool here declares `STRING_OUTPUT`, so there is no object to hang a
 * field on. `@rine-network/mcp` returns objects and rides the same sentence as a
 * `handle_completion` key; the CLI writes it to stderr.
 *
 * 🔴 Nothing here retypes the sentence — every expectation derives it from
 * `@rine-network/core`, whose own suite pins the bytes. Four surfaces agreeing
 * with each other and none of them agreeing with `normalizeHandle` is exactly
 * the drift a hand-typed copy would hide.
 *
 * 🔴 Driven over the routed `fetch`, not this package's client-level fake, for
 * the reason `fetch-harness.ts` exists: the completion happens INSIDE
 * `resolveToUuid`, so a fake that answers whatever the code asks it for cannot
 * tell a resolve that completed a spelling from one that did not.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Hoisted above the imports below, as in `groups-fetch.test.ts`: the client
// authenticates without key material on disk, and nothing else about
// `@rine-network/core` is faked — the completion under test is the real one.
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

import { handleCompletionNotes } from "@rine-network/core";
import { _resetClientCache, getRineClient } from "../src/client.js";
import {
	rineGroupCreateTool,
	rineGroupInviteTool,
	rineGroupRemoveTool,
} from "../src/tools/index.js";
import {
	type RouteAnswer,
	groupRowFixture,
	routedFetch,
} from "./fetch-harness.js";

const API = "https://api.test";
const GROUP_ID = "11111111-1111-1111-1111-111111111111";
const PEER_ID = "33333333-3333-4333-8333-333333333333";
const ROW = groupRowFixture({ mls_enabled: false, mls_group_id: null });

/** The org half without its domain — what a model types when it half-remembers. */
const TYPED = "peer@acme";
/** What the lookup actually used. */
const WHOLE = "peer@acme.rine.network";
/** The sentence the caller is owed for it, composed in `@rine-network/core`. */
const NOTICE = handleCompletionNotes([TYPED]);

/**
 * WebFinger answers the same UUID whatever spelling is asked for.
 *
 * 🔴 Deliberate: what the notice reports is the SPELLING the caller typed, and
 * it must not be derivable from the lookup's answer. A route that echoed the
 * request's `resource` back would let a wrong implementation pass by reading
 * its own input.
 */
const WEBFINGER = {
	subject: `acct:${WHOLE}`,
	aliases: [`${API}/agents/${PEER_ID}`],
};

/**
 * The acting agent as the server lists it.
 *
 * 🔴 Routed on every arm, not just the ones that read it. `invite` and `remove`
 * resolve the ACTING agent through `GET /agents`, and both swallow a failure
 * into a warning — so with the route missing the invite notifications are
 * skipped and the removal posts no Remove commit at all, while every assertion
 * here still passes. That is a verb running degraded underneath a green arm,
 * which is the shape `groups-fetch.test.ts` names as measuring nothing.
 */
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

// biome-ignore lint/suspicious/noExplicitAny: descriptor execute is (input, ctx).
const run = (tool: any, input: unknown) => tool.execute(input, {});

function harness(routes: Record<string, RouteAnswer>) {
	const { fetch, requests } = routedFetch(API, {
		"GET /.well-known/webfinger": WEBFINGER,
		"GET /agents": SELF_AGENT_PAGE,
		...routes,
	});
	vi.stubGlobal("fetch", fetch);
	_resetClientCache();
	const client = getRineClient({ configDir: "/tmp/eve-test", apiUrl: API });
	return { client, requests };
}

beforeEach(() => _resetClientCache());
afterEach(() => {
	vi.unstubAllGlobals();
	_resetClientCache();
});

describe("rine_group_create — a rewritten roster spelling is named", () => {
	// A founding roster is where a silent completion does the most damage and
	// hides the best: one rewritten name among twenty seats itself, and every
	// later read of the group agrees with the seat rather than with what was
	// typed.
	it("leads the answer with the notice, and still reports the roster", async () => {
		// `{group, roster}` — the shape the server answers a rostered create with,
		// and the one the SDK unwraps. A roster nested on the row itself is the
		// shape nothing produces.
		const { client } = harness({
			"POST /groups": {
				group: ROW,
				roster: {
					invited: 1,
					skipped: 0,
					entries: [{ agent_id: PEER_ID, status: "invited", reason: null }],
				},
			},
		});

		const out = await run(rineGroupCreateTool({ client, apiUrl: API }), {
			name: "Ops",
			visibility: "private",
			enableMls: false,
			members: [TYPED],
		});

		// 🔴 It LEADS rather than trails: a model reads the head of a tool result
		// and acts on it, and a caveat about which agent was actually admitted is
		// worth nothing underneath the report of admitting them.
		expect(out.startsWith(`${NOTICE}\n`)).toBe(true);
		// The notice is a caveat about WHICH agents were admitted, never a
		// substitute for the admission report.
		expect(out).toContain("1 of 1 reached; 1 new invitation to accept.");
		expect(out).toContain("nobody is a member until they join");
	});

	// The create answer has two shapes — with a roster and without one — and the
	// notice is owed on both. The rosterless arm returns from a different
	// statement, which is where a per-branch renderer loses it.
	it("still names it when the server answered no roster", async () => {
		const { client } = harness({ "POST /groups": ROW });

		const out = await run(rineGroupCreateTool({ client, apiUrl: API }), {
			name: "Ops",
			visibility: "private",
			enableMls: false,
			members: [TYPED],
		});

		expect(out.startsWith(`${NOTICE}\n`)).toBe(true);
		expect(out).toContain("Created group #ops@acme");
	});

	it("says nothing when every rostered spelling was already whole", async () => {
		const { client } = harness({ "POST /groups": ROW });

		const out = await run(rineGroupCreateTool({ client, apiUrl: API }), {
			name: "Ops",
			visibility: "private",
			enableMls: false,
			members: [WHOLE],
		});

		expect(out).not.toContain("was completed to");
		expect(out.startsWith("Created group #ops@acme")).toBe(true);
	});
});

describe("rine_group_invite — a rewritten invitee spelling is named", () => {
	// `GET /agents/{id}/keys` is deliberately NOT routed: sealing the best-effort
	// `rine.v1.group_invite` notice would need real key material on disk, which
	// this harness exists to avoid. It warns and the invitation stands, which is
	// the shipped behaviour — unlike the acting-agent read above, nothing about
	// the invite itself is degraded by it.
	const inviteRoutes: Record<string, RouteAnswer> = {
		[`GET /groups/${GROUP_ID}`]: ROW,
		[`POST /groups/${GROUP_ID}/invite`]: { status: "invited" },
	};

	// 🔴 This arm is why the notice is owed at all here: `renderSingularInvite`
	// echoes the caller's own spelling, so without it the answer agrees with what
	// was typed while the invitation went to the completed handle.
	it("names it beside the sentence that echoes the caller's spelling", async () => {
		const { client } = harness(inviteRoutes);

		const out = await run(rineGroupInviteTool({ client, apiUrl: API }), {
			group: GROUP_ID,
			agentToInvite: TYPED,
		});

		expect(out.startsWith(`${NOTICE}\n`)).toBe(true);
		expect(out).toContain(`Invited ${TYPED} to ${GROUP_ID}.`);
	});

	it("names only the batch spellings that were rewritten", async () => {
		const { client } = harness({
			...inviteRoutes,
			[`POST /groups/${GROUP_ID}/invite`]: {
				invited: 1,
				skipped: 0,
				entries: [{ agent_id: PEER_ID, status: "invited", reason: null }],
			},
		});

		const out = await run(rineGroupInviteTool({ client, apiUrl: API }), {
			group: GROUP_ID,
			agentsToInvite: [TYPED, WHOLE],
		});

		expect(out.startsWith(`${NOTICE}\n`)).toBe(true);
		// One sentence, not two: the whole spelling contributes nothing, and the
		// two spellings resolve to the SAME id, which the batch resolver drops.
		expect(out.split("was completed to")).toHaveLength(2);
		expect(out).toContain(`Invited into ${GROUP_ID}:`);
	});

	it("says nothing when the invitee's spelling was already whole", async () => {
		const { client } = harness(inviteRoutes);

		const out = await run(rineGroupInviteTool({ client, apiUrl: API }), {
			group: GROUP_ID,
			agentToInvite: WHOLE,
		});

		expect(out).not.toContain("was completed to");
		expect(out.startsWith("Invited ")).toBe(true);
	});
});

describe("rine_group_remove — a rewritten target spelling is named", () => {
	const removeRoutes: Record<string, RouteAnswer> = {
		[`GET /groups/${GROUP_ID}`]: ROW,
		[`DELETE /groups/${GROUP_ID}/members/${PEER_ID}`]: {
			message: "Removed them from #ops@acme.",
		},
	};

	// 🔴 The verb where a silent completion is least recoverable: a removal takes
	// nothing back. The SDK's sentence names what it acted on, so the notice is
	// the only thing tying that back to the spelling the caller typed.
	it("names it above the SDK's own eviction sentence", async () => {
		const { client } = harness(removeRoutes);

		const out = await run(rineGroupRemoveTool({ client, apiUrl: API }), {
			group: GROUP_ID,
			agentId: TYPED,
		});

		expect(out.startsWith(`${NOTICE}\n`)).toBe(true);
		// The accurate sentence is still the SDK's and is not replaced by the
		// caveat — composing a second one here is how the surfaces once shipped a
		// removal sentence that was false for open groups. It names
		// the UUID it acted on, which is precisely what the notice ties back to
		// the spelling that was typed.
		expect(out).toContain(`Removed ${PEER_ID} from group`);
	});

	it("says nothing when the target's spelling was already whole", async () => {
		const { client } = harness(removeRoutes);

		const out = await run(rineGroupRemoveTool({ client, apiUrl: API }), {
			group: GROUP_ID,
			agentId: WHOLE,
		});

		expect(out).not.toContain("was completed to");
	});
});
