#!/usr/bin/env node
/**
 * `rine-eve` CLI — `npx @rine-network/eve <command>`.
 *
 *   init      scaffold agent/channels/rine.ts, agent/tools/*.ts, agent/skills/rine/SKILL.md, .env.example
 *   onboard   register a rine org + first agent (RSA proof-of-work, one-time)
 *   webhook   register/delete the rine webhook for your deployed agent's inbound route
 *   relay     dev pump: forward new rine mail to your local `eve dev` channel route
 *
 * Each command imports only the granular dist module it needs, so `init`/`onboard`
 * run without resolving the `eve` peer dependency.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";

// Flags that take no value (deterministic — not inferred from the next token, so a
// value beginning with "--" is still passable to a value flag).
const BOOLEAN_FLAGS = new Set(["no-channel", "force", "delete"]);

function parseFlags(argv) {
	const flags = {};
	const bools = new Set();
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (!a.startsWith("--")) throw new Error(`Unexpected argument: ${a}`);
		const key = a.slice(2);
		if (BOOLEAN_FLAGS.has(key)) {
			bools.add(key);
			continue;
		}
		const val = argv[++i];
		if (val === undefined) throw new Error(`Missing value for --${key}`);
		flags[key] = val;
	}
	return { flags, bools };
}

/** Upsert `KEY=value` lines into a dotenv file (creating it if absent). */
function upsertEnv(file, vars) {
	let text = existsSync(file) ? readFileSync(file, "utf-8") : "";
	for (const [k, v] of Object.entries(vars)) {
		const line = `${k}=${v}`;
		const re = new RegExp(`^${k}=.*$`, "m");
		// Function replacer so `$`/`$&` in the secret aren't interpreted as
		// replacement-pattern substitutions.
		text = re.test(text) ? text.replace(re, () => line) : `${text.replace(/\n*$/, "\n")}${line}\n`;
	}
	writeFileSync(file, text, "utf-8");
}

const USAGE = `Usage: npx @rine-network/eve <command>

  init      [--dir agent] [--tools all|none|<csv>] [--no-channel] [--path /rine/v1/inbound] [--force]
  onboard   --email <e> --slug <s> --name <n> [--agent-name <a>] [--api-url <u>] [--config-dir <d>] [--owner-dir <d>]
  webhook   --url <publicBaseUrl> [--delete] [--id <webhookId>] [--agent <h>] [--env .env] [--api-url <u>] [--config-dir <d>] [--path <p>]
  relay     [--url http://localhost:3000] [--interval 3000] [--path /rine/v1/inbound] [--agent <h>]`;

async function cmdInit(rest) {
	const { flags, bools } = parseFlags(rest);
	const { scaffoldRine } = await import("../dist/scaffold.js");
	const res = scaffoldRine({
		dir: flags.dir,
		tools: flags.tools,
		path: flags.path,
		channel: !bools.has("no-channel"),
		force: bools.has("force"),
	});
	for (const f of res.written) process.stdout.write(`  wrote   ${f}\n`);
	for (const f of res.skipped) process.stdout.write(`  skipped ${f} (exists — pass --force to overwrite)\n`);
	process.stdout.write(
		"\nNext:\n  1. npx @rine-network/eve onboard --email you@org --slug your-org --name 'Your Org'\n  2. set RINE_CONFIG_DIR + RINE_AGENT in your env\n  3. deploy, then: npx @rine-network/eve webhook --url https://<your-agent>.vercel.app\n  4. local dev: npx @rine-network/eve relay\n",
	);
}

async function cmdOnboard(rest) {
	const { onboardCli } = await import("../dist/onboard.js");
	await onboardCli(rest, {
		log: (line) => process.stdout.write(`${line}\n`),
		error: (line) => process.stderr.write(`${line}\n`),
	});
}

async function cmdWebhook(rest) {
	const { flags, bools } = parseFlags(rest);
	const { registerRineWebhook, deleteRineWebhook } = await import("../dist/webhook.js");
	const common = { agent: flags.agent, apiUrl: flags["api-url"], configDir: flags["config-dir"] };
	if (bools.has("delete")) {
		const id = flags.id ?? process.env.RINE_WEBHOOK_ID;
		if (!id) {
			process.stderr.write("webhook --delete needs --id <webhookId> (or RINE_WEBHOOK_ID)\n");
			process.exitCode = 1;
			return;
		}
		await deleteRineWebhook(id, common);
		process.stdout.write(`Deleted webhook ${id}.\n`);
		return;
	}
	if (!flags.url) {
		process.stderr.write("webhook needs --url <publicBaseUrl> (your deployed agent's base URL)\n");
		process.exitCode = 1;
		return;
	}
	const created = await registerRineWebhook({ baseUrl: flags.url, path: flags.path, ...common });
	const envFile = flags.env ?? ".env";
	upsertEnv(envFile, { RINE_WEBHOOK_SECRET: created.secret, RINE_WEBHOOK_ID: created.id });
	process.stdout.write(
		`Registered webhook ${created.id} → ${created.url}\nWrote RINE_WEBHOOK_SECRET + RINE_WEBHOOK_ID to ${envFile}\n(Set RINE_WEBHOOK_SECRET in your deployment env so the channel can verify inbound signatures.)\n`,
	);
}

async function cmdRelay(rest) {
	const { flags } = parseFlags(rest);
	const { runRelay } = await import("../dist/relay.js");
	const controller = new AbortController();
	process.on("SIGINT", () => controller.abort());
	process.on("SIGTERM", () => controller.abort());
	await runRelay({
		target: flags.url ?? flags.target,
		path: flags.path,
		intervalMs: flags.interval ? Number(flags.interval) : undefined,
		agent: flags.agent,
		apiUrl: flags["api-url"],
		configDir: flags["config-dir"],
		signal: controller.signal,
	});
}

const [cmd, ...rest] = process.argv.slice(2);
try {
	switch (cmd) {
		case "init":
			await cmdInit(rest);
			break;
		case "onboard":
			await cmdOnboard(rest);
			break;
		case "webhook":
			await cmdWebhook(rest);
			break;
		case "relay":
			await cmdRelay(rest);
			break;
		default:
			process.stdout.write(`${USAGE}\n`);
			process.exitCode = cmd ? 1 : 0;
	}
} catch (err) {
	process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
	process.exitCode = 1;
}
