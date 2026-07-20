/**
 * Inbound webhook helpers for the rine channel: extracting the message id from a
 * rine standard-webhook body, and the continuation-token codec.
 *
 * The continuation token is how the channel makes outbound replies STATELESS (R7):
 * it encodes the rine `conversation_id`, the reply target (the group handle for
 * group mail, else the sender handle), and — for 1:1 inbound only — the inbound
 * `message id` so the `message.completed` handler can reply IN-PLACE (via the reply
 * endpoint, preserving the inbound conversation) without any durable per-session map.
 * Because the token bakes in the per-message `m`, it differs on every 1:1 inbound
 * turn, so Eve does NOT resume a prior session from it — cross-turn continuity comes
 * from the general thread primitive (push-injected transcript, Slice E), not session
 * resume. The message id is optional: group inbound and tokens minted by an older
 * build carry only `{c,r}` and decode with `messageId === undefined`, so the outbound
 * handler falls back to the `send()+parentConversationId` broadcast path.
 */

/** Sentinel marking our token payload, robust to Eve's `<channel>:` namespacing. */
const TOKEN_MARKER = "r1.";

/** Bound on the per-runtime `seen` dedupe set before it is cleared wholesale. */
export const SEEN_CAP = 5000;

/**
 * Record a handled message id in the bounded per-runtime dedupe set. The set is
 * cleared wholesale when it reaches {@link SEEN_CAP} (a coarse but allocation-free
 * eviction — the server-side `delivered_at` ack is the durable dedupe). A no-op
 * when no set is provided.
 */
export function rememberSeen(seen: Set<string> | undefined, id: string): void {
	if (!seen) return;
	if (seen.size >= SEEN_CAP) seen.clear();
	seen.add(id);
}

/** What a decoded continuation token yields. */
export interface ReplyContext {
	/** The rine conversation id to thread the reply into. */
	readonly conversationId: string;
	/** Who/where to send the reply: a group handle (`#…`) or a sender handle. */
	readonly replyTarget: string;
	/**
	 * The inbound rine message id, used to reply IN-PLACE via the reply endpoint.
	 * Absent for legacy 2-field tokens → caller falls back to send()+parent.
	 */
	readonly messageId?: string;
	/**
	 * Marks a session started by an inbound x402 payment frame (D1). The terminal
	 * assistant message is NEVER prose-replied into a payment thread — that would
	 * corrupt the handshake. The signed payment / receipt is transmitted in-thread
	 * by the pay / fulfill tools instead, so `processCompletion` short-circuits when
	 * this is set.
	 */
	readonly x402?: boolean;
}

/** base64url (no padding) encode of a UTF-8 string. */
function b64urlEncode(s: string): string {
	return Buffer.from(s, "utf-8").toString("base64url");
}

/** base64url decode to a UTF-8 string (throws on malformed input). */
function b64urlDecode(s: string): string {
	return Buffer.from(s, "base64url").toString("utf-8");
}

/**
 * Encode the raw channel-local continuation token. Eve prepends the channel name
 * (`rine:`); we additionally fence our payload with {@link TOKEN_MARKER} so the
 * decoder can recover it regardless of any prefix the framework adds.
 */
export function encodeReplyToken(
	conversationId: string,
	replyTarget: string,
	messageId?: string,
	opts: { x402?: boolean } = {},
): string {
	const payload: { c: string; r: string; m?: string; x?: 1 } = {
		c: conversationId,
		r: replyTarget,
	};
	// Only emit `m` when present so older decoders stay tolerant and tokens
	// remain minimal for legacy callers.
	if (messageId) payload.m = messageId;
	// The x402 no-prose-reply flag rides as a compact `x:1` when set.
	if (opts.x402) payload.x = 1;
	return `${TOKEN_MARKER}${b64urlEncode(JSON.stringify(payload))}`;
}

/**
 * Decode a continuation token back to its {@link ReplyContext}. Tolerant of a
 * leading `<channel>:` namespace (or any prefix) and of malformed input —
 * returns `null` when the token is not one of ours or fails to parse, so the
 * outbound handler can safely skip rather than throw.
 */
export function decodeReplyToken(token: string | undefined): ReplyContext | null {
	if (!token) return null;
	const idx = token.indexOf(TOKEN_MARKER);
	if (idx < 0) return null;
	try {
		const payload = JSON.parse(b64urlDecode(token.slice(idx + TOKEN_MARKER.length)));
		const conversationId = payload?.c;
		const replyTarget = payload?.r;
		if (typeof conversationId !== "string" || typeof replyTarget !== "string") {
			return null;
		}
		// `m` is optional; legacy 2-field tokens leave messageId undefined.
		const m = payload?.m;
		const messageId = typeof m === "string" && m.length > 0 ? m : undefined;
		const x402 = payload?.x === 1 ? true : undefined;
		return { conversationId, replyTarget, messageId, x402 };
	} catch {
		return null;
	}
}

/**
 * Extract the rine message id from a webhook body. The rine server's standard
 * (`payload_format="rine"`) delivery posts `{ message_id, agent_id, event,
 * timestamp }` (see backend `worker/delivery.py:_build_payload`); the A2A format
 * posts `{ result: { artifactUpdate: { artifact: { artifactId } } } }`. We read
 * `message_id` first, then the A2A artifact id, then tolerate a couple of legacy
 * nesting variants. Returns `undefined` when no id is present (→ 202 ignored).
 */
export function messageIdFromWebhook(body: unknown): string | undefined {
	if (!body || typeof body !== "object") return undefined;
	const b = body as Record<string, unknown>;
	const a2aArtifactId = (
		(b.result as { artifactUpdate?: { artifact?: { artifactId?: unknown } } } | undefined)
			?.artifactUpdate?.artifact?.artifactId
	);
	const fromMessage = (b.message as { id?: unknown } | undefined)?.id;
	const fromData = (b.data as { id?: unknown } | undefined)?.id;
	const id = b.message_id ?? a2aArtifactId ?? fromMessage ?? fromData ?? b.id;
	return typeof id === "string" && id.length > 0 ? id : undefined;
}
