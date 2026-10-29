/**
 * The five admission verbs on the Eve surface: `rine_group_requests`,
 * `rine_group_vote`, `rine_group_leave`, `rine_group_sync`,
 * `rine_group_reclaim`.
 *
 * These assert what a model sees — the arguments that reach the SDK and the
 * sentence that comes back — rather than the shape of the code producing them.
 * The verbs whose truth differs by group type return the SDK's own sentence, so
 * what is asserted there is that the tool did not compose a second one.
 */

import { AuthorizationError } from "@rine-network/sdk";
import { describe, expect, it } from "vitest";
import {
	rineGroupCreateTool,
	rineGroupJoinTool,
	rineGroupLeaveTool,
	rineGroupReclaimTool,
	rineGroupRequestsTool,
	rineGroupSyncTool,
	rineGroupVoteTool,
} from "../src/tools/index.js";
import { fakeClient } from "./helpers.js";

const GROUP_ID = "11111111-1111-1111-1111-111111111111";
const REQUEST_ID = "44444444-4444-4444-8444-444444444444";
const APPLICANT = "55555555-5555-4555-8555-555555555555";

// biome-ignore lint/suspicious/noExplicitAny: descriptor execute is (input, ctx).
const run = (tool: any, input: unknown) => tool.execute(input, {});

/** A groups fake that can resolve `#ops@acme` to {@link GROUP_ID}. */
function groups(over: Record<string, unknown>) {
	return {
		list: async () => ({
			items: [
				{
					id: GROUP_ID,
					handle: "#ops@acme",
					enrollment_policy: "majority",
					visibility: "private",
					mls_enabled: true,
					mls_group_id: "mls1",
				},
			],
		}),
		...over,
	};
}

const requestRow = (over: Record<string, unknown> = {}) => ({
	id: REQUEST_ID,
	group_id: GROUP_ID,
	agent_id: APPLICANT,
	status: "pending",
	expires_at: "2026-08-10T00:00:00Z",
	created_at: "2026-08-03T00:00:00Z",
	...over,
});

describe("rine_group_requests", () => {
	it("asks for the vote queue when no filter was named", async () => {
		let seen: unknown;
		const { client } = fakeClient({
			groups: groups({
				listRequests: async (_id: string, opts: Record<string, unknown>) => {
					seen = opts;
					return [requestRow()];
				},
			}),
		});
		const out = await run(rineGroupRequestsTool({ client }), {
			group: GROUP_ID,
		});
		expect(seen).toEqual({ outstanding: "pending" });
		// The group reference the caller gave, not a UUID it never named.
		expect(out).toContain(`Outstanding in \`${GROUP_ID}\` (pending): 1`);
		expect(out).toContain(REQUEST_ID);
		expect(out).toContain(APPLICANT);
		expect(out).toContain("expires 2026-08-10T00:00:00Z");
	});

	it("passes `live` through — members plus live is the whole tree", async () => {
		let seen: unknown;
		const { client } = fakeClient({
			groups: groups({
				listRequests: async (_id: string, opts: Record<string, unknown>) => {
					seen = opts;
					return [];
				},
			}),
		});
		const out = await run(rineGroupRequestsTool({ client }), {
			group: "#ops@acme",
			outstanding: "live",
		});
		expect(seen).toEqual({ outstanding: "live" });
		expect(out).toBe("Nothing outstanding in `#ops@acme` under filter `live`.");
	});
});

