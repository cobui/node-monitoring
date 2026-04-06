import type { Aggregate } from "../types";
import type { Transporter } from "./base";
import { emitWarning } from "../warnings";

export type TransportMessage = {
  type: "monitoring:transport";
  key: string;
  data: Aggregate<unknown>;
};

export function isTransportMessage(msg: unknown): msg is TransportMessage {
  return (
    typeof msg === "object" &&
    msg !== null &&
    (msg as TransportMessage).type === "monitoring:transport" &&
    typeof (msg as TransportMessage).key === "string" &&
    (msg as TransportMessage).data !== undefined
  );
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export class TransportQueue {
  private readonly priorityQueue: Aggregate<unknown>[] = [];
  private readonly normalQueue: Aggregate<unknown>[] = [];
  private drainTimer: NodeJS.Timeout | null = null;
  private readonly intervalMs: number;
  private readonly batchSize: number;

  private readonly lossAccumulator = new Map<string, number>();
  private lossTimer: NodeJS.Timeout | null = null;

  constructor(private readonly transporter: Transporter) {
    if (!Number.isFinite(transporter.rateLimit) || transporter.rateLimit <= 0) {
      throw new Error(
        `[node-monitoring] Transporter "${transporter.key}" has invalid rateLimit: ${transporter.rateLimit}. ` +
          `rateLimit must be a positive number (aggregates per second).`,
      );
    }
    this.intervalMs = Math.ceil(1000 / transporter.rateLimit);
    this.batchSize = transporter.queue.batchSize ?? 500;
  }

  enqueue(data: Aggregate<unknown>): void {
    const max = this.transporter.queue.maxSize ?? Infinity;
    if (this.normalQueue.length >= max) {
      this.recordLoss(data);
      return;
    }
    this.normalQueue.push(data);
    this.scheduleDrain();
  }

  private scheduleDrain(): void {
    if (this.drainTimer !== null) return;
    this.drainTimer = setTimeout(() => void this.drain(), this.intervalMs);
  }

  private async drain(): Promise<void> {
    this.drainTimer = null;
    const batch = this.dequeueUpTo(this.batchSize);
    if (batch.length === 0) return;

    await this.dispatchBatch(batch);

    if (this.priorityQueue.length + this.normalQueue.length > 0) this.scheduleDrain();
  }

  /**
   * Sends all queued items immediately, bypassing the rate-limit timer.
   * Call this after {@link enqueue} when the process is about to exit — e.g.
   * in a cron job or short-lived worker — to ensure no data is lost.
   */
  async drainAll(): Promise<void> {
    if (this.drainTimer) {
      clearTimeout(this.drainTimer);
      this.drainTimer = null;
    }
    while (this.priorityQueue.length + this.normalQueue.length > 0) {
      await this.dispatchBatch(this.dequeueUpTo(this.batchSize));
    }
  }

  /** Collects up to `n` items from the queues (priority first, then normal). */
  private dequeueUpTo(n: number): Aggregate<unknown>[] {
    const batch: Aggregate<unknown>[] = [];
    while (batch.length < n) {
      const item = this.priorityQueue.shift() ?? this.normalQueue.shift();
      if (!item) break;
      batch.push(item);
    }
    return batch;
  }

  /**
   * Sends a batch as one transporter call. Retries the whole batch as a unit
   * (matches InfluxDB's all-or-nothing write semantics). On total failure,
   * each item is recorded individually as lost.
   */
  private async dispatchBatch(batch: Aggregate<unknown>[]): Promise<void> {
    const { retries = 3 } = this.transporter.retry;
    let lastError: unknown;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        await this.transporter.send(batch);
        return;
      } catch (error) {
        lastError = error;
        if (attempt < retries) await sleep(this.backoffDelay(attempt));
      }
    }
    const message = lastError instanceof Error ? lastError.message : String(lastError);
    emitWarning(
      "transport:loss",
      { key: this.transporter.key, count: batch.length, attempts: retries + 1, cause: lastError },
      `Dropping ${batch.length} aggregate(s) for transporter "${this.transporter.key}" after ${retries + 1} failed attempt(s). Cause: ${message}`,
    );
    for (const item of batch) this.recordLoss(item);
  }

  private backoffDelay(attempt: number): number {
    const { minTimeout = 1_000, maxTimeout = 30_000, factor = 2 } = this.transporter.retry;
    return Math.min(minTimeout * Math.pow(factor, attempt), maxTimeout);
  }

  private recordLoss(item: Aggregate<unknown>): void {
    const ns = String(item.tags.namespace ?? "unknown");
    this.lossAccumulator.set(ns, (this.lossAccumulator.get(ns) ?? 0) + 1);
    this.scheduleLossFlush();
  }

  private scheduleLossFlush(): void {
    if (this.lossTimer !== null) return;
    const interval = this.transporter.queue.lossInterval ?? 300_000;
    this.lossTimer = setInterval(() => this.flushLosses(), interval);
  }

  private flushLosses(): void {
    if (this.lossAccumulator.size === 0) return;
    const now = Date.now();
    for (const [namespace, count] of this.lossAccumulator) {
      this.priorityQueue.push({
        tags: { namespace, metric: "monitoring.loss" },
        value: count,
        timestamp: now,
      });
    }
    this.lossAccumulator.clear();
    this.scheduleDrain();
  }

  destroy(): void {
    if (this.drainTimer) {
      clearTimeout(this.drainTimer);
      this.drainTimer = null;
    }
    if (this.lossTimer) {
      clearInterval(this.lossTimer);
      this.lossTimer = null;
    }
    this.priorityQueue.length = 0;
    this.normalQueue.length = 0;
    this.lossAccumulator.clear();
  }
}
