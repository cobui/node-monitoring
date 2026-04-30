import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import { Counter, Gauge, Histogram } from "../sensor";
import { warnings } from "../warnings";
import type { RegisteredMetric } from "../types";

vi.mock("../runtime/context", () => ({
  getContext: vi.fn(),
  getActiveNamespaces: vi.fn().mockReturnValue(["test"]),
}));

import { getContext, getActiveNamespaces } from "../runtime/context";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeRegistry(ref?: RegisteredMetric) {
  return { get: vi.fn().mockReturnValue(ref) };
}

function makeCounterRef(enabled = true): RegisteredMetric {
  return {
    uri: "error",
    type: "counter",
    enabled,
    metric: { increment: vi.fn() } as any,
    interval: 1000,
    reset: false,
  };
}

function makeGaugeRef(enabled = true): RegisteredMetric {
  return {
    uri: "test.gauger",
    type: "gauge",
    enabled,
    metric: { set: vi.fn() } as any,
    interval: 1000,
    reset: false,
  };
}

function makeHistogramRef(enabled = true): RegisteredMetric {
  return {
    uri: "test.histogram",
    type: "histogram",
    enabled,
    metric: { record: vi.fn() } as any,
    interval: 1000,
    reset: false,
  };
}

function makeContext(makeRef: () => RegisteredMetric, overrides = {}) {
  const ref = makeRef();
  const registry = makeRegistry(ref);
  return {
    ctx: { active: true, version: 1, registry, ...overrides },
    registry,
    ref,
  };
}

beforeEach(() => {
  vi.mocked(getContext).mockReset();
  vi.mocked(getActiveNamespaces).mockReset().mockReturnValue(["test"]);
});

// ─── Counter ──────────────────────────────────────────────────────────────────

describe("Counter.mark", () => {
  it("calls metric.increment with value, timestamp and tags", () => {
    const { ctx, ref } = makeContext(makeCounterRef);
    vi.mocked(getContext).mockReturnValue(ctx as any);

    Counter.create("error", "test").increment(3, { route: "/api" });

    expect(ref.metric.increment).toHaveBeenCalledOnce();
    expect(ref.metric.increment).toHaveBeenCalledWith(3, expect.any(Number), { route: "/api" });
  });

  it("defaults to incrementing by 1", () => {
    const { ctx, ref } = makeContext(makeCounterRef);
    vi.mocked(getContext).mockReturnValue(ctx as any);

    Counter.create("error", "test").increment();

    expect(ref.metric.increment).toHaveBeenCalledWith(1, expect.any(Number), undefined);
  });

  it("accepts tags as the only argument, defaulting value to 1", () => {
    const { ctx, ref } = makeContext(makeCounterRef);
    vi.mocked(getContext).mockReturnValue(ctx as any);

    Counter.create("error", "test").increment({ route: "/api" });

    expect(ref.metric.increment).toHaveBeenCalledWith(1, expect.any(Number), { route: "/api" });
  });

  it("is a no-op when context is intentionally stopped (has registry)", () => {
    const { ctx, ref } = makeContext(makeCounterRef, { active: false });
    vi.mocked(getContext).mockReturnValue(ctx as any);

    Counter.create("error", "test").increment();

    expect(ref.metric.increment).not.toHaveBeenCalled();
  });

  it("is a no-op when the metric is not found in the registry", () => {
    const registry = makeRegistry(undefined);
    vi.mocked(getContext).mockReturnValue({ active: true, version: 1, registry } as any);

    expect(() => Counter.create("error", "test").increment()).not.toThrow();
  });

  it("is a no-op when the metric is disabled", () => {
    const ref = makeCounterRef(false);
    const registry = makeRegistry(ref);
    vi.mocked(getContext).mockReturnValue({ active: true, version: 1, registry } as any);

    Counter.create("error", "test").increment();

    expect(ref.metric.increment).not.toHaveBeenCalled();
  });

  it("is a no-op when the metric type does not match", () => {
    const ref = makeGaugeRef();
    const registry = makeRegistry(ref);
    vi.mocked(getContext).mockReturnValue({ active: true, version: 1, registry } as any);

    Counter.create("error", "test").increment();

    expect(ref.metric.set).not.toHaveBeenCalled();
  });

  it("uses the cached ref on subsequent calls with the same version", () => {
    const { ctx, registry } = makeContext(makeCounterRef);
    vi.mocked(getContext).mockReturnValue(ctx as any);

    const counter = Counter.create("error", "test");
    counter.increment();
    counter.increment();

    expect(registry.get).toHaveBeenCalledOnce();
  });

  it("re-resolves the ref when the context version changes", () => {
    const { ctx, registry } = makeContext(makeCounterRef);
    vi.mocked(getContext).mockReturnValue(ctx as any);

    const counter = Counter.create("error", "test");
    counter.increment();
    ctx.version = 2;
    counter.increment();

    expect(registry.get).toHaveBeenCalledTimes(2);
  });
});

// ─── Gauge ────────────────────────────────────────────────────────────────────

