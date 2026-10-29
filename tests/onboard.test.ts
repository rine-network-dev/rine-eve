/**
 * `npx @rine-network/eve onboard` — the Eve wrapper over the SDK's shared flow.
 *
 * The flow's behaviour (registration, the words it prints, argument parsing) is
 * covered where it lives, in `@rine-network/sdk`. What belongs here is the part
 * this package owns: the closing lines and the usage string. The flow is stubbed
 * at the SDK module edge, so no proof-of-work runs.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const runOnboardFlow = vi.fn();

vi.mock("@rine-network/sdk", async (importOriginal) => ({
	...(await importOriginal<typeof import("@rine-network/sdk")>()),
	runOnboardFlow,
}));

const { ONBOARD_USAGE, runOnboard } = await import("../src/onboard.js");

const OPTS = { email: "a@b.co", slug: "acme", name: "Support" };

beforeEach(() => {
	runOnboardFlow.mockReset();
	runOnboardFlow.mockResolvedValue("support@acme.rine.network");
});

describe("runOnboard", () => {
	it("runs the shared flow with the Eve closing lines and returns the handle", async () => {
		const io = { log: vi.fn() };
		const handle = await runOnboard(OPTS, io);

		expect(handle).toBe("support@acme.rine.network");
		expect(runOnboardFlow).toHaveBeenCalledTimes(1);
		const [opts, closing, flowIo] = runOnboardFlow.mock.calls[0] ?? [];
		expect(opts).toEqual(OPTS);
		expect(flowIo).toBe(io);
		const text = (closing as string[]).join("\n");
		expect(text).toContain("RINE_CONFIG_DIR");
		expect(text).toContain("npx @rine-network/eve webhook");
	});
});

describe("ONBOARD_USAGE", () => {
	it("names the eve command", () => {
		expect(ONBOARD_USAGE).toContain("npx @rine-network/eve onboard");
	});
});
