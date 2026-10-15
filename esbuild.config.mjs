// Bundle the extension into one self-contained ESM file, dist/index.js, with every
// production dependency inlined. The .mcpb and the Claude Code plugin both ship only
// this file, so it must run with no node_modules next to it.
import { build } from "esbuild";

await build({
  entryPoints: ["src/index.ts"],
  outfile: "dist/index.js",
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
