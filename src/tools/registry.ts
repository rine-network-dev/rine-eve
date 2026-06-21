/**
 * Pure tool metadata (name / export name / domain) — NO `eve` import, NO factory
 * references. The scaffolder and CLI depend only on this, so `init` runs without
 * resolving the `eve` peer dependency (the eve-importing factories load only when
 * the Eve runtime imports the scaffolded `agent/tools/*.ts` files). `tools/index.ts`
 * attaches the live factories to this metadata for programmatic use.
 */

/** The canonical domains a rine tool belongs to (drives `init --tools`). */
export type RineToolDomain = "messaging" | "discovery" | "groups";

/** Scaffold metadata for one tool: canonical name, export name, domain. */
export interface RineToolMeta {
	/** Filename slug + runtime tool name (e.g. `rine_send`). */
	readonly name: string;
	/** Named export in `@rine-network/eve/tools` that builds the descriptor. */
	readonly factoryName: string;
	readonly domain: RineToolDomain;
}

/**
 * The registry the scaffolder + docs read. Order is the canonical surface order
 * (messaging → discovery → groups). `name` === scaffolded filename === tool name.
 */
export const RINE_TOOL_META: readonly RineToolMeta[] = [
	{ name: "rine_send", factoryName: "rineSendTool", domain: "messaging" },
	{ name: "rine_send_and_wait", factoryName: "rineSendAndWaitTool", domain: "messaging" },
	{ name: "rine_check_inbox", factoryName: "rineCheckInboxTool", domain: "messaging" },
	{ name: "rine_read", factoryName: "rineReadTool", domain: "messaging" },
	{ name: "rine_reply", factoryName: "rineReplyTool", domain: "messaging" },
	{ name: "rine_thread", factoryName: "rineThreadTool", domain: "messaging" },
	{ name: "rine_discover", factoryName: "rineDiscoverTool", domain: "discovery" },
	{ name: "rine_inspect", factoryName: "rineInspectTool", domain: "discovery" },
	{ name: "rine_group_create", factoryName: "rineGroupCreateTool", domain: "groups" },
	{ name: "rine_group_invite", factoryName: "rineGroupInviteTool", domain: "groups" },
	{ name: "rine_group_remove", factoryName: "rineGroupRemoveTool", domain: "groups" },
	{ name: "rine_group_inspect", factoryName: "rineGroupInspectTool", domain: "groups" },
];
