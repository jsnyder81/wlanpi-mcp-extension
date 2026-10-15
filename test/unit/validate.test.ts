import { describe, expect, it } from "vitest";
import { ValidationError } from "../../src/errors.js";
import { isValidName, nameFromHost, normalizeName, parseHost, parsePort, parseSeedDevices } from "../../src/validate.js";

describe("parseHost", () => {
  it.each([
    ["10.0.0.5", { host: "10.0.0.5" }],
    ["10.0.0.5:8767", { host: "10.0.0.5", port: 8767 }],
    ["  wlanpi-7.local  ", { host: "wlanpi-7.local" }],
    ["WLANPI-7.Local:443", { host: "wlanpi-7.local", port: 443 }],
    ["wlanpi.", { host: "wlanpi" }],
    ["wlanpi", { host: "wlanpi" }],
    ["fe80::1", { host: "fe80::1" }],
    ["::1", { host: "::1" }],
    ["FE80::ABCD", { host: "fe80::abcd" }],
    ["fe80::1%en0", { host: "fe80::1%en0" }],
    ["[fe80::1]", { host: "fe80::1" }],
    ["[fe80::1]:8767", { host: "fe80::1", port: 8767 }],
    ["::ffff:10.0.0.1", { host: "::ffff:10.0.0.1" }],
  ])("accepts %j", (input, expected) => {
    expect(parseHost(input)).toEqual(expected);
  });

  it.each([
    ["", /empty/],
    ["   ", /empty/],
    ["https://10.0.0.5", /URL/],
    ["https://10.0.0.5:8767/mcp", /URL/],
    ["10.0.0.5/mcp", /path/],
    ["user:pass@10.0.0.5", /credentials/],
    ["admin@wlanpi.local", /credentials/],
    ["wlanpi.local?x=1", /query/],
    ["wlanpi.local#frag", /path, credentials, query/],
    ["wlan pi", /whitespace/],
    ["10.0.0.5:0", /port/],
    ["10.0.0.5:65536", /port/],
    ["10.0.0.5:abc", /port/],
    ["10.0.0.5:", /port/],
    ["999.1.1.1", /IPv4/],
    ["1.2.3", /IPv4/],
    ["-bad.local", /hostname/],
    ["bad-.local", /hostname/],
    ["under_score.local", /hostname/],
    ["a..b", /hostname/],
    [`${"a".repeat(64)}.local`, /hostname/],
    ["fe80::1:8767:zz", /IPv6/],
    ["[10.0.0.5]:8767", /IPv6/],
    ["[fe80::1]:99999", /port/],
  ])("rejects %j", (input, message) => {
    expect(() => parseHost(input)).toThrow(ValidationError);
    expect(() => parseHost(input)).toThrow(message);
  });
});

describe("parsePort", () => {
  it("accepts 1 to 65535", () => {
    expect(parsePort("1")).toBe(1);
    expect(parsePort(65535)).toBe(65535);
  });
  it.each(["0", "65536", "-1", "1.5", "", "80a"])("rejects %j", (value) => {
    expect(() => parsePort(value)).toThrow(ValidationError);
  });
});

describe("device names", () => {
  it.each(["lab", "field-2", "10-0-0-5", "a", "a".repeat(63)])("accepts %j", (name) => {
    expect(isValidName(name)).toBe(true);
  });

  it.each(["", "Lab", "lab_1", "lab.1", "lab 1", "a".repeat(64), "../etc"])("rejects %j", (name) => {
    expect(isValidName(name)).toBe(false);
  });

  it("normalizeName lowercases and trims", () => {
    expect(normalizeName("  Lab-2 ")).toBe("lab-2");
    expect(() => normalizeName("lab/2")).toThrow(ValidationError);
  });
});

describe("nameFromHost", () => {
  it.each([
    ["wlanpi-7.local", "wlanpi-7"],
    ["10.0.0.5", "10-0-0-5"],
    ["fe80::1", "fe80-1"],
    ["fe80::1%en0", "fe80-1"],
    ["::1", "1"],
    ["WLANPI", "wlanpi"],
  ])("%s gives %s", (host, name) => {
    expect(nameFromHost(host)).toBe(name);
    expect(isValidName(nameFromHost(host))).toBe(true);
  });

  it("adds a numeric suffix on collision", () => {
    expect(nameFromHost("wlanpi.local", ["wlanpi"])).toBe("wlanpi-2");
    expect(nameFromHost("wlanpi.local", ["wlanpi", "wlanpi-2"])).toBe("wlanpi-3");
  });
});

describe("parseSeedDevices", () => {
  it("returns nothing for an empty or missing value", () => {
    expect(parseSeedDevices(undefined)).toEqual({ devices: [], errors: [] });
    expect(parseSeedDevices(" , ,")).toEqual({ devices: [], errors: [] });
  });

  it("parses name=host[:port] pairs with loose whitespace", () => {
    expect(parseSeedDevices("lab=10.0.0.5,  field = wlanpi-7.local:8767 ,v6=[fe80::1]:9000")).toEqual({
      devices: [
        { name: "lab", host: "10.0.0.5" },
        { name: "field", host: "wlanpi-7.local", port: 8767 },
        { name: "v6", host: "fe80::1", port: 9000 },
      ],
      errors: [],
    });
  });

  it("derives a name for a bare host", () => {
    expect(parseSeedDevices("wlanpi-7.local, wlanpi-7.lan").devices).toEqual([
      { name: "wlanpi-7", host: "wlanpi-7.local" },
      { name: "wlanpi-7-2", host: "wlanpi-7.lan" },
    ]);
  });

  it("skips bad entries and keeps the rest", () => {
    const result = parseSeedDevices("lab=10.0.0.5, Bad Name=10.0.0.6, x=https://10.0.0.7, lab=10.0.0.8, ok=10.0.0.9");
    expect(result.devices).toEqual([
      { name: "lab", host: "10.0.0.5" },
      { name: "ok", host: "10.0.0.9" },
    ]);
    expect(result.errors).toHaveLength(3);
    expect(result.errors[0]).toMatch(/Skipped seed device 'Bad Name=10\.0\.0\.6'.*Invalid device name/);
    expect(result.errors[1]).toMatch(/URL/);
    expect(result.errors[2]).toMatch(/'lab' is used more than once/);
  });
});
