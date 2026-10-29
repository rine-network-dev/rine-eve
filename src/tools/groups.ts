/**
 * 6 of the group domain's 13 tool factories: `rine_group_create`,
 * `rine_group_invite`, `rine_group_remove`, `rine_group_inspect`,
 * `rine_group_join`, `rine_group_invites`. The four admission and exit verbs —
 * `rine_group_requests`, `rine_group_vote`, `rine_group_leave`,
 * `rine_group_sync` — live in `groups-admin.ts`, so both files hold the
 * ~200-LOC budget. Groups are MLS-by-default.
 *
 * `visibility` has no default here or anywhere else — see `schemas-groups.ts`.
 *
 * Admission is plural on both write verbs. `members` on create and
 * `agentsToInvite` on invite each take a batch and report one outcome per
 * agent, because a batch drops what it cannot admit rather than refusing
 * everyone, and on an MLS group it mints every new leaf in one commit instead
 * of one commit each.
 *
 * Handle→UUID resolution lives in `groups-resolve.ts` and the admission
 * rendering in `groups-admission.ts`, so this file is those six factories.
 */

import {
	GROUPS_KEY_SCOPE,
	GROUP_READERS_NOTICE,
	createdGroupMls,
} from "@rine-network/core";
import { SchemaValidationError } from "@rine-network/sdk";
import { defineTool } from "eve/tools";
import { STRING_OUTPUT, jsonSchema } from "../_zod.js";
import { renderGroup, renderInvites, renderJoinResult } from "../format.js";
import {
	groupCreateInput,
	groupInspectInput,
	groupInviteInput,
	groupInvitesInput,
	groupJoinInput,
	groupRemoveInput,
} from "../schemas.js";
import { type RineToolOpts, approvalGate, makeExecute } from "../tool.js";
import {
	INVITE_TARGET_REQUIRED,
	renderAdmission,
	renderMlsAdmission,
	renderSingularInvite,
} from "./groups-admission.js";
import {
	resolveAgentUuid,
	resolveAgentUuids,
	withHandleCompletionLine,
	resolveJoinGroupUuid,
} from "./groups-resolve.js";

/** `rine_group_create` — create an MLS-by-default coordination group. */
export function rineGroupCreateTool(opts: RineToolOpts = {}) {
	return defineTool({
		description:
			"Create a new end-to-end-encrypted coordination group. By default the group uses post-quantum MLS (RFC 9420), which gives forward secrecy and post-compromise security across epochs; open-enrollment groups use sender keys, whose bodies are classical AES-256-GCM. `visibility` is required and has no default: `public` lists the group at dir.rine.network and turns the member-joined signal off, `private` does neither. Name `members` to invite agents as the group is created — that is what lets an MLS group mint every leaf in a handful of commits instead of one commit per member. A founding roster mints real invitations under every enrollment policy, `majority` and `unanimity` included, because at founding the creator is the only member and therefore the whole electorate; a later invite into one of those two policies nominates instead. This is a real, irreversible network action. Returns the new group handle, id, E2EE mode, enrollment policy, and one outcome per rostered agent. " + GROUP_READERS_NOTICE,
		inputSchema: jsonSchema(groupCreateInput),
		outputSchema: STRING_OUTPUT,
		needsApproval: approvalGate(opts),
		execute: makeExecute(groupCreateInput, opts, async (client, i, apiUrl) => {
			const members = i.members?.length
				? await resolveAgentUuids(apiUrl, i.members)
				: undefined;
			const g = await client.groups.create(i.name, {
				description: i.description,
				enrollment: i.enrollment,
				visibility: i.visibility,
				enableMls: i.enableMls,
				voteDurationHours: i.voteDurationHours,
				...(members && { members }),
			});
			// Which of the four answers this group gets is `createdGroupMls`'s to
			// decide, and it is `@rine-network/core`'s — this surface and
			// `rine-mastra` render one answer from one definition. It reads the
			// create RESULT, because the row alone cannot tell a founded group from
			// an unfounded one on either of the two best-effort paths that hand this
			// head the pre-init row. No repair word is passed: this surface has no
			// verb that founds a group, which is the default.
			const { mode, note } = createdGroupMls(g);
			const head = `Created group ${g.handle} (id ${g.id}, ${mode} E2EE, enrollment ${g.enrollment_policy}).${note ? ` ${note}` : ""}`;
			// A founding roster is where a silent handle completion seats the
			// wrong agent, and where it hides best — one name among twenty.
			const typed = i.members ?? [];
			if (!g.roster) return withHandleCompletionLine(head, typed);
			// The roster says an invitation was minted; the founding's MLS admission
			// says whether a ratchet-tree leaf was, and only it can report a roster
			// of 40 that seated 37. `rine_group_invite` already answers both
			// questions — a create must not answer one.
			const lines = [
				`${head}\nRoster invited (nobody is a member until they join; an invitation holds a seat until it is accepted or expires):\n${renderAdmission(g.roster)}`,
			];
			if (g.mlsAdmission) lines.push(renderMlsAdmission(g.mlsAdmission));
			return withHandleCompletionLine(lines.join("\n"), typed);
		}),
	});
}

