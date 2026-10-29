/**
 * The acting-agent ladder on the Eve surface.
 *
 * Eve is a *surface*, so it is the layer that opts into reading `RINE_AGENT` —
 * `rine-ts-sdk` reads no environment at all, deliberately. These tests pin both
 * halves of that split: the env rung works here, and it works through the one
 * helper rather than five hand-rolled `??` chains.
 *
 * The webhook cases drive a real client through a stubbed `fetch`, because the
 * property is what leaves on the wire (which agent id the webhook is created
 * against), not which local variable held a string.
 */

import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { _resetClientCache, actingAgent } from "../src/client.js";
import { resolveClient } from "../src/tool.js";
import { registerRineWebhook } from "../src/webhook.js";
import { seedAgentRuntime } from "@rine-network/core/testing";

/** The wire name, spelled literally: importing the constant would assert it
 * against itself and pass just as happily if the header were renamed. */
const HEADER = "X-Rine-Agent";
const API_URL = "https://api.actor.test";

const BOB = "b0b00000-0000-4000-8000-000000000001";
const KOFI = "c0f10000-0000-4000-8000-000000000002";

const SAVED_ENV = { ...process.env };
let configDir: string;
let calls: { url: string; init: RequestInit }[];

function agentRow(id: string, name: string) {
	return {
		id,
		name,
		handle: `${name}@acme`,
		human_oversight: true,
		incoming_policy: "accept_all",
		outgoing_policy: "send_all",
		created_at: "2026-06-19T00:00:00Z",
		verification_words: null,
		warnings: null,
		poll_url: null,
	};
}

/** Answer the token POST, `/agents`, and `/webhooks`; record every request. */
function installFetchStub(agents: ReturnType<typeof agentRow>[]): void {
	calls = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: string | URL | Request, init: RequestInit = {}) => {
			const url = String(input);
			calls.push({ url, init });
			let body: unknown = { items: agents, total: agents.length };
			if (url.includes("/oauth/token")) {
				body = { access_token: "stub-token", expires_in: 3600 };
			} else if (url.includes("/webhooks")) {
				body = {
					id: "d0d00000-0000-4000-8000-000000000003",
					agent_id: JSON.parse(String(init.body ?? "{}")).agent_id,
					url: JSON.parse(String(init.body ?? "{}")).url,
					active: true,
					created_at: "2026-06-19T00:00:00Z",
					secret: "shhh",
				};
			}
			return new Response(JSON.stringify(body), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}),
	);
}

/** The body of the `/webhooks` POST that actually left. */
function createdWebhookBody(): { agent_id?: string; url?: string } {
	const call = calls.find((c) => c.url.includes("/webhooks"));
	return JSON.parse(String(call?.init.body ?? "{}"));
}

/** The acting-agent header on a recorded call, case-insensitively. */
function actorHeaderOf(url: string): string | undefined {
	const call = calls.find((c) => c.url.includes(url));
	const headers = (call?.init.headers ?? {}) as Record<string, string>;
	return Object.entries(headers).find(
		([k]) => k.toLowerCase() === HEADER.toLowerCase(),
	)?.[1];
}

beforeEach(() => {
	_resetClientCache();
	configDir = fs.mkdtempSync(join(tmpdir(), "rine-eve-actor-"));
	seedAgentRuntime(configDir, BOB);
	delete process.env.RINE_AGENT;
	installFetchStub([agentRow(BOB, "bob"), agentRow(KOFI, "kofi")]);
});

