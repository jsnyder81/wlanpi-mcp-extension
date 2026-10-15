# WLAN Pi MCP Extension

A local Claude extension that connects Claude Desktop and Claude Code to one or more [WLAN Pi](https://www.wlanpi.com) devices running [wlanpi-mcp](https://github.com/WLAN-Pi/wlanpi-mcp).


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
| wlanpi-core tokens | One token per Pi as `name=token` pairs, e.g. `lab=eyJ..., field=eyJ...`, so tokens never appear in a conversation. With one Pi, the token alone is enough |
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

No configuration is needed. The plugin runs the extension with `node`, so Node.js 22.19 or later must be on your `PATH`. The optional settings above are read from environment variables instead (`WLANPI_BRIDGE_SEED_DEVICES`, `WLANPI_BRIDGE_TOKENS`, `WLANPI_BRIDGE_CA_FILE`; see [TROUBLESHOOTING.md](TROUBLESHOOTING.md#logging)) if they are set in the shell that starts Claude Code.

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
| `list_wlanpi_tools` | List the tools a Pi offers, or describe one in full |
| `call_wlanpi_tool` | Run any Pi tool by name |

Every wlanpi-mcp tool is listed once, with a `device` argument naming the Pi to run on. Claude Desktop only reads this list when the extension starts, so a Pi added during a conversation has its tools offered after the extension restarts; until then Claude reaches them through `list_wlanpi_tools` and `call_wlanpi_tool`. With one Pi registered, `device` is optional. If Pis run different wlanpi-mcp versions, a tool's description lists which Pis offer it.

Each Pi's resources appear under its own prefix: `device://info` on the Pi named `lab` is `wlanpi://lab/device/info`. Prompts such as `health_check` are listed once and take a `device` argument like tools do.

### Getting a Token

wlanpi-mcp requires a wlanpi-core token. On the Pi, run:

```bash
sudo getjwt claude
```

Each Pi issues its own tokens. Put each Pi's `access_token` in the extension's **wlanpi-core tokens** setting as `name=token` pairs, using the same names as in **WLAN Pis to add at startup** (or as shown by `list_wlanpis`). Tokens in the setting replace stored ones every time the extension starts.

Tokens expire (7 days by default). When one does, `list_wlanpis` shows `token_valid: false` and tool calls say so. Run `sudo getjwt claude` on that Pi again, paste the new token into the setting, and restart the extension (turn it off and on in **Settings → Extensions**).

You can also give a token to `add_wlanpi` or `set_wlanpi_token`, but it is then visible in your conversation.

### Verifying the Certificate

`add_wlanpi` returns the Pi's certificate fingerprint. Compare it with the Pi:

```bash
openssl x509 -in /etc/nginx/ssl/self-signed-wlanpi.cert -noout -fingerprint -sha256
```

If a Pi is reimaged it gets a new certificate, and the extension refuses to connect until you confirm the new fingerprint with `trust_wlanpi_cert`.

## Quick Local Test

### Automated Check

`scripts/check-device.mjs` drives the built extension over stdio against a real Pi, the way Claude runs it. It adds the Pi (pinning its certificate and verifying the token), lists it, calls a few read-only tools, reads a resource, renders a prompt, and checks that a bad token and a wrong pinned certificate are both refused. It changes nothing on the Pi and uses a temporary config directory.

```bash
npm run build
ssh wlanpi.local 'sudo getjwt --no-color claude'   # copy the access_token into a file
node scripts/check-device.mjs wlanpi.local --token-file ./token
```

Add `--entry <dir>/dist/index.mjs` to check an unpacked `.mcpb` or an assembled plugin instead.

### Manual Checklist

Run through these in Claude Desktop with the `.mcpb`, and again in Claude Code with the plugin:

1. Install with no settings. The six management tools are listed.
2. Ask Claude to "add my WLAN Pi at `<host>`" with a token. It shows the certificate fingerprint and `token_verified: true`.
3. On the Pi, run `openssl x509 -in /etc/nginx/ssl/self-signed-wlanpi.cert -noout -fingerprint -sha256` and confirm it matches.
4. Ask for the Pi's device info, then for a Wi-Fi scan. The scan completes without a timeout.
5. Ask Claude to read the `wlanpi://<name>/device/info` resource, and to run the `health_check` prompt.
6. Start a capture with `start_pcap_file`, stop it, and fetch it with `fetch_pcap_file`. The file comes back intact.
7. With a second Pi added, ask for device info from both in one request. The tool list does not grow.
8. Set an invalid token with `set_wlanpi_token`. It is reported as rejected, and a tool call says to run `sudo getjwt claude`. Set the real token again.
9. Reimage a Pi or regenerate its certificate. Calls are refused with both fingerprints until `trust_wlanpi_cert` is called with the new one.
10. Power a Pi off. `list_wlanpis` shows it unreachable, its tools are still listed, and calls fail with a clear message. Power it on, and it works again.

## Advanced: Direct Connection

The extension is the easy path, but any MCP client that speaks streamable HTTP can talk to a Pi directly at `https://<host>:8767/mcp`, sending the wlanpi-core token as `Authorization: Bearer <token>`. You then handle certificate trust yourself, for example by copying the Pi's `/etc/nginx/ssl/self-signed-wlanpi.cert` to your machine.

For Claude Code:

```bash
claude mcp add --transport http wlanpi https://wlanpi.local:8767/mcp --header "Authorization: Bearer ${WLANPI_TOKEN}"
NODE_EXTRA_CA_CERTS=./self-signed-wlanpi.cert claude
```

Normal certificate checks also require the address to match a name in the certificate, and a Pi's certificate covers only `wlanpi.local`. So `NODE_EXTRA_CA_CERTS` works when you connect as `https://wlanpi.local:8767/mcp`, but not by IP address or another hostname. The extension avoids this by pinning each Pi's certificate instead.

MCP gateways and aggregators such as LiteLLM or MetaMCP can be pointed at the same URL. Each Pi is then a separate server, without the extension's single tool list, pinning and token checks.

## Roadmap

- Find Pis on the local network automatically (mDNS), instead of adding them by address.
- Standalone builds, so the Claude Code plugin needs no Node.js on the `PATH`.

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

1. Bump the version in `package.json` (and `package-lock.json`), `manifest.json`, `plugin/.claude-plugin/plugin.json` and `src/version.ts` (a test fails if they differ), and update `CHANGELOG.md`.
2. Merge to `main`, then tag it: `git tag v0.2.0 && git push origin v0.2.0`.

The release workflow checks, packs and smoke-tests both packages, attaches the `.mcpb` to a GitHub Release, and pushes the assembled plugin to the `release` branch that the marketplace installs from. Claude Code updates the plugin when the version in `plugin.json` changes.

See [WLAN-Pi/developers](https://github.com/WLAN-Pi/developers) for WLAN Pi contribution guidelines. Debugging notes live in [TROUBLESHOOTING.md](TROUBLESHOOTING.md).

## Changelog and Releases

See [CHANGELOG.md](CHANGELOG.md) and the GitHub Releases page.

## Authors

- Jake Snyder

## License

BSD 3-Clause. See [LICENSE](LICENSE).
