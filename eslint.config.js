import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/", "build/", "node_modules/", "coverage/", "*.mcpb"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // stdout is the MCP stdio channel: all logging goes through src/log.ts to stderr.
      "no-console": "error",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    },
  },
  {
    files: ["*.config.{js,mjs,ts}", "scripts/**/*.mjs"],
    languageOptions: { globals: { process: "readonly", console: "readonly", URL: "readonly" } },
    rules: { "no-console": "off" },
  },
);
