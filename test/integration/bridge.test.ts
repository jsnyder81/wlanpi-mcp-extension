import type { CallToolResult, ElicitResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import { Registry } from "../../src/registry.js";
import { MANAGEMENT, add, data, hostOf, settle, textOf, useBridgeHarness } from "../helpers/bridgeHarness.js";
import { type MockTool, defaultTools } from "../helpers/mockPi.js";

const env = useBridgeHarness();
const { pi, harness } = env;

describe("adding a WLAN Pi (trust on first use)", () => {
  it("pins the certificate, checks MCP, saves the device and exposes its tools", async () => {
    const mock = await pi();
    const h = await harness();

    const added = await add(h, mock, "lab");

    expect(added).toMatchObject({
      name: "lab",
      host: "127.0.0.1",
      port: mock.port,
      status: "ready",
      token_verified: true,
      trust: "pinned",
      certificate: { fingerprint_sha256: mock.cert.fingerprint256, subject: "CN=wlanpi", self_signed: true },
      server: { name: "wlanpi-mcp", version: "0.6.17-3" },
      tool_count: 5,
      registered_devices: ["lab"],
    });
    expect((added.next_steps as string[])[0]).toMatch(/openssl x509 .* -fingerprint -sha256/);
    expect(h.registry.get("lab")).toMatchObject({ cert_sha256: mock.cert.fingerprint256, token: mock.token, port: mock.port });

    expect(await h.piToolNames()).toEqual(["echo", "fails", "fetch_pcap_file", "get_device_info", "slow"]);
    // Single device: no device argument needed.
    const info = await h.call("get_device_info");
    expect(info.structuredContent).toEqual({ model: "WLAN Pi M4" });
    expect(mock.requests.every((r) => r.headers.authorization === `Bearer ${mock.token}`)).toBe(true);
  });

  it("accepts the port as an argument and derives a name from the host", async () => {
    const mock = await pi();
    const h = await harness();
    const added = data(await h.call("add_wlanpi", { host: "127.0.0.1", port: mock.port, token: mock.token }));
    expect(added.name).toBe("127-0-0-1");
  });

  it("saves a Pi without a token as needs_token, and set_wlanpi_token completes it", async () => {
    const mock = await pi();
    const h = await harness();

    const added = await add(h, mock, "lab", null);
    expect(added.status).toBe("needs_token");
    expect((added.next_steps as string[])[1]).toMatch(/No token is set for 'lab'.*getjwt/);
    expect(await h.piToolNames()).toEqual([]);

    expect(data(await h.call("set_wlanpi_token", { device: "lab", token: "wrong" }))).toMatchObject({ status: "rejected", error: expect.stringMatching(/rejected its token/) });
    expect(data(await h.call("set_wlanpi_token", { device: "lab", token: mock.token }))).toEqual({ name: "lab", status: "accepted", tool_count: 5 });
    expect(await h.piToolNames()).toHaveLength(5);
    expect(JSON.stringify(await h.call("list_wlanpis"))).not.toContain(mock.token);
  });

  it("checks the token against wlanpi-core, since any token passes initialize", async () => {
    const mock = await pi();
    const h = await harness();

    const added = await add(h, mock, "lab", "expired-token");
    expect(added).toMatchObject({ status: "needs_token", token_verified: false });
    expect((added.next_steps as string[])[1]).toMatch(/rejected its token \(wlanpi-core returned 401\).*set_wlanpi_token/);
    // The Pi answered tools/list, so its tools are listed anyway.
    expect(await h.piToolNames()).toHaveLength(5);

    // A call that reaches core keeps the Pi's error and adds what to do.
    const call = await h.call("echo", { message: "x" });
    expect(call.isError).toBe(true);
    expect(call.content).toEqual([
      { type: "text", text: "Error executing tool echo: wlanpi-core returned 401: Unauthorized" },
      { type: "text", text: expect.stringMatching(/^'lab' \(127\.0\.0\.1:\d+\) rejected its token .*sudo getjwt claude/) },
    ]);

    const listed = data(await h.call("list_wlanpis"));
    expect(listed.devices).toEqual([expect.objectContaining({ reachable: true, token_valid: false, needs_token: true })]);

    expect(data(await h.call("set_wlanpi_token", { device: "lab", token: mock.token })).status).toBe("accepted");
    expect(data(await h.call("list_wlanpis")).devices).toEqual([expect.objectContaining({ token_valid: true })]);
    expect(textOf(await h.call("echo", { message: "ok" }))).toBe("ok");
  });

  it("reports ready with an unverified token when the Pi lacks the check tool", async () => {
    const mock = await pi({ tools: defaultTools().filter((t) => t.name !== "get_device_info") });
    const h = await harness();
    const added = await add(h, mock, "lab");
    expect(added).toMatchObject({ status: "ready", token_verified: false });
    expect((added.next_steps as string[]).at(-1)).toMatch(/The token could not be checked/);
  });

  it("uses default_token when add_wlanpi gets no token", async () => {
    const mock = await pi();
    const h = await harness({ defaultToken: mock.token });
    expect((await add(h, mock, "lab", null)).status).toBe("ready");
  });

  it("refuses bad input and duplicates with clear messages", async () => {
    const mock = await pi();
    const h = await harness();
    await add(h, mock, "lab");

    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [{ host: `https://${hostOf(mock)}/mcp` }, /looks like a URL/],
      [{ host: `admin@${hostOf(mock)}` }, /credentials/],
      [{}, /'host' is required/],
      [{ host: hostOf(mock), name: "other" }, /already registered as 'lab'/],
      [{ host: "127.0.0.1:1", name: "lab" }, /A device named 'lab' is already registered/],
      [{ host: "127.0.0.1:1", name: "Bad Name" }, /Invalid device name/],
      [{ host: `127.0.0.1:${mock.port}`, port: 1 }, /Give the port once/],
    ];
    for (const [args, message] of cases) {
      const result = await h.call("add_wlanpi", args);
      expect(result.isError, JSON.stringify(args)).toBe(true);
      expect(textOf(result)).toMatch(message);
    }
    expect(h.registry.names()).toEqual(["lab"]);
  });

  it("does not save a host that is not answering", async () => {
    const mock = await pi();
    await mock.stop();
    const h = await harness();
    const result = await h.call("add_wlanpi", { host: hostOf(mock), name: "lab" });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/^Device 'lab' \(127\.0\.0\.1:\d+\) is unreachable: connection refused/);
    expect(h.registry.names()).toEqual([]);
  });

  it("does not save a host that serves TLS but not wlanpi-mcp", async () => {
    const mock = await pi({ path: "/elsewhere" });
    const h = await harness();
    const result = await h.call("add_wlanpi", { host: hostOf(mock), name: "lab", token: mock.token });
    expect(textOf(result)).toMatch(/no MCP endpoint at \/mcp \(HTTP 404\)/);
    expect(h.registry.names()).toEqual([]);
  });
});

