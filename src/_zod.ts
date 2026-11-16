/**
 * Host-zod re-export + the JSON-Schema bridge for Eve's `defineTool`.
 *
 * Eve's `defineTool` types want a JSON-Schema-bearing schema (`StandardJSONSchemaV1`
 * with a `~standard.jsonSchema` converter) or a plain JSON-Schema object. We hand
 * Eve a real JSON Schema generated from the zod schema with zod's own
 * `z.toJSONSchema` (which also carries every `.describe()` into `description` —
 * the #1 lever on tool-call accuracy) and parse the raw model input with the zod
 * schema inside `execute` (applying defaults + coercion). One source of truth (zod).
 *
 * Every tool's `outputSchema` is `string` — a tool returns clean text, so
 * ciphertext can never ride a struct field.
 */

import { z } from "zod";

export { z };

/**
 * Convert a zod schema to a plain JSON Schema for `defineTool`'s `inputSchema`.
 *
 * `io: "input"` describes what the model sends: a field with a `.default()` is
 * optional there, exactly as the model may omit it. Zod leaves objects open in
 * input mode, so the override closes them again: the tool contract has always
 * told the model not to invent fields. Draft-07 is the dialect it has always
 * carried. Returns `any` deliberately: it bridges into Eve's internal
 * `JsonObject` type, which is not exported for us to name.
 *
 * The result is a plain copy: zod attaches a hidden `~standard` property to it,
 * and the AI SDK under Eve treats any value carrying `~standard` as a validator
 * schema, takes its zod-3 path and fails every model call.
 */
// biome-ignore lint/suspicious/noExplicitAny: deliberate bridge to Eve's JsonObject.
export function jsonSchema(schema: z.ZodType): any {
	const out = z.toJSONSchema(schema, {
		target: "draft-7",
		io: "input",
		override: ({ zodSchema, jsonSchema: node }) => {
			if (zodSchema._zod.def.type === "object") node.additionalProperties = false;
		},
	});
	return JSON.parse(JSON.stringify(out));
}

/** The shared `outputSchema` for every rine tool: a JSON-Schema string. */
// biome-ignore lint/suspicious/noExplicitAny: deliberate bridge to Eve's JsonObject.
export const STRING_OUTPUT: any = { type: "string" };
