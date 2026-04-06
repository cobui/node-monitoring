import cluster from "node:cluster";
import { getQueue } from "./queues";
import { isTransportMessage } from "./queue";

type ClusterMessageHandler = (worker: cluster.Worker, message: unknown) => void;

let handler: ClusterMessageHandler | null = null;
let refCount = 0;

/**
 * Attaches the cluster IPC message handler on the primary process.
 * Reference-counted — safe to call from multiple Monitors; the handler is
 * attached only on the first call and detached only after the last release.
 */
export function activateListener(): void {
  if (refCount++ === 0) {
    handler = (_worker, message) => {
      if (!isTransportMessage(message)) return;
      getQueue(message.key)?.enqueue(message.data);
    };
    cluster.on("message", handler);
  }
}

/**
 * Releases one reference to the IPC handler. When the reference count
 * reaches zero the handler is removed from the cluster event emitter.
 */
export function deactivateListener(): void {
  if (refCount === 0) return;
  if (--refCount === 0 && handler) {
    cluster.off("message", handler);
    handler = null;
  }
}

/** Reset listener state — for use in tests only. */
export function _reset(): void {
  if (handler) {
    cluster.off("message", handler);
    handler = null;
  }
  refCount = 0;
}
