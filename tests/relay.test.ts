import { describe, expect, it } from "vitest";
import { buildRelayBody, drainOnce, type FetchLike } from "../src/relay.js";
import { verifyRineSignature } from "../src/hmac.js";
import { fakeClient, makeMsg } from "./helpers.js";

describe("dev relay", () => {
	it("builds the real server envelope shape (message_id)", () => {
		const body = JSON.parse(buildRelayBody(makeMsg({ id: "m7" }), "agent-1"));
		expect(body.message_id).toBe("m7");
		expect(body.agent_id).toBe("agent-1");
		expect(body.event).toBe("message.received");
	});

	it("POSTs each new message signed with the shared secret", async () => {
		const secret = "devsecret";
		const posted: { url: string; headers: Record<string, string>; body: string }[] = [];
		const fetchImpl: FetchLike = async (url, init) => {
			posted.push({ url, headers: init.headers, body: init.body });
			return { status: 200 };
		};
		const { client } = fakeClient({
			inbox: async () => ({ items: [makeMsg({ id: "a" }), makeMsg({ id: "b" })] }),
		});
		const seen = new Set<string>();
		const n = await drainOnce({
			client,
			target: "http://localhost:3000/rine/v1/inbound",
			secret,
			seen,
			fetchImpl,
			log: () => {},
		});
		expect(n).toBe(2);
		expect(posted.length).toBe(2);
		// Each POST carries a valid signature the channel would accept.
		for (const p of posted) {
			expect(verifyRineSignature(p.body, p.headers["x-rine-signature"], secret)).toBe(true);
		}
		expect([...seen].sort()).toEqual(["a", "b"]);
	});

	it("dedupes already-seen ids across passes", async () => {
		let posts = 0;
		const fetchImpl: FetchLike = async () => {
			posts++;
			return { status: 200 };
		};
		const { client } = fakeClient({ inbox: async () => ({ items: [makeMsg({ id: "x" })] }) });
		const seen = new Set<string>();
		await drainOnce({ client, target: "t", secret: "s", seen, fetchImpl, log: () => {} });
		await drainOnce({ client, target: "t", secret: "s", seen, fetchImpl, log: () => {} });
		expect(posts).toBe(1);
	});

	it("retries on 5xx (transient) but drops on 4xx (terminal)", async () => {
		const { client } = fakeClient({ inbox: async () => ({ items: [makeMsg({ id: "x" })] }) });

		// 5xx — channel not ready: not marked seen, so a later pass retries.
		const seen5xx = new Set<string>();
		const n5 = await drainOnce({
			client,
			target: "t",
			secret: "s",
			seen: seen5xx,
			fetchImpl: async () => ({ status: 503 }),
			log: () => {},
		});
		expect(n5).toBe(0);
		expect(seen5xx.size).toBe(0);

		// 4xx — terminal drop (e.g. unverified): marked seen, never retried.
		const seen4xx = new Set<string>();
		const n4 = await drainOnce({
			client,
			target: "t",
			secret: "s",
			seen: seen4xx,
			fetchImpl: async () => ({ status: 422 }),
			log: () => {},
		});
		expect(n4).toBe(0);
		expect(seen4xx.has("x")).toBe(true);
	});
});
