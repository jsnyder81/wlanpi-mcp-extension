import { describe, expect, it } from "vitest";
import { add, settle, useBridgeHarness } from "../helpers/bridgeHarness.js";
import { defaultPrompts } from "../helpers/mockPi.js";

const env = useBridgeHarness();
const { pi, harness } = env;

describe("resources", () => {
  it("lists a Pi's resources and templates under wlanpi://<device>/", async () => {
    const mock = await pi();
    const h = await harness();
    await add(h, mock, "lab");

    expect((await h.client.listResources()).resources).toEqual([
      { uri: "wlanpi://lab/device/info", name: "device_info", title: "device_info (lab)", description: "From WLAN Pi 'lab'.", mimeType: "application/json" },
      { uri: "wlanpi://lab/network/interfaces", name: "interfaces", title: "interfaces (lab)", description: "From WLAN Pi 'lab'.", mimeType: "application/json" },
    ]);
    expect((await h.client.listResourceTemplates()).resourceTemplates).toEqual([
      {
        uriTemplate: "wlanpi://lab/services/status/{name}",
        name: "service_status",
        title: "service_status (lab)",
        description: "From WLAN Pi 'lab'.",
        mimeType: "application/json",
      },
    ]);
  });

  it("reads a resource and a template instance from the right Pi, with bridge URIs in the result", async () => {
    const lab = await pi();
    const field = await pi({ resources: [{ uri: "device://info", name: "device_info", mimeType: "application/json", text: '{"model":"WLAN Pi R4"}' }] });
    const h = await harness();
    await add(h, lab, "lab");
    await add(h, field, "field");

    expect((await h.client.listResources()).resources.map((r) => r.uri)).toEqual([
      "wlanpi://field/device/info",
      "wlanpi://lab/device/info",
      "wlanpi://lab/network/interfaces",
    ]);
    expect((await h.client.readResource({ uri: "wlanpi://field/device/info" })).contents).toEqual([
      { uri: "wlanpi://field/device/info", mimeType: "application/json", text: '{"model":"WLAN Pi R4"}' },
    ]);
    expect((await h.client.readResource({ uri: "wlanpi://lab/device/info" })).contents[0]).toMatchObject({ text: '{"model":"WLAN Pi M4"}' });
    expect((await h.client.readResource({ uri: "wlanpi://lab/services/status/ssh" })).contents).toEqual([
      { uri: "wlanpi://lab/services/status/ssh", mimeType: "application/json", text: '{"name":"ssh","active":true}' },
    ]);
    // Each Pi only saw its own reads and its own token.
    expect(field.requests.every((r) => r.headers.authorization === `Bearer ${field.token}`)).toBe(true);
  });

  it("explains bad URIs, unknown devices and errors from the Pi", async () => {
    const mock = await pi();
    const h = await harness();
    await add(h, mock, "lab");

    await expect(h.client.readResource({ uri: "device://info" })).rejects.toThrow(/'device:\/\/info' is not a WLAN Pi resource\. Resource URIs look like wlanpi:\/\/<device>\/device\/info\./);
    await expect(h.client.readResource({ uri: "wlanpi://lad/device/info" })).rejects.toThrow(/Unknown device 'lad'\. Registered devices: lab\./);
    await expect(h.client.readResource({ uri: "wlanpi://lab/device/nope" })).rejects.toThrow(/'lab' \(127\.0\.0\.1:\d+\) returned an error: .*Unknown resource: device:\/\/nope/);
  });

  it("lists cached resources for an offline Pi and fails reads cleanly", async () => {
    const mock = await pi();
    const first = await harness();
    await add(first, mock, "lab");
    await first.bridge.close();
    await mock.stop();

    const h = await harness();
    expect((await h.client.listResources()).resources.map((r) => r.uri)).toEqual(["wlanpi://lab/device/info", "wlanpi://lab/network/interfaces"]);
    await expect(h.client.readResource({ uri: "wlanpi://lab/device/info" })).rejects.toThrow(/Device 'lab' \(127\.0\.0\.1:\d+\) is unreachable: connection refused/);
  });

  it("follows renames and removals", async () => {
    const mock = await pi();
    const h = await harness();
    await add(h, mock, "lab");
    await h.call("rename_wlanpi", { device: "lab", new_name: "bench" });
    expect((await h.client.listResources()).resources.map((r) => r.uri)).toEqual(["wlanpi://bench/device/info", "wlanpi://bench/network/interfaces"]);
    expect((await h.client.readResource({ uri: "wlanpi://bench/device/info" })).contents[0]?.uri).toBe("wlanpi://bench/device/info");

    await h.call("remove_wlanpi", { device: "bench" });
    expect((await h.client.listResources()).resources).toEqual([]);
    expect((await h.client.listResourceTemplates()).resourceTemplates).toEqual([]);
  });
});

