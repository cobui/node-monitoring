import { Registry } from "./registry";
import type { AggregateSink, Tags } from "./types";

export class Collector {
  private readonly namespaceTags: Tags;
  private readonly registry: Registry;
  private readonly sink: AggregateSink;
  private readonly timers = new Map<number, NodeJS.Timeout>();
  private readonly intervalGroups = new Map<number, Set<string>>();
  private isRunning = false;

  constructor(namespaceTags: Tags, registry: Registry, sink: AggregateSink) {
    this.registry = registry;
    this.sink = sink;
    this.namespaceTags = namespaceTags;

    for (const { uri, interval } of this.registry.values()) {
      if (!this.intervalGroups.has(interval)) {
        this.intervalGroups.set(interval, new Set());
      }
      this.intervalGroups.get(interval)!.add(uri);
    }
  }

  start(): void {
    this.stopTimers();
    for (const [interval, uris] of this.intervalGroups.entries()) {
      const timer = setInterval(() => void this.collect([...uris]), interval);
      this.timers.set(interval, timer);
    }
    this.isRunning = true;
  }

  stop(): void {
    this.stopTimers();
    this.isRunning = false;
  }

  destroy(): void {
    this.stopTimers();
    this.intervalGroups.clear();
    this.isRunning = false;
  }

  reschedule(uri: string, newInterval: number): void {
    const ref = this.registry.get(uri);
    if (!ref || ref.interval === newInterval) return;

    const oldInterval = ref.interval;
    const oldGroup = this.intervalGroups.get(oldInterval);
    if (oldGroup) {
      oldGroup.delete(uri);
      if (oldGroup.size === 0) {
        const timer = this.timers.get(oldInterval);
        if (timer) clearInterval(timer);
        this.timers.delete(oldInterval);
        this.intervalGroups.delete(oldInterval);
      }
    }

    if (!this.intervalGroups.has(newInterval)) {
      this.intervalGroups.set(newInterval, new Set());
    }
    const newGroup = this.intervalGroups.get(newInterval)!;
    newGroup.add(uri);
    ref.interval = newInterval;

    if (this.isRunning && !this.timers.has(newInterval)) {
      const timer = setInterval(() => void this.collect([...newGroup]), newInterval);
      this.timers.set(newInterval, timer);
    }
  }

  private stopTimers(): void {
    for (const timer of this.timers.values()) {
      clearInterval(timer);
    }
    this.timers.clear();
  }

  /**
   * Performs a single immediate collection pass for all registered metrics,
   * regardless of their scheduled interval. Useful for flushing data before
   * process exit.
   */
  async flush(): Promise<void> {
    const allUris = [...this.intervalGroups.values()].flatMap((s) => [...s]);
    await this.collect(allUris);
  }

  private async collect(uris: string[]): Promise<void> {
    for (const uri of uris) {
      const ref = this.registry.get(uri);
      if (!ref || !ref.enabled) continue;

      const aggregates = ref.metric.aggregate();
      if (ref.reset) ref.metric.reset();

      for (const aggregate of aggregates) {
        const merged = { ...this.namespaceTags, ...aggregate.tags, uri };
        this.sink.enqueue({
          ...aggregate,
          tags: Object.fromEntries(Object.entries(merged).sort(([a], [b]) => a.localeCompare(b))),
        });
      }
    }
  }
}
