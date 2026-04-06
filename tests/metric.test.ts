import { describe, it, expect } from "vitest";
import { Counter, Gauge, Histogram } from "../metric";

// ─── Counter ─────────────────────────────────────────────────────────────────

describe("Counter.increment", () => {
  it("records a single increment", () => {
    const counter = new Counter({ cache: { max: 100 } });
    counter.increment(1, 1000);
    const [entry] = counter.aggregate();
    expect(entry).toMatchObject({
      value: { value: 1 },
      timestamp: 1000,
      tags: {},
    });
  });

  it("accumulates increments with the same tags", () => {
    const counter = new Counter({ cache: { max: 100 } });
    counter.increment(1, 1000, { method: "GET" });
    counter.increment(3, 2000, { method: "GET" });
    const results = counter.aggregate();
    expect(results).toHaveLength(1);
    expect(results[0].value).toEqual({ value: 4 });
  });

  it("creates separate entries for different tag values", () => {
    const counter = new Counter({ cache: { max: 100 } });
    counter.increment(1, 1000, { method: "GET" });
    counter.increment(1, 1000, { method: "POST" });
    expect(counter.aggregate()).toHaveLength(2);
  });

  it("treats tag sets with different key order as the same entry", () => {
    const counter = new Counter({ cache: { max: 100 } });
    counter.increment(1, 1000, { method: "GET", status: "200" });
    counter.increment(1, 2000, { status: "200", method: "GET" });
    const results = counter.aggregate();
    expect(results).toHaveLength(1);
    expect(results[0].value).toMatchObject({ value: 2 });
  });

  it("strips excluded tag keys", () => {
    const counter = new Counter({
      cache: { max: 100 },
      exclude: ["request_id"],
    });
    counter.increment(1, 1000, { method: "GET", request_id: "abc" });
    counter.increment(1, 2000, { method: "GET", request_id: "xyz" });
    const results = counter.aggregate();
    expect(results).toHaveLength(1);
    expect(results[0].tags).not.toHaveProperty("request_id");
  });

  it("treats high-cardinality tags as the same entry after exclusion", () => {
    const counter = new Counter({
      cache: { max: 100 },
      exclude: ["trace_id"],
    });
    counter.increment(1, 1000, { route: "/api", trace_id: "aaa" });
    counter.increment(1, 2000, { route: "/api", trace_id: "bbb" });
    counter.increment(1, 3000, { route: "/api", trace_id: "ccc" });
    const results = counter.aggregate();
    expect(results).toHaveLength(1);
    expect(results[0].value).toEqual({ value: 3 });
  });

  it("updates the timestamp to the most recent increment", () => {
    const counter = new Counter({ cache: { max: 100 } });
    counter.increment(1, 1000);
    counter.increment(1, 2000);
    const [entry] = counter.aggregate();
    expect(entry.timestamp).toBe(2000);
  });
});

describe("Counter.aggregate", () => {
  it("returns the correct shape for each entry", () => {
    const counter = new Counter({ cache: { max: 100 } });
    counter.increment(2, 9999, { env: "prod" });
    const [entry] = counter.aggregate();
    expect(entry.timestamp).toBe(9999);
    expect(entry.tags).toEqual({ env: "prod" });
    expect(entry.value).toEqual({ value: 2 });
  });

  it("includes metric-level tags in every entry", () => {
    const counter = new Counter({
      cache: { max: 100 },
      tags: { env: "prod" },
    });
    counter.increment(1, 1000);
    const [entry] = counter.aggregate();
    expect(entry.tags).toMatchObject({ env: "prod" });
  });

  it("metric-level tags take precedence over entry tags on collision", () => {
    const counter = new Counter({
      cache: { max: 100 },
      tags: { env: "prod" },
    });
    counter.increment(1, 1000, { env: "staging", route: "/api" });
    const [entry] = counter.aggregate();
    expect(entry.tags).toEqual({ env: "prod", route: "/api" });
  });
});

describe("Counter.reset", () => {
  it("clears all entries", () => {
    const counter = new Counter({ cache: { max: 100 } });
    counter.increment(5, 1000);
    counter.reset();
    expect(counter.aggregate()).toHaveLength(0);
  });
});

// ─── Gauge ───────────────────────────────────────────────────────────────────

describe("Gauge.set", () => {
  it("records a value", () => {
    const gauge = new Gauge({ cache: { max: 100 } });
    gauge.set(512, 1000);
    const [entry] = gauge.aggregate();
    expect(entry).toMatchObject({
      value: { value: 512 },
      timestamp: 1000,
      tags: {},
    });
  });

  it("overwrites the previous value for the same tags", () => {
    const gauge = new Gauge({ cache: { max: 100 } });
    gauge.set(100, 1000);
    gauge.set(200, 2000);
    const results = gauge.aggregate();
    expect(results).toHaveLength(1);
    expect(results[0].value).toEqual({ value: 200 });
  });

  it("creates separate entries for different tag values", () => {
    const gauge = new Gauge({ cache: { max: 100 } });
    gauge.set(100, 1000, { pid: "1" });
    gauge.set(200, 1000, { pid: "2" });
    expect(gauge.aggregate()).toHaveLength(2);
  });

  it("treats tag sets with different key order as the same entry", () => {
    const gauge = new Gauge({ cache: { max: 100 } });
    gauge.set(100, 1000, { host: "a", region: "eu" });
    gauge.set(200, 2000, { region: "eu", host: "a" });
    const results = gauge.aggregate();
    expect(results).toHaveLength(1);
    expect(results[0].value).toEqual({ value: 200 });
  });

  it("strips excluded tag keys", () => {
    const gauge = new Gauge({
      cache: { max: 100 },
      exclude: ["pod"],
    });
    gauge.set(100, 1000, { host: "a", pod: "x" });
    const [entry] = gauge.aggregate();
    expect(entry.tags).not.toHaveProperty("pod");
    expect(entry.tags).toHaveProperty("host");
  });

  it("treats high-cardinality tags as the same entry after exclusion", () => {
    const gauge = new Gauge({
      cache: { max: 100 },
      exclude: ["request_id"],
    });
    gauge.set(100, 1000, { route: "/api", request_id: "abc" });
    gauge.set(200, 2000, { route: "/api", request_id: "xyz" });
    const results = gauge.aggregate();
    expect(results).toHaveLength(1);
    expect(results[0].value).toEqual({ value: 200 });
  });

  it("updates the timestamp to the most recent set", () => {
    const gauge = new Gauge({ cache: { max: 100 } });
    gauge.set(1, 1000);
    gauge.set(1, 2000);
    const [entry] = gauge.aggregate();
    expect(entry.timestamp).toBe(2000);
  });
});

