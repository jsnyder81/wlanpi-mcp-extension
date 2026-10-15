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

## Certificate Changed

Each WLAN Pi serves a self-signed certificate. The extension stores its SHA-256 fingerprint when you add the Pi and refuses any later connection that presents a different certificate. It drops the connection right after the TLS handshake, so your token is never sent. The error names both fingerprints.

A Pi gets a new certificate when it is reimaged. To check the current fingerprint, run this on the Pi:

```bash
openssl x509 -in /etc/nginx/ssl/self-signed-wlanpi.cert -noout -fingerprint -sha256
```

If it matches the "presented" fingerprint in the error, ask Claude to call `trust_wlanpi_cert` with that fingerprint. If it does not match, something else is answering at that address: do not re-trust it.

## Token Rejected or Missing

wlanpi-mcp passes your token to wlanpi-core, which checks it. A message saying the token was rejected means it expired (after 7 days by default), was revoked, or belongs to another Pi. On the Pi, run `sudo getjwt claude` and give the new `access_token` to `set_wlanpi_token`. The extension never refreshes tokens itself.

## Device Unreachable

The extension connects to `https://<host>:8767/mcp`. If a Pi is reported unreachable:

- Check the Pi is on and on a network you can reach (`ping <host>`).
- Check port 8767 is open on the Pi (`sudo ufw status`), and that `systemctl status wlanpi-mcp nginx` shows both running.
- After a failed connection attempt the extension waits before trying again, up to 30 seconds. `list_wlanpis` always checks right away and clears the wait when the Pi answers.

## Tool Calls Time Out

Tool calls wait up to 300 seconds by default. A timed-out call may still be running on the Pi. Set `WLANPI_BRIDGE_CALL_TIMEOUT_MS` to wait longer.

## Logging

Logs go to stderr only, never stdout. Set `WLANPI_BRIDGE_LOG_LEVEL` to `error`, `warn`, `info` (default) or `debug`. Tokens are redacted from every log line.

| Variable | Purpose |
|---|---|
| `WLANPI_BRIDGE_CONFIG_DIR` | Override the config directory |
| `WLANPI_BRIDGE_LOG_LEVEL` | Log verbosity |
| `WLANPI_BRIDGE_CALL_TIMEOUT_MS` | Tool call timeout in milliseconds (default 300000, five minutes) |
| `WLANPI_BRIDGE_SEED_DEVICES` | Devices to add at startup, e.g. `lab=10.0.0.5, field=wlanpi-7.local` |
| `WLANPI_BRIDGE_DEFAULT_TOKEN` | Token applied to seeded devices |
| `WLANPI_BRIDGE_CA_FILE` | CA file to validate against instead of pinning |
