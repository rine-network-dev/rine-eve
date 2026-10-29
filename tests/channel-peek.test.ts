/**
 * The inbound read PEEKS, so nothing is consumed by looking at it.
 *
 * Two levels, deliberately, because neither can make the other's claim:
 *
 *   1. **At the wire.** A real `AsyncRineClient` over a header-recording `fetch`,
 *      proving the `GET /messages/{id}` this connector issues actually carries
 *      `X-Rine-Peek: 1` — spelled with `rine-core`'s own constant, never a literal
 *      retyped here — and that no `mark-delivered` request follows a refusal. A
 *      misspelled or dropped header is the one failure on this path with no
 *      symptom: the server answers an ordinary `200` and consumes every row the
 *      connector believed it was deferring.
 *   2. **At the `InboundDeps` boundary.** Which exits ack and which deliberately do
 *      not. Only the fake client can drive a READABLE message (a wire-level read
 *      cannot open an envelope without real key material on disk), and "a readable
 *      one still gets consumed" is half of what this change has to guarantee.
 *
 * 🔴 The un-acked arm also must NOT `rememberSeen`. `seen` short-circuits to a
 * `200` at the head of `processInbound`, which the rine webhook worker reads as
 * delivered — so remembering an undecryptable id would cancel the very retry the
 * peek exists to preserve. Eve keeps no set-aside store (it is stateless per
 * inbound message), so that worker-side bounded retry is the ONLY retry there is.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Hoisted above the imports below: the client authenticates without key material
// on disk, and nothing else about `@rine-network/core` is faked — the acting-agent
// header, the peek header's spelling and the HTTP layer are the shipped ones.
vi.mock("@rine-network/core", async () => {
	const actual =
		await vi.importActual<typeof import("@rine-network/core")>(
			"@rine-network/core",
		);
	return {
		...actual,
		getOrRefreshToken: vi.fn(async () => "stub-token"),
	};
});

import { ACTING_AGENT_HEADER, PEEK_HEADER } from "@rine-network/core";
import { X402_MESSAGE_TYPE } from "@rine-network/sdk";
// Imported from the module under test rather than the `channel.js` barrel, which
// re-exports the pipeline but not `ackDelivery`. Taken from `channel-core.js`
// (which re-exports it) rather than from `inbound.js` where it now lives, so this
// file loads the modules in the order a consumer does — `channel-core` first,
// pulling in `x402.js` and the leaf behind both.
import {
	ackDelivery,
	type InboundDeps,
	processInbound,
} from "../src/channel-core.js";
import { _resetClientCache, getRineClient } from "../src/client.js";
import { signRineBody } from "../src/hmac.js";
import { fakeClient, makeMsg } from "./helpers.js";

const SECRET = "whsec";
const API = "https://api.test";
const MSG_ID = "11111111-1111-1111-1111-111111111111";
const SELF_ID = "22222222-2222-4222-8222-222222222222";

/** The exact body the rine server posts (`worker/delivery.py::_build_payload`). */
const serverBody = () =>
	Buffer.from(
		JSON.stringify({
			message_id: MSG_ID,
			agent_id: "33333333-3333-3333-3333-333333333333",
			event: "message.received",
			timestamp: "2026-09-11T00:00:00Z",
		}),
	);

function recSend(): {
	calls: unknown[];
	send: InboundDeps["send"];
} {
	const calls: unknown[] = [];
	return {
		calls,
		send: async (input, opts) => {
			calls.push({ input, opts });
			return { id: "s" };
		},
	};
}

function mkDeps(
	over: Partial<InboundDeps> & {
		client: InboundDeps["client"];
		send: InboundDeps["send"];
	},
): InboundDeps {
	const raw = over.raw ?? serverBody();
	return {
		raw,
		signature: over.signature ?? signRineBody(raw, SECRET),
		secret: SECRET,
		acceptUnverified: false,
		maxBodyBytes: 512 * 1024,
		ignoreTypes: ["rine.v1.task_response", "rine.v1.error"],
		...over,
	};
}

