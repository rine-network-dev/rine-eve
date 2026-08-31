import { describe, expect, it } from "vitest";
import {
	SENDER_KEY_UNAVAILABLE_CODE,
	SENDER_KEY_UNAVAILABLE_PREVIEW,
	groupIsMls,
} from "@rine-network/sdk";
import {
	renderGroup,
	renderInbox,
	renderMessageBody,
	renderSingleMessage,
	unwrapText,
	verifiedNote,
} from "../src/format.js";
import {
	NO_CONVERSATION,
	NO_OWN_AGENTS,
} from "../src/format-groups-list.js";
import type { GroupRead } from "../src/types.js";
import { makeMsg } from "./helpers.js";

describe("renderers (never leak ciphertext)", () => {
	it("unwraps { text } and plain strings", () => {
		expect(unwrapText({ text: "hi" })).toBe("hi");
		expect(unwrapText("yo")).toBe("yo");
		expect(unwrapText(null)).toBe("");
		expect(unwrapText({ a: 1 })).toBe('{"a":1}');
	});

	it("renderMessageBody surfaces decrypt errors, never ciphertext", () => {
		const ok = renderMessageBody(makeMsg({ plaintext: { text: "secret-plain" } }));
		expect(ok).toBe("secret-plain");
		const bad = renderMessageBody(
			// biome-ignore lint/suspicious/noExplicitAny: fixture
			makeMsg({ decrypt_error: "no key", plaintext: undefined } as any),
		);
		expect(bad).toContain("[unreadable]");
	});

	it("rendered single message has no ciphertext field", () => {
		// biome-ignore lint/suspicious/noExplicitAny: inject a stray envelope field
		const msg = makeMsg({ encrypted_payload: "BASE64CIPHERTEXT" } as any);
		const out = renderSingleMessage(msg);
		expect(out).not.toContain("BASE64CIPHERTEXT");
		expect(out).toContain("hello there");
		expect(out).toContain("signature verified");
	});

	it("verifiedNote is honest about unverified mail", () => {
		expect(verifiedNote(makeMsg({ verified: true }))).toBe("signature verified");
		expect(
			verifiedNote(
				// biome-ignore lint/suspicious/noExplicitAny: fixture
				makeMsg({ verified: false, verification_status: "unverifiable" } as any),
			),
		).toContain("unverifiable");
	});

	it("renderInbox numbers items or reports empty", () => {
		expect(renderInbox([])).toBe("No new messages.");
		const out = renderInbox([makeMsg(), makeMsg({ id: "x" })]);
		expect(out).toMatch(/^1\. /m);
		expect(out).toMatch(/^2\. /m);
	});

	it("MULTI tier: first unopenable row explains in full, later rows mark", () => {
		const full = "rine cannot open this group message: it is sealed under sender key X.";
		const noKey = (id: string) =>
			makeMsg({
				id,
				plaintext: undefined,
				decrypt_error: full,
				// biome-ignore lint/suspicious/noExplicitAny: fixture cast for SDK type drift.
				decrypt_error_code: SENDER_KEY_UNAVAILABLE_CODE,
			} as any);
		const out = renderInbox([noKey("a"), noKey("b"), noKey("c")]);
		const lines = out.split("\n");
		expect(lines[0]).toContain(`[unreadable] ${full}`);
		expect(lines[1]).toContain(`[unreadable] ${SENDER_KEY_UNAVAILABLE_PREVIEW}`);
		expect(lines[1]).not.toContain(full);
		expect(lines[2]).toContain(`[unreadable] ${SENDER_KEY_UNAVAILABLE_PREVIEW}`);
	});

	it("a fresh renderInbox() call explains again — no module-level flag", () => {
		const full = "rine cannot open this group message: it is sealed under sender key X.";
		const noKey = (id: string) =>
			makeMsg({
				id,
				plaintext: undefined,
				decrypt_error: full,
				// biome-ignore lint/suspicious/noExplicitAny: fixture cast for SDK type drift.
				decrypt_error_code: SENDER_KEY_UNAVAILABLE_CODE,
			} as any);
		renderInbox([noKey("a"), noKey("b")]); // spends this render's explanation
		const second = renderInbox([noKey("c")]);
		expect(second).toContain(full);
	});

	it("an unrelated decrypt-error cause is untouched — no code, no tiering", () => {
		const full = "rine cannot open this group message: it is sealed under sender key X.";
		const other = makeMsg({
			id: "a",
			plaintext: undefined,
			decrypt_error: "bad sig",
			// biome-ignore lint/suspicious/noExplicitAny: fixture cast for SDK type drift.
		} as any);
		const noKey = makeMsg({
			id: "b",
			plaintext: undefined,
			decrypt_error: full,
			// biome-ignore lint/suspicious/noExplicitAny: fixture cast for SDK type drift.
			decrypt_error_code: SENDER_KEY_UNAVAILABLE_CODE,
		} as any);
		const out = renderInbox([other, noKey]);
		const lines = out.split("\n");
		expect(lines[0]).toContain("[unreadable] bad sig");
		expect(lines[1]).toContain(full);
	});

	it("SINGLE tier (renderMessageBody with no explainer) keeps the full sentence", () => {
		const full = "rine cannot open this group message: it is sealed under sender key X.";
		const msg = makeMsg({
			plaintext: undefined,
			decrypt_error: full,
			// biome-ignore lint/suspicious/noExplicitAny: fixture cast for SDK type drift.
			decrypt_error_code: SENDER_KEY_UNAVAILABLE_CODE,
		} as any);
		expect(renderMessageBody(msg)).toBe(`[unreadable] ${full}`);
	});

	it("groupIsMls reads the mls_group_id latch and nothing else", () => {
		// The latch is the only field that says the group HAS MLS state;
		// `mls_enabled` is an intent flag an open-enrollment group carries while
		// running on sender keys.
		// biome-ignore lint/suspicious/noExplicitAny: group fixture
		expect(groupIsMls({ mls_enabled: false, mls_group_id: "mls-abc" } as any)).toBe(true);
		// biome-ignore lint/suspicious/noExplicitAny: group fixture
		expect(groupIsMls({ mls_enabled: true, mls_group_id: null } as any)).toBe(false);
		// biome-ignore lint/suspicious/noExplicitAny: group fixture
		expect(groupIsMls({ mls_enabled: false, mls_group_id: null, mls_pending: false } as any)).toBe(false);
	});
});

