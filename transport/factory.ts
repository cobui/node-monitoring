import { Influx } from "./influx";
import type { InfluxConfig } from "./influx";
import type { Transporter } from "./base";

/**
 * Discriminated union of all supported transporter configs.
 * Add new transporter types here as the package grows.
 */
export type TransporterConfig = InfluxConfig & { type: "influx" };
// Future: | (StatsDConfig & { type: "statsd" })

/**
 * Instantiates the correct {@link Transporter} from a plain config object.
 * Called by {@link Monitor} so users never need to import transporter classes directly.
 */
export function createTransporter(config: TransporterConfig): Transporter {
  switch (config.type) {
    case "influx":
      return new Influx(config);
    default: {
      const _exhaustive: never = config.type;
      throw new Error(`Unknown transporter type: "${String(_exhaustive)}"`);
    }
  }
}
