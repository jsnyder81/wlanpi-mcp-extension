import type { Prompt, Resource, ResourceTemplate, Tool } from "@modelcontextprotocol/sdk/types.js";
import { type Logger, silentLogger } from "./log.js";

/**
 * Merging what several WLAN Pis offer into the one catalog Claude sees.
 *
 * Each distinct tool and prompt name appears once, whatever the number of devices, with
 * a routing argument (`device`) added. Resources are per device, under
 * `wlanpi://<device>/...`. This module is pure: it takes each device's catalog and the
 * registered names and returns the merged lists plus the routing tables the bridge uses
 * to dispatch requests.
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

interface Candidate<T> {
  device: string;
  version: string;
  item: T;
}

interface Picked<T> {
  name: string;
  chosen: T;
  /** Every device offering the item has the same definition. */
  identical: boolean;
  /** Devices that offer the item, sorted by name. */
  supporting: string[];
}

/**
 * Group same-named items (tools or prompts) across devices and pick the definition to
 * expose: the shared one when all devices agree, else the newest server version's
 * (ties go to the first device by name, so the choice is stable).
 */
function pickDefinitions<T extends { name: string }>(
  devices: ReadonlyArray<{ device: string; version: string; items: readonly T[] }>,
  keyOf: (item: T) => string,
  kind: string,
  reserved: ReadonlySet<string>,
  logger: Logger,
): Picked<T>[] {
  const byName = new Map<string, Candidate<T>[]>();
  for (const { device, version, items } of [...devices].sort((a, b) => a.device.localeCompare(b.device))) {
    for (const item of items) {
      if (reserved.has(item.name)) {
        logger.warn(`Ignoring ${kind} '${item.name}' from '${device}': the name is reserved by the extension.`);
        continue;
      }
      const entries = byName.get(item.name) ?? [];
      entries.push({ device, version, item });
      byName.set(item.name, entries);
    }
  }
  return [...byName.keys()].sort().map((name) => {
    const entries = byName.get(name)!;
    const identical = new Set(entries.map((e) => keyOf(e.item))).size === 1;
    const chosen = identical ? entries[0]! : [...entries].sort((a, b) => compareVersions(b.version, a.version) || a.device.localeCompare(b.device))[0]!;
    return { name, chosen: chosen.item, identical, supporting: entries.map((e) => e.device) };
  });
}

/** Append which devices offer an item when not all registered devices do, or definitions differ. */
function availability(description: string | undefined, picked: Picked<unknown>, registered: readonly string[]): string | undefined {
  const everywhere = registered.every((d) => picked.supporting.includes(d));
  if (picked.identical && everywhere) return description;
  return `${description ?? ""}${description ? "\n\n" : ""}Available on: ${picked.supporting.join(", ")}.`;
}

/** The parts of a tool definition that must match for two devices to share it as-is. */
function toolKey(tool: Tool): string {
  const { inputSchema, outputSchema, description, title, annotations } = tool;
  return canonicalJson({ inputSchema, outputSchema, description, title, annotations });
}

function promptKey(prompt: Prompt): string {
  const { description, title, arguments: args } = prompt;
  return canonicalJson({ description, title, arguments: args });
}

/** `device`, or `wlanpi_device` if the item already uses `device`; undefined if it uses both. */
function routingParamFor(kind: string, name: string, existing: readonly string[], logger: Logger): string | undefined {
  if (!existing.includes(ROUTING_PARAM)) return ROUTING_PARAM;
  if (existing.includes(FALLBACK_ROUTING_PARAM)) {
    logger.warn(`Ignoring ${kind} '${name}': it already has both '${ROUTING_PARAM}' and '${FALLBACK_ROUTING_PARAM}' arguments.`);
    return undefined;
  }
  logger.warn(`${kind[0]!.toUpperCase()}${kind.slice(1)} '${name}' already has a '${ROUTING_PARAM}' argument; its device is chosen with '${FALLBACK_ROUTING_PARAM}' instead.`);
  return FALLBACK_ROUTING_PARAM;
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
  const picked = pickDefinitions(
    devices.map((d) => ({ device: d.device, version: d.version, items: d.tools })),
    toolKey,
    "tool",
    options.reserved ?? new Set(),
    logger,
  );

  const tools: Tool[] = [];
  const routes = new Map<string, ToolRoute>();
  const required = registered.length >= 2;

  for (const entry of picked) {
    const tool = entry.chosen;
    const properties: Record<string, object> = { ...(tool.inputSchema.properties ?? {}) };
    const param = routingParamFor("tool", entry.name, Object.keys(properties), logger);
    if (!param) continue;

    const description = availability(tool.description, entry, registered);
    const existingRequired = (tool.inputSchema.required as string[] | undefined) ?? [];
    tools.push({
      ...tool,
      ...(description ? { description } : {}),
      inputSchema: {
        ...tool.inputSchema,
        type: "object",
        properties: { [param]: routingParamSchema(registered), ...properties },
        ...(required ? { required: [param, ...existingRequired] } : existingRequired.length ? { required: existingRequired } : {}),
      },
    });
    routes.set(entry.name, { param, devices: entry.supporting });
  }

  return { tools, routes };
}

