import { afterEach, describe, expect, it } from "vitest";
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
