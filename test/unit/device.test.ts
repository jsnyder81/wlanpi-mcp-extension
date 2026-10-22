import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import { BACKOFF_MAX_MS, type DeviceTarget, MAX_LIST_PAGES, allPages, backoffDelay, deviceLabel, deviceUrl, toDeviceError, trustFor } from "../../src/device.js";
import { CertMismatchError, DeviceError } from "../../src/errors.js";

const PIN = "AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89";
const target: DeviceTarget = { name: "lab", host: "10.0.0.5", port: 8767, path: "/mcp", token: "t", trust: { kind: "pin", fingerprint: PIN } };
const connect = { kind: "connect" as const, timeoutMs: 5000 };
const call = { kind: "call" as const, what: "Tool call 'scan_wlan'", timeoutMs: 300_000 };

const fetchFailed = (code: string, message = code) =>
  Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error(message), { code }) });

describe("deviceLabel and deviceUrl", () => {
  it("shows the port only when it is not the default", () => {
    expect(deviceLabel(target)).toBe("'lab' (10.0.0.5)");
    expect(deviceLabel({ ...target, port: 9000 })).toBe("'lab' (10.0.0.5:9000)");
    expect(deviceLabel({ ...target, host: "fe80::1", port: 9000 })).toBe("'lab' ([fe80::1]:9000)");
  });

  it("builds an https URL, bracketing IPv6", () => {
    expect(deviceUrl(target).href).toBe("https://10.0.0.5:8767/mcp");
    expect(deviceUrl({ ...target, host: "wlanpi-7.local" }).href).toBe("https://wlanpi-7.local:8767/mcp");
    expect(deviceUrl({ ...target, host: "fe80::1" }).href).toBe("https://[fe80::1]:8767/mcp");
  });
});

describe("backoffDelay", () => {
  it("doubles from 1 s up to the 30 s cap", () => {
    const mid = () => 0.5;
    expect([1, 2, 3, 4, 5, 6, 7, 10].map((n) => backoffDelay(n, mid))).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000]);
  });

  it("jitters by at most 20% and never exceeds the cap", () => {
    expect(backoffDelay(1, () => 0)).toBe(800);
    expect(backoffDelay(1, () => 1)).toBe(1200);
    expect(backoffDelay(20, () => 1)).toBe(BACKOFF_MAX_MS);
  });
});

