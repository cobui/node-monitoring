import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

// ─── Module mocks ─────────────────────────────────────────────────────────────
// Mocked: cluster (stay in primary mode without real IPC), transport/listener
// (avoid process event listener side-effects), transport/factory (avoid real
// InfluxDB connections — sendSpy captures what the transport layer receives).
// Everything else — context, registry, recorder, collector, sensor, metric — is real.

vi.mock("node:cluster", () => ({ default: { isWorker: false } }));

vi.mock("../transport/listener", () => ({
  activateListener: vi.fn(),
  deactivateListener: vi.fn(),
}));

vi.mock("../transport/factory", () => ({
  createTransporter: vi.fn(),
}));

// ─── Imports ──────────────────────────────────────────────────────────────────

import { Monitoring } from "../monitoring";
import { Counter, Gauge, Histogram } from "../sensor";
import { createTransporter } from "../transport/factory";
import { _reset as resetQueues } from "../transport/queues";
import type { MonitorConfig } from "../monitor";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const TRANSPORTER_CONFIG: MonitorConfig["transporter"] = {
  type: "influx",
  version: 2,
  host: "h",
  org: "o",
  bucket: "b",
  token: "t",
};

let sendSpy: ReturnType<typeof vi.fn>;
let monitoring: Monitoring;

beforeEach(() => {
  sendSpy = vi.fn().mockResolvedValue(undefined);
  vi.mocked(createTransporter).mockReturnValue({
    key: "test-transporter",
    rateLimit: 1000, // drain intervalMs = ceil(1000/1000) = 1ms
    retry: { retries: 0 },
    queue: { batchSize: 1 }, // one item per drain — keeps per-send assertions exact
    send: vi.fn(async (items: any[]) => {
      for (const item of items) await (sendSpy as (d: unknown) => Promise<void>)(item);
    }),
  });
  vi.useFakeTimers();
  monitoring = new Monitoring();
});

afterEach(() => {
  monitoring.destroy();
  resetQueues();
  vi.useRealTimers();
});

/**
 * Advance fake timers by `ms` plus a 50ms buffer.
 * The buffer covers the drain timer (1ms per item at rateLimit=1000)
 * for up to ~50 queued items per collection cycle.
 */
async function tick(ms = 1000): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms + 50);
}

// ─── Counter ──────────────────────────────────────────────────────────────────