export interface DevicePrompts {
  device: string;
  version: string;
  prompts: Prompt[];
}

export interface MergedPrompts {
  prompts: Prompt[];
  routes: Map<string, ToolRoute>;
}

/**
 * Merge prompts the same way as tools: one copy per name, the newest definition when
 * devices disagree, and a routing argument (prompt arguments are plain strings, so the
 * device names are listed in its description rather than as an enum).
 */
export function mergePrompts(devices: readonly DevicePrompts[], registered: readonly string[], options: { logger?: Logger } = {}): MergedPrompts {
  const logger = options.logger ?? silentLogger;
  const picked = pickDefinitions(
    devices.map((d) => ({ device: d.device, version: d.version, items: d.prompts })),
    promptKey,
    "prompt",
    new Set(),
    logger,
  );
  const prompts: Prompt[] = [];
  const routes = new Map<string, ToolRoute>();
  const only = registered.length === 1 ? registered[0] : undefined;

  for (const entry of picked) {
    const args = entry.chosen.arguments ?? [];
    const param = routingParamFor("prompt", entry.name, args.map((a) => a.name), logger);
    if (!param) continue;
    const description = availability(entry.chosen.description, entry, registered);
    prompts.push({
      ...entry.chosen,
      ...(description ? { description } : {}),
      arguments: [
        {
          name: param,
          description: only ? `WLAN Pi to use. Optional: defaults to '${only}', the only registered device.` : `WLAN Pi to use: one of ${registered.join(", ")}.`,
          required: !only,
        },
        ...args,
      ],
    });
    routes.set(entry.name, { param, devices: entry.supporting });
  }
  return { prompts, routes };
}

// ---- Resources ----------------------------------------------------------------------

export const BRIDGE_SCHEME = "wlanpi";
const PI_URI = /^([a-z][a-z0-9+.-]*):\/\/(.*)$/is;
const BRIDGE_URI = /^wlanpi:\/\/([a-z0-9-]+)\/([a-z][a-z0-9+.-]*)\/(.*)$/is;

/**
 * A Pi resource URI as the bridge exposes it: `device://info` on 'lab' becomes
 * `wlanpi://lab/device/info`. Works for templates too (`{name}` passes through).
 * Returns undefined for a URI without a `scheme://` part, which cannot be mapped.
 */
export function toBridgeUri(device: string, piUri: string): string | undefined {
  const match = PI_URI.exec(piUri);
  if (!match) return undefined;
  return `${BRIDGE_SCHEME}://${device}/${match[1]!.toLowerCase()}/${match[2]}`;
}

/** The device and original Pi URI behind a bridge URI, or undefined if it is not one. */
export function fromBridgeUri(uri: string): { device: string; piUri: string } | undefined {
  const match = BRIDGE_URI.exec(uri);
  if (!match) return undefined;
  return { device: match[1]!.toLowerCase(), piUri: `${match[2]}://${match[3]}` };
}

export interface DeviceResources {
  device: string;
  resources: Resource[];
  resourceTemplates: ResourceTemplate[];
}

function onDevice<T extends { title?: string; name: string; description?: string }>(item: T, device: string): T {
  return {
    ...item,
    title: `${item.title ?? item.name} (${device})`,
    description: `${item.description ? `${item.description} ` : ""}From WLAN Pi '${device}'.`,
  };
}

/**
 * Every device's resources and templates, under `wlanpi://<device>/...`. Unlike tools,
 * these are per device: a resource is a piece of one Pi's state, so each Pi's copy is
 * listed. Items whose URI cannot be mapped are skipped with a warning.
 */
export function mergeResources(devices: readonly DeviceResources[], options: { logger?: Logger } = {}): { resources: Resource[]; resourceTemplates: ResourceTemplate[] } {
  const logger = options.logger ?? silentLogger;
  const resources: Resource[] = [];
  const resourceTemplates: ResourceTemplate[] = [];
  for (const { device, resources: rs, resourceTemplates: ts } of [...devices].sort((a, b) => a.device.localeCompare(b.device))) {
    for (const resource of rs) {
      const uri = toBridgeUri(device, resource.uri);
      if (uri) resources.push({ ...onDevice(resource, device), uri });
      else logger.warn(`Skipping resource '${resource.uri}' from '${device}': only scheme:// URIs can be exposed.`);
    }
    for (const template of ts) {
      const uriTemplate = toBridgeUri(device, template.uriTemplate);
      if (uriTemplate) resourceTemplates.push({ ...onDevice(template, device), uriTemplate });
      else logger.warn(`Skipping resource template '${template.uriTemplate}' from '${device}': only scheme:// URIs can be exposed.`);
    }
  }
  return { resources, resourceTemplates };
}
