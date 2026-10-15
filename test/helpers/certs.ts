import { X509Certificate } from "node:crypto";
import { generate } from "selfsigned";

export interface TestCert {
  key: string;
  cert: string;
  /** Uppercase colon-separated SHA-256, as the bridge stores it. */
  fingerprint256: string;
}

const LOCAL_SAN = {
  name: "subjectAltName" as const,
  altNames: [
    { type: 2 as const, value: "localhost" },
    { type: 7 as const, ip: "127.0.0.1" },
    { type: 7 as const, ip: "::1" },
  ],
};

function withFingerprint(key: string, cert: string): TestCert {
  return { key, cert, fingerprint256: new X509Certificate(cert).fingerprint256 };
}

/** A self-signed leaf like the one wlanpi-core generates for nginx. */
export async function selfSignedCert(commonName = "wlanpi"): Promise<TestCert> {
  const pems = await generate([{ name: "commonName", value: commonName }], {
    keyType: "ec",
    algorithm: "sha256",
    extensions: [LOCAL_SAN],
  });
  return withFingerprint(pems.private, pems.cert);
}

/** A CA and a leaf signed by it (for localhost unless `dnsNames` says otherwise), for CA-mode tests. */
export async function caSignedCert(dnsNames?: string[]): Promise<{ ca: TestCert; leaf: TestCert }> {
  const san = dnsNames ? { name: "subjectAltName" as const, altNames: dnsNames.map((value) => ({ type: 2 as const, value })) } : LOCAL_SAN;
  const caPems = await generate([{ name: "commonName", value: "Test WLAN Pi CA" }], {
    keyType: "ec",
    algorithm: "sha256",
    extensions: [
      { name: "basicConstraints", cA: true, critical: true },
      { name: "keyUsage", keyCertSign: true, cRLSign: true, digitalSignature: true, critical: true },
    ],
  });
  const leafPems = await generate([{ name: "commonName", value: dnsNames?.[0] ?? "localhost" }], {
    keyType: "ec",
    algorithm: "sha256",
    extensions: [
      { name: "basicConstraints", cA: false },
      { name: "keyUsage", digitalSignature: true, keyEncipherment: true },
      { name: "extKeyUsage", serverAuth: true },
      san,
    ],
    ca: { key: caPems.private, cert: caPems.cert },
  });
  return { ca: withFingerprint(caPems.private, caPems.cert), leaf: withFingerprint(leafPems.private, leafPems.cert) };
}