describe("Gauge.set", () => {
  it("calls metric.set with value, timestamp and tags", () => {
    const { ctx, ref } = makeContext(makeGaugeRef);
    vi.mocked(getContext).mockReturnValue(ctx as any);

    Gauge.create("memory", "test").set(64, { type: "rss" });

    expect(ref.metric.set).toHaveBeenCalledOnce();
    expect(ref.metric.set).toHaveBeenCalledWith(64, expect.any(Number), { type: "rss" });
  });

  it("is a no-op when the context is intentionally stopped (has registry)", () => {
    const { ctx, ref } = makeContext(makeGaugeRef, { active: false });
    vi.mocked(getContext).mockReturnValue(ctx as any);

    Gauge.create("memory", "test").set(64);

    expect(ref.metric.set).not.toHaveBeenCalled();
  });

  it("is a no-op when the metric is not found in the registry", () => {
    const registry = makeRegistry(undefined);
    vi.mocked(getContext).mockReturnValue({ active: true, version: 1, registry } as any);

    expect(() => Gauge.create("memory", "test").set(64)).not.toThrow();
  });

  it("is a no-op when the metric is disabled", () => {
    const ref = makeGaugeRef(false);
    const registry = makeRegistry(ref);
    vi.mocked(getContext).mockReturnValue({ active: true, version: 1, registry } as any);

    Gauge.create("memory", "test").set(64);

    expect(ref.metric.set).not.toHaveBeenCalled();
  });

  it("is a no-op when the metric type does not match", () => {
    const ref = makeCounterRef();
    const registry = makeRegistry(ref);
    vi.mocked(getContext).mockReturnValue({ active: true, version: 1, registry } as any);

    Gauge.create("memory", "test").set(64);

    expect(ref.metric.increment).not.toHaveBeenCalled();
  });

  it("uses the cached ref on subsequent calls with the same version", () => {
    const { ctx, registry } = makeContext(makeGaugeRef);
    vi.mocked(getContext).mockReturnValue(ctx as any);

    const gauge = Gauge.create("memory", "test");
    gauge.set(1);
    gauge.set(2);

    expect(registry.get).toHaveBeenCalledOnce();
  });

  it("re-resolves the ref when the context version changes", () => {
    const { ctx, registry } = makeContext(makeGaugeRef);
    vi.mocked(getContext).mockReturnValue(ctx as any);

    const gauge = Gauge.create("memory", "test");
    gauge.set(1);
    ctx.version = 2;
    gauge.set(2);

    expect(registry.get).toHaveBeenCalledTimes(2);
  });
});

// ─── Histogram ────────────────────────────────────────────────────────────────

describe("Histogram.record", () => {
  it("calls metric.record with value, timestamp and tags", () => {
    const { ctx, ref } = makeContext(makeHistogramRef);
    vi.mocked(getContext).mockReturnValue(ctx as any);

    Histogram.create("latency", "test").record(42, { route: "/api" });

    expect(ref.metric.record).toHaveBeenCalledOnce();
    expect(ref.metric.record).toHaveBeenCalledWith(42, expect.any(Number), { route: "/api" });
  });

  it("is a no-op when the context is intentionally stopped (has registry)", () => {
    const { ctx, ref } = makeContext(makeHistogramRef, { active: false });
    vi.mocked(getContext).mockReturnValue(ctx as any);

    Histogram.create("latency", "test").record(42);

    expect(ref.metric.record).not.toHaveBeenCalled();
  });

  it("is a no-op when the metric is not found in the registry", () => {
    const registry = makeRegistry(undefined);
    vi.mocked(getContext).mockReturnValue({ active: true, version: 1, registry } as any);

    expect(() => Histogram.create("latency", "test").record(42)).not.toThrow();
  });

  it("is a no-op when the metric is disabled", () => {
    const ref = makeHistogramRef(false);
    const registry = makeRegistry(ref);
    vi.mocked(getContext).mockReturnValue({ active: true, version: 1, registry } as any);

    Histogram.create("latency", "test").record(42);

    expect(ref.metric.record).not.toHaveBeenCalled();
  });

  it("is a no-op when the metric type does not match", () => {
    const ref = makeCounterRef();
    const registry = makeRegistry(ref);
    vi.mocked(getContext).mockReturnValue({ active: true, version: 1, registry } as any);

    Histogram.create("latency", "test").record(42);

    expect(ref.metric.increment).not.toHaveBeenCalled();
  });

  it("uses the cached ref on subsequent calls with the same version", () => {
    const { ctx, registry } = makeContext(makeHistogramRef);
    vi.mocked(getContext).mockReturnValue(ctx as any);

    const histogram = Histogram.create("latency", "test");
    histogram.record(10);
    histogram.record(20);

    expect(registry.get).toHaveBeenCalledOnce();
  });

  it("re-resolves the ref when the context version changes", () => {
    const { ctx, registry } = makeContext(makeHistogramRef);
    vi.mocked(getContext).mockReturnValue(ctx as any);

    const histogram = Histogram.create("latency", "test");
    histogram.record(10);
    ctx.version = 2;
    histogram.record(20);

    expect(registry.get).toHaveBeenCalledTimes(2);
  });
});

// ─── Warnings ────────────────────────────────────────────────────────────────

