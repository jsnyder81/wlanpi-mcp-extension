// Check the bundled extension against a real WLAN Pi, end to end over stdio, the way
// Claude launches it. Uses only read-only Pi tools, plus two failure paths that change
// nothing on the Pi: a wrong pinned certificate and a rejected token.
//
// Usage:
//   WLANPI_TOKEN=<jwt> node scripts/check-device.mjs <host[:port]> [--entry dist/index.mjs]
//   node scripts/check-device.mjs <host[:port]> --token-file <path>
//
// The token is passed to the extension as WLANPI_BRIDGE_DEFAULT_TOKEN, never as an
// argument, and the script checks it never appears in the extension's logs. A temporary
// config directory is used, so your real devices.json is untouched.
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { entry: { type: "string", default: "dist/index.mjs" }, "token-file": { type: "string" }, name: { type: "string", default: "pi" } },
});
const host = positionals[0];
if (!host) {
  console.error("Usage: node scripts/check-device.mjs <host[:port]> [--token-file path] [--entry dist/index.mjs]");
  process.exit(2);
}
const token = (values["token-file"] ? await readFile(values["token-file"], "utf8") : process.env.WLANPI_TOKEN ?? "").trim();
if (!token) {
  console.error("Give the token with WLANPI_TOKEN or --token-file (on the Pi: sudo getjwt claude).");
  process.exit(2);
}
const entry = resolve(values.entry);
const name = values.name;
const configDir = await mkdtemp(join(tmpdir(), "wlanpi-check-"));

const READ_ONLY_TOOLS = ["get_device_info", "get_device_stats", "get_network_interfaces", "list_allowed_services"];
let stderr = "";
let failures = 0;

