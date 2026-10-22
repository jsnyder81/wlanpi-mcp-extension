import type { Prompt, Tool } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import { canonicalJson, compareVersions, fromBridgeUri, mergePrompts, mergeResources, mergeTools, toBridgeUri } from "../../src/catalog.js";
import { createLogger } from "../../src/log.js";

const tool = (name: string, properties: Record<string, object> = {}, extra: Partial<Tool> = {}): Tool => ({
  name,
  description: `${name} description`,
  inputSchema: { type: "object", properties },
  ...extra,
});

describe("compareVersions", () => {
  it.each([
    ["0.7.0", "0.6.17-3", 1],
    ["0.6.17-3", "0.6.17", 1],
    ["0.6.17-3", "0.6.17-10", -1],
    ["0.6.17", "0.6.17", 0],
    ["1.0", "1.0.0", -1],
    ["0.10.0", "0.9.9", 1],
    ["0.6.17-rc1", "0.6.17-rc2", -1],
  ])("%s vs %s", (a, b, expected) => {
    expect(compareVersions(a, b)).toBe(expected);
    expect(compareVersions(b, a)).toBe(-expected || 0);
  });
});

describe("canonicalJson", () => {
  it("ignores key order but not array order", () => {
    expect(canonicalJson({ a: 1, b: { c: 2, d: 3 } })).toBe(canonicalJson({ b: { d: 3, c: 2 }, a: 1 }));
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
  });
});