const CONVERSATION_ID = "66666666-6666-4666-8666-666666666666";
const OWN_AGENT = "44444444-4444-4444-4444-444444444444";
const UNKNOWN_AGENT = "99999999-9999-4999-8999-999999999999";

// What `client.agentHandles()` answers: this org's ids indexed lowercased.
const HANDLES: ReadonlyMap<string, string> = new Map([
	[OWN_AGENT, "ops@acme"],
	["55555555-5555-4555-8555-555555555555", "billing@acme"],
]);

// Module scope so both `renderGroup` blocks below share one fixture — the
// mastra twin of this file keeps its own `group()` here for the same reason.
function group(over: Record<string, unknown> = {}): GroupRead {
	return {
		id: "g-1",
		name: "Ops",
		handle: "#ops@acme",
		enrollment_policy: "closed",
		visibility: "private",
		mls_enabled: false,
		mls_group_id: null,
		mls_pending: false,
		conversation_id: CONVERSATION_ID,
		member_agent_ids: [OWN_AGENT],
		...over,
	} as GroupRead;
}

describe("renderGroup — four encryption states", () => {
	it("a latched group renders as an MLS group", () => {
		const out = renderGroup(group({ mls_group_id: "mls-abc" }));
		expect(out).toContain("[OK] MLS group — end-to-end encrypted");
		expect(out).toContain("mls_group_id: mls-abc");
		expect(out).not.toContain("sender-key");
	});

	it("a group whose MLS init is in flight renders its own third state", () => {
		// Not sender-key and not yet a latched MLS group: the send path already
		// takes the MLS branch here, so either of the other two renders lies.
		const out = renderGroup(group({ mls_enabled: true, mls_pending: true }));
		expect(out).toContain("[OK] MLS group, initialising");
		expect(out).toContain("Sends from here already use MLS.");
		expect(out).not.toContain("sender-key");
	});

	it("an open-enrollment group renders as sender-key even with mls_enabled", () => {
		const out = renderGroup(
			group({ enrollment_policy: "open", mls_enabled: true }),
		);
		expect(out).toContain("[OK] sender-key group");
		expect(out).not.toContain("MLS group");
	});

	it("names the fourth state: created to run MLS, no ratchet tree", () => {
		// Unlatched and no init in flight, so this is field for field an open
		// group in the MLS columns — and it used to fall into the plain
		// sender-key arm, which told the agent nothing about the encryption the
		// group was created for and did not get.
		const out = renderGroup(group({ mls_enabled: true }));
		expect(out).toContain("[OK] sender-key group");
		expect(out).toContain("ratchet tree was never founded");
		// Nothing here may claim the group is unusable or that the founding was
		// attempted and failed — no client can tell a died init from an init
		// that never ran, and the server does not refuse a send either way.
		expect(out).not.toMatch(/broken|frozen|failed|cannot carry|holds no keys/i);
	});

	it("says no verb on this surface founds it, because rine_group_reclaim refuses here", () => {
		// The repair clause is the SDK's, and this surface asks for the no-verb
		// spelling: naming a verb the agent would then be refused by is worse
		// than naming none. The sentence still says who CAN act.
		const out = renderGroup(group({ mls_enabled: true }));
		expect(out).toContain("No verb on this surface founds it");
		expect(out).not.toContain("rine_group_reclaim");
		expect(out).not.toContain("rine group resume-admission");
	});

	it("extends the ordinary sender-key line rather than replacing it", () => {
		// The two groups run the same cryptography and the fourth state's line
		// is the ordinary one plus the rest of the answer. If the arms ever
		// disagree about what sender keys ARE, this fails — which is the whole
		// reason the fourth arm sits in front of the plain one rather than
		// rewriting it.
		const diagnosis = (g: GroupRead) => renderGroup(g).split("\n")[1] ?? "";
		const ordinary = diagnosis(group({ enrollment_policy: "open" }));
		expect(ordinary).toContain("[OK] sender-key group");
		expect(diagnosis(group({ mls_enabled: true }))).toMatch(
			new RegExp(`^${ordinary.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} .`),
		);
	});

	it("the four group states are rendered as four distinct lines", () => {
		// The regression this pins: the in-flight branch swallowing the
		// open-enrollment case, or vice versa, is invisible to a test that only
		// checks the new branch fires. The fourth state joined the set for the
		// same reason — it is the one that used to BE the sender-key render.
		const mls = renderGroup(group({ mls_group_id: "mls-abc" }));
		const inFlight = renderGroup(
			group({ mls_enabled: true, mls_pending: true }),
		);
		const neverFounded = renderGroup(group({ mls_enabled: true }));
		const senderKey = renderGroup(
			group({ enrollment_policy: "open", mls_enabled: true }),
		);
		expect(new Set([mls, inFlight, neverFounded, senderKey]).size).toBe(4);
	});
});

