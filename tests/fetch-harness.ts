/**
 * A routed `fetch` for the group suites — the one place eve's tests see real
 * request/response shapes.
 *
 * 🔴 **Why this exists.** Every other suite in this package fakes the
 * `AsyncRineClient` object, which is fine for asserting what a tool RENDERS and
 * useless for asserting what it FETCHES: a fake answers whatever the code asks
 * it for, so a call site that pays two group reads where the contract promises
 * one, or hands a verb an id where the contract hands it the record, reads
 * exactly like one that does not. Every group reference on this surface now
 * routes through the SDK's `groups.resolveRef`, and what had to be proven about
 * that move is a REQUEST COUNT. Only a fetch-level harness can count requests.
 *
 * The client under test is a real `AsyncRineClient` built by this package's own
 * `getRineClient`; only one seam is stubbed, in the test file (vitest hoists
 * `vi.mock`): `getOrRefreshToken`, so the client authenticates without key
 * material on disk. Everything below the
 * token — the SDK's HTTP layer, `rine-core`'s resolve ladder, every path
 * literal and every Zod parse — is the shipped code.
 *
 * An unrouted path throws a STATUSLESS `Error` (the shape `rine-mcp`'s
 * `test/tools/group-routes.ts` settled on): a 404 is a refusal the resolver is
 * entitled to swallow into "no such group", so defaulting to one would hide the
 * missing route instead of naming it.
 */

/** One recorded outbound request, in the order it was made. */
export interface RecordedRequest {
	method: string;
	path: string;
}

/** What a route may answer with: a JSON body, or a refusal to make. */
export type RouteAnswer = unknown | Error | { status: number; detail: string };

function isRefusal(v: unknown): v is { status: number; detail: string } {
	return (
		typeof v === "object" &&
		v !== null &&
		"status" in v &&
		typeof (v as { status: unknown }).status === "number"
	);
}

/**
 * Build a `fetch` that answers by `"<METHOD> <path>"` and records every call.
 *
 * Routes are matched on the path alone after the api URL is stripped, query
 * string included — so a test can pin `GET /groups?limit=100` when the query is
 * the point and `GET /groups` when it is not (the longer key is tried first).
 */
export function routedFetch(
	apiUrl: string,
	routes: Record<string, RouteAnswer>,
): { fetch: typeof globalThis.fetch; requests: RecordedRequest[] } {
	const requests: RecordedRequest[] = [];
	const fetchImpl = async (input: unknown, init?: { method?: string }) => {
		const url = String(
			typeof input === "string" ? input : (input as { url: string }).url,
		);
		const path = url.startsWith(apiUrl) ? url.slice(apiUrl.length) : url;
		const method = (init?.method ?? "GET").toUpperCase();
		requests.push({ method, path });
		const bare = barePath(path);
		const answer =
			`${method} ${path}` in routes
				? routes[`${method} ${path}`]
				: `${method} ${bare}` in routes
					? routes[`${method} ${bare}`]
					: new Error(
							`routedFetch: no route for \`${method} ${path}\` and no fallback was named`,
						);
		if (answer instanceof Error) throw answer;
		if (isRefusal(answer)) {
			return jsonResponse({ detail: answer.detail }, answer.status);
		}
		return jsonResponse(
			method === "GET" && bare === "/groups"
				? applyHandleFilter(path, answer)
				: answer,
			200,
		);
	};
	return { fetch: fetchImpl as unknown as typeof globalThis.fetch, requests };
}

/** The path with any query string removed — routes and counts key on this. */
export function barePath(path: string): string {
	return path.split("?")[0] ?? path;
}

/**
 * The server's own `?handle=` filter, applied to EVERY `GET /groups` answer.
 *
 * 🔴 The full-handle rung now lives on the server's own
 * `GET /groups?handle=` lookup, so a route that answers the same page to every
 * query hands the resolver the first row whatever was asked:
 * `resolveRef("#nope@acme")` then resolves to somebody else's group and the
 * test passes on a group it never named. Central here so no route can forget
 * it — the twin lives in `rine-mastra/tests/harness.ts`.
 */
function applyHandleFilter(path: string, answer: unknown): unknown {
	const wanted = new URLSearchParams(path.split("?")[1] ?? "").get("handle");
	const page = answer as { items?: unknown[] } | null;
	if (wanted === null || !Array.isArray(page?.items)) return answer;
	return {
		...page,
		items: page.items.filter(
			(g) => (g as { handle?: string }).handle === wanted,
		),
	};
}

function jsonResponse(body: unknown, status: number): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

/** The group rows the server answers with, as `GroupReadSchema` wants them. */
export function groupRowFixture(over: Record<string, unknown> = {}) {
	return {
		id: "11111111-1111-1111-1111-111111111111",
		name: "Ops",
		handle: "#ops@acme",
		description: null,
		visibility: "private",
		enrollment_policy: "closed",
		member_count: 3,
		mls_enabled: true,
		mls_group_id: "mls-1",
		created_at: "2026-08-03T00:00:00Z",
		...over,
	};
}

/** How many times the group's own row was read — the count the fold keeps flat. */
export function groupReads(
	requests: readonly RecordedRequest[],
	groupId: string,
): number {
	// 🔴 Compare the path BEFORE its query string: `routedFetch` deliberately
	// keeps the query on `path`, so an exact match silently stops counting the
	// day `list()` grows a `?limit=` or a `?cursor=` — and under-counting is the
	// one way this number can lie about a fold that did not happen.
	return requests.filter((r) => {
		const bare = barePath(r.path);
		return (
			r.method === "GET" &&
			(bare === `/groups/${groupId}` || bare === "/groups")
		);
	}).length;
}
