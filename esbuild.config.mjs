// Bundle the extension into one self-contained ESM file, dist/index.mjs, with every
// production dependency inlined. The .mcpb and the Claude Code plugin both ship only
// this file, so it must run with no node_modules (and no package.json) next to it.
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { build } from "esbuild";

// Tests build into their own directory (WLANPI_BUILD_OUT) so parallel runs never
// delete each other's bundle.
const outdir = process.env.WLANPI_BUILD_OUT ?? "dist";

// Start clean so nothing stale (an old bundle name) ends up in the .mcpb.
await rm(outdir, { recursive: true, force: true });
await build({
  entryPoints: ["src/index.ts"],
  outfile: join(outdir, "index.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  sourcemap: false,
  legalComments: "inline",
  banner: {
    js: [
      // The Claude Code plugin runs on whatever `node` is on the PATH: fail with a clear
      // message on one older than the manifest's runtime requirement, before any bundled
      // code runs.
      "{ const [major, minor] = process.versions.node.split('.').map(Number);",
      "  if (major < 22 || (major === 22 && minor < 19)) {",
      "    process.stderr.write(`wlanpi-mcp-extension needs Node.js 22.19 or later; this is ${process.version}. Install a newer Node.js and restart Claude.\\n`);",
      "    process.exit(1); } }",
      // Some bundled CommonJS dependencies call require() for Node builtins, which an ESM
      // bundle does not provide on its own.
      "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
    ].join("\n"),
  },
  logLevel: "info",
});
