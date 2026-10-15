import { createServer as createTcpServer, type AddressInfo, type Server as TcpServer, type Socket } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { CertMismatchError, ValidationError } from "../../src/errors.js";
import { createDispatcher, createFetch, fetchPeerCert, fingerprintsEqual, normalizeFingerprint } from "../../src/tls.js";
import { caSignedCert, selfSignedCert, type TestCert } from "../helpers/certs.js";
import { startHttpsServer, type TestHttpsServer } from "../helpers/httpsServer.js";

let piCert: TestCert;
let otherCert: TestCert;
let ca: { ca: TestCert; leaf: TestCert };
let otherCa: { ca: TestCert; leaf: TestCert };
let server: TestHttpsServer | undefined;

beforeAll(async () => {
  [piCert, otherCert, ca, otherCa] = await Promise.all([selfSignedCert("wlanpi"), selfSignedCert("imposter"), caSignedCert(), caSignedCert()]);
});

afterEach(async () => {
  await server?.close();
  server = undefined;
});

const url = (port: number, host = "127.0.0.1") => `https://${host}:${port}/mcp`;

describe("normalizeFingerprint", () => {
  const colon = "AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89";

  it.each([
    colon,
    colon.toLowerCase(),
    colon.replaceAll(":", ""),
    colon.replaceAll(":", " "),
    `sha256 Fingerprint=${colon}`,
    `SHA256 Fingerprint=${colon}\n`,
  ])("normalizes %j", (input) => {
    expect(normalizeFingerprint(input)).toBe(colon);
  });

  it.each(["", "AB:CD", colon.slice(0, -1) + "G", `${colon}:00`, "sha1 Fingerprint=AB:CD"])("rejects %j", (input) => {
    expect(() => normalizeFingerprint(input)).toThrow(ValidationError);
  });

  it("compares fingerprints regardless of format", () => {
    expect(fingerprintsEqual(colon, colon.toLowerCase().replaceAll(":", ""))).toBe(true);
    expect(fingerprintsEqual(colon, colon.replace(/^AB/, "AA"))).toBe(false);
  });
});

describe("fetchPeerCert", () => {
  it("returns the leaf fingerprint, names and validity without sending a request", async () => {
    server = await startHttpsServer(piCert);
    const cert = await fetchPeerCert("127.0.0.1", server.port);

    expect(cert.fingerprint256).toBe(piCert.fingerprint256);
    expect(cert.subject).toBe("CN=wlanpi");
    expect(cert.selfSigned).toBe(true);
    expect(cert.subjectAltName).toContain("IP Address:127.0.0.1");
    expect(Date.parse(cert.validFrom)).toBeLessThanOrEqual(Date.now());
    expect(Date.parse(cert.validTo)).toBeGreaterThan(Date.now());
    expect(cert.validFrom).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(server.requests).toHaveLength(0);
  });

  it("works by hostname", async () => {
    server = await startHttpsServer(piCert);
    expect((await fetchPeerCert("localhost", server.port)).fingerprint256).toBe(piCert.fingerprint256);
  });

  it("reports a CA-signed leaf as not self-signed", async () => {
    server = await startHttpsServer(ca.leaf);
    const cert = await fetchPeerCert("127.0.0.1", server.port);
    expect(cert.selfSigned).toBe(false);
    expect(cert.issuer).toBe("CN=Test WLAN Pi CA");
  });

  it("fails on a refused connection", async () => {
    const port = await unusedPort();
    await expect(fetchPeerCert("127.0.0.1", port)).rejects.toMatchObject({ code: "ECONNREFUSED" });
  });

  describe("against a server that never completes the handshake", () => {
    let silent: { port: number; close: () => Promise<void> };
    beforeAll(async () => (silent = await startSilentServer()));
    afterAll(() => silent.close());

    it("times out", async () => {
      await expect(fetchPeerCert("127.0.0.1", silent.port, 200)).rejects.toMatchObject({ code: "UND_ERR_CONNECT_TIMEOUT" });
    });

    it("times out in the pinned dispatcher too", async () => {
      const fetch = createFetch(createDispatcher({ kind: "pin", fingerprint: piCert.fingerprint256 }, { connectTimeoutMs: 200 }));
      await expect(fetch(url(silent.port))).rejects.toMatchObject({ cause: { code: "UND_ERR_CONNECT_TIMEOUT" } });
    });
  });
});

