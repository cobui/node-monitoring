import { LRUCache } from "lru-cache";
import { createHistogram, RecordableHistogram } from "node:perf_hooks";
import { createHash } from "crypto";
import type { Aggregate, Entry, HistogramAggregate, MetricOptions, Tags } from "./types";

/*
 * This module defines the core metric classes: Counter, Gauge, and Histogram.
 * Each class extends the abstract Metric class, which provides common functionality for storing and aggregating metric data points.
 */

/**
 * Abstract base class for all metric types.
 * Provides common functionality for storing and aggregating time-series data points,
 * keyed by a hash of the metric's tags.
 *
 * @template TStored - The raw value type stored in the series cache.
 * @template TAggregate - The aggregated value type returned by {@link Metric#aggregate}.
 */
abstract class Metric<TStored, TAggregate> {
  protected readonly tags: Tags;
  protected readonly exclude: string[];
  /**
   * LRU cache storing recorded data points indexed by a tag-hash key.
   * The maximum size is defined in {@link MetricOptions} — once reached,
   * the least-recently-used entry is evicted.
   */
  protected readonly series: LRUCache<string, Entry<TStored>>;

  /**
   * @param {MetricOptions} options - Configuration options including default tags, excluded tag keys, and cache size.
   */
  constructor(options: MetricOptions) {
    this.tags = options.tags || {};
    this.exclude = options.exclude || [];
    const max = options.cache?.max || 1000;
    this.series = new LRUCache<string, Entry<TStored>>({ max });
  }

  protected hashTags(tags: Tags): string {
    return createHash("sha256")
      .update(
        Object.entries(tags)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([k, v]) => `${k}=${v}`)
          .join(","),
      )
      .digest("hex");
  }

  protected omit(tags: Tags, exclude: string[]): Tags {
    const redacted: Tags = {};
    for (const [key, value] of Object.entries(tags)) {
      if (!exclude.includes(key)) {
        redacted[key] = value;
      }
    }
    return redacted;
  }

  /**
   * Extracts the aggregatable value from a raw stored value.
   * @param {TStored} value - The raw stored value.
   * @returns {TAggregate} The value in its aggregated form.
   */
  protected abstract extract(value: TStored): TAggregate;

  /**
   * Resets all recorded data points in the series cache.
   */
  reset(): void {
    this.series.clear();
  }

  /**
   * Returns all recorded data points as an array of aggregated entries,
   * each carrying the metric name, tags, value, and timestamp.
   * @returns {Array<Aggregate<TAggregate>>} Array of aggregated metric entries.
   */
  aggregate(): Aggregate<TAggregate>[] {
    const aggregates: Aggregate<TAggregate>[] = [];
    for (const { tags, timestamp, value } of this.series.values()) {
      aggregates.push({
        tags: { ...tags, ...this.tags },
        value: this.extract(value),
        timestamp,
      });
    }
    return aggregates;
  }
}

/**
 * A monotonically increasing metric that counts occurrences or totals.
 */
class Counter extends Metric<number, { value: number }> {
  /**
   * @param {MetricOptions} options - Metric configuration options.
   */
  constructor(options: MetricOptions) {
    super(options);
  }

  /**
   * Returns the stored numeric value as-is for aggregation.
   * @param {number} value - The raw stored count value.
   * @returns {number} The value unchanged.
   */
  extract(value: number): { value: number } {
    return { value };
  }

  /**
   * Records a new count value at the given timestamp.
   * @param {number} value - The count to record.
   * @param {number} timestamp - Unix timestamp (ms) of the observation.
   * @param {Tags} tags - Optional tags to attach to this data point.
   */
  increment(value: number, timestamp: number, tags: Tags = {}): void {
    const redacted = this.omit(tags, this.exclude);
    const key = this.hashTags(redacted);
    const existing = this.series.get(key);
    const newValue = (existing ? existing.value : 0) + value;
    this.series.set(key, {
      tags: redacted,
      timestamp,
      value: newValue,
    });
  }
}

/**
 * A metric that represents an instantaneous numeric value that can go up or down,
 * such as memory usage or queue depth.
 */
class Gauge extends Metric<number, { value: number }> {
  /**
   * @param {MetricOptions} options - Metric configuration options.
   */
  constructor(options: MetricOptions) {
    super(options);
  }

  /**
   * Returns the stored numeric value as-is for aggregation.
   * @param {number} value - The raw stored gauge value.
   * @returns {number} The value unchanged.
   */
  extract(value: number): { value: number } {
    return { value };
  }

  /**
   * Records the current value of the gauge at the given timestamp.
   * @param {number} value - The instantaneous value to record.
   * @param {number} timestamp - Unix timestamp (ms) of the observation.
   * @param {Tags} tags - Optional tags to attach to this data point.
   */
  set(value: number, timestamp: number, tags: Tags = {}): void {
    const redacted = this.omit(tags, this.exclude);
    const key = this.hashTags(redacted);
    this.series.set(key, {
      tags: redacted,
      timestamp,
      value,
    });
  }
}

/**
 * A metric that tracks the statistical distribution of values over time,
 * exposing count, min, max, mean, and standard deviation.
 * Backed by Node's {@link https://nodejs.org/api/perf_hooks.html#class-recordablehistogram RecordableHistogram}.
 */
class Histogram extends Metric<RecordableHistogram, HistogramAggregate> {
  /**
   * @param {MetricOptions} options - Metric configuration options.
   */
  constructor(options: MetricOptions) {
    super(options);
  }

  /**
   * Extracts statistical aggregates from a {@link https://nodejs.org/api/perf_hooks.html#class-recordablehistogram RecordableHistogram}.
   * @param {RecordableHistogram} value - The underlying histogram instance.
   * @returns {HistogramAggregate} An object with count, min, max, mean, and stddev.
   */
  extract(value: RecordableHistogram): HistogramAggregate {
    return {
      count: value.count,
      min: value.min,
      max: value.max,
      mean: value.mean,
      stddev: value.stddev,
    };
  }

  /**
   * Records a single observed value into the histogram at the given timestamp.
   * @param {number} value - The observed value (e.g. latency in ms).
   * @param {number} timestamp - Unix timestamp (ms) of the observation.
   * @param {Tags} tags - Optional tags to attach to this data point.
   */
  record(value: number, timestamp: number, tags: Tags = {}): void {
    const redacted = this.omit(tags, this.exclude);
    const key = this.hashTags(redacted);
    let histogram = this.series.get(key)?.value;
    if (!histogram) {
      histogram = createHistogram();
    }
    histogram.record(value);
    this.series.set(key, {
      tags: redacted,
      timestamp,
      value: histogram,
    });
  }
}

export { Counter, Gauge, Histogram };
