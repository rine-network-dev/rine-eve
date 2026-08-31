/**
 * `npx @rine-network/eve onboard` — the verification words it prints.
 *
 * The words come from the signing key in the config dir, not from the
 * string the server returned with the agent. A fixture that echoed the server's
 * own answer back would pass whatever this surface did with it, so the expected
 * string is derived from real key material written to a real temp dir.
 *
 * The PoW/register boundary is mocked at the `@rine-network/sdk` module edge so
 * the test never runs a ~30–60 s proof-of-work.
 */

import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	generateAgentKeys,
	saveAgentKeys,
	verificationWordsForKey,
} from "@rine-network/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const register = vi.fn();
const createAgent = vi.fn();

vi.mock("@rine-network/sdk", () => ({
	register,
	AsyncRineClient: class {
		createAgent = createAgent;
	},
}));

const { runOnboard } = await import("../src/onboard.js");

const AGENT_ID = "11111111-2222-3333-4444-555555555555";
const OTHER_WORDS = "abandon ability able about above";

let configDir: string;
let ownWords: string;

function makeIO(): { io: { log: (l: string) => void }; lines: string[] } {
	const lines: string[] = [];
	return { io: { log: (l: string) => lines.push(l) }, lines };
}

async function onboard(): Promise<string[]> {
	const { io, lines } = makeIO();
	await runOnboard(
		{ email: "a@b.co", slug: "acme", name: "Support", configDir },
		io,
	);
	return lines;
}

beforeEach(() => {
	configDir = fs.mkdtempSync(join(tmpdir(), "rine-eve-onboard-"));
	const keys = generateAgentKeys();
	saveAgentKeys(configDir, AGENT_ID, keys);
	ownWords = verificationWordsForKey(keys.signing.publicKey);

	register.mockReset();
	createAgent.mockReset();
	register.mockResolvedValue({ orgId: "org-1", clientId: "cid-1" });
	createAgent.mockResolvedValue({
		id: AGENT_ID,
		handle: "support@acme.rine.network",
		name: "Support",
		verification_words: ownWords,
	});
});

afterEach(() => {
	vi.clearAllMocks();
	fs.rmSync(configDir, { recursive: true, force: true });
});

describe("runOnboard — verification words", () => {
	it("prints the words this config dir's signing key derives", async () => {
		const out = (await onboard()).join("\n");
		expect(out).toContain("Agent ready: support@acme.rine.network");
		expect(out).toContain(`Verification words: ${ownWords}`);
	});

	it("renders BOTH values when the server asserts different words", async () => {
		createAgent.mockResolvedValue({
			id: AGENT_ID,
			handle: "support@acme.rine.network",
			name: "Support",
			verification_words: OTHER_WORDS,
		});
		const out = (await onboard()).join("\n");
		expect(out).toContain(`Verification words (this client): ${ownWords}`);
		expect(out).toContain(OTHER_WORDS);
		expect(out).toContain("Messages still send and arrive");
	});

	it("says so rather than echoing the server's string when it holds no key", async () => {
		createAgent.mockResolvedValue({
			id: "99999999-9999-9999-9999-999999999999",
			handle: "support@acme.rine.network",
			name: "Support",
			verification_words: OTHER_WORDS,
		});
		const out = (await onboard()).join("\n");
		expect(out).toContain(`Verification words (server): ${OTHER_WORDS}`);
		expect(out).toContain("Not recomputed here");
	});

	it("still prints its own words when the server names none", async () => {
		createAgent.mockResolvedValue({
			id: AGENT_ID,
			handle: "support@acme.rine.network",
			name: "Support",
			verification_words: null,
		});
		const out = (await onboard()).join("\n");
		expect(out).toContain(`Verification words: ${ownWords}`);
		expect(out).toContain("nothing to compare");
	});
});
