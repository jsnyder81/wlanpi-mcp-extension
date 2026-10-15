import { isIPv4, isIPv6 } from "node:net";
import { ValidationError } from "./errors.js";

export interface HostPort {
  /** Lowercased hostname, IPv4 address, or IPv6 address without brackets. */
  host: string;
  /** Present only when the input named a port. */
  port?: number;
}

const HOSTNAME_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const DEVICE_NAME = /^[a-z0-9-]{1,63}$/;
const FORBIDDEN_IN_HOST = /[/\\@?#\s]/;

/**
 * Parse what a user typed as a device address: a hostname, IPv4 or IPv6 address, with
 * an optional port (`host:port`, or `[v6]:port` for IPv6). Anything URL-shaped (a
 * scheme, path, query or `user@` credentials) is rejected, because the bridge builds
 * the URL itself and must never send a token somewhere the user did not name.
 */
export function parseHost(input: string): HostPort {
  const raw = input.trim();
  if (raw === "") throw new ValidationError("Host is empty. Give a hostname or IP address, e.g. 10.0.0.5 or wlanpi-7.local.");
  if (raw.includes("://")) throw new ValidationError(`Host '${raw}' looks like a URL. Give only the hostname or IP address (and optional :port), not a scheme.`);
  if (FORBIDDEN_IN_HOST.test(raw)) {
    throw new ValidationError(`Host '${raw}' contains a path, credentials, query or whitespace. Give only the hostname or IP address (and optional :port).`);
  }

  // [v6] or [v6]:port
  const bracketed = /^\[([^\]]+)\](?::(.*))?$/.exec(raw);
  if (bracketed) {
    const [, addr = "", port] = bracketed;
    if (!isIPv6(addr)) throw new ValidationError(`'${addr}' inside brackets is not a valid IPv6 address.`);
    return withPort(checkNoZone(addr).toLowerCase(), port, raw);
  }

  // A bare IPv6 address has several colons and cannot carry a port unbracketed.
  if (isIPv6(raw)) return { host: checkNoZone(raw).toLowerCase() };
  if ((raw.match(/:/g) ?? []).length > 1) {
    throw new ValidationError(`Host '${raw}' is not a valid IPv6 address. To give an IPv6 address with a port, use brackets: [fe80::1]:8767.`);
  }

  const colon = raw.indexOf(":");
  const hostPart = colon === -1 ? raw : raw.slice(0, colon);
  const portPart = colon === -1 ? undefined : raw.slice(colon + 1);
  const host = hostPart.toLowerCase().replace(/\.$/, "");

  if (isIPv4(host)) return withPort(host, portPart, raw);
  if (/^[0-9.]+$/.test(host)) throw new ValidationError(`'${host}' is not a valid IPv4 address.`);
  if (!isHostname(host)) {
    throw new ValidationError(`'${hostPart}' is not a valid hostname. Use letters, digits, hyphens and dots, e.g. wlanpi-7.local.`);
  }
  return withPort(host, portPart, raw);
}

/** URLs cannot carry an IPv6 zone ID ("fe80::1%en0"), so the bridge cannot connect to one. */
function checkNoZone(addr: string): string {
  if (addr.includes("%")) {
    throw new ValidationError(`IPv6 zone IDs such as '${addr}' are not supported. Use the Pi's hostname or a non-link-local address.`);
  }
  return addr;
}

function isHostname(host: string): boolean {
  return host.length <= 253 && host.split(".").every((label) => HOSTNAME_LABEL.test(label));
}

function withPort(host: string, port: string | undefined, raw: string): HostPort {
  if (port === undefined) return { host };
  return { host, port: parsePort(port, raw) };
}

export function parsePort(value: string | number, context?: string): number {
  const text = String(value).trim();
  const port = /^\d{1,5}$/.test(text) ? Number(text) : NaN;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ValidationError(`Invalid port '${text}'${context ? ` in '${context}'` : ""}. A port is a number from 1 to 65535.`);
  }
  return port;
}

/** Device names are unique, lowercase `[a-z0-9-]`, at most 63 characters. */
export function isValidName(name: string): boolean {
  return DEVICE_NAME.test(name);
}

