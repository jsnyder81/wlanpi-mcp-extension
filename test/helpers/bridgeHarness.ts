import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  type CallToolResult,
  PromptListChangedNotificationSchema,
  ResourceListChangedNotificationSchema,
  ToolListChangedNotificationSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, expect } from "vitest";
import { Bridge, type BridgeOptions, MANAGEMENT_TOOLS } from "../../src/bridge.js";
import { Registry } from "../../src/registry.js";
import { type MockPi, type MockPiOptions, startMockPi } from "./mockPi.js";

export const MANAGEMENT = MANAGEMENT_TOOLS.map((t) => t.name);

export interface Harness {
  bridge: Bridge;
  client: Client;
  registry: Registry;
  /** list_changed notifications received, per list. */
  changes: { tools: number; resources: number; prompts: number };
  call: (name: string, args?: Record<string, unknown>) => Promise<CallToolResult>;
  piToolNames: () => Promise<string[]>;
}

/**
 * A bridge driven through a real MCP client over an in-memory transport, with a fresh
 * config directory per test and everything cleaned up afterwards. Call once at the top
 * of a test file.
 */
export function useBridgeHarness() {
  const cleanup: Array<() => Promise<unknown>> = [];
  let dir = "";

  beforeEach(async () => {
    dir = await fs.mkdtemp(join(tmpdir(), "wlanpi-bridge-"));
    cleanup.push(() => fs.rm(dir, { recursive: true, force: true }));
  });

  afterEach(async () => {
    while (cleanup.length) await cleanup.pop()!().catch(() => {});
  });

  async function pi(options: MockPiOptions = {}): Promise<MockPi> {
    const mock = await startMockPi(options);
    cleanup.push(() => mock.close());
    return mock;
  }

  async function harness(config: Partial<BridgeOptions["config"]> = {}): Promise<Harness> {
    const registry = await Registry.open(dir);
    const bridge = new Bridge({ registry, config: { callTimeoutMs: 10_000, ...config }, connectionOptions: { connectTimeoutMs: 2000 } });
    await bridge.init();
    const client = new Client({ name: "test", version: "0.0.0" });
    const changes = { tools: 0, resources: 0, prompts: 0 };
    client.setNotificationHandler(ToolListChangedNotificationSchema, () => void changes.tools++);
    client.setNotificationHandler(ResourceListChangedNotificationSchema, () => void changes.resources++);
    client.setNotificationHandler(PromptListChangedNotificationSchema, () => void changes.prompts++);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await bridge.server.connect(serverTransport);
    await client.connect(clientTransport);
    cleanup.push(() => bridge.close());
    return {
      bridge,
      client,
      registry,
      changes,
      call: async (name, args = {}) => (await client.callTool({ name, arguments: args })) as CallToolResult,
      piToolNames: async () => (await client.listTools()).tools.map((t) => t.name).filter((n) => !MANAGEMENT.includes(n)),
    };
  }

  return {
    pi,
    harness,
    get dir() {
      return dir;
    },
    cleanup,
  };
}

export const textOf = (result: CallToolResult) => result.content.map((c) => (c.type === "text" ? c.text : "")).join("");

export const data = (result: CallToolResult) => {
  expect(result.isError, textOf(result)).toBeFalsy();
  return result.structuredContent as Record<string, unknown>;
};

export const hostOf = (mock: MockPi) => `127.0.0.1:${mock.port}`;

/** Notifications cross the in-memory transport asynchronously. */
export const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

export async function add(h: Harness, mock: MockPi, name: string, token: string | null = mock.token) {
  return data(await h.call("add_wlanpi", { host: hostOf(mock), name, ...(token ? { token } : {}) }));
}
