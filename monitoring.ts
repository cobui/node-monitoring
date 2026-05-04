import { Monitor } from "./monitor";
import { getContext, isNamespaceOwned } from "./runtime/context";
import type { MonitorConfig } from "./monitor";

/**
 * Top-level entry point for the monitoring system.
 *
 * Holds a collection of {@link Monitor} instances, each scoped to its own
 * namespace and transporter. Provides namespace-level enable/disable control
 * and bulk lifecycle operations.
 *
 * Each namespace has a configured *intent* (enabled or disabled) that is set
 * at `add()` time and updated via `setEnabled()`. The live runtime state is
 * always derivable from `isNamespaceEnabled()`, which reads the context's `active`
 * flag directly — the context is the single source of truth for whether a
 * namespace is currently running.
 *
 * @example
 * ```ts
 * const monitoring = new Monitoring();
 *
 * monitoring.add([
 *   { namespace: "app",   transporter: new Influx(),  metrics: [...] },
 *   { namespace: "debug", transporter: new StatsD(),  enabled: false },
 * ]);
 *
 * // "app" is already running; "debug" is not
 * monitoring.isNamespaceEnabled("app");   // true
 * monitoring.isNamespaceEnabled("debug"); // false
 *
 * monitoring.setEnabled("debug", true);  // starts "debug"
 * monitoring.setEnabled("app", false);   // stops "app"
 *
 * monitoring.stop();    // pauses all running namespaces
 * monitoring.start();   // restarts all configured-enabled namespaces
 *
 * monitoring.destroy();
 * ```
 */
export class Monitoring {
  private readonly monitors = new Map<string, Monitor>();
  /** Configured intent per namespace — survives stop/start cycles. */
  private readonly intents = new Map<string, boolean>();

  /**
   * Creates a {@link Monitor} for each config and registers it.
   * If `config.enabled` is `true` (the default), the monitor is started immediately.
   * Pairs naturally with {@link loadConfig}:
   * ```ts
   * monitoring.add(loadConfig("monitoring.config.yml"));
   * ```
   *
   * **Each namespace may only be active once per process.** Attempting to register a
   * namespace that is already owned by another Monitor — whether in this instance or
   * a separate `Monitoring` instance — throws an error. This constraint is per-process:
   * separate processes (cron jobs, separate containers) have independent memory and are
   * unaffected. Note that cluster workers are separate processes but share the same
   * transporter key space via IPC — the primary must have a Monitor registered with a
   * matching transporter key for worker aggregates to be delivered.
   *
   * @param configs - Array of monitor configurations to register.
   * @throws If any namespace in `configs` is already active in this process.
   */
  add(configs: MonitorConfig[]): void {
    for (const config of configs) {
      if (isNamespaceOwned(config.namespace)) {
        throw new Error(
          `[node-monitoring] Namespace "${config.namespace}" is already active in this process. Each namespace may only be owned by one Monitor at a time.`,
        );
      }
      const monitor = new Monitor(config);
      const enabled = config.enabled ?? true;
      this.monitors.set(config.namespace, monitor);
      this.intents.set(config.namespace, enabled);
      if (enabled) monitor.start();
    }
  }

  /**
   * Returns whether the given namespace is currenttly active.
   * Reads the live context state — the context is the authoritative source of truth.
   * @param namespace - The namespace to check.
   */
  isNamespaceEnabled(namespace: string): boolean {
    return getContext(namespace).active;
  }

  /**
   * Enables or disables a namespace at runtime.
   * Enabling starts the monitor (if not already running); disabling stops it.
   * The new state is persisted as the namespace's configured intent, so a
   * subsequent `start()` call will respect it.
   *
   * @param namespace - The namespace to update.
   * @param enabled - `true` to enable and start, `false` to stop and disable.
   */
  setNamespaceEnabled(namespace: string, enabled: boolean): void {
    const monitor = this.monitors.get(namespace);
    if (!monitor) return;
    this.intents.set(namespace, enabled);
    if (enabled) monitor.start();
    else monitor.stop();
  }

  /**
   * Enables or disables a single metric within a namespace at runtime.
   * @param namespace - The namespace that owns the metric.
   * @param uri - The unique identifier of the metric to update.
   * @param enabled - `true` to enable, `false` to disable.
   */
  setMetricEnabled(namespace: string, uri: string, enabled: boolean): void {
    this.monitors.get(namespace)?.setMetricEnabled(uri, enabled);
  }

  /**
   * Changes the collection interval for a metric within a namespace at runtime.
   * @param namespace - The namespace that owns the metric.
   * @param uri - The unique identifier of the metric to reschedule.
   * @param newInterval - The new collection interval in milliseconds.
   */
  reschedule(namespace: string, uri: string, newInterval: number): void {
    this.monitors.get(namespace)?.rescheduleMetric(uri, newInterval);
  }

  /**
   * Starts all namespaces whose configured intent is enabled.
   * If a namespace is given, starts only that namespace (if its intent is enabled).
   * Namespaces explicitly disabled via `setEnabled(ns, false)` are not affected.
   * @param namespace - Optional namespace to start. When omitted, starts all enabled namespaces.
   */
  start(namespace?: string): void {
    if (namespace !== undefined) {
      if (this.intents.get(namespace)) this.monitors.get(namespace)?.start();
      return;
    }
    for (const [ns, monitor] of this.monitors) {
      if (this.intents.get(ns)) monitor.start();
    }
  }

  /**
   * Performs an immediate one-shot collection pass and waits for all in-flight
   * data to be sent. The Promise resolves only after every item has been sent
   * (or exhausted its retries), so no data is silently dropped when the process
   * terminates.
   *
   * `flush()` alone does **not** close all handles. Always follow
   * `await flush()` with `destroy()` before exiting to release all timers and
   * event listeners.
   *
   * **Process exit caveats:**
   * - `process.on("exit", handler)` — synchronous; async operations are
   *   abandoned. Use an async `main()` and call `process.exit(0)` explicitly.
   * - `process.on("SIGTERM"/"SIGINT", handler)` — can be `async`, but requires
   *   an explicit `process.exit(0)` call at the end of the handler.
   *
   * @param namespace - Optional namespace to flush. When omitted, flushes all.
   */
  async flush(namespace?: string): Promise<void> {
    if (namespace !== undefined) {
      await this.monitors.get(namespace)?.flush();
      return;
    }
    await Promise.all([...this.monitors.values()].map((m) => m.flush()));
  }

  /**
   * Pauses currently running namespaces without changing their configured intent.
   * A subsequent `start()` will restart all namespaces that were enabled before `stop()`.
   * If a namespace is given, stops only that namespace.
   * @param namespace - Optional namespace to stop. When omitted, stops all.
   */
  stop(namespace?: string): void {
    if (namespace !== undefined) {
      this.monitors.get(namespace)?.stop();
      return;
    }
    for (const monitor of this.monitors.values()) monitor.stop();
  }

  /**
   * Destroys one or all monitors and removes them from internal state.
   * If a namespace is given, only that monitor is destroyed; otherwise all
   * monitors are destroyed and the Monitoring instance should not be used again.
   * @param namespace - Optional namespace to destroy. When omitted, destroys all.
   */
  destroy(namespace?: string): void {
    if (namespace !== undefined) {
      this.monitors.get(namespace)?.destroy();
      this.monitors.delete(namespace);
      this.intents.delete(namespace);
      return;
    }
    for (const monitor of this.monitors.values()) monitor.destroy();
    this.monitors.clear();
    this.intents.clear();
  }
}
