import { EventEmitter } from "node:events";

/** Payload emitted when a sensor fires on a namespace that has never been started. */
export type SensorInactiveWarning = { uri: string; namespace?: string };

/** Payload emitted when a sensor fires but its URI is not registered in the namespace. */
export type SensorNotFoundWarning = { uri: string; namespace: string; type: string };

/**
 * Payload emitted when a sensor has no explicit namespace and multiple namespaces are active.
 */
export type SensorAmbiguousWarning = { uri: string; namespaces: string[] };

/**
 * Payload emitted when a transport batch is permanently dropped after all retry attempts fail.
 * `cause` is the last error thrown by the transporter — inspect it to diagnose authentication
 * failures, SSL mismatches, wrong host/port, etc.
 */
export type TransportLossWarning = { key: string; count: number; attempts: number; cause: unknown };

type WarningEvents = {
  "sensor:inactive": [SensorInactiveWarning];
  "sensor:not-found": [SensorNotFoundWarning];
  "sensor:ambiguous": [SensorAmbiguousWarning];
  "transport:loss": [TransportLossWarning];
};

class WarningEmitter extends EventEmitter {
  emit<K extends keyof WarningEvents>(event: K, payload: WarningEvents[K][0]): boolean {
    return super.emit(event as string, payload);
  }

  on<K extends keyof WarningEvents>(event: K, listener: (payload: WarningEvents[K][0]) => void): this {
    return super.on(event as string, listener);
  }

  off<K extends keyof WarningEvents>(event: K, listener: (payload: WarningEvents[K][0]) => void): this {
    return super.off(event as string, listener);
  }

  once<K extends keyof WarningEvents>(event: K, listener: (payload: WarningEvents[K][0]) => void): this {
    return super.once(event as string, listener);
  }

  listenerCount(event: keyof WarningEvents): number {
    return super.listenerCount(event as string);
  }
}

/**
 * Global warning event emitter for the monitoring package.
 *
 * Subscribe to specific warning categories to route them to your own logger
 * or suppress them selectively. When no listener is registered for an event,
 * the warning falls through to `console.warn`.
 *
 * @example
 * ```ts
 * import { warnings } from "@cobui/node-monitoring";
 *
 * // Route to your own logger
 * warnings.on("sensor:inactive", ({ uri, namespace }) => {
 *   logger.warn(`sensor ${uri} fired on inactive namespace ${namespace}`);
 * });
 *
 * // Suppress a specific category entirely
 * warnings.on("sensor:not-found", () => {});
 * ```
 */
export const warnings = new WarningEmitter();

/**
 * Emits a typed warning event. If no listener is registered for the event,
 * falls back to `console.warn` with a `[node-monitoring]` prefix.
 */
export function emitWarning<K extends keyof WarningEvents>(
  event: K,
  payload: WarningEvents[K][0],
  message: string,
): void {
  if (warnings.listenerCount(event) > 0) {
    warnings.emit(event, payload);
  } else {
    console.warn(`[node-monitoring] ${message}`);
  }
}
