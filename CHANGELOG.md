# Changelog

## Unreleased

- Device connections: one MCP client per Pi, connected lazily over pinned TLS, with backoff after failed connection attempts (capped at 30 s), connect and call timeouts, and error messages that name the device and the fix (unreachable, changed certificate, missing or expired token, wrong path, wlanpi-mcp down, slow call). Results pass through unchanged.
- The default tool call timeout is 300 s, not 60 s, because the Pi's speedtest can take 180 s.
- IPv6 zone IDs (`fe80::1%en0`) are rejected with a clear message, since URLs cannot carry them.
- TLS trust: trust-on-first-use certificate pinning checked on every connection right after the handshake, before any request or token is sent, plus an optional CA mode with normal verification. Process-wide TLS settings are never changed.
- Device registry: `devices.json` in the per-user config directory, written atomically with `0600` permissions, with a per-device catalog cache. A corrupt file is moved aside, never dropped.
- Input validation for hosts (hostname, IPv4, IPv6, optional port; URLs and credentials rejected), device names, and the `seed_devices` list.
- Configuration from environment variables, and a stderr-only logger that redacts tokens.
- Project scaffold: TypeScript build, lint, tests, CI, and MCPB manifest stub.
