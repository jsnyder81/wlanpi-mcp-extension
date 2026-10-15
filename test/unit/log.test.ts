import { describe, expect, it } from "vitest";
import { createLogger, parseLogLevel, redact } from "../../src/log.js";

const JWT =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJjbGF1ZGUifQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";

describe("redact", () => {
  it.each([
    [`Authorization: Bearer abc.def-ghi`, "abc.def-ghi"],
    [`authorization: bearer s3cr3t`, "s3cr3t"],
    [`payload ${JWT} end`, JWT],
    [`{"token":"opaque-123"}`, "opaque-123"],
    [`{"token": "opaque-123", "name":"lab"}`, "opaque-123"],
    [`default_token=opaque-456`, "opaque-456"],
    [`WLANPI_BRIDGE_DEFAULT_TOKEN: opaque-789`, "opaque-789"],
  ])("removes the secret from %j", (text, secret) => {
    const out = redact(text);
    expect(out).not.toContain(secret);
    expect(out).toContain("[REDACTED]");
  });

  it("leaves ordinary text and null tokens alone", () => {
    expect(redact(`device 'lab' (10.0.0.5) is unreachable`)).toBe(`device 'lab' (10.0.0.5) is unreachable`);
    expect(redact(`{"token":null}`)).toBe(`{"token":null}`);
  });
});

describe("createLogger", () => {
  it("filters by level and redacts every line", () => {
    const lines: string[] = [];
    const log = createLogger("warn", (line) => lines.push(line));
    log.debug("debug line");
    log.info("info line");
    log.warn("connecting", { headers: { Authorization: "Bearer topsecret" } });
    log.error("failed", new Error(`bad token ${JWT}`));

    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/WARN \[wlanpi-mcp-extension\] connecting/);
    expect(lines.join("")).not.toContain("topsecret");
    expect(lines.join("")).not.toContain(JWT);
    expect(lines.every((l) => l.endsWith("\n"))).toBe(true);
  });

  it("writes to stderr by default, never stdout", () => {
    const stdout = process.stdout.write;
    const stderr = process.stderr.write;
    const seen: string[] = [];
    process.stdout.write = (() => {
      throw new Error("wrote to stdout");
    }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: string) => {
      seen.push(chunk);
      return true;
    }) as typeof process.stderr.write;
    try {
      createLogger("info").info("hello");
    } finally {
      process.stdout.write = stdout;
      process.stderr.write = stderr;
    }
    expect(seen.join("")).toContain("hello");
  });

  it("parses levels case-insensitively", () => {
    expect(parseLogLevel("DEBUG")).toBe("debug");
    expect(parseLogLevel("verbose")).toBeUndefined();
    expect(parseLogLevel(undefined)).toBeUndefined();
  });
});
