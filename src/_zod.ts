/**
 * Host-zod re-export + the JSON-Schema bridge for Eve's `defineTool`.
 *
 * Eve's `defineTool` types want a JSON-Schema-bearing schema (`StandardJSONSchemaV1`
 * with a `~standard.jsonSchema` converter) or a plain JSON-Schema object. Zod 3.25
 * implements Standard Schema's `~standard.validate` but not the JSON-Schema
 * converter, so we hand Eve a real JSON Schema generated from the zod schema (which
 * also carries every `.describe()` into `description` — the #1 lever on tool-call
 * accuracy) and parse the raw model input with the zod schema inside `execute`
 * (applying defaults + coercion). One source of truth (zod), version-independent.
 *
 * Every tool's `outputSchema` is `string` (R4) — a tool returns clean text, so
 * ciphertext can never ride a struct field.
 */

import { z, type ZodTypeAny } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

export { z };

/**
 * Convert a zod schema to a plain JSON Schema for `defineTool`'s `inputSchema`.
 * Returns `any` deliberately: it bridges into Eve's internal `JsonObject` type,
 * which is not exported for us to name.
 */
// biome-ignore lint/suspicious/noExplicitAny: deliberate bridge to Eve's JsonObject.
export function jsonSchema(schema: ZodTypeAny): any {
	return zodToJsonSchema(schema, { $refStrategy: "none" });
}

/** The shared `outputSchema` for every rine tool: a JSON-Schema string. */
// biome-ignore lint/suspicious/noExplicitAny: deliberate bridge to Eve's JsonObject.
export const STRING_OUTPUT: any = { type: "string" };
