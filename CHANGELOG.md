# Changelog

## 0.1.1 (2026-10-15)

Fixes found by running 0.1.0 in Claude Desktop.

- Claude Desktop reads an extension's tool list once, when the extension starts, and ignores later `tools/list_changed` notifications. A Pi added a few seconds after startup (from `seed_devices`, or with `add_wlanpi` in a conversation) never had its tools offered. Two fixes:
  - New tools `list_wlanpi_tools` and `call_wlanpi_tool` are always present and run any Pi tool by name, so a Pi is usable even when the client's tool list is stale.
  - The first tool, resource and prompt lists wait up to 8 seconds for seeded Pis and Pis with no cached tool list, so Desktop's one reading includes them.
- One token per Pi: the token setting is now `tokens`, taking `name=token` pairs (a single token alone still works for one Pi). Tokens from settings replace stored ones every time the extension starts, so renewing an expired token is: paste it into the settings and restart. Desktop users who set the old single token need to enter it again in the new field; `WLANPI_BRIDGE_DEFAULT_TOKEN` is still read.

## 0.1.0 (2026-10-15)

First release, tested against a WLAN Pi M4 running wlanpi-mcp 1.30.0.

- Tokens are verified with wlanpi-core (through the read-only `get_device_info` tool), because wlanpi-mcp accepts any token for listing tools. `add_wlanpi` reports `token_verified`, `set_wlanpi_token` reports `accepted` only after the check, `list_wlanpis` reports `token_valid`, and a Pi tool that fails with wlanpi-core's 401 gets the fix added to its error.
- `scripts/check-device.mjs` checks the built extension against a real Pi.
- Packaging: full MCPB manifest with optional settings (seed devices, default token, CA file); Claude Code plugin and the `wlanpi` marketplace, installed from a `release` branch so `main` never carries the bundle; a release workflow that publishes both; CI smoke-tests the unpacked `.mcpb` and the assembled plugin on Linux and Windows. The bundle is now `dist/index.mjs` and needs no `package.json` beside it.
- Resources and prompts: each Pi's resources and templates under `wlanpi://<device>/...` with reads routed to that Pi; prompts merged once per name with a `device` argument, and a note naming the Pi added to the rendered prompt. `resources/list_changed` and `prompts/list_changed` are sent on real changes.
- Bridge server: management tools `add_wlanpi`, `list_wlanpis`, `remove_wlanpi`, `rename_wlanpi`, `trust_wlanpi_cert` and `set_wlanpi_token`; one merged copy of every Pi tool with a `device` routing argument (newest schema wins when versions differ); cached tool lists for offline Pis; `seed_devices` added at startup; `tools/list_changed` on real changes only.
- Device connections: one MCP client per Pi, connected lazily over pinned TLS, with backoff after failed connection attempts (capped at 30 s), connect and call timeouts, and error messages that name the device and the fix (unreachable, changed certificate, missing or expired token, wrong path, wlanpi-mcp down, slow call). Results pass through unchanged.
- The default tool call timeout is 300 s, not 60 s, because the Pi's speedtest can take 180 s.
- IPv6 zone IDs (`fe80::1%en0`) are rejected with a clear message, since URLs cannot carry them.
- TLS trust: trust-on-first-use certificate pinning checked on every connection right after the handshake, before any request or token is sent, plus an optional CA mode with normal verification. Process-wide TLS settings are never changed.
- Device registry: `devices.json` in the per-user config directory, written atomically with `0600` permissions, with a per-device catalog cache. A corrupt file is moved aside, never dropped.
- Input validation for hosts (hostname, IPv4, IPv6, optional port; URLs and credentials rejected), device names, and the `seed_devices` list.
- Configuration from environment variables, and a stderr-only logger that redacts tokens.
- Project scaffold: TypeScript build, lint, tests, CI, and MCPB manifest stub.
