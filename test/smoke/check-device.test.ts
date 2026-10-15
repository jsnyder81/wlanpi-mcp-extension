import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type MockPi, defaultPrompts, defaultTools, startMockPi } from "../helpers/mockPi.js";

/** scripts/check-device.mjs is for real Pis; this keeps it working against a mock one. */

const root = fileURLToPath(new URL("../..", import.meta.url));
const run = promisify(execFile);
let mock: MockPi;
let out: string;

beforeAll(async () => {
  out = await mkdtemp(join(tmpdir(), "wlanpi-check-build-"));
  await run(process.execPath, [join(root, "esbuild.config.mjs")], { cwd: root, env: { ...process.env, WLANPI_BUILD_OUT: out } });
  const readOnly = ["get_device_stats", "get_network_interfaces", "list_allowed_services"].map((name) => ({
    name,
    description: name,
    inputSchema: { type: "object" as const, properties: {} },
    handler: () => ({ content: [{ type: "text" as const, text: `${name} ok` }] }),
  }));
  mock = await startMockPi({
    tools: [...defaultTools(), ...readOnly],
    prompts: [
      ...defaultPrompts(),
      { name: "health_check", description: "Health check.", render: () => ({ messages: [{ role: "user", content: { type: "text", text: "Run a health check." } }] }) },
    ],
  });
}, 60_000);

afterAll(async () => {
  await mock?.close();
  await rm(out, { recursive: true, force: true });
});

const script = (host: string) => [join(root, "scripts", "check-device.mjs"), host, "--entry", join(out, "index.mjs")];

describe("scripts/check-device.mjs", () => {
  it("passes every check against a well-behaved Pi", async () => {
    const { stdout } = await run(process.execPath, script(`127.0.0.1:${mock.port}`), {
      cwd: root,
      env: { ...process.env, WLANPI_TOKEN: mock.token },
    });
    expect(stdout).not.toMatch(/^FAIL/m);
    expect(stdout).toMatch(/All checks passed\./);
    expect(stdout).toMatch(/PASS {2}a certificate that does not match the pin is refused/);
    expect(stdout).not.toContain(mock.token);
  }, 60_000);

  it("fails and says why when the token is wrong", async () => {
    const result = await run(process.execPath, script(`127.0.0.1:${mock.port}`), {
      cwd: root,
      env: { ...process.env, WLANPI_TOKEN: "wrong" },
    }).catch((err: { code: number; stdout: string }) => err);
    expect("code" in result && result.code).toBe(1);
    expect(result.stdout).toMatch(/FAIL {2}add_wlanpi/);
  }, 60_000);
});