describe("rine_group_vote", () => {
	it("records the vote and says nothing about seating while pending", async () => {
		const calls: unknown[][] = [];
		const { client } = fakeClient({
			groups: groups({
				vote: async (...args: unknown[]) => {
					calls.push(args);
					return {
						request_id: REQUEST_ID,
						your_vote: "approve",
						status: "pending",
					};
				},
			}),
		});
		const out = await run(rineGroupVoteTool({ client }), {
			group: GROUP_ID,
			requestId: REQUEST_ID,
			vote: "approve",
		});
		// The RECORD, not its id — `vote` takes a `GroupSelector`. It does
		// not fold it (its read follows its own POST), but a call site
		// that handed over a bare id would be re-deriving what the resolve knew.
		expect(calls[0]?.[0]).toMatchObject({ id: GROUP_ID, spelling: GROUP_ID });
		expect(calls[0]?.slice(1)).toEqual([REQUEST_ID, "approve"]);
		expect(out).toContain("Vote `approve` recorded on request");
		expect(out).toContain("Request status: `pending`.");
		expect(out).not.toContain("now a member");
	});

	it("says the leaf and Welcome were minted once the vote approved it", async () => {
		const { client } = fakeClient({
			groups: groups({
				vote: async () => ({
					request_id: REQUEST_ID,
					your_vote: "approve",
					status: "approved",
					mls_seated: true,
				}),
			}),
		});
		const out = await run(rineGroupVoteTool({ client }), {
			group: "#ops@acme",
			requestId: REQUEST_ID,
			vote: "approve",
		});
		// True only because the SDK reported that it seated the applicant inside
		// vote(): the leaf and the Welcome are minted in that same call.
		expect(out).toContain(
			"The applicant is now a member; their ratchet-tree leaf and Welcome were minted as part of this vote.",
		);
	});

	it("never claims a leaf and a Welcome the SDK did not mint", async () => {
		// The seat is best-effort: a sender-key group has no tree, and an add
		// commit that fails is swallowed so the vote can still be reported. On the
		// server status alone this claimed a Welcome for every one of them.
		const { client } = fakeClient({
			groups: groups({
				vote: async () => ({
					request_id: REQUEST_ID,
					your_vote: "approve",
					status: "approved",
					mls_seated: false,
				}),
			}),
		});
		const out = await run(rineGroupVoteTool({ client }), {
			group: "#ops@acme",
			requestId: REQUEST_ID,
			vote: "approve",
		});
		expect(out).toContain("The applicant is now a member.");
		expect(out).toContain("resume-admission");
		expect(out).not.toContain("were minted as part of this vote");
	});

	// A carried vote on a nomination the nominee never
	// consented to resolves the row to `invited`, not to a seat — and no stack
	// anticipated the word. Falling through to the bare status line hands a model
	// a status no other outcome of this tool uses.
	it("names the carried vote that produced an invitation rather than a member", async () => {
		const { client } = fakeClient({
			groups: groups({
				vote: async () => ({
					request_id: REQUEST_ID,
					your_vote: "approve",
					status: "invited",
				}),
			}),
		});
		const out = await run(rineGroupVoteTool({ client }), {
			group: "#ops@acme",
			requestId: REQUEST_ID,
			vote: "approve",
		});
		expect(out).toContain("Request status: `invited`.");
		expect(out).toContain("The electorate approved it");
		expect(out).toContain("holds a spendable invitation rather than a seat");
		expect(out).toContain("becomes a member when it accepts");
		// Neither of the two sentences an approve-and-seat prints.
		expect(out).not.toContain("The applicant is now a member");
		expect(out).not.toContain("were minted as part of this vote");
	});

	it("reports a denial as a denial", async () => {
		const { client } = fakeClient({
			groups: groups({
				vote: async () => ({
					request_id: REQUEST_ID,
					your_vote: "deny",
					status: "denied",
				}),
			}),
		});
		const out = await run(rineGroupVoteTool({ client }), {
			group: GROUP_ID,
			requestId: REQUEST_ID,
			vote: "deny",
		});
		expect(out).toContain("Vote `deny` recorded");
		expect(out).toContain("Request status: `denied`.");
		expect(out).not.toContain("now a member");
	});
});

describe("rine_group_leave", () => {
	it("returns the SDK's sentence for this group type, not a second one", async () => {
		let seen: unknown;
		const message =
			"You left group #ops@acme. No Remove commit was posted — MLS gives " +
			"nobody a way to commit their own removal.";
		const { client } = fakeClient({
			groups: groups({
				leave: async (id: string) => {
					seen = id;
					return { left: true, encryption: "mls", message };
				},
			}),
		});
		const out = await run(rineGroupLeaveTool({ client }), { group: GROUP_ID });
		// The resolve's whole record, which is what lets `leave` read the group
		// zero extra times; the count itself is asserted in `groups-fetch.test.ts`.
		expect(seen).toMatchObject({ id: GROUP_ID, handle: "#ops@acme" });
		expect(out).toBe(message);
	});
});

