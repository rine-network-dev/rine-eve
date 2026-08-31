import {
	bareNameJoinRefusal,
	unresolvedHandleJoinRefusal,
} from "@rine-network/core";
import { describe, expect, it } from "vitest";
import {
	RINE_TOOLS,
	rineDiscoverTool,
	rineGroupInspectTool,
	rineGroupInvitesTool,
	rineGroupJoinTool,
	rineInboxTool,
	rineInspectTool,
	rineReadTool,
	rineSendTool,
	rineThreadTool,
	rineWhoamiTool,
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
		const out = await run(rineSendTool({ client }), {
			to: "bob@acme",
			body: "hi",
		});
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

	it("rine_send never rejects — SDK errors become strings", async () => {
		const { client } = fakeClient({
			send: async () => {
				throw new Error("network down");
			},
		});
		const out = await run(rineSendTool({ client }), {
			to: "bob@acme",
			body: "hi",
		});
		expect(out).toBe("network down");
	});

	it("rejects invalid input with a field-named message", async () => {
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

	it("rine_inbox marks decryptable messages delivered", async () => {
		const { client, delivered } = fakeClient({
			inbox: async () => ({
				items: [makeMsg({ id: "a" }), makeMsg({ id: "b" })],
			}),
		});
		const out = await run(rineInboxTool({ client }), {});
		expect(out).toMatch(/^1\. /m);
		expect(delivered[0]).toEqual(["a", "b"]);
	});

	it("rine_inbox defaults to status new and sends it on the wire", async () => {
		let seenOpts: { status?: unknown } | undefined;
		const { client } = fakeClient({
			inbox: async (opts: { status?: unknown }) => {
				seenOpts = opts;
				return { items: [] };
			},
		});
		await run(rineInboxTool({ client }), {});
		expect(seenOpts?.status).toBe("new");
	});

	it("rine_inbox with status all sends NO status parameter", async () => {
		let seenOpts: { status?: unknown } | undefined;
		const { client } = fakeClient({
			inbox: async (opts: { status?: unknown }) => {
				seenOpts = opts;
				return { items: [makeMsg({ id: "a" })] };
			},
		});
		await run(rineInboxTool({ client }), { status: "all" });
		// `all` is a tool-layer value; the server literal has three values, and
		// "everything" is the ABSENCE of the parameter.
		expect(seenOpts?.status).toBeUndefined();
	});

	it("rine_inbox with status read issues no mark-delivered write", async () => {
		const { client, delivered } = fakeClient({
			inbox: async () => ({
				items: [makeMsg({ id: "a" }), makeMsg({ id: "b" })],
			}),
		});
		const out = await run(rineInboxTool({ client }), { status: "read" });
		expect(out).toMatch(/^1\. /m);
		expect(delivered).toEqual([]);
	});

	it("rine_inbox acks only what it could decrypt", async () => {
		const { client, delivered } = fakeClient({
			inbox: async () => ({
				items: [
					makeMsg({ id: "a" }),
					makeMsg({ id: "b", decrypt_error: "no key" }),
				],
			}),
		});
		await run(rineInboxTool({ client }), {});
		// A broken envelope stays `new` so a later poll can retry after key
		// recovery — it must not be acked with the readable one.
		expect(delivered[0]).toEqual(["a"]);
	});

	it("rine_whoami renders the org, tier and live handles only", async () => {
		const { client } = fakeClient({
			whoami: async () => ({
				org: { name: "Acme", slug: "acme" },
				trust_tier: 2,
				agents: [
					{ handle: "support@acme", revoked_at: null },
					{ handle: "gone@acme", revoked_at: "2026-01-01T00:00:00Z" },
				],
			}),
		});
		const out = await run(rineWhoamiTool({ client }), {});
		expect(out).toContain("Org Acme (acme)");
		expect(out).toContain("trust tier: 2");
		expect(out).toContain("support@acme");
		expect(out).not.toContain("gone@acme");
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
		const out = await run(rineInspectTool({ client }), {
			handleOrId: "bob@acme",
		});
		expect(out).toContain("Bob (bob@acme)");
		expect(out).toContain("human oversight: yes");
	});

	it("rine_thread renders a multi-turn transcript role-tagged", async () => {
		const { client } = fakeClient({
			thread: async () => [
				entry({ direction: "sent", senderHandle: "me@acme", text: "ping" }),
				entry({
					direction: "received",
					senderHandle: "alice@acme",
					text: "pong",
				}),
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

	// Every other group verb on this surface takes the group; the one that
	// read what the group SAID took a conversation UUID, so a model holding a
	// group had nowhere to put it. It now has one, and the group goes to the SDK
	// as a group — never squeezed into the conversation slot.
	it("rine_thread reads a group named by its handle", async () => {
		let seen: unknown;
		const { client } = fakeClient({
			thread: async (arg: unknown) => {
				seen = arg;
				return [
					entry({ senderHandle: "alice@acme", text: "the delivery is booked" }),
				];
			},
		});
		const out = await run(rineThreadTool({ client }), {
			group: "#logistics@acme",
		});
		expect(out).toContain("[received] alice@acme: the delivery is booked");
		expect(seen).toMatchObject({ group: "#logistics@acme" });
	});

	// The other spelling of the same slot. A group UUID must reach the SDK
	// in the GROUP argument, not be mistaken for a conversation id because it
	// looks like one: `resolveThreadRef` decides by which field was named, never
	// by the shape of the string, and the SDK's own resolver is what turns it
	// into a group. Nothing on this surface pre-resolves it (the ladder lives
	// in one place, and the transcript read reaches it through `client.thread`).
	it("test_thread_when_the_group_is_a_uuid_sends_it_as_the_group", async () => {
		let seen: unknown;
		const { client } = fakeClient({
			thread: async (arg: unknown) => {
				seen = arg;
				return [entry({ senderHandle: "alice@acme", text: "booked" })];
			},
		});
		const out = await run(rineThreadTool({ client }), {
			group: "11111111-1111-1111-1111-111111111111",
		});
		expect(seen).toMatchObject({
			group: "11111111-1111-1111-1111-111111111111",
		});
		expect(seen).not.toHaveProperty("conversationId");
		expect(out).toContain("[received] alice@acme: booked");
	});

	// The measured failure: a model put the group's NAME in the conversation
	// slot and the server — which types that path parameter `uuid.UUID` —
	// answered a framework 422 with no next step in it. All three mistakes are
	// decided offline now, so a caller that named the wrong thing spends nothing.
	it.each([
		[
			"both references",
			{
				group: "#logistics@acme",
				conversationId: "22222222-2222-2222-2222-222222222222",
			},
			"Name exactly one of group",
		],
		["neither reference", {}, "Name exactly one of group"],
		[
			"a conversation reference that is not a UUID",
			{ conversationId: "quarterly planning group" },
			"To read a group, name the group instead",
		],
	])(
		"rine_thread refuses %s without calling the client",
		async (_case, input, expected) => {
			let called = false;
			const { client } = fakeClient({
				thread: async () => {
					called = true;
					return [];
				},
			});
			const out = await run(rineThreadTool({ client }), input);
			expect(out).toContain(expected);
			expect(called).toBe(false);
		},
	);

	it("RINE_TOOLS has 25 tools incl. the admission verbs (registry/factory in sync)", () => {
		expect(RINE_TOOLS).toHaveLength(25);
		const names = RINE_TOOLS.map((t) => t.name);
		expect(names).toContain("rine_thread");
		expect(names).toContain("rine_pay");
		expect(names).toContain("rine_fulfill");
		expect(names).toContain("rine_group_join");
		expect(names).toContain("rine_group_invites");
		expect(names).toContain("rine_group_reclaim");
		expect(names).toContain("rine_inbox");
		expect(names).toContain("rine_groups");
		expect(names).toContain("rine_discover_groups");
		expect(names).toContain("rine_whoami");
		expect(names).toContain("rine_group_roster");
		// The rename is a hard cutover — no alias survives under the old name.
		expect(names).not.toContain("rine_check_inbox");
		expect(names).not.toContain("rine_group_members");
		// Every registry entry resolves to a live factory.
		for (const t of RINE_TOOLS) expect(typeof t.factory).toBe("function");
	});

	it("each domain carries the tools the toolkit filter promises", () => {
		const byDomain = (d: string) =>
			RINE_TOOLS.filter((t) => t.domain === d).map((t) => t.name);
		expect(byDomain("messaging")).toHaveLength(6);
		expect(byDomain("discovery")).toHaveLength(4);
		expect(byDomain("groups")).toHaveLength(13);
		expect(byDomain("payments")).toHaveLength(2);
		expect(byDomain("discovery")).toContain("rine_discover_groups");
		expect(byDomain("discovery")).toContain("rine_whoami");
		expect(byDomain("groups")).toContain("rine_groups");
		expect(byDomain("groups")).toContain("rine_group_roster");
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
		const out = await run(rineGroupInspectTool({ client }), {
			group: "#ops@acme",
		});
		expect(out).toContain("[OK] MLS");
		expect(out).toContain("#ops@acme");
	});

	it("rine_group_join joins immediately when the group is already listed", async () => {
		const { client } = fakeClient({
			groups: {
				resolveRefForJoin: async (ref: string) => ref,
				join: async () => ({
					status: "joined",
					member: { group_id: "g1", agent_id: "a1", role: "member" },
				}),
			},
		});
		const out = await run(rineGroupJoinTool({ client }), {
			group: "11111111-1111-1111-1111-111111111111",
		});
		expect(out).toContain("Joined");
	});

	// This surface used to resolve a join against `groups.listInvites()` alone, so
	// a handle read straight off `rine_discover_groups` was refused here with the
	// server never having been asked. It now hands the reference to the SDK's
	// join-scoped ladder — org seats, then this agent's invitations, then the
	// public directory — which is where those rungs are tested. What is eve's own
	// behaviour, and so what is tested here, is that it delegates the reference
	// the caller actually typed and joins the id it gets back.
	it("rine_group_join hands the caller's reference to the join ladder and joins what it answers", async () => {
		let seenRef: unknown;
		let seenGroupId: unknown;
		const { client } = fakeClient({
			groups: {
				resolveRefForJoin: async (ref: string) => {
					seenRef = ref;
					return "11111111-1111-1111-1111-111111111111";
				},
				join: async (groupId: unknown) => {
					seenGroupId = groupId;
					return {
						status: "pending",
						request: {
							id: "req1",
							group_id: "11111111-1111-1111-1111-111111111111",
							agent_id: "a1",
							status: "invited",
						},
					};
				},
			},
		});
		const out = await run(rineGroupJoinTool({ client }), {
			group: "#ops@acme",
		});
		expect(seenRef).toBe("#ops@acme");
		expect(seenGroupId).toBe("11111111-1111-1111-1111-111111111111");
		expect(out).toContain("pending approval");
	});

	// The two refusals below are composed by the ladder's own exported composers
	// rather than typed out here. A hand-typed copy is a fixture that agrees with
	// a sentence nothing ships: this suite would keep passing while the shipped
	// refusal drifted, which is exactly the drift `formatError` cannot survive —
	// it keys on the LEAD phrase to decide whether a remedy gets appended at all.
	it("rine_group_join answers an unresolvable handle with this surface's own discover verbs", async () => {
		const { client } = fakeClient({
			groups: {
				resolveRefForJoin: async () => {
					// A plain `Error` — what the ladder actually throws. Stubbing a
					// richer class would test this surface against a shape the
					// product never hands it.
					throw new Error(unresolvedHandleJoinRefusal("#nope@acme"));
				},
			},
		});
		const out = await run(rineGroupJoinTool({ client }), {
			group: "#nope@acme",
		});
		expect(out).toContain("Group not found: #nope@acme");
		expect(out).toContain("rine_groups");
		expect(out).toContain("rine_discover_groups");
	});

	it("rine_group_join passes a bare name to the ladder rather than refusing it here", async () => {
		// This surface could always join by bare name, against the invitations
		// addressed to this agent. The rung lives in the SDK now, but what eve
		// must not do is decide a bare name is unresolvable BEFORE asking — the
		// caller would be refused with the server never having been asked, which
		// is the defect this whole round exists for.
		let seenRef: unknown;
		const { client } = fakeClient({
			groups: {
				resolveRefForJoin: async (ref: string) => {
					seenRef = ref;
					return "11111111-1111-1111-1111-111111111111";
				},
				join: async () => ({
					status: "joined",
					member: {
						group_id: "11111111-1111-1111-1111-111111111111",
						agent_id: "a1",
						role: "member",
					},
				}),
			},
		});
		const out = await run(rineGroupJoinTool({ client }), { group: "ops" });
		expect(seenRef).toBe("ops");
		expect(out).toContain("Joined");
	});

	it("rine_group_join gives a bare name no invitation answers the same remedy a handle gets", async () => {
		// The refusal has to carry the remedy too: a bare name is the spelling
		// every other group tool here invites, so its refusal is the one a caller
		// is likeliest to read, and a refusal with no way forward reads as the
		// product being broken.
		const { client } = fakeClient({
			groups: {
				resolveRefForJoin: async () => {
					throw new Error(bareNameJoinRefusal("ops"));
				},
			},
		});
		const out = await run(rineGroupJoinTool({ client }), { group: "ops" });
		expect(out).toContain("Group not found: ops");
		expect(out).toContain(
			"A bare name is read as one of this agent's pending invitations",
		);
		expect(out).toContain("rine_discover_groups");
	});

	it("rine_group_invites renders the caller's pending invites", async () => {
		const { client } = fakeClient({
			groups: {
				listInvites: async () => [
					{
						id: "req1",
						group_id: "11111111-1111-1111-1111-111111111111",
						agent_id: "a1",
						status: "invited",
						group_handle: "#ops@acme",
						invited_by: "bob-uuid",
						message: "join us",
					},
				],
			},
		});
		const out = await run(rineGroupInvitesTool({ client }), {});
		expect(out).toContain("#ops@acme");
		expect(out).toContain("invited by bob-uuid");
		expect(out).toContain("join us");
	});

	it("rine_group_invites reports the empty state", async () => {
		const { client } = fakeClient({ groups: { listInvites: async () => [] } });
		const out = await run(rineGroupInvitesTool({ client }), {});
		expect(out).toBe("No pending group invites.");
	});
});
