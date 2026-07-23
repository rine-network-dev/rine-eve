import { describe, expect, it } from "vitest";
import { z } from "zod";
import { formatError } from "../src/errors.js";

describe("formatError (errors → readable strings)", () => {
	it("maps a ZodError to an input message naming the field", () => {
		const schema = z.object({ to: z.string() });
		const res = schema.safeParse({});
		expect(res.success).toBe(false);
		if (!res.success) {
			const msg = formatError(res.error);
			expect(msg).toContain("Invalid input");
			expect(msg).toContain("to");
		}
	});

	it("stringifies a plain Error", () => {
		expect(formatError(new Error("boom"))).toBe("boom");
	});

	it("handles non-Error throwables", () => {
		expect(formatError("nope")).toBe("nope");
		expect(formatError(undefined)).toBe("unknown error");
	});
});
