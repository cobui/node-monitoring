import { MetricRef } from "./types";
import { getContext, getActiveNamespaces } from "./runtime/context";
import { emitWarning } from "./warnings";
import type { Tags } from "./types";

/**
 * Abstract base class for all sensor types.
 *
 * A sensor is the read-side companion to a {@link Recorder}: it holds a reference
 * to a registered metric (by URI and namespace) and exposes a domain-specific API
 * (e.g. `set`, `increment`, `record`) that internally resolves the metric and delegates
 * to the recorder. The `version` field allows sensors to detect stale cached refs
 * and re-resolve them without external coordination.
 *
 * **Namespace resolution:** if `namespace` is omitted and exactly one namespace is
 * active, the sensor resolves to it automatically. If multiple namespaces are active,
 * pass the namespace explicitly to disambiguate.
 */
export class SensorBase {
  /** Unique identifier used to look up the metric in the registry. */
  private uri: string;

  /**
   * Explicit namespace, if provided at creation time.
   * When `undefined`, the namespace is resolved dynamically from the active contexts.
   */
  private namespace: string | undefined;

  /** Cached metric reference, populated on first use and invalidated by version changes. */
  private cached?: MetricRef;

  /**
   * Monotonic version counter. A value of `-1` means the cache has never been
   * populated. When the registry version advances past this value, the cached
   * ref is considered stale and must be re-resolved.
   */
  private version: number;

  /** Ensures the "namespace not active / not found" warning fires at most once per sensor. */
  private warnedInactive = false;

  /** Ensures the "ambiguous namespace" warning fires at most once per sensor. */
  private warnedAmbiguous = false;

  /** Ensures the "metric not found" warning fires at most once per sensor. */
  private warnedMissing = false;

  /**
   * @param uri - Unique identifier for the metric this sensor observes.
   * @param namespace - Namespace that scopes the metric. When omitted, the sensor
   *   resolves to the single active namespace automatically. Pass explicitly when
   *   multiple namespaces are active.
   */
  constructor(uri: string, namespace?: string) {
    this.uri = uri;
    this.namespace = namespace;
    this.version = -1;
  }

  private resolveNamespace(): string | undefined {
    if (this.namespace !== undefined) return this.namespace;

    const active = getActiveNamespaces();

    if (active.length === 1) return active[0];

    if (active.length === 0) {
      if (!this.warnedInactive) {
        this.warnedInactive = true;
        emitWarning(
          "sensor:inactive",
          { uri: this.uri },
          `Sensor "${this.uri}" fired but no namespace has been started. ` +
            `Call monitoring.add([{ namespace: "...", ... }]) before using sensors.`,
        );
      }
      return undefined;
    }

    if (!this.warnedAmbiguous) {
      this.warnedAmbiguous = true;
      emitWarning(
        "sensor:ambiguous",
        { uri: this.uri, namespaces: active },
        `Sensor "${this.uri}" cannot resolve a namespace — multiple namespaces are active: ` +
          `[${active.join(", ")}]. Pass a namespace: Counter.create("${this.uri}", "<namespace>").`,
      );
    }
    return undefined;
  }

  protected withMetric<TType extends MetricRef["type"]>(
    type: TType,
    fn: (ref: Extract<MetricRef, { type: TType }>) => void,
  ): void {
    const ns = this.resolveNamespace();
    if (ns === undefined) return;

    const context = getContext(ns);

    if (!context.active) {
      if (this.version !== context.version) {
        this.cached = undefined;
        this.version = context.version;
      }
      if (!context.registry && !this.warnedInactive) {
        this.warnedInactive = true;
        emitWarning(
          "sensor:inactive",
          { uri: this.uri, namespace: ns },
          `Sensor "${this.uri}" fired but namespace "${ns}" has never been started. ` +
            `Call monitoring.add([{ namespace: "${ns}", ... }]) before using sensors.`,
        );
      }
      return;
    }

    if (!this.cached || this.version !== context.version) {
      this.cached = context.registry!.get(this.uri);
      this.version = context.version;
    }

    const metric = this.cached;
    if (!metric || metric.type !== type) {
      if (!this.warnedMissing && !metric) {
        this.warnedMissing = true;
        emitWarning(
          "sensor:not-found",
          { uri: this.uri, namespace: ns, type },
          `Sensor fired but metric "${this.uri}" is not registered in namespace "${ns}". ` +
            `Add { uri: "${this.uri}", type: "${type}", interval: <ms> } to your metrics config.`,
        );
      }
      return;
    }

    if (!metric.enabled) return;

    fn(metric as Extract<MetricRef, { type: TType }>);
  }
}

