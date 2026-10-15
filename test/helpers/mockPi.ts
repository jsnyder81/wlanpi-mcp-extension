import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from "node:http";
import { createServer, type Server as HttpsServer } from "node:https";
import type { AddressInfo, Socket } from "node:net";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  type CallToolResult,
  CallToolRequestSchema,
  GetPromptRequestSchema,
  type GetPromptResult,
  ListPromptsRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  type Prompt,
  ReadResourceRequestSchema,
  type ReadResourceResult,
  type Resource,
  type ResourceTemplate,
  type ServerNotification,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { type TestCert, selfSignedCert } from "./certs.js";

export interface MockTool extends Tool {
  handler?: (args: Record<string, unknown>, ctx: MockToolContext) => Promise<CallToolResult> | CallToolResult;
}

export interface MockToolContext {
  signal: AbortSignal;
  progressToken?: string | number;
  sendNotification: (notification: ServerNotification) => Promise<void>;
}

export interface MockResource extends Resource {
  text?: string;
}

export interface MockPrompt extends Prompt {
  render?: (args: Record<string, string>) => GetPromptResult;
}

export interface MockPiOptions {
  /** serverInfo.version, like wlanpi-mcp's package version. */
  version?: string;
  /** The token wlanpi-core accepts. */
  token?: string;
  /**
   * How a wrong token fails. "core" (default) is what a real Pi does: wlanpi-mcp's
   * middleware only rejects a request with no Bearer token (HTTP 401), and a wrong token
   * fails later, when a tool or resource calls wlanpi-core. "http" rejects any wrong
   * token with HTTP 401 up front.
   */
  auth?: "core" | "http";
  tools?: MockTool[];
  resources?: MockResource[];
  resourceTemplates?: ResourceTemplate[];
  prompts?: MockPrompt[];
  cert?: TestCert;
  path?: string;
  /** JSON responses like the real Pi (default); false streams SSE so progress can flow. */
  jsonResponse?: boolean;
}

export interface MockPi {
  port: number;
  cert: TestCert;
  token: string;
  version: string;
  /** Every HTTP request received, in order (including rejected ones). */
  requests: Array<{ method: string; url: string; headers: IncomingHttpHeaders }>;
  /** Every tools/call that reached a tool, in order. */
  calls: Array<{ name: string; arguments: Record<string, unknown> }>;
  /** Serve a new certificate to new connections, like a reimaged Pi. */
  swapCert(cert?: TestCert): Promise<TestCert>;
  /** Stop accepting connections (the port is kept for start()). */
  stop(): Promise<void>;
  start(): Promise<void>;
  close(): Promise<void>;
}

export const DEFAULT_TOKEN = "test-token";

const text = (value: string): CallToolResult => ({ content: [{ type: "text", text: value }] });

/** A tool set shaped like a few real wlanpi-mcp tools. */
export function defaultTools(): MockTool[] {
  return [
    {
      name: "get_device_info",
      description: "Get WLAN Pi device information.",
      inputSchema: { type: "object", properties: {} },
      handler: () => ({ ...text('{"model":"WLAN Pi M4"}'), structuredContent: { model: "WLAN Pi M4" } }),
    },
    {
      name: "echo",
      description: "Return the arguments.",
      inputSchema: { type: "object", properties: { message: { type: "string" } }, required: ["message"] },
      handler: (args) => text(String(args.message)),
    },
    {
      name: "slow",
      description: "Wait, reporting progress.",
      inputSchema: { type: "object", properties: { ms: { type: "number" } } },
      handler: async (args, ctx) => {
        const ms = Number(args.ms ?? 1000);
        const steps = 4;
        for (let i = 1; i <= steps; i++) {
          await new Promise((resolve, reject) => {
            const timer = setTimeout(resolve, ms / steps);
            ctx.signal.addEventListener("abort", () => (clearTimeout(timer), reject(new Error("aborted"))), { once: true });
          });
          if (ctx.progressToken !== undefined) {
            await ctx.sendNotification({ method: "notifications/progress", params: { progressToken: ctx.progressToken, progress: i, total: steps } });
          }
        }
        return text(`waited ${ms} ms`);
      },
    },
    {
      name: "fetch_pcap_file",
      description: "Return a capture file as an embedded blob.",
      inputSchema: { type: "object", properties: {} },
      handler: () => ({
        content: [
          {
            type: "resource",
            resource: { uri: "file:///tmp/capture.pcapng", mimeType: "application/vnd.tcpdump.pcapng", blob: Buffer.from([0x0a, 0x0d, 0x0d, 0x0a, 0, 1, 2, 255]).toString("base64") },
          },
        ],
      }),
    },
    {
      name: "fails",
      description: "Return a tool error.",
      inputSchema: { type: "object", properties: {} },
      handler: () => ({ ...text("Service 'x' is not in the allowlist"), isError: true }),
    },
  ];
}

export function defaultResources(): MockResource[] {
  return [
    { uri: "device://info", name: "device_info", mimeType: "application/json", text: '{"model":"WLAN Pi M4"}' },
    { uri: "network://interfaces", name: "interfaces", mimeType: "application/json", text: '{"eth0":{}}' },
  ];
}

export function defaultResourceTemplates(): ResourceTemplate[] {
  return [{ uriTemplate: "services://status/{name}", name: "service_status", mimeType: "application/json" }];
}

export function defaultPrompts(): MockPrompt[] {
  return [
    {
      name: "diagnose_connectivity",
      description: "Walk through connectivity checks.",
      arguments: [{ name: "target", description: "Host to test", required: false }],
      render: (args) => ({ messages: [{ role: "user", content: { type: "text", text: `Diagnose connectivity to ${args.target ?? "the internet"}.` } }] }),
    },
  ];
}

