import { describe, expect, it } from "vitest";
import {
	groupIsMls,
	renderInbox,
	renderMessageBody,
	renderSingleMessage,
	unwrapText,
	verifiedNote,
} from "../src/format.js";
import { makeMsg } from "./helpers.js";

describe("renderers (R4: never leak ciphertext)", () => {
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

	it("groupIsMls reads capability flags", () => {
		// biome-ignore lint/suspicious/noExplicitAny: group fixture
		expect(groupIsMls({ mls_enabled: true, mls_group_id: null } as any)).toBe(true);
		// biome-ignore lint/suspicious/noExplicitAny: group fixture
		expect(groupIsMls({ mls_enabled: false, mls_group_id: null, mls_pending: false } as any)).toBe(false);
	});
});
