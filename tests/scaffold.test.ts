import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	channelFileContent,
	envExampleBlock,
	resolveToolSelection,
	scaffoldRine,
	toolFileContent,
} from "../src/scaffold.js";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "rine-eve-scaffold-"));
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("resolveToolSelection", () => {
	it("expands all / none", () => {
		expect(resolveToolSelection("all")).toHaveLength(16);
		expect(resolveToolSelection("none")).toHaveLength(0);
		expect(resolveToolSelection(undefined)).toHaveLength(16);
	});
	it("selects by domain and by name", () => {
		expect(resolveToolSelection("messaging").map((t) => t.name)).toContain(
			"rine_send",
		);
		expect(
			resolveToolSelection("payments")
				.map((t) => t.name)
				.sort(),
		).toEqual(["rine_fulfill", "rine_pay"]);
		expect(resolveToolSelection("discovery")).toHaveLength(2);
		const named = resolveToolSelection("rine_send,rine_discover");
		expect(named.map((t) => t.name).sort()).toEqual([
			"rine_discover",
			"rine_send",
		]);
	});
	it("throws on an unknown token", () => {
		expect(() => resolveToolSelection("nope")).toThrow(/unknown/);
	});
});

describe("content builders", () => {
	it("channel file re-exports rineChannel", () => {
		expect(channelFileContent()).toContain('from "@rine-network/eve/channel"');
		expect(channelFileContent()).toContain("export default rineChannel()");
	});
	it("tool file re-exports the right factory", () => {
		const c = toolFileContent({
			name: "rine_send",
			factoryName: "rineSendTool",
			domain: "messaging",
		});
		expect(c).toContain("rineSendTool");
		expect(c).toContain('from "@rine-network/eve/tools"');
	});
	it("env block carries the inbound path", () => {
		expect(envExampleBlock("/x/y")).toContain("RINE_INBOUND_PATH=/x/y");
		expect(envExampleBlock("/x/y")).toContain("RINE_WEBHOOK_SECRET=");
	});
});

describe("scaffoldRine", () => {
	it("writes channel, all tools, skill, and .env.example", () => {
		const res = scaffoldRine({ cwd: dir, tools: "all" });
		expect(existsSync(join(dir, "agent/channels/rine.ts"))).toBe(true);
		expect(existsSync(join(dir, "agent/tools/rine_send.ts"))).toBe(true);
		expect(existsSync(join(dir, "agent/tools/rine_group_inspect.ts"))).toBe(
			true,
		);
		expect(existsSync(join(dir, "agent/skills/rine/SKILL.md"))).toBe(true);
		expect(existsSync(join(dir, ".env.example"))).toBe(true);
		// 1 channel + 16 tools + 1 skill + 1 env
		expect(res.written.length).toBe(19);
		expect(
			readFileSync(join(dir, "agent/skills/rine/SKILL.md"), "utf-8"),
		).toContain("description:");
	});

	it("honors --no-channel and a tool subset", () => {
		const res = scaffoldRine({ cwd: dir, channel: false, tools: "discovery" });
		expect(existsSync(join(dir, "agent/channels/rine.ts"))).toBe(false);
		expect(existsSync(join(dir, "agent/tools/rine_discover.ts"))).toBe(true);
		expect(existsSync(join(dir, "agent/tools/rine_send.ts"))).toBe(false);
		void res;
	});

	it("skips existing files without --force, overwrites with it", () => {
		scaffoldRine({ cwd: dir, tools: "none" });
		const again = scaffoldRine({ cwd: dir, tools: "none" });
		expect(again.skipped).toContain(join(dir, "agent/channels/rine.ts"));
		const forced = scaffoldRine({ cwd: dir, tools: "none", force: true });
		expect(forced.written).toContain(join(dir, "agent/channels/rine.ts"));
	});

	it("does not duplicate the .env.example block on re-run", () => {
		scaffoldRine({ cwd: dir, tools: "none" });
		scaffoldRine({ cwd: dir, tools: "none" });
		const env = readFileSync(join(dir, ".env.example"), "utf-8");
		expect(env.match(/RINE_WEBHOOK_SECRET=/g)?.length).toBe(1);
	});
});
