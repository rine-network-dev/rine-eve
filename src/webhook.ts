/**
 * Prod inbound wiring — `npx @rine-network/eve webhook --url <publicBase>`.
 *
 * A Vercel-deployed Eve agent has a public URL, so inbound rine messages arrive
 * by webhook (no daemon, serverless-native). This registers a rine webhook that
 * POSTs new-message notifications to the channel route, and returns the HMAC
 * `secret` the channel verifies with (`RINE_WEBHOOK_SECRET`). `--delete` tears it
 * down. The client is built lazily inside the call.
 */

import { resolveApiUrl, resolveToUuid, UUID_RE } from "@rine-network/core";
import { asAgentUuid, asWebhookUuid } from "@rine-network/sdk";
import { getRineClient } from "./client.js";

const DEFAULT_INBOUND_PATH = "/rine/v1/inbound";

/** Options shared by register/delete. */
export interface WebhookOptions {
	/** Public base URL of the deployed Eve agent (e.g. `https://x.vercel.app`). */
	baseUrl: string;
	/** Acting agent handle/UUID; defaults to `process.env.RINE_AGENT`. */
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

async function resolveAgentUuid(apiUrl: string, agent: string) {
	if (UUID_RE.test(agent)) return asAgentUuid(agent);
	return asAgentUuid(await resolveToUuid(apiUrl, agent));
}

/**
 * Register a rine webhook pointing at the deployed agent's inbound route. Returns
 * the webhook id + the HMAC secret (shown once) for `RINE_WEBHOOK_SECRET`.
 */
export async function registerRineWebhook(
	opts: WebhookOptions,
): Promise<RegisteredWebhook> {
	const agent = opts.agent ?? process.env.RINE_AGENT;
	if (!agent) {
		throw new Error(
			"no acting agent — set RINE_AGENT or pass --agent <handle>",
		);
	}
	const apiUrl = opts.apiUrl ?? resolveApiUrl();
	const client = getRineClient({
		agent,
		apiUrl: opts.apiUrl,
		configDir: opts.configDir,
	});
	const agentUuid = await resolveAgentUuid(apiUrl, agent);
	const url = inboundUrl(opts);
	const created = await client.webhooks.create(agentUuid, url);
	return { id: created.id, secret: created.secret, url };
}

/** Delete a previously-registered webhook by id (best-effort teardown). */
export async function deleteRineWebhook(
	id: string,
	opts: Pick<WebhookOptions, "agent" | "apiUrl" | "configDir"> = {},
): Promise<void> {
	const client = getRineClient({
		agent: opts.agent ?? process.env.RINE_AGENT,
		apiUrl: opts.apiUrl,
		configDir: opts.configDir,
	});
	await client.webhooks.delete(asWebhookUuid(id));
}
