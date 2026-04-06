import { vi, describe, it, expect, beforeEach } from "vitest";
import { Registry } from "../registry";
import { Counter, Gauge, Histogram } from "../metric";
import type { MetricConfig } from "../types";

vi.mock("../runtime/context", () => ({
  bumpVersion: vi.fn(),
}));

import { bumpVersion } from "../runtime/context";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeConfig(overrides: Partial<MetricConfig> = {}): MetricConfig {
  return {
    type: "counter",
    uri: "test.metric",
    interval: 1000,
    reset: false,
    enabled: true,
    ...overrides,
  };
}

// ─── register ────────────────────────────────────────────────────────────────

describe("Registry.register", () => {
  beforeEach(() => vi.mocked(bumpVersion).mockReset());

  it("creates a Counter for type 'counter'", () => {
    const registry = new Registry("test");
    registry.register([makeConfig({ type: "counter", uri: "hits" })]);

    expect(registry.get("hits")?.metric).toBeInstanceOf(Counter);
  });

  it("creates a Gauge for type 'gauge'", () => {
    const registry = new Registry("test");
    registry.register([makeConfig({ type: "gauge", uri: "memory" })]);

    expect(registry.get("memory")?.metric).toBeInstanceOf(Gauge);
  });

  it("creates a Histogram for type 'histogram'", () => {
    const registry = new Registry("test");
    registry.register([makeConfig({ type: "histogram", uri: "latency" })]);

    expect(registry.get("latency")?.metric).toBeInstanceOf(Histogram);
  });

  it("stores the correct ref properties", () => {
    const registry = new Registry("test");
    registry.register([makeConfig({ uri: "hits", type: "counter", interval: 5000, reset: true, enabled: true })]);

    const ref = registry.get("hits");
    expect(ref).toMatchObject({
      uri: "hits",
      type: "counter",
      interval: 5000,
      reset: true,
      enabled: true,
    });
  });

  it("defaults enabled to true when omitted", () => {
    const registry = new Registry("test");
    registry.register([makeConfig({ uri: "hits", enabled: undefined })]);

    expect(registry.get("hits")?.enabled).toBe(true);
  });

  it("calls bumpVersion once per metric registered", () => {
    const registry = new Registry("test");
    registry.register([makeConfig({ uri: "a" }), makeConfig({ uri: "b" }), makeConfig({ uri: "c" })]);

    expect(bumpVersion).toHaveBeenCalledTimes(3);
  });

  it("calls bumpVersion with the registry namespace", () => {
    const registry = new Registry("myapp");
    registry.register([makeConfig({ uri: "hits" })]);

    expect(bumpVersion).toHaveBeenCalledWith("myapp");
  });

  it("throws when a metric has an invalid interval (≤ 0)", () => {
    const registry = new Registry("test");
    expect(() => registry.register([makeConfig({ uri: "bad", interval: -1 })])).toThrow("invalid interval");
  });

  it("throws when a metric has a non-integer interval", () => {
    const registry = new Registry("test");
    expect(() => registry.register([makeConfig({ uri: "bad", interval: 1.5 })])).toThrow("invalid interval");
  });

  it("is a no-op when called with an empty array", () => {
    const registry = new Registry("test");
    registry.register([]);

    expect(bumpVersion).not.toHaveBeenCalled();
    expect([...registry.values()]).toHaveLength(0);
  });

  it("overwrites a previously registered metric with the same URI", () => {
    const registry = new Registry("test");
    registry.register([makeConfig({ uri: "hits", type: "counter" })]);
    registry.register([makeConfig({ uri: "hits", type: "gauge" })]);

    expect(registry.get("hits")?.type).toBe("gauge");
    expect(registry.get("hits")?.metric).toBeInstanceOf(Gauge);
  });

  it("registers multiple metrics in one call", () => {
    const registry = new Registry("test");
    registry.register([makeConfig({ uri: "a", type: "counter" }), makeConfig({ uri: "b", type: "gauge" })]);

    expect(registry.get("a")?.metric).toBeInstanceOf(Counter);
    expect(registry.get("b")?.metric).toBeInstanceOf(Gauge);
  });
});

// ─── get ─────────────────────────────────────────────────────────────────────