describe("Gauge.aggregate", () => {
  it("returns the correct shape for each entry", () => {
    const gauge = new Gauge({ cache: { max: 100 } });
    gauge.set(42, 5000, { type: "rss" });
    const [entry] = gauge.aggregate();
    expect(entry.timestamp).toBe(5000);
    expect(entry.tags).toEqual({ type: "rss" });
    expect(entry.value).toEqual({ value: 42 });
  });
});

describe("Gauge.reset", () => {
  it("clears all entries", () => {
    const gauge = new Gauge({ cache: { max: 100 } });
    gauge.set(100, 1000);
    gauge.reset();
    expect(gauge.aggregate()).toHaveLength(0);
  });
});

// ─── Histogram ───────────────────────────────────────────────────────────────

describe("Histogram.record", () => {
  it("records a single observation", () => {
    const histogram = new Histogram({ cache: { max: 100 } });
    histogram.record(42, 1000);
    const [entry] = histogram.aggregate();
    expect(entry.timestamp).toBe(1000);
    expect(entry.value.count).toBe(1);
    expect(entry.value.min).toBe(42);
    expect(entry.value.max).toBe(42);
    expect(entry.value.mean).toBe(42);
    expect(entry.value.stddev).toBe(0);
  });

  it("accumulates multiple observations into the same histogram", () => {
    const histogram = new Histogram({ cache: { max: 100 } });
    histogram.record(10, 1000);
    histogram.record(20, 2000);
    histogram.record(30, 3000);
    const [entry] = histogram.aggregate();
    expect(entry.value.count).toBe(3);
  });

  it("creates separate histograms for different tag values", () => {
    const histogram = new Histogram({ cache: { max: 100 } });
    histogram.record(10, 1000, { route: "/a" });
    histogram.record(20, 1000, { route: "/b" });
    expect(histogram.aggregate()).toHaveLength(2);
  });

  it("treats tag sets with different key order as the same histogram", () => {
    const histogram = new Histogram({ cache: { max: 100 } });
    histogram.record(10, 1000, { method: "GET", route: "/a" });
    histogram.record(20, 2000, { route: "/a", method: "GET" });
    const results = histogram.aggregate();
    expect(results).toHaveLength(1);
    expect(results[0].value.count).toBe(2);
  });

  it("strips excluded tag keys", () => {
    const histogram = new Histogram({
      cache: { max: 100 },
      exclude: ["trace_id"],
    });
    histogram.record(10, 1000, { route: "/a", trace_id: "abc" });
    histogram.record(20, 2000, { route: "/a", trace_id: "xyz" });
    const results = histogram.aggregate();
    expect(results).toHaveLength(1);
    expect(results[0].tags).not.toHaveProperty("trace_id");
  });

  it("treats high-cardinality tags as the same histogram after exclusion", () => {
    const histogram = new Histogram({
      cache: { max: 100 },
      exclude: ["request_id"],
    });
    histogram.record(10, 1000, { route: "/a", request_id: "abc" });
    histogram.record(20, 2000, { route: "/a", request_id: "xyz" });
    histogram.record(30, 3000, { route: "/a", request_id: "123" });
    const results = histogram.aggregate();
    expect(results).toHaveLength(1);
    expect(results[0].value.count).toBe(3);
  });

  it("updates the timestamp to the most recent record", () => {
    const histogram = new Histogram({ cache: { max: 100 } });
    histogram.record(10, 1000);
    histogram.record(20, 2000);
    const [entry] = histogram.aggregate();
    expect(entry.timestamp).toBe(2000);
  });
});

describe("Histogram.aggregate", () => {
  it("returns the correct shape for each entry", () => {
    const histogram = new Histogram({ cache: { max: 100 } });
    histogram.record(100, 7000, { env: "prod" });
    histogram.record(200, 8000, { env: "prod" });
    histogram.record(300, 9000, { env: "prod" });
    const [entry] = histogram.aggregate();
    expect(entry.timestamp).toBe(9000);
    expect(entry.tags).toEqual({ env: "prod" });
    expect(entry.value.count).toBe(3);
    expect(entry.value.min).toBe(100);
    expect(entry.value.max).toBe(300);
    expect(entry.value.mean).toBe(200);
    expect(entry.value.stddev).toBeCloseTo(81.649658092773, 4);
  });
});

describe("Histogram.reset", () => {
  it("clears all entries", () => {
    const histogram = new Histogram({ cache: { max: 100 } });
    histogram.record(10, 1000);
    histogram.reset();
    expect(histogram.aggregate()).toHaveLength(0);
  });
});
