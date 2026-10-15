import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { NAME, VERSION } from "./version.js";

/**
 * Build the MCP server Claude talks to over stdio.
 *
 * Uses the low-level Server API rather than McpServer: the tools it advertises are
 * aggregated from each WLAN Pi at runtime as plain JSON Schema, not declared up front
 * with zod. Phase 0 advertises no tools yet.
 */
export function createBridgeServer(): Server {
  const server = new Server(
    { name: NAME, version: VERSION },
    { capabilities: { tools: { listChanged: true } } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [] }));

  return server;
}
