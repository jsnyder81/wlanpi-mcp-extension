import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/", "node_modules/", "coverage/", "*.mcpb"] },
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
    files: ["*.config.{js,mjs,ts}"],
    languageOptions: { globals: { process: "readonly", console: "readonly" } },
    rules: { "no-console": "off" },
  },
);
