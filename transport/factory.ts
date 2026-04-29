import { Influx } from "./influx";
import type { InfluxConfig } from "./influx";
import type { Transporter } from "./base";

/**
 * A key-only transporter reference — reuses an already-configured transporter
 * queue by key. The referenced key must have been defined by a preceding
 * namespace in the same `monitoring.add()` call (or a previous call).
 */
export type TransporterRef = { key: string };

/**
 * Discriminated union of all supported transporter configs.
 * Add new transporter types here as the package grows.
 */
export type TransporterConfig = (InfluxConfig & { type: "influx" }) | TransporterRef;
// Future: | (StatsDConfig & { type: "statsd" })

export function isTransporterRef(config: TransporterConfig): config is TransporterRef {
  return !("type" in config);
}

/**
 * Instantiates the correct {@link Transporter} from a plain config object.
 * Called by {@link Monitor} so users never need to import transporter classes directly.
 * Throws if passed a {@link TransporterRef} — callers must handle refs before calling this.
 */
export function createTransporter(config: TransporterConfig): Transporter {
  if (isTransporterRef(config)) {
    throw new Error(
      `[node-monitoring] Transporter ref "${config.key}" passed to createTransporter — ` +
        `resolve the ref via acquireQueueByKey() before calling createTransporter.`,
    );
  }
  switch (config.type) {
    case "influx":
      return new Influx(config);
    default: {
      const _exhaustive: never = config.type;
      throw new Error(`Unknown transporter type: "${String(_exhaustive)}"`);
    }
  }
}
