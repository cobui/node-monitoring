import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

vi.mock("node:fs");

import { readFileSync } from "node:fs";
import { loadConfig } from "../config";

beforeEach(() => {
  vi.mocked(readFileSync).mockReset();
});

// ─── loadConfig — happy path ──────────────────────────────────────────────────

describe("loadConfig — valid YAML", () => {
  it("parses a top-level array and returns MonitorConfig objects", () => {
    vi.mocked(readFileSync).mockReturnValue(`
- namespace: app
  transporter:
    type: influx
    version: 2
    host: localhost
    org: myorg
    bucket: metrics
    token: secret
`);
    const result = loadConfig("monitoring.yml");
    expect(result).toHaveLength(1);
    expect(result[0].namespace).toBe("app");
  });

  it("returns multiple configs when the file contains multiple entries", () => {
    vi.mocked(readFileSync).mockReturnValue(`
- namespace: app
  transporter:
    type: influx
    version: 2
    host: h
    org: o
    bucket: b
    token: t
- namespace: infra
  transporter:
    type: influx
    version: 1
    host: h
    database: db
`);
    const result = loadConfig("monitoring.yml");
    expect(result).toHaveLength(2);
    expect(result[1].namespace).toBe("infra");
  });
});

// ─── loadConfig — env var interpolation ──────────────────────────────────────

describe("loadConfig — environment variable interpolation", () => {
  afterEach(() => {
    delete process.env.TEST_INFLUX_TOKEN;
  });

  it("replaces \${VAR} placeholders with the corresponding env variable", () => {
    process.env.TEST_INFLUX_TOKEN = "my-secret-token";
    vi.mocked(readFileSync).mockReturnValue(`
- namespace: app
  transporter:
    type: influx
    version: 2
    host: h
    org: o
    bucket: b
    token: "\${TEST_INFLUX_TOKEN}"
`);
    const result = loadConfig("monitoring.yml");
    expect((result[0].transporter as Record<string, unknown>)["token"]).toBe("my-secret-token");
  });

  it("throws when a referenced env variable is not set", () => {
    delete process.env.TEST_INFLUX_TOKEN;
    vi.mocked(readFileSync).mockReturnValue(`
- namespace: app
  transporter:
    token: "\${TEST_INFLUX_TOKEN}"
`);
    expect(() => loadConfig("monitoring.yml")).toThrow("environment variable");
  });
});

// ─── loadConfig — error cases ─────────────────────────────────────────────────

describe("loadConfig — error cases", () => {
  it("throws a descriptive error when the file cannot be read", () => {
    vi.mocked(readFileSync).mockImplementation(() => {
      throw new Error("ENOENT: no such file or directory");
    });
    expect(() => loadConfig("missing.yml")).toThrow('loadConfig: failed to read or parse "missing.yml"');
  });

  it("throws when the YAML content is not a top-level array", () => {
    vi.mocked(readFileSync).mockReturnValue("namespace: app");
    expect(() => loadConfig("bad.yml")).toThrow("loadConfig: expected a top-level array");
  });

  it("throws when the YAML content is null", () => {
    vi.mocked(readFileSync).mockReturnValue("~");
    expect(() => loadConfig("null.yml")).toThrow("loadConfig: expected a top-level array");
  });
});
