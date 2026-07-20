/**
 * `init` scaffolding — writes the thin `agent/` files that wire rine into an Eve
 * project: the one-line channel re-export, one re-export file per selected tool
 * (Eve discovers tools by filename, so the slug IS the tool name), the skill
 * markdown, and a `.env.example` block. Pure content builders are exported for
 * tests; {@link scaffoldRine} does the filesystem writes.
 */

import {
	existsSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { RINE_SKILL_FILE } from "./skill-content.js";
import { RINE_TOOL_META, type RineToolMeta } from "./tools/registry.js";

const ENV_MARKER = "# rine — @rine-network/eve";
const DEFAULT_INBOUND_PATH = "/rine/v1/inbound";

/** The default-export channel file (`agent/channels/rine.ts`). */
export function channelFileContent(): string {
	return `import { rineChannel } from "@rine-network/eve/channel";\n\n// Inbound rine messages start/resume a session here; replies flow back over rine.\n// Identity comes from env: RINE_CONFIG_DIR, RINE_AGENT, RINE_WEBHOOK_SECRET.\nexport default rineChannel();\n`;
}

/** A single tool's re-export file (`agent/tools/<name>.ts`). */
export function toolFileContent(spec: RineToolMeta): string {
	return `import { ${spec.factoryName} } from "@rine-network/eve/tools";\n\nexport default ${spec.factoryName}();\n`;
}

/** The `.env.example` block (with the inbound path applied). */
export function envExampleBlock(path: string): string {
	return `${ENV_MARKER}
RINE_CONFIG_DIR=
RINE_AGENT=
# RINE_API_URL=https://rine.network
RINE_WEBHOOK_SECRET=
# RINE_WEBHOOK_ID=
# RINE_INBOUND_PATH=${path}
# x402 payments (optional). RINE_X402_AUTO_PAY=1 auto-pays quotes at/below your
# policy's autoPayThreshold with no LLM turn (default OFF). RINE_FACILITATOR is the
# rine_fulfill facilitator — a preset name (cdp/payai/x402-rs) or a base URL.
# RINE_X402_AUTO_PAY=
# RINE_FACILITATOR=
`;
}

/**
 * Resolve a `--tools` selection to the ordered tool specs. Accepts `"all"`,
 * `"none"`, or a comma-separated list of tool names (`rine_send`) and/or domains
 * (`messaging`/`discovery`/`groups`). Unknown tokens throw.
 */
export function resolveToolSelection(value: string | undefined): RineToolMeta[] {
	const v = (value ?? "all").trim();
	if (v === "none") return [];
	if (v === "all") return [...RINE_TOOL_META];
	const tokens = v.split(",").map((t) => t.trim()).filter(Boolean);
	const out: RineToolMeta[] = [];
	for (const spec of RINE_TOOL_META) {
		if (tokens.includes(spec.name) || tokens.includes(spec.domain)) out.push(spec);
	}
	const matchedDomains = new Set(RINE_TOOL_META.map((s) => s.domain));
	const matchedNames = new Set(RINE_TOOL_META.map((s) => s.name));
	for (const tok of tokens) {
		if (!matchedDomains.has(tok as RineToolMeta["domain"]) && !matchedNames.has(tok)) {
			throw new Error(
				`unknown tool/domain '${tok}' (valid: all, none, messaging, discovery, groups, or a rine_* tool name)`,
			);
		}
	}
	return out;
}

export interface ScaffoldOptions {
	/** Project root (default `process.cwd()`). */
	cwd?: string;
	/** Agent directory relative to cwd (default `agent`). */
	dir?: string;
	/** `--tools` selection (default `all`). */
	tools?: string;
	/** Write the channel file (default true). */
	channel?: boolean;
	/** Inbound path baked into the `.env.example` (default `/rine/v1/inbound`). */
	path?: string;
	/** Overwrite existing files (default false → skip + report). */
	force?: boolean;
}

export interface ScaffoldResult {
	readonly written: string[];
	readonly skipped: string[];
}

/** Write `content` to `file`, honoring `force`; record into the result. */
function writeFile(
	file: string,
	content: string,
	force: boolean,
	res: { written: string[]; skipped: string[] },
): void {
	if (existsSync(file) && !force) {
		res.skipped.push(file);
		return;
	}
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, content, "utf-8");
	res.written.push(file);
}

/** Scaffold the rine channel, tools, skill, and `.env.example` block. */
export function scaffoldRine(opts: ScaffoldOptions = {}): ScaffoldResult {
	const cwd = opts.cwd ?? process.cwd();
	const agentDir = join(cwd, opts.dir ?? "agent");
	const path = opts.path ?? DEFAULT_INBOUND_PATH;
	const res = { written: [] as string[], skipped: [] as string[] };
	const force = opts.force ?? false;

	if (opts.channel ?? true) {
		writeFile(
			join(agentDir, "channels", "rine.ts"),
			channelFileContent(),
			force,
			res,
		);
	}

	for (const spec of resolveToolSelection(opts.tools)) {
		writeFile(
			join(agentDir, "tools", `${spec.name}.ts`),
			toolFileContent(spec),
			force,
			res,
		);
	}

	writeFile(
		join(agentDir, "skills", "rine", "SKILL.md"),
		RINE_SKILL_FILE,
		force,
		res,
	);

	// `.env.example` is appended (not overwritten) unless our block is already present.
	const envFile = join(cwd, ".env.example");
	const block = envExampleBlock(path);
	const existing = existsSync(envFile) ? readFileSync(envFile, "utf-8") : "";
	if (!existing.includes(ENV_MARKER)) {
		writeFileSync(
			envFile,
			existing.length > 0 ? `${existing.trimEnd()}\n\n${block}` : block,
			"utf-8",
		);
		res.written.push(envFile);
	} else {
		res.skipped.push(envFile);
	}

	return res;
}
