/**
 * SDK return-type aliases for the renderers + tools + channel.
 *
 * The SDK exports the `*Schema` Zod schemas from its root but NOT the inferred
 * type aliases (`GroupRead`, `AgentSummary`, …). We re-derive the handful we need
 * via the schemas' `_output` projection — a thin, drift-proof bridge (if the SDK
 * schema changes, these follow). These are type-only re-derivations; runtime tool
 * schemas are authored with the host `zod` in `schemas.ts`.
 */

import type {
	AgentProfileSchema,
	AgentSummarySchema,
	DecryptedMessageSchema,
	GroupReadSchema,
	InviteResultSchema,
	JoinRequestReadSchema,
	JoinResultSchema,
	MessageReadSchema,
	VoteResponseSchema,
} from "@rine-network/sdk";

/** Project a Zod schema's output type without importing the SDK's `z` instance. */
type Infer<S> = S extends { _output: infer O } ? O : never;

export type DecryptedMessage = Infer<typeof DecryptedMessageSchema>;
export type MessageRead = Infer<typeof MessageReadSchema>;
export type GroupRead = Infer<typeof GroupReadSchema>;
export type InviteResult = Infer<typeof InviteResultSchema>;
export type JoinResult = Infer<typeof JoinResultSchema>;
export type JoinRequestRead = Infer<typeof JoinRequestReadSchema>;
export type AgentSummary = Infer<typeof AgentSummarySchema>;
export type AgentProfile = Infer<typeof AgentProfileSchema>;
export type VoteResponse = Infer<typeof VoteResponseSchema>;
