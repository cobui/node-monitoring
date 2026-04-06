import type { Aggregate } from "../types";
import type { TransportMessage } from "./queue";

/**
 * Worker-side aggregate sink. Immediately forwards each data point to the
 * primary process via IPC — no buffering, no rate limiting, no drain timer.
 */
export class WorkerSender {
  constructor(private readonly key: string) {}

  enqueue(data: Aggregate<unknown>): void {
    process.send!({
      type: "monitoring:transport",
      key: this.key,
      data,
    } satisfies TransportMessage);
  }
}
