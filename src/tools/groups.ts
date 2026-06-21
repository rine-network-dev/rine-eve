/**
 * The 4 group tool factories: `rine_group_create`, `rine_group_invite`,
 * `rine_group_remove`, `rine_group_inspect`. Groups are MLS-by-default.
 *
 * The TS SDK's `groups.invite`/`removeMember` take BRANDED UUIDs positionally, so
 * invite/remove/inspect PRE-RESOLVE handle→UUID here:
 *   - a group → `groups.list()` + local match (`findGroup`),
 *   - an agent → `resolveToUuid` (WebFinger) → its UUID (or pass a UUID through),
 *     so unlisted agents resolve too.
 */

import { UUID_RE, normalizeHandle, resolveToUuid } from "@rine-network/core";
import { NotFoundError, asAgentUuid, asGroupUuid } from "@rine-network/sdk";
import type { AsyncRineClient } from "@rine-network/sdk";
import { defineTool } from "eve/tools";
import { STRING_OUTPUT, jsonSchema } from "../_zod.js";
import { groupIsMls, renderGroup } from "../format.js";
import {
	groupCreateInput,
	groupInspectInput,
	groupInviteInput,
	groupRemoveInput,
} from "../schemas.js";
import { type RineToolOpts, approvalGate, makeExecute } from "../tool.js";
import type { GroupRead } from "../types.js";

/** True for a bare UUID string (no `@`, matches the rine UUID shape). */
function isUuid(s: string): boolean {
	return UUID_RE.test(s);
}

/** A handle's bare local name: `#ops@acme` / `ops` → `ops`. */
function bareLocalName(handle: string): string {
	return handle.replace(/^#/, "").split("@")[0] ?? handle;
}

/** Match a group among the caller's groups by UUID, full handle, or bare name. */
function findGroup(
	groups: readonly GroupRead[],
	target: string,
): GroupRead | undefined {
	if (isUuid(target)) return groups.find((g) => g.id === target);
	if (!target.includes("@")) {
		const want = bareLocalName(target);
		return groups.find((g) => bareLocalName(g.handle) === want);
	}
	const want = normalizeHandle(target.startsWith("#") ? target : `#${target}`);
	return groups.find((g) => normalizeHandle(g.handle) === want);
}

/** Resolve a group handle/UUID to its `GroupUuid` via the caller's group list. */
async function resolveGroupUuid(client: AsyncRineClient, target: string) {
	if (isUuid(target)) return asGroupUuid(target);
	const page = await client.groups.list();
	const match = findGroup(page.items, target);
	if (!match) {
		throw new NotFoundError(
			`No group '${target}' among the groups this agent belongs to`,
		);
	}
	return asGroupUuid(match.id);
}

/** Resolve an agent handle/UUID to its `AgentUuid` (UUIDs pass through). */
async function resolveAgentUuid(apiUrl: string, target: string) {
	if (isUuid(target)) return asAgentUuid(target);
	return asAgentUuid(await resolveToUuid(apiUrl, target));
}

/** `rine_group_create` — create an MLS-by-default coordination group. */
export function rineGroupCreateTool(opts: RineToolOpts = {}) {
	return defineTool({
		description:
			"Create a new end-to-end-encrypted coordination group. By default the group uses MLS (RFC 9420) encryption with forward secrecy. This is a real, irreversible network action. Returns the new group handle, id, E2EE mode, and enrollment policy.",
		inputSchema: jsonSchema(groupCreateInput),
		outputSchema: STRING_OUTPUT,
		needsApproval: approvalGate(opts),
		execute: makeExecute(groupCreateInput, opts,
			async (client, i) => {
				const g = await client.groups.create(i.name, {
					description: i.description,
					enrollment: i.enrollment,
					visibility: i.visibility,
					enableMls: i.enableMls,
				});
				const mode = groupIsMls(g) ? "MLS" : "sender-key";
				return `Created group ${g.handle} (id ${g.id}, ${mode} E2EE, enrollment ${g.enrollment_policy}).`;
			},
		),
	});
}

/** `rine_group_invite` — invite an agent into a group (handle→UUID pre-resolved). */
export function rineGroupInviteTool(opts: RineToolOpts = {}) {
	return defineTool({
		description:
			"Invite an agent into a group your agent administers (group and agent may be handles or UUIDs). This is a real, irreversible network action. Returns the invite status.",
		inputSchema: jsonSchema(groupInviteInput),
		outputSchema: STRING_OUTPUT,
		needsApproval: approvalGate(opts),
		execute: makeExecute(groupInviteInput, opts,
			async (client, i, apiUrl) => {
				const groupId = await resolveGroupUuid(client, i.group);
				const agentId = await resolveAgentUuid(apiUrl, i.agentToInvite);
				const result = await client.groups.invite(groupId, agentId, {
					message: i.message,
				});
				return `Invited ${i.agentToInvite} to ${i.group} (status ${result.status}).`;
			},
		),
	});
}

/** `rine_group_remove` — remove a member; group keys rotate (handle→UUID pre-resolved). */
export function rineGroupRemoveTool(opts: RineToolOpts = {}) {
	return defineTool({
		description:
			"Remove a member from a group your agent administers (group and agent may be handles or UUIDs). Group keys are rotated for forward secrecy. This is a real, irreversible network action.",
		inputSchema: jsonSchema(groupRemoveInput),
		outputSchema: STRING_OUTPUT,
		needsApproval: approvalGate(opts),
		execute: makeExecute(groupRemoveInput, opts,
			async (client, i, apiUrl) => {
				const groupId = await resolveGroupUuid(client, i.group);
				const agentId = await resolveAgentUuid(apiUrl, i.agentId);
				await client.groups.removeMember(groupId, agentId);
				return `Removed ${i.agentId} from ${i.group}; keys rotated.`;
			},
		),
	});
}

/** `rine_group_inspect` — report a group's E2EE mode + policy. */
export function rineGroupInspectTool(opts: RineToolOpts = {}) {
	return defineTool({
		description:
			"Show a group's details and encryption status (MLS vs sender-key) so you can confirm your agent can read and post to it. Accepts a group handle or UUID.",
		inputSchema: jsonSchema(groupInspectInput),
		outputSchema: STRING_OUTPUT,
		execute: makeExecute(groupInspectInput, opts,
			async (client, i) => {
				const page = await client.groups.list();
				const match = findGroup(page.items, i.group);
				if (!match) {
					throw new NotFoundError(
						`No group '${i.group}' among the groups this agent belongs to`,
					);
				}
				return renderGroup(match);
			},
		),
	});
}
