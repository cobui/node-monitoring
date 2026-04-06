import type { MetricConfig, RegisteredMetric } from "./types";
import { Counter, Gauge, Histogram } from "./metric";
import { bumpVersion } from "./runtime/context";

/**
 * Central store for all metrics within a namespace.
 *
 * The `Registry` holds the lifecycle of every metric: it creates metric instances
 * from {@link MetricConfig} descriptors, stores them as {@link RegisteredMetric} references,
 * and exposes lookup and control APIs used by sensors and the runtime collector.
 *
 * Each mutating operation (register, setEnabled) bumps an internal version counter,
 * which sensors use to detect stale cached refs and re-resolve them.
 */
export class Registry {
  /** Namespace that scopes all metrics registered here. */
  private readonly namespace: string;

  /** Internal store mapping URI to registered metric ref. */
  private readonly metrics = new Map<string, RegisteredMetric>();

  /**
   * @param namespace - Namespace prefix applied to all metrics in this registry.
   */
  constructor(namespace: string) {
    this.namespace = namespace;
  }

  /**
   * Creates metric instances from the given config descriptors and stores them.
   * Metrics with a URI that is already registered are ignored or replaced.
   * Bumps the version counter after registration.
   * @param metrics - Array of metric configuration descriptors to register.
   */
  register(metrics: MetricConfig[]): void {
    if (metrics.length === 0) return;

    for (const { type, tags, exclude, cache, uri, enabled, reset, interval } of metrics) {
      if (!Number.isInteger(interval) || interval <= 0) {
        throw new Error(
          `[node-monitoring] Metric "${uri}" has invalid interval: ${interval}. ` +
            `interval must be a positive integer (milliseconds).`,
        );
      }

      if (this.metrics.has(uri)) {
        console.warn(
          `[node-monitoring] Metric "${uri}" is already registered in namespace "${this.namespace}" and will be overwritten. ` +
            `Any data recorded since the last collection cycle will be lost.`,
        );
      }

      // Default reset: true for counter/histogram (rates), false for gauge (current value)
      const resolvedReset = reset ?? (type === "gauge" ? false : true);
      switch (type) {
        case "counter":
          this.metrics.set(uri, {
            uri,
            enabled: enabled ?? true,
            type,
            reset: resolvedReset,
            interval,
            metric: new Counter({ tags, exclude, cache }),
          });
          break;
        case "gauge":
          this.metrics.set(uri, {
            uri,
            enabled: enabled ?? true,
            type,
            reset: resolvedReset,
            interval,
            metric: new Gauge({ tags, exclude, cache }),
          });
          break;
        case "histogram":
          this.metrics.set(uri, {
            uri,
            enabled: enabled ?? true,
            type,
            reset: resolvedReset,
            interval,
            metric: new Histogram({ tags, exclude, cache }),
          });
          break;
      }
      bumpVersion(this.namespace);
    }
  }

  /**
   * Looks up a registered metric by URI.
   * @param uri - The unique identifier of the metric to retrieve.
   * @returns The {@link RegisteredMetric} if found, or `undefined` if not registered.
   */
  get(uri: string): RegisteredMetric | undefined {
    return this.metrics.get(uri);
  }

  /**
   * Returns all registered metrics as an array.
   * @returns All {@link RegisteredMetric} entries currently in the registry.
   */
  values(): MapIterator<RegisteredMetric> {
    return this.metrics.values();
  }

  /**
   * Enables or disables a metric by URI.
   * Disabled metrics are skipped by the recorder and excluded from collection.
   * Bumps the version counter so sensors can detect the change.
   * @param uri - The unique identifier of the metric to update.
   * @param enabled - `true` to enable, `false` to disable.
   */
  setEnabled(uri: string, enabled: boolean): void {
    const ref = this.metrics.get(uri);
    if (ref) ref.enabled = enabled;
    bumpVersion(this.namespace);
  }

  /**
   * Resets all metrics.
   * Less aggressive than {@link Registry.destroy} — the registry remains usable afterwards.
   */
  cleanup(): void {
    for (const { metric } of this.metrics.values()) {
      metric.reset();
    }
  }

  /**
   * Removes all registered metrics and releases all resources held by the registry.
   * The registry should not be used after calling this method.
   */
  destroy(): void {
    this.cleanup();
    this.metrics.clear();
    bumpVersion(this.namespace);
  }
}