describe("toDeviceError", () => {
  it("passes a DeviceError through", () => {
    const err = new DeviceError("auth", "lab", "x");
    expect(toDeviceError(err, target, call)).toBe(err);
  });

  it("finds a certificate mismatch anywhere in the cause chain", () => {
    const mismatch = new CertMismatchError(PIN, "12:34", "lab");
    const err = toDeviceError(Object.assign(new TypeError("fetch failed"), { cause: mismatch }), target, connect);
    expect(err.kind).toBe("cert-mismatch");
    expect(err.message).toBe(mismatch.message);
  });

  it.each([
    ["ECONNREFUSED", "Device 'lab' (10.0.0.5) is unreachable: connection refused. Check that wlanpi-mcp is installed and that the port is open."],
    ["ENOTFOUND", "Device 'lab' (10.0.0.5) is unreachable: the hostname could not be resolved."],
    ["EHOSTUNREACH", "Device 'lab' (10.0.0.5) is unreachable: no route to host."],
    ["UND_ERR_CONNECT_TIMEOUT", "Device 'lab' (10.0.0.5) is unreachable: connection timed out after 5s."],
  ])("maps %s to an unreachable message", (code, message) => {
    const err = toDeviceError(fetchFailed(code), target, connect);
    expect(err.kind).toBe("unreachable");
    expect(err.message).toBe(message);
  });

  it("maps 401 with and without a token", () => {
    expect(toDeviceError(new StreamableHTTPError(401, "x"), target, connect).message).toBe(
      "'lab' (10.0.0.5) rejected its token (HTTP 401): it is expired, revoked or wrong. " +
        "On the Pi run 'sudo getjwt claude', then call set_wlanpi_token with the new access_token.",
    );
    const noToken = toDeviceError(new StreamableHTTPError(401, "x"), { ...target, token: null }, connect);
    expect(noToken.kind).toBe("auth");
    expect(noToken.message).toMatch(/^No token is set for 'lab' \(10\.0\.0\.5\)\./);
  });

  it("maps 404 and gateway errors to protocol errors that name the fix", () => {
    expect(toDeviceError(new StreamableHTTPError(404, "x"), target, connect).message).toMatch(/no MCP endpoint at \/mcp \(HTTP 404\)/);
    const bad = toDeviceError(new StreamableHTTPError(502, "x"), target, connect);
    expect(bad.kind).toBe("protocol");
    expect(bad.message).toMatch(/systemctl status wlanpi-mcp/);
  });

  it("tells a connect timeout from a slow tool call", () => {
    const timeout = new McpError(ErrorCode.RequestTimeout, "Request timed out");
    expect(toDeviceError(timeout, target, connect)).toMatchObject({
      kind: "unreachable",
      message: "Device 'lab' (10.0.0.5) is unreachable: no MCP response within 5s.",
    });
    expect(toDeviceError(timeout, target, call)).toMatchObject({
      kind: "timeout",
      message: expect.stringMatching(/^Tool call 'scan_wlan' on 'lab' \(10\.0\.0\.5\) timed out after 300s\. .*WLANPI_BRIDGE_CALL_TIMEOUT_MS/),
    });
  });

  it("reports JSON-RPC errors from the Pi as remote errors", () => {
    const err = toDeviceError(new McpError(ErrorCode.InvalidParams, "bad args"), target, call);
    expect(err).toMatchObject({ kind: "remote", message: "'lab' (10.0.0.5) returned an error: MCP error -32602: bad args" });
  });

  it("maps TLS verification failures, with a hint in CA mode", () => {
    const err = toDeviceError(fetchFailed("UNABLE_TO_VERIFY_LEAF_SIGNATURE", "unable to verify the first certificate"), { ...target, trust: { kind: "ca", ca: "x" } }, connect);
    expect(err.kind).toBe("tls");
    expect(err.message).toBe("TLS with 'lab' (10.0.0.5) failed: unable to verify the first certificate. The certificate did not validate against the configured CA file.");
  });

  it("falls back to the full cause chain for anything else", () => {
    const err = toDeviceError(Object.assign(new Error("outer"), { cause: new Error("inner") }), target, connect);
    expect(err).toMatchObject({ kind: "protocol", message: "Unexpected error talking to 'lab' (10.0.0.5): outer: inner" });
  });
});

describe("trustFor", () => {
  it("prefers the device CA file, then the global one, then the pin", async () => {
    const dir = await fs.mkdtemp(join(tmpdir(), "wlanpi-trust-"));
    const own = join(dir, "own.pem");
    const global = join(dir, "global.pem");
    await fs.writeFile(own, "OWN");
    await fs.writeFile(global, "GLOBAL");
    try {
      const record = { name: "lab", ca_file: own, cert_sha256: PIN };
      expect(await trustFor(record, global)).toEqual({ kind: "ca", ca: Buffer.from("OWN") });
      expect(await trustFor({ ...record, ca_file: null }, global)).toEqual({ kind: "ca", ca: Buffer.from("GLOBAL") });
      expect(await trustFor({ ...record, ca_file: null })).toEqual({ kind: "pin", fingerprint: PIN });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("explains a missing CA file or a missing pin", async () => {
    await expect(trustFor({ name: "lab", ca_file: "/nope/ca.pem", cert_sha256: null })).rejects.toThrow(/Cannot read the CA file for 'lab' \(\/nope\/ca\.pem\)/);
    await expect(trustFor({ name: "lab", ca_file: null, cert_sha256: null })).rejects.toThrow(/has no pinned certificate/);
  });
});

describe("allPages", () => {
  it("follows cursors to the end", async () => {
    const pages: Record<string, { items: number[]; nextCursor?: string }> = { "": { items: [1], nextCursor: "a" }, a: { items: [2], nextCursor: "b" }, b: { items: [3] } };
    expect(await allPages(async (params) => pages[params?.cursor ?? ""]!, (p) => p.items)).toEqual([1, 2, 3]);
  });

  it("stops on a repeated cursor or after MAX_LIST_PAGES", async () => {
    expect(await allPages(async () => ({ items: [1], nextCursor: "same" }), (p) => p.items)).toEqual([1, 1]);
    let n = 0;
    const items = await allPages(async () => ({ items: [n], nextCursor: String(n++) }), (p) => p.items);
    expect(items).toHaveLength(MAX_LIST_PAGES);
  });
});
