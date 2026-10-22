import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { DEFAULT_PATH, DEFAULT_PORT } from "./config.js";
import { DuplicateDeviceError, UnknownDeviceError, ValidationError } from "./errors.js";
import { type Logger, silentLogger } from "./log.js";
import { isValidName } from "./validate.js";

// Loose objects: fields this version does not know (written by a newer copy of the
// extension sharing the file) are kept on every write instead of being dropped.
const DeviceRecordSchema = z.looseObject({
  name: z.string().refine(isValidName, "invalid device name"),
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535),
  path: z.string().startsWith("/"),
  /** SHA-256 of the pinned leaf cert, uppercase colon-separated. Null in CA mode or before first contact. */
  cert_sha256: z.string().nullable(),
  /** Per-device CA file; when set the device is validated against it instead of pinned. */
  ca_file: z.string().nullable().default(null),
  /** A token given with add_wlanpi or set_wlanpi_token. Tokens from settings are never stored. */
  token: z.string().nullable(),
  /** The unnamed token from settings may be sent to this device (it was the first Pi added). */
  default_token: z.boolean().default(false),
  added_at: z.string(),
  last_seen: z.string().nullable(),
});

export const REGISTRY_VERSION = 1;

const RegistryFileSchema = z.looseObject({
  version: z.literal(REGISTRY_VERSION),
  devices: z.array(DeviceRecordSchema),
});

export type DeviceRecord = z.infer<typeof DeviceRecordSchema>;

export type NewDevice = Pick<DeviceRecord, "name" | "host"> &
  Partial<Pick<DeviceRecord, "port" | "path" | "cert_sha256" | "ca_file" | "token" | "default_token">>;

export type DevicePatch = Partial<Omit<DeviceRecord, "name" | "added_at">>;

export const DEVICES_FILE = "devices.json";
export const CACHE_DIR = "cache";

const IS_POSIX = process.platform !== "win32";

export interface AtomicWriteOptions {
  /** Test hook, called after the temp file is fully written and before the rename. */
  beforeRename?: (tempPath: string) => Promise<void> | void;
}

/**
 * Write a file so that readers only ever see the old or the new content: write a
 * uniquely named temp file in the same directory (mode 0600), fsync it, then rename it
 * over the target. If anything fails the temp file is removed and the target is left
 * untouched.
 */
export async function writeFileAtomic(path: string, data: string, options: AtomicWriteOptions = {}): Promise<void> {
  const temp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(temp, "wx", 0o600);
    await handle.writeFile(data, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await options.beforeRename?.(temp);
    await renameWithRetry(temp, path);
    if (IS_POSIX) await fs.chmod(path, 0o600);
  } catch (err) {
    await handle?.close().catch(() => {});
    await fs.rm(temp, { force: true }).catch(() => {});
    throw err;
  }
}

/** On Windows a rename over a file another process (often antivirus) has open fails briefly with EPERM/EBUSY. */
async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fs.rename(from, to);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (process.platform !== "win32" || attempt >= 5 || (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES")) throw err;
      await new Promise((resolve) => setTimeout(resolve, 20 * 2 ** attempt));
    }
  }
}

async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
}

export interface RegistryOptions {
  logger?: Logger;
  now?: () => Date;
}

/**
 * The device registry, persisted to `<configDir>/devices.json`.
 *
 * Every mutation re-reads the file, applies the change and writes it back atomically,
 * one at a time through a promise queue. Re-reading matters because Claude Desktop and
 * Claude Code can each run their own copy of the extension against the same file; it
 * keeps one process from silently undoing the other's change.
 *
 * Per-device catalogs (tools, resources, prompts) are cached in `<configDir>/cache/<name>.json`
 * so a Pi that is offline at startup still has its tools advertised.
 */
export class Registry {
  private devices: DeviceRecord[] = [];
  private queue: Promise<unknown> = Promise.resolve();
  /** Set while devices.json is in a newer format: nothing may be written. */
  readOnlyReason?: string;
  private readonly logger: Logger;
  private readonly now: () => Date;

  private constructor(
    readonly dir: string,
    options: RegistryOptions,
  ) {
    this.logger = options.logger ?? silentLogger;
    this.now = options.now ?? (() => new Date());
  }

  static async open(dir: string, options: RegistryOptions = {}): Promise<Registry> {
    const registry = new Registry(dir, options);
    await registry.reload();
    return registry;
  }

  get filePath(): string {
    return join(this.dir, DEVICES_FILE);
  }

  /** All devices, sorted by name. Returned records are copies. */
  list(): DeviceRecord[] {
    return this.devices.map((d) => ({ ...d }));
  }

  names(): string[] {
    return this.devices.map((d) => d.name);
  }

  get(name: string): DeviceRecord | undefined {
    const device = this.devices.find((d) => d.name === name);
    return device && { ...device };
  }

  /** Like {@link get}, but throws an UnknownDeviceError listing the registered names. */
  require(name: string): DeviceRecord {
    const device = this.get(name);
    if (!device) throw new UnknownDeviceError(name, this.names());
    return device;
  }

  /** Re-read devices.json from disk (it may have been changed by another process). */
  async reload(): Promise<void> {
    await this.enqueue(async () => {
      this.devices = await this.readFile();
    });
  }