describe("SensorBase warnings", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
    warnings.removeAllListeners();
  });

  it("auto-resolves to the single active namespace when no namespace is given", () => {
    const { ctx, ref } = makeContext(makeCounterRef);
    vi.mocked(getContext).mockReturnValue(ctx as any);

    Counter.create("error").increment(1);

    expect(ref.metric.increment).toHaveBeenCalledWith(1, expect.any(Number), undefined);
  });

  it("emits sensor:ambiguous when no namespace given and multiple are active", () => {
    vi.mocked(getActiveNamespaces).mockReturnValue(["app", "infra"]);
    const received: unknown[] = [];
    warnings.on("sensor:ambiguous", (p) => received.push(p));

    Counter.create("hits").increment();

    expect(warnSpy).not.toHaveBeenCalled();
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ uri: "hits", namespaces: ["app", "infra"] });
  });

  it("warns via console.warn for ambiguous namespace when no listener registered", () => {
    vi.mocked(getActiveNamespaces).mockReturnValue(["app", "infra"]);

    Counter.create("hits").increment();

    expect(warnSpy).toHaveBeenCalledOnce();
    expect(warnSpy.mock.calls[0][0]).toContain("multiple namespaces are active");
  });

  it("emits sensor:ambiguous at most once per sensor instance", () => {
    vi.mocked(getActiveNamespaces).mockReturnValue(["app", "infra"]);

    const counter = Counter.create("hits");
    counter.increment();
    counter.increment();

    expect(warnSpy).toHaveBeenCalledOnce();
  });

  it("warns via console.warn when namespace has never been started (no registry)", () => {
    vi.mocked(getContext).mockReturnValue({ active: false, version: 0 } as any);

    Counter.create("hits", "app").increment();

    expect(warnSpy).toHaveBeenCalledOnce();
    expect(warnSpy.mock.calls[0][0]).toContain("[node-monitoring]");
    expect(warnSpy.mock.calls[0][0]).toContain("hits");
    expect(warnSpy.mock.calls[0][0]).toContain("app");
  });

  it("warns at most once per sensor instance for an inactive namespace", () => {
    vi.mocked(getContext).mockReturnValue({ active: false, version: 0 } as any);

    const counter = Counter.create("hits", "app");
    counter.increment();
    counter.increment();
    counter.increment();

    expect(warnSpy).toHaveBeenCalledOnce();
  });

  it("emits sensor:inactive event instead of console.warn when a listener is registered", () => {
    vi.mocked(getContext).mockReturnValue({ active: false, version: 0 } as any);
    const received: unknown[] = [];
    warnings.on("sensor:inactive", (p) => received.push(p));

    Counter.create("hits", "app").increment();

    expect(warnSpy).not.toHaveBeenCalled();
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ uri: "hits", namespace: "app" });
  });

  it("emits sensor:inactive at most once per sensor when no namespace is given and none active", () => {
    vi.mocked(getActiveNamespaces).mockReturnValue([]);

    const counter = Counter.create("hits");
    counter.increment();
    counter.increment();

    expect(warnSpy).toHaveBeenCalledOnce();
  });

  it("warns via console.warn when no namespaces are active and none is given", () => {
    vi.mocked(getActiveNamespaces).mockReturnValue([]);

    Counter.create("hits").increment();

    expect(warnSpy).toHaveBeenCalledOnce();
    expect(warnSpy.mock.calls[0][0]).toContain("[node-monitoring]");
    expect(warnSpy.mock.calls[0][0]).toContain("hits");
  });

  it("does not warn when namespace is intentionally stopped (has registry)", () => {
    const { ctx } = makeContext(makeCounterRef, { active: false });
    vi.mocked(getContext).mockReturnValue(ctx as any);

    Counter.create("error", "test").increment();

    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("warns via console.warn when metric URI is not registered", () => {
    const registry = makeRegistry(undefined);
    vi.mocked(getContext).mockReturnValue({ active: true, version: 1, registry } as any);

    Counter.create("unknown.metric", "app").increment();

    expect(warnSpy).toHaveBeenCalledOnce();
    expect(warnSpy.mock.calls[0][0]).toContain("[node-monitoring]");
    expect(warnSpy.mock.calls[0][0]).toContain("unknown.metric");
  });

  it("warns at most once per sensor instance for a missing metric", () => {
    const registry = makeRegistry(undefined);
    vi.mocked(getContext).mockReturnValue({ active: true, version: 1, registry } as any);

    const counter = Counter.create("unknown.metric", "app");
    counter.increment();
    counter.increment();

    expect(warnSpy).toHaveBeenCalledOnce();
  });

  it("emits sensor:not-found event instead of console.warn when a listener is registered", () => {
    const registry = makeRegistry(undefined);
    vi.mocked(getContext).mockReturnValue({ active: true, version: 1, registry } as any);
    const received: unknown[] = [];
    warnings.on("sensor:not-found", (p) => received.push(p));

    Counter.create("unknown.metric", "app").increment();

    expect(warnSpy).not.toHaveBeenCalled();
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ uri: "unknown.metric", namespace: "app", type: "counter" });
  });
});
