import { promises as fs } from "node:fs";
import { isIPv6 } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport, StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { RequestOptions } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  type CallToolResult,
  CallToolResultSchema,
  ErrorCode,
  type GetPromptResult,
  type Implementation,
  McpError,
  type Prompt,
  type ReadResourceResult,
  type Resource,
  type ResourceTemplate,
  type ServerCapabilities,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import type { Agent } from "undici";
import { DEFAULT_CALL_TIMEOUT_MS, DEFAULT_PORT } from "./config.js";
import { CertMismatchError, DeviceError, type DeviceErrorKind } from "./errors.js";
import { type Logger, silentLogger } from "./log.js";
import type { DeviceRecord } from "./registry.js";
import { DEFAULT_CONNECT_TIMEOUT_MS, type Trust, createDispatcher, createFetch } from "./tls.js";
import { NAME, VERSION } from "./version.js";

export const DEFAULT_PROBE_TIMEOUT_MS = 2_000;
export const BACKOFF_BASE_MS = 1_000;
export const BACKOFF_MAX_MS = 30_000;

/** Everything needed to reach one device. */
export interface DeviceTarget {
  name: string;
  host: string;
  port: number;
  path: string;
  token: string | null;
  trust: Trust;
}

/** What a device offers, as fetched in one pass (and cached for offline startup). */
export interface DeviceCatalog {
  serverInfo: Implementation;
  capabilities: ServerCapabilities;
  tools: Tool[];
  resources: Resource[];
  resourceTemplates: ResourceTemplate[];
  prompts: Prompt[];
  fetched_at: string;
}

export interface CallOptions {
  signal?: AbortSignal;
  onprogress?: RequestOptions["onprogress"];
  /** Overrides the connection's default call timeout for this call. */
  timeoutMs?: number;
}

export interface ProbeResult {
  ok: boolean;
  latencyMs?: number;
  serverInfo?: Implementation;
  error?: DeviceError;
}

export type TokenCheck =
  | { status: "valid" }
  | { status: "rejected"; error: DeviceError }
  /** The check could not run (Pi unreachable, or it lacks the check tool). */
  | { status: "unknown"; reason: string };

export interface DeviceConnectionOptions {
  connectTimeoutMs?: number;
  callTimeoutMs?: number;
  logger?: Logger;
  /** Called after each successful exchange, e.g. to update last_seen. */
  onContact?: (serverInfo: Implementation | undefined) => void;
  /** Clock and randomness, injectable for backoff tests. */
  now?: () => number;
  random?: () => number;
}

/** `'lab' (10.0.0.5)`, with the port only when it is not the default. */
export function deviceLabel(target: Pick<DeviceTarget, "name" | "host" | "port">): string {
  const host = isIPv6(target.host) ? `[${target.host}]` : target.host;
  return `'${target.name}' (${target.port === DEFAULT_PORT ? target.host : `${host}:${target.port}`})`;
}

export function deviceUrl(target: Pick<DeviceTarget, "host" | "port" | "path">): URL {
  const host = isIPv6(target.host) ? `[${target.host}]` : target.host;
  return new URL(`https://${host}:${target.port}${target.path}`);
}

/**
 * How to trust a device: its own CA file, else the global CA file, else its pinned
 * fingerprint. A device with none of these has never been contacted and cannot be used.
 */
export async function trustFor(record: Pick<DeviceRecord, "name" | "ca_file" | "cert_sha256">, globalCaFile?: string): Promise<Trust> {
  const caFile = record.ca_file ?? globalCaFile;
  if (caFile) {
    try {
      return { kind: "ca", ca: await fs.readFile(caFile) };
    } catch (err) {
      throw new DeviceError("tls", record.name, `Cannot read the CA file for '${record.name}' (${caFile}): ${(err as Error).message}`, { cause: err });
    }
  }
  if (record.cert_sha256) return { kind: "pin", fingerprint: record.cert_sha256 };
  throw new DeviceError("tls", record.name, `Device '${record.name}' has no pinned certificate. Remove it and add it again with add_wlanpi.`);
}

/** Exponential backoff with ±20% jitter, never above BACKOFF_MAX_MS. */
export function backoffDelay(failures: number, random: () => number = Math.random): number {
  const base = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, failures - 1));
  return Math.min(BACKOFF_MAX_MS, Math.round(base * (0.8 + 0.4 * random())));
}

