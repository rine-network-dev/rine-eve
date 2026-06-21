import { describe, expect, it } from "vitest";
import { signRineBody, verifyRineSignature } from "../src/hmac.js";

describe("rine webhook signature", () => {
	const secret = "s3cr3t";
	const body = JSON.stringify({ message: { id: "m1" } });

	it("verifies a body signed with the same secret", () => {
		const sig = signRineBody(body, secret);
		expect(verifyRineSignature(body, sig, secret)).toBe(true);
	});

	it("rejects a tampered body", () => {
		const sig = signRineBody(body, secret);
		expect(verifyRineSignature(`${body} `, sig, secret)).toBe(false);
	});

	it("rejects a wrong secret", () => {
		const sig = signRineBody(body, secret);
		expect(verifyRineSignature(body, sig, "other")).toBe(false);
	});

	it("rejects a missing/empty signature or secret", () => {
		expect(verifyRineSignature(body, undefined, secret)).toBe(false);
		expect(verifyRineSignature(body, signRineBody(body, secret), "")).toBe(false);
	});

	it("produces the `sha256=` prefix", () => {
		expect(signRineBody(body, secret)).toMatch(/^sha256=[0-9a-f]{64}$/);
	});
});
