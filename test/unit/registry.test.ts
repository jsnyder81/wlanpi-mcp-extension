import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DuplicateDeviceError, UnknownDeviceError, ValidationError } from "../../src/errors.js";
import { createLogger } from "../../src/log.js";
import { Registry, writeFileAtomic } from "../../src/registry.js";

const POSIX = process.platform !== "win32";
const FIXED = new Date("2026-10-15T12:00:00.000Z");

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), "wlanpi-registry-"));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const open = (subdir = "config") => Registry.open(join(dir, subdir), { now: () => FIXED });
const readJson = async (path: string) => JSON.parse(await fs.readFile(path, "utf8"));

describe("Registry", () => {
  it("starts empty when there is no file, without creating one", async () => {
    const registry = await open();
    expect(registry.list()).toEqual([]);
    await expect(fs.stat(registry.filePath)).rejects.toThrow();
  });

  it("adds a device with defaults and persists it", async () => {
    const registry = await open();
    const added = await registry.add({ name: "lab", host: "10.0.0.5", cert_sha256: "AB:CD", token: "t" });
    expect(added).toEqual({
      name: "lab",
      host: "10.0.0.5",
      port: 8767,
      path: "/mcp",
      cert_sha256: "AB:CD",
      ca_file: null,
      token: "t",
      added_at: FIXED.toISOString(),
      last_seen: null,
    });

    expect(await readJson(registry.filePath)).toEqual({ version: 1, devices: [added] });
    expect((await open()).list()).toEqual([added]);
  });

  it("keeps devices sorted by name and returns copies", async () => {
    const registry = await open();
    await registry.add({ name: "zeta", host: "z.local" });
    await registry.add({ name: "alpha", host: "a.local" });
    expect(registry.names()).toEqual(["alpha", "zeta"]);

    registry.list()[0]!.host = "mutated";
    registry.get("alpha")!.host = "mutated";
    expect(registry.get("alpha")!.host).toBe("a.local");
  });

  it("rejects duplicate and invalid names", async () => {
    const registry = await open();
    await registry.add({ name: "lab", host: "10.0.0.5" });
    await expect(registry.add({ name: "lab", host: "10.0.0.6" })).rejects.toThrow(DuplicateDeviceError);
    await expect(registry.add({ name: "Lab!", host: "10.0.0.6" })).rejects.toThrow(ValidationError);
    expect(registry.names()).toEqual(["lab"]);
  });

  it("updates fields, records last_seen, and validates the result", async () => {
    const registry = await open();
    await registry.add({ name: "lab", host: "10.0.0.5" });
    await registry.update("lab", { cert_sha256: "12:34", token: "new" });
    await registry.touch("lab");
    expect(registry.get("lab")).toMatchObject({ cert_sha256: "12:34", token: "new", last_seen: FIXED.toISOString() });

    await expect(registry.update("lab", { port: 70000 })).rejects.toThrow();
    expect(registry.get("lab")!.port).toBe(8767);
    expect((await readJson(registry.filePath)).devices[0].port).toBe(8767);
  });

  it("names the registered devices when one is unknown", async () => {
    const registry = await open();
    await registry.add({ name: "lab", host: "10.0.0.5" });
    await registry.add({ name: "field", host: "10.0.0.6" });
    await expect(registry.update("lad", { token: "x" })).rejects.toThrow("Unknown device 'lad'. Registered devices: field, lab.");
    expect(() => registry.require("lad")).toThrow(UnknownDeviceError);
    expect(registry.require("lab").host).toBe("10.0.0.5");
  });

  it("renames a device and moves its cache", async () => {
    const registry = await open();
    await registry.add({ name: "lab", host: "10.0.0.5" });
    await registry.add({ name: "field", host: "10.0.0.6" });
    await registry.writeCache("lab", { tools: ["a"] });

    await registry.rename("lab", "bench");
    expect(registry.names()).toEqual(["bench", "field"]);
    expect(await registry.readCache("bench")).toEqual({ tools: ["a"] });
    expect(await registry.readCache("lab")).toBeUndefined();

    await expect(registry.rename("bench", "field")).rejects.toThrow(DuplicateDeviceError);
    await expect(registry.rename("bench", "Bad Name")).rejects.toThrow(ValidationError);
    await expect(registry.rename("nope", "other")).rejects.toThrow(UnknownDeviceError);
  });

  it("removes a device and its cache", async () => {
    const registry = await open();
    await registry.add({ name: "lab", host: "10.0.0.5" });
    await registry.writeCache("lab", { tools: [] });

    expect(await registry.remove("lab")).toBe(true);
    expect(await registry.remove("lab")).toBe(false);
    expect(registry.list()).toEqual([]);
    await expect(fs.stat(registry.cachePath("lab"))).rejects.toThrow();
  });

  it("serializes concurrent mutations without losing any", async () => {
    const registry = await open();
    await Promise.all(Array.from({ length: 25 }, (_, i) => registry.add({ name: `pi-${i}`, host: `10.0.0.${i + 1}` })));
    expect(registry.list()).toHaveLength(25);
    expect((await readJson(registry.filePath)).devices).toHaveLength(25);
  });

  it("keeps working after a failed mutation", async () => {
    const registry = await open();
    await registry.add({ name: "lab", host: "10.0.0.5" });
    await expect(registry.add({ name: "lab", host: "10.0.0.5" })).rejects.toThrow();
    await registry.add({ name: "field", host: "10.0.0.6" });
    expect(registry.names()).toEqual(["field", "lab"]);
  });

  it("picks up changes another process made before mutating", async () => {
    const a = await open();
    const b = await open();
    await a.add({ name: "lab", host: "10.0.0.5" });
    await b.add({ name: "field", host: "10.0.0.6" });
    expect(b.names()).toEqual(["field", "lab"]);
    await a.reload();
    expect(a.names()).toEqual(["field", "lab"]);
  });

  it("moves a corrupt devices.json aside instead of dropping it", async () => {
    const configDir = join(dir, "config");
    await fs.mkdir(configDir, { recursive: true });
    await fs.writeFile(join(configDir, "devices.json"), "{ not json");
    const lines: string[] = [];

    const registry = await Registry.open(configDir, { now: () => FIXED, logger: createLogger("error", (l) => lines.push(l)) });

    expect(registry.list()).toEqual([]);
    const files = await fs.readdir(configDir);
    const aside = files.find((f) => f.startsWith("devices.json.bad-"));
    expect(aside).toBeDefined();
    expect(await fs.readFile(join(configDir, aside!), "utf8")).toBe("{ not json");
    expect(lines.join("")).toMatch(/moved to/);
  });

  it("treats a file with the wrong shape as corrupt", async () => {
    const configDir = join(dir, "config");
    await fs.mkdir(configDir, { recursive: true });
    await fs.writeFile(join(configDir, "devices.json"), JSON.stringify({ version: 1, devices: [{ name: "BAD" }] }));
    expect((await Registry.open(configDir)).list()).toEqual([]);
    expect((await fs.readdir(configDir)).some((f) => f.startsWith("devices.json.bad-"))).toBe(true);
  });

  it("ignores a stale temp file left by a crash", async () => {
    const registry = await open();
    await registry.add({ name: "lab", host: "10.0.0.5" });
    await fs.writeFile(`${registry.filePath}.999.deadbeef.tmp`, "{ half written");
    expect((await open()).names()).toEqual(["lab"]);
  });

  it.runIf(POSIX)("creates the directory 0700 and files 0600", async () => {
    const registry = await open();
    await registry.add({ name: "lab", host: "10.0.0.5", token: "secret" });
    await registry.writeCache("lab", {});
    expect((await fs.stat(registry.dir)).mode & 0o777).toBe(0o700);
    expect((await fs.stat(registry.filePath)).mode & 0o777).toBe(0o600);
    expect((await fs.stat(registry.cachePath("lab"))).mode & 0o777).toBe(0o600);
  });

  it.runIf(POSIX)("restores 0600 on a file whose mode was loosened", async () => {
    const registry = await open();
    await registry.add({ name: "lab", host: "10.0.0.5" });
    await fs.chmod(registry.filePath, 0o644);
    await registry.touch("lab");
    expect((await fs.stat(registry.filePath)).mode & 0o777).toBe(0o600);
  });
});

