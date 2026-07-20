/**
 * The 12 rine tool factories, re-exported for `@rine-network/eve/tools`.
 *
 * Eve discovers tools by file: each lives as a default-export in
 * `agent/tools/<name>.ts`, and the filename slug IS the tool name. The `init`
 * scaffolder writes those thin re-export files from the pure {@link RINE_TOOL_META}
 * registry (which carries no `eve` import); this module attaches the live
 * factories to that metadata as {@link RINE_TOOLS} for programmatic use.
 */

import type { RineToolOpts } from "../tool.js";
import { rineDiscoverTool, rineInspectTool } from "./discovery.js";
import {
	rineGroupCreateTool,
	rineGroupInspectTool,
	rineGroupInviteTool,
	rineGroupRemoveTool,
} from "./groups.js";
import {
	rineCheckInboxTool,
	rineReadTool,
	rineReplyTool,
	rineSendAndWaitTool,
	rineSendTool,
	rineThreadTool,
} from "./messaging.js";
import { rineFulfillTool, rinePayTool } from "./payments.js";
import { RINE_TOOL_META, type RineToolMeta } from "./registry.js";

export {
	rineCheckInboxTool,
	rineReadTool,
	rineReplyTool,
	rineSendAndWaitTool,
	rineSendTool,
	rineThreadTool,
} from "./messaging.js";
export { rineDiscoverTool, rineInspectTool } from "./discovery.js";
export {
	rineGroupCreateTool,
	rineGroupInspectTool,
	rineGroupInviteTool,
	rineGroupRemoveTool,
} from "./groups.js";
export { rineFulfillTool, rinePayTool } from "./payments.js";
export {
	RINE_TOOL_META,
	type RineToolMeta,
	type RineToolDomain,
} from "./registry.js";
export type { RineToolOpts } from "../tool.js";

/** A rine tool factory: builds an Eve `defineTool` descriptor from options. */
export type RineToolFactory = (opts?: RineToolOpts) => unknown;

/** One scaffoldable tool: its metadata plus the live factory. */
export interface RineToolSpec extends RineToolMeta {
	readonly factory: RineToolFactory;
}

const FACTORIES: Record<string, RineToolFactory> = {
	rineSendTool,
	rineSendAndWaitTool,
	rineCheckInboxTool,
	rineReadTool,
	rineReplyTool,
	rineThreadTool,
	rineDiscoverTool,
	rineInspectTool,
	rineGroupCreateTool,
	rineGroupInviteTool,
	rineGroupRemoveTool,
	rineGroupInspectTool,
	rinePayTool,
	rineFulfillTool,
};

/** The metadata registry with live factories attached (programmatic use). */
export const RINE_TOOLS: readonly RineToolSpec[] = RINE_TOOL_META.map((m) => ({
	...m,
	// biome-ignore lint/style/noNonNullAssertion: every meta entry has a factory.
	factory: FACTORIES[m.factoryName]!,
}));