describe("Counter: sensor → recorder → metric → collect → send", () => {
  it("sends the accumulated value after the interval fires", async () => {
    monitoring.add([
      {
        namespace: "app",
        transporter: TRANSPORTER_CONFIG,
        metrics: [{ uri: "hits", type: "counter", interval: 1000 }],
      },
    ]);

    Counter.create("hits", "app").increment(5);
    await tick();

    expect(sendSpy).toHaveBeenCalledOnce();
    expect(sendSpy.mock.calls[0][0]).toMatchObject({
      value: { value: 5 },
      tags: expect.objectContaining({ uri: "hits" }),
    });
  });

  it("accumulates multiple marks before the interval fires", async () => {
    monitoring.add([
      {
        namespace: "app",
        transporter: TRANSPORTER_CONFIG,
        metrics: [{ uri: "hits", type: "counter", interval: 1000 }],
      },
    ]);

    const hits = Counter.create("hits", "app");
    hits.increment(2);
    hits.increment(3);
    hits.increment(5);
    await tick();

    expect(sendSpy).toHaveBeenCalledOnce();
    expect(sendSpy.mock.calls[0][0].value).toEqual({ value: 10 });
  });

  it("resets after collection — second interval sends nothing when no new marks", async () => {
    monitoring.add([
      {
        namespace: "app",
        transporter: TRANSPORTER_CONFIG,
        metrics: [{ uri: "hits", type: "counter", interval: 1000 }],
      },
    ]);

    Counter.create("hits", "app").increment(3);
    await tick(); // first collection: sends 3#
    expect(sendSpy).toHaveBeenCalledOnce();

    sendSpy.mockClear();
    await tick(); // second collection: series is empty → nothing enqueued
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it("produces separate aggregates per distinct tag combination", async () => {
    monitoring.add([
      {
        namespace: "app",
        transporter: TRANSPORTER_CONFIG,
        metrics: [{ uri: "hits", type: "counter", interval: 1000 }],
      },
    ]);

    const hits = Counter.create("hits", "app");
    hits.increment(1, { route: "/a" });
    hits.increment(2, { route: "/a" }); // same tag → accumulates
    hits.increment(4, { route: "/b" }); // different tag → separate entry
    await tick();

    expect(sendSpy).toHaveBeenCalledTimes(2);
    const values = sendSpy.mock.calls.map(([agg]) => agg.value.value as number).sort((a, b) => a - b);
    expect(values).toEqual([3, 4]);
  });
});

// ─── Gauge ────────────────────────────────────────────────────────────────────

describe("Gauge: sensor → recorder → metric → collect → send", () => {
  it("sends the last set value after the interval fires", async () => {
    monitoring.add([
      {
        namespace: "app",
        transporter: TRANSPORTER_CONFIG,
        metrics: [{ uri: "memory", type: "gauge", interval: 1000 }],
      },
    ]);

    Gauge.create("memory", "app").set(42);
    await tick();

    expect(sendSpy).toHaveBeenCalledOnce();
    expect(sendSpy.mock.calls[0][0].value).toEqual({ value: 42 });
  });

  it("reflects only the latest set() call — overwrites earlier values", async () => {
    monitoring.add([
      {
        namespace: "app",
        transporter: TRANSPORTER_CONFIG,
        metrics: [{ uri: "memory", type: "gauge", interval: 1000 }],
      },
    ]);

    const mem = Gauge.create("memory", "app");
    mem.set(10);
    mem.set(99); // overwrites
    await tick();

    expect(sendSpy).toHaveBeenCalledOnce();
    expect(sendSpy.mock.calls[0][0].value).toEqual({ value: 99 });
  });

  it("repeats the last value on subsequent intervals without re-recording (no reset)", async () => {
    monitoring.add([
      {
        namespace: "app",
        transporter: TRANSPORTER_CONFIG,
        metrics: [{ uri: "memory", type: "gauge", interval: 1000 }],
      },
    ]);

    Gauge.create("memory", "app").set(64);
    await tick(); // first collection
    sendSpy.mockClear();
    await tick(); // second collection: value persists — gauge never resets
    expect(sendSpy).toHaveBeenCalledOnce();
    expect(sendSpy.mock.calls[0][0].value).toEqual({ value: 64 });
  });
});

// ─── Histogram ────────────────────────────────────────────────────────────────

describe("Histogram: sensor → recorder → metric → collect → send", () => {
  it("sends count, min, and max across all recorded observations", async () => {
    monitoring.add([
      {
        namespace: "app",
        transporter: TRANSPORTER_CONFIG,
        metrics: [{ uri: "latency", type: "histogram", interval: 1000 }],
      },
    ]);

    const lat = Histogram.create("latency", "app");
    lat.record(10);
    lat.record(50);
    lat.record(30);
    await tick();

    expect(sendSpy).toHaveBeenCalledOnce();
    const { value } = sendSpy.mock.calls[0][0];
    expect(value.count).toBe(3);
    expect(value.min).toBe(10);
    expect(value.max).toBe(50);
  });

  it("resets after collection — second interval sends nothing when idle", async () => {
    monitoring.add([
      {
        namespace: "app",
        transporter: TRANSPORTER_CONFIG,
        metrics: [{ uri: "latency", type: "histogram", interval: 1000 }],
      },
    ]);

    Histogram.create("latency", "app").record(42);
    await tick();
    expect(sendSpy).toHaveBeenCalledOnce();

    sendSpy.mockClear();
    await tick();
    expect(sendSpy).not.toHaveBeenCalled();
  });
});

// ─── Tags ─────────────────────────────────────────────────────────────────────

describe("Tag merging", () => {
  it("merges namespace-level, metric-level, and call-site tags into every aggregate", async () => {
    monitoring.add([
      {
        namespace: "app",
        tags: { env: "test" },
        includeNamespaceTag: true,
        transporter: TRANSPORTER_CONFIG,
        metrics: [{ uri: "hits", type: "counter", interval: 1000, tags: { service: "api" } }],
      },
    ]);

    Counter.create("hits", "app").increment(1, { route: "/users" });
    await tick();

    const { tags } = sendSpy.mock.calls[0][0];
    expect(tags).toMatchObject({
      namespace: "app",
      env: "test",
      service: "api",
      route: "/users",
      uri: "hits",
    });
  });

  it("always stamps namespace and uri regardless of other tags", async () => {
    monitoring.add([
      {
        namespace: "myns",
        includeNamespaceTag: true,
        transporter: TRANSPORTER_CONFIG,
        metrics: [{ uri: "some.metric", type: "counter", interval: 1000 }],
      },
    ]);

    Counter.create("some.metric", "myns").increment();
    await tick();

    const { tags } = sendSpy.mock.calls[0][0];
    expect(tags.namespace).toBe("myns");
    expect(tags.uri).toBe("some.metric");
  });
});

// ─── Namespace resolution ─────────────────────────────────────────────────────

describe("Namespace resolution", () => {
  it("sensor without a namespace auto-resolves when exactly one namespace is active", async () => {
    monitoring.add([
      {
        namespace: "app",
        transporter: TRANSPORTER_CONFIG,
        metrics: [{ uri: "hits", type: "counter", interval: 1000 }],
      },
    ]);

    Counter.create("hits").increment(3); // no namespace
    await tick();

    expect(sendSpy).toHaveBeenCalledOnce();
    expect(sendSpy.mock.calls[0][0].value).toEqual({ value: 3 });
  });

  it("sensor is a silent no-op when namespace is intentionally stopped", async () => {
    monitoring.add([
      {
        namespace: "app",
        transporter: TRANSPORTER_CONFIG,
        metrics: [{ uri: "hits", type: "counter", interval: 1000 }],
      },
    ]);
    monitoring.setNamespaceEnabled("app", false);

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    Counter.create("hits", "app").increment(5);
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();

    await tick();
    expect(sendSpy).not.toHaveBeenCalled(); // collector is stopped, nothing collected
  });

  it("sensor resumes recording after namespace is re-enabled", async () => {
    monitoring.add([
      {
        namespace: "app",
        transporter: TRANSPORTER_CONFIG,
        metrics: [{ uri: "hits", type: "counter", interval: 1000 }],
      },
    ]);
    monitoring.setNamespaceEnabled("app", false);
    monitoring.setNamespaceEnabled("app", true);

    Counter.create("hits", "app").increment(7);
    await tick();

    expect(sendSpy).toHaveBeenCalledOnce();
    expect(sendSpy.mock.calls[0][0].value).toEqual({ value: 7 });
  });

  it("marks recorded while namespace is stopped are discarded — not sent on resume", async () => {
    monitoring.add([
      {
        namespace: "app",
        transporter: TRANSPORTER_CONFIG,
        metrics: [{ uri: "hits", type: "counter", interval: 1000 }],
      },
    ]);
    monitoring.setNamespaceEnabled("app", false);

    Counter.create("hits", "app").increment(99); // silent no-op → not stored in metric

    monitoring.setNamespaceEnabled("app", true);
    await tick();

    // Nothing was recorded while stopped — send should not be called
    expect(sendSpy).not.toHaveBeenCalled();
  });
});

// ─── Per-metric control ───────────────────────────────────────────────────────

describe("Per-metric enable/disable", () => {
  it("disabled metric is not recorded or collected", async () => {
    monitoring.add([
      {
        namespace: "app",
        transporter: TRANSPORTER_CONFIG,
        metrics: [{ uri: "hits", type: "counter", interval: 1000 }],
      },
    ]);
    monitoring.setMetricEnabled("app", "hits", false);

    Counter.create("hits", "app").increment(5); // no-op — metric disabled
    await tick();

    expect(sendSpy).not.toHaveBeenCalled();
  });

  it("re-enabled metric resumes recording and collection", async () => {
    monitoring.add([
      {
        namespace: "app",
        transporter: TRANSPORTER_CONFIG,
        metrics: [{ uri: "hits", type: "counter", interval: 1000 }],
      },
    ]);
    monitoring.setMetricEnabled("app", "hits", false);
    monitoring.setMetricEnabled("app", "hits", true);

    Counter.create("hits", "app").increment(4);
    await tick();

    expect(sendSpy).toHaveBeenCalledOnce();
    expect(sendSpy.mock.calls[0][0].value).toEqual({ value: 4 });
  });
});

// ─── Flush ────────────────────────────────────────────────────────────────────

describe("flush()", () => {
  it("collects all metrics immediately without waiting for the scheduled interval", async () => {
    monitoring.add([
      {
        namespace: "app",
        transporter: TRANSPORTER_CONFIG,
        metrics: [{ uri: "hits", type: "counter", interval: 60_000 }], // very long interval
      },
    ]);

    Counter.create("hits", "app").increment(9);
    await monitoring.flush();
    await vi.advanceTimersByTimeAsync(50); // let drain timer fire

    expect(sendSpy).toHaveBeenCalledOnce();
    expect(sendSpy.mock.calls[0][0].value).toEqual({ value: 9 });
  });

  it("flush does not interfere with the scheduled interval — both can fire", async () => {
    monitoring.add([
      {
        namespace: "app",
        transporter: TRANSPORTER_CONFIG,
        metrics: [{ uri: "hits", type: "counter", interval: 1000 }],
      },
    ]);

    Counter.create("hits", "app").increment(3);
    await monitoring.flush(); // immediate collect + reset
    await vi.advanceTimersByTimeAsync(50);
    sendSpy.mockClear();

    // Counter was reset after flush — scheduled interval finds nothing to send
    await tick();
    expect(sendSpy).not.toHaveBeenCalled();
  });
});

// ─── Reschedule ───────────────────────────────────────────────────────────────

describe("reschedule()", () => {
  it("delays collection until the new interval elapses", async () => {
    monitoring.add([
      {
        namespace: "app",
        transporter: TRANSPORTER_CONFIG,
        metrics: [{ uri: "hits", type: "counter", interval: 1000 }],
      },
    ]);
    monitoring.get("app")!.rescheduleMetric("hits", 5000);

    Counter.create("hits", "app").increment(2);

    await tick(1000); // old interval window — hits is on 5000ms now
    expect(sendSpy).not.toHaveBeenCalled();

    await tick(4000); // total ~5100ms from start — 5000ms interval fires
    expect(sendSpy).toHaveBeenCalledOnce();
    expect(sendSpy.mock.calls[0][0].value).toEqual({ value: 2 });
  });
});

// ─── Multiple intervals ───────────────────────────────────────────────────────

describe("Multiple metrics at different intervals", () => {
  it("collects each metric independently on its own schedule", async () => {
    monitoring.add([
      {
        namespace: "app",
        transporter: TRANSPORTER_CONFIG,
        metrics: [
          { uri: "fast", type: "counter", interval: 1000 },
          { uri: "slow", type: "counter", interval: 30_000 },
        ],
      },
    ]);

    Counter.create("fast", "app").increment(1);
    Counter.create("slow", "app").increment(1);

    await tick(1000); // only "fast" fires
    const fastCalls = sendSpy.mock.calls.filter(([agg]) => agg.tags.uri === "fast");
    const slowCalls = sendSpy.mock.calls.filter(([agg]) => agg.tags.uri === "slow");
    expect(fastCalls).toHaveLength(1);
    expect(slowCalls).toHaveLength(0);

    sendSpy.mockClear();
    await tick(29_000); // total ~30_100ms — "slow" fires
    const slowCalls2 = sendSpy.mock.calls.filter(([agg]) => agg.tags.uri === "slow");
    expect(slowCalls2).toHaveLength(1);
    expect(slowCalls2[0][0].value).toEqual({ value: 1 });
  });
});
