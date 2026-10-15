# Changelog

## Unreleased

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
