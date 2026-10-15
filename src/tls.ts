import { timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import * as tls from "node:tls";
import { Agent, type buildConnector, errors as undiciErrors, fetch as undiciFetch } from "undici";
import { CertMismatchError, ValidationError } from "./errors.js";

/**
 * TLS trust for WLAN Pi connections.
 *
 * Default is trust on first use: {@link fetchPeerCert} reads the Pi's self-signed leaf
 * certificate once, its SHA-256 fingerprint is stored, and every later connection is
 * accepted only if it presents that exact certificate ({@link createDispatcher} with a
 * pin). CA chain and hostname checks are skipped in pinned mode because Pi certs are
 * self-signed and usually reached by IP. With a CA file, normal verification applies.
 *
 * Verification is per connection, through an undici dispatcher. Nothing here touches
 * NODE_TLS_REJECT_UNAUTHORIZED or any global agent.
 */

export const DEFAULT_CONNECT_TIMEOUT_MS = 5_000;

export type Trust = { kind: "pin"; fingerprint: string } | { kind: "ca"; ca: string | Buffer };

export interface PeerCert {
  /** SHA-256 of the leaf certificate, uppercase colon-separated (openssl's format). */
  fingerprint256: string;
  subject: string;
  issuer: string;
  subjectAltName?: string;
  /** ISO 8601. */
  validFrom: string;
  validTo: string;
  selfSigned: boolean;
}

/**
 * Canonical fingerprint form: uppercase hex pairs joined by colons. Accepts what a user
 * is likely to paste, including openssl's `sha256 Fingerprint=AB:CD:...` output, plain
 * hex, and space- or colon-separated pairs in either case.
 */
export function normalizeFingerprint(input: string): string {
  const hex = input
    .trim()
    .replace(/^sha-?256\s*fingerprint\s*=\s*/i, "")
    .replace(/[\s:]/g, "")
    .toUpperCase();
  if (!/^[0-9A-F]{64}$/.test(hex)) {
    throw new ValidationError(
      `'${input}' is not a SHA-256 fingerprint. Expected 32 hex byte pairs, e.g. AB:CD:..., as printed by ` +
        "openssl x509 -noout -fingerprint -sha256.",
    );
  }
  return hex.match(/../g)!.join(":");
}

export function fingerprintsEqual(a: string, b: string): boolean {
  const left = Buffer.from(normalizeFingerprint(a));
  const right = Buffer.from(normalizeFingerprint(b));
  return left.length === right.length && timingSafeEqual(left, right);
}

function bareHost(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}

/** SNI is only valid for DNS names; Node warns when it is set to an IP address. */
function serverName(host: string): string | undefined {
  return isIP(host) === 0 ? host : undefined;
}

function formatName(name: tls.Certificate | undefined): string {
  if (!name) return "";
  return Object.entries(name)
    .map(([key, value]) => `${key}=${Array.isArray(value) ? value.join("+") : value}`)
    .join(", ");
}

function toIso(date: string): string {
  const parsed = new Date(date);
  return Number.isNaN(parsed.getTime()) ? date : parsed.toISOString();
}

function describeCert(cert: tls.PeerCertificate): PeerCert {
  const subject = formatName(cert.subject);
  const issuer = formatName(cert.issuer);
  return {
    fingerprint256: normalizeFingerprint(cert.fingerprint256),
    subject,
    issuer,
    ...(cert.subjectaltname ? { subjectAltName: cert.subjectaltname } : {}),
    validFrom: toIso(cert.valid_from),
    validTo: toIso(cert.valid_to),
    selfSigned: subject === issuer,
  };
}

function connectTimeoutError(host: string, port: number, timeoutMs: number): Error {
  return new undiciErrors.ConnectTimeoutError(`Connect timeout: no TLS handshake with ${host}:${port} after ${timeoutMs} ms`);
}

/**
 * Open a TLS connection, read the leaf certificate, and close without sending anything.
 * Used on first contact (add_wlanpi) and when re-pinning (trust_wlanpi_cert).
 */
export function fetchPeerCert(host: string, port: number, timeoutMs = DEFAULT_CONNECT_TIMEOUT_MS): Promise<PeerCert> {
  const target = bareHost(host);
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ host: target, port, servername: serverName(target), rejectUnauthorized: false });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(connectTimeoutError(target, port, timeoutMs));
    }, timeoutMs);
    socket.once("secureConnect", () => {
      clearTimeout(timer);
      const cert = socket.getPeerCertificate();
      socket.destroy();
      if (!cert?.fingerprint256) reject(new Error(`${target}:${port} did not present a certificate.`));
      else resolve(describeCert(cert));
    });
    socket.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/**
 * An undici connector that only hands a socket to undici once the peer's leaf
 * certificate matches the pin. The check runs on `secureConnect`, so on a mismatch the
 * socket is destroyed before a single request byte (and so the token) is written.
 */
export function pinnedConnector(pin: string, options: { device?: string; timeoutMs?: number } = {}): buildConnector.connector {
  const expected = normalizeFingerprint(pin);
  const timeoutMs = options.timeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;

  return (opts, callback) => {
    if (opts.protocol !== "https:") {
      callback(new Error(`Refusing ${opts.protocol} connection to ${opts.hostname}: only HTTPS is allowed.`), null);
      return;
    }
    const host = bareHost(opts.hostname);
    const port = Number(opts.port) || 443;
    const socket = tls.connect({ host, port, servername: serverName(host), rejectUnauthorized: false });

    let settled = false;
    const settle = (err: Error | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.off("error", onError);
      if (err) {
        socket.destroy();
        callback(err, null);
      } else {
        callback(null, socket);
      }
    };
    const onError = (err: Error) => settle(err);
    const timer = setTimeout(() => settle(connectTimeoutError(host, port, timeoutMs)), timeoutMs);

    socket.once("error", onError);
    socket.once("secureConnect", () => {
      const presented = socket.getPeerCertificate()?.fingerprint256;
      if (!presented) settle(new Error(`${host}:${port} did not present a certificate.`));
      else if (!fingerprintsEqual(presented, expected)) settle(new CertMismatchError(expected, normalizeFingerprint(presented), options.device));
      else settle(null);
    });
  };
}

/**
 * The dispatcher every request to one device goes through: pinned (default) or
 * validated against a CA. One dispatcher per device, so a pin only ever applies to the
 * device it belongs to.
 */
export function createDispatcher(trust: Trust, options: { device?: string; connectTimeoutMs?: number } = {}): Agent {
  const timeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  if (trust.kind === "pin") {
    return new Agent({ connect: pinnedConnector(trust.fingerprint, { device: options.device, timeoutMs }) });
  }
  return new Agent({ connect: { ca: trust.ca, rejectUnauthorized: true, timeout: timeoutMs } });
}

/** A fetch bound to one device's dispatcher, for the MCP client transport. */
export function createFetch(dispatcher: Agent): typeof undiciFetch {
  return (input, init) => undiciFetch(input, { ...init, dispatcher });
}