// ---------------------------------------------------------------------------
// 1. At the wire
// ---------------------------------------------------------------------------

/** One recorded outbound request, headers included — the point of this harness. */
interface WireRequest {
	method: string;
	path: string;
	headers: Headers;
}

/**
 * A `fetch` that records method, path AND headers.
 *
 * `tests/fetch-harness.ts` already routes requests for the group suites but
 * records only method + path, and a header is exactly what has to be proven here.
 * An unrouted path throws a statusless `Error` so a missing route is named rather
 * than swallowed into a refusal the code is entitled to handle.
 */
function wireFetch(routes: Record<string, unknown>): {
	fetch: typeof globalThis.fetch;
	requests: WireRequest[];
} {
	const requests: WireRequest[] = [];
	const impl = async (
		input: unknown,
		init?: { method?: string; headers?: Record<string, string> },
	) => {
		const url = String(
			typeof input === "string" ? input : (input as { url: string }).url,
		);
		const path = url.startsWith(API) ? url.slice(API.length) : url;
		const method = (init?.method ?? "GET").toUpperCase();
		requests.push({ method, path, headers: new Headers(init?.headers ?? {}) });
		const key = `${method} ${path.split("?")[0]}`;
		if (!(key in routes)) {
			throw new Error(`wireFetch: no route for \`${key}\``);
		}
		return new Response(JSON.stringify(routes[key]), {
			status: 200,
			headers: { "content-type": "application/json" },
		});
	};
	return { fetch: impl as unknown as typeof globalThis.fetch, requests };
}

const SELF_AGENT_PAGE = {
	items: [
		{
			id: SELF_ID,
			name: "eve",
			handle: "eve@acme",
			created_at: "2026-01-01T00:00:00.000Z",
		},
	],
	next_cursor: null,
};

/**
 * The row `GET /messages/{id}` answers with.
 *
 * `encryption_version` is deliberately one the SDK cannot dispatch, which is the
 * only way to reach a `decrypt_error` at the wire without key material: the
 * decrypt short-circuits before any further request, so the recorded request list
 * is exactly what `processInbound` itself asked for.
 */
const unreadableRow = {
	id: MSG_ID,
	conversation_id: "44444444-4444-4444-4444-444444444444",
	from_agent_id: "33333333-3333-3333-3333-333333333333",
	sender_handle: "alice@acme",
	type: "rine.v1.task_request",
	encrypted_payload: "ZmFrZQ==",
	encryption_version: "sealed-with-a-key-this-agent-does-not-have",
	content_type: "application/json",
	metadata: {},
	created_at: "2026-09-11T00:00:00Z",
	group_id: null,
	group_handle: null,
};

/**
 * A group row under a sender key this host has never ingested — the REALISTIC
 * transient, and the reason it is built byte by byte here.
 *
 * `unreadableRow` above reaches a `decrypt_error` by naming an
 * `encryption_version` the SDK cannot dispatch, which no server can return. This
 * one is a wire-shaped `sender-key-v1` envelope: version byte `0x02`, the 16-byte
 * sender-key UUID, a big-endian message index, a nonce, then ciphertext
 * (`rine-core/src/crypto/sender-keys.ts::sealGroup`). Core reads the id back off
 * it, finds no state for it and throws its `unknown sender key id:` control
 * string — which is what drives the SDK's one-shot recovery, and therefore the
 * only fixture that can measure what a reader is told when that recovery finds
 * nothing.
 */
function sealedGroupPayload(senderKeyId: string): string {
	const bytes = new Uint8Array(1 + 16 + 4 + 12 + 16);
	bytes[0] = 0x02;
	bytes.set(Buffer.from(senderKeyId.replace(/-/g, ""), "hex"), 1);
	// index 0, an all-zero nonce and 16 bytes of "ciphertext": never reached,
	// because the missing key is decided before any AEAD open.
	return Buffer.from(bytes).toString("base64");
}

const GROUP_ID = "55555555-5555-4555-8555-555555555555";
const SENDER_KEY_ID = "66666666-6666-4666-8666-666666666666";

