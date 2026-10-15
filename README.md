# WLAN Pi MCP Extension

A local Claude extension that connects Claude Desktop and Claude Code to one or more [WLAN Pi](https://www.wlanpi.com) devices running [wlanpi-mcp](https://github.com/WLAN-Pi/wlanpi-mcp).

> **Status:** early development (Phase 0 scaffold). Not ready for use yet.

## What and Why

Each WLAN Pi runs `wlanpi-mcp`, an MCP server served over HTTPS on the Pi with a self-signed certificate. Pis live on private LANs, so Claude's cloud-hosted connectors cannot reach them. This extension runs on your machine, speaks MCP over stdio to Claude, and forwards to any number of Pis over pinned TLS. You install it once, add a Pi by hostname or IP, and every `wlanpi-mcp` tool becomes available with a `device` argument to pick the Pi.

## Features

- One install, any number of WLAN Pis.
- Trust on first use (TOFU) certificate pinning per device, with an explicit re-trust step when a certificate changes.
- One aggregated tool list with a `device` routing argument, so the tool list does not grow with device count.
- Each Pi's resources exposed as `wlanpi://<device>/...`, and its prompts with a `device` argument.
- Cached tool lists, so a Pi that is offline at startup still has its tools listed and calls to it fail with a clear error.

## Installation

Coming soon: a `.mcpb` bundle for Claude Desktop and a plugin marketplace for Claude Code.

- **Claude Desktop** runs the extension on its own bundled Node.js, so nothing else needs to be installed.
- **Claude Code** runs the extension with `node`, so Node.js 22.19 or later must be on your `PATH`.

## Usage

Ask Claude in plain language. The extension's own tools manage the list of Pis:

| Tool | What it does |
|---|---|
| `add_wlanpi` | Register a Pi by hostname or IP, pin its certificate, check wlanpi-mcp answers |
| `list_wlanpis` | Show registered Pis, whether each answers, its version and when it was last seen |
| `remove_wlanpi` | Forget a Pi, its pinned certificate and its token |
| `rename_wlanpi` | Change the name a Pi is known by |
| `trust_wlanpi_cert` | Re-pin a Pi's certificate after it legitimately changed |
| `set_wlanpi_token` | Set or replace a Pi's wlanpi-core token |

Every wlanpi-mcp tool is listed once, with a `device` argument naming the Pi to run on. With one Pi registered, `device` is optional. If Pis run different wlanpi-mcp versions, a tool's description lists which Pis offer it.

Each Pi's resources appear under its own prefix: `device://info` on the Pi named `lab` is `wlanpi://lab/device/info`. Prompts such as `health_check` are listed once and take a `device` argument like tools do.

### Getting a Token

wlanpi-mcp requires a wlanpi-core token. On the Pi, run:

```bash
sudo getjwt claude
```

Use the `access_token` it prints, either in `add_wlanpi` or later with `set_wlanpi_token`. Tokens expire (7 days by default); when one does, tool calls say so and tell you to run the command again.

A token passed to a tool is visible in your Claude conversation. To keep it out, set the extension's default token in its settings instead.

### Verifying the Certificate

`add_wlanpi` returns the Pi's certificate fingerprint. Compare it with the Pi:

```bash
openssl x509 -in /etc/nginx/ssl/self-signed-wlanpi.cert -noout -fingerprint -sha256
```

If a Pi is reimaged it gets a new certificate, and the extension refuses to connect until you confirm the new fingerprint with `trust_wlanpi_cert`.

## Quick Local Test

Coming soon: a manual checklist for testing against a real WLAN Pi.

## Development and Contributing

Requires Node.js 22.19 or later.

```bash
npm install
npm run check   # lint, typecheck, tests
npm run build   # bundle to dist/index.js
npm run pack    # build and pack wlanpi-mcp-extension.mcpb
```

See [WLAN-Pi/developers](https://github.com/WLAN-Pi/developers) for WLAN Pi contribution guidelines. Debugging notes live in [TROUBLESHOOTING.md](TROUBLESHOOTING.md).

## Changelog and Releases

See [CHANGELOG.md](CHANGELOG.md) and the GitHub Releases page.

## Authors

- Jake Snyder

## License

BSD 3-Clause. See [LICENSE](LICENSE).
