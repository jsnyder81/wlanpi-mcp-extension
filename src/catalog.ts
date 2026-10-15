import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { type Logger, silentLogger } from "./log.js";

/**
 * Merging the tool lists of several WLAN Pis into the one list Claude sees.
 *
 * Each distinct tool name appears once, whatever the number of devices, with a routing
 * argument (`device`) added to its input schema. This module is pure: it takes each
 * device's tools and the registered names and returns the merged list plus the routing
 * table the bridge uses to dispatch calls.
 */

export const ROUTING_PARAM = "device";
export const FALLBACK_ROUTING_PARAM = "wlanpi_device";

export interface DeviceTools {
  device: string;
  /** serverInfo.version, used to pick the newest schema when devices disagree. */
  version: string;
  tools: Tool[];
}

export interface ToolRoute {
  /** The argument that names the device: `device`, or `wlanpi_device` if the tool already has a `device` argument. */
  param: string;
  /** Devices that offer this tool, sorted by name. */
  devices: string[];
}

export interface MergedTools {
  tools: Tool[];
  routes: Map<string, ToolRoute>;
}

/**
 * Compare version strings like `0.6.17-3` or `0.7.0`. Numeric parts compare as numbers,
 * other parts as text; a version with an extra part is newer (`0.6.17-3` > `0.6.17`).
 */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.\-+~]/);
  const pb = b.split(/[.\-+~]/);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i];
    const y = pb[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const nx = /^\d+$/.test(x) ? Number(x) : NaN;
    const ny = /^\d+$/.test(y) ? Number(y) : NaN;
    const diff = !Number.isNaN(nx) && !Number.isNaN(ny) ? nx - ny : x.localeCompare(y);
    if (diff !== 0) return Math.sign(diff);
  }
  return 0;
}

/** JSON with object keys sorted, so equal schemas compare equal regardless of key order. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0)))
      : v,
  );
}

/** The parts of a tool definition that must match for two devices to share it as-is. */
function definitionKey(tool: Tool): string {
  const { inputSchema, outputSchema, description, title, annotations } = tool;
  return canonicalJson({ inputSchema, outputSchema, description, title, annotations });
}

export function routingParamSchema(registered: readonly string[]): Record<string, unknown> {
  const only = registered.length === 1 ? registered[0] : undefined;
  return {
    type: "string",
    enum: [...registered],
    description: only
      ? `WLAN Pi to run this on. Optional: defaults to '${only}', the only registered device.`
      : `WLAN Pi to run this on: one of ${registered.join(", ")}. Use list_wlanpis to see them.`,
    ...(only ? { default: only } : {}),
  };
}

/**
 * Merge the tools of every device.
 *
 * - Identical definitions on every device are exposed as-is.
 * - When definitions differ, the one from the device with the newest server version wins.
 * - When not every registered device offers a tool (or definitions differ), the
 *   description ends with the devices that do.
 * - The routing argument is required with 2+ registered devices and optional (defaulting
 *   to the only one) with exactly one.
 * - Tools whose names are reserved (the bridge's own management tools) are dropped.
 */
export function mergeTools(
  devices: readonly DeviceTools[],
  registered: readonly string[],
  options: { reserved?: ReadonlySet<string>; logger?: Logger } = {},
): MergedTools {
  const logger = options.logger ?? silentLogger;
  const reserved = options.reserved ?? new Set<string>();
  const byName = new Map<string, Array<{ device: string; version: string; tool: Tool }>>();

  for (const { device, version, tools } of [...devices].sort((a, b) => a.device.localeCompare(b.device))) {
    for (const tool of tools) {
      if (reserved.has(tool.name)) {
        logger.warn(`Ignoring tool '${tool.name}' from '${device}': the name is reserved by the extension.`);
        continue;
      }
      const entries = byName.get(tool.name) ?? [];
      entries.push({ device, version, tool });
      byName.set(tool.name, entries);
    }
  }

  const tools: Tool[] = [];
  const routes = new Map<string, ToolRoute>();
  const required = registered.length >= 2;

  for (const name of [...byName.keys()].sort()) {
    const entries = byName.get(name)!;
    const identical = new Set(entries.map((e) => definitionKey(e.tool))).size === 1;
    // Newest version wins; on a tie, the first device by name, so the choice is stable.
    const chosen = identical ? entries[0]! : [...entries].sort((a, b) => compareVersions(b.version, a.version) || a.device.localeCompare(b.device))[0]!;
    const supporting = entries.map((e) => e.device);

    const properties: Record<string, object> = { ...(chosen.tool.inputSchema.properties ?? {}) };
    let param = ROUTING_PARAM;
    if (param in properties) {
      param = FALLBACK_ROUTING_PARAM;
      logger.warn(`Tool '${name}' already has a '${ROUTING_PARAM}' argument; its device is chosen with '${param}' instead.`);
      if (param in properties) {
        logger.warn(`Ignoring tool '${name}': it already has both '${ROUTING_PARAM}' and '${FALLBACK_ROUTING_PARAM}' arguments.`);
        continue;
      }
    }

    const everywhere = registered.every((d) => supporting.includes(d));
    let description = chosen.tool.description ?? "";
    if (!identical || !everywhere) {
      description = `${description}${description ? "\n\n" : ""}Available on: ${supporting.join(", ")}.`;
    }

    const existingRequired = (chosen.tool.inputSchema.required as string[] | undefined) ?? [];
    tools.push({
      ...chosen.tool,
      ...(description ? { description } : {}),
      inputSchema: {
        ...chosen.tool.inputSchema,
        type: "object",
        properties: { [param]: routingParamSchema(registered), ...properties },
        ...(required ? { required: [param, ...existingRequired] } : existingRequired.length ? { required: existingRequired } : {}),
      },
    });
    routes.set(name, { param, devices: supporting });
  }

  return { tools, routes };
}