afterEach(() => {
	_resetClientCache();
	process.env = { ...SAVED_ENV };
	fs.rmSync(configDir, { recursive: true, force: true });
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe("actingAgent — rungs 1 and 2 of the ladder", () => {
	it("prefers the caller's own value over the environment", () => {
		process.env.RINE_AGENT = "kofi";
		expect(actingAgent({ agent: "bob" })).toBe("bob");
	});

	it("falls back to RINE_AGENT when the caller named nobody", () => {
		process.env.RINE_AGENT = "kofi";
		expect(actingAgent({})).toBe("kofi");
	});

	it("trims a padded RINE_AGENT instead of hunting for ' kofi '", () => {
		process.env.RINE_AGENT = "  kofi  ";
		expect(actingAgent({})).toBe("kofi");
	});

	it("reads a bare `RINE_AGENT=` line as no actor at all", () => {
		// This is the literal line `scaffold.ts` writes into every generated
		// project's .env — it must mean "unset", never an agent named "".
		process.env.RINE_AGENT = "";
		expect(actingAgent({})).toBeUndefined();
	});

	it("reads a whitespace-only RINE_AGENT as no actor at all", () => {
		process.env.RINE_AGENT = "   ";
		expect(actingAgent({})).toBeUndefined();
	});

	it("answers with nobody when neither rung is set", () => {
		expect(actingAgent({})).toBeUndefined();
	});
});

describe("the Eve tool surface still opts into RINE_AGENT", () => {
	it("sends the env agent on the wire", async () => {
		process.env.RINE_AGENT = "kofi";

		await resolveClient({ configDir, apiUrl: API_URL }).identity.listAgents();

		expect(actorHeaderOf("/agents")).toBe("kofi");
	});

	it("sends no acting-agent header when RINE_AGENT is unset — the falsifier", async () => {
		await resolveClient({ configDir, apiUrl: API_URL }).identity.listAgents();

		expect(actorHeaderOf("/agents")).toBeUndefined();
	});
});

describe("registerRineWebhook runs the whole ladder", () => {
	it("resolves a bare RINE_AGENT name to that agent's id", async () => {
		process.env.RINE_AGENT = "kofi";

		await registerRineWebhook({
			baseUrl: "https://app.vercel.app",
			configDir,
			apiUrl: API_URL,
		});

		expect(createdWebhookBody().agent_id).toBe(KOFI);
	});

	it("lets an explicit agent beat RINE_AGENT", async () => {
		process.env.RINE_AGENT = "kofi";

		await registerRineWebhook({
			baseUrl: "https://app.vercel.app",
			agent: "bob",
			configDir,
			apiUrl: API_URL,
		});

		expect(createdWebhookBody().agent_id).toBe(BOB);
	});

	it("refuses by naming the org's agents when nobody is named", async () => {
		await expect(
			registerRineWebhook({
				baseUrl: "https://app.vercel.app",
				configDir,
				apiUrl: API_URL,
			}),
		).rejects.toThrow(
			/more than one agent[\s\S]*bob \(bob@acme\)[\s\S]*kofi \(kofi@acme\)[\s\S]*Name one of them with agent, or set RINE_AGENT\./,
		);
	});

	it("needs no agent at all in a single-agent org — the falsifier for the refusal", async () => {
		installFetchStub([agentRow(BOB, "bob")]);

		await registerRineWebhook({
			baseUrl: "https://app.vercel.app",
			configDir,
			apiUrl: API_URL,
		});

		expect(createdWebhookBody().agent_id).toBe(BOB);
	});

	it("acts as that only agent on a value that names nobody, and logs it", async () => {
		// The measured defect this reverses: a caller — or a scaffolder's
		// placeholder — puts a word in the actor slot and the whole command dies
		// before it registers anything. With one agent there is nothing to choose
		// between, so it registers and the operator log says what was ignored.
		installFetchStub([agentRow(BOB, "bob")]);
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

		await registerRineWebhook({
			baseUrl: "https://app.vercel.app",
			agent: "null",
			configDir,
			apiUrl: API_URL,
		});

		expect(createdWebhookBody().agent_id).toBe(BOB);
		expect(warn).toHaveBeenCalledWith(
			"rine: Ignored agent 'null': this org has one agent, so " +
				"bob (bob@acme) acted. Omit agent for a one-agent org.",
		);
		warn.mockRestore();
	});

	it("still refuses on a multi-agent org, where there is a choice to make", async () => {
		await expect(
			registerRineWebhook({
				baseUrl: "https://app.vercel.app",
				agent: "null",
				configDir,
				apiUrl: API_URL,
			}),
		).rejects.toThrow("No agent named 'null'.");
	});

	it("resolves a handle against this org's own agents, not WebFinger", async () => {
		// A webhook is registered against an agent id, so this rung has to end
		// in one. It used to end in whatever WebFinger said owned the handle —
		// a question about the whole network — so a handle belonging to another
		// org registered a webhook against an agent this deployment cannot act
		// as. The org's own list is the only thing that can answer "is it ours".
		await registerRineWebhook({
			baseUrl: "https://app.vercel.app",
			agent: "kofi@acme",
			configDir,
			apiUrl: API_URL,
		});

		expect(createdWebhookBody().agent_id).toBe(KOFI);
		expect(calls.filter((c) => c.url.includes("webfinger"))).toEqual([]);
	});

	it("refuses a handle this org does not own, naming the agents it has", async () => {
		await expect(
			registerRineWebhook({
				baseUrl: "https://app.vercel.app",
				agent: "kofi@other-org.rine.network",
				configDir,
				apiUrl: API_URL,
			}),
		).rejects.toThrow(
			/No agent with handle 'kofi@other-org\.rine\.network'[\s\S]*bob \(bob@acme\)[\s\S]*kofi \(kofi@acme\)/,
		);
		expect(calls.filter((c) => c.url.includes("/webhooks"))).toEqual([]);
	});

	it("costs no agent list when the actor is already a UUID", async () => {
		// A UUID answers rung 1 outright, so the org's agent list can neither
		// change the answer nor be required to read it: a deployment whose token
		// cannot list agents still registers its own webhook.
		process.env.RINE_AGENT = KOFI;

		await registerRineWebhook({
			baseUrl: "https://app.vercel.app",
			configDir,
			apiUrl: API_URL,
		});

		expect(createdWebhookBody().agent_id).toBe(KOFI);
		expect(calls.filter((c) => c.url.includes("/agents"))).toEqual([]);
	});

	it("appends the inbound path to the deployed base URL", async () => {
		installFetchStub([agentRow(BOB, "bob")]);

		const created = await registerRineWebhook({
			baseUrl: "https://app.vercel.app/",
			configDir,
			apiUrl: API_URL,
		});

		expect(created.url).toBe("https://app.vercel.app/rine/v1/inbound");
		expect(created.secret).toBe("shhh");
	});
});