describe("Registry.get", () => {
  it("returns the registered metric ref by URI", () => {
    const registry = new Registry("test");
    registry.register([makeConfig({ uri: "hits" })]);

    expect(registry.get("hits")).toBeDefined();
    expect(registry.get("hits")?.uri).toBe("hits");
  });

  it("returns undefined for an unknown URI", () => {
    const registry = new Registry("test");

    expect(registry.get("unknown")).toBeUndefined();
  });
});

// ─── values ──────────────────────────────────────────────────────────────────

describe("Registry.values", () => {
  it("returns all registered metrics", () => {
    const registry = new Registry("test");
    registry.register([makeConfig({ uri: "a" }), makeConfig({ uri: "b" }), makeConfig({ uri: "c" })]);

    const uris = [...registry.values()].map((r) => r.uri);
    expect(uris).toEqual(expect.arrayContaining(["a", "b", "c"]));
    expect(uris).toHaveLength(3);
  });

  it("returns an empty iterator when no metrics are registered", () => {
    const registry = new Registry("test");

    expect([...registry.values()]).toHaveLength(0);
  });
});

// ─── setEnabled ──────────────────────────────────────────────────────────────

describe("Registry.setEnabled", () => {
  beforeEach(() => vi.mocked(bumpVersion).mockReset());

  it("sets enabled to false on the registered ref", () => {
    const registry = new Registry("test");
    registry.register([makeConfig({ uri: "hits", enabled: true })]);
    vi.mocked(bumpVersion).mockReset();

    registry.setEnabled("hits", false);

    expect(registry.get("hits")?.enabled).toBe(false);
  });

  it("sets enabled to true on the registered ref", () => {
    const registry = new Registry("test");
    registry.register([makeConfig({ uri: "hits", enabled: false })]);
    vi.mocked(bumpVersion).mockReset();

    registry.setEnabled("hits", true);

    expect(registry.get("hits")?.enabled).toBe(true);
  });

  it("calls bumpVersion with the registry namespace", () => {
    const registry = new Registry("myapp");
    registry.register([makeConfig({ uri: "hits" })]);
    vi.mocked(bumpVersion).mockReset();

    registry.setEnabled("hits", false);

    expect(bumpVersion).toHaveBeenCalledOnce();
    expect(bumpVersion).toHaveBeenCalledWith("myapp");
  });

  it("calls bumpVersion even when the URI is not found", () => {
    const registry = new Registry("test");
    vi.mocked(bumpVersion).mockReset();

    registry.setEnabled("nonexistent", false);

    expect(bumpVersion).toHaveBeenCalledOnce();
  });
});

// ─── cleanup ─────────────────────────────────────────────────────────────────

describe("Registry.cleanup", () => {
  it("calls reset on every registered metric", () => {
    const registry = new Registry("test");
    registry.register([makeConfig({ uri: "a" }), makeConfig({ uri: "b" })]);

    const spyA = vi.spyOn(registry.get("a")!.metric, "reset");
    const spyB = vi.spyOn(registry.get("b")!.metric, "reset");

    registry.cleanup();

    expect(spyA).toHaveBeenCalledOnce();
    expect(spyB).toHaveBeenCalledOnce();
  });

  it("is a no-op when no metrics are registered", () => {
    const registry = new Registry("test");
    expect(() => registry.cleanup()).not.toThrow();
  });
});

// ─── destroy ─────────────────────────────────────────────────────────────────

describe("Registry.destroy", () => {
  beforeEach(() => vi.mocked(bumpVersion).mockReset());

  it("resets all metrics before clearing", () => {
    const registry = new Registry("test");
    registry.register([makeConfig({ uri: "hits" })]);

    const spy = vi.spyOn(registry.get("hits")!.metric, "reset");

    registry.destroy();

    expect(spy).toHaveBeenCalledOnce();
  });

  it("clears all metrics so values() returns empty", () => {
    const registry = new Registry("test");
    registry.register([makeConfig({ uri: "a" }), makeConfig({ uri: "b" })]);

    registry.destroy();

    expect([...registry.values()]).toHaveLength(0);
  });

  it("calls bumpVersion after clearing", () => {
    const registry = new Registry("test");
    registry.register([makeConfig({ uri: "hits" })]);
    vi.mocked(bumpVersion).mockReset();

    registry.destroy();

    expect(bumpVersion).toHaveBeenCalledOnce();
    expect(bumpVersion).toHaveBeenCalledWith("test");
  });
});
