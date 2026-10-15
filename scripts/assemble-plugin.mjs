// Assemble the Claude Code plugin in build/plugin from plugin/ plus the bundle, the
// license and the docs. The release workflow pushes this directory to the `release`
// branch, which the marketplace entry installs from, so main never carries the bundle.
//
// Usage: node scripts/assemble-plugin.mjs [outDir]   (run `npm run build` first)
import { cp, mkdir, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const out = resolve(process.argv[2] ?? join(root, "build", "plugin"));
const bundle = join(root, "dist", "index.mjs");

try {
  await stat(bundle);
} catch {
  console.error(`${bundle} is missing; run npm run build first.`);
  process.exit(1);
}

await rm(out, { recursive: true, force: true });
await mkdir(join(out, "dist"), { recursive: true });
await cp(join(root, "plugin"), out, { recursive: true });
await cp(bundle, join(out, "dist", "index.mjs"));
for (const file of ["LICENSE", "README.md", "TROUBLESHOOTING.md", "CHANGELOG.md"]) {
  await cp(join(root, file), join(out, file));
}
console.log(`Assembled the plugin in ${out}`);
