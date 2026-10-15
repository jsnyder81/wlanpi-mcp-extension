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
  // Some bundled CommonJS dependencies call require() for Node builtins, which an ESM
  // bundle does not provide on its own.
  banner: {
    js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
  },
  logLevel: "info",
});