describe("rine_group_sync", () => {
	it("reports the cheap rung as having committed nothing", async () => {
		let seen: unknown;
		const { client } = fakeClient({
			groups: groups({
				sync: async (id: string) => {
					seen = id;
					return {
						regime: "mls",
						rung: "replay",
						fromEpoch: 3,
						epoch: 7,
						behind: 4,
						processed: 4,
						evicted: false,
					};
				},
			}),
		});
		const out = await run(rineGroupSyncTool({ client }), {
			group: "#ops@acme",
		});
		// The handle the caller named resolved to the group's record for the SDK —
		// carrying the caller's own spelling — and the report still names the
		// handle back rather than the UUID the caller never typed.
		expect(seen).toMatchObject({ id: GROUP_ID, spelling: "#ops@acme" });
		expect(out).toContain("#ops@acme");
		expect(out).toContain("Nothing was committed.");
	});

	it("says an expensive resync posts a commit every member pays for", async () => {
		const { client } = fakeClient({
			groups: groups({
				sync: async () => ({
					regime: "mls",
					rung: "resync",
					fromEpoch: 2,
					epoch: 13,
					behind: 11,
					processed: 0,
					evicted: false,
				}),
			}),
		});
		const out = await run(rineGroupSyncTool({ client }), { group: GROUP_ID });
		expect(out).toContain("O(N)");
		expect(out).toContain("every member of the group downloads");
	});

	it("recovers a sender-key group by installing the keys that were waiting", async () => {
		// An open group has no epoch chain, so the answer carries none of the MLS
		// arm's fields — it says what was installed and that nothing was
		// committed. Which arm ran is `regime` and nothing else.
		const { client } = fakeClient({
			groups: groups({
				sync: async () => ({
					regime: "sender-key",
					ingested: 3,
					retired: false,
				}),
			}),
		});
		const out = await run(rineGroupSyncTool({ client }), { group: GROUP_ID });
		expect(out).toContain("installed 3 sender key(s)");
		expect(out).toContain("nothing was committed and this cost reads only");
		// An open group's removals are the server's delivery filter, never an MLS
		// Remove, so the eviction sentence can never belong to this answer.
		expect(out).not.toContain("was removed from the group");
	});

	it("says an agent that retired this group's keys needs an invitation", async () => {
		const { client } = fakeClient({
			groups: groups({
				sync: async () => ({
					regime: "sender-key",
					ingested: 0,
					retired: true,
				}),
			}),
		});
		const out = await run(rineGroupSyncTool({ client }), { group: GROUP_ID });
		expect(out).toContain("needs an invitation");
		// The gate fails closed, so `retired` also covers a membership read that
		// never got an answer: the retry comes first and the escalation second.
		expect(out).toContain("run the sync again");
	});
});

/** The 403 the vote route answers, carrying the code a caller branches on. */
function refusal(code: string, detail: string): AuthorizationError {
	const err = new AuthorizationError(detail);
	err.code = code;
	return err;
}

