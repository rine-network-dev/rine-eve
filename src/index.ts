/**
 * @rine-network/eve — native Vercel Eve connector for the rine network.
 *
 * Makes an Eve agent a first-class, E2E-encrypted (HPKE 1:1, MLS groups RFC 9420,
 * PQ-hybrid) citizen of the rine agent network: a custom **channel** for inbound
 * reachability + outbound replies, file-discovered rine **tools** for agency, a
 * **skill**, and an out-of-band **onboard / init / webhook / relay** CLI.
 *
 * Import is side-effect-free (R1): nothing here builds a client, reads a
 * credential, or opens a socket at module load.
 *
 * Most consumers don't import from here — they run `npx @rine-network/eve init`,
 * and the scaffolded `agent/` files import from `@rine-network/eve/channel` and
 * `@rine-network/eve/tools`. This barrel is for programmatic/advanced use.
 */

// Channel (inbound reachability + outbound replies)
export {
	rineChannel,
	processInbound,
	processCompletion,
	processFailure,
	senderContextLine,
} from "./channel.js";
export type {
	RineChannelOptions,
	ChannelSend,
	InboundDeps,
	CompletionDeps,
} from "./channel.js";

// The 12 tool factories + the scaffold registry
export * from "./tools/index.js";

// Skill (markdown + defineSkill form)
export {
	rineSkill,
	RINE_SKILL_BODY,
	RINE_SKILL_FILE,
	RINE_SKILL_DESCRIPTION,
} from "./skill.js";

// Foundation — lazy client + error formatter
export { getRineClient } from "./client.js";
export type { RineClientOpts } from "./client.js";
export { formatError } from "./errors.js";

// Continuation-token codec + webhook-signature helpers (advanced/testing)
export {
	encodeReplyToken,
	decodeReplyToken,
	messageIdFromWebhook,
} from "./inbound.js";
export type { ReplyContext } from "./inbound.js";
export { verifyRineSignature, signRineBody } from "./hmac.js";

// Out-of-band setup helpers (CLI-facing; NEVER tools)
export {
	runOnboard,
	parseOnboardArgs,
	agentNameFromOrgName,
} from "./onboard.js";
export type { OnboardArgs, OnboardIO, OnboardOptions } from "./onboard.js";

// Prod webhook wiring + dev relay
export { registerRineWebhook, deleteRineWebhook } from "./webhook.js";
export type { RegisteredWebhook, WebhookOptions } from "./webhook.js";
export { runRelay, drainOnce, buildRelayBody } from "./relay.js";
export type { RelayOptions, FetchLike, DrainDeps } from "./relay.js";

// Scaffolder (the `init` command's engine)
export {
	scaffoldRine,
	channelFileContent,
	toolFileContent,
	envExampleBlock,
	resolveToolSelection,
} from "./scaffold.js";
export type { ScaffoldOptions, ScaffoldResult } from "./scaffold.js";

// SDK-derived return types
export type {
	AgentProfile,
	AgentSummary,
	DecryptedMessage,
	GroupRead,
	InviteResult,
	MessageRead,
} from "./types.js";
