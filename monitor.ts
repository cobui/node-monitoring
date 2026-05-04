import cluster from "node:cluster";
import { Registry } from "./registry";
import { Collector } from "./collector";
import { acquireQueue, acquireQueueByRef, releaseQueue } from "./transport/queues";
import { TransportQueue } from "./transport/queue";
import { WorkerSender } from "./transport/sender";
import { activateListener, deactivateListener } from "./transport/listener";
import { createTransporter, isTransporterRef } from "./transport/factory";
import { activateContext, deactivateContext, destroyContext } from "./runtime/context";
import type { Transporter } from "./transport/base";
import type { TransporterConfig } from "./transport/factory";
import type { MetricConfig, Tags, AggregateSink } from "./types";

export type MonitorConfig = {
  /** Namespace that scopes all metrics, context, and sensor lookups for this monitor. */
  namespace: string;
  /** Tags merged into every aggregate emitted by this monitor's collector. */
  tags?: Tags;
  /** Metrics to register at construction time. More can be added later via {@link Monitor#register}. */
  metrics?: MetricConfig[];
  /**
   * Transporter configuration. The monitor instantiates the correct transporter
   * internally — pass a plain config object (e.g. parsed from YAML) rather than
   * a class instance.
   */
  transporter: TransporterConfig;
  /**
   * Whether this namespace starts enabled. Defaults to `true`.
   * When `false`, the monitor is constructed but not started — activate it
   * later via {@link Monitoring#setEnabled}.
   */
  enabled?: boolean;
};

/**
 * Owns one namespace/transporter pair.
 * Creates and wires together the Registry, Recorder, Collector, and transport
 * sink for a single monitoring namespace. Lifecycle is managed via
 * {@link Monitor#start}, {@link Monitor#stop}, and {@link Monitor#destroy}.
 *
 * On the primary process, the transport sink is a rate-limited
 * {@link TransportQueue} drawn from the singleton queue registry — shared
 * across all Monitors that reference the same transporter key, ensuring the
 * declared rate limit is honoured even when multiple namespaces share a
 * transporter.
 *
 * On worker processes, the transport sink is a {@link WorkerSender} that
 * forwards aggregates to the primary via IPC.
 *
 * Sensors (`Counter`, `Gauge`, `Histogram`) are independent — create them
 * anywhere via their static `create(uri, namespace)` factories without
 * holding a Monitor reference.
 */
export class Monitor {
  private readonly namespace: string;
  private readonly transporter: Transporter;
  private readonly registry: Registry;
  private readonly collector: Collector;
  private readonly sink: AggregateSink;

  constructor({ namespace, tags = {}, metrics = [], transporter: transporterConfig }: MonitorConfig) {
    this.namespace = namespace;

    if (isTransporterRef(transporterConfig)) {
      this.transporter = { key: transporterConfig.key } as Transporter;
      this.sink = cluster.isWorker ? new WorkerSender(transporterConfig.key) : acquireQueueByRef(transporterConfig.key);
    } else {
      this.transporter = createTransporter(transporterConfig);
      this.sink = cluster.isWorker ? new WorkerSender(this.transporter.key) : acquireQueue(this.transporter);
    }

    this.registry = new Registry(namespace);
    if (metrics.length) this.registry.register(metrics);
    this.collector = new Collector({ namespace, ...tags }, this.registry, this.sink);
  }

  /**
   * Activates the monitoring context for this namespace, attaches the IPC
   * listener on the cluster primary (if applicable), and starts the metric
   * collection timers. Safe to call multiple times — subsequent calls clear
   * and restart the collection timers without duplicating listeners or contexts.
   */
  start(): void {
    activateContext(this.namespace, this.registry);
    if (!cluster.isWorker) activateListener();
    this.collector.start();
  }

  /**
   * Pauses collection and deactivates the monitoring context while keeping the
   * registry and recorder in place. A subsequent {@link Monitor#start} will
   * resume without re-registering metrics.
   */
  stop(): void {
    this.collector.stop();
    deactivateContext(this.namespace, false);
  }

  /**
   * Stops collection, releases the transport queue (primary) or discards the
   * worker sender, clears the registry, and removes the context from the
   * runtime map. The monitor should not be used after this call.
   */
  destroy(): void {
    this.collector.destroy();
    if (!cluster.isWorker) {
      deactivateListener();
      releaseQueue(this.transporter.key);
    }
    this.registry.destroy();
    deactivateContext(this.namespace, true);
    destroyContext(this.namespace);
  }

  /**
   * Collects all metrics immediately and waits for the transport queue to
   * finish sending them. The Promise resolves only after every item has been
   * sent (or exhausted its retries), so no data is silently dropped when the
   * process terminates.
   *
   * `flush()` alone does **not** close all handles — the loss-reporting timer
   * inside the transport queue remains active until {@link Monitor#destroy} is
   * called. Always follow `await flush()` with `destroy()` before exiting.
   *
   * **Process exit caveats:**
   * - `process.on("exit", handler)` — the exit event is synchronous; any
   *   async operation started inside it is abandoned. Place `await flush()` in
   *   your async `main()` function and call `process.exit(0)` explicitly after
   *   `destroy()`.
   * - `process.on("SIGTERM"/"SIGINT", handler)` — the handler can be `async`
   *   and `await flush()` will work, but only if you call `process.exit(0)` at
   *   the end of the handler. Without an explicit exit call the process will
   *   not terminate.
   */
  async flush(): Promise<void> {
    await this.collector.flush();
    if (this.sink instanceof TransportQueue) {
      await this.sink.drainAll();
    }
  }

  /**
   * Enables or disables a metric by URI at runtime.
   * @param uri - The unique identifier of the metric to update.
   * @param enabled - `true` to enable, `false` to disable.
   */
  setMetricEnabled(uri: string, enabled: boolean): void {
    this.registry.setEnabled(uri, enabled);
  }

  /**
   * Changes the collection interval for a metric at runtime.
   * @param uri - The unique identifier of the metric to reschedule.
   * @param newInterval - The new collection interval in milliseconds.
   */
  rescheduleMetric(uri: string, newInterval: number): void {
    this.collector.reschedule(uri, newInterval);
  }
}
