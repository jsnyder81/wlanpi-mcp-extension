import { describe, expect, it } from "vitest";
import { MANAGEMENT, add, data, hostOf, textOf, useBridgeHarness } from "../helpers/bridgeHarness.js";
import { defaultTools } from "../helpers/mockPi.js";

const env = useBridgeHarness();
const { pi, harness } = env;

describe("list_wlanpi_tools and call_wlanpi_tool", () => {
  it("lists a Pi's tools with summaries and flags, and describes one in full", async () => {
    const mock = await pi({
      tools: [
        ...defaultTools(),
        {
          name: "reboot_device",
          description: "Reboot the WLAN Pi.\n\nThe device is unreachable for about a minute.",
          inputSchema: { type: "object", properties: { delay: { type: "integer" } }, required: ["delay"] },
          annotations: { destructiveHint: true },
        },
      ],
    });
    const h = await harness();
    await add(h, mock, "lab");

    const listed = data(await h.call("list_wlanpi_tools"));
    expect(listed).toMatchObject({ device: "lab", server_version: "0.6.17-3", source: "live", count: 6 });
    expect((listed.tools as Array<{ name: string }>).find((t) => t.name === "reboot_device")).toEqual({
      name: "reboot_device",
      summary: "Reboot the WLAN Pi.",
      read_only: false,
      destructive: true,
      arguments: ["delay"],
      required: ["delay"],
    });

    expect(data(await h.call("list_wlanpi_tools", { device: "lab", tool: "echo" }))).toEqual({
      device: "lab",
      tool: {
        name: "echo",
        description: "Return the arguments.",
        read_only: false,
        destructive: false,
        inputSchema: { type: "object", properties: { message: { type: "string" } }, required: ["message"] },
      },
    });
    expect(textOf(await h.call("list_wlanpi_tools", { tool: "nope" }))).toMatch(/'lab' has no tool 'nope'/);
  });

  it("runs any Pi tool by name and returns its result unchanged", async () => {
    const mock = await pi();
    const h = await harness();
    await add(h, mock, "lab");

    expect(await h.call("call_wlanpi_tool", { tool: "get_device_info" })).toEqual({
      content: [{ type: "text", text: '{"model":"WLAN Pi M4"}' }],
      structuredContent: { model: "WLAN Pi M4" },
    });
    expect(textOf(await h.call("call_wlanpi_tool", { device: "lab", tool: "echo", arguments: { message: "via fallback" } }))).toBe("via fallback");
    expect(mock.calls.at(-1)).toEqual({ name: "echo", arguments: { message: "via fallback" } });
    expect(await h.call("call_wlanpi_tool", { tool: "fails" })).toEqual({ content: [{ type: "text", text: "Service 'x' is not in the allowlist" }], isError: true });
  });

  it("reaches tools the merged list cannot show", async () => {
    // A tool with both 'device' and 'wlanpi_device' arguments is dropped from the merged list.
    const mock = await pi({
      tools: [
        {
          name: "odd",
          description: "Odd arguments.",
          inputSchema: { type: "object", properties: { device: { type: "string" }, wlanpi_device: { type: "string" } } },
          handler: (args) => ({ content: [{ type: "text", text: `${String(args.device)}/${String(args.wlanpi_device)}` }] }),
        },
      ],
    });
    const h = await harness();
    await add(h, mock, "lab");
    expect(await h.piToolNames()).toEqual([]);
    expect(textOf(await h.call("call_wlanpi_tool", { tool: "odd", arguments: { device: "a", wlanpi_device: "b" } }))).toBe("a/b");
  });

  it("explains missing devices, unknown tools and bad arguments", async () => {
    const a = await pi();
    const b = await pi({ tools: defaultTools().filter((t) => t.name !== "fails") });
    const h = await harness();

    expect(textOf(await h.call("call_wlanpi_tool", { tool: "echo" }))).toBe("No WLAN Pi is registered yet: add one with add_wlanpi.");
    await add(h, a, "lab");
    await add(h, b, "field");

    expect(textOf(await h.call("call_wlanpi_tool", { tool: "echo", arguments: { message: "x" } }))).toBe(
      "call_wlanpi_tool needs a 'device' argument naming the WLAN Pi to use: one of field, lab.",
    );
    expect(textOf(await h.call("call_wlanpi_tool", { device: "lad", tool: "echo" }))).toBe("Unknown device 'lad'. Registered devices: field, lab.");
    expect(textOf(await h.call("call_wlanpi_tool", { device: "field", tool: "fails" }))).toBe(
      "Device 'field' (wlanpi-mcp 0.6.17-3) does not have the tool 'fails'. See list_wlanpi_tools.",
    );
    expect(textOf(await h.call("call_wlanpi_tool", { device: "lab", tool: "add_wlanpi" }))).toMatch(/one of the extension's own tools/);
    expect(textOf(await h.call("call_wlanpi_tool", { device: "lab", tool: "echo", arguments: "x" }))).toMatch(/'arguments' must be an object/);
    expect(textOf(await h.call("call_wlanpi_tool", { device: "lab" }))).toMatch(/'tool' is required/);
  });

  it("adds the token fix to a core 401, like a routed call", async () => {
    const mock = await pi();
    const h = await harness();
    await add(h, mock, "lab", "expired");
    const result = await h.call("call_wlanpi_tool", { tool: "get_device_info" });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/wlanpi-core returned 401.*sudo getjwt claude/s);
  });

  it("works for a Pi whose tool list was never fetched", async () => {
    const mock = await pi();
    const h = await harness();
    await h.registry.add({ name: "lab", host: "127.0.0.1", port: mock.port, cert_sha256: mock.cert.fingerprint256, token: mock.token });
    await h.bridge.reload();
    expect(data(await h.call("list_wlanpi_tools")).count).toBe(5);
    expect(textOf(await h.call("call_wlanpi_tool", { tool: "echo", arguments: { message: "fresh" } }))).toBe("fresh");
  });
});

