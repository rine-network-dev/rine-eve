/**
 * Handle → UUID resolution for the group tools.
 *
 * What is left here is the AGENT half. The group half moved out entirely: the
 * SDK's `groups.resolveRef` is now the one ladder for a group reference, and
 * it answers with the group's whole record — id, handle, the caller's own
 * spelling, and the row the resolve already read — so a verb that reads the
 * group before it writes spends no `GET /groups/{id}` of its own. This package
 * used to search `groups.list()` and match locally, which is a second copy of a
 * ladder the SDK, the CLI and the MCP server all reach through one function; a
 * refusal that differed per surface is what that copy was.
 *
 * Agents still resolve here, and differently on purpose: `resolveToUuid` is a
 * WebFinger lookup, so an agent that this org has never messaged resolves too.
 *
 * `join` is the exception and does NOT resolve through `resolveRef`: it is the
 * one group verb whose target is by definition a group this org is not in, so
 * the org's seats are the one set it cannot be found in. It delegates to the
 * SDK's join ladder (`resolveRefForJoin`), which walks the org's seats, this
 * agent's invitations and the public directory. A bare UUID always passes
 * through unchanged.
 *
 * Split out of `tools/groups.ts` so that file holds its six tool factories and
 * nothing else; `tools/registry.ts` — which is what the shipped-surface gate
 * reads for tool names — is untouched by the move.
 */

import { UUID_RE, handleCompletionNotes, resolveToUuid } from "@rine-network/core";
import { asAgentUuid } from "@rine-network/sdk";
import type { AsyncRineClient } from "@rine-network/sdk";

/** True for a bare UUID string (no `@`, matches the rine UUID shape). */
function isUuid(s: string): boolean {
	return UUID_RE.test(s);
}

/**
 * A tool's answer, led by the item-18 completion notice when there is one.
 *
 * 🔴 `resolveToUuid` completes a short handle before it reaches WebFinger —
 * `kofi@acme` is looked up as `kofi@acme.rine.network` — and answers with the
 * resolved UUID, never the handle it resolved. The model named one agent and
 * the call may have invited, removed or seated another, with nothing in the
 * answer saying so.
 *
 * 🔴 A LINE, not a key, and that is this surface's shape rather than a choice:
 * every tool here declares `STRING_OUTPUT`, so there is no object to hang a
 * field on. `@rine-network/mcp` returns objects and rides the same sentence as
 * a `handle_completion` key; the CLI writes it to stderr. The BYTES are
 * {@link handleCompletionNotes}' in `@rine-network/core` and are retyped by
 * none of the three.
 *
 * It leads rather than trails because a model reads the head of a tool result
 * and acts on it — a caveat about which agent was actually touched is worth
 * nothing underneath the report of touching them.
 */
export function withHandleCompletionLine(
	answer: string,
	spellings: readonly string[],
): string {
	const note = handleCompletionNotes(spellings);
	return note === undefined ? answer : `${note}\n${answer}`;
}

/** Resolve an agent handle/UUID to its `AgentUuid` (UUIDs pass through). */
export async function resolveAgentUuid(apiUrl: string, target: string) {
	if (isUuid(target)) return asAgentUuid(target);
	return asAgentUuid(await resolveToUuid(apiUrl, target));
}

/**
 * Resolve a batch of agent handles/UUIDs, **in the order they were named**.
 *
 * Order is load-bearing: the server answers one admission entry per requested
 * id in request order, so a report read against a re-ordered list names the
 * wrong agents. Duplicates are dropped case-insensitively rather than sent
 * twice, because the second copy of an id comes back `already_invited` and
 * reads as a failure the caller did not cause.
 */
export async function resolveAgentUuids(apiUrl: string, targets: string[]) {
	const resolved = [];
	const seen = new Set<string>();
	for (const target of targets) {
		const id = await resolveAgentUuid(apiUrl, target);
		const key = id.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		resolved.push(id);
	}
	return resolved;
}

/**
 * Resolve a group handle/UUID to its `GroupUuid` for `rine_group_join`.
 *
 * 🔴 The SDK's own join ladder, not a copy of one. This package used to search
 * `groups.listInvites()` alone, which answered for a group that had invited
 * this agent and for nothing else — so the commonest join there is, a handle
 * read straight off `rine_discover_groups`, was refused here with the server
 * never having been asked. `resolveRefForJoin` walks the org's seats, then this
 * agent's invitations, then the public directory, matching the handle exactly at
 * every rung. What this package could always do it still does: a BARE name
 * resolves against this agent's own pending invitations — and against nothing
 * else, because that list is the only set bounded to groups that have already
 * asked for this agent, and a join cannot be taken back.
 *
 * The refusals it throws lead with `Group not found`, which is the phrase
 * `formatError` (`../errors.ts`) keys on to append this surface's own discover
 * verbs — the old `No pending invite` wording matched none of its three
 * spellings, so a refused join carried no remedy at all.
 */
export async function resolveJoinGroupUuid(
	client: AsyncRineClient,
	target: string,
) {
	return await client.groups.resolveRefForJoin(target);
}