function report(ok, label, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `\n      ${detail.replaceAll("\n", "\n      ")}` : ""}`);
}

const text = (result) => result.content?.map((c) => (c.type === "text" ? c.text : `[${c.type}]`)).join("") ?? "";
const short = (s, n = 160) => (s.length > n ? `${s.slice(0, n)}...` : s);

async function start() {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entry],
    env: { ...getDefaultEnvironment(), WLANPI_BRIDGE_CONFIG_DIR: configDir, WLANPI_BRIDGE_LOG_LEVEL: "debug", WLANPI_BRIDGE_DEFAULT_TOKEN: token },
    stderr: "pipe",
  });
  transport.stderr?.on("data", (chunk) => (stderr += chunk.toString()));
  const client = new Client({ name: "check-device", version: "0.0.0" });
  await client.connect(transport);
  return client;
}

const call = async (client, tool, args = {}) => client.callTool({ name: tool, arguments: args });

let client;
try {
  console.log(`Checking ${host} with ${entry}\n`);
  client = await start();
  const server = client.getServerVersion();
  report(true, `extension started: ${server.name} ${server.version}`);

  // add_wlanpi: trust on first use, MCP initialize, save.
  const added = await call(client, "add_wlanpi", { host, name });
  const info = added.structuredContent ?? {};
  report(
    !added.isError && info.status === "ready" && info.token_verified === true,
    "add_wlanpi pins the certificate, reaches wlanpi-mcp and verifies the token with wlanpi-core",
    added.isError ? text(added) : `status ${info.status}, token verified ${info.token_verified}, wlanpi-mcp ${info.server?.version}, ${info.tool_count} tools`,
  );
  if (added.isError) throw new Error("Cannot continue without the device.");
  const fingerprint = info.certificate.fingerprint_sha256;
  console.log(`      certificate ${info.certificate.subject}, valid to ${info.certificate.valid_to}`);
  console.log(`      fingerprint ${fingerprint}`);
  console.log("      compare on the Pi: openssl x509 -in /etc/nginx/ssl/self-signed-wlanpi.cert -noout -fingerprint -sha256");

  const tools = (await client.listTools()).tools;
  const deviceInfo = tools.find((t) => t.name === "get_device_info");
  report(!!deviceInfo && !deviceInfo.inputSchema.required?.includes("device"), "Pi tools listed once, device optional with one Pi", `${tools.length} tools in total`);

  const listed = await call(client, "list_wlanpis");
  const row = listed.structuredContent?.devices?.[0];
  report(row?.reachable === true && row?.token_valid === true, "list_wlanpis probes the Pi and its token", row ? `reachable ${row.reachable}, token valid ${row.token_valid}, ${row.latency_ms} ms, version ${row.server_version}` : text(listed));

  for (const tool of READ_ONLY_TOOLS) {
    if (!tools.some((t) => t.name === tool)) {
      report(false, `${tool} is offered by this Pi`);
      continue;
    }
    const started = Date.now();
    const result = await call(client, tool);
    report(!result.isError, `${tool}`, `${Date.now() - started} ms: ${short(text(result))}`);
  }

  // Resources and prompts.
  const resources = (await client.listResources()).resources;
  const uri = `wlanpi://${name}/device/info`;
  report(resources.some((r) => r.uri === uri), "resources are listed under wlanpi://<device>/", `${resources.length} resources`);
  try {
    const read = await client.readResource({ uri });
    report(read.contents[0]?.uri === uri, `read ${uri}`, short(read.contents[0]?.text ?? ""));
  } catch (err) {
    report(false, `read ${uri}`, err.message);
  }
  const prompts = (await client.listPrompts()).prompts;
  if (prompts.some((p) => p.name === "health_check")) {
    const prompt = await client.getPrompt({ name: "health_check", arguments: {} });
    report(text({ content: [prompt.messages[0]?.content ?? {}] }).startsWith(`This is about WLAN Pi '${name}'`), "prompt health_check renders with the device note");
  } else {
    report(false, "prompt health_check is offered", `${prompts.length} prompts: ${prompts.map((p) => p.name).join(", ")}`);
  }

  // A rejected token: set a bad one, then put the real one back.
  const bad = await call(client, "set_wlanpi_token", { device: name, token: "not-a-valid-token" });
  report(bad.structuredContent?.status === "rejected", "a bad token is rejected by wlanpi-core", short(bad.structuredContent?.error ?? text(bad), 220));
  const rejectedCall = await call(client, "get_device_info");
  report(rejectedCall.isError && /set_wlanpi_token/.test(text(rejectedCall)), "a tool call with the bad token explains the fix", short(text(rejectedCall), 220));
  const good = await call(client, "set_wlanpi_token", { device: name, token });
  report(good.structuredContent?.status === "accepted", "the real token is accepted again");

  // A changed certificate: corrupt the stored pin, restart, and expect a refusal.
  await client.close();
  const file = join(configDir, "devices.json");
  const saved = JSON.parse(await readFile(file, "utf8"));
  saved.devices[0].cert_sha256 = Array(32).fill("AB").join(":");
  await writeFile(file, JSON.stringify(saved, null, 2));
  client = await start();
  const refused = await call(client, "get_device_info");
  report(refused.isError && text(refused).includes(`presented ${fingerprint}`), "a certificate that does not match the pin is refused", short(text(refused), 260));
  const trusted = await call(client, "trust_wlanpi_cert", { device: name, fingerprint });
  report(trusted.structuredContent?.status === "trusted", "trust_wlanpi_cert re-pins the presented certificate");
  const after = await call(client, "get_device_info");
  report(!after.isError, "calls work again after re-pinning");

  report(!stderr.includes(token), "the token never appears in the extension's logs");
} catch (err) {
  report(false, "unexpected error", err.stack ?? String(err));
} finally {
  await client?.close().catch(() => {});
  await rm(configDir, { recursive: true, force: true });
}

console.log(`\n${failures === 0 ? "All checks passed." : `${failures} check(s) failed.`}`);
if (failures && process.env.WLANPI_CHECK_VERBOSE) console.log(`\nExtension log:\n${stderr}`);
process.exit(failures === 0 ? 0 : 1);
