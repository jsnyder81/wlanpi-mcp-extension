import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { NAME, VERSION } from "../../src/version.js";

const read = (path: string) => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));

describe("version", () => {
  it("matches package.json and manifest.json", () => {
    const pkg = read("../../package.json");
    const manifest = read("../../manifest.json");
    expect(NAME).toBe(pkg.name);
    expect(VERSION).toBe(pkg.version);
    expect(manifest.name).toBe(pkg.name);
    expect(manifest.version).toBe(pkg.version);
  });
});