/** `rine_group_invite` — invite one agent or a batch (handle→UUID pre-resolved). */
export function rineGroupInviteTool(opts: RineToolOpts = {}) {
	return defineTool({
		description:
			"Invite one agent (`agentToInvite`) or several at once (`agentsToInvite`) into a group your agent belongs to; groups and agents may be handles or UUIDs. A batch reports one outcome per agent and drops what it cannot admit rather than refusing everyone. What an invite does depends on the group's enrollment policy. On a `closed` group it mints an invitation the agent accepts with rine_group_join, and on an MLS group its ratchet-tree leaf and Welcome are minted in the same call. On a `majority` or `unanimity` group it NOMINATES: it files a join request the group's electorate decides, counts this agent's own approval toward it, and mints no leaf — the vote seats the member, and seating is what grants the key. On an `open` group nobody needs an invitation and the call only tells the agent the group exists. This is a real, irreversible network action.",
		inputSchema: jsonSchema(groupInviteInput),
		outputSchema: STRING_OUTPUT,
		needsApproval: approvalGate(opts),
		execute: makeExecute(groupInviteInput, opts, async (client, i, apiUrl) => {
			const batch = i.agentsToInvite ?? [];
			if ((i.agentToInvite === undefined) === (batch.length === 0)) {
				throw new SchemaValidationError(INVITE_TARGET_REQUIRED);
			}
			// The record, not its id. `invite` takes a `GroupSelector` and deliberately
			// does not fold the resolve's row: its group read happens after its own POST
			// — the nomination it may have filed — so it has to be a fresh one.
			const group = await client.groups.resolveRef(i.group);
			if (i.agentToInvite !== undefined) {
				const agentId = await resolveAgentUuid(apiUrl, i.agentToInvite);
				const result = await client.groups.invite(group, agentId, {
					message: i.message,
				});
				// The completion line is owed here above all: `renderSingularInvite`
				// echoes `i.agentToInvite`, the caller's own spelling, so the answer
				// agrees with what was typed while the invitation went to the
				// completed handle.
				return withHandleCompletionLine(
					renderSingularInvite(i.agentToInvite, i.group, result.status),
					[i.agentToInvite],
				);
			}
			const agentIds = await resolveAgentUuids(apiUrl, batch);
			const report = await client.groups.invite(group, agentIds, {
				message: i.message,
			});
			const lines = [`Invited into ${i.group}:`, renderAdmission(report)];
			if (report.mls) lines.push(renderMlsAdmission(report.mls));
			return withHandleCompletionLine(lines.join("\n"), batch);
		}),
	});
}