type Operation = { kind: "connect"; timeoutMs: number } | { kind: "call"; what: string; timeoutMs: number };

const UNREACHABLE_REASONS: Record<string, string> = {
  ECONNREFUSED: "connection refused. Check that wlanpi-mcp is installed and that the port is open",
  ENOTFOUND: "the hostname could not be resolved",
  EAI_AGAIN: "the hostname could not be resolved (DNS lookup failed)",
  EHOSTUNREACH: "no route to host",
  ENETUNREACH: "the network is unreachable",
  EHOSTDOWN: "the host is down",
  ECONNRESET: "the connection was reset",
  EPIPE: "the connection was closed",
  UND_ERR_SOCKET: "the connection was closed",
  UND_ERR_CLOSED: "the connection was closed",
};

const TLS_CODE = /^(ERR_TLS_|ERR_SSL_|CERT_|UNABLE_TO_|DEPTH_ZERO_|SELF_SIGNED_|HOSTNAME_MISMATCH)/;

function causes(err: unknown): unknown[] {
  const chain: unknown[] = [];
  for (let e = err; e && chain.length < 8; e = (e as { cause?: unknown }).cause) chain.push(e);
  return chain;
}

function codeOf(err: unknown): string | undefined {
  for (const e of causes(err)) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  return undefined;
}

const seconds = (ms: number) => `${Math.round(ms / 100) / 10}s`;

/**
 * wlanpi-mcp only checks that a Bearer token is present; wlanpi-core validates it when a
 * tool calls the core API. So initialize and tools/list succeed with any token, and a
 * bad one shows up as a tool error carrying core's status. This read-only tool is what
 * the bridge calls to find out whether a token really works (the same core endpoint
 * wlanpi-mcp itself uses to check a token).
 */
export const TOKEN_CHECK_TOOL = "get_device_info";
const CORE_AUTH_FAILURE = /wlanpi-core returned (401|403)\b/;

/** A tool result that failed because wlanpi-core refused the token. */
export function isCoreAuthFailure(result: CallToolResult): boolean {
  return result.isError === true && result.content.some((c) => c.type === "text" && CORE_AUTH_FAILURE.test(c.text));
}

export function tokenRejectedMessage(target: Pick<DeviceTarget, "name" | "host" | "port" | "token">, detail: string): string {
  const label = deviceLabel(target);
  return target.token
    ? `${label} rejected its token (${detail}): it is expired, revoked or wrong. ` +
        "On the Pi run 'sudo getjwt claude', then call set_wlanpi_token with the new access_token."
    : `No token is set for ${label}. On the Pi run 'sudo getjwt claude', then call set_wlanpi_token with the access_token it prints.`;
}

/** Turn any failure talking to a device into a DeviceError whose message says what to do. */
export function toDeviceError(err: unknown, target: DeviceTarget, op: Operation, connectTimeoutMs = DEFAULT_CONNECT_TIMEOUT_MS): DeviceError {
  if (err instanceof DeviceError) return err;
  const label = deviceLabel(target);
  const make = (kind: DeviceErrorKind, message: string) => new DeviceError(kind, target.name, message, { cause: err });

  const mismatch = causes(err).find((e): e is CertMismatchError => e instanceof CertMismatchError);
  if (mismatch) return make("cert-mismatch", mismatch.message);

  if (err instanceof StreamableHTTPError && err.code !== undefined) {
    const status = err.code;
    if (status === 401 || status === 403) {
      return make("auth", tokenRejectedMessage(target, `HTTP ${status}`));
    }
    if (status === 404) return make("protocol", `${label} answered, but has no MCP endpoint at ${target.path} (HTTP 404). Check that wlanpi-mcp is installed on the Pi.`);
    if (status >= 502 && status <= 504) {
      return make("protocol", `${label}: the Pi's web server answered but wlanpi-mcp did not (HTTP ${status}). On the Pi, check 'systemctl status wlanpi-mcp'.`);
    }
    return make("protocol", `${label} returned HTTP ${status}: ${err.message}`);
  }

  if (err instanceof McpError) {
    if (err.code === ErrorCode.RequestTimeout) {
      return op.kind === "connect"
        ? make("unreachable", `Device ${label} is unreachable: no MCP response within ${seconds(op.timeoutMs)}.`)
        : make(
            "timeout",
            `${op.what} on ${label} timed out after ${seconds(op.timeoutMs)}. It may still be running on the Pi. ` +
              "For longer operations, raise WLANPI_BRIDGE_CALL_TIMEOUT_MS.",
          );
    }
    if (err.code === ErrorCode.ConnectionClosed) return make("unreachable", `Device ${label} is unreachable: the connection was closed.`);
    return make("remote", `${label} returned an error: ${err.message}`);
  }

  const code = codeOf(err);
  if (code === "UND_ERR_CONNECT_TIMEOUT" || code === "ETIMEDOUT") {
    return make("unreachable", `Device ${label} is unreachable: connection timed out after ${seconds(connectTimeoutMs)}.`);
  }
  if (code && UNREACHABLE_REASONS[code]) return make("unreachable", `Device ${label} is unreachable: ${UNREACHABLE_REASONS[code]}.`);
  if (code && TLS_CODE.test(code)) {
    const detail = (causes(err).find((e) => (e as { code?: unknown }).code === code) as Error | undefined)?.message ?? code;
    const hint = target.trust.kind === "ca" ? " The certificate did not validate against the configured CA file." : "";
    return make("tls", `TLS with ${label} failed: ${detail}.${hint}`);
  }

  const message = causes(err)
    .map((e) => (e instanceof Error ? e.message : String(e)))
    .filter((m, i, all) => m && all.indexOf(m) === i)
    .join(": ");
  return make("protocol", `Unexpected error talking to ${label}: ${message || String(err)}`);
}

