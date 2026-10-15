import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MANAGEMENT_TOOLS } from "../../src/bridge.js";
import { type MockPi, startMockPi } from "../helpers/mockPi.js";

/**
 * Runs the bundled dist/index.js as a real stdio process, the way Claude Desktop and
 * Claude Code launch it, to prove the single-file bundle works on its own.
 */

const root = fileURLToPath(new URL("../..", import.meta.url));

let dir: string;
let mock: MockPi;
let client: Client;
let stderr = "";

beforeAll(async () => {
  execFileSync(process.execPath, [join(root, "esbuild.config.mjs")], { cwd: root, stdio: "ignore" });
  dir = await fs.mkdtemp(join(tmpdir(), "wlanpi-smoke-"));
  // Copy the bundle out of the repo, laid out as in the .mcpb, so a dependency that was
  // not bundled cannot be found in the repo's node_modules.
  const installed = join(dir, "extension");
  await fs.mkdir(join(installed, "dist"), { recursive: true });
  await fs.copyFile(join(root, "dist", "index.js"), join(installed, "dist", "index.js"));
  await fs.copyFile(join(root, "package.json"), join(installed, "package.json"));
  const entry = join(installed, "dist", "index.js");
  mock = await startMockPi();

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entry],
    cwd: dir,
    env: { ...getDefaultEnvironment(), WLANPI_BRIDGE_CONFIG_DIR: join(dir, "config"), WLANPI_BRIDGE_LOG_LEVEL: "debug" },
    stderr: "pipe",
  });
  transport.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
  client = new Client({ name: "smoke", version: "0.0.0" });
  await client.connect(transport);
}, 60_000);

afterAll(async () => {
  await client?.close();
  await mock?.close();
  await fs.rm(dir, { recursive: true, force: true });
});

describe("bundled extension over stdio", () => {
  it("starts with only the management tools", async () => {
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual(MANAGEMENT_TOOLS.map((t) => t.name));
  });

  it("adds a Pi and calls one of its tools", async () => {
    const added = (await client.callTool({ name: "add_wlanpi", arguments: { host: `127.0.0.1:${mock.port}`, name: "lab", token: mock.token } })) as CallToolResult;
    expect(added.isError).toBeFalsy();
    expect(added.structuredContent).toMatchObject({ status: "ready", certificate: { fingerprint_sha256: mock.cert.fingerprint256 } });

    const info = (await client.callTool({ name: "get_device_info", arguments: { device: "lab" } })) as CallToolResult;
    expect(info.structuredContent).toEqual({ model: "WLAN Pi M4" });

    const saved = JSON.parse(await fs.readFile(join(dir, "config", "devices.json"), "utf8"));
    expect(saved.devices[0]).toMatchObject({ name: "lab", cert_sha256: mock.cert.fingerprint256 });
  });

  it("logs to stderr without the token", () => {
    expect(stderr).toMatch(/Starting wlanpi-mcp-extension/);
    expect(stderr).not.toContain(mock.token);
  });
});