describe("an outstanding row reports where the vote stands", () => {
	/** One row through `rine_group_requests`, as the model would read it. */
	async function row(over: Record<string, unknown>): Promise<string> {
		const { client } = fakeClient({
			groups: groups({ listRequests: async () => [requestRow(over)] }),
		});
		return await run(rineGroupRequestsTool({ client }), { group: GROUP_ID });
	}

	it("an eligible voter reads the arithmetic and that the vote counts", async () => {
		const out = await row({
			quorum_total_members: 9,
			electorate_size: 3,
			approvals: 1,
			denials: 0,
			approvals_needed: 1,
			denials_needed: 2,
			you_may_vote: true,
			you_may_vote_reason: "in_electorate",
		});
		// Character for character the Python twin's clause: both bars, one string,
		// on all four surfaces that render a request row.
		expect(out).toContain(
			"1 approved, 1 more needed of 3 eligible; 0 denied, 2 more would refuse it",
		);
		expect(out).toContain("you can vote");
	});

	// The denial bar moves on its own — it falls as members leave — so a row
	// that reports only the approval half cannot explain a request its standing
	// denials went on to refuse.
	it("a denial bar the server sent is printed beside the approval one", async () => {
		const out = await row({
			electorate_size: 4,
			approvals: 1,
			denials: 1,
			approvals_needed: 2,
			denials_needed: 1,
			you_may_vote: true,
			you_may_vote_reason: "in_electorate",
		});
		expect(out).toContain(
			"1 approved, 2 more needed of 4 eligible; 1 denied, 1 more would refuse it",
		);
	});

	it("a denial bar the server did not send is a dash, never a zero", async () => {
		// "no denials needed" and "this server does not report the denial bar" are
		// different facts, and only the first is arithmetic.
		const out = await row({
			electorate_size: 3,
			approvals: 1,
			denials: 0,
			approvals_needed: 1,
			you_may_vote: true,
			you_may_vote_reason: "in_electorate",
		});
		expect(out).toContain(
			"1 approved, 1 more needed of 3 eligible; 0 denied, — more would refuse it",
		);
		expect(out).not.toContain("0 more would refuse it");
	});

	it("drops the denial half entirely for a server that counts no denials", async () => {
		// The same rule the approval half already follows, one field down: a server
		// that reports approvals and no denials prints exactly the clause it
		// printed before this bar existed.
		const out = await row({
			electorate_size: 3,
			approvals: 1,
			approvals_needed: 1,
			you_may_vote: true,
			you_may_vote_reason: "in_electorate",
		});
		expect(out).toContain(
			"1 approved, 1 more needed of 3 eligible  you can vote",
		);
		expect(out).not.toContain("would refuse it");
		expect(out).not.toContain("denied");
	});

	// Both new tokens carry the frozen clause, so a row states the reason
	// rather than printing the wire token at a model.
	it("tells an applicant reading its own request that it is its own", async () => {
		const out = await row({
			electorate_size: 3,
			approvals: 0,
			denials: 0,
			approvals_needed: 2,
			denials_needed: 2,
			you_may_vote: false,
			you_may_vote_reason: "is_applicant",
		});
		expect(out).toContain("this is your own request");
		expect(out).not.toContain("`is_applicant`");
	});

	it("says a request with no recorded electorate is undecidable, not empty", async () => {
		// `electorate_empty` asserts a fact about a set nobody wrote. A row filed
		// before electorates existed, whose bar is zero, gets its own token.
		const out = await row({
			electorate_size: null,
			approvals: 0,
			denials: 0,
			approvals_needed: null,
			denials_needed: null,
			you_may_vote: false,
			you_may_vote_reason: "bar_unreachable",
		});
		expect(out).toContain("nobody can decide this request");
		expect(out).not.toContain("nobody eligible is still in the group");
		expect(out).not.toContain("`bar_unreachable`");
	});

	it("a latecomer is told the vote would not count, before spending a call", async () => {
		const out = await row({
			electorate_size: 3,
			approvals: 1,
			denials: 0,
			approvals_needed: 1,
			you_may_vote: false,
			you_may_vote_reason: "not_in_electorate",
		});
		expect(out).toContain(
			"you cannot vote: you were not in the group when this was filed",
		);
	});

	it("an emptied electorate reads as undecidable, with no counts to repeat it", async () => {
		const out = await row({
			electorate_size: 0,
			approvals: 0,
			denials: 0,
			approvals_needed: null,
			you_may_vote: false,
			you_may_vote_reason: "electorate_empty",
		});
		expect(out).toContain("nobody eligible is still in the group");
		expect(out).not.toContain("eligible  ");
	});

	it("a request filed before electorates says so rather than inventing counts", async () => {
		// What the SDK's schema default produces for a server that sends none of
		// these fields — production is one, and any member may vote there.
		const out = await row({ you_may_vote_reason: "electorate_not_recorded" });
		expect(out).toContain("any member may");
		expect(out).not.toContain("more needed of");
	});

	it("counts the server did send are printed even with no electorate size", async () => {
		// A 0016-era row: the tally is real and only the electorate is missing.
		// Dropping the whole clause here threw away numbers the server sent, and
		// the Python twin printed them — so the same row read differently
		// depending on which stack the operator happened to be holding.
		const out = await row({
			quorum_total_members: 5,
			electorate_size: null,
			approvals: 2,
			denials: 0,
			approvals_needed: 1,
			you_may_vote: true,
			you_may_vote_reason: "electorate_not_recorded",
		});
		expect(out).toContain("2 approved, 1 more needed of — eligible");
	});

	it("a row that never went through the SDK parse never prints `undefined`", async () => {
		const out = await row({});
		expect(out).toContain("eligibility not reported");
		expect(out).not.toContain("undefined");
	});

	it("an agent that already voted is told which way", async () => {
		const out = await row({
			you_may_vote: false,
			you_may_vote_reason: "already_voted",
			your_vote: "approve",
		});
		expect(out).toContain("you already voted approve  expires");
	});

	it("an already-voted row that names no ballot dashes it", async () => {
		const out = await row({
			you_may_vote: false,
			you_may_vote_reason: "already_voted",
			your_vote: null,
		});
		expect(out).toContain("you already voted —  expires");
	});

	it("a decided request reads as closed to voting", async () => {
		const out = await row({
			status: "approved",
			you_may_vote: false,
			you_may_vote_reason: "not_pending",
		});
		expect(out).toContain("not open for voting");
	});

	it("a reason this package predates prints itself, never a guess", async () => {
		const out = await row({ you_may_vote_reason: "constructor" });
		expect(out).toContain("eligibility `constructor`  expires");
		expect(out).not.toContain("you can vote");
	});
});

