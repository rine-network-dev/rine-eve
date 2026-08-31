/**
 * Shared `defineTool` plumbing every rine tool reuses (no duplicated logic):
 * env-based identity resolution and the try/catch → `formatError` wrapper
 * (errors→strings, never a reject).
 *
 * Unlike the Mastra integration (which threads identity through a `RequestContext`),
 * Eve tools run in the app runtime with full `process.env` access, so identity is
 * resolved straight from the environment via `getRineClient` — no per-call context
 * plumbing, no credentials in the model-visible input schema.
 *
 * A tool's per-tool body is just `(client, input, apiUrl) => string`; this helper
 * supplies the surrounding contract. The concrete `defineTool({...})` (with the
 * model-facing description + schemas) lives in each domain module; this file only
 * builds the `execute` closure and the shared option/body types.
 */

import { resolveApiUrl } from "@rine-network/core";
import type {
	AgentHandle,
	AgentUuid,
	AsyncRineClient,
	GroupHandle,
	GroupUuid,
} from "@rine-network/sdk";
import type { NeedsApprovalContext, ToolModelOutput } from "eve/tools";
import { always, never, once } from "eve/tools/approval";
import type { ZodTypeAny, z } from "zod";
import { type RineClientOpts, actingAgent, getRineClient } from "./client.js";
import { formatError } from "./errors.js";

/**
 * Per-factory overrides. All optional: when omitted, identity is resolved from
 * the environment (`RINE_CONFIG_DIR`, `RINE_API_URL`, `RINE_AGENT`). Pass `agent`
 * to pin a specific acting agent at scaffold time in a multi-agent org.
 */
export interface RineToolOpts extends RineClientOpts {
	/** A pre-built client to use instead of env resolution (tests / advanced use). */
	client?: AsyncRineClient;
	/**
	 * Human-in-the-loop approval gate for the MUTATING tools (send / reply /
	 * group_*). Off by default — autonomous agent-to-agent messaging is the point —
	 * but a deployment can require `"once"` (per session) or `"always"` approval on
	 * irreversible network actions. Ignored by read-only tools.
	 */
	needsApproval?: "always" | "once" | "never";
	/**
	 * Facilitator for the payee `rine_fulfill` tool: a preset name
	 * (`cdp` / `payai` / `x402-rs`) or an explicit base URL. Falls back to the
	 * `RINE_FACILITATOR` env var. Ignored by every other tool. Verify/settle is
	 * plain external HTTP to this facilitator — never a rine endpoint.
	 */
	facilitator?: string;
	/** Extra HTTP headers (provider auth, e.g. a CDP key) sent to the facilitator. */
	facilitatorHeaders?: Record<string, string>;
}

/**
 * Resolve {@link RineToolOpts.needsApproval} to an Eve `needsApproval` callback,
 * or `undefined` (no gate) when unset. Only the mutating tool factories apply it.
 */
export function approvalGate(
	opts: RineToolOpts,
): ((ctx: NeedsApprovalContext) => boolean) | undefined {
	switch (opts.needsApproval) {
		case "always":
			return always();
		case "once":
			return once();
		case "never":
			return never();
		default:
			return undefined;
	}
}

/** Resolve the effective `AsyncRineClient` for one `execute` call (lazy). */
export function resolveClient(opts: RineToolOpts): AsyncRineClient {
	if (opts.client) {
		const agent = actingAgent(opts);
		return agent ? opts.client.withAgent(agent) : opts.client;
	}
	return getRineClient({
		configDir: opts.configDir,
		apiUrl: opts.apiUrl,
		agent: actingAgent(opts),
	});
}

/**
 * The same resolved `apiUrl` the client is built against (factory override →
 * `RINE_API_URL` env → `resolveApiUrl()`). Exposed so handle→UUID pre-resolution
 * hits the SAME server WebFinger the client uses.
 */
export function resolveApiUrlFor(opts: RineToolOpts): string {
	return opts.apiUrl ?? resolveApiUrl();
}

/**
 * The recipient union `client.send`/`sendAndWait` accept. The model supplies a
 * free-form `to` string (a `name@org` handle, a `#logistics@acme.rine.network` handle, or a UUID);
 * the SDK normalizes + validates it at runtime, so this brands the string once.
 */
type Recipient = AgentHandle | AgentUuid | GroupHandle | GroupUuid;

/** Brand a model-supplied recipient string for the SDK send surface. */
export function asRecipient(to: string): Recipient {
	return to as Recipient;
}

/**
 * Belt-and-suspenders ciphertext redactor for `read` / `inbox` / `thread`.
 * The renderers + `outputSchema: z.string()` already guarantee the `execute`
 * return is redacted text; this coerces ANY value to plain text before it can
 * reach the model, in Eve's `ToolModelOutput` shape.
 */
export function redactToText(output: unknown): ToolModelOutput {
	return { type: "text", value: typeof output === "string" ? output : "" };
}

/**
 * A tool body: one client call rendered to a string. The wrapper handles errors.
 * `apiUrl` is the server the client is bound to (for handle→UUID pre-resolution);
 * bodies that don't resolve handles ignore it.
 */
export type RineToolBody<I> = (
	client: AsyncRineClient,
	input: I,
	apiUrl: string,
) => Promise<string>;

/**
 * Build an Eve-tool `execute(input, ctx)` from a zod schema + body, applying:
 *   1. zod `.parse(raw)` of the model input (defaults + coercion + validation),
 *   2. the lazy env-resolved client,
 *   3. the try/catch→formatError contract (resolves a string, never rejects).
 *
 * Eve hands `execute` the raw model input as `Record<string, unknown>`; we own the
 * parse because Eve receives a JSON Schema (not the zod schema) and may not apply
 * zod defaults. The Eve `ToolContext` is intentionally ignored — rine identity is
 * environment-resolved, not session-scoped.
 */
export function makeExecute<S extends ZodTypeAny>(
	schema: S,
	opts: RineToolOpts,
	body: RineToolBody<z.infer<S>>,
) {
	return async (raw: unknown): Promise<string> => {
		try {
			const input = schema.parse(raw) as z.infer<S>;
			const client = resolveClient(opts);
			return await body(client, input, resolveApiUrlFor(opts));
		} catch (err) {
			return formatError(err);
		}
	};
}
