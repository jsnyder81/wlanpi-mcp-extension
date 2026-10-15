import { promises as fs } from "node:fs";
import { createServer as createTcpServer, type AddressInfo, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DeviceConnection, type DeviceConnectionOptions, type DeviceTarget, trustFor } from "../../src/device.js";
import { DeviceError } from "../../src/errors.js";
import { caSignedCert } from "../helpers/certs.js";
import { type MockPi, type MockPiOptions, startMockPi } from "../helpers/mockPi.js";

const cleanup: Array<() => Promise<unknown>> = [];

afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!().catch(() => {});
});

async function pi(options: MockPiOptions = {}): Promise<MockPi> {
  const mock = await startMockPi(options);
  cleanup.push(() => mock.close());
  return mock;
}

function targetFor(mock: MockPi, overrides: Partial<DeviceTarget> = {}): DeviceTarget {
  return { name: "lab", host: "127.0.0.1", port: mock.port, path: "/mcp", token: mock.token, trust: { kind: "pin", fingerprint: mock.cert.fingerprint256 }, ...overrides };
}

function connection(target: DeviceTarget, options: DeviceConnectionOptions = {}): DeviceConnection {
  const conn = new DeviceConnection(target, options);
  cleanup.push(() => conn.close());
  return conn;
}

async function failure(promise: Promise<unknown>): Promise<DeviceError> {
  const err = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(DeviceError);
  return err as DeviceError;
}