describe("prompts", () => {
  const servicePrompt = {
    name: "troubleshoot_service",
    description: "Troubleshoot a service.",
    arguments: [{ name: "service_name", required: true }],
    render: (args: Record<string, string>) => ({
      messages: [{ role: "user" as const, content: { type: "text" as const, text: `Check service ${args.service_name} with get_service_status.` } }],
    }),
  };

  it("lists each prompt once with a device argument", async () => {
    const a = await pi({ prompts: [...defaultPrompts(), servicePrompt] });
    const b = await pi({ prompts: [...defaultPrompts(), servicePrompt] });
    const h = await harness();
    await add(h, a, "lab");
    await add(h, b, "field");

    const prompts = (await h.client.listPrompts()).prompts;
    expect(prompts.map((p) => p.name)).toEqual(["diagnose_connectivity", "troubleshoot_service"]);
    expect(prompts[1]).toEqual({
      name: "troubleshoot_service",
      description: "Troubleshoot a service.",
      arguments: [{ name: "device", description: "WLAN Pi to use: one of field, lab.", required: true }, { name: "service_name", required: true }],
    });
  });

  it("renders a prompt from the chosen Pi and says which Pi it is about", async () => {
    const a = await pi({ prompts: [servicePrompt] });
    const b = await pi({ prompts: [servicePrompt] });
    const h = await harness();
    await add(h, a, "lab");
    await add(h, b, "field");

    const result = await h.client.getPrompt({ name: "troubleshoot_service", arguments: { device: "field", service_name: "wlanpi-core" } });
    expect(result.messages).toEqual([
      {
        role: "user",
        content: {
          type: "text",
          text: 'This is about WLAN Pi \'field\': pass device "field" to each WLAN Pi tool you call for it.\n\nCheck service wlanpi-core with get_service_status.',
        },
      },
    ]);
    expect(b.requests.some((r) => r.method === "POST")).toBe(true);
  });

  it("defaults to the only Pi, and explains missing or unknown devices", async () => {
    const mock = await pi();
    const h = await harness();
    await add(h, mock, "lab");

    const result = await h.client.getPrompt({ name: "diagnose_connectivity", arguments: {} });
    expect(result.messages[0]?.content).toMatchObject({ text: expect.stringMatching(/^This is about WLAN Pi 'lab'.*\n\nDiagnose connectivity to the internet\.$/s) });

    await expect(h.client.getPrompt({ name: "diagnose_connectivity", arguments: { device: "lad" } })).rejects.toThrow(/Unknown device 'lad'/);
    await expect(h.client.getPrompt({ name: "nope", arguments: {} })).rejects.toThrow(/Unknown prompt 'nope'/);

    const other = await pi({ prompts: [] });
    await add(h, other, "field");
    await expect(h.client.getPrompt({ name: "diagnose_connectivity", arguments: {} })).rejects.toThrow(/needs a 'device' argument naming the WLAN Pi to use: one of field, lab/);
    await expect(h.client.getPrompt({ name: "diagnose_connectivity", arguments: { device: "field" } })).rejects.toThrow(
      /Device 'field' \(wlanpi-mcp 0\.6\.17-3\) does not have the prompt 'diagnose_connectivity'\. It is available on: lab\./,
    );
  });
});

describe("list_changed", () => {
  it("is not sent for resources or prompts when only an unrelated list changes", async () => {
    const a = await pi();
    const b = await pi({ resources: [], resourceTemplates: [], prompts: [] });
    const h = await harness();
    await add(h, a, "lab");
    await settle();
    const before = { ...h.changes };

    // A second Pi with no resources still changes the device enum (tools, prompts) but
    // not the resource list.
    await add(h, b, "field");
    await settle();
    expect(h.changes.resources).toBe(before.resources);
    expect(h.changes.tools).toBe(before.tools + 1);
    expect(h.changes.prompts).toBe(before.prompts + 1);
  });
});
