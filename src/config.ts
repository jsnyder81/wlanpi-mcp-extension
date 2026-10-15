import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { type LogLevel, parseLogLevel } from "./log.js";

/** wlanpi-mcp's TLS listener (nginx on the Pi). The plaintext port is never used. */
export const DEFAULT_PORT = 8767;
export const DEFAULT_PATH = "/mcp";
/**
 * Default tool call timeout. Longer than the spec's 60 s on purpose: the Pi's speedtest
 * waits up to 180 s, and a 60 s capture_scan needs time on top of its capture window.
 */
export const DEFAULT_CALL_TIMEOUT_MS = 300_000;

/** Directory name under the per-user config root, kept from the original spec. */
export const CONFIG_DIR_NAME = "wlanpi-mcp-bridge";

export interface BridgeConfig {
  configDir: string;
  logLevel: LogLevel;
  callTimeoutMs: number;
  /** Raw `seed_devices` value; parsed with parseSeedDevices. */
  seedDevices?: string;
  /** Token applied to seeded devices. */
  defaultToken?: string;
  /** CA file used instead of TOFU pinning for every device without its own. */
  caFile?: string;
  /** Problems found while reading the environment, logged at startup. */
  warnings: string[];
}

type Env = Record<string, string | undefined>;

/**
 * Per-user config directory: `WLANPI_BRIDGE_CONFIG_DIR` if set, else
 * macOS `~/Library/Application Support/wlanpi-mcp-bridge`,
 * Windows `%APPDATA%\wlanpi-mcp-bridge`,
 * Linux and others `$XDG_CONFIG_HOME/wlanpi-mcp-bridge` (falling back to `~/.config`).
 */
export function resolveConfigDir(env: Env = process.env, platform: NodeJS.Platform = process.platform, home: string = homedir()): string {
  const override = setting(env, "WLANPI_BRIDGE_CONFIG_DIR");
  if (override) return override;
  if (platform === "darwin") return join(home, "Library", "Application Support", CONFIG_DIR_NAME);
  if (platform === "win32") return join(setting(env, "APPDATA") ?? join(home, "AppData", "Roaming"), CONFIG_DIR_NAME);
  const xdg = setting(env, "XDG_CONFIG_HOME");
  // The XDG spec says a relative XDG_CONFIG_HOME is invalid and must be ignored.
  return join(xdg && isAbsolute(xdg) ? xdg : join(home, ".config"), CONFIG_DIR_NAME);
}

/**
 * Read one setting. Empty strings count as unset, and so does an unexpanded
 * `${user_config.x}` placeholder, which is what a host may pass through when the user
 * left an optional extension setting blank.
 */
function setting(env: Env, key: string): string | undefined {
  const value = env[key]?.trim();
  if (!value || /^\$\{[^}]*\}$/.test(value)) return undefined;
  return value;
}

export function loadConfig(env: Env = process.env, platform: NodeJS.Platform = process.platform, home: string = homedir()): BridgeConfig {
  const warnings: string[] = [];

  const rawLevel = setting(env, "WLANPI_BRIDGE_LOG_LEVEL");
  let logLevel = parseLogLevel(rawLevel);
  if (!logLevel) {
    if (rawLevel) warnings.push(`Ignoring WLANPI_BRIDGE_LOG_LEVEL='${rawLevel}'; use error, warn, info or debug.`);
    logLevel = "info";
  }

  const rawTimeout = setting(env, "WLANPI_BRIDGE_CALL_TIMEOUT_MS");
  let callTimeoutMs = DEFAULT_CALL_TIMEOUT_MS;
  if (rawTimeout) {
    const parsed = /^\d+$/.test(rawTimeout) ? Number(rawTimeout) : NaN;
    if (Number.isSafeInteger(parsed) && parsed > 0) callTimeoutMs = parsed;
    else warnings.push(`Ignoring WLANPI_BRIDGE_CALL_TIMEOUT_MS='${rawTimeout}'; it must be a positive whole number of milliseconds.`);
  }

  return {
    configDir: resolveConfigDir(env, platform, home),
    logLevel,
    callTimeoutMs,
    seedDevices: setting(env, "WLANPI_BRIDGE_SEED_DEVICES"),
    defaultToken: setting(env, "WLANPI_BRIDGE_DEFAULT_TOKEN"),
    caFile: setting(env, "WLANPI_BRIDGE_CA_FILE"),
    warnings,
  };
}
