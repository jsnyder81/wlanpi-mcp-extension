/**
 * Errors the bridge returns to Claude. Each message is written to be shown as-is:
 * it names the device and says what to do next.
 */

/** Bad input from a tool argument or from config (host, name, port, seed list). */
export class ValidationError extends Error {
  override name = "ValidationError";
}

export class UnknownDeviceError extends Error {
  override name = "UnknownDeviceError";
  constructor(
    readonly device: string,
    registered: readonly string[],
  ) {
    super(
      `Unknown device '${device}'. ` +
        (registered.length > 0
          ? `Registered devices: ${registered.join(", ")}.`
          : "No devices are registered yet; add one with add_wlanpi."),
    );
  }
}

/**
 * The device presented a certificate other than the pinned one. The connection was
 * dropped right after the TLS handshake, before any request (or token) was sent.
 */
export class CertMismatchError extends Error {
  override name = "CertMismatchError";
  constructor(
    readonly expected: string,
    readonly presented: string,
    readonly device?: string,
  ) {
    super(
      `Certificate for ${device ? `'${device}'` : "the device"} changed. Pinned ${expected}, presented ${presented}. ` +
        "If this is expected (for example the Pi was reimaged), verify the new fingerprint on the Pi and call trust_wlanpi_cert.",
    );
  }
}

export class DuplicateDeviceError extends Error {
  override name = "DuplicateDeviceError";
  constructor(readonly device: string) {
    super(`A device named '${device}' is already registered. Choose another name or remove it first.`);
  }
}

export type DeviceErrorKind =
  /** Could not reach the device at all (refused, timed out, DNS, no route). */
  | "unreachable"
  /** The device presented a certificate other than the pinned one. */
  | "cert-mismatch"
  /** TLS failed for another reason, e.g. CA validation in CA mode. */
  | "tls"
  /** The token is missing, expired or revoked (HTTP 401/403). */
  | "auth"
  /** A request was sent but no answer came back in time. */
  | "timeout"
  /** The device answered, but not as an MCP server (wrong path, nginx up but wlanpi-mcp down). */
  | "protocol"
  /** The Pi's MCP server returned a JSON-RPC error. */
  | "remote";

/** A failure talking to one device, with a message ready to show to Claude. */
export class DeviceError extends Error {
  override name = "DeviceError";
  constructor(
    readonly kind: DeviceErrorKind,
    readonly device: string,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}
