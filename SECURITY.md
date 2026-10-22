# Security Policy

## Reporting a Vulnerability

Please report security problems privately, through GitHub's private vulnerability reporting: on this repository's **Security** tab, choose **Report a vulnerability**. Do not open a public issue.

Include what you found, how to reproduce it, and the extension version (`list_wlanpis` and the log both show it). You should get a reply within a week.

## Supported Versions

Fixes go into the latest release only. Claude Desktop and Claude Code users get them by updating the extension.

## Scope

The extension's own code and packaging are in scope: certificate pinning, token handling, the device registry, and the release workflow. Problems in wlanpi-mcp or wlanpi-core on the Pi belong to those projects; see [WLAN-Pi](https://github.com/WLAN-Pi).

The README's [Security Model](README.md#security-model) describes what the extension protects against.