describe("mergeTools", () => {
  it("exposes nothing without devices", () => {
    expect(mergeTools([], [])).toEqual({ tools: [], routes: new Map() });
  });

  it("makes device optional with a default when one device is registered", () => {
    const { tools, routes } = mergeTools([{ device: "lab", version: "1", tools: [tool("echo", { message: { type: "string" } }, { inputSchema: { type: "object", properties: { message: { type: "string" } }, required: ["message"] } })] }], ["lab"]);
    expect(tools).toEqual([
      {
        name: "echo",
        description: "echo description",
        inputSchema: {
          type: "object",
          properties: {
            device: { type: "string", default: "lab", description: expect.stringMatching(/Optional: defaults to 'lab'/) },
            message: { type: "string" },
          },
          required: ["message"],
        },
      },
    ]);
    expect(routes.get("echo")).toEqual({ param: "device", devices: ["lab"] });
  });

  it("requires device with two or more devices, and does not grow with device count", () => {
    const tools = [tool("a"), tool("b")];
    const two = mergeTools(
      [
        { device: "lab", version: "1", tools },
        { device: "field", version: "1", tools },
      ],
      ["field", "lab"],
    );
    expect(two.tools.map((t) => t.name)).toEqual(["a", "b"]);
    expect(two.tools[0]?.inputSchema.required).toEqual(["device"]);
    expect(two.tools[0]?.inputSchema.properties?.device).toEqual({ type: "string", description: expect.stringContaining("one of field, lab") });
    expect(two.tools[0]?.description).toBe("a description");
    expect(two.routes.get("a")?.devices).toEqual(["field", "lab"]);

    const five = mergeTools(
      ["a1", "a2", "a3", "a4", "a5"].map((device) => ({ device, version: "1", tools })),
      ["a1", "a2", "a3", "a4", "a5"],
    );
    expect(five.tools).toHaveLength(2);
  });

  it("uses the newest version's schema when definitions differ and says where the tool exists", () => {
    const older = tool("scan", { band: { type: "string" } });
    const newer = tool("scan", { band: { type: "string" }, dwell_ms: { type: "integer" } }, { description: "Scan, now with dwell." });
    const { tools } = mergeTools(
      [
        { device: "old", version: "0.6.17-3", tools: [older] },
        { device: "new", version: "0.7.0", tools: [newer] },
      ],
      ["new", "old"],
    );
    expect(tools[0]?.inputSchema.properties).toHaveProperty("dwell_ms");
    expect(tools[0]?.description).toBe("Scan, now with dwell.\n\nAvailable on: new, old.");
  });

  it("notes when only some devices offer a tool", () => {
    const { tools, routes } = mergeTools(
      [
        { device: "lab", version: "1", tools: [tool("shared"), tool("rare")] },
        { device: "field", version: "1", tools: [tool("shared")] },
      ],
      ["field", "lab", "offline"],
    );
    expect(tools.find((t) => t.name === "rare")?.description).toBe("rare description\n\nAvailable on: lab.");
    // "offline" has no catalog, so not every registered device is known to have it.
    expect(tools.find((t) => t.name === "shared")?.description).toBe("shared description\n\nAvailable on: field, lab.");
    expect(routes.get("rare")?.devices).toEqual(["lab"]);
  });

  it("treats key order differences as identical schemas", () => {
    const a = tool("x", { p: { type: "string", description: "d" } });
    const b = { ...a, inputSchema: { properties: { p: { description: "d", type: "string" } }, type: "object" as const } };
    const { tools } = mergeTools(
      [
        { device: "a", version: "1", tools: [a] },
        { device: "b", version: "2", tools: [b] },
      ],
      ["a", "b"],
    );
    expect(tools[0]?.description).toBe("x description");
  });

  it("uses wlanpi_device when a tool already has a device argument, and warns", () => {
    const lines: string[] = [];
    const { tools, routes } = mergeTools([{ device: "lab", version: "1", tools: [tool("bt", { device: { type: "string", description: "Bluetooth MAC" } })] }], ["lab"], {
      logger: createLogger("warn", (l) => lines.push(l)),
    });
    expect(routes.get("bt")?.param).toBe("wlanpi_device");
    expect(Object.keys(tools[0]?.inputSchema.properties ?? {})).toEqual(["wlanpi_device", "device"]);
    expect(lines.join("")).toMatch(/already has a 'device' argument/);
  });

  it("drops a tool that has both device and wlanpi_device", () => {
    const { tools } = mergeTools([{ device: "lab", version: "1", tools: [tool("odd", { device: {}, wlanpi_device: {} })] }], ["lab"]);
    expect(tools).toEqual([]);
  });

  it("drops tools whose names are reserved", () => {
    const { tools } = mergeTools([{ device: "lab", version: "1", tools: [tool("add_wlanpi"), tool("ok")] }], ["lab"], { reserved: new Set(["add_wlanpi"]) });
    expect(tools.map((t) => t.name)).toEqual(["ok"]);
  });

  it("keeps annotations, output schemas and existing required arguments", () => {
    const rich = tool("reboot", { delay: { type: "integer" } }, {
      annotations: { destructiveHint: true },
      outputSchema: { type: "object", properties: { ok: { type: "boolean" } } },
      inputSchema: { type: "object", properties: { delay: { type: "integer" } }, required: ["delay"] },
    });
    const { tools } = mergeTools(
      [
        { device: "a", version: "1", tools: [rich] },
        { device: "b", version: "1", tools: [rich] },
      ],
      ["a", "b"],
    );
    expect(tools[0]).toMatchObject({ annotations: { destructiveHint: true }, outputSchema: rich.outputSchema });
    expect(tools[0]?.inputSchema.required).toEqual(["device", "delay"]);
  });
});

describe("bridge resource URIs", () => {
  it.each([
    ["device://info", "wlanpi://lab/device/info"],
    ["netconfig://leftovers", "wlanpi://lab/netconfig/leftovers"],
    ["services://status/{name}", "wlanpi://lab/services/status/{name}"],
    ["services://status/ssh", "wlanpi://lab/services/status/ssh"],
    ["DEVICE://Info", "wlanpi://lab/device/Info"],
    ["file:///tmp/capture.pcapng", "wlanpi://lab/file//tmp/capture.pcapng"],
    ["profiler://status?x=1", "wlanpi://lab/profiler/status?x=1"],
  ])("%s round-trips through %s", (piUri, bridgeUri) => {
    expect(toBridgeUri("lab", piUri)).toBe(bridgeUri);
    expect(fromBridgeUri(bridgeUri)).toEqual({ device: "lab", piUri: piUri.replace(/^DEVICE/, "device") });
  });

  it("cannot map a URI without scheme://", () => {
    expect(toBridgeUri("lab", "urn:wlanpi:info")).toBeUndefined();
  });

  it.each(["device://info", "wlanpi://lab", "wlanpi://lab/", "wlanpi://lab/device", "wlanpi://la_b/device/info", "wlanpi:///device/info", "other://lab/device/info"])(
    "rejects %s as a bridge URI",
    (uri) => {
      expect(fromBridgeUri(uri)).toBeUndefined();
    },
  );

  it("lowercases the device name", () => {
    expect(fromBridgeUri("wlanpi://LAB/device/info")).toEqual({ device: "lab", piUri: "device://info" });
  });
});

