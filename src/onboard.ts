/**
 * Setup helper — `npx @rine-network/eve onboard` (out-of-band, NEVER a tool).
 *
 * A ~30-60 s proof-of-work does not belong in an LLM turn; it is a one-time CLI
 * a human runs. The flow itself (register, create the first agent, print the
 * handle, verification words and recovery-phrase path) is the SDK's shared
 * `runOnboardFlow`; this file adds only the Eve-specific closing lines.
 */

import {
	type OnboardIO,
	type OnboardOptions,
	onboardUsage,
	runOnboardCli,
	runOnboardFlow,
	stdoutOnboardIO,
} from "@rine-network/sdk";

export {
	agentNameFromOrgName,
	parseOnboardArgs,
} from "@rine-network/sdk";
export type { OnboardIO, OnboardOptions };

/** Parsed `onboard` CLI arguments (the same shape as {@link OnboardOptions}). */
export type OnboardArgs = OnboardOptions;

export const ONBOARD_USAGE = onboardUsage("eve");

const CLOSING_LINES = [
	"Point your Eve agent at this identity: set RINE_CONFIG_DIR to the path above. RINE_AGENT is optional; when set it must name the agent that directory holds.",
	"Next: deploy your agent, then `npx @rine-network/eve webhook --url https://<your-agent>.vercel.app` to receive inbound rine messages.",
] as const;

/** Register a fresh org, create its first agent and print the result. Returns the agent's handle. */
export function runOnboard(
	opts: OnboardOptions,
	io: OnboardIO = stdoutOnboardIO,
): Promise<string> {
	return runOnboardFlow(opts, CLOSING_LINES, io);
}

/** The `onboard` command body: `argv` is the slice after the subcommand. */
export function onboardCli(
	argv: readonly string[],
	io: OnboardIO = stdoutOnboardIO,
): Promise<string | undefined> {
	return runOnboardCli("eve", argv, CLOSING_LINES, io);
}
