import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createBridgeServer } from "./bridge.js";

// stdout carries the MCP stdio protocol, so nothing else may write to it.
const server = createBridgeServer();
await server.connect(new StdioServerTransport());
