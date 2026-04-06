import type { CounterMetricRef, GaugeMetricRef, HistogramMetricRef, MetricRef, Tags } from "../types";

/**
 * Responsible for recording metric data points against registered metric references.
 * Acts as the write-side entry point: callers hold a {@link MetricRef}
 * and pass it here rather than calling the metric directly, allowing the recorder
 * to handle timestamping and gate recording on the `enabled` flag.
 */
export class Recorder {
  /**
   * @param {() => number} now - Clock function that returns the current time in milliseconds.
   *   Defaults to `Date.now`. Override in tests to control time.
   */
  constructor(private readonly now: () => number = () => Date.now()) {}

  /**
   * Increments a counter metric by the given delta.
   * @param {CounterMetricRef} ref - Reference to the counter metric to update.
   * @param {number} delta - Amount to increment by. Defaults to `1`.
   * @param {Tags} tags - Additional tags to attach to this data point.
   */
  increment(ref: CounterMetricRef, delta = 1, tags?: Tags): void {
    ref.metric.increment(delta, this.now(), tags);
  }

  /**
   * Sets a gauge metric to the given value.
   * @param {GaugeMetricRef} ref - Reference to the gauge metric to update.
   * @param {number} value - The new instantaneous value.
   * @param {Tags} tags - Additional tags to attach to this data point.
   */
  set(ref: GaugeMetricRef, value: number, tags?: Tags): void {
    ref.metric.set(value, this.now(), tags);
  }

  /**
   * Records a single observation into a histogram metric.
   * @param {HistogramMetricRef} ref - Reference to the histogram metric to update.
   * @param {number} value - The observed value (e.g. duration in ms).
   * @param {Tags} tags - Additional tags to attach to this data point.
   */
  record(ref: HistogramMetricRef, value: number, tags?: Tags): void {
    ref.metric.record(value, this.now(), tags);
  }
}