describe("changed certificates", () => {
  it("asks the user to confirm a new certificate when the client supports elicitation", async () => {
    const mock = await pi();
    const prompts: string[] = [];
    let answer: ElicitResult = { action: "decline" };
    const h = await harness({}, { elicit: (message) => (prompts.push(message), answer) });
    await add(h, mock, "lab");
    const original = mock.cert.fingerprint256;
    const fresh = await mock.swapCert();

    expect(data(await h.call("trust_wlanpi_cert", { device: "lab", fingerprint: fresh.fingerprint256 }))).toMatchObject({ status: "declined" });
    expect(prompts[0]).toContain(`It now presents SHA-256 fingerprint ${fresh.fingerprint256}`);
    expect(h.registry.get("lab")?.cert_sha256).toBe(original);

    answer = { action: "accept", content: { matches: false } };
    expect(data(await h.call("trust_wlanpi_cert", { device: "lab", fingerprint: fresh.fingerprint256 }))).toMatchObject({ status: "declined" });

    answer = { action: "accept", content: { matches: true } };
    expect(data(await h.call("trust_wlanpi_cert", { device: "lab", fingerprint: fresh.fingerprint256 }))).toMatchObject({ status: "trusted" });
    expect(h.registry.get("lab")?.cert_sha256).toBe(fresh.fingerprint256);
  });

  it("treats a failed confirmation as a no", async () => {
    const mock = await pi();
    const h = await harness(
      {},
      {
        elicit: () => {
          throw new Error("no UI");
        },
      },
    );
    await add(h, mock, "lab");
    const original = mock.cert.fingerprint256;
    const fresh = await mock.swapCert();
    expect(data(await h.call("trust_wlanpi_cert", { device: "lab", fingerprint: fresh.fingerprint256 }))).toMatchObject({ status: "declined" });
    expect(h.registry.get("lab")?.cert_sha256).toBe(original);
  });

  it("refuses calls until the new certificate is explicitly trusted", async () => {
    const mock = await pi();
    const h = await harness();
    await add(h, mock, "lab");
    const original = mock.cert.fingerprint256;
    const fresh = await mock.swapCert();
    await settle();

    let refused = await h.call("echo", { message: "x" });
    if (!/Certificate for/.test(textOf(refused))) refused = await h.call("echo", { message: "x" });
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toContain(`Certificate for 'lab' changed: it no longer matches the pinned fingerprint ${original}.`);
    // The presented fingerprint must come from the user reading the Pi, so it is not shown.
    expect(textOf(refused)).not.toContain(fresh.fingerprint256);
    const callsBefore = mock.calls.length;

    // The old pin, or any other value, is refused and nothing changes.
    for (const wrong of [original, "AB".repeat(32)]) {
      const result = await h.call("trust_wlanpi_cert", { device: "lab", fingerprint: wrong });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toMatch(/does not match the certificate 'lab' .* presents now\. Nothing was changed/);
      expect(textOf(result)).not.toContain(fresh.fingerprint256);
    }
    expect(h.registry.get("lab")?.cert_sha256).toBe(original);
    expect(textOf(await h.call("trust_wlanpi_cert", { device: "lab", fingerprint: "not hex" }))).toMatch(/is not a SHA-256 fingerprint/);

    const trusted = data(await h.call("trust_wlanpi_cert", { device: "lab", fingerprint: fresh.fingerprint256.toLowerCase().replaceAll(":", "") }));
    expect(trusted).toMatchObject({ name: "lab", status: "trusted", previous_fingerprint_sha256: original, certificate: { fingerprint_sha256: fresh.fingerprint256 }, tool_count: 5 });
    expect(h.registry.get("lab")?.cert_sha256).toBe(fresh.fingerprint256);

    expect(textOf(await h.call("echo", { message: "back" }))).toBe("back");
    expect(mock.calls.length).toBe(callsBefore + 1);

    expect(data(await h.call("trust_wlanpi_cert", { device: "lab", fingerprint: fresh.fingerprint256 })).status).toBe("unchanged");
  });
});

