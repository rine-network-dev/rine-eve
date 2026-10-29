import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seedAgentRuntime, seedOrgIdentity } from "@rine-network/core/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { _resetClientCache, getRineClient } from "../src/client.js";

afterEach(() => _resetClientCache());

describe("getRineClient memoization", () => {
	it("returns the same base client for the same (configDir, apiUrl)", () => {
		const a = getRineClient({ configDir: "/tmp/x", apiUrl: "https://r" });
		const b = getRineClient({ configDir: "/tmp/x", apiUrl: "https://r" });
		expect(a).toBe(b);
	});

	it("builds distinct clients for distinct config", () => {
		const a = getRineClient({ configDir: "/tmp/x", apiUrl: "https://r" });
		const b = getRineClient({ configDir: "/tmp/y", apiUrl: "https://r" });
		expect(a).not.toBe(b);
	});

	it("derives a per-agent client without a new base", () => {
		const base = getRineClient({ configDir: "/tmp/x", apiUrl: "https://r" });
		const scoped = getRineClient({ configDir: "/tmp/x", apiUrl: "https://r", agent: "bob@acme" });
		// withAgent returns a derived client (not the base, not cached separately).
		expect(scoped).not.toBe(base);
		expect(getRineClient({ configDir: "/tmp/x", apiUrl: "https://r" })).toBe(base);
	});

	it("_resetClientCache forces a fresh base", () => {
		const a = getRineClient({ configDir: "/tmp/z", apiUrl: "https://r" });
		_resetClientCache();
		const b = getRineClient({ configDir: "/tmp/z", apiUrl: "https://r" });
		expect(a).not.toBe(b);
	});
});

describe("getRineClient sign-in", () => {
	it("signs in as the agent while the owner dir holds an org root", async () => {
		const base = mkdtempSync(join(tmpdir(), "rine-client-"));
		const configDir = join(base, "runtime");
		const ownerDir = join(base, "owner");
		const agentId = "622684e9-8ef3-4633-b407-b658c23c6b1f";
		seedAgentRuntime(configDir, agentId, { cacheToken: false });
		seedOrgIdentity(ownerDir);
		vi.stubEnv("RINE_OWNER_DIR", ownerDir);
		const assertions: string[] = [];
		vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
			const json = (body: unknown) => Response.json(body, { status: 200 });
			if (String(url).endsWith("/oauth/token")) {
				const form = new URLSearchParams(String(init?.body));
				assertions.push(form.get("client_assertion") ?? "");
				return json({ access_token: "t", expires_in: 900 });
			}
			return json({ items: [], total: 0 });
		});
		try {
			await getRineClient({ configDir, apiUrl: "https://rine.test" }).listAgents();
		} finally {
			vi.unstubAllEnvs();
			vi.unstubAllGlobals();
			rmSync(base, { recursive: true, force: true });
		}
		const claims = JSON.parse(
			Buffer.from(assertions[0]?.split(".")[1] ?? "", "base64url").toString(),
		);
		expect(claims.iss).toBe(`agent:${agentId}`);
	});
});
