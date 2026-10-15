# Changelog

## Unreleased

- TLS trust: trust-on-first-use certificate pinning checked on every connection right after the handshake, before any request or token is sent, plus an optional CA mode with normal verification. Process-wide TLS settings are never changed.
- Device registry: `devices.json` in the per-user config directory, written atomically with `0600` permissions, with a per-device catalog cache. A corrupt file is moved aside, never dropped.
- Input validation for hosts (hostname, IPv4, IPv6, optional port; URLs and credentials rejected), device names, and the `seed_devices` list.
- Configuration from environment variables, and a stderr-only logger that redacts tokens.
- Project scaffold: TypeScript build, lint, tests, CI, and MCPB manifest stub.
