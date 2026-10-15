import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { createBridgeServer } from "../../src/bridge.js";
import { NAME, VERSION } from "../../src/version.js";

describe("createBridgeServer", () => {
  it("initializes over MCP and reports its name, version and tool capability", async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createBridgeServer();
    const client = new Client({ name: "test", version: "0.0.0" });
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    expect(client.getServerVersion()).toEqual({ name: NAME, version: VERSION });
    expect(client.getServerCapabilities()?.tools?.listChanged).toBe(true);
    expect((await client.listTools()).tools).toEqual([]);

    await client.close();
  });
});
