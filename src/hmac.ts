import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Verify a rine standard-webhook signature: `X-Rine-Signature: sha256=<hex>`,
 * where hex = HMAC-SHA256(rawBody, secret). Constant-time compare.
 *
 * This is the TRANSPORT-auth check (the POST genuinely came from rine and was not
 * tampered). It is independent of the per-message Ed25519 sender signature, which
 * the channel verifies separately after decryption (`DecryptedMessage.verified`).
 */
export function verifyRineSignature(
	rawBody: Buffer | string,
	header: string | undefined,
	secret: string,
): boolean {
	if (!header || !secret) return false;
	const expectedHex = createHmac("sha256", secret)
		.update(typeof rawBody === "string" ? Buffer.from(rawBody) : rawBody)
		.digest("hex");
	const expected = `sha256=${expectedHex}`;
	const a = Buffer.from(expected);
	const b = Buffer.from(header);
	if (a.length !== b.length) return false;
	return timingSafeEqual(a, b);
}

/** Sign a raw body the way the rine server (and the dev relay) do. */
export function signRineBody(rawBody: Buffer | string, secret: string): string {
	const hex = createHmac("sha256", secret)
		.update(typeof rawBody === "string" ? Buffer.from(rawBody) : rawBody)
		.digest("hex");
	return `sha256=${hex}`;
}