/**
 * A stand-in WLAN Pi: an HTTPS server with a self-signed certificate serving MCP over
 * stateless streamable HTTP with JSON responses on /mcp, behind a Bearer check, the way
 * nginx and wlanpi-mcp do on a real Pi.
 */
export async function startMockPi(options: MockPiOptions = {}): Promise<MockPi> {
  const version = options.version ?? "0.6.17-3";
  const token = options.token ?? DEFAULT_TOKEN;
  const path = options.path ?? "/mcp";
  const tools = options.tools ?? defaultTools();
  const resources = options.resources ?? defaultResources();
  const resourceTemplates = options.resourceTemplates ?? defaultResourceTemplates();
  const prompts = options.prompts ?? defaultPrompts();
  let cert = options.cert ?? (await selfSignedCert("wlanpi"));

  const requests: MockPi["requests"] = [];
  const calls: MockPi["calls"] = [];
  const sockets = new Set<Socket>();

  const coreUnauthorized = "wlanpi-core returned 401: Unauthorized";

  function buildServer(tokenOk: boolean): Server {
    const server = new Server(
      { name: "wlanpi-mcp", version },
      {
        capabilities: {
          tools: {},
          ...(resources.length || resourceTemplates.length ? { resources: {} } : {}),
          ...(prompts.length ? { prompts: {} } : {}),
        },
      },
    );
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: tools.map(({ handler: _handler, ...tool }) => tool),
    }));
    server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      const tool = tools.find((t) => t.name === request.params.name);
      if (!tool) return { ...text(`Unknown tool: ${request.params.name}`), isError: true };
      const args = request.params.arguments ?? {};
      if (!tokenOk) return { ...text(`Error executing tool ${tool.name}: ${coreUnauthorized}`), isError: true };
      calls.push({ name: tool.name, arguments: args });
      return (await tool.handler?.(args, {
        signal: extra.signal,
        progressToken: request.params._meta?.progressToken,
        sendNotification: extra.sendNotification,
      })) ?? text("ok");
    });
    if (resources.length || resourceTemplates.length) {
      server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: resources.map(({ text: _text, ...r }) => r) }));
      server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({ resourceTemplates }));
      server.setRequestHandler(ReadResourceRequestSchema, async (request): Promise<ReadResourceResult> => {
        const { uri } = request.params;
        if (!tokenOk) throw new Error(coreUnauthorized);
        const resource = resources.find((r) => r.uri === uri);
        if (resource) return { contents: [{ uri, mimeType: resource.mimeType, text: resource.text ?? "" }] };
        const status = /^services:\/\/status\/(.+)$/.exec(uri);
        if (status) return { contents: [{ uri, mimeType: "application/json", text: JSON.stringify({ name: status[1], active: true }) }] };
        throw new Error(`Unknown resource: ${uri}`);
      });
    }
    if (prompts.length) {
      server.setRequestHandler(ListPromptsRequestSchema, async () => ({ prompts: prompts.map(({ render: _render, ...p }) => p) }));
      server.setRequestHandler(GetPromptRequestSchema, async (request) => {
        const prompt = prompts.find((p) => p.name === request.params.name);
        if (!prompt) throw new Error(`Unknown prompt: ${request.params.name}`);
        return prompt.render?.(request.params.arguments ?? {}) ?? { messages: [] };
      });
    }
    return server;
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    requests.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers });
    if ((req.url ?? "").split("?")[0] !== path) {
      res.writeHead(404, { "content-type": "application/json" }).end('{"detail":"Not Found"}');
      return;
    }
    const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1];
    if (!bearer || ((options.auth ?? "core") === "http" && bearer !== token)) {
      res.writeHead(401, { "content-type": "application/json" }).end('{"detail":"Missing or invalid bearer token"}');
      return;
    }
    // Stateless: no standalone SSE stream and no sessions to delete.
    if (req.method !== "POST") {
      res.writeHead(405, { allow: "POST" }).end();
      return;
    }
    const server = buildServer(bearer === token);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: options.jsonResponse ?? true });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res);
  }

  let https: HttpsServer = makeServer();
  let port = 0;

  function makeServer(): HttpsServer {
    const server = createServer({ key: cert.key, cert: cert.cert }, (req, res) => {
      handle(req, res).catch((err) => {
        if (!res.headersSent) res.writeHead(500).end(String(err));
      });
    });
    server.on("connection", (socket: Socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
    });
    server.on("tlsClientError", () => {});
    return server;
  }

  async function listen(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      https.once("error", reject);
      https.listen(port, "127.0.0.1", () => {
        https.off("error", reject);
        resolve();
      });
    });
    port = (https.address() as AddressInfo).port;
  }

  async function stop(): Promise<void> {
    if (!https.listening) return;
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => https.close(() => resolve()));
  }

  await listen();

  return {
    get port() {
      return port;
    },
    get cert() {
      return cert;
    },
    token,
    version,
    requests,
    calls,
    async swapCert(next) {
      cert = next ?? (await selfSignedCert("wlanpi-reimaged"));
      https.setSecureContext({ key: cert.key, cert: cert.cert });
      // Like a reboot after reimaging: existing connections do not survive.
      for (const socket of sockets) socket.destroy();
      return cert;
    },
    stop,
    async start() {
      if (https.listening) return;
      https = makeServer();
      await listen();
    },
    close: stop,
  };
}