describe("rine_group_vote refuses in words a model can act on", () => {
	/** The tool's output for one thrown refusal. */
	async function refused(err: unknown): Promise<string> {
		const { client } = fakeClient({
			groups: groups({
				vote: async () => {
					throw err;
				},
			}),
		});
		return await run(rineGroupVoteTool({ client }), {
			group: "#ops@acme",
			requestId: REQUEST_ID,
			vote: "approve",
		});
	}

	it("says no vote was recorded and where to read who can decide", async () => {
		const out = await refused(
			refusal(
				"not_in_electorate",
				"This request is decided by the members this group had when it was filed, and you were not one of them.",
			),
		);
		expect(out).toContain("No vote was recorded in `#ops@acme`");
		expect(out).toContain("you were not one of them");
		expect(out).toContain("Retrying will not help");
		// Never the bare authorization line: that reads as a fixable permission.
		expect(out).not.toContain("Not authorized");
	});

	it("says an emptied electorate leaves the request to its expiry", async () => {
		const out = await refused(
			refusal(
				"electorate_empty",
				"Nobody who was a member of this group when this request was filed is still in it.",
			),
		);
		expect(out).toContain("No vote from anyone can decide this request");
		expect(out).toContain("until it expires");
	});

	// The refusal half of the same case. `SelfRequestVoteError` carries
	// `is_applicant`, and it is reachable exactly when an applicant was seated by
	// some other route while its own request still stands — an ordinary shape. A
	// bare "Not authorized" would read as a permission an operator can grant.
	it("says an agent cannot decide the request it is the subject of", async () => {
		const out = await refused(
			refusal(
				"is_applicant",
				"This is your own join request. The members this group had when it was filed decide it, and you were not one of them. Your vote was not recorded.",
			),
		);
		expect(out).toContain("No vote was recorded in `#ops@acme`");
		expect(out).toContain("This is your own join request");
		expect(out).toContain("Retrying will not help");
		expect(out).not.toContain("Not authorized");
	});

	it("leaves every other refusal to the shared error formatter", async () => {
		// A deliberately neutral stand-in. What this asserts is PROPAGATION —
		// that a refusal this tool has no special sentence for reaches the model
		// as the shared formatter wrote it. The server's own group refusals now
		// name the acting agent and a seated sibling, so pinning one of those
		// strings here would make the fake state a product fact it does not own,
		// and would go stale the next time the server rewords it.
		const out = await refused(new AuthorizationError("stand-in refusal"));
		expect(out).toBe("Not authorized: stand-in refusal.");
	});
});

describe("rine_group_reclaim", () => {
	/** A resume result, with whatever reclamation report the case needs. */
	const admission = (reclamation?: unknown) => ({
		epoch: 12,
		commits: 2,
		added: 1,
		outcomes: [{ agentId: APPLICANT, status: "added" }],
		reclamation,
	});

	it("asks the SDK to reclaim, not merely to seat", async () => {
		let seen: unknown;
		const { client } = fakeClient({
			groups: groups({
				resumeMlsAdmission: async (_id: string, opts: unknown) => {
					seen = opts;
					return admission({
						found: 2,
						reclaimed: 2,
						commits: 2,
						epoch: 12,
					});
				},
			}),
		});
		const out = await run(rineGroupReclaimTool({ client }), {
			group: "#ops@acme",
		});
		expect(seen).toEqual({ reclaim: true });
		expect(out).toContain("Seated 1 of 1 in 2 commit(s) in `#ops@acme`");
		expect(out).toContain("Reclaimed 2 of 2 orphaned leaves");
		// The cost is the deterrent, so it is never left out of the report.
		expect(out).toContain("billed to every member");
	});

	it("says a clean tree is clean rather than saying nothing", async () => {
		const { client } = fakeClient({
			groups: groups({
				resumeMlsAdmission: async () =>
					admission({ found: 0, reclaimed: 0, commits: 0, epoch: 12 }),
			}),
		});
		const out = await run(rineGroupReclaimTool({ client }), {
			group: GROUP_ID,
		});
		expect(out).toContain(
			"Every leaf belongs to a member or to an unanswered invitation.",
		);
	});

	it("returns the decline the pass reported, not a sentence of its own", async () => {
		const detail =
			"An agent this group calls a member holds no leaf in the ratchet tree.";
		const { client } = fakeClient({
			groups: groups({
				resumeMlsAdmission: async () =>
					admission({
						found: 0,
						reclaimed: 0,
						commits: 0,
						epoch: 12,
						declined: { reason: "identity_unseated", detail },
					}),
			}),
		});
		const out = await run(rineGroupReclaimTool({ client }), {
			group: GROUP_ID,
		});
		expect(out).toContain(detail);
	});
});

describe("group create/join descriptions carry the member-org reader notice", () => {
	it.each([
		["rine_group_create", rineGroupCreateTool],
		["rine_group_join", rineGroupJoinTool],
	])("%s tells the model every member org can read the group", (_name, make) => {
		expect(make().description).toContain(
			"Every member organisation can read this group",
		);
	});
});