describe("startup", () => {
  it("holds the first tool list until seeded Pis are added", async () => {
    const mock = await pi();
    const h = await harness({ seedDevices: `lab=${hostOf(mock)}`, tokens: mock.token });
    const started = h.bridge.start();
    // Asked before seeding finishes, as Claude Desktop does right after initialize.
    const names = (await h.client.listTools()).tools.map((t) => t.name);
    expect(names.filter((n) => !MANAGEMENT.includes(n))).toEqual(["echo", "fails", "fetch_pcap_file", "get_device_info", "slow"]);
    expect((await h.client.listResources()).resources).toHaveLength(2);
    await started;
  });

  it("does not hold it longer than the startup wait", async () => {
    const mock = await pi();
    await mock.stop();
    const h = await harness({ seedDevices: `lab=${hostOf(mock)}` }, { startupWaitMs: 200 });
    const before = Date.now();
    void h.bridge.start();
    expect((await h.client.listTools()).tools.map((t) => t.name)).toEqual(MANAGEMENT);
    expect(Date.now() - before).toBeLessThan(2000);
  });

  it("answers at once when start() was never called", async () => {
    const h = await harness();
    expect((await h.client.listTools()).tools.map((t) => t.name)).toEqual(MANAGEMENT);
  });
});

describe("tokens from settings", () => {
  it("uses a named token for a Pi added without one", async () => {
    const a = await pi({ token: "token-a" });
    const b = await pi({ token: "token-b" });
    const h = await harness({ tokens: "lab=token-a, field=token-b" });
    expect((await add(h, a, "lab", null)).token_verified).toBe(true);
    expect((await add(h, b, "field", null)).token_verified).toBe(true);
    expect(h.registry.get("field")?.token).toBe("token-b");
  });

  it("replaces stored tokens on start, so renewing is paste and restart", async () => {
    const a = await pi({ token: "fresh-a" });
    const b = await pi({ token: "fresh-b" });
    const first = await harness();
    await add(first, a, "lab", "expired-a");
    await add(first, b, "field", "expired-b");
    await first.bridge.close();

    const h = await harness({ tokens: "lab=fresh-a, field=fresh-b" });
    expect(h.registry.get("lab")?.token).toBe("fresh-a");
    expect(h.registry.get("field")?.token).toBe("fresh-b");
    expect(data(await h.call("list_wlanpis")).devices).toEqual([
      expect.objectContaining({ name: "field", token_valid: true }),
      expect.objectContaining({ name: "lab", token_valid: true }),
    ]);
  });

  it("applies an unnamed token to a single Pi, but only fills gaps when there are several", async () => {
    const a = await pi();
    const first = await harness();
    await add(first, a, "lab", "old");
    await first.bridge.close();
    expect((await harness({ tokens: "new" })).registry.get("lab")?.token).toBe("new");

    const b = await pi();
    const second = await harness();
    await add(second, b, "field", null);
    await second.bridge.close();
    const h = await harness({ tokens: "shared" });
    expect(h.registry.get("lab")?.token).toBe("new");
    expect(h.registry.get("field")?.token).toBe("shared");
  });

  it("still accepts the old default token setting", async () => {
    const mock = await pi();
    const h = await harness({ defaultToken: mock.token });
    expect((await add(h, mock, "lab", null)).token_verified).toBe(true);
  });
});
