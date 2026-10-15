import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import {
  type CallToolResult,
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type ServerNotification,
  type ServerRequest,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { canonicalJson, type MergedTools, mergeTools } from "./catalog.js";
import { type BridgeConfig, DEFAULT_PATH, DEFAULT_PORT } from "./config.js";
import {
  DEFAULT_PROBE_TIMEOUT_MS,
  type DeviceCatalog,
  DeviceConnection,
  type DeviceConnectionOptions,
  type DeviceTarget,
  deviceLabel,
  toDeviceError,
  trustFor,
} from "./device.js";
import { DeviceError, DuplicateDeviceError, UnknownDeviceError, ValidationError } from "./errors.js";
import { type Logger, silentLogger } from "./log.js";
import type { DeviceRecord, Registry } from "./registry.js";
import { DEFAULT_CONNECT_TIMEOUT_MS, type PeerCert, fetchPeerCert, fingerprintsEqual, normalizeFingerprint } from "./tls.js";
import { nameFromHost, normalizeName, parseHost, parsePort, parseSeedDevices } from "./validate.js";
import { NAME, VERSION } from "./version.js";

type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>;
type Args = Record<string, unknown>;

export const PI_CERT_COMMAND = "openssl x509 -in /etc/nginx/ssl/self-signed-wlanpi.cert -noout -fingerprint -sha256";
const TOKEN_COMMAND = "sudo getjwt claude";
/** last_seen is written at most this often per device, not on every call. */
const TOUCH_INTERVAL_MS = 60_000;

const INSTRUCTIONS = `This extension connects to one or more WLAN Pi devices running wlanpi-mcp.
Register a Pi with add_wlanpi (hostname or IP), and show the user the certificate fingerprint it returns so they can compare it with the Pi.
Every WLAN Pi tool takes a 'device' argument naming the Pi to run on (see list_wlanpis). With one registered Pi it is optional.
To run the same tool on several Pis, call it once per device.`;

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
];

const RESERVED = new Set(MANAGEMENT_TOOLS.map((t) => t.name));

export interface BridgeOptions {
  registry: Registry;
  config: Pick<BridgeConfig, "callTimeoutMs" | "caFile" | "defaultToken" | "seedDevices">;
  logger?: Logger;
  /** Overrides for every device connection (timeouts, clock), mainly for tests. */
  connectionOptions?: Omit<DeviceConnectionOptions, "onContact" | "logger">;
  probeTimeoutMs?: number;
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
  private mergedKey = canonicalJson([]);
  private initialized = false;
  private refreshing = new Map<string, Promise<void>>();

