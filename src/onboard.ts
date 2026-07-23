/**
 * Setup helper — `npx @rine-network/eve onboard` (out-of-band, NEVER a tool).
 *
 * Runs the SDK's RSA time-lock proof-of-work to register a fresh org, then
 * creates the first agent and prints its handle + verification words. A ~30–60 s
 * PoW does not belong in an LLM turn; it is a one-time CLI a human runs.
 *
 * No client is built at module load — `runOnboard` constructs the client
 * lazily. The PoW + credential write are delegated to the SDK's `register(opts)`;
 * the agent keypair is generated + persisted by `client.createAgent(name)`.
 */

import { resolveApiUrl, resolveConfigDir } from "@rine-network/core";
import { AsyncRineClient, register } from "@rine-network/sdk";

/** Options for {@link runOnboard}. */
export interface OnboardOptions {
	email: string;
	slug: string;
	name: string;
	apiUrl?: string;
	configDir?: string;
	agentName?: string;
}

/**
 * Derive a server-valid agent name (handle local-part: 1–200 lowercase alnum +
 * interior hyphens) from a free-form display name; fall back to `slug` if empty.
 */
export function agentNameFromOrgName(name: string, slug: string): string {
	const derived = name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 200)
		.replace(/-+$/g, "");
	return derived.length > 0 ? derived : slug;
}

/** Where {@link runOnboard} writes its progress/output (stdout by default). */
export interface OnboardIO {
	log: (line: string) => void;
}

const stdoutIO: OnboardIO = {
	log: (line) => process.stdout.write(`${line}\n`),
};

/**
 * Register a fresh org (RSA PoW), create its first agent, and print the handle +
 * verification words. Returns the new agent's handle.
 */
export async function runOnboard(
	opts: OnboardOptions,
	io: OnboardIO = stdoutIO,
): Promise<string> {
	const apiUrl = opts.apiUrl ?? resolveApiUrl();
	const configDir = opts.configDir ?? resolveConfigDir();

	io.log(`Onboarding org "${opts.slug}" at ${apiUrl} …`);
	io.log("Solving registration proof-of-work (this takes ~30–60 s) …");

	let lastPct = -1;
	await register({
		apiUrl,
		configDir,
		email: opts.email,
		slug: opts.slug,
		name: opts.name,
		onProgress: (pct) => {
			const whole = Math.floor(pct);
			if (whole > lastPct) {
				lastPct = whole;
				io.log(`  proof-of-work ${whole}%`);
			}
		},
	});

	io.log("Registered. Creating your first agent …");
	const client = new AsyncRineClient({ configDir, apiUrl });
	const agentName = opts.agentName ?? agentNameFromOrgName(opts.name, opts.slug);
	const agent = await client.createAgent(agentName);

	io.log("");
	io.log(`Agent ready: ${agent.handle}`);
	if (agent.verification_words) {
		io.log(`Verification words: ${agent.verification_words}`);
	}
	io.log(`Config dir: ${configDir}`);
	io.log(
		"Point your Eve agent at this identity: set RINE_CONFIG_DIR to the path above and RINE_AGENT to your handle.",
	);
	io.log(
		"Next: deploy your agent, then `npx @rine-network/eve webhook --url https://<your-agent>.vercel.app` to receive inbound rine messages.",
	);
	return agent.handle;
}

/** Parsed `onboard` CLI arguments. */
export interface OnboardArgs {
	email: string;
	slug: string;
	name: string;
	apiUrl?: string;
	configDir?: string;
	agentName?: string;
}

export const ONBOARD_USAGE =
	"Usage: npx @rine-network/eve onboard --email <e> --slug <s> --name <n> [--agent-name <a>] [--api-url <u>] [--config-dir <d>]";

/**
 * Parse `onboard` argv (the slice AFTER the `onboard` subcommand). Throws on a
 * missing required flag or unknown flag. Pure + side-effect-free.
 */
export function parseOnboardArgs(argv: readonly string[]): OnboardArgs {
	const flags: Record<string, string> = {};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (!arg?.startsWith("--")) throw new Error(`Unexpected argument: ${arg}`);
		const key = arg.slice(2);
		const value = argv[++i];
		if (value === undefined) throw new Error(`Missing value for --${key}`);
		flags[key] = value;
	}

	const known = new Set([
		"email",
		"slug",
		"name",
		"agent-name",
		"api-url",
		"config-dir",
	]);
	for (const key of Object.keys(flags)) {
		if (!known.has(key)) throw new Error(`Unknown flag: --${key}`);
	}

	const missing = ["email", "slug", "name"].filter((k) => !flags[k]);
	if (missing.length > 0) {
		throw new Error(
			`Missing required flag(s): ${missing.map((m) => `--${m}`).join(", ")}`,
		);
	}

	return {
		// biome-ignore lint/style/noNonNullAssertion: presence checked above
		email: flags.email!,
		// biome-ignore lint/style/noNonNullAssertion: presence checked above
		slug: flags.slug!,
		// biome-ignore lint/style/noNonNullAssertion: presence checked above
		name: flags.name!,
		apiUrl: flags["api-url"],
		configDir: flags["config-dir"],
		agentName: flags["agent-name"],
	};
}
