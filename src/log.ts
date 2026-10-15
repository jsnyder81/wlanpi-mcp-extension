/**
 * Leveled logger that writes to stderr only: stdout is the MCP stdio channel, and a
 * stray write there corrupts the protocol. Every line is passed through {@link redact}
 * so a token can never reach a log, even by accident.
 */

export const LOG_LEVELS = ["error", "warn", "info", "debug"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export interface Logger {
  error(message: string, detail?: unknown): void;
  warn(message: string, detail?: unknown): void;
  info(message: string, detail?: unknown): void;
  debug(message: string, detail?: unknown): void;
}

const REDACTED = "[REDACTED]";

const PATTERNS: Array<[RegExp, string]> = [
  // Authorization: Bearer <token>
  [/(bearer\s+)[^\s"',;]+/gi, `$1${REDACTED}`],
  // Any JWT-shaped value (base64url header.payload.signature, header starts with eyJ).
  [/eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g, REDACTED],
  // "token": "...", token=..., default_token: ...
  [/("?\b[a-z_]*token"?\s*[:=]\s*"?)(?!null\b)[^\s"',}]+/gi, `$1${REDACTED}`],
];

export function redact(text: string): string {
  return PATTERNS.reduce((out, [pattern, replacement]) => out.replace(pattern, replacement), text);
}

export function parseLogLevel(value: string | undefined): LogLevel | undefined {
  const level = value?.trim().toLowerCase();
  return (LOG_LEVELS as readonly string[]).includes(level ?? "") ? (level as LogLevel) : undefined;
}

function formatDetail(detail: unknown): string {
  if (detail === undefined) return "";
  if (detail instanceof Error) return ` ${detail.stack ?? detail.message}`;
  if (typeof detail === "string") return ` ${detail}`;
  try {
    return ` ${JSON.stringify(detail)}`;
  } catch {
    return ` ${String(detail)}`;
  }
}

export function createLogger(
  level: LogLevel = "info",
  write: (line: string) => void = (line) => process.stderr.write(line),
): Logger {
  const threshold = LOG_LEVELS.indexOf(level);
  const emit = (at: LogLevel) => (message: string, detail?: unknown) => {
    if (LOG_LEVELS.indexOf(at) > threshold) return;
    const line = `${new Date().toISOString()} ${at.toUpperCase()} [wlanpi-mcp-extension] ${message}${formatDetail(detail)}`;
    write(`${redact(line)}\n`);
  };
  return { error: emit("error"), warn: emit("warn"), info: emit("info"), debug: emit("debug") };
}

export const silentLogger: Logger = { error() {}, warn() {}, info() {}, debug() {} };
