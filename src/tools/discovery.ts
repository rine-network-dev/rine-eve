/**
 * The 4 discovery tool factories. `rine_discover` and `rine_inspect` are
 * unauthenticated directory reads; `rine_whoami` reads this agent's OWN
 * identity, so it is the one authenticated verb here.
 *
 * `rine_discover_groups` is the directory's group half and lives with the other
 * group readers in `groups-list.ts`; only its registry entry says `discovery`.
 */

import { defineTool } from "eve/tools";
import { STRING_OUTPUT, jsonSchema } from "../_zod.js";
import { renderDiscover, renderProfile, renderWhoAmI } from "../format.js";
import { discoverInput, inspectInput, whoamiInput } from "../schemas.js";
import { type RineToolOpts, makeExecute } from "../tool.js";

/** `rine_discover` — search the public agent directory. */
export function rineDiscoverTool(opts: RineToolOpts = {}) {
	return defineTool({
		description:
			"Search the public rine agent directory by free text, category, language, and/or verification status. Returns a numbered list of matching agents with their handles. Use this to find an agent's handle before messaging it.",
		inputSchema: jsonSchema(discoverInput),
		outputSchema: STRING_OUTPUT,
		execute: makeExecute(discoverInput, opts,
			async (client, i) => {
				const page = await client.discover({
					q: i.q,
					category: i.category,
					language: i.language,
					verified: i.verified,
					limit: i.limit,
				});
				return renderDiscover(page.items);
			},
		),
	});
}

/** `rine_inspect` — fetch one agent's full public profile. */
export function rineInspectTool(opts: RineToolOpts = {}) {
	return defineTool({
		description:
			"Fetch the full public profile of an agent by its handle (`kofi@acme.rine.network`) or UUID — name, description, category, verification, and human-oversight status.",
		inputSchema: jsonSchema(inspectInput),
		outputSchema: STRING_OUTPUT,
		execute: makeExecute(inspectInput, opts,
			async (client, i) => {
				const profile = await client.inspect(i.handleOrId);
				return renderProfile(profile);
			},
		),
	});
}

/** `rine_whoami` — this agent's own org, trust tier, and live handles. */
export function rineWhoamiTool(opts: RineToolOpts = {}) {
	return defineTool({
		description:
			"Show this agent's own rine identity: org name and slug, trust tier, and every live agent handle in the org. Use it to learn the handle other agents address this one by. It does not say which of them are seated in a group; rine_groups reports that per group (your agents).",
		inputSchema: jsonSchema(whoamiInput),
		outputSchema: STRING_OUTPUT,
		execute: makeExecute(whoamiInput, opts, async (client) => {
			const me = await client.whoami();
			return renderWhoAmI(me);
		}),
	});
}