describe("cache", () => {
  it("round-trips JSON and returns undefined when missing or corrupt", async () => {
    const registry = await open();
    expect(await registry.readCache("lab")).toBeUndefined();
    await registry.writeCache("lab", { serverInfo: { version: "0.6.17" } });
    expect(await registry.readCache("lab")).toEqual({ serverInfo: { version: "0.6.17" } });

    await fs.writeFile(registry.cachePath("lab"), "{ nope");
    expect(await registry.readCache("lab")).toBeUndefined();
  });

  it("refuses names that could escape the cache directory", async () => {
    const registry = await open();
    expect(() => registry.cachePath("../devices")).toThrow(ValidationError);
  });
});

describe("writeFileAtomic", () => {
  it("leaves the old content and no temp file when interrupted before the rename", async () => {
    const target = join(dir, "file.json");
    await writeFileAtomic(target, "old");

    await expect(
      writeFileAtomic(target, "new", {
        beforeRename: () => {
          throw new Error("simulated crash");
        },
      }),
    ).rejects.toThrow("simulated crash");

    expect(await fs.readFile(target, "utf8")).toBe("old");
    expect(await fs.readdir(dir)).toEqual(["file.json"]);
  });

  it("replaces the content when it completes", async () => {
    const target = join(dir, "file.json");
    await writeFileAtomic(target, "old");
    await writeFileAtomic(target, "new");
    expect(await fs.readFile(target, "utf8")).toBe("new");
    expect(await fs.readdir(dir)).toEqual(["file.json"]);
  });
});