describe("mergeResources", () => {
  it("lists every device's resources under its own prefix and labels them", () => {
    const lines: string[] = [];
    const merged = mergeResources(
      [
        { device: "lab", resources: [{ uri: "device://info", name: "device_info", description: "Device facts." }, { uri: "urn:x", name: "odd" }], resourceTemplates: [] },
        { device: "field", resources: [{ uri: "device://info", name: "device_info" }], resourceTemplates: [{ uriTemplate: "services://status/{name}", name: "service_status" }] },
      ],
      { logger: createLogger("warn", (l) => lines.push(l)) },
    );
    expect(merged.resources).toEqual([
      { uri: "wlanpi://field/device/info", name: "device_info", title: "device_info (field)", description: "From WLAN Pi 'field'." },
      { uri: "wlanpi://lab/device/info", name: "device_info", title: "device_info (lab)", description: "Device facts. From WLAN Pi 'lab'." },
    ]);
    expect(merged.resourceTemplates).toEqual([
      { uriTemplate: "wlanpi://field/services/status/{name}", name: "service_status", title: "service_status (field)", description: "From WLAN Pi 'field'." },
    ]);
    expect(lines.join("")).toMatch(/Skipping resource 'urn:x' from 'lab'/);
  });
});

describe("mergePrompts", () => {
  const prompt = (name: string, args: Prompt["arguments"] = [], description = `${name} prompt`): Prompt => ({ name, description, arguments: args });

  it("adds an optional device argument with one device", () => {
    const { prompts, routes } = mergePrompts([{ device: "lab", version: "1", prompts: [prompt("health_check")] }], ["lab"]);
    expect(prompts).toEqual([
      { name: "health_check", description: "health_check prompt", arguments: [{ name: "device", description: expect.stringMatching(/defaults to 'lab'/), required: false }] },
    ]);
    expect(routes.get("health_check")).toEqual({ param: "device", devices: ["lab"] });
  });

  it("requires device with two devices, keeps arguments, and merges like tools", () => {
    const service = [{ name: "service_name", required: true }];
    const { prompts } = mergePrompts(
      [
        { device: "lab", version: "0.6.17-3", prompts: [prompt("troubleshoot_service", service), prompt("health_check")] },
        { device: "field", version: "0.7.0", prompts: [prompt("troubleshoot_service", service, "Newer wording.")] },
      ],
      ["field", "lab"],
    );
    expect(prompts.map((p) => p.name)).toEqual(["health_check", "troubleshoot_service"]);
    expect(prompts[0]?.description).toBe("health_check prompt\n\nAvailable on: lab.");
    expect(prompts[1]).toEqual({
      name: "troubleshoot_service",
      description: "Newer wording.\n\nAvailable on: field, lab.",
      arguments: [{ name: "device", description: "WLAN Pi to use: one of field, lab.", required: true }, { name: "service_name", required: true }],
    });
  });

  it("uses wlanpi_device when a prompt already has a device argument", () => {
    const { prompts, routes } = mergePrompts([{ device: "lab", version: "1", prompts: [prompt("bt", [{ name: "device" }])] }], ["lab"]);
    expect(routes.get("bt")?.param).toBe("wlanpi_device");
    expect(prompts[0]?.arguments?.map((a) => a.name)).toEqual(["wlanpi_device", "device"]);
  });
});