describe("pinned dispatcher", () => {
  it("accepts the pinned certificate and sends the request", async () => {
    server = await startHttpsServer(piCert);
    const fetch = createFetch(createDispatcher({ kind: "pin", fingerprint: piCert.fingerprint256 }));

    const res = await fetch(url(server.port), { headers: { authorization: "Bearer secret" } });

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
    expect(server.requests).toHaveLength(1);
    expect(server.requests[0]?.authorization).toBe("Bearer secret");
  });

  it("skips chain and hostname checks, so only the pin matters", async () => {
    // Issued for another name by a CA the bridge does not know: both checks would fail normally.
    const elsewhere = await caSignedCert(["elsewhere.example"]);
    server = await startHttpsServer(elsewhere.leaf);
    const fetch = createFetch(createDispatcher({ kind: "pin", fingerprint: elsewhere.leaf.fingerprint256 }));
    expect((await fetch(url(server.port, "localhost"))).status).toBe(200);
    expect((await fetch(url(server.port))).status).toBe(200);
  });

  it("refuses a different certificate before sending anything, naming both fingerprints", async () => {
    server = await startHttpsServer(otherCert);
    const fetch = createFetch(createDispatcher({ kind: "pin", fingerprint: piCert.fingerprint256 }, { device: "lab" }));

    const error = await fetch(url(server.port), { headers: { authorization: "Bearer secret" } }).catch((err: Error) => err);

    expect(error).toBeInstanceOf(Error);
    const cause = (error as Error & { cause?: unknown }).cause;
    expect(cause).toBeInstanceOf(CertMismatchError);
    expect((cause as CertMismatchError).message).toBe(
      `Certificate for 'lab' changed. Pinned ${piCert.fingerprint256}, presented ${otherCert.fingerprint256}. ` +
        "If this is expected (for example the Pi was reimaged), verify the new fingerprint on the Pi and call trust_wlanpi_cert.",
    );
    expect(server.requests).toHaveLength(0);
  });

  it("refuses new connections after the server's certificate is swapped", async () => {
    server = await startHttpsServer(piCert);
    const dispatcher = createDispatcher({ kind: "pin", fingerprint: piCert.fingerprint256 });
    const fetch = createFetch(dispatcher);
    expect((await fetch(url(server.port))).status).toBe(200);

    server.setCert(otherCert);
    // Drop pooled keep-alive sockets so the next request needs a new handshake.
    await dispatcher.close();
    const fresh = createFetch(createDispatcher({ kind: "pin", fingerprint: piCert.fingerprint256 }));
    await expect(fresh(url(server.port))).rejects.toMatchObject({ cause: { name: "CertMismatchError" } });
    expect(server.requests).toHaveLength(1);

    // Re-pinning to the new certificate restores access.
    const repinned = createFetch(createDispatcher({ kind: "pin", fingerprint: otherCert.fingerprint256 }));
    expect((await repinned(url(server.port))).status).toBe(200);
  });

  it("never connects over plain HTTP", async () => {
    const fetch = createFetch(createDispatcher({ kind: "pin", fingerprint: piCert.fingerprint256 }));
    await expect(fetch("http://127.0.0.1:8767/mcp")).rejects.toMatchObject({ cause: { message: expect.stringMatching(/only HTTPS/) } });
  });
});

describe("CA dispatcher", () => {
  it("accepts a certificate signed by the CA", async () => {
    server = await startHttpsServer(ca.leaf);
    const fetch = createFetch(createDispatcher({ kind: "ca", ca: ca.ca.cert }));
    expect((await fetch(url(server.port, "localhost"))).status).toBe(200);
  });

  it("rejects a certificate signed by another CA, and a self-signed one", async () => {
    const fetch = createFetch(createDispatcher({ kind: "ca", ca: ca.ca.cert }));

    server = await startHttpsServer(otherCa.leaf);
    await expect(fetch(url(server.port, "localhost"))).rejects.toThrow();
    server.setCert(piCert);
    await expect(fetch(url(server.port, "localhost"))).rejects.toThrow();
    expect(server.requests).toHaveLength(0);
  });

  it("still checks the hostname", async () => {
    const elsewhere = await caSignedCert(["elsewhere.example"]);
    server = await startHttpsServer(elsewhere.leaf);
    const fetch = createFetch(createDispatcher({ kind: "ca", ca: elsewhere.ca.cert }));
    await expect(fetch(url(server.port, "localhost"))).rejects.toMatchObject({ cause: { code: "ERR_TLS_CERT_ALTNAME_INVALID" } });
    expect(server.requests).toHaveLength(0);
  });
});

describe("process-wide TLS settings", () => {
  it("are never changed: the default fetch still rejects the self-signed cert", async () => {
    const before = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    server = await startHttpsServer(piCert);
    await fetchPeerCert("127.0.0.1", server.port);
    await createFetch(createDispatcher({ kind: "pin", fingerprint: piCert.fingerprint256 }))(url(server.port));

    expect(process.env.NODE_TLS_REJECT_UNAUTHORIZED).toBe(before);
    await expect(globalThis.fetch(url(server.port))).rejects.toThrow();
  });
});

async function unusedPort(): Promise<number> {
  const probe = createTcpServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

/** Accepts TCP connections and never answers, so a TLS handshake never completes. */
async function startSilentServer(): Promise<{ port: number; close: () => Promise<void> }> {
  const sockets = new Set<Socket>();
  const tcp: TcpServer = createTcpServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
  });
  await new Promise<void>((resolve) => tcp.listen(0, "127.0.0.1", resolve));
  return {
    port: (tcp.address() as AddressInfo).port,
    close: () =>
      new Promise((resolve) => {
        for (const s of sockets) s.destroy();
        tcp.close(() => resolve());
      }),
  };
}
