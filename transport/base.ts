import type { Aggregate } from "../types";

/**
 * Retry strategy for a transporter. All fields are optional and fall back to
 * sensible defaults inside `TransportQueue`.
 */
export type RetryConfig = {
  /** Maximum number of retry attempts after the initial send. Default: 3. */
  retries?: number;
  /** Milliseconds to wait before the first retry. Default: 1 000. */
  minTimeout?: number;
  /** Upper bound on the backoff delay in milliseconds. Default: 30 000. */
  maxTimeout?: number;
  /** Exponential base applied to each successive retry. Default: 2. */
  factor?: number;
};

/**
 * Buffering and loss-reporting configuration for the transport queue.
 */
export type QueueConfig = {
  /** Maximum number of items held in the normal queue. Default: `Infinity`. */
  maxSize?: number;
  /**
   * Milliseconds between loss-record flushes. Lost items (overflow or retry
   * exhaustion) are accumulated and reported as a single priority aggregate
   * per namespace at this cadence. Default: 300 000 (5 min).
   */
  lossInterval?: number;
  /**
   * Maximum number of aggregates sent in a single HTTP request. Default: 500.
   *
   * InfluxDB accepts multiple line-protocol points per write request
   * (recommended batch size: 5 000 for raw events). For pre-aggregated
   * monitoring data a default of 500 covers most setups in one request
   * while staying well within typical payload limits.
   */
  batchSize?: number;
};

export abstract class Transporter {
  /** Unique key identifying this transporter — used to route IPC messages on the primary. */
  abstract readonly key: string;
  /** Maximum number of aggregates to send per second. */
  abstract readonly rateLimit: number;
  /** Retry strategy applied on failed sends. */
  readonly retry: RetryConfig = {};
  /** Queue buffering and loss-reporting config. */
  readonly queue: QueueConfig = {};

  /**
   * Sends one or more aggregates in a single request.
   *
   * The queue always passes a batch — even a single item arrives as an array
   * of length 1. Implementations may write all items in one network request
   * (e.g. newline-separated InfluxDB line protocol) or loop over them.
   */
  abstract send(data: Aggregate<unknown>[]): Promise<void>;
}
