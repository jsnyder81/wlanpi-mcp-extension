# Troubleshooting

Debugging notes for the WLAN Pi MCP Extension. Entries are added as features land.

## Where Device Settings Are Stored

Registered devices, their pinned certificate fingerprints and their tokens are kept in `devices.json`, readable only by your user (`0600` on macOS and Linux):

| Platform | Location |
|---|---|
| macOS | `~/Library/Application Support/wlanpi-mcp-bridge/devices.json` |
| Linux | `$XDG_CONFIG_HOME/wlanpi-mcp-bridge/devices.json` (default `~/.config/...`) |
| Windows | `%APPDATA%\wlanpi-mcp-bridge\devices.json` |

Set `WLANPI_BRIDGE_CONFIG_DIR` to use a different directory. The `cache/` folder next to it holds each device's last known tool list and is safe to delete.

If `devices.json` cannot be read, the extension renames it to `devices.json.bad-<timestamp>`, logs an error and starts with no devices. Your old entries are still in that file.

## Logging

Logs go to stderr only, never stdout. Set `WLANPI_BRIDGE_LOG_LEVEL` to `error`, `warn`, `info` (default) or `debug`. Tokens are redacted from every log line.

| Variable | Purpose |
|---|---|
| `WLANPI_BRIDGE_CONFIG_DIR` | Override the config directory |
| `WLANPI_BRIDGE_LOG_LEVEL` | Log verbosity |
| `WLANPI_BRIDGE_CALL_TIMEOUT_MS` | Tool call timeout (default 60000) |
| `WLANPI_BRIDGE_SEED_DEVICES` | Devices to add at startup, e.g. `lab=10.0.0.5, field=wlanpi-7.local` |
| `WLANPI_BRIDGE_DEFAULT_TOKEN` | Token applied to seeded devices |
| `WLANPI_BRIDGE_CA_FILE` | CA file to validate against instead of pinning |
