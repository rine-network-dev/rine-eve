import { defineConfig } from "tsdown";

// Named entries → stable dist paths that match `package.json#exports` and the
// `bin/cli.js` relative imports. Declarations come from a separate `tsc` pass
// (`dts: false` here), mirroring the other rine TS packages.
export default defineConfig({
	entry: {
		index: "src/index.ts",
		channel: "src/channel.ts",
		"tools/index": "src/tools/index.ts",
		onboard: "src/onboard.ts",
		scaffold: "src/scaffold.ts",
		relay: "src/relay.ts",
		webhook: "src/webhook.ts",
	},
	format: "esm",
	outDir: "dist",
	clean: true,
	dts: false,
});