describe("several WLAN Pis", () => {
  const newerTools = (): MockTool[] => [
    ...defaultTools().filter((t) => t.name !== "fails" && t.name !== "echo"),
    {
      name: "echo",
      description: "Return the arguments, louder.",
      inputSchema: { type: "object", properties: { message: { type: "string" }, upper: { type: "boolean" } }, required: ["message"] },
      handler: (args) => ({ content: [{ type: "text", text: args.upper ? String(args.message).toUpperCase() : String(args.message) }] }),
    },
    { name: "scan_wlan", description: "Scan for Wi-Fi networks.", inputSchema: { type: "object", properties: {} }, handler: () => ({ content: [{ type: "text", text: "3 networks" }] }) },
  ];

  it("merges tools once, newest schema wins, and routes by device", async () => {
    const older = await pi({ version: "0.6.17-3", token: "tok-old" });
    const newer = await pi({ version: "0.7.0", token: "tok-new", tools: newerTools() });
    const h = await harness();
    await add(h, older, "bench");
    await add(h, newer, "field");

    const tools = (await h.client.listTools()).tools;
    const piTools = tools.filter((t) => !MANAGEMENT.includes(t.name));
    expect(piTools.map((t) => t.name)).toEqual(["echo", "fails", "fetch_pcap_file", "get_device_info", "scan_wlan", "slow"]);

    const echo = piTools.find((t) => t.name === "echo")!;
    expect(echo.inputSchema.required).toEqual(["device", "message"]);
    expect(echo.inputSchema.properties?.device).toMatchObject({ description: expect.stringContaining("one of bench, field") });
    expect(echo.inputSchema.properties).toHaveProperty("upper");
    expect(echo.description).toBe("Return the arguments, louder.\n\nAvailable on: bench, field.");
    expect(piTools.find((t) => t.name === "scan_wlan")?.description).toBe("Scan for Wi-Fi networks.\n\nAvailable on: field.");
    expect(piTools.find((t) => t.name === "get_device_info")?.description).toBe("Get WLAN Pi device information.");

    // The same tool on both devices in one turn.
    expect(textOf(await h.call("echo", { device: "bench", message: "hi" }))).toBe("hi");
    expect(textOf(await h.call("echo", { device: "field", message: "hi", upper: true }))).toBe("HI");
    const echoes = (mock: typeof older) => mock.calls.filter((c) => c.name === "echo");
    expect(echoes(older)).toEqual([{ name: "echo", arguments: { message: "hi" } }]);
    expect(echoes(newer)).toEqual([{ name: "echo", arguments: { message: "hi", upper: true } }]);
    // Each device only ever saw its own token.
    expect(older.requests.every((r) => r.headers.authorization === "Bearer tok-old")).toBe(true);
    expect(newer.requests.every((r) => r.headers.authorization === "Bearer tok-new")).toBe(true);

    const missing = await h.call("fails", { device: "field" });
    expect(missing.isError).toBe(true);
    expect(textOf(missing)).toBe(
      "Device 'field' (wlanpi-mcp 0.7.0) does not have the tool 'fails'. It is available on: bench. Updating wlanpi-mcp on 'field' may add it.",
    );
    expect(textOf(await h.call("scan_wlan", { device: "bench" }))).toMatch(/^Device 'bench' \(wlanpi-mcp 0\.6\.17-3\) does not have the tool 'scan_wlan'/);
  });

  it("requires device with two Pis and names the choices", async () => {
    const a = await pi();
    const b = await pi();
    const h = await harness();
    await add(h, a, "lab");
    await add(h, b, "field");

    expect(textOf(await h.call("echo", { message: "x" }))).toBe("Tool 'echo' needs a 'device' argument naming the WLAN Pi to use: one of field, lab.");
    expect(textOf(await h.call("echo", { device: "lad", message: "x" }))).toBe("Unknown device 'lad'. Registered devices: field, lab.");
    expect(textOf(await h.call("echo", { device: 7, message: "x" }))).toMatch(/must be the name of a WLAN Pi/);
  });

  it("keeps the tool list the same size however many Pis are added", async () => {
    const h = await harness();
    const sizes: number[] = [];
    for (const name of ["one", "two", "three"]) {
      const mock = await pi();
      await add(h, mock, name);
      sizes.push((await h.client.listTools()).tools.length);
    }
    expect(sizes).toEqual([MANAGEMENT.length + 5, MANAGEMENT.length + 5, MANAGEMENT.length + 5]);
  });

  it("routes with wlanpi_device when a Pi tool has its own device argument", async () => {
    const mock = await pi({
      tools: [
        {
          name: "bt_pair",
          description: "Pair a Bluetooth device.",
          inputSchema: { type: "object", properties: { device: { type: "string", description: "Bluetooth MAC" } }, required: ["device"] },
          handler: (args) => ({ content: [{ type: "text", text: `paired ${String(args.device)}` }] }),
        },
      ],
    });
    const other = await pi();
    const h = await harness();
    await add(h, mock, "lab");
    await add(h, other, "field");

    const bt = (await h.client.listTools()).tools.find((t) => t.name === "bt_pair")!;
    expect(bt.inputSchema.required).toEqual(["wlanpi_device", "device"]);
    expect(textOf(await h.call("bt_pair", { wlanpi_device: "lab", device: "AA:BB:CC:DD:EE:FF" }))).toBe("paired AA:BB:CC:DD:EE:FF");
    expect(mock.calls.filter((c) => c.name === "bt_pair")).toEqual([{ name: "bt_pair", arguments: { device: "AA:BB:CC:DD:EE:FF" } }]);
  });
});

