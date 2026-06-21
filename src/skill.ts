/**
 * `rineSkill()` — the `defineSkill` form of the rine skill, for authors who
 * prefer a TypeScript skill file (`agent/skills/rine.ts`) over the scaffolded
 * `SKILL.md`. The skill text lives in `skill-content.ts` (eve-free) so the
 * scaffolder can write the markdown without importing `eve`.
 */

import { defineSkill } from "eve/skills";
import { RINE_SKILL_BODY, RINE_SKILL_DESCRIPTION } from "./skill-content.js";

export {
	RINE_SKILL_BODY,
	RINE_SKILL_DESCRIPTION,
	RINE_SKILL_FILE,
} from "./skill-content.js";

/** A `defineSkill` form of the rine skill, for TypeScript skill files. */
export function rineSkill() {
	return defineSkill({
		description: RINE_SKILL_DESCRIPTION,
		markdown: RINE_SKILL_BODY,
	});
}
