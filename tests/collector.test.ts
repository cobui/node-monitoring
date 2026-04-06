import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import { Collector } from "../collector";
import type { RegisteredMetric, Aggregate } from "../types";
import type { Counter } from "../metric";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeMetricInstance() {
  return {
    aggregate: vi.fn().mockReturnValue([] as Aggregate<unknown>[]),
    reset: vi.fn(),
  };
}

function makeRef(overrides: Partial<RegisteredMetric> = {}): RegisteredMetric {
  return {
    uri: "test.metric",
    type: "counter",
    enabled: true,
    reset: false,
    interval: 1000,
    metric: makeMetricInstance() as unknown as Counter,
    ...overrides,
  } as RegisteredMetric;
}

function makeRegistry(refs: RegisteredMetric[] = []) {
  return {
    get: vi.fn((uri: string) => refs.find((r) => r.uri === uri)),
    values: vi.fn(() => refs.values()),
  };
}

function makeQueue() {
  return { enqueue: vi.fn(), destroy: vi.fn() };
}

function makeAggregate(overrides: Partial<Aggregate<unknown>> = {}): Aggregate<unknown> {
  return {
    tags: {},
    value: 1,
    timestamp: 1000,
    ...overrides,
  };
}

// ─── Collector.start ─────────────────────────────────────────────────────────

describe("Collector.start", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("groups metrics with the same interval into one timer", () => {
    const refs = [makeRef({ uri: "a", interval: 1000 }), makeRef({ uri: "b", interval: 1000 })];
    const collector = new Collector({ namespace: "test" }, makeRegistry(refs) as any, makeQueue() as any);

    collector.start();
    expect(vi.getTimerCount()).toBe(1);
    collector.destroy();
  });

  it("creates separate timers for different intervals", () => {
    const refs = [makeRef({ uri: "a", interval: 1000 }), makeRef({ uri: "b", interval: 5000 })];
    const collector = new Collector({ namespace: "test" }, makeRegistry(refs) as any, makeQueue() as any);

    collector.start();
    expect(vi.getTimerCount()).toBe(2);
    collector.destroy();
  });

  it("creates one timer per interval group", () => {
    const refs = [makeRef({ uri: "a", interval: 1000 }), makeRef({ uri: "b", interval: 2000 })];
    const collector = new Collector({ namespace: "test" }, makeRegistry(refs) as any, makeQueue() as any);

    collector.start();
    expect(vi.getTimerCount()).toBe(2);
    collector.destroy();
  });

  it("clears existing timers before creating new ones", () => {
    const refs = [makeRef({ uri: "a", interval: 1000 })];
    const collector = new Collector({ namespace: "test" }, makeRegistry(refs) as any, makeQueue() as any);

    collector.start();
    collector.start();
    expect(vi.getTimerCount()).toBe(1);
    collector.destroy();
  });
});

// ─── Collector.stop ──────────────────────────────────────────────────────────

describe("Collector.stop", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("clears all timers", () => {
    const refs = [makeRef({ uri: "a", interval: 1000 })];
    const collector = new Collector({ namespace: "test" }, makeRegistry(refs) as any, makeQueue() as any);

    collector.start();
    collector.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("prevents further collection after being called", async () => {
    const metric = makeMetricInstance();
    const ref = makeRef({ metric: metric as unknown as Counter });

    const collector = new Collector({ namespace: "test" }, makeRegistry([ref]) as any, makeQueue() as any);
    collector.start();
    collector.stop();
    await vi.advanceTimersByTimeAsync(5000);

    expect(metric.aggregate).not.toHaveBeenCalled();
  });
});

// ─── Collector.destroy ───────────────────────────────────────────────────────

describe("Collector.destroy", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("clears timers and interval groups so a subsequent start has no effect", () => {
    const refs = [makeRef({ uri: "a", interval: 1000 })];
    const collector = new Collector({ namespace: "test" }, makeRegistry(refs) as any, makeQueue() as any);

    collector.start();
    collector.destroy();
    collector.start();
    expect(vi.getTimerCount()).toBe(0);
  });
});

// ─── Collector.collect ───────────────────────────────────────────────────────

