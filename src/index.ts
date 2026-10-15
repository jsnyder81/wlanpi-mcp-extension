import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Bridge } from "./bridge.js";
import { loadConfig } from "./config.js";
import { createLogger } from "./log.js";
import { Registry } from "./registry.js";
import { VERSION } from "./version.js";

// stdout carries the MCP stdio protocol: everything else goes to stderr via the logger.
const config = loadConfig();
const logger = createLogger(config.logLevel);
for (const warning of config.warnings) logger.warn(warning);
logger.info(`Starting wlanpi-mcp-extension ${VERSION}; config in ${config.configDir}`);

const registry = await Registry.open(config.configDir, { logger });
const bridge = new Bridge({ registry, config, logger });

// Registry and cached tool lists only: no network, so Claude gets a tool list at once.
await bridge.init();
await bridge.server.connect(new StdioServerTransport());

// Seeding and catalog refreshes run in the background and announce changes with
// notifications/tools/list_changed.
bridge.start().catch((err) => logger.error("Background startup failed", err));

let closing = false;
const shutdown = () => {
  if (closing) return;
  closing = true;
  bridge.close().finally(() => process.exit(0));
};
process.stdin.on("close", shutdown);
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
