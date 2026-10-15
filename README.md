# WLAN Pi MCP Extension

A local Claude extension that connects Claude Desktop and Claude Code to one or more [WLAN Pi](https://www.wlanpi.com) devices running [wlanpi-mcp](https://github.com/WLAN-Pi/wlanpi-mcp).

> **Status:** pre-release. Feature complete for v1 and tested against a simulated Pi; validation on real WLAN Pi hardware is in progress.

## What and Why

Each WLAN Pi runs `wlanpi-mcp`, an MCP server served over HTTPS on the Pi with a self-signed certificate. Pis live on private LANs, so Claude's cloud-hosted connectors cannot reach them. This extension runs on your machine, speaks MCP over stdio to Claude, and forwards to any number of Pis over pinned TLS. You install it once, add a Pi by hostname or IP, and every `wlanpi-mcp` tool becomes available with a `device` argument to pick the Pi.

## Features

- One install, any number of WLAN Pis.
- Trust on first use (TOFU) certificate pinning per device, with an explicit re-trust step when a certificate changes.
- One aggregated tool list with a `device` routing argument, so the tool list does not grow with device count.
- Each Pi's resources exposed as `wlanpi://<device>/...`, and its prompts with a `device` argument.
- Cached tool lists, so a Pi that is offline at startup still has its tools listed and calls to it fail with a clear error.

## Installation

### Claude Desktop

1. Download `wlanpi-mcp-extension-<version>.mcpb` from the [latest release](https://github.com/jsnyder81/wlanpi-mcp-extension/releases/latest).
2. Open it, or drag it onto Claude Desktop's **Settings > Extensions** page, and choose **Install**.

All settings are optional, so you can skip them and add Pis by asking Claude:

| Setting | Use |
|---|---|
| WLAN Pis to add at startup | `name=host` pairs, e.g. `lab=10.0.0.5, field=wlanpi-7.local` |
| wlanpi-core token | Token for Pis added without one, so it never appears in a conversation |
| CA certificate | Only if your Pis use certificates from your own CA |

Claude Desktop runs the extension on its own bundled Node.js, so nothing else needs to be installed.

### Claude Code

In Claude Code, run:

```text
/plugin install wlanpi-mcp-extension --marketplace jsnyder81/wlanpi-mcp-extension
```

On Claude Code versions before 2.1.275, add the marketplace first:

```text
/plugin marketplace add jsnyder81/wlanpi-mcp-extension
/plugin install wlanpi-mcp-extension@wlanpi
```

No configuration is needed. The plugin runs the extension with `node`, so Node.js 22.19 or later must be on your `PATH`. The optional settings above are read from environment variables instead (`WLANPI_BRIDGE_SEED_DEVICES`, `WLANPI_BRIDGE_DEFAULT_TOKEN`, `WLANPI_BRIDGE_CA_FILE`; see [TROUBLESHOOTING.md](TROUBLESHOOTING.md#logging)) if they are set in the shell that starts Claude Code.

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
npm run check    # lint, typecheck, tests
npm run build    # bundle to dist/index.mjs
npm run pack     # build and pack wlanpi-mcp-extension.mcpb
npm run plugin   # build and assemble the Claude Code plugin in build/plugin
```

Try a local build in Claude Code with `claude --plugin-dir build/plugin`.

### Releasing

1. Bump the version in `package.json`, `manifest.json`, `plugin/.claude-plugin/plugin.json` and `src/version.ts` (a test fails if they differ), and update `CHANGELOG.md`.
2. Merge to `main`, then tag it: `git tag v0.2.0 && git push origin v0.2.0`.

The release workflow checks, packs and smoke-tests both packages, attaches the `.mcpb` to a GitHub Release, and pushes the assembled plugin to the `release` branch that the marketplace installs from. Claude Code updates the plugin when the version in `plugin.json` changes.

See [WLAN-Pi/developers](https://github.com/WLAN-Pi/developers) for WLAN Pi contribution guidelines. Debugging notes live in [TROUBLESHOOTING.md](TROUBLESHOOTING.md).

## Changelog and Releases

See [CHANGELOG.md](CHANGELOG.md) and the GitHub Releases page.

## Authors

- Jake Snyder

## License

BSD 3-Clause. See [LICENSE](LICENSE).
