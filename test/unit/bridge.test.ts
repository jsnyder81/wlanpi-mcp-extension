import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import { Bridge, MANAGEMENT_TOOLS } from "../../src/bridge.js";
import { Registry } from "../../src/registry.js";
import { NAME, VERSION } from "../../src/version.js";

let dir: string | undefined;

afterEach(async () => {
  if (dir) await fs.rm(dir, { recursive: true, force: true });
  dir = undefined;
});

describe("Bridge with no devices", () => {
  it("initializes over MCP and offers only the management tools", async () => {
    dir = await fs.mkdtemp(join(tmpdir(), "wlanpi-bridge-"));
    const bridge = new Bridge({ registry: await Registry.open(dir), config: { callTimeoutMs: 1000 } });
    await bridge.init();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "0.0.0" });
    await bridge.server.connect(serverTransport);
    await client.connect(clientTransport);

    expect(client.getServerVersion()).toEqual({ name: NAME, version: VERSION });
    expect(client.getServerCapabilities()?.tools?.listChanged).toBe(true);
    expect(client.getInstructions()).toMatch(/add_wlanpi/);
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual(MANAGEMENT_TOOLS.map((t) => t.name));

    const unknown = await client.callTool({ name: "get_device_info", arguments: {} });
    expect(unknown).toMatchObject({ isError: true, content: [{ type: "text", text: expect.stringMatching(/No WLAN Pi is registered yet/) }] });

    const listed = await client.callTool({ name: "list_wlanpis", arguments: {} });
    expect(listed.structuredContent).toMatchObject({ count: 0, hint: expect.stringMatching(/add_wlanpi/) });

    await client.close();
  });

  it("marks every management tool with annotations", () => {
    for (const tool of MANAGEMENT_TOOLS) {
      expect(tool.annotations, tool.name).toBeDefined();
      expect(typeof tool.annotations?.readOnlyHint, tool.name).toBe("boolean");
    }
    expect(MANAGEMENT_TOOLS.find((t) => t.name === "list_wlanpis")?.annotations?.readOnlyHint).toBe(true);
    expect(MANAGEMENT_TOOLS.find((t) => t.name === "remove_wlanpi")?.annotations?.destructiveHint).toBe(true);
  });
});
