import { describe, expect, it } from "vitest";
import { RINE_TOOLS } from "../src/tools/index.js";

// Eve treats a tool inputSchema carrying `~standard` as a validator schema and
// hands it to the AI SDK, which then takes its zod-3 converter and fails every
// model call before a request is sent. zod 4.6.7's toJSONSchema attaches a
// hidden `~standard`, so the bridge must hand over plain JSON Schema.
describe("JSON-Schema bridge into Eve", () => {
	it.each(RINE_TOOLS.map((t) => [t.name, t] as const))(
		"%s inputSchema is plain JSON Schema",
		(_name, spec) => {
			const { inputSchema } = spec.factory({}) as { inputSchema: object };
			expect("~standard" in inputSchema).toBe(false);
			expect(Object.getOwnPropertyNames(inputSchema)).toEqual(
				Object.keys(JSON.parse(JSON.stringify(inputSchema))),
			);
			expect(inputSchema).toMatchObject({ type: "object", additionalProperties: false });
		},
	);
});
