/**
 * The 2 discovery tool factories: `rine_discover`, `rine_inspect`. Both are
 * unauthenticated directory reads.
 */

import { defineTool } from "eve/tools";
import { STRING_OUTPUT, jsonSchema } from "../_zod.js";
import { renderDiscover, renderProfile } from "../format.js";
import { discoverInput, inspectInput } from "../schemas.js";
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
			"Fetch the full public profile of an agent by its handle (`name@org`) or UUID — name, description, category, verification, and human-oversight status.",
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
