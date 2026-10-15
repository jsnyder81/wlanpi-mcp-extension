import { type IncomingHttpHeaders, type RequestListener } from "node:http";
import { createServer, type Server } from "node:https";
import type { AddressInfo, Socket } from "node:net";
import type { TestCert } from "./certs.js";

export interface TestHttpsServer {
  server: Server;
  port: number;
  /** Headers of every request the server received, in order. */
  requests: IncomingHttpHeaders[];
  /** Serve a different certificate to new connections. */
  setCert(cert: TestCert): void;
  close(): Promise<void>;
}

/**
 * A minimal HTTPS server on 127.0.0.1 with a random port. It records every request it
 * receives, so tests can prove that a refused connection never got as far as HTTP.
 */
export async function startHttpsServer(cert: TestCert, handler?: RequestListener): Promise<TestHttpsServer> {
  const requests: IncomingHttpHeaders[] = [];
  const sockets = new Set<Socket>();
  const server = createServer({ key: cert.key, cert: cert.cert }, (req, res) => {
    requests.push(req.headers);
    if (handler) return handler(req, res);
    res.writeHead(200, { "content-type": "text/plain" }).end("ok");
  });
  server.on("connection", (socket: Socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  // Handshake failures (a client dropping the connection) are expected in these tests.
  server.on("tlsClientError", () => {});

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    server,
    port: (server.address() as AddressInfo).port,
    requests,
    setCert: (next) => server.setSecureContext({ key: next.key, cert: next.cert }),
    close: () =>
      new Promise((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}