const sealedGroupRow = {
	id: MSG_ID,
	conversation_id: "44444444-4444-4444-4444-444444444444",
	from_agent_id: "33333333-3333-3333-3333-333333333333",
	sender_handle: "alice@acme",
	type: "rine.v1.task_request",
	encrypted_payload: sealedGroupPayload(SENDER_KEY_ID),
	encryption_version: "sender-key-v1",
	content_type: "application/json",
	metadata: {},
	created_at: "2026-09-11T00:00:00Z",
	group_id: GROUP_ID,
	group_handle: "#team@acme",
};

function wireHarness(routes: Record<string, unknown>, configDir?: string) {
	const { fetch, requests } = wireFetch(routes);
	vi.stubGlobal("fetch", fetch);
	_resetClientCache();
	const client = getRineClient({
		configDir: configDir ?? "/tmp/eve-peek-test",
		apiUrl: API,
	});
	return { client, requests };
}

const marked = (requests: readonly WireRequest[]) =>
	requests.filter((q) => q.path.includes("mark-delivered"));

/** Config dirs the sender-key case writes into; removed after each test. */
const tmpDirs: string[] = [];

beforeEach(() => _resetClientCache());
afterEach(() => {
	vi.unstubAllGlobals();
	_resetClientCache();
	for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("the inbound read, at the wire", () => {
	it("test_read_when_the_connector_fetches_a_message_then_it_sends_the_peek_header", async () => {
		const { client, requests } = wireHarness({
			[`GET /messages/${MSG_ID}`]: unreadableRow,
			"GET /agents": SELF_AGENT_PAGE,
		});
		const r = recSend();
		await processInbound(mkDeps({ client, send: r.send }));

		const read = requests.find(
			(q) => q.method === "GET" && q.path === `/messages/${MSG_ID}`,
		);
		expect(read).toBeDefined();
		expect(read?.headers.get(PEEK_HEADER)).toBe("1");
		// Peek changes what the read DOES, never who it is AS: the acting agent is
		// still named and still resolved, so the server marks nothing but decrypts
		// against the same agent's delivery row as before.
		expect(read?.headers.get(ACTING_AGENT_HEADER)).toBe(SELF_ID);
	});

	it("test_read_when_the_message_is_undecryptable_then_no_mark_delivered_request_is_made", async () => {
		const { client, requests } = wireHarness({
			[`GET /messages/${MSG_ID}`]: unreadableRow,
			"GET /agents": SELF_AGENT_PAGE,
		});
		const r = recSend();
		const res = await processInbound(mkDeps({ client, send: r.send }));

		expect(res.status).toBe(422);
		// Nothing on the wire consumed the row — neither the read (it peeked) nor a
		// follow-up ack. This is the whole of peek-then-decide, measured at the
		// transport.
		expect(marked(requests)).toHaveLength(0);
		expect(r.calls).toHaveLength(0);
	});

	// 🔴 The status this arm answers was ASSUMED until this test: every other
	// unreadable fixture in this file reaches `decrypt_error` through either a
	// version no server can emit or a fake client, and whether the REAL SDK
	// reports a missing sender key as `decrypt_error` (→ 422) or throws (→ 503)
	// decides what a webhook caller does next — 5xx is retried, 4xx is not.
	// Measured here against the shipped SDK, with the recovery running and
	// finding nothing.
	it("test_group_row_when_the_sender_key_never_arrives_then_422_and_nothing_is_consumed", async () => {
		const dir = mkdtempSync(join(tmpdir(), "eve-peek-sk-"));
		tmpDirs.push(dir);
		const { client, requests } = wireHarness(
			{
				[`GET /messages/${MSG_ID}`]: sealedGroupRow,
				"GET /agents": SELF_AGENT_PAGE,
				// The one-shot recovery's own lookup: this agent's inbox, scanned for
				// a pending sender-key distribution. Empty — nobody has sent one — so
				// the retry re-decrypts and fails for the same reason as the first try.
				[`GET /agents/${SELF_ID}/messages`]: { items: [], next_cursor: null },
			},
			dir,
		);
		const r = recSend();
		const res = await processInbound(mkDeps({ client, send: r.send }));

		expect(res.status).toBe(422);
		// Named, because two arms answer 422 and only one of them leaves the row
		// alone: this is the `decrypt_error` arm, not the acked unverified-sender one.
		expect(await res.text()).toBe("undecryptable");
		expect(marked(requests)).toHaveLength(0);
		expect(r.calls).toHaveLength(0);
		// The recovery really did look, which is what makes "the key is not coming"
		// an earned answer rather than a first-attempt miss.
		expect(
			requests.some(
				(q) => q.method === "GET" && q.path.startsWith(`/agents/${SELF_ID}/messages`),
			),
		).toBe(true);
		// And the read that started it all still peeked.
		const read = requests.find(
			(q) => q.method === "GET" && q.path === `/messages/${MSG_ID}`,
		);
		expect(read?.headers.get(PEEK_HEADER)).toBe("1");
	});

	it("test_ack_delivery_when_called_then_it_posts_mark_delivered_for_that_id", async () => {
		// The other half at the wire: the ack the pipeline now owns really does
		// consume. Without this, "no mark-delivered request" above would also pass
		// against an `ackDelivery` that did nothing at all.
		const { client, requests } = wireHarness({
			"GET /agents": SELF_AGENT_PAGE,
			[`POST /agents/${SELF_ID}/messages/mark-delivered`]: { marked: 1 },
		});
		await ackDelivery({ client }, MSG_ID);

		expect(marked(requests).map((q) => q.method)).toEqual(["POST"]);
		expect(marked(requests)[0]?.path).toBe(
			`/agents/${SELF_ID}/messages/mark-delivered`,
		);
	});
});

// ---------------------------------------------------------------------------
// 2. At the InboundDeps boundary — which exits consume, and which do not
// ---------------------------------------------------------------------------

describe("which inbound exits consume the row", () => {
	it("test_read_when_the_pipeline_calls_it_then_peek_is_requested", async () => {
		let readOpts: unknown = "never called";
		const { client } = fakeClient({
			read: async (_id: unknown, opts: unknown) => {
				readOpts = opts;
				return makeMsg({ verified: true });
			},
		});
		const r = recSend();
		await processInbound(mkDeps({ client, send: r.send }));
		expect(readOpts).toEqual({ peek: true });
	});

	it("test_undecryptable_when_read_then_the_row_is_left_unconsumed_and_unremembered", async () => {
		const seen = new Set<string>();
		const { client, delivered } = fakeClient({
			// biome-ignore lint/suspicious/noExplicitAny: fixture
			read: async () => makeMsg({ decrypt_error: "no sender key yet" } as any),
		});
		const r = recSend();
		const res = await processInbound(mkDeps({ client, send: r.send, seen }));

		expect(res.status).toBe(422);
		expect(delivered).toEqual([]);
		// 🔴 Not remembered either: `seen` would make the next webhook attempt answer
		// `200 duplicate` without re-reading, which is the worker's bounded retry
		// cancelled by the connector that asked for it.
		expect(seen.has(MSG_ID)).toBe(false);
	});

	it("test_a_readable_message_when_dispatched_then_the_row_is_consumed", async () => {
		const { client, delivered } = fakeClient({
			read: async () => makeMsg({ verified: true }),
		});
		const r = recSend();
		const res = await processInbound(mkDeps({ client, send: r.send }));

		expect(res.status).toBe(200);
		expect(delivered).toEqual([[MSG_ID]]);
		expect(r.calls).toHaveLength(1);
	});

	it("test_a_failed_read_when_it_throws_then_nothing_is_consumed_and_the_retry_is_real", async () => {
		const seen = new Set<string>();
		const { client, delivered } = fakeClient({
			read: async () => {
				throw new Error("network");
			},
		});
		const r = recSend();
		const res = await processInbound(mkDeps({ client, send: r.send, seen }));

		expect(res.status).toBe(503);
		expect(delivered).toEqual([]);
		expect(seen.has(MSG_ID)).toBe(false);
	});

	it("test_an_unverified_signature_when_refused_then_the_row_is_still_consumed", async () => {
		// Unchanged from before the peek. `invalid` / `sender-mismatch` are
		// properties of the bytes, so no attempt can reach a different verdict, and
		// leaving them `new` would pin them at the head of the inbox forever.
		const { client, delivered } = fakeClient({
			read: async () =>
				// biome-ignore lint/suspicious/noExplicitAny: fixture
				makeMsg({ verified: false, verification_status: "invalid" } as any),
		});
		const r = recSend();
		const res = await processInbound(mkDeps({ client, send: r.send }));

		expect(res.status).toBe(422);
		expect(delivered).toEqual([[MSG_ID]]);
	});

	it("test_an_unverifiable_signature_when_the_key_lookup_missed_then_nothing_is_consumed", async () => {
		// 🔴 The counterpart to the test above, and the pair is the whole point:
		// these two fixtures differ ONLY in `verification_status`, and they must
		// differ in whether the row survives. `unverifiable` is not a refusal — it
		// is the absence of a verdict, because the sender's signing key could not be
		// fetched at that moment — so it heals on its own and acking it throws a
		// genuine message away. `invalid` above can never heal and is still acked.
		const { client, delivered } = fakeClient({
			read: async () =>
				// biome-ignore lint/suspicious/noExplicitAny: fixture
				makeMsg({ verified: false, verification_status: "unverifiable" } as any),
		});
		const r = recSend();
		const res = await processInbound(mkDeps({ client, send: r.send }));

		expect(res.status).toBe(422);
		// Named, for the reason the sender-key test above names its own body: three
		// arms answer 422 and the status alone cannot tell which one ran.
		expect(await res.text()).toBe("sender signature unverifiable");
		expect(delivered).toEqual([]);
		expect(r.calls).toHaveLength(0);
	});

	it("test_the_loop_guard_when_it_ignores_our_own_reply_type_then_the_row_is_still_consumed", async () => {
		const { client, delivered } = fakeClient({
			read: async () =>
				makeMsg({ verified: true, type: "rine.v1.task_response" }),
		});
		const r = recSend();
		const res = await processInbound(mkDeps({ client, send: r.send }));

		expect(res.status).toBe(202);
		expect(delivered).toEqual([[MSG_ID]]);
		expect(r.calls).toHaveLength(0);
	});

	it("test_a_message_with_no_reply_target_when_refused_then_the_row_is_still_consumed", async () => {
		const { client, delivered } = fakeClient({
			read: async () =>
				makeMsg({ verified: true, sender_handle: null, group_handle: null }),
		});
		const r = recSend();
		const res = await processInbound(mkDeps({ client, send: r.send }));

		expect(res.status).toBe(422);
		expect(delivered).toEqual([[MSG_ID]]);
	});

	it("test_an_x402_frame_when_surfaced_then_the_row_is_still_consumed", async () => {
		const { client, delivered } = fakeClient({
			read: async () =>
				makeMsg({ verified: true, type: X402_MESSAGE_TYPE.RECEIPT }),
		});
		const r = recSend();
		const res = await processInbound(mkDeps({ client, send: r.send }));

		expect(res.status).toBe(200);
		expect(delivered).toEqual([[MSG_ID]]);
	});

	it("test_a_failed_ack_when_it_rejects_then_the_delivery_survives_and_the_failure_is_warned", async () => {
		// The ack is the ONLY consumer now, so a swallowed rejection means the model
		// answers the same message twice on a later attempt. It stays best-effort —
		// the turn is never blocked on it — but it is no longer silent.
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const { client } = fakeClient({
			read: async () => makeMsg({ verified: true }),
			markDelivered: async () => {
				throw new Error("503 from the server");
			},
		});
		const r = recSend();
		const res = await processInbound(mkDeps({ client, send: r.send }));

		expect(res.status).toBe(200);
		expect(r.calls).toHaveLength(1);
		const said = warn.mock.calls.flat().join(" ");
		expect(said).toContain(MSG_ID);
		expect(said).toContain("503 from the server");
		warn.mockRestore();
	});
});