/** `rine_group_remove` — evict a member, or leave (handle→UUID pre-resolved). */
export function rineGroupRemoveTool(opts: RineToolOpts = {}) {
	return defineTool({
		description:
			"Remove a member from a group your agent administers, or leave a group by naming your own agent. On an MLS group this posts a real Remove commit that takes the member's ratchet-tree leaf with it, so it is slower than a roster edit and it can fail; an open group has no cryptographic eviction — the server stops delivering to them, and what bounds their reach into later traffic is each remaining member rotating on the next send. A kick takes nothing back: messages already delivered still open for everyone, the removed member included. A leave is different — it retires this host's key material for the group, so the group's messages stop opening here, including ones that arrived before the leave and were never read. This is a real, irreversible network action.",
		inputSchema: jsonSchema(groupRemoveInput),
		outputSchema: STRING_OUTPUT,
		needsApproval: approvalGate(opts),
		execute: makeExecute(groupRemoveInput, opts, async (client, i, apiUrl) => {
			const group = await client.groups.resolveRef(i.group);
			const agentId = await resolveAgentUuid(apiUrl, i.agentId);
			const result = await client.groups.removeMember(group, agentId);
			// The SDK composes the one accurate sentence for this removal and this
			// group type. Composing another one here is how the surfaces produced a
			// sentence that was false for open groups. The item-18
			// notice is not that sentence — it is a caveat about WHICH agent the
			// accurate sentence is about, and a removal takes nothing back.
			return withHandleCompletionLine(result.message, [i.agentId]);
		}),
	});
}

/** `rine_group_inspect` — report a group's E2EE mode + policy. */
export function rineGroupInspectTool(opts: RineToolOpts = {}) {
	return defineTool({
		description:
			`Show a group's details and encryption status (MLS vs sender-key) so you can tell how a group is run before posting to it. Accepts a group handle or UUID; it covers the groups your key can see. ${GROUPS_KEY_SCOPE} Its 'your agents' line names by handle which of them hold a seat in this one.`,
		inputSchema: jsonSchema(groupInspectInput),
		outputSchema: STRING_OUTPUT,
		execute: makeExecute(groupInspectInput, opts, async (client, i) => {
			// The resolve answers with the group's ROW, which is the whole of what this
			// tool renders — so it reads the group once. Handing `renderGroup` a
			// `groups.get(id)` off the resolved id instead would turn one read into
			// two, and searching `groups.list()` for it — what this did — made every
			// inspect pay the unpaginated list even when the caller named a UUID.
			const [group, handles] = await Promise.all([
				client.groups.resolveRef(i.group),
				client.agentHandles(),
			]);
			return renderGroup(group.row, handles);
		}),
	});
}

/** `rine_group_join` — accept an invite (or self-join an open group). */
export function rineGroupJoinTool(opts: RineToolOpts = {}) {
	return defineTool({
		description:
			"Join a group by its handle or its UUID — or, when the group has already invited this agent, by its bare name: accept a pending invite, or self-join a publicly discovered open-enrollment group. Instant for open enrollment, and instant against an invitation this agent already holds. On a `majority` or `unanimity` group with no invitation it submits a request the group's electorate votes on. Calling it against a nomination another member filed for this agent is how consent is given: the request is not seated until this agent has asked for it, so a nomination that carries before that becomes an invitation to accept rather than a seat. This is a real, irreversible network action. " + GROUP_READERS_NOTICE,
		inputSchema: jsonSchema(groupJoinInput),
		outputSchema: STRING_OUTPUT,
		needsApproval: approvalGate(opts),
		execute: makeExecute(groupJoinInput, opts, async (client, i) => {
			const groupId = await resolveJoinGroupUuid(client, i.group);
			const result = await client.groups.join(groupId, { message: i.message });
			return renderJoinResult(i.group, result);
		}),
	});
}

/** `rine_group_invites` — list the caller's pending group invites. */
export function rineGroupInvitesTool(opts: RineToolOpts = {}) {
	return defineTool({
		description:
			"List the live admissions addressed to your agent — group, who invited or nominated you, status, and any message. It reports both kinds and they are told apart by `status`: `invited` is an invitation you accept, `pending` is a nomination a member filed for you that the group's electorate is deciding. This is the only place a non-member reads its own nomination, and calling rine_group_join on one is how consent to it is given. Join or consent with rine_group_join using the group handle or id.",
		inputSchema: jsonSchema(groupInvitesInput),
		outputSchema: STRING_OUTPUT,
		execute: makeExecute(groupInvitesInput, opts, async (client) => {
			const invites = await client.groups.listInvites();
			return renderInvites(invites);
		}),
	});
}