describe("passthrough", () => {
  it("returns tool errors, structured content and binary blobs unchanged", async () => {
    const mock = await pi();
    const h = await harness();
    await add(h, mock, "lab");

    expect(await h.call("fails")).toEqual({ content: [{ type: "text", text: "Service 'x' is not in the allowlist" }], isError: true });
    const blob = await h.call("fetch_pcap_file");
    const item = blob.content[0];
    expect(item?.type === "resource" && "blob" in item.resource && Buffer.from(item.resource.blob, "base64")).toEqual(Buffer.from([0x0a, 0x0d, 0x0d, 0x0a, 0, 1, 2, 255]));
    expect(item?.type === "resource" && item.resource.mimeType).toBe("application/vnd.tcpdump.pcapng");
  });

  it("forwards progress notifications from a Pi that streams them", async () => {
    const mock = await pi({ jsonResponse: false });
    const h = await harness();
    await add(h, mock, "lab");
    const progress: number[] = [];
    const result = await h.client.callTool({ name: "slow", arguments: { ms: 200 } }, undefined, { onprogress: (p) => progress.push(p.progress) });
    expect((result as CallToolResult).content).toEqual([{ type: "text", text: "waited 200 ms" }]);
    expect(progress).toEqual([1, 2, 3, 4]);
  });
});

