import { readFileSync } from "node:fs";
import { load } from "js-yaml";
import type { MonitorConfig } from "./monitor";

/**
 * Recursively replaces `${VAR_NAME}` placeholders in string values with the
 * corresponding `process.env` value.
 *
 * Throws if a referenced variable is not set — silent failures are worse than
 * loud ones when credentials are involved.
 */
function interpolateEnv(value: unknown): unknown {
  if (typeof value === "string") {
    return value.replace(/\$\{([^}]+)\}/g, (_match, key: string) => {
      const resolved = process.env[key];
      if (resolved === undefined) {
        throw new Error(`loadConfig: environment variable "\${${key}}" is not set`);
      }
      return resolved;
    });
  }
  if (Array.isArray(value)) return value.map(interpolateEnv);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, interpolateEnv(v)]));
  }
  return value;
}

/**
 * Loads a YAML configuration file and returns the parsed namespace configs
 * ready to pass directly to {@link Monitoring#add}.
 *
 * String values of the form `${VAR_NAME}` are resolved against `process.env`
 * before the config is returned — store credentials in environment variables
 * and reference them from the YAML instead of committing them to source control.
 *
 * @param path - Path to the YAML config file (absolute or relative to `process.cwd()`).
 * @returns Array of {@link MonitorConfig} objects, one per entry in the file.
 * @throws If the file cannot be read, is not valid YAML, does not contain a
 *   top-level array, or references an unset environment variable.
 *
 * @example
 * ```ts
 * import { Monitoring, loadConfig } from "node-monitoring";
 *
 * const monitoring = new Monitoring();
 * monitoring.add(loadConfig("monitoring.config.yml"));
 * monitoring.start();
 * ```
 */
export function loadConfig(path: string): MonitorConfig[] {
  let raw: unknown;
  try {
    raw = load(readFileSync(path, "utf8"));
  } catch (err) {
    throw new Error(`loadConfig: failed to read or parse "${path}": ${(err as Error).message}`);
  }

  if (!Array.isArray(raw)) {
    throw new Error(`loadConfig: expected a top-level array in "${path}"`);
  }

  return interpolateEnv(raw) as MonitorConfig[];
}