describe("DeviceConnection against a mock Pi", () => {
  it("connects lazily, calls a tool and sends the token on every request", async () => {
    const mock = await pi();
    const contacts: unknown[] = [];
    const conn = connection(targetFor(mock), { onContact: (info) => contacts.push(info) });

    expect(conn.connected).toBe(false);
    expect(mock.requests).toHaveLength(0);

    const result = await conn.callTool("echo", { message: "hello" });

    expect(result.content).toEqual([{ type: "text", text: "hello" }]);
    expect(conn.serverInfo).toEqual({ name: "wlanpi-mcp", version: "0.6.17-3" });
    expect(mock.calls).toEqual([{ name: "echo", arguments: { message: "hello" } }]);
    expect(mock.requests.length).toBeGreaterThan(0);
    expect(mock.requests.every((r) => r.headers.authorization === `Bearer ${mock.token}`)).toBe(true);
    expect(contacts.length).toBeGreaterThanOrEqual(2);
  });

  it("reuses one client for later calls", async () => {
    const mock = await pi();
    const conn = connection(targetFor(mock));
    await conn.callTool("echo", { message: "1" });
    const before = mock.requests.filter((r) => r.method === "POST").length;
    await conn.callTool("echo", { message: "2" });
    // One POST for the call, no new initialize.
    expect(mock.requests.filter((r) => r.method === "POST").length - before).toBe(1);
  });

  it("fetches the whole catalog", async () => {
    const mock = await pi({ version: "0.7.0" });
    const catalog = await connection(targetFor(mock)).fetchCatalog();

    expect(catalog.serverInfo.version).toBe("0.7.0");
    expect(catalog.tools.map((t) => t.name)).toEqual(["get_device_info", "echo", "slow", "fetch_pcap_file", "fails"]);
    expect(catalog.tools[1]?.inputSchema).toEqual({ type: "object", properties: { message: { type: "string" } }, required: ["message"] });
    expect(catalog.resources.map((r) => r.uri)).toEqual(["device://info", "network://interfaces"]);
    expect(catalog.resourceTemplates.map((r) => r.uriTemplate)).toEqual(["services://status/{name}"]);
    expect(catalog.prompts.map((p) => p.name)).toEqual(["diagnose_connectivity"]);
    expect(Date.parse(catalog.fetched_at)).not.toBeNaN();
  });

  it("skips resources and prompts when the Pi does not offer them", async () => {
    const mock = await pi({ resources: [], resourceTemplates: [], prompts: [] });
    const catalog = await connection(targetFor(mock)).fetchCatalog();
    expect(catalog.capabilities.resources).toBeUndefined();
    expect(catalog.resources).toEqual([]);
    expect(catalog.prompts).toEqual([]);
  });

  it("returns results unchanged: structured content, tool errors and binary blobs", async () => {
    const mock = await pi();
    const conn = connection(targetFor(mock));

    expect(await conn.callTool("get_device_info", {})).toEqual({
      content: [{ type: "text", text: '{"model":"WLAN Pi M4"}' }],
      structuredContent: { model: "WLAN Pi M4" },
    });
    expect(await conn.callTool("fails", {})).toEqual({ content: [{ type: "text", text: "Service 'x' is not in the allowlist" }], isError: true });

    const blob = await conn.callTool("fetch_pcap_file", {});
    const item = blob.content[0];
    expect(item?.type).toBe("resource");
    expect(item?.type === "resource" && "blob" in item.resource && Buffer.from(item.resource.blob, "base64")).toEqual(Buffer.from([0x0a, 0x0d, 0x0d, 0x0a, 0, 1, 2, 255]));
  });

  it("reads resources and renders prompts", async () => {
    const mock = await pi();
    const conn = connection(targetFor(mock));
    expect((await conn.readResource("device://info")).contents).toEqual([{ uri: "device://info", mimeType: "application/json", text: '{"model":"WLAN Pi M4"}' }]);
    expect((await conn.readResource("services://status/ssh")).contents[0]).toMatchObject({ text: '{"name":"ssh","active":true}' });
    expect((await conn.getPrompt("diagnose_connectivity", { target: "8.8.8.8" })).messages[0]?.content).toEqual({
      type: "text",
      text: "Diagnose connectivity to 8.8.8.8.",
    });
  });

  it("reports a JSON-RPC error from the Pi as a remote error and keeps the client", async () => {
    const mock = await pi();
    const conn = connection(targetFor(mock));
    const err = await failure(conn.readResource("device://nope"));
    expect(err.kind).toBe("remote");
    expect(err.message).toMatch(/^'lab' \(127\.0\.0\.1:\d+\) returned an error: .*Unknown resource: device:\/\/nope/);
    expect(conn.connected).toBe(true);
  });

  it("forwards progress notifications when the Pi streams them", async () => {
    const mock = await pi({ jsonResponse: false });
    const progress: number[] = [];
    await connection(targetFor(mock)).callTool("slow", { ms: 200 }, { onprogress: (p) => progress.push(p.progress) });
    expect(progress).toEqual([1, 2, 3, 4]);
  });

  it("stops waiting when the caller aborts", async () => {
    const mock = await pi();
    const conn = connection(targetFor(mock));
    const controller = new AbortController();
    const call = conn.callTool("slow", { ms: 5000 }, { signal: controller.signal });
    setTimeout(() => controller.abort(), 100);
    await expect(call).rejects.toThrow();
  });

  it("times out a slow tool call with an actionable message", async () => {
    const mock = await pi();
    const conn = connection(targetFor(mock), { callTimeoutMs: 300 });
    const err = await failure(conn.callTool("slow", { ms: 3000 }));
    expect(err.kind).toBe("timeout");
    expect(err.message).toMatch(/^Tool call 'slow' on 'lab' \(127\.0\.0\.1:\d+\) timed out after 0\.3s\. It may still be running on the Pi\./);
    // A slow call is not a connection problem: the client is kept and the next call works.
    expect(conn.connected).toBe(true);
    expect((await conn.callTool("echo", { message: "still here" })).content).toEqual([{ type: "text", text: "still here" }]);
  });

  it("lets a per-call timeout override the default", async () => {
    const mock = await pi();
    const conn = connection(targetFor(mock), { callTimeoutMs: 100 });
    expect((await conn.callTool("slow", { ms: 300 }, { timeoutMs: 5000 })).content).toEqual([{ type: "text", text: "waited 300 ms" }]);
  });

  describe("authentication", () => {
    it("explains a missing token", async () => {
      const mock = await pi();
      const err = await failure(connection(targetFor(mock, { token: null })).callTool("echo", { message: "x" }));
      expect(err.kind).toBe("auth");
      expect(err.message).toMatch(/^No token is set for 'lab'/);
      expect(mock.requests.every((r) => r.headers.authorization === undefined)).toBe(true);
    });

    it("explains a token rejected with HTTP 401, without backing off", async () => {
      const mock = await pi({ auth: "http" });
      const conn = connection(targetFor(mock, { token: "expired" }));
      const err = await failure(conn.callTool("echo", { message: "x" }));
      expect(err.kind).toBe("auth");
      expect(err.message).toMatch(/rejected its token \(HTTP 401\).*set_wlanpi_token/);
      expect(conn.backoffRemainingMs).toBe(0);

      const before = mock.requests.length;
      await failure(conn.callTool("echo", { message: "x" }));
      expect(mock.requests.length).toBeGreaterThan(before);
    });

    it("verifies a token through wlanpi-core", async () => {
      const mock = await pi();
      expect(await connection(targetFor(mock)).verifyToken()).toEqual({ status: "valid" });

      const bad = await connection(targetFor(mock, { token: "expired" })).verifyToken();
      expect(bad.status).toBe("rejected");
      expect(bad.status === "rejected" && bad.error.message).toMatch(/rejected its token \(wlanpi-core returned 401\)/);

      expect((await connection(targetFor(mock, { token: null })).verifyToken()).status).toBe("rejected");

      await mock.stop();
      expect((await connection(targetFor(mock)).verifyToken()).status).toBe("unknown");
    });

    it("sends each device only its own token", async () => {
      const a = await pi({ token: "token-a" });
      const b = await pi({ token: "token-b" });
      await connection(targetFor(a, { name: "a" })).callTool("echo", { message: "a" });
      await connection(targetFor(b, { name: "b" })).callTool("echo", { message: "b" });
      expect(a.requests.every((r) => r.headers.authorization === "Bearer token-a")).toBe(true);
      expect(b.requests.every((r) => r.headers.authorization === "Bearer token-b")).toBe(true);
    });
  });

  describe("certificates", () => {
    it("refuses a reimaged Pi's new certificate without sending a request", async () => {
      const mock = await pi();
      const conn = connection(targetFor(mock));
      await conn.callTool("echo", { message: "before" });
      const old = mock.cert.fingerprint256;
      const fresh = await mock.swapCert();
      const before = mock.requests.length;

      // The swap drops the open keep-alive connection, as a reboot would. Depending on
      // timing the first call may see that closed socket; either way it must not hide
      // the certificate problem behind a backoff.
      let err = await failure(conn.callTool("echo", { message: "after" }));
      if (err.kind === "unreachable") {
        expect(conn.backoffRemainingMs).toBe(0);
        err = await failure(conn.callTool("echo", { message: "after" }));
      }

      expect(err.kind).toBe("cert-mismatch");
      expect(err.message).toContain(`Certificate for 'lab' changed. Pinned ${old}, presented ${fresh.fingerprint256}.`);
      expect(mock.requests.length).toBe(before);
      expect(conn.connected).toBe(false);
    });

    it("validates against a CA file in CA mode", async () => {
      const { ca, leaf } = await caSignedCert();
      const mock = await pi({ cert: leaf });
      const dir = await fs.mkdtemp(join(tmpdir(), "wlanpi-ca-"));
      cleanup.push(() => fs.rm(dir, { recursive: true, force: true }));
      const caFile = join(dir, "ca.pem");
      await fs.writeFile(caFile, ca.cert);

      const trust = await trustFor({ name: "lab", ca_file: caFile, cert_sha256: null });
      expect((await connection(targetFor(mock, { host: "localhost", trust })).callTool("echo", { message: "ca" })).content).toEqual([{ type: "text", text: "ca" }]);

      const err = await failure(connection(targetFor(mock, { host: "127.0.0.1", trust: { kind: "ca", ca: (await caSignedCert()).ca.cert } })).callTool("echo", { message: "x" }));
      expect(err.kind).toBe("tls");
    });
  });

  describe("reachability and backoff", () => {
    it("reports a stopped Pi as unreachable quickly", async () => {
      const mock = await pi();
      await mock.stop();
      const started = Date.now();
      const err = await failure(connection(targetFor(mock)).callTool("echo", { message: "x" }));
      expect(err.kind).toBe("unreachable");
      expect(err.message).toMatch(/^Device 'lab' \(127\.0\.0\.1:\d+\) is unreachable: connection refused\./);
      expect(Date.now() - started).toBeLessThan(5000);
    });

    it("times out a connection that never completes the handshake", async () => {
      const silent = await startSilentServer();
      cleanup.push(silent.close);
      const target: DeviceTarget = { name: "lab", host: "127.0.0.1", port: silent.port, path: "/mcp", token: "t", trust: { kind: "pin", fingerprint: "AB".repeat(32) } };
      const started = Date.now();
      const err = await failure(connection(target, { connectTimeoutMs: 300 }).callTool("echo", {}));
      expect(err.kind).toBe("unreachable");
      expect(err.message).toMatch(/is unreachable: (connection timed out after 0\.3s|no MCP response within 0\.3s)\./);
      expect(Date.now() - started).toBeLessThan(3000);
    });

    it("backs off after failures, fails fast meanwhile, and recovers", async () => {
      const mock = await pi();
      let now = 1_000_000;
      const conn = connection(targetFor(mock), { now: () => now, random: () => 0.5 });
      await mock.stop();

      await failure(conn.callTool("echo", {}));
      expect(conn.backoffRemainingMs).toBe(1000);

      // Inside the window: no connection attempt, the last error plus when it retries.
      const fast = await failure(conn.callTool("echo", {}));
      expect(fast.kind).toBe("unreachable");
      expect(fast.message).toMatch(/connection refused\..* Next retry in 1s\.$/);

      now += 1000;
      await failure(conn.callTool("echo", {}));
      expect(conn.backoffRemainingMs).toBe(2000);
      now += 2000;
      await failure(conn.callTool("echo", {}));
      expect(conn.backoffRemainingMs).toBe(4000);

      await mock.start();
      // Still inside the window, so a normal call fails fast even though the Pi is back...
      await failure(conn.callTool("echo", {}));
      // ...but a probe ignores the backoff, and its success clears it.
      const probe = await conn.probe();
      expect(probe).toMatchObject({ ok: true, serverInfo: { name: "wlanpi-mcp", version: "0.6.17-3" } });
      expect(conn.backoffRemainingMs).toBe(0);
      expect((await conn.callTool("echo", { message: "back" })).content).toEqual([{ type: "text", text: "back" }]);
    });

    it("drops the client when the Pi goes away mid-session and reconnects later", async () => {
      const mock = await pi();
      const conn = connection(targetFor(mock));
      await conn.callTool("echo", { message: "1" });

      await mock.stop();
      expect((await failure(conn.callTool("echo", { message: "2" }))).kind).toBe("unreachable");
      expect(conn.connected).toBe(false);
      // Losing an established connection does not start the backoff by itself.
      expect(conn.backoffRemainingMs).toBe(0);

      await mock.start();
      expect((await conn.callTool("echo", { message: "3" })).content).toEqual([{ type: "text", text: "3" }]);
    });

    it("probes report failures without throwing", async () => {
      const mock = await pi();
      await mock.stop();
      const probe = await connection(targetFor(mock)).probe(500);
      expect(probe.ok).toBe(false);
      expect(probe.error?.kind).toBe("unreachable");
    });

    it("probes a connected client with a ping", async () => {
      const mock = await pi();
      const conn = connection(targetFor(mock));
      await conn.callTool("echo", { message: "x" });
      const before = mock.requests.length;
      expect((await conn.probe()).ok).toBe(true);
      expect(mock.requests.length).toBe(before + 1);
    });

    it("explains a wrong MCP path", async () => {
      const mock = await pi();
      const err = await failure(connection(targetFor(mock, { path: "/wrong" })).callTool("echo", {}));
      expect(err.kind).toBe("protocol");
      expect(err.message).toMatch(/has no MCP endpoint at \/wrong \(HTTP 404\)/);
    });
  });
});

async function startSilentServer(): Promise<{ port: number; close: () => Promise<void> }> {
  const sockets = new Set<Socket>();
  const tcp = createTcpServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
  });
  await new Promise<void>((resolve) => tcp.listen(0, "127.0.0.1", resolve));
  return {
    port: (tcp.address() as AddressInfo).port,
    close: () =>
      new Promise((resolve) => {
        for (const s of sockets) s.destroy();
        tcp.close(() => resolve());
      }),
  };
}