describe("offline devices", () => {
  it("advertises cached tools at startup and fails calls cleanly while a Pi is offline", async () => {
    const mock = await pi();
    const first = await harness();
    await add(first, mock, "lab");
    await first.bridge.close();
    await mock.stop();

    const h = await harness();
    expect(await h.piToolNames()).toEqual(["echo", "fails", "fetch_pcap_file", "get_device_info", "slow"]);

    const result = await h.call("get_device_info");
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/^Device 'lab' \(127\.0\.0\.1:\d+\) is unreachable: connection refused/);

    const listed = data(await h.call("list_wlanpis"));
    expect(listed.devices).toEqual([
      expect.objectContaining({ name: "lab", reachable: false, server_version: "0.6.17-3", tool_count: 5, error: expect.stringMatching(/unreachable/) }),
    ]);

    // Back online: the probe in list_wlanpis clears the backoff and calls work again.
    await mock.start();
    expect(data(await h.call("list_wlanpis")).devices).toEqual([expect.objectContaining({ name: "lab", reachable: true, server_version: "0.6.17-3" })]);
    expect((await h.call("get_device_info")).structuredContent).toEqual({ model: "WLAN Pi M4" });
  });
});

describe("registry changes", () => {
  it("announces tools/list_changed on real changes only", async () => {
    const a = await pi();
    const b = await pi();
    const h = await harness();

    await add(h, a, "lab");
    await settle();
    expect(h.changes).toEqual({ tools: 1, resources: 1, prompts: 1 });

    await h.bridge.refreshAll();
    await settle();
    expect(h.changes).toEqual({ tools: 1, resources: 1, prompts: 1 });

    await add(h, b, "field");
    await settle();
    expect(h.changes).toEqual({ tools: 2, resources: 2, prompts: 2 });

    data(await h.call("remove_wlanpi", { device: "field" }));
    await settle();
    expect(h.changes).toEqual({ tools: 3, resources: 3, prompts: 3 });
  });

  it("renames and removes devices", async () => {
    const a = await pi();
    const b = await pi();
    const h = await harness();
    await add(h, a, "lab");
    await add(h, b, "field");

    expect(data(await h.call("rename_wlanpi", { device: "lab", new_name: "Bench" }))).toEqual({ old_name: "lab", name: "bench", registered_devices: ["bench", "field"] });
    const echo = (await h.client.listTools()).tools.find((t) => t.name === "echo")!;
    expect(echo.inputSchema.properties?.device).toMatchObject({ description: expect.stringContaining("one of bench, field") });
    expect(textOf(await h.call("echo", { device: "bench", message: "renamed" }))).toBe("renamed");
    expect(a.calls.at(-1)).toEqual({ name: "echo", arguments: { message: "renamed" } });
    expect(textOf(await h.call("rename_wlanpi", { device: "bench", new_name: "field" }))).toMatch(/already registered/);

    expect(data(await h.call("remove_wlanpi", { device: "field" }))).toEqual({ removed: "field", registered_devices: ["bench"] });
    expect(textOf(await h.call("remove_wlanpi", { device: "field" }))).toBe("Unknown device 'field'. Registered devices: bench.");
    data(await h.call("remove_wlanpi", { device: "bench" }));
    expect(await h.piToolNames()).toEqual([]);
  });

  it("picks up a device another extension process added", async () => {
    const mock = await pi();
    const h = await harness();
    const elsewhere = await Registry.open(env.dir);
    await elsewhere.add({ name: "lab", host: "127.0.0.1", port: mock.port, cert_sha256: mock.cert.fingerprint256, token: mock.token });

    const listed = data(await h.call("list_wlanpis"));
    expect(listed.devices).toEqual([expect.objectContaining({ name: "lab", reachable: true })]);
    await h.bridge.refreshDevice("lab");
    expect(await h.piToolNames()).toHaveLength(5);
  });
});

