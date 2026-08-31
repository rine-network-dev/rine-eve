/**
 * Prod inbound wiring — `npx @rine-network/eve webhook --url <publicBase>`.
 *
 * A Vercel-deployed Eve agent has a public URL, so inbound rine messages arrive
 * by webhook (no daemon, serverless-native). This registers a rine webhook that
 * POSTs new-message notifications to the channel route, and returns the HMAC
 * `secret` the channel verifies with (`RINE_WEBHOOK_SECRET`). `--delete` tears it
 * down. The client is built lazily inside the call.
 */

import {
	ACTOR_SURFACES,
	type AgentRead,
	type ResolvedActor,
	UUID_RE,
	normalizeActor,
	resolveAgent,
} from "@rine-network/core";
import { asAgentUuid, asWebhookUuid } from "@rine-network/sdk";
import { actingAgent, getRineClient } from "./client.js";

const DEFAULT_INBOUND_PATH = "/rine/v1/inbound";

/**
 * How Eve spells the acting agent in a refusal.
 *
 * `ACTOR_SURFACES.ts` with the environment rung switched back on: the SDK
 * itself reads no environment, but Eve is a *surface* and
 * `actingAgent()` climbs to `RINE_AGENT` on its behalf — the scaffolder even
 * writes the variable into every generated `.env.example`. A refusal that
 * omitted it would hide the lever this deployment is configured with.
 */
const EVE_SURFACE = { ...ACTOR_SURFACES.ts, readsEnv: true };

/** Options shared by register/delete. */
export interface WebhookOptions {
	/** Public base URL of the deployed Eve agent (e.g. `https://x.vercel.app`). */
	baseUrl: string;
	/** Acting agent name, handle or UUID; falls back to `RINE_AGENT`, then to
	 * the org's only agent. */
	agent?: string;
	apiUrl?: string;
	configDir?: string;
	/** Inbound path; defaults to `RINE_INBOUND_PATH` env or `/rine/v1/inbound`. */
	path?: string;
}

/** The persisted result of registering a webhook. */
export interface RegisteredWebhook {
	readonly id: string;
	readonly secret: string;
	readonly url: string;
}

function inboundUrl(opts: WebhookOptions): string {
	const path = opts.path ?? process.env.RINE_INBOUND_PATH ?? DEFAULT_INBOUND_PATH;
	return `${opts.baseUrl.replace(/\/$/, "")}${path}`;
}

/**
 * Register a rine webhook pointing at the deployed agent's inbound route. Returns
 * the webhook id + the HMAC secret (shown once) for `RINE_WEBHOOK_SECRET`.
 *
 * The whole acting-agent ladder runs here, because this is the one Eve
 * entry point that must name a *specific* agent — the webhook is created against
 * an agent id, not an org. So a bare name works, a single-agent org needs no
 * `--agent` at all, and the refusal names the org's agents rather than asserting
 * the caller forgot an env var they may well have set to the wrong thing.
 */
export async function registerRineWebhook(
	opts: WebhookOptions,
): Promise<RegisteredWebhook> {
	// Built WITHOUT an actor: the agent list is org-scoped, and the actor is what
	// we are about to resolve from it.
	const client = getRineClient({
		apiUrl: opts.apiUrl,
		configDir: opts.configDir,
	});
	// Three optional fields spell "not set" as `null` on the SDK's parsed row and
	// as absent on core's `AgentRead`. Convert rather than cast, so a genuinely
	// new field mismatch still fails the typecheck instead of being waved through.
	const orgAgents = async (): Promise<AgentRead[]> =>
		(await client.identity.listAgents()).map((a) => ({
			...a,
			verification_words: a.verification_words ?? undefined,
			warnings: a.warnings ?? undefined,
			poll_url: a.poll_url ?? undefined,
		}));
	// The list is fetched only when it can change the answer, as `resolveActor`
	// does: a UUID is already what the webhook route wants, so `--agent <uuid>`
	// still registers a webhook for an org whose agent list this deployment
	// cannot read. Every other spelling costs the round trip, handles included —
	// the agent a webhook is registered against must be one this org owns, and
	// the org's own list is the only thing that can say so.
	const named = actingAgent(opts);
	// On a one-agent org a value that named nobody no longer refuses —
	// that agent acts and the resolver says what it ignored. Eve's actor comes
	// from configuration (`--agent`, `RINE_AGENT`), never from a model, so the
	// audience for the note is whoever wrote that configuration and the channel
	// is the operator log this command already writes to.
	const resolved: ResolvedActor =
		named !== undefined && UUID_RE.test(named)
			? { agentId: named }
			: await resolveAgent(
					await orgAgents(),
					named,
					undefined,
					EVE_SURFACE,
					// `actingAgent()` climbed the environment rung on this call's
					// behalf, so the note has to name `RINE_AGENT` rather than an
					// `agent` option this deployment never passed.
					normalizeActor(opts.agent) === undefined ? "environment" : "argument",
				);
	if (resolved.warning !== undefined) console.warn(`rine: ${resolved.warning}`);
	const agentUuid = asAgentUuid(resolved.agentId);
	const url = inboundUrl(opts);
	const created = await client
		.withAgent(agentUuid)
		.webhooks.create(agentUuid, url);
	return { id: created.id, secret: created.secret, url };
}

/** Delete a previously-registered webhook by id (best-effort teardown). */
export async function deleteRineWebhook(
	id: string,
	opts: Pick<WebhookOptions, "agent" | "apiUrl" | "configDir"> = {},
): Promise<void> {
	const client = getRineClient({
		agent: actingAgent(opts),
		apiUrl: opts.apiUrl,
		configDir: opts.configDir,
	});
	await client.webhooks.delete(asWebhookUuid(id));
}