  constructor(options: BridgeOptions) {
    this.registry = options.registry;
    this.config = options.config;
    this.logger = options.logger ?? silentLogger;
    this.connectionOptions = options.connectionOptions;
    this.probeTimeoutMs = options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;

    this.server = new Server({ name: NAME, version: VERSION }, { capabilities: { tools: { listChanged: true } }, instructions: INSTRUCTIONS });
    this.server.oninitialized = () => {
      this.initialized = true;
    };
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [...MANAGEMENT_TOOLS, ...this.merged.tools] }));
    this.server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      const { name, arguments: args = {} } = request.params;
      try {
        return RESERVED.has(name) ? await this.callManagementTool(name, args) : await this.callPiTool(name, args, request.params._meta?.progressToken, extra);
      } catch (err) {
        if (err instanceof ValidationError || err instanceof DeviceError || err instanceof UnknownDeviceError || err instanceof DuplicateDeviceError) {
          return fail(err.message);
        }
        this.logger.error(`Tool '${name}' failed unexpectedly`, err);
        return fail(`Tool '${name}' failed unexpectedly: ${err instanceof Error ? err.message : String(err)}`);
      }
    });
  }

  /** The merged Pi tools, without the management tools. */
  get piTools(): Tool[] {
    return this.merged.tools;
  }

  /** Load the registry and cached catalogs. No network, so startup is instant. */
  async init(): Promise<void> {
    await this.sync();
  }

  /**
   * Network work after startup: add seeded devices, then refresh every catalog. Runs in
   * the background in production; tests await it.
   */
  async start(): Promise<void> {
    await this.seed();
    await this.refreshAll();
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
    const devices = [...this.states.entries()]
      .filter(([, s]) => s.catalog)
      .map(([device, s]) => ({ device, version: s.catalog!.serverInfo.version, tools: s.catalog!.tools }));
    this.merged = mergeTools(devices, this.registry.names(), { reserved: RESERVED, logger: this.logger });
    const key = canonicalJson(this.merged.tools);
    if (key === this.mergedKey) return;
    this.mergedKey = key;
    if (this.initialized) {
      this.server.sendToolListChanged().catch((err) => this.logger.debug("Could not send tools/list_changed", err));
    }
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

  private async callPiTool(name: string, args: Args, progressToken: string | number | undefined, extra: Extra): Promise<CallToolResult> {
    const registered = this.registry.names();
    let route = this.merged.routes.get(name);
    if (!route) {
      return fail(
        registered.length === 0
          ? `Unknown tool '${name}'. No WLAN Pi is registered yet: add one with add_wlanpi.`
          : `Unknown tool '${name}'. None of the registered WLAN Pis (${registered.join(", ")}) offers it.`,
      );
    }

    const { [route.param]: requested, ...rest } = args;
    let device: string;
    if (requested === undefined || requested === null || requested === "") {
      if (registered.length !== 1) return fail(`Tool '${name}' needs a '${route.param}' argument naming the WLAN Pi to use: one of ${registered.join(", ")}.`);
      device = registered[0]!;
    } else if (typeof requested !== "string") {
      return fail(`'${route.param}' must be the name of a WLAN Pi: one of ${registered.join(", ")}.`);
    } else {
      device = requested.trim().toLowerCase();
    }

    const state = this.states.get(device);
    if (!state) return fail(new UnknownDeviceError(device, registered).message);

    // A device we have only a cached (or no) tool list for may have gained the tool:
    // ask it before saying no.
    if (!route.devices.includes(device) && !state.live) {
      await this.refreshDevice(device);
      route = this.merged.routes.get(name) ?? route;
    }
    if (!route.devices.includes(device)) {
      const version = state.catalog?.serverInfo.version;
      return fail(
        `Device '${device}' (wlanpi-mcp ${version ?? "version unknown"}) does not have the tool '${name}'. ` +
          `It is available on: ${route.devices.join(", ")}. Updating wlanpi-mcp on '${device}' may add it.`,
      );
    }

    const connection = await this.connectionFor(state);
    const result = await connection.callTool(name, rest, {
      signal: extra.signal,
      ...(progressToken !== undefined
        ? { onprogress: (p) => void extra.sendNotification({ method: "notifications/progress", params: { ...p, progressToken } }).catch(() => {}) }
        : {}),
    });
    // The device answered; if its tool list came from the cache, refresh it quietly.
    if (!state.live) void this.refreshDevice(device).catch(() => {});
    return result;
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
    const token = optionalString(args, "token") ?? this.config.defaultToken ?? null;

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
    return {
      name,
      host,
      port,
      status: catalog ? "ready" : "needs_token",
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
          const probe = await (await this.connectionFor(state)).probe(this.probeTimeoutMs);
          if (probe.ok && !state.live) void this.refreshDevice(name).catch(() => {});
          return probe.ok
            ? { ...base, reachable: true, latency_ms: probe.latencyMs, server_version: probe.serverInfo?.version ?? state.catalog?.serverInfo.version }
            : {
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
      return { name, status: "accepted", tool_count: this.states.get(name)?.catalog?.tools.length ?? 0 };
    } catch (err) {
      const error = err instanceof DeviceError ? err : undefined;
      return error?.kind === "auth"
        ? { name, status: "rejected", error: error.message }
        : { name, status: "saved_untested", error: err instanceof Error ? err.message : String(err) };
    }
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