describe("seeded devices", () => {
  it("adds seed_devices with default_token on start, and only once", async () => {
    const mock = await pi();
    const h = await harness({ seedDevices: `lab=${hostOf(mock)}, broken=https://nope`, defaultToken: mock.token });
    await h.bridge.start();

    // The token from settings is used for the seeded host but never written to disk.
    expect(h.registry.get("lab")).toMatchObject({ cert_sha256: mock.cert.fingerprint256, token: null });
    expect(h.registry.names()).toEqual(["lab"]);
    expect(await h.piToolNames()).toHaveLength(5);
    expect(data(await h.call("list_wlanpis")).devices).toEqual([expect.objectContaining({ name: "lab", token_set: true, token_valid: true })]);

    await h.bridge.start();
    expect(h.registry.names()).toEqual(["lab"]);
  });

  it("skips an unreachable seed and keeps starting", async () => {
    const mock = await pi();
    await mock.stop();
    const h = await harness({ seedDevices: `lab=${hostOf(mock)}` });
    await h.bridge.start();
    expect(h.registry.names()).toEqual([]);
  });
});

describe("last_seen", () => {
  it("is kept in memory while running and written once on close", async () => {
    const mock = await pi();
    const h = await harness();
    await add(h, mock, "lab");
    await h.call("echo", { message: "x" });
    const listed = data(await h.call("list_wlanpis")).devices as Array<{ last_seen: string | null }>;
    expect(listed[0]?.last_seen).toEqual(expect.any(String));
    expect((await Registry.open(env.dir)).get("lab")?.last_seen).toBeNull();

    await h.bridge.close();
    const written = (await Registry.open(env.dir)).get("lab")?.last_seen;
    expect(written && written >= listed[0]!.last_seen!).toBe(true);
  });
});