describe("renderGroup — the conversation pointer", () => {
	it("names the id under the same key `rine_thread` asks for", () => {
		// The whole affordance: a model reads `conversation_id: <uuid>` here and
		// fills `rine_thread`'s argument with it. Spelling the key any other way
		// puts a translation step back in exactly the place this removes one.
		expect(renderGroup(group())).toContain(
			`conversation_id: ${CONVERSATION_ID}`,
		);
	});

	it("says nothing has been said yet rather than printing a null", () => {
		const out = renderGroup(group({ conversation_id: null }));
		expect(out).toContain(NO_CONVERSATION);
		expect(out).not.toContain("null");
		expect(out).not.toContain("undefined");
	});

	it("renders the clause on every group, including the empty one", () => {
		// Omitting it on null would read to a model as a rendering fault rather
		// than as a fact, and it would have no way to tell the two apart.
		for (const g of [group(), group({ conversation_id: null })]) {
			expect(renderGroup(g)).toContain("conversation_id: ");
		}
	});
});

describe("renderGroup — which of this org's agents hold a seat", () => {
	// The `[OK]` lines above describe how the GROUP is run. None of them says
	// whether this org may act in it, and the group list this view is reached
	// from is org-scoped — so before this clause a model could read a full
	// `[OK] MLS group` report about a group holding no seat of its org's at all,
	// and learn that only from a refusal.

	it("names the seated agents by handle", () => {
		// Case 1 of the shared rule: the handle is what a model reads and what
		// every group verb takes. Its own UUID is a value it has never seen.
		expect(renderGroup(group(), HANDLES)).toContain("your agents: ops@acme");
	});

	it("prints an id this org's list cannot resolve as the id", () => {
		// Case 2 — degraded, not lost: `X-Rine-Agent` still takes the UUID.
		const out = renderGroup(
			group({ member_agent_ids: [UNKNOWN_AGENT] }),
			HANDLES,
		);
		expect(out).toContain(`your agents: ${UNKNOWN_AGENT}`);
	});

	it("prints the ids when no agent list was resolved at all", () => {
		// `client.agentHandles()` answers an empty map when `GET /agents` fails,
		// and this view must keep rendering: the group read already succeeded.
		expect(renderGroup(group())).toContain(`your agents: ${OWN_AGENT}`);
	});

	it("names every seated agent, not just the first", () => {
		const second = "55555555-5555-4555-8555-555555555555";
		const out = renderGroup(
			group({ member_agent_ids: [OWN_AGENT, second] }),
			HANDLES,
		);
		expect(out).toContain("your agents: ops@acme, billing@acme");
	});

	it("says no agent of this org is seated rather than printing an empty list", () => {
		const out = renderGroup(group({ member_agent_ids: [] }));
		expect(out).toContain(NO_OWN_AGENTS);
		expect(out).not.toContain("your agents: \n");
		expect(out).not.toContain("undefined");
	});

	it("renders the clause on every group, seated or not", () => {
		// Same reason as the conversation pointer: a clause that appears on some
		// groups and not others reads as a rendering fault, and the empty case
		// is the one a model most needs to see.
		for (const g of [group(), group({ member_agent_ids: [] })]) {
			expect(renderGroup(g)).toContain("your agents: ");
		}
	});
});
