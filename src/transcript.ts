/**
 * Token-budgeted, role-tagged transcript rendering for the Eve channel's
 * push-injection. The Eve session is STATELESS per inbound message,
 * so cross-turn memory comes from injecting the recent thread into the session
 * `context[]` on each inbound. This module renders that transcript within a
 * char-approximated token budget, truncating the OLDEST turns first.
 *
 * It reads only `ThreadEntry.text` (already decrypted + rendered by the
 * SDK), never any ciphertext field.
 */

import type { ThreadEntry } from "@rine-network/sdk";
import { renderThreadLine } from "./format.js";

/** char ≈ 4 × tokens — the coarse proxy the spec specifies. */
const CHARS_PER_TOKEN = 4;

/** Marker prepended when older turns were dropped to fit the budget. */
export const OMITTED_MARKER = "[…earlier turns omitted]";

/**
 * Render the most-recent turns of a thread as role-tagged `context[]` lines within
 * a token budget. Turns are accumulated from the NEWEST end backwards until the
 * char budget (`tokenBudget * 4`) is hit; if any older turns were dropped, a single
 * {@link OMITTED_MARKER} line is prepended. Returns lines oldest→newest, ready to
 * slot into the Eve session `context` array.
 *
 * @param entries Thread entries, ordered oldest→newest (SDK `client.thread()`).
 * @param tokenBudget Approximate token budget for the transcript.
 */
export function renderTranscriptContext(
	entries: readonly ThreadEntry[],
	tokenBudget: number,
): string[] {
	const charBudget = Math.max(0, tokenBudget) * CHARS_PER_TOKEN;
	const lines = entries.map(renderThreadLine);

	// Accumulate newest-first until the budget is exhausted.
	const kept: string[] = [];
	let used = 0;
	for (let i = lines.length - 1; i >= 0; i--) {
		const line = lines[i] as string;
		// +1 for the newline that joins this line to the next.
		const cost = line.length + 1;
		if (kept.length > 0 && used + cost > charBudget) break;
		kept.push(line);
		used += cost;
	}
	kept.reverse();

	if (kept.length < lines.length) kept.unshift(OMITTED_MARKER);
	return kept;
}
