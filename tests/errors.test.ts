import type { GroupRead } from "@rine-network/core";
import { matchGroupByName, recipientGroupForBareName } from "@rine-network/core";
import { NotFoundError } from "@rine-network/sdk";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { GROUP_ON_WAIT_MESSAGE, formatError } from "../src/errors.js";
import { RINE_TOOL_META } from "../src/tools/registry.js";

/** One group of the caller's org, so a miss has a roster to hand back. */
const PLANNING = {
	id: "g-1",
	name: "Planning",
	handle: "#planning@acme.rine.network",
	description: null,
	enrollment_policy: "closed",
	visibility: "private",
	isolated: false,
	vote_duration_hours: 48,
	member_count: 1,
	created_at: "2026-01-01T00:00:00Z",
	conversation_id: null,
} as GroupRead;

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

	it("sends a 404 that is not about a group to the agent directory", () => {
		expect(formatError(new NotFoundError("no agent xyz"))).toBe(
			"Not found: no agent xyz. Try rine_discover to find the right handle.",
		);
	});

	// `rine_discover` searches AGENTS, so it can never resolve a group handle.
	//
	// 🔴 Three producers reach `formatError` and only ONE of them is a
	// `NotFoundError`. What this replaced was an `it.each` that fed
	// `new NotFoundError("Group not found: <handle>")` in by hand — an input the
	// product cannot make (the SDK throws a plain `Error` there) — so the case
	// that mattered was asserted on a fabrication while the shipped shape was
	// tested by nothing at all. Each of the three is now driven the way it is
	// really produced.
	it("sends a server group 404 to the group directory", () => {
		expect(formatError(new NotFoundError("Group not found"))).toBe(
			"Not found: Group not found. Try rine_groups to find the right group handle, or rine_discover_groups to search the public directory.",
		);
	});

	// `rine-ts-sdk`'s `resolveGroup` runs before EVERY group send and throws a
	// PLAIN `Error`, so this arm — not the `NotFoundError` one — is what a
	// mistyped handle on `rine_send` actually lands in.
	it("sends the SDK's plain-Error handle 404 to the group directory", () => {
		expect(
			formatError(new Error("Group not found: #ops@acme.rine.network")),
		).toBe(
			"Not found: Group not found: #ops@acme.rine.network. Try rine_groups to find the right group handle, or rine_discover_groups to search the public directory.",
		);
	});

	// Driven by the real producer, never by a hand-typed detail: `client.send`
	// and every group verb resolve a bare reference through `matchGroupByName`,
	// which refuses with the org's own roster inline. A rosterless fixture is
	// what let this arm ship telling a model to run the verb whose output it is
	// printing — the loop this surface removed, inverted.
	it("names only the public directory when the refusal carries the roster", () => {
		let out = "";
		try {
			matchGroupByName([PLANNING], "invoices");
		} catch (err) {
			out = formatError(err);
		}
		expect(out).toBe(
			"Not found: Group not found: invoices. Name one of these groups:\n" +
				"  - #planning@acme.rine.network (Planning)\n" +
				"Try rine_discover_groups to search the public directory.",
		);
		expect(out).not.toContain("rine_groups to find");
	});

	// The empty arm has no roster to read, and `rine_groups` would answer it with
	// an empty list, so it is dropped there too. One line, so the remedy joins
	// with a space rather than a newline.
	// 🔴 The BARE-name miss stopped opening with a group verdict,
	// and the REMEDY must not follow it out of the group half of the directory.
	// `isGroupNotFound` matches the second lead by CONTAINMENT, because its
	// sentence opens with the caller's own spelling — narrow it back to
	// `startsWith` and this refusal drops into `formatError`'s catch-all, which
	// names `rine_discover`: the AGENT directory, which cannot resolve a group
	// handle. That is the regression this test exists to fail on.
	it("a bare name that answers to nothing still names the group directory", () => {
		let out = "";
		try {
			recipientGroupForBareName([PLANNING], "kofi");
		} catch (err) {
			out = formatError(err);
		}
		expect(out).toContain("'kofi' names neither an agent nor a group you can reach.");
		expect(out.endsWith("Try rine_discover_groups to search the public directory.")).toBe(
			true,
		);
		expect(out).not.toContain("Try rine_discover to");
	});

	it("names only the public directory for an org that is in no groups", () => {
		let out = "";
		try {
			matchGroupByName([], "invoices");
		} catch (err) {
			out = formatError(err);
		}
		expect(out).toBe(
			"Not found: Group not found: invoices. This org is in no groups yet. Try rine_discover_groups to search the public directory.",
		);
		expect(out).not.toContain("rine_groups to find");
	});

	// The ORDER is the substance: `rine_discover_groups` reaches only
	// `visibility == "public"` groups, so a member of a PRIVATE group who
	// mistypes the handle needs `rine_groups` — which lists every group the
	// org holds a seat in — named first.
	it("names rine_groups before rine_discover_groups", () => {
		const out = formatError(new NotFoundError("Group not found"));
		expect(out).toContain("rine_groups");
		expect(out).toContain("rine_discover_groups");
		expect(out.indexOf("rine_groups")).toBeLessThan(
			out.indexOf("rine_discover_groups"),
		);
	});

	it("stringifies a plain Error", () => {
		expect(formatError(new Error("boom"))).toBe("boom");
	});

	it("handles non-Error throwables", () => {
		expect(formatError("nope")).toBe("nope");
		expect(formatError(undefined)).toBe("unknown error");
	});
});

describe("GROUP_ON_WAIT_MESSAGE — the verbs it names are this surface's", () => {
	// 🔴 This package asserted the sentence NOWHERE. Its bytes were compared
	// only against `rine-mastra`'s copy, cross-package, by the backend contract
	// gate — which proves the two agree and proves nothing about either agreeing
	// with the tools it actually registers. Renaming a verb here would have kept
	// both copies green while the refusal sent a model to a tool that no longer
	// exists.
	//
	// Derived from `RINE_TOOL_META`, not from the factories: an eve tool
	// descriptor carries no id of its own — the registry is where a name lives
	// on this surface, and it is what the scaffolder and the shipped-surface
	// gate read.
	const nameOf = (factoryName: string) => {
		const meta = RINE_TOOL_META.find((m) => m.factoryName === factoryName);
		if (meta === undefined) throw new Error(`no registry entry: ${factoryName}`);
		return meta.name;
	};

	it("names both verbs by the ids the registry actually ships", () => {
		expect(GROUP_ON_WAIT_MESSAGE).toBe(
			`${nameOf("rineSendAndWaitTool")} is 1:1 only; use ${nameOf("rineSendTool")} for groups.`,
		);
	});
});
