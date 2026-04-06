import { describe, it, expect, vi } from "vitest";
import { Recorder } from "../runtime/recorder";
import type { CounterMetricRef, GaugeMetricRef, HistogramMetricRef } from "../types";
import type { Counter, Gauge, Histogram } from "../metric";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeCounterRef(): CounterMetricRef {
  return {
    uri: "hits",
    type: "counter",
    enabled: true,
    metric: { increment: vi.fn() } as unknown as Counter,
  };
}

function makeGaugeRef(): GaugeMetricRef {
  return {
    uri: "memory",
    type: "gauge",
    enabled: true,
    metric: { set: vi.fn() } as unknown as Gauge,
  };
}

function makeHistogramRef(): HistogramMetricRef {
  return {
    uri: "latency",
    type: "histogram",
    enabled: true,
    metric: { record: vi.fn() } as unknown as Histogram,
  };
}

// ─── Recorder.increment ──────────────────────────────────────────────────────

describe("Recorder.increment", () => {
  it("calls metric.increment with the delta, current timestamp, and tags", () => {
    const now = vi.fn().mockReturnValue(1234);
    const recorder = new Recorder(now);
    const ref = makeCounterRef();

    recorder.increment(ref, 3, { route: "/api" });

    expect(ref.metric.increment).toHaveBeenCalledOnce();
    expect(ref.metric.increment).toHaveBeenCalledWith(3, 1234, { route: "/api" });
  });

  it("uses the injected now function for the timestamp", () => {
    const now = vi.fn().mockReturnValue(9999);
    const recorder = new Recorder(now);
    const ref = makeCounterRef();

    recorder.increment(ref, 1);

    expect(now).toHaveBeenCalled();
    expect(ref.metric.increment).toHaveBeenCalledWith(1, 9999, undefined);
  });

  it("defaults delta to 1", () => {
    const recorder = new Recorder(() => 0);
    const ref = makeCounterRef();

    recorder.increment(ref);

    expect(ref.metric.increment).toHaveBeenCalledWith(1, 0, undefined);
  });
});

// ─── Recorder.set ────────────────────────────────────────────────────────────

describe("Recorder.set", () => {
  it("calls metric.set with the value, current timestamp, and tags", () => {
    const now = vi.fn().mockReturnValue(5000);
    const recorder = new Recorder(now);
    const ref = makeGaugeRef();

    recorder.set(ref, 512, { type: "rss" });

    expect(ref.metric.set).toHaveBeenCalledOnce();
    expect(ref.metric.set).toHaveBeenCalledWith(512, 5000, { type: "rss" });
  });

  it("uses the injected now function for the timestamp", () => {
    const now = vi.fn().mockReturnValue(42);
    const recorder = new Recorder(now);
    const ref = makeGaugeRef();

    recorder.set(ref, 100);

    expect(now).toHaveBeenCalled();
    expect(ref.metric.set).toHaveBeenCalledWith(100, 42, undefined);
  });
});

// ─── Recorder.record ─────────────────────────────────────────────────────────

describe("Recorder.record", () => {
  it("calls metric.record with the value, current timestamp, and tags", () => {
    const now = vi.fn().mockReturnValue(7777);
    const recorder = new Recorder(now);
    const ref = makeHistogramRef();

    recorder.record(ref, 42, { route: "/api" });

    expect(ref.metric.record).toHaveBeenCalledOnce();
    expect(ref.metric.record).toHaveBeenCalledWith(42, 7777, { route: "/api" });
  });

  it("uses the injected now function for the timestamp", () => {
    const now = vi.fn().mockReturnValue(100);
    const recorder = new Recorder(now);
    const ref = makeHistogramRef();

    recorder.record(ref, 99);

    expect(now).toHaveBeenCalled();
    expect(ref.metric.record).toHaveBeenCalledWith(99, 100, undefined);
  });
});
