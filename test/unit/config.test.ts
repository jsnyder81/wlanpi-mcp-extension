import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_CALL_TIMEOUT_MS, loadConfig, resolveConfigDir } from "../../src/config.js";

const HOME = "/home/pi";

describe("resolveConfigDir", () => {
  it("honours WLANPI_BRIDGE_CONFIG_DIR on every platform", () => {
    for (const platform of ["darwin", "linux", "win32"] as const) {
      expect(resolveConfigDir({ WLANPI_BRIDGE_CONFIG_DIR: "/tmp/x" }, platform, HOME)).toBe("/tmp/x");
    }
  });

  it("uses Application Support on macOS", () => {
    expect(resolveConfigDir({}, "darwin", HOME)).toBe(join(HOME, "Library", "Application Support", "wlanpi-mcp-bridge"));
  });

  it("uses APPDATA on Windows, with a fallback", () => {
    expect(resolveConfigDir({ APPDATA: "C:\\Users\\pi\\AppData\\Roaming" }, "win32", HOME)).toBe(
      join("C:\\Users\\pi\\AppData\\Roaming", "wlanpi-mcp-bridge"),
    );
    expect(resolveConfigDir({}, "win32", HOME)).toBe(join(HOME, "AppData", "Roaming", "wlanpi-mcp-bridge"));
  });

  it("uses XDG_CONFIG_HOME on Linux, ignoring relative values", () => {
    expect(resolveConfigDir({ XDG_CONFIG_HOME: "/xdg" }, "linux", HOME)).toBe(join("/xdg", "wlanpi-mcp-bridge"));
    expect(resolveConfigDir({ XDG_CONFIG_HOME: "relative" }, "linux", HOME)).toBe(join(HOME, ".config", "wlanpi-mcp-bridge"));
    expect(resolveConfigDir({}, "linux", HOME)).toBe(join(HOME, ".config", "wlanpi-mcp-bridge"));
  });
});

describe("loadConfig", () => {
  it("has sensible defaults", () => {
    const config = loadConfig({}, "linux", HOME);
    expect(config).toMatchObject({ logLevel: "info", callTimeoutMs: DEFAULT_CALL_TIMEOUT_MS, warnings: [] });
    expect(config.seedDevices).toBeUndefined();
    expect(config.defaultToken).toBeUndefined();
    expect(config.caFile).toBeUndefined();
  });

  it("reads every setting", () => {
    const config = loadConfig(
      {
        WLANPI_BRIDGE_LOG_LEVEL: "DEBUG",
        WLANPI_BRIDGE_CALL_TIMEOUT_MS: "120000",
        WLANPI_BRIDGE_SEED_DEVICES: "lab=10.0.0.5",
        WLANPI_BRIDGE_TOKENS: "lab=abc",
        WLANPI_BRIDGE_DEFAULT_TOKEN: "abc",
        WLANPI_BRIDGE_CA_FILE: "/ca.pem",
      },
      "linux",
      HOME,
    );
    expect(config).toMatchObject({
      logLevel: "debug",
      callTimeoutMs: 120_000,
      seedDevices: "lab=10.0.0.5",
      tokens: "lab=abc",
      defaultToken: "abc",
      caFile: "/ca.pem",
      warnings: [],
    });
  });

  it("treats blank values and unexpanded ${user_config.x} placeholders as unset", () => {
    const config = loadConfig(
      {
        WLANPI_BRIDGE_SEED_DEVICES: "${user_config.seed_devices}",
        WLANPI_BRIDGE_DEFAULT_TOKEN: "  ",
        WLANPI_BRIDGE_CA_FILE: "",
      },
      "linux",
      HOME,
    );
    expect(config.seedDevices).toBeUndefined();
    expect(config.defaultToken).toBeUndefined();
    expect(config.caFile).toBeUndefined();
  });

  it("warns about and ignores bad log levels and timeouts", () => {
    const config = loadConfig({ WLANPI_BRIDGE_LOG_LEVEL: "loud", WLANPI_BRIDGE_CALL_TIMEOUT_MS: "-5" }, "linux", HOME);
    expect(config.logLevel).toBe("info");
    expect(config.callTimeoutMs).toBe(DEFAULT_CALL_TIMEOUT_MS);
    expect(config.warnings).toHaveLength(2);
    expect(loadConfig({ WLANPI_BRIDGE_CALL_TIMEOUT_MS: "0" }, "linux", HOME).warnings).toHaveLength(1);
  });
});
