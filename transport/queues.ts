import type { Transporter } from "./base";
import { TransportQueue } from "./queue";

const queues = new Map<string, TransportQueue>();
const refCounts = new Map<string, number>();

export function acquireQueue(transporter: Transporter): TransportQueue {
  let queue = queues.get(transporter.key);
  if (!queue) {
    queue = new TransportQueue(transporter);
    queues.set(transporter.key, queue);
    refCounts.set(transporter.key, 0);
  }
  refCounts.set(transporter.key, refCounts.get(transporter.key)! + 1);
  return queue;
}

/**
 * Acquires an existing queue by key reference. Throws if the key has not been
 * registered yet — the full transporter config must appear before any refs to it.
 */
export function acquireQueueByRef(key: string): TransportQueue {
  const queue = queues.get(key);
  if (!queue) {
    throw new Error(
      `[node-monitoring] Transporter ref "${key}" used before it was defined. ` +
        `Ensure the namespace with the full transporter config appears first in monitoring.add([...]).`,
    );
  }
  refCounts.set(key, refCounts.get(key)! + 1);
  return queue;
}

export function releaseQueue(key: string): void {
  const count = refCounts.get(key);
  if (count === undefined) return;
  if (count <= 1) {
    queues.get(key)?.destroy();
    queues.delete(key);
    refCounts.delete(key);
  } else {
    refCounts.set(key, count - 1);
  }
}

export function getQueue(key: string): TransportQueue | undefined {
  return queues.get(key);
}

/** Reset registry state — for use in tests only. */
export function _reset(): void {
  for (const queue of queues.values()) queue.destroy();
  queues.clear();
  refCounts.clear();
}
