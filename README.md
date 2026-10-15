# WLAN Pi MCP Extension

A local Claude extension that connects Claude Desktop and Claude Code to one or more [WLAN Pi](https://www.wlanpi.com) devices running [wlanpi-mcp](https://github.com/WLAN-Pi/wlanpi-mcp).

> **Status:** early development (Phase 0 scaffold). Not ready for use yet.

## What and Why

Each WLAN Pi runs `wlanpi-mcp`, an MCP server served over HTTPS on the Pi with a self-signed certificate. Pis live on private LANs, so Claude's cloud-hosted connectors cannot reach them. This extension runs on your machine, speaks MCP over stdio to Claude, and forwards to any number of Pis over pinned TLS. You install it once, add a Pi by hostname or IP, and every `wlanpi-mcp` tool becomes available with a `device` argument to pick the Pi.

## Features

Planned for v1:

- One install, any number of WLAN Pis.
- Trust on first use (TOFU) certificate pinning per device, with an explicit re-trust step when a certificate changes.
- One aggregated tool list with a `device` routing argument, so the tool list does not grow with device count.
- Pi resources exposed as `wlanpi://<device>/...` and prompts with a `device` argument.
- Cached tool lists, so a Pi that is offline at startup still has its tools listed and calls to it fail with a clear error.

## Installation

Coming soon: a `.mcpb` bundle for Claude Desktop and a plugin marketplace for Claude Code.

- **Claude Desktop** runs the extension on its own bundled Node.js, so nothing else needs to be installed.
- **Claude Code** runs the extension with `node`, so Node.js 22.19 or later must be on your `PATH`.

## Usage

Coming soon.

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