/**
 * Sensor for incrementing a `counter` metric.
 *
 * Use `Counter` to count discrete events such as HTTP requests, errors, or cache hits.
 *
 * @example
 * // Single-namespace app — namespace auto-resolved
 * const errors = Counter.create("http.errors");
 * errors.increment(1, { route: "/api/users" });
 *
 * // Multi-namespace app — pass namespace to disambiguate
 * const errors = Counter.create("http.errors", "app");
 */
export class Counter extends SensorBase {
  /**
   * Creates a new `Counter` bound to the given URI.
   * @param uri - Unique identifier for the counter metric in the registry.
   * @param namespace - Namespace that scopes the metric. Omit when only one namespace is active.
   */
  static create(uri: string, namespace?: string): Counter {
    return new Counter(uri, namespace);
  }

  private constructor(uri: string, namespace?: string) {
    super(uri, namespace);
  }

  /**
   * Increments the counter.
   * @param valueOrTags - The amount to increment by (defaults to `1`), or tags if incrementing by 1.
   * @param tags - Optional tags to attach to this data point.
   */
  increment(valueOrTags?: number | Tags, tags?: Tags): void {
    const value = typeof valueOrTags === "number" ? valueOrTags : 1;
    const resolvedTags = typeof valueOrTags === "object" ? valueOrTags : tags;
    this.withMetric("counter", (ref) => {
      ref.metric.increment(value, Date.now(), resolvedTags);
    });
  }
}

/**
 * Sensor for recording instantaneous numeric values against a `gauge` metric.
 *
 * Use `Gauge` to observe values that can go up or down over time,
 * such as memory usage, queue depth, or active connection counts.
 *
 * @example
 * const memory = Gauge.create("process.memory");
 * memory.set(process.memoryUsage().heapUsed);
 */
export class Gauge extends SensorBase {
  /**
   * Creates a new `Gauge` bound to the given URI.
   * @param uri - Unique identifier for the gauge metric in the registry.
   * @param namespace - Namespace that scopes the metric. Omit when only one namespace is active.
   */
  static create(uri: string, namespace?: string): Gauge {
    return new Gauge(uri, namespace);
  }

  private constructor(uri: string, namespace?: string) {
    super(uri, namespace);
  }

  /**
   * Records the current value of the gauge.
   * @param value - The instantaneous value to record.
   * @param tags - Optional tags to attach to this data point.
   */
  set(value: number, tags?: Tags): void {
    this.withMetric("gauge", (ref) => {
      ref.metric.set(value, Date.now(), tags);
    });
  }
}

/**
 * Sensor for recording observations into a `histogram` metric.
 *
 * Use `Histogram` to track the statistical distribution of values over time,
 * such as request latencies, payload sizes, or processing durations.
 *
 * @example
 * const latency = Histogram.create("http.latency");
 * latency.record(42, { route: "/api/users", method: "GET" });
 */
export class Histogram extends SensorBase {
  /**
   * Creates a new `Histogram` bound to the given URI.
   * @param uri - Unique identifier for the histogram metric in the registry.
   * @param namespace - Namespace that scopes the metric. Omit when only one namespace is active.
   */
  static create(uri: string, namespace?: string): Histogram {
    return new Histogram(uri, namespace);
  }

  private constructor(uri: string, namespace?: string) {
    super(uri, namespace);
  }

  /**
   * Records a single observed value into the histogram.
   * @param value - The observed value (e.g. duration in ms, size in bytes).
   * @param tags - Optional tags to attach to this data point.
   */
  record(value: number, tags?: Tags): void {
    this.withMetric("histogram", (ref) => {
      ref.metric.record(value, Date.now(), tags);
    });
  }
}
