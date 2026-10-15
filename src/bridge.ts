import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import {
  type CallToolResult,
  CallToolRequestSchema,
  ErrorCode,
  GetPromptRequestSchema,
  type GetPromptResult,
  ListPromptsRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ReadResourceRequestSchema,
  type ReadResourceResult,
  type Resource,
  type ResourceTemplate,
  type ServerNotification,
  type ServerRequest,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import {
  type MergedPrompts,
  type MergedTools,
  type ToolRoute,
  canonicalJson,
  fromBridgeUri,
  mergePrompts,
  mergeResources,
  mergeTools,
  toBridgeUri,
} from "./catalog.js";
import { type BridgeConfig, DEFAULT_PATH, DEFAULT_PORT } from "./config.js";
import {
  DEFAULT_PROBE_TIMEOUT_MS,
  type DeviceCatalog,
  DeviceConnection,
  type DeviceConnectionOptions,
  type DeviceTarget,
  deviceLabel,
  isCoreAuthFailure,
  toDeviceError,
  tokenRejectedMessage,
  trustFor,
} from "./device.js";
import { DeviceError, DuplicateDeviceError, UnknownDeviceError, ValidationError } from "./errors.js";
import { type Logger, silentLogger } from "./log.js";
import type { DeviceRecord, Registry } from "./registry.js";
import { DEFAULT_CONNECT_TIMEOUT_MS, type PeerCert, fetchPeerCert, fingerprintsEqual, normalizeFingerprint } from "./tls.js";
import { type TokenSettings, nameFromHost, normalizeName, parseHost, parsePort, parseSeedDevices, parseTokens } from "./validate.js";
import { NAME, VERSION } from "./version.js";

type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>;
type Args = Record<string, unknown>;

export const PI_CERT_COMMAND = "openssl x509 -in /etc/nginx/ssl/self-signed-wlanpi.cert -noout -fingerprint -sha256";
const TOKEN_COMMAND = "sudo getjwt claude";
/** last_seen is written at most this often per device, not on every call. */
const TOUCH_INTERVAL_MS = 60_000;
/**
 * How long the first list requests wait for seeded and never-fetched Pis. Some clients
 * (Claude Desktop) read the lists once when the extension starts and ignore later
 * list_changed notifications, so tools added a few seconds later would never be seen.
 */
export const STARTUP_WAIT_MS = 8_000;

const INSTRUCTIONS = `This extension connects to one or more WLAN Pi devices running wlanpi-mcp.
Register a Pi with add_wlanpi (hostname or IP), and show the user the certificate fingerprint it returns so they can compare it with the Pi.
Every WLAN Pi tool takes a 'device' argument naming the Pi to run on (see list_wlanpis). With one registered Pi it is optional.
To run the same tool on several Pis, call it once per device.
Each Pi's resources are listed under wlanpi://<device>/..., and prompts take a 'device' argument too.
If a Pi's tools are missing from your tool list (some clients only read it when the extension starts), use list_wlanpi_tools to see them and call_wlanpi_tool to run one.`;

const deviceArg = { type: "string", description: "Name of a registered WLAN Pi (see list_wlanpis)." };

export const MANAGEMENT_TOOLS: Tool[] = [
  {
    name: "add_wlanpi",
    title: "Add a WLAN Pi",
    description:
      "Register a WLAN Pi so its tools can be used. Connects to it, pins its TLS certificate (trust on first use) and checks that wlanpi-mcp answers. " +
      "Returns the certificate's SHA-256 fingerprint: show it to the user so they can compare it with the Pi " +
      `(on the Pi: ${PI_CERT_COMMAND}). wlanpi-mcp needs a token from wlanpi-core; get one on the Pi with '${TOKEN_COMMAND}'. ` +
      "Without a token the Pi is still registered and set_wlanpi_token can add one later.",
    inputSchema: {
      type: "object",
      properties: {
        host: { type: "string", description: "Hostname or IP address, optionally with :port, e.g. 10.0.0.5 or wlanpi-7.local. Not a URL." },
        name: { type: "string", description: "Short name for the device (lowercase letters, digits, hyphens). Defaults to one derived from the host." },
        port: { type: "integer", minimum: 1, maximum: 65535, description: `HTTPS port of wlanpi-mcp. Default ${DEFAULT_PORT}.` },
        token: { type: "string", description: "wlanpi-core access token (JWT) for this Pi." },
      },
      required: ["host"],
    },
    annotations: { title: "Add a WLAN Pi", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  {
    name: "list_wlanpis",
    title: "List WLAN Pis",
    description: "List the registered WLAN Pis with a quick reachability check: name, host, whether it answers, its wlanpi-mcp version, when it was last seen, and whether a token is set.",
    inputSchema: { type: "object", properties: {} },
    annotations: { title: "List WLAN Pis", readOnlyHint: true, openWorldHint: true },
  },
  {
    name: "remove_wlanpi",
    title: "Remove a WLAN Pi",
    description: "Forget a registered WLAN Pi, including its pinned certificate and token.",
    inputSchema: { type: "object", properties: { device: deviceArg }, required: ["device"] },
    annotations: { title: "Remove a WLAN Pi", readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "rename_wlanpi",
    title: "Rename a WLAN Pi",
    description: "Change the name a registered WLAN Pi is known by.",
    inputSchema: {
      type: "object",
      properties: { device: deviceArg, new_name: { type: "string", description: "New name (lowercase letters, digits, hyphens)." } },
      required: ["device", "new_name"],
    },
    annotations: { title: "Rename a WLAN Pi", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "trust_wlanpi_cert",
    title: "Trust a WLAN Pi's new certificate",
    description:
      "Re-pin a WLAN Pi's TLS certificate after it legitimately changed (for example the Pi was reimaged). " +
      "The fingerprint must be the one the Pi presents now, as the user read it on the Pi " +
      `(${PI_CERT_COMMAND}). Never pass a fingerprint the user has not confirmed.`,
    inputSchema: {
      type: "object",
      properties: { device: deviceArg, fingerprint: { type: "string", description: "SHA-256 fingerprint of the Pi's current certificate, e.g. AB:CD:..." } },
      required: ["device", "fingerprint"],
    },
    annotations: { title: "Trust a WLAN Pi's new certificate", readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  },
  {
    name: "set_wlanpi_token",
    title: "Set a WLAN Pi's token",
    description: `Set or replace the wlanpi-core access token (JWT) used for a WLAN Pi, e.g. after it expired. Get a new one on the Pi with '${TOKEN_COMMAND}'. The new token is tested right away.`,
    inputSchema: {
      type: "object",
      properties: { device: deviceArg, token: { type: "string", description: "wlanpi-core access token (JWT)." } },
      required: ["device", "token"],
    },
    annotations: { title: "Set a WLAN Pi's token", readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  },
  {
    name: "list_wlanpi_tools",
    title: "List a WLAN Pi's tools",
    description:
      "List the tools a WLAN Pi offers, with a short summary of each and whether it is read-only or destructive. Give 'tool' to get one tool's full description and input schema. " +
      "Use this with call_wlanpi_tool when the Pi's tools are not in your tool list.",
    inputSchema: {
      type: "object",
      properties: {
        device: { ...deviceArg, description: "Name of a registered WLAN Pi. Optional when only one is registered." },
        tool: { type: "string", description: "Name of one tool to describe in full." },
      },
    },
    annotations: { title: "List a WLAN Pi's tools", readOnlyHint: true, openWorldHint: true },
  },
  {
    name: "call_wlanpi_tool",
    title: "Run a WLAN Pi tool",
    description:
      "Run any tool a WLAN Pi offers, by name, and return its result unchanged. Use it when the tool you need is not in your tool list (see list_wlanpi_tools for names and arguments). " +
      "Some Pi tools change the device (for example reboot_device, stop_service): check the tool's read_only and destructive flags from list_wlanpi_tools and ask the user before running a destructive one.",
    inputSchema: {
      type: "object",
      properties: {
        device: { ...deviceArg, description: "Name of a registered WLAN Pi. Optional when only one is registered." },
        tool: { type: "string", description: "Name of the Pi tool to run, e.g. get_device_info." },
        arguments: { type: "object", description: "Arguments for the Pi tool, as listed in its input schema.", additionalProperties: true },
      },
      required: ["tool"],
    },
    annotations: { title: "Run a WLAN Pi tool", readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  },
];

const RESERVED = new Set(MANAGEMENT_TOOLS.map((t) => t.name));

export interface BridgeOptions {
  registry: Registry;
  config: Pick<BridgeConfig, "callTimeoutMs" | "caFile" | "tokens" | "defaultToken" | "seedDevices">;
  logger?: Logger;
  /** Overrides for every device connection (timeouts, clock), mainly for tests. */
  connectionOptions?: Omit<DeviceConnectionOptions, "onContact" | "logger">;
  probeTimeoutMs?: number;
  /** How long first list requests wait for startup work; default STARTUP_WAIT_MS. */
  startupWaitMs?: number;
}

interface DeviceState {
  record: DeviceRecord;
  connection?: DeviceConnection;
  catalog?: DeviceCatalog;
  /** True once the catalog came from the device in this process, not from the cache. */
  live: boolean;
  lastTouch: number;
}

function ok(data: Record<string, unknown>): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }], structuredContent: data };
}

function fail(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

function requireString(args: Args, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || value.trim() === "") throw new ValidationError(`'${key}' is required and must be a non-empty string.`);
  return value.trim();
}

function optionalString(args: Args, key: string): string | undefined {
  const value = args[key];
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw new ValidationError(`'${key}' must be a string.`);
  return value.trim() || undefined;
}

/** The fields that, when changed, need a new connection. */
function connectionKey(record: DeviceRecord): string {
  return canonicalJson([record.host, record.port, record.path, record.token, record.cert_sha256, record.ca_file]);
}

function isCatalog(value: unknown): value is DeviceCatalog {
  const v = value as Partial<DeviceCatalog> | undefined;
  return !!v && Array.isArray(v.tools) && typeof v.serverInfo?.version === "string";
}

function describeCert(cert: PeerCert) {
  return {
    fingerprint_sha256: cert.fingerprint256,
    subject: cert.subject,
    issuer: cert.issuer,
    valid_from: cert.validFrom,
    valid_to: cert.validTo,
    self_signed: cert.selfSigned,
  };
}

/**
 * The MCP server Claude talks to: the extension's own management tools plus one merged
 * copy of every tool the registered WLAN Pis offer, routed by a `device` argument.
 */
export class Bridge {
  readonly server: Server;
  private readonly registry: Registry;
  private readonly config: BridgeOptions["config"];
  private readonly logger: Logger;
  private readonly connectionOptions: BridgeOptions["connectionOptions"];
  private readonly probeTimeoutMs: number;
  private readonly states = new Map<string, DeviceState>();
  private merged: MergedTools = { tools: [], routes: new Map() };
  private prompts: MergedPrompts = { prompts: [], routes: new Map() };
  private resources: Resource[] = [];
  private resourceTemplates: ResourceTemplate[] = [];
  /** Last announced state of each list, to send list_changed only on real changes. */
  private keys = { tools: canonicalJson([]), resources: canonicalJson([[], []]), prompts: canonicalJson([]) };
  private initialized = false;
  private refreshing = new Map<string, Promise<void>>();
  private readonly tokens: TokenSettings;
  private readonly startupWaitMs: number;
  private startupReady?: Promise<void>;
  private startedAt = 0;

  constructor(options: BridgeOptions) {
    this.registry = options.registry;
    this.config = options.config;
    this.logger = options.logger ?? silentLogger;
    this.connectionOptions = options.connectionOptions;
    this.probeTimeoutMs = options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
    this.startupWaitMs = options.startupWaitMs ?? STARTUP_WAIT_MS;
    this.tokens = parseTokens(this.config.tokens);
    this.tokens.default ??= this.config.defaultToken;
    for (const error of this.tokens.errors) this.logger.warn(error);

    this.server = new Server(
      { name: NAME, version: VERSION },
      {
        capabilities: { tools: { listChanged: true }, resources: { listChanged: true }, prompts: { listChanged: true } },
        instructions: INSTRUCTIONS,
      },
    );
    this.server.oninitialized = () => {
      this.initialized = true;
    };
    this.server.setRequestHandler(ListToolsRequestSchema, async () => {
      await this.untilStarted();
      return { tools: [...MANAGEMENT_TOOLS, ...this.merged.tools] };
    });
    this.server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      const { name, arguments: args = {} } = request.params;
      try {
        const progressToken = request.params._meta?.progressToken;
        if (name === "call_wlanpi_tool") return await this.callAnyPiTool(args, progressToken, extra);
        return RESERVED.has(name) ? await this.callManagementTool(name, args) : await this.callPiTool(name, args, progressToken, extra);
      } catch (err) {
        if (err instanceof ValidationError || err instanceof DeviceError || err instanceof UnknownDeviceError || err instanceof DuplicateDeviceError) {
          return fail(err.message);
        }
        this.logger.error(`Tool '${name}' failed unexpectedly`, err);
        return fail(`Tool '${name}' failed unexpectedly: ${err instanceof Error ? err.message : String(err)}`);
      }
    });

    this.server.setRequestHandler(ListResourcesRequestSchema, async () => {
      await this.untilStarted();
      return { resources: this.resources };
    });
    this.server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => {
      await this.untilStarted();
      return { resourceTemplates: this.resourceTemplates };
    });
    this.server.setRequestHandler(ReadResourceRequestSchema, async (request, extra) => this.asMcpError(() => this.readResource(request.params.uri, extra)));
    this.server.setRequestHandler(ListPromptsRequestSchema, async () => {
      await this.untilStarted();
      return { prompts: this.prompts.prompts };
    });
    this.server.setRequestHandler(GetPromptRequestSchema, async (request, extra) =>
      this.asMcpError(() => this.getPrompt(request.params.name, request.params.arguments ?? {}, extra)),
    );
  }

  /**
   * Resources and prompts report failures as JSON-RPC errors (they have no isError
   * result), carrying the same actionable message a tool would.
   */
  private async asMcpError<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof McpError) throw err;
      if (err instanceof ValidationError || err instanceof UnknownDeviceError) throw new McpError(ErrorCode.InvalidParams, err.message);
      if (err instanceof DeviceError) throw new McpError(ErrorCode.InternalError, err.message);
      this.logger.error("Request failed unexpectedly", err);
      throw new McpError(ErrorCode.InternalError, `Unexpected error: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** The merged Pi tools, without the management tools. */
  get piTools(): Tool[] {
    return this.merged.tools;
  }

  /**
   * Load the registry and cached catalogs, and apply tokens from settings. No network, so
   * startup is instant.
   */
  async init(): Promise<void> {
    await this.sync();
    await this.applyConfiguredTokens();
  }

  /**
   * Network work after startup: add seeded devices and fetch Pis with no cached catalog
   * (the first list requests wait for this, up to startupWaitMs), then refresh every
   * catalog. Runs in the background in production; tests await it.
   */
  async start(): Promise<void> {
    this.startedAt = Date.now();
    this.startupReady = (async () => {
      await this.seed();
      const uncached = [...this.states.entries()].filter(([, s]) => !s.catalog).map(([name]) => name);
      await Promise.all(uncached.map((name) => this.refreshDevice(name).catch(() => {})));
    })();
    await this.startupReady;
    await this.refreshAll();
  }

  /** Wait for startup work, but never longer than startupWaitMs after start(). */
  private async untilStarted(): Promise<void> {
    if (!this.startupReady) return;
    const remaining = this.startupWaitMs - (Date.now() - this.startedAt);
    if (remaining <= 0) return;
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([this.startupReady.catch(() => {}), new Promise((resolve) => (timer = setTimeout(resolve, remaining)))]);
    clearTimeout(timer);
  }

  /** The token to use for a device that was not given one. */
  private tokenFor(name: string): string | null {
    return this.tokens.byName.get(name) ?? this.tokens.default ?? null;
  }

  /**
   * Settings win over stored tokens, so renewing an expired token is: paste the new one
   * into the settings and restart. A named token replaces that device's token. A token
   * without a name replaces the token when exactly one Pi is registered, and otherwise
   * only fills in Pis that have none (it cannot know which Pi it belongs to).
   */
  private async applyConfiguredTokens(): Promise<void> {
    const records = this.registry.list();
    let changed = false;
    for (const record of records) {
      const named = this.tokens.byName.get(record.name);
      const fallback = this.tokens.default && (records.length === 1 || !record.token) ? this.tokens.default : undefined;
      const wanted = named ?? fallback;
      if (!wanted || wanted === record.token) continue;
      await this.registry.update(record.name, { token: wanted });
      this.logger.info(`Using the token from settings for '${record.name}'.`);
      changed = true;
    }
    if (changed) await this.sync();
  }

  async close(): Promise<void> {
    await Promise.all([...this.states.values()].map((s) => s.connection?.close()));
    await this.server.close();
  }

  /** Re-read the registry (another process may have changed it) and reconcile. */
  async reload(): Promise<void> {
    await this.registry.reload();
    await this.sync();
  }

  async refreshAll(): Promise<void> {
    await Promise.all([...this.states.keys()].map((name) => this.refreshDevice(name).catch(() => {})));
  }

  /**
   * Fetch a device's catalog, cache it and update the merged tool list. Concurrent
   * refreshes of one device share a single request.
   */
  refreshDevice(name: string): Promise<void> {
    const pending = this.refreshing.get(name);
    if (pending) return pending;
    const run = (async () => {
      const state = this.states.get(name);
      if (!state) throw new UnknownDeviceError(name, this.registry.names());
      const catalog = await (await this.connectionFor(state)).fetchCatalog();
      // The device may have been removed or renamed while the request was in flight.
      if (this.states.get(name) !== state) return;
      state.catalog = catalog;
      state.live = true;
      await this.registry.writeCache(name, catalog).catch((err) => this.logger.warn(`Could not cache the catalog for '${name}'`, err));
      this.remerge();
    })();
    this.refreshing.set(name, run);
    run.then(
      () => this.refreshing.delete(name),
      (err) => {
        this.refreshing.delete(name);
        this.logger.info(`Could not refresh '${name}': ${err instanceof Error ? err.message : String(err)}`);
      },
    );
    return run;
  }

  /** Bring device state in line with the registry: new, removed, renamed and changed devices. */
  private async sync(): Promise<void> {
    const records = this.registry.list();
    const names = new Set(records.map((r) => r.name));
    for (const [name, state] of this.states) {
      if (!names.has(name)) {
        this.states.delete(name);
        await state.connection?.close();
      }
    }
    for (const record of records) {
      const state = this.states.get(record.name);
      if (!state) {
        const cached = await this.registry.readCache(record.name);
        this.states.set(record.name, { record, catalog: isCatalog(cached) ? cached : undefined, live: false, lastTouch: 0 });
      } else {
        if (connectionKey(state.record) !== connectionKey(record)) {
          const old = state.connection;
          state.connection = undefined;
          await old?.close();
        }
        state.record = record;
      }
    }
    this.remerge();
  }

  private remerge(): void {
    const registered = this.registry.names();
    const catalogs = [...this.states.entries()].filter(([, s]) => s.catalog).map(([device, s]) => ({ device, catalog: s.catalog! }));
    const options = { logger: this.logger };

    this.merged = mergeTools(
      catalogs.map(({ device, catalog }) => ({ device, version: catalog.serverInfo.version, tools: catalog.tools })),
      registered,
      { ...options, reserved: RESERVED },
    );
    this.prompts = mergePrompts(
      catalogs.map(({ device, catalog }) => ({ device, version: catalog.serverInfo.version, prompts: catalog.prompts ?? [] })),
      registered,
      options,
    );
    ({ resources: this.resources, resourceTemplates: this.resourceTemplates } = mergeResources(
      catalogs.map(({ device, catalog }) => ({ device, resources: catalog.resources ?? [], resourceTemplates: catalog.resourceTemplates ?? [] })),
      options,
    ));

    this.announce("tools", canonicalJson(this.merged.tools), () => this.server.sendToolListChanged());
    this.announce("resources", canonicalJson([this.resources, this.resourceTemplates]), () => this.server.sendResourceListChanged());
    this.announce("prompts", canonicalJson(this.prompts.prompts), () => this.server.sendPromptListChanged());
  }

  private announce(list: keyof Bridge["keys"], key: string, send: () => Promise<void>): void {
    if (this.keys[list] === key) return;
    this.keys[list] = key;
    if (this.initialized) send().catch((err) => this.logger.debug(`Could not send ${list}/list_changed`, err));
  }

  private makeConnection(target: DeviceTarget): DeviceConnection {
    return new DeviceConnection(target, {
      callTimeoutMs: this.config.callTimeoutMs,
      logger: this.logger,
      ...this.connectionOptions,
      onContact: () => this.touch(target.name),
    });
  }

  private async connectionFor(state: DeviceState): Promise<DeviceConnection> {
    if (!state.connection) {
      const { name, host, port, path, token } = state.record;
      const trust = await trustFor(state.record, this.config.caFile);
      state.connection = this.makeConnection({ name, host, port, path, token, trust });
    }
    return state.connection;
  }

  private touch(name: string): void {
    const state = this.states.get(name);
    const now = Date.now();
    if (!state || now - state.lastTouch < TOUCH_INTERVAL_MS) return;
    state.lastTouch = now;
    this.registry.touch(name).then(
      (record) => {
        if (this.states.get(name) === state) state.record = record;
      },
      (err) => this.logger.debug(`Could not record last_seen for '${name}'`, err),
    );
  }

  private get connectTimeoutMs(): number {
    return this.connectionOptions?.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  }

  // ---- Pi tools ----------------------------------------------------------------------

  /** The device a request names, or the only registered one when it names none. */
  private pickDevice(what: string, param: string, requested: unknown): { state: DeviceState; device: string } | { error: string } {
    const registered = this.registry.names();
    if (registered.length === 0) return { error: `No WLAN Pi is registered yet: add one with add_wlanpi.` };
    let device: string;
    if (requested === undefined || requested === null || requested === "") {
      if (registered.length !== 1) return { error: `${what} needs a '${param}' argument naming the WLAN Pi to use: one of ${registered.join(", ")}.` };
      device = registered[0]!;
    } else if (typeof requested !== "string") {
      return { error: `'${param}' must be the name of a WLAN Pi: one of ${registered.join(", ")}.` };
    } else {
      device = requested.trim().toLowerCase();
    }
    const state = this.states.get(device);
    return state ? { state, device } : { error: new UnknownDeviceError(device, registered).message };
  }

  /**
   * Check that a device offers a tool or prompt. A device whose list came from the cache
   * (or was never fetched) is asked again before being told it lacks the item.
   */
  private async ensureOffers(kind: "tool" | "prompt", name: string, device: string, state: DeviceState, routes: () => Map<string, ToolRoute>): Promise<string | undefined> {
    if (!routes().get(name)?.devices.includes(device) && !state.live) await this.refreshDevice(device);
    const route = routes().get(name);
    if (route?.devices.includes(device)) return undefined;
    const version = state.catalog?.serverInfo.version;
    return (
      `Device '${device}' (wlanpi-mcp ${version ?? "version unknown"}) does not have the ${kind} '${name}'.` +
      (route ? ` It is available on: ${route.devices.join(", ")}. Updating wlanpi-mcp on '${device}' may add it.` : "")
    );
  }

  /** Resolve a routed tool or prompt request: which device, and the arguments for it. */
  private async resolveDevice(
    kind: "tool" | "prompt",
    name: string,
    args: Args,
    routes: () => Map<string, ToolRoute>,
  ): Promise<{ state: DeviceState; device: string; rest: Args } | { error: string }> {
    const route = routes().get(name);
    if (!route) {
      const registered = this.registry.names();
      return {
        error:
          registered.length === 0
            ? `Unknown ${kind} '${name}'. No WLAN Pi is registered yet: add one with add_wlanpi.`
            : `Unknown ${kind} '${name}'. None of the registered WLAN Pis (${registered.join(", ")}) offers it.`,
      };
    }
    const { [route.param]: requested, ...rest } = args;
    const picked = this.pickDevice(`${kind === "tool" ? "Tool" : "Prompt"} '${name}'`, route.param, requested);
    if ("error" in picked) return picked;
    const missing = await this.ensureOffers(kind, name, picked.device, picked.state, routes);
    return missing ? { error: missing } : { ...picked, rest };
  }

  // ---- Pi tools ----------------------------------------------------------------------

  private async callPiTool(name: string, args: Args, progressToken: string | number | undefined, extra: Extra): Promise<CallToolResult> {
    const target = await this.resolveDevice("tool", name, args, () => this.merged.routes);
    if ("error" in target) return fail(target.error);
    return this.runPiTool(target.state, target.device, name, target.rest, progressToken, extra);
  }

  /** Call a tool on one device and return its result, with a fix appended on a core 401. */
  private async runPiTool(state: DeviceState, device: string, name: string, rest: Args, progressToken: string | number | undefined, extra: Extra): Promise<CallToolResult> {
    const connection = await this.connectionFor(state);
    const result = await connection.callTool(name, rest, {
      signal: extra.signal,
      ...(progressToken !== undefined
        ? { onprogress: (p) => void extra.sendNotification({ method: "notifications/progress", params: { ...p, progressToken } }).catch(() => {}) }
        : {}),
    });
    // The device answered; if its tool list came from the cache, refresh it quietly.
    if (!state.live) void this.refreshDevice(device).catch(() => {});
    // wlanpi-core refused the token: keep the Pi's result and add what to do about it.
    if (isCoreAuthFailure(result)) {
      return { ...result, content: [...result.content, { type: "text", text: tokenRejectedMessage(state.record, "wlanpi-core returned 401") }] };
    }
    return result;
  }

  // ---- Resources and prompts ---------------------------------------------------------

  private async readResource(uri: string, extra: Extra): Promise<ReadResourceResult> {
    const target = fromBridgeUri(uri);
    if (!target) throw new ValidationError(`'${uri}' is not a WLAN Pi resource. Resource URIs look like wlanpi://<device>/device/info.`);
    const state = this.states.get(target.device);
    if (!state) throw new UnknownDeviceError(target.device, this.registry.names());

    const result = await (await this.connectionFor(state)).readResource(target.piUri, { signal: extra.signal });
    // Point returned contents back at bridge URIs, so a follow-up read routes correctly.
    return { ...result, contents: result.contents.map((c) => ({ ...c, uri: toBridgeUri(target.device, c.uri) ?? c.uri })) };
  }

  private async getPrompt(name: string, args: Record<string, string>, extra: Extra): Promise<GetPromptResult> {
    const target = await this.resolveDevice("prompt", name, args, () => this.prompts.routes);
    if ("error" in target) throw new ValidationError(target.error);
    const { state, device, rest } = target;

    const result = await (await this.connectionFor(state)).getPrompt(name, rest as Record<string, string>, { signal: extra.signal });
    // The Pi's prompt names tools without a device; say which Pi this conversation is about.
    const note = `This is about WLAN Pi '${device}': pass device "${device}" to each WLAN Pi tool you call for it.`;
    const [first, ...others] = result.messages;
    const messages: GetPromptResult["messages"] =
      first?.role === "user" && first.content.type === "text"
        ? [{ ...first, content: { ...first.content, text: `${note}\n\n${first.content.text}` } }, ...others]
        : [{ role: "user", content: { type: "text", text: note } }, ...result.messages];
    return { ...result, messages };
  }

  // ---- Management tools --------------------------------------------------------------

  private async callManagementTool(name: string, args: Args): Promise<CallToolResult> {
    switch (name) {
      case "add_wlanpi":
        return ok(await this.addDevice(args));
      case "list_wlanpis":
        return ok(await this.listDevices());
      case "remove_wlanpi":
        return ok(await this.removeDevice(args));
      case "rename_wlanpi":
        return ok(await this.renameDevice(args));
      case "trust_wlanpi_cert":
        return ok(await this.trustCert(args));
      case "set_wlanpi_token":
        return ok(await this.setToken(args));
      case "list_wlanpi_tools":
        return ok(await this.listPiTools(args));
      default:
        return fail(`Unknown tool '${name}'.`);
    }
  }

  async addDevice(args: Args): Promise<Record<string, unknown>> {
    const parsed = parseHost(requireString(args, "host"));
    let port = parsed.port;
    if (args.port !== undefined && args.port !== null) {
      const fromArg = parsePort(args.port as string | number);
      if (port !== undefined && port !== fromArg) throw new ValidationError(`The host gives port ${port} but 'port' is ${fromArg}. Give the port once.`);
      port = fromArg;
    }
    port ??= DEFAULT_PORT;
    const host = parsed.host;

    await this.reload();
    const sameHost = this.registry.list().find((r) => r.host === host && r.port === port);
    if (sameHost) throw new ValidationError(`${deviceLabel({ name: sameHost.name, host, port })} is already registered as '${sameHost.name}'.`);
    const nameArg = optionalString(args, "name");
    const name = nameArg ? normalizeName(nameArg) : nameFromHost(host, this.registry.names());
    if (this.registry.get(name)) throw new DuplicateDeviceError(name);
    const token = optionalString(args, "token") ?? this.tokenFor(name);

    // Trust on first use: read the certificate the device presents now.
    const probeTarget: DeviceTarget = { name, host, port, path: DEFAULT_PATH, token, trust: { kind: "pin", fingerprint: "00".repeat(32) } };
    let cert: PeerCert;
    try {
      cert = await fetchPeerCert(host, port, this.connectTimeoutMs);
    } catch (err) {
      throw toDeviceError(err, probeTarget, { kind: "connect", timeoutMs: this.connectTimeoutMs }, this.connectTimeoutMs);
    }

    const caMode = !!this.config.caFile;
    const trust = await trustFor({ name, ca_file: null, cert_sha256: cert.fingerprint256 }, this.config.caFile);
    const connection = this.makeConnection({ ...probeTarget, trust });

    let catalog: DeviceCatalog | undefined;
    let tokenProblem: string | undefined;
    try {
      catalog = await connection.fetchCatalog();
    } catch (err) {
      const error = toDeviceError(err, probeTarget, { kind: "connect", timeoutMs: this.connectTimeoutMs }, this.connectTimeoutMs);
      // A missing or rejected token still leaves a reachable, pinned Pi worth saving.
      if (error.kind !== "auth") {
        await connection.close();
        throw error;
      }
      tokenProblem = error.message;
    }

    // initialize and tools/list succeed with any token; only a call into wlanpi-core
    // shows whether it really works.
    let tokenVerified = false;
    let tokenWarning: string | undefined;
    if (catalog) {
      const check = await connection.verifyToken();
      if (check.status === "valid") tokenVerified = true;
      else if (check.status === "rejected") tokenProblem = check.error.message;
      else tokenWarning = `The token could not be checked: ${check.reason}`;
    }

    try {
      await this.registry.add({ name, host, port, cert_sha256: caMode ? null : cert.fingerprint256, token });
    } catch (err) {
      await connection.close();
      throw err;
    }
    if (catalog) await this.registry.writeCache(name, catalog).catch((err) => this.logger.warn(`Could not cache the catalog for '${name}'`, err));
    await this.sync();
    const state = this.states.get(name);
    if (state) {
      await state.connection?.close();
      state.connection = connection;
      state.catalog = catalog ?? state.catalog;
      state.live = !!catalog;
      this.remerge();
    }

    const nextSteps = [`Ask the user to confirm the fingerprint matches the Pi. On the Pi: ${PI_CERT_COMMAND}`];
    if (tokenProblem) nextSteps.push(tokenProblem);
    if (tokenWarning) nextSteps.push(tokenWarning);
    return {
      name,
      host,
      port,
      status: catalog && !tokenProblem ? "ready" : "needs_token",
      token_verified: tokenVerified,
      trust: caMode ? "ca" : "pinned",
      certificate: describeCert(cert),
      ...(catalog ? { server: catalog.serverInfo, tool_count: catalog.tools.length } : {}),
      registered_devices: this.registry.names(),
      next_steps: nextSteps,
    };
  }

  async listDevices(): Promise<Record<string, unknown>> {
    await this.reload();
    const devices = await Promise.all(
      [...this.states.entries()].map(async ([name, state]) => {
        const { host, port, last_seen, token, ca_file, cert_sha256 } = state.record;
        const base = {
          name,
          host,
          port,
          trust: ca_file || this.config.caFile ? "ca" : "pinned",
          ...(cert_sha256 && !(ca_file || this.config.caFile) ? { fingerprint_sha256: cert_sha256 } : {}),
          token_set: !!token,
          last_seen,
          tool_count: state.catalog?.tools.length ?? 0,
        };
        try {
          const connection = await this.connectionFor(state);
          const probe = await connection.probe(this.probeTimeoutMs);
          if (probe.ok && !state.live) void this.refreshDevice(name).catch(() => {});
          if (probe.ok) {
            // Tokens expire (7 days by default): say so here rather than on the next call.
            const check = token ? await connection.verifyToken(this.probeTimeoutMs * 2) : undefined;
            return {
              ...base,
              reachable: true,
              latency_ms: probe.latencyMs,
              server_version: probe.serverInfo?.version ?? state.catalog?.serverInfo.version,
              token_valid: check?.status === "valid" ? true : check?.status === "rejected" ? false : null,
              ...(check?.status === "rejected" ? { needs_token: true, error: check.error.message } : {}),
            };
          }
          return {
            ...base,
            reachable: false,
            ...(probe.error?.kind === "auth" ? { reachable: true, needs_token: true } : {}),
            server_version: state.catalog?.serverInfo.version ?? null,
            error: probe.error?.message,
          };
        } catch (err) {
          return { ...base, reachable: false, error: err instanceof Error ? err.message : String(err) };
        }
      }),
    );
    return devices.length
      ? { count: devices.length, devices }
      : { count: 0, devices: [], hint: "No WLAN Pi is registered yet. Add one with add_wlanpi, giving its hostname or IP address." };
  }

  async removeDevice(args: Args): Promise<Record<string, unknown>> {
    const name = requireString(args, "device").toLowerCase();
    await this.registry.reload();
    if (!(await this.registry.remove(name))) throw new UnknownDeviceError(name, this.registry.names());
    await this.sync();
    return { removed: name, registered_devices: this.registry.names() };
  }

  async renameDevice(args: Args): Promise<Record<string, unknown>> {
    const name = requireString(args, "device").toLowerCase();
    const newName = normalizeName(requireString(args, "new_name"));
    await this.registry.reload();
    await this.registry.rename(name, newName);
    await this.sync();
    return { old_name: name, name: newName, registered_devices: this.registry.names() };
  }

  async trustCert(args: Args): Promise<Record<string, unknown>> {
    const name = requireString(args, "device").toLowerCase();
    const given = normalizeFingerprint(requireString(args, "fingerprint"));
    await this.reload();
    const record = this.registry.require(name);
    if (record.ca_file || this.config.caFile) {
      throw new ValidationError(`'${name}' is validated against a CA file, not a pinned certificate, so there is nothing to re-pin.`);
    }

    let cert: PeerCert;
    try {
      cert = await fetchPeerCert(record.host, record.port, this.connectTimeoutMs);
    } catch (err) {
      throw toDeviceError(err, { ...record, trust: { kind: "pin", fingerprint: given } }, { kind: "connect", timeoutMs: this.connectTimeoutMs }, this.connectTimeoutMs);
    }
    if (!fingerprintsEqual(given, cert.fingerprint256)) {
      throw new ValidationError(
        `The fingerprint given (${given}) does not match the certificate ${deviceLabel(record)} presents now (${cert.fingerprint256}). ` +
          `Nothing was changed. Read the fingerprint on the Pi with: ${PI_CERT_COMMAND}`,
      );
    }
    const previous = record.cert_sha256;
    if (previous && fingerprintsEqual(previous, cert.fingerprint256)) {
      return { name, status: "unchanged", certificate: describeCert(cert) };
    }

    await this.registry.update(name, { cert_sha256: cert.fingerprint256 });
    await this.sync();
    const refresh = await this.refreshDevice(name).then(
      () => undefined,
      (err: Error) => err.message,
    );
    const state = this.states.get(name);
    return {
      name,
      status: "trusted",
      previous_fingerprint_sha256: previous,
      certificate: describeCert(cert),
      ...(refresh ? { warning: refresh } : { tool_count: state?.catalog?.tools.length ?? 0 }),
    };
  }

  async setToken(args: Args): Promise<Record<string, unknown>> {
    const name = requireString(args, "device").toLowerCase();
    const token = requireString(args, "token");
    await this.registry.reload();
    await this.registry.update(name, { token });
    await this.sync();
    try {
      await this.refreshDevice(name);
      const state = this.states.get(name);
      const check = state ? await (await this.connectionFor(state)).verifyToken() : undefined;
      if (check?.status === "rejected") return { name, status: "rejected", error: check.error.message };
      if (check?.status !== "valid") return { name, status: "saved_untested", error: check?.reason ?? "The device was removed." };
      return { name, status: "accepted", tool_count: state?.catalog?.tools.length ?? 0 };
    } catch (err) {
      const error = err instanceof DeviceError ? err : undefined;
      return error?.kind === "auth"
        ? { name, status: "rejected", error: error.message }
        : { name, status: "saved_untested", error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** A device's catalog, fetched now if there is none yet. */
  private async catalogFor(device: string, state: DeviceState): Promise<DeviceCatalog> {
    if (!state.catalog) await this.refreshDevice(device);
    if (!state.catalog) throw new ValidationError(`The tools of '${device}' are not known yet.`);
    return state.catalog;
  }

  async listPiTools(args: Args): Promise<Record<string, unknown>> {
    const picked = this.pickDevice("list_wlanpi_tools", "device", args.device);
    if ("error" in picked) throw new ValidationError(picked.error);
    const { state, device } = picked;
    const catalog = await this.catalogFor(device, state);
    const toolName = optionalString(args, "tool");

    const flags = (tool: Tool) => ({ read_only: tool.annotations?.readOnlyHint === true, destructive: tool.annotations?.destructiveHint === true });
    if (toolName) {
      const tool = catalog.tools.find((t) => t.name === toolName);
      if (!tool) throw new ValidationError(`'${device}' has no tool '${toolName}'. Call list_wlanpi_tools without 'tool' to see them all.`);
      return { device, tool: { name: tool.name, description: tool.description ?? "", ...flags(tool), inputSchema: tool.inputSchema, ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}) } };
    }

    const summary = (text = "") => {
      const first = text.split(/\n\s*\n/)[0]!.replace(/\s+/g, " ").trim();
      return first.length > 200 ? `${first.slice(0, 197)}...` : first;
    };
    return {
      device,
      server_version: catalog.serverInfo.version,
      source: state.live ? "live" : "cache",
      count: catalog.tools.length,
      tools: catalog.tools.map((tool) => ({
        name: tool.name,
        summary: summary(tool.description),
        ...flags(tool),
        arguments: Object.keys(tool.inputSchema.properties ?? {}),
        required: (tool.inputSchema.required as string[] | undefined) ?? [],
      })),
    };
  }

  /** call_wlanpi_tool: run any Pi tool by name, whether or not the client lists it. */
  private async callAnyPiTool(args: Args, progressToken: string | number | undefined, extra: Extra): Promise<CallToolResult> {
    const tool = requireString(args, "tool");
    const toolArgs = args.arguments ?? {};
    if (typeof toolArgs !== "object" || Array.isArray(toolArgs) || toolArgs === null) throw new ValidationError("'arguments' must be an object of the Pi tool's arguments.");
    if (RESERVED.has(tool)) throw new ValidationError(`'${tool}' is one of the extension's own tools: call it directly.`);

    const picked = this.pickDevice("call_wlanpi_tool", "device", args.device);
    if ("error" in picked) return fail(picked.error);
    const { state, device } = picked;
    const offers = (catalog?: DeviceCatalog) => catalog?.tools.some((t) => t.name === tool) ?? false;
    if (!offers(state.catalog) && !state.live) await this.refreshDevice(device);
    if (!offers(state.catalog)) {
      return fail(`Device '${device}' (wlanpi-mcp ${state.catalog?.serverInfo.version ?? "version unknown"}) does not have the tool '${tool}'. See list_wlanpi_tools.`);
    }
    return this.runPiTool(state, device, tool, toolArgs as Args, progressToken, extra);
  }

  private async seed(): Promise<void> {
    const { devices, errors } = parseSeedDevices(this.config.seedDevices);
    for (const error of errors) this.logger.warn(error);
    for (const seed of devices) {
      const port = seed.port ?? DEFAULT_PORT;
      if (this.registry.get(seed.name) || this.registry.list().some((r) => r.host === seed.host && r.port === port)) continue;
      try {
        const result = await this.addDevice({ host: seed.host, name: seed.name, port });
        this.logger.info(`Added seeded device '${seed.name}' (${result.status}), certificate ${(result.certificate as { fingerprint_sha256: string }).fingerprint_sha256}.`);
      } catch (err) {
        this.logger.warn(`Could not add seeded device '${seed.name}' (${seed.host}); will retry on the next start: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
}