/** More list pages than any real Pi serves; a server past it is looping. */
export const MAX_LIST_PAGES = 100;

/** Follow nextCursor through a paginated list, stopping on a repeated cursor or MAX_LIST_PAGES. */
export async function allPages<P extends { nextCursor?: string }, T>(
  fetchPage: (params: { cursor: string } | undefined) => Promise<P>,
  itemsOf: (page: P) => T[],
): Promise<T[]> {
  const items: T[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  for (let pages = 0; pages < MAX_LIST_PAGES; pages++) {
    const page = await fetchPage(cursor ? { cursor } : undefined);
    items.push(...itemsOf(page));
    cursor = page.nextCursor;
    if (!cursor || seen.has(cursor)) break;
    seen.add(cursor);
  }
  return items;
}

/** Failures that mean "the device is not there right now", which start the backoff. */
const BACKOFF_KINDS: ReadonlySet<DeviceErrorKind> = new Set(["unreachable", "protocol"]);

/**
 * The MCP client session for one device.
 *
 * Connects lazily on first use and keeps the client for later calls. The Pi's transport
 * is stateless, so a "session" is only local state; after a network failure the client
 * is dropped and the next use initializes again. Repeated failures back off
 * exponentially (capped at 30 s) and fail fast in between, so an offline Pi does not
 * stall every request; a probe ignores the backoff so `list_wlanpis` always gets a
 * fresh answer.
 */
export class DeviceConnection {
  private client?: Client;
  private connecting?: Promise<Client>;
  private dispatcher?: Agent;
  private failures = 0;
  private retryAt = 0;
  private lastError?: DeviceError;
  private info?: Implementation;

  private readonly connectTimeoutMs: number;
  private readonly callTimeoutMs: number;
  private readonly logger: Logger;
  private readonly now: () => number;
  private readonly random: () => number;

  constructor(
    readonly target: DeviceTarget,
    private readonly options: DeviceConnectionOptions = {},
  ) {
    this.connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    this.callTimeoutMs = options.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
    this.logger = options.logger ?? silentLogger;
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
  }

  get name(): string {
    return this.target.name;
  }

  get label(): string {
    return deviceLabel(this.target);
  }

  /** serverInfo from the last successful initialize. */
  get serverInfo(): Implementation | undefined {
    return this.info;
  }

  get connected(): boolean {
    return this.client !== undefined;
  }

  /** Milliseconds until the next connection attempt is allowed, 0 if not backing off. */
  get backoffRemainingMs(): number {
    return Math.max(0, this.retryAt - this.now());
  }

  async connect(): Promise<Client> {
    if (this.client) return this.client;
    if (this.connecting) return this.connecting;
    const wait = this.backoffRemainingMs;
    if (wait > 0 && this.lastError) {
      throw new DeviceError(this.lastError.kind, this.name, `${this.lastError.message} Next retry in ${seconds(wait)}.`, { cause: this.lastError });
    }
    return this.startConnect(this.connectTimeoutMs);
  }

  private startConnect(timeoutMs: number): Promise<Client> {
    this.connecting = this.doConnect(timeoutMs).finally(() => {
      this.connecting = undefined;
    });
    return this.connecting;
  }

  private async doConnect(timeoutMs: number): Promise<Client> {
    this.dispatcher ??= createDispatcher(this.target.trust, { device: this.name, connectTimeoutMs: this.connectTimeoutMs });
    const headers: Record<string, string> = {};
    if (this.target.token) headers.Authorization = `Bearer ${this.target.token}`;

    const transport = new StreamableHTTPClientTransport(deviceUrl(this.target), {
      fetch: createFetch(this.dispatcher) as unknown as FetchLike,
      requestInit: { headers },
    });
    const client = new Client({ name: NAME, version: VERSION });
    try {
      await client.connect(transport, { timeout: timeoutMs });
    } catch (err) {
      await client.close().catch(() => {});
      throw this.recordFailure(toDeviceError(err, this.target, { kind: "connect", timeoutMs }, this.connectTimeoutMs), true);
    }
    this.client = client;
    this.info = client.getServerVersion();
    this.recordSuccess();
    this.logger.debug(`Connected to ${this.label}`, this.info);
    return client;
  }

  private recordSuccess(): void {
    this.failures = 0;
    this.retryAt = 0;
    this.lastError = undefined;
    this.options.onContact?.(this.info);
  }

  /**
   * Remember a failure. Only a failed connection attempt starts or extends the backoff:
   * a call that loses an established connection (the Pi rebooted, a keep-alive socket
   * was closed) just drops the client, so the next call reconnects at once and reports
   * the real problem, such as a changed certificate.
   */
  private recordFailure(error: DeviceError, connecting: boolean): DeviceError {
    this.lastError = error;
    const mismatch = causes(error).find((e): e is CertMismatchError => e instanceof CertMismatchError);
    if (mismatch) this.logger.warn(`${this.label} presented certificate ${mismatch.presented}.`);
    if (connecting && BACKOFF_KINDS.has(error.kind)) {
      this.failures++;
      const delay = backoffDelay(this.failures, this.random);
      this.retryAt = this.now() + delay;
      this.logger.info(`${error.message} Backing off ${seconds(delay)}.`);
    } else {
      this.logger.info(error.message);
    }
    return error;
  }

  /** Forget the client so the next use initializes again. */
  private async dropClient(): Promise<void> {
    const client = this.client;
    this.client = undefined;
    await client?.close().catch(() => {});
  }

  /**
   * Run one request. Network, TLS and auth failures drop the client so the next use
   * connects afresh (with a new token or pin if one was set). Requests are never retried
   * here: tool calls are not idempotent (think reboot_device).
   */
  private async run<T>(what: string, timeoutMs: number, fn: (client: Client) => Promise<T>): Promise<T> {
    const client = await this.connect();
    try {
      const result = await fn(client);
      this.options.onContact?.(this.info);
      return result;
    } catch (err) {
      const error = toDeviceError(err, this.target, { kind: "call", what, timeoutMs }, this.connectTimeoutMs);
      if (BACKOFF_KINDS.has(error.kind) || error.kind === "auth" || error.kind === "cert-mismatch" || error.kind === "tls") {
        await this.dropClient();
        this.recordFailure(error, false);
      }
      throw error;
    }
  }

  /** Fetch the device's tools, resources, resource templates and prompts. */
  async fetchCatalog(): Promise<DeviceCatalog> {
    return this.run("Listing the catalog", this.connectTimeoutMs * 2, async (client) => {
      const capabilities = client.getServerCapabilities() ?? {};
      const options = { timeout: this.connectTimeoutMs * 2 };
      const tools: Tool[] = [];
      const resources: Resource[] = [];
      const resourceTemplates: ResourceTemplate[] = [];
      const prompts: Prompt[] = [];

      if (capabilities.tools) tools.push(...(await allPages((params) => client.listTools(params, options), (p) => p.tools)));
      if (capabilities.resources) {
        resources.push(...(await allPages((params) => client.listResources(params, options), (p) => p.resources)));
        resourceTemplates.push(...(await allPages((params) => client.listResourceTemplates(params, options), (p) => p.resourceTemplates)));
      }
      if (capabilities.prompts) prompts.push(...(await allPages((params) => client.listPrompts(params, options), (p) => p.prompts)));

      return {
        serverInfo: this.info ?? { name: "unknown", version: "0" },
        capabilities,
        tools,
        resources,
        resourceTemplates,
        prompts,
        fetched_at: new Date(this.now()).toISOString(),
      };
    });
  }

  /**
   * Call a tool and return the device's result unchanged: content, structuredContent
   * and isError all pass through. Uses the raw request rather than Client.callTool so
   * the SDK does not re-validate the result against the tool's output schema.
   */
  async callTool(name: string, args: Record<string, unknown> | undefined, options: CallOptions = {}): Promise<CallToolResult> {
    const timeoutMs = options.timeoutMs ?? this.callTimeoutMs;
    return this.run(`Tool call '${name}'`, timeoutMs, (client) =>
      client.request({ method: "tools/call", params: { name, arguments: args ?? {} } }, CallToolResultSchema, this.requestOptions(timeoutMs, options)),
    );
  }

  async readResource(uri: string, options: CallOptions = {}): Promise<ReadResourceResult> {
    const timeoutMs = options.timeoutMs ?? this.callTimeoutMs;
    return this.run(`Reading resource '${uri}'`, timeoutMs, (client) => client.readResource({ uri }, this.requestOptions(timeoutMs, options)));
  }

  async getPrompt(name: string, args: Record<string, string> | undefined, options: CallOptions = {}): Promise<GetPromptResult> {
    const timeoutMs = options.timeoutMs ?? this.callTimeoutMs;
    return this.run(`Prompt '${name}'`, timeoutMs, (client) =>
      client.getPrompt({ name, ...(args ? { arguments: args } : {}) }, this.requestOptions(timeoutMs, options)),
    );
  }

  private requestOptions(timeoutMs: number, options: CallOptions): RequestOptions {
    return {
      timeout: timeoutMs,
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.onprogress ? { onprogress: options.onprogress } : {}),
    };
  }

  /**
   * Find out whether the device's token is accepted by wlanpi-core, by calling a
   * read-only tool that goes to the core API. Never throws.
   */
  async verifyToken(timeoutMs = this.connectTimeoutMs * 2): Promise<TokenCheck> {
    try {
      const result = await this.callTool(TOKEN_CHECK_TOOL, {}, { timeoutMs });
      if (!result.isError) return { status: "valid" };
      if (isCoreAuthFailure(result)) {
        return { status: "rejected", error: new DeviceError("auth", this.name, tokenRejectedMessage(this.target, "wlanpi-core returned 401")) };
      }
      const text = result.content.map((c) => (c.type === "text" ? c.text : "")).join(" ");
      return { status: "unknown", reason: `${TOKEN_CHECK_TOOL} failed: ${text}` };
    } catch (err) {
      const error = toDeviceError(err, this.target, { kind: "call", what: "Checking the token", timeoutMs }, this.connectTimeoutMs);
      return error.kind === "auth" ? { status: "rejected", error } : { status: "unknown", reason: error.message };
    }
  }

  /**
   * Quick reachability check with a short timeout, ignoring any backoff. Never throws.
   * A success resets the backoff, so a recovered device is usable straight away.
   */
  async probe(timeoutMs = DEFAULT_PROBE_TIMEOUT_MS): Promise<ProbeResult> {
    const started = this.now();
    try {
      if (this.connecting) await this.connecting;
      else if (!this.client) await this.startConnect(timeoutMs);
      else {
        try {
          await this.client.ping({ timeout: timeoutMs });
        } catch (err) {
          await this.dropClient();
          throw this.recordFailure(toDeviceError(err, this.target, { kind: "connect", timeoutMs }, this.connectTimeoutMs), false);
        }
        this.recordSuccess();
      }
      return { ok: true, latencyMs: this.now() - started, serverInfo: this.info };
    } catch (err) {
      return { ok: false, error: toDeviceError(err, this.target, { kind: "connect", timeoutMs }, this.connectTimeoutMs) };
    }
  }

  /** Close the client and the connection pool. The object can connect again afterwards. */
  async close(): Promise<void> {
    await this.dropClient();
    const dispatcher = this.dispatcher;
    this.dispatcher = undefined;
    await dispatcher?.close().catch(() => {});
  }
}
