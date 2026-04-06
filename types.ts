import { Gauge, Counter, Histogram } from "./metric";
import { Recorder } from "./runtime/recorder";
import { Registry } from "./registry";
/**
 * A set of key-value pairs attached to a metric data point for filtering and grouping.
 * Keys are strings; values may be strings, numbers, or booleans.
 */
export type Tags = Record<string, string | number | boolean>;

/**
 * A single recorded data point in the series cache.
 * @template T - The type of the stored value.
 */
export type Entry<T> = { tags: Tags; timestamp: number; value: T };

/**
 * An aggregated metric data point ready for export or querying.
 * @template T - The type of the aggregated value.
 */
export type Aggregate<T> = {
  tags: Tags;
  value: T;
  timestamp: number;
};

/**
 * Statistical summary produced by a {@link Histogram} aggregation.
 */
export type HistogramAggregate = {
  /** Total number of recorded observations. */
  count: number;
  /** Minimum observed value. */
  min: number;
  /** Maximum observed value. */
  max: number;
  /** Arithmetic mean of all observations. */
  mean: number;
  /** Standard deviation of all observations. */
  stddev: number;
};

/**
 * Configuration options passed to a metric constructor.
 */
export type MetricOptions = {
  /** Default tags applied to every data point recorded on this metric. */
  tags?: Tags;
  /** Tag keys to strip before hashing (e.g. high-cardinality keys). */
  exclude?: string[];
  /** LRU cache configuration. `max` sets the maximum number of entries retained. */
  cache?: { max?: number };
};

export type MetricType = "counter" | "gauge" | "histogram";
export type MetricInstance = Counter | Gauge | Histogram;

/**
 * Base shape for all metric references.
 * @template TType - The metric type discriminant.
 * @template TMetric - The underlying metric instance type.
 */
export type BaseMetricRef<TType extends MetricType, TMetric extends MetricInstance> = {
  /** Unique identifier for this metric reference. */
  uri: string;
  /** The metric type discriminant. */
  type: TType;
  /** When `false`, the recorder skips recording for this ref. */
  enabled: boolean;
  /** The underlying metric instance. */
  metric: TMetric;
};

/** A metric reference pointing to a {@link Counter} instance. */
export type CounterMetricRef = BaseMetricRef<"counter", Counter>;

/** A metric reference pointing to a {@link Gauge} instance. */
export type GaugeMetricRef = BaseMetricRef<"gauge", Gauge>;

/** A metric reference pointing to a {@link Histogram} instance. */
export type HistogramMetricRef = BaseMetricRef<"histogram", Histogram>;

/** A union type for all metric references. */
export type MetricRef = CounterMetricRef | GaugeMetricRef | HistogramMetricRef;
/** LRU cache sizing options for a metric's series store. */
export type CacheConfig = {
  /** Maximum number of data points to retain. Defaults to a sensible value when omitted. */
  max?: number;
};

/**
 * Descriptor used to register a metric with a {@link Registry}.
 * Defines the metric's identity, type, collection schedule, and default behaviour.
 */
export type MetricConfig = {
  /** The metric type — determines which class is instantiated. */
  type: MetricType;
  /** Unique identifier used to look up and reference the metric. */
  uri: string;
  /** Collection interval in milliseconds. */
  interval: number;
  /** Optional LRU cache sizing. Falls back to a default when omitted. */
  cache?: CacheConfig;
  /**
   * When `true`, the metric's series is cleared after each collection cycle.
   * Defaults: `true` for `counter` and `histogram`, `false` for `gauge`.
   */
  reset?: boolean;
  /** Whether the metric starts enabled. Defaults to `true`. */
  enabled?: boolean;
  /** Default tags applied to every data point. */
  tags?: Tags;
  /** Tag keys to strip before hashing (e.g. high-cardinality keys). */
  exclude?: string[];
};

/**
 * Runtime state shared between the registry, recorder, and sensors.
 * Passed through the active context to give components access to the
 * current registry and recorder without direct coupling.
 */
export type Context = {
  /** Whether the monitoring runtime is currently active. */
  active: boolean;
  /** Monotonic version counter — incremented on every registry mutation. */
  version: number;
  /** The active registry, if the runtime has been initialised. */
  registry?: Registry;
  /** The active recorder, if the runtime has been initialised. */
  recorder?: Recorder;
};

/**
 * A fully registered metric ref, extending {@link MetricRef} with
 * collection scheduling and reset behaviour.
 */
/**
 * Minimal interface for anything that can receive aggregated data points.
 * Implemented by {@link TransportQueue} on the primary and {@link WorkerSender} on workers.
 */
export type AggregateSink = { enqueue(data: Aggregate<unknown>): void };

export type RegisteredMetric = MetricRef & {
  /** Collection interval in milliseconds. */
  interval: number;
  /** When `true`, the metric's series is cleared after each collection cycle. */
  reset: boolean;
};