describe("Collector.collect", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("enqueues aggregates when the timer fires", async () => {
    const metric = makeMetricInstance();
    metric.aggregate.mockReturnValue([makeAggregate()]);
    const ref = makeRef({ metric: metric as unknown as Counter });
    const queue = makeQueue();

    const collector = new Collector({ namespace: "test" }, makeRegistry([ref]) as any, queue as any);
    collector.start();
    await vi.advanceTimersByTimeAsync(1000);

    expect(queue.enqueue).toHaveBeenCalledOnce();
    collector.destroy();
  });

  it("enqueues one item per aggregate entry", async () => {
    const metric = makeMetricInstance();
    metric.aggregate.mockReturnValue([
      makeAggregate({ tags: { route: "/a" } }),
      makeAggregate({ tags: { route: "/b" } }),
    ]);
    const ref = makeRef({ metric: metric as unknown as Counter });
    const queue = makeQueue();

    const collector = new Collector({ namespace: "test" }, makeRegistry([ref]) as any, queue as any);
    collector.start();
    await vi.advanceTimersByTimeAsync(1000);

    expect(queue.enqueue).toHaveBeenCalledTimes(2);
    collector.destroy();
  });

  it("merges namespaceTags into each aggregate, call-site tags taking precedence on collision", async () => {
    const metric = makeMetricInstance();
    metric.aggregate.mockReturnValue([makeAggregate({ tags: { env: "staging", route: "/api" } })]);
    const ref = makeRef({ metric: metric as unknown as Counter });
    const queue = makeQueue();

    const collector = new Collector({ namespace: "test", env: "prod" }, makeRegistry([ref]) as any, queue as any);
    collector.start();
    await vi.advanceTimersByTimeAsync(1000);

    expect(queue.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        tags: { env: "staging", route: "/api", namespace: "test", uri: "test.metric" },
      }),
    );
    collector.destroy();
  });

  it("skips disabled metrics", async () => {
    const metric = makeMetricInstance();
    const ref = makeRef({
      enabled: false,
      metric: metric as unknown as Counter,
    });
    const queue = makeQueue();

    const collector = new Collector({ namespace: "test" }, makeRegistry([ref]) as any, queue as any);
    collector.start();
    await vi.advanceTimersByTimeAsync(1000);

    expect(metric.aggregate).not.toHaveBeenCalled();
    expect(queue.enqueue).not.toHaveBeenCalled();
    collector.destroy();
  });

  it("resets the metric after collection when reset is true", async () => {
    const metric = makeMetricInstance();
    metric.aggregate.mockReturnValue([makeAggregate()]);
    const ref = makeRef({ reset: true, metric: metric as unknown as Counter });

    const collector = new Collector({ namespace: "test" }, makeRegistry([ref]) as any, makeQueue() as any);
    collector.start();
    await vi.advanceTimersByTimeAsync(1000);

    expect(metric.reset).toHaveBeenCalledOnce();
    collector.destroy();
  });

  it("does not reset the metric when reset is false", async () => {
    const metric = makeMetricInstance();
    metric.aggregate.mockReturnValue([makeAggregate()]);
    const ref = makeRef({ reset: false, metric: metric as unknown as Counter });

    const collector = new Collector({ namespace: "test" }, makeRegistry([ref]) as any, makeQueue() as any);
    collector.start();
    await vi.advanceTimersByTimeAsync(1000);

    expect(metric.reset).not.toHaveBeenCalled();
    collector.destroy();
  });

  it("fires independently per interval group", async () => {
    const metricA = makeMetricInstance();
    const metricB = makeMetricInstance();
    metricA.aggregate.mockReturnValue([makeAggregate()]);
    metricB.aggregate.mockReturnValue([makeAggregate()]);

    const refs = [
      makeRef({
        uri: "a",
        interval: 1000,
        metric: metricA as unknown as Counter,
      }),
      makeRef({
        uri: "b",
        interval: 3000,
        metric: metricB as unknown as Counter,
      }),
    ];
    const queue = makeQueue();

    const collector = new Collector({ namespace: "test" }, makeRegistry(refs) as any, queue as any);
    collector.start();

    await vi.advanceTimersByTimeAsync(2000);
    expect(metricA.aggregate).toHaveBeenCalledTimes(2);
    expect(metricB.aggregate).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1000);
    expect(metricA.aggregate).toHaveBeenCalledTimes(3);
    expect(metricB.aggregate).toHaveBeenCalledOnce();

    collector.destroy();
  });
});

// ─── Collector.reschedule ────────────────────────────────────────────────────