/** Lowercase and check a user-supplied device name. */
export function normalizeName(input: string): string {
  const name = input.trim().toLowerCase();
  if (!isValidName(name)) {
    throw new ValidationError(`Invalid device name '${input}'. Use 1 to 63 lowercase letters, digits and hyphens, e.g. lab or field-2.`);
  }
  return name;
}

/**
 * Default device name for a host: the first label of a hostname (`wlanpi-7.local` gives
 * `wlanpi-7`), or the address with separators turned into hyphens (`10.0.0.5` gives
 * `10-0-0-5`). A numeric suffix is added when the name is already taken.
 */
export function nameFromHost(host: string, taken: Iterable<string> = []): string {
  const used = new Set(taken);
  let base: string;
  if (isIPv4(host)) base = host.replaceAll(".", "-");
  else if (isIPv6(host)) base = host.split("%")[0]!.replaceAll(":", "-");
  else base = host.split(".")[0] ?? "";

  base = base.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
  if (base === "") base = "wlanpi";

  if (!used.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`;
    if (!used.has(candidate)) return candidate;
  }
}

export interface SeedDevice {
  name: string;
  host: string;
  port?: number;
}

export interface SeedParseResult {
  devices: SeedDevice[];
  /** One message per entry that was skipped; the other entries are still used. */
  errors: string[];
}

/**
 * Parse the `seed_devices` setting: comma-separated `name=host[:port]` entries, e.g.
 * `lab=10.0.0.5, field=wlanpi-7.local:8767`. A bare `host` is accepted too and gets a
 * name from {@link nameFromHost}. A bad entry is reported and skipped, never fatal, so
 * one typo does not stop the extension from starting.
 */
export function parseSeedDevices(value: string | undefined): SeedParseResult {
  const result: SeedParseResult = { devices: [], errors: [] };
  if (!value) return result;

  const names = new Set<string>();
  for (const entry of value.split(",").map((e) => e.trim()).filter(Boolean)) {
    try {
      const eq = entry.indexOf("=");
      const hostPort = parseHost(eq === -1 ? entry : entry.slice(eq + 1));
      const name = eq === -1 ? nameFromHost(hostPort.host, names) : normalizeName(entry.slice(0, eq));
      if (names.has(name)) throw new ValidationError(`device name '${name}' is used more than once`);
      names.add(name);
      result.devices.push({ name, ...hostPort });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      result.errors.push(`Skipped seed device '${entry}': ${reason}`);
    }
  }
  return result;
}

export interface TokenSettings {
  /** Tokens for named devices. */
  byName: Map<string, string>;
  /** A token given without a name: used for Pis that have no named token. */
  default?: string;
  /** One message per entry that was skipped. Never contains a token. */
  errors: string[];
}

/**
 * Parse the tokens setting: `name=token` pairs separated by commas, semicolons or
 * whitespace, e.g. `lab=eyJ..., field=eyJ...`. A single entry without a name is the
 * default token. wlanpi-core tokens are JWTs, which never contain `=`, `,` or spaces,
 * so the pairs cannot be misread. Messages name entries by position, never by value.
 */
export function parseTokens(value: string | undefined): TokenSettings {
  const result: TokenSettings = { byName: new Map(), errors: [] };
  if (!value) return result;
  const entries = value.split(/[\s,;]+/).filter(Boolean);
  entries.forEach((entry, index) => {
    const eq = entry.indexOf("=");
    if (eq === -1) {
      if (result.default) result.errors.push(`Ignoring token entry ${index + 1}: only one token may be given without a name; use name=token for the others.`);
      else result.default = entry;
      return;
    }
    const name = entry.slice(0, eq).trim().toLowerCase();
    const token = entry.slice(eq + 1).trim();
    if (!isValidName(name)) result.errors.push(`Ignoring token entry ${index + 1}: '${name}' is not a valid device name.`);
    else if (!token) result.errors.push(`Ignoring token entry ${index + 1}: no token after '${name}='.`);
    else if (result.byName.has(name)) result.errors.push(`Ignoring token entry ${index + 1}: '${name}' already has a token.`);
    else result.byName.set(name, token);
  });
  return result;
}