  async add(input: NewDevice): Promise<DeviceRecord> {
    if (!isValidName(input.name)) throw new ValidationError(`Invalid device name '${input.name}'.`);
    return this.mutate((devices) => {
      if (devices.some((d) => d.name === input.name)) throw new DuplicateDeviceError(input.name);
      const record: DeviceRecord = {
        name: input.name,
        host: input.host,
        port: input.port ?? DEFAULT_PORT,
        path: input.path ?? DEFAULT_PATH,
        cert_sha256: input.cert_sha256 ?? null,
        ca_file: input.ca_file ?? null,
        token: input.token ?? null,
        default_token: input.default_token ?? false,
        added_at: this.now().toISOString(),
        last_seen: null,
      };
      devices.push(record);
      return record;
    });
  }

  async update(name: string, patch: DevicePatch): Promise<DeviceRecord> {
    return this.mutate((devices) => {
      const device = findOrThrow(devices, name);
      Object.assign(device, patch);
      DeviceRecordSchema.parse(device);
      return device;
    });
  }

  /** Record a successful contact with the device. */
  async touch(name: string): Promise<DeviceRecord> {
    return this.update(name, { last_seen: this.now().toISOString() });
  }

  async rename(name: string, newName: string): Promise<DeviceRecord> {
    if (!isValidName(newName)) throw new ValidationError(`Invalid device name '${newName}'.`);
    const device = await this.mutate((devices) => {
      const device = findOrThrow(devices, name);
      if (name === newName) return device;
      if (devices.some((d) => d.name === newName)) throw new DuplicateDeviceError(newName);
      device.name = newName;
      return device;
    });
    // Only once devices.json has the new name, so a failed write never orphans the cache.
    if (name !== newName) {
      await fs.rename(this.cachePath(name), this.cachePath(newName)).catch((err: NodeJS.ErrnoException) => {
        if (err.code !== "ENOENT") this.logger.warn(`Could not move cache for '${name}' to '${newName}'`, err);
      });
    }
    return device;
  }

  /** Remove a device and its cache. Returns false if it was not registered. */
  async remove(name: string): Promise<boolean> {
    const removed = await this.mutate((devices) => {
      const index = devices.findIndex((d) => d.name === name);
      if (index === -1) return false;
      devices.splice(index, 1);
      return true;
    });
    if (removed) await fs.rm(this.cachePath(name), { force: true });
    return removed;
  }

  cachePath(name: string): string {
    if (!isValidName(name)) throw new ValidationError(`Invalid device name '${name}'.`);
    return join(this.dir, CACHE_DIR, `${name}.json`);
  }

  async writeCache(name: string, data: unknown): Promise<void> {
    const path = this.cachePath(name);
    await ensureDir(dirname(path));
    await writeFileAtomic(path, `${JSON.stringify(data, null, 2)}\n`);
  }

  /** The cached catalog for a device, or undefined if there is none or it is unreadable. */
  async readCache(name: string): Promise<unknown> {
    const path = this.cachePath(name);
    let text: string;
    try {
      text = await fs.readFile(path, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") this.logger.warn(`Could not read cache for '${name}'`, err);
      return undefined;
    }
    try {
      return JSON.parse(text);
    } catch {
      this.logger.warn(`Ignoring corrupt cache file ${path}; it will be rewritten on the next successful contact.`);
      return undefined;
    }
  }

  /** Run `change` against the latest on-disk state, then persist and publish the result. */
  private async mutate<T>(change: (devices: DeviceRecord[]) => T | Promise<T>): Promise<T> {
    return this.enqueue(async () => {
      const devices = await this.readFile();
      if (this.readOnlyReason) throw new ValidationError(this.readOnlyReason);
      const result = await change(devices);
      devices.sort((a, b) => a.name.localeCompare(b.name));
      await this.writeFile(devices);
      this.devices = devices;
      return typeof result === "object" && result !== null ? { ...result } : result;
    });
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.catch(() => {});
    return run;
  }

  private async readFile(): Promise<DeviceRecord[]> {
    let text: string;
    try {
      text = await fs.readFile(this.filePath, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch (err) {
      return this.moveAside(err);
    }
    // A newer copy of the extension (Claude Desktop and Claude Code update separately)
    // wrote a format this one cannot read. Leave the file alone, and refuse to write it.
    const version = (json as { version?: unknown } | null)?.version;
    if (typeof version === "number" && version > REGISTRY_VERSION) {
      if (!this.readOnlyReason) {
        this.readOnlyReason = `devices.json was written by a newer version of the WLAN Pi extension (format ${version}). Update this copy of the extension to use and change your WLAN Pis.`;
        this.logger.error(this.readOnlyReason);
      }
      return [];
    }
    this.readOnlyReason = undefined;
    const parsed = RegistryFileSchema.safeParse(json);
    if (!parsed.success) return this.moveAside(parsed.error);
    return parsed.data.devices.sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Never silently drop a user's devices: keep an unreadable file for inspection. */
  private async moveAside(err: unknown): Promise<DeviceRecord[]> {
    const aside = `${this.filePath}.bad-${this.now().toISOString().replace(/[:.]/g, "-")}`;
    try {
      await fs.rename(this.filePath, aside);
    } catch (renameErr) {
      // Another copy of the extension moved it first.
      if ((renameErr as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw renameErr;
    }
    this.logger.error(`devices.json was unreadable and has been moved to ${aside}; starting with no devices.`, err instanceof Error ? err.message : err);
    return [];
  }

  private async writeFile(devices: DeviceRecord[]): Promise<void> {
    await ensureDir(this.dir);
    await writeFileAtomic(this.filePath, `${JSON.stringify({ version: 1, devices }, null, 2)}\n`);
  }
}

function findOrThrow(devices: DeviceRecord[], name: string): DeviceRecord {
  const device = devices.find((d) => d.name === name);
  if (!device) throw new UnknownDeviceError(name, devices.map((d) => d.name));
  return device;
}