describe("Collector.reschedule", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("is a no-op for an unknown URI", () => {
    const collector = new Collector({ namespace: "test" }, makeRegistry([]) as any, makeQueue() as any);
    collector.start();
    expect(() => collector.reschedule("unknown", 2000)).not.toThrow();
    expect(vi.getTimerCount()).toBe(0);
    collector.destroy();
  });

  it("is a no-op when the new interval equals the current interval", () => {
    const refs = [makeRef({ uri: "a", interval: 1000 })];
    const collector = new Collector({ namespace: "test" }, makeRegistry(refs) as any, makeQueue() as any);
    collector.start();
    const timersBefore = vi.getTimerCount();
    collector.reschedule("a", 1000);
    expect(vi.getTimerCount()).toBe(timersBefore);
    collector.destroy();
  });

  it("moves the metric to the new interval and fires at the new cadence", () => {
    const metricA = makeMetricInstance();
    metricA.aggregate.mockReturnValue([makeAggregate()]);
    const refs = [makeRef({ uri: "a", interval: 1000, metric: metricA as unknown as Counter })];

    const collector = new Collector({ namespace: "test" }, makeRegistry(refs) as any, makeQueue() as any);
    collector.start();
    collector.reschedule("a", 3000);

    // old 1000ms timer is gone; new 3000ms timer was created
    expect(vi.getTimerCount()).toBe(1);

    // should not fire at 1000ms or 2000ms anymore
    vi.advanceTimersByTime(2000);
    expect(metricA.aggregate).not.toHaveBeenCalled();

    // should fire at 3000ms
    vi.advanceTimersByTime(1000);
    expect(metricA.aggregate).toHaveBeenCalledOnce();

    collector.destroy();
  });

  it("removes the old timer when its group becomes empty", () => {
    const refs = [makeRef({ uri: "a", interval: 1000 })];
    const collector = new Collector({ namespace: "test" }, makeRegistry(refs) as any, makeQueue() as any);
    collector.start();
    expect(vi.getTimerCount()).toBe(1);

    collector.reschedule("a", 2000);
    // old 1000ms group is now empty → timer cleared; new 2000ms timer created
    expect(vi.getTimerCount()).toBe(1);
    collector.destroy();
  });

  it("keeps the old timer when the group still has other metrics after reschedule", () => {
    const refs = [
      makeRef({ uri: "a", interval: 1000 }),
      makeRef({ uri: "b", interval: 1000 }), // same group as "a"
    ];
    const collector = new Collector({ namespace: "test" }, makeRegistry(refs) as any, makeQueue() as any);
    collector.start();
    expect(vi.getTimerCount()).toBe(1); // one timer for the 1000ms group

    collector.reschedule("a", 2000); // "b" remains in 1000ms group → size > 0 → timer kept
    expect(vi.getTimerCount()).toBe(2); // 1000ms timer still alive + new 2000ms timer
    collector.destroy();
  });

  it("joins an existing interval group without creating a duplicate timer", () => {
    const refs = [makeRef({ uri: "a", interval: 1000 }), makeRef({ uri: "b", interval: 2000 })];
    const collector = new Collector({ namespace: "test" }, makeRegistry(refs) as any, makeQueue() as any);
    collector.start();
    expect(vi.getTimerCount()).toBe(2);

    collector.reschedule("a", 2000);
    // "a" joins "b"'s existing 2000ms group — no new timer needed
    expect(vi.getTimerCount()).toBe(1);
    collector.destroy();
  });

  it("is a no-op (no crash) when the old interval group no longer exists", () => {
    // Build collector with empty registry so no intervalGroups are created,
    // then make registry.get() return a ref — reschedule finds the ref but
    // intervalGroups has no entry for its interval → false branch of if (oldGroup).
    const ref = makeRef({ uri: "a", interval: 1000 });
    const registry = makeRegistry([]); // values() empty → no groups built
    (registry.get as ReturnType<typeof vi.fn>).mockReturnValue(ref);

    const collector = new Collector({ namespace: "test" }, registry as any, makeQueue() as any);
    expect(() => collector.reschedule("a", 2000)).not.toThrow();
    expect(vi.getTimerCount()).toBe(0); // no timer created since not running
  });

  it("does not create a timer when the collector is not running", () => {
    const refs = [makeRef({ uri: "a", interval: 1000 })];
    const collector = new Collector({ namespace: "test" }, makeRegistry(refs) as any, makeQueue() as any);
    // not started — reschedule should update groups but not create any timer
    collector.reschedule("a", 2000);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("updates the interval on the registry ref", () => {
    const refs = [makeRef({ uri: "a", interval: 1000 })];
    const registry = makeRegistry(refs);
    const collector = new Collector({ namespace: "test" }, registry as any, makeQueue() as any);
    collector.reschedule("a", 3000);
    expect(registry.get("a")?.interval).toBe(3000);
  });
});
