import { describe, expect, it } from "vitest";
import {
	RINE_TOOLS,
	rineCheckInboxTool,
	rineDiscoverTool,
	rineGroupInspectTool,
	rineInspectTool,
	rineReadTool,
	rineSendTool,
	rineThreadTool,
} from "../src/tools/index.js";
import { fakeClient, makeMsg } from "./helpers.js";

/** A ThreadEntry fixture (camelCase SDK shape). */
const entry = (over: Record<string, unknown> = {}) => ({
	direction: "received",
	senderHandle: "alice@acme",
	text: "hi",
	verificationStatus: "verified",
	type: "rine.v1.task_request",
	createdAt: "2026-06-20T00:00:00Z",
	...over,
});

// Call a tool descriptor's execute with raw model input (ctx is ignored by us).
// biome-ignore lint/suspicious/noExplicitAny: descriptor execute is (input, ctx).
const run = (tool: any, input: unknown) => tool.execute(input, {});

describe("rine tools (env identity via injected client)", () => {
	it("rine_send maps a send to a confirmation string", async () => {
		const { client, sends } = fakeClient({
			send: async () => ({ id: "m9", conversation_id: "c9" }),
		});
		const out = await run(rineSendTool({ client }), { to: "bob@acme", body: "hi" });
		expect(out).toContain("Sent message m9");
		expect(out).toContain("conversation c9");
		expect(sends.length).toBe(0); // overridden send doesn't push, but was called
	});

	it("applies zod defaults (messageType) to raw input", async () => {
		let seenType: unknown;
		const { client } = fakeClient({
			send: async (_to: unknown, _p: unknown, opts: { type?: string }) => {
				seenType = opts.type;
				return { id: "m1", conversation_id: "c1" };
			},
		});
		await run(rineSendTool({ client }), { to: "bob@acme", body: "hi" });
		expect(seenType).toBe("rine.v1.task_request");
	});

	it("rine_send never rejects — SDK errors become strings (R2)", async () => {
		const { client } = fakeClient({
			send: async () => {
				throw new Error("network down");
			},
		});
		const out = await run(rineSendTool({ client }), { to: "bob@acme", body: "hi" });
		expect(out).toBe("network down");
	});

	it("rejects invalid input with a field-named message (R3 parse)", async () => {
		const { client } = fakeClient();
		const out = await run(rineSendTool({ client }), { body: "missing to" });
		expect(out).toContain("Invalid input");
		expect(out).toContain("to");
	});

	it("rine_read renders a decrypted message, no ciphertext", async () => {
		const { client } = fakeClient({
			// biome-ignore lint/suspicious/noExplicitAny: stray envelope field
			read: async () => makeMsg({ encrypted_payload: "CIPHER" } as any),
		});
		const out = await run(rineReadTool({ client }), {
			messageId: "11111111-1111-1111-1111-111111111111",
		});
		expect(out).toContain("hello there");
		expect(out).not.toContain("CIPHER");
	});

	it("rine_check_inbox marks decryptable messages delivered", async () => {
		const { client, delivered } = fakeClient({
			inbox: async () => ({ items: [makeMsg({ id: "a" }), makeMsg({ id: "b" })] }),
		});
		const out = await run(rineCheckInboxTool({ client }), {});
		expect(out).toMatch(/^1\. /m);
		expect(delivered[0]).toEqual(["a", "b"]);
	});

	it("rine_discover renders directory matches", async () => {
		const { client } = fakeClient({
			discover: async () => ({
				items: [{ handle: "bob@acme", verified: true, description: "a bot" }],
			}),
		});
		const out = await run(rineDiscoverTool({ client }), { q: "bob" });
		expect(out).toContain("bob@acme");
		expect(out).toContain("[verified]");
	});

	it("rine_inspect renders a profile", async () => {
		const { client } = fakeClient({
			inspect: async () => ({
				name: "Bob",
				handle: "bob@acme",
				id: "id1",
				verified: false,
				human_oversight: true,
			}),
		});
		const out = await run(rineInspectTool({ client }), { handleOrId: "bob@acme" });
		expect(out).toContain("Bob (bob@acme)");
		expect(out).toContain("human oversight: yes");
	});

	it("rine_thread renders a multi-turn transcript role-tagged (T-EVE-1)", async () => {
		const { client } = fakeClient({
			thread: async () => [
				entry({ direction: "sent", senderHandle: "me@acme", text: "ping" }),
				entry({ direction: "received", senderHandle: "alice@acme", text: "pong" }),
			],
		});
		const out = await run(rineThreadTool({ client }), {
			conversationId: "22222222-2222-2222-2222-222222222222",
		});
		expect(out).toContain("[sent] you: ping");
		expect(out).toContain("[received] alice@acme: pong");
	});

	it("rine_thread passes [unavailable] through unchanged", async () => {
		const { client } = fakeClient({
			thread: async () => [entry({ text: "[unavailable]" })],
		});
		const out = await run(rineThreadTool({ client }), {
			conversationId: "22222222-2222-2222-2222-222222222222",
		});
		expect(out).toContain("[unavailable]");
	});

	it("RINE_TOOLS has 12 tools incl. rine_thread (registry/factory in sync)", () => {
		expect(RINE_TOOLS).toHaveLength(12);
		const names = RINE_TOOLS.map((t) => t.name);
		expect(names).toContain("rine_thread");
		// Every registry entry resolves to a live factory.
		for (const t of RINE_TOOLS) expect(typeof t.factory).toBe("function");
	});

	it("rine_group_inspect reports MLS as a capability ([OK])", async () => {
		const { client } = fakeClient({
			groups: {
				list: async () => ({
					items: [
						{
							id: "g1",
							handle: "#ops@acme",
							mls_enabled: true,
							mls_group_id: "mls1",
							enrollment_policy: "closed",
							visibility: "private",
						},
					],
				}),
			},
		});
		const out = await run(rineGroupInspectTool({ client }), { group: "#ops@acme" });
		expect(out).toContain("[OK] MLS");
		expect(out).toContain("#ops@acme");
	});
});
