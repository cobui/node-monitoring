import * as http from "node:http";
import * as https from "node:https";
import * as zlib from "node:zlib";
import { Transporter } from "./base";
import type { RetryConfig, QueueConfig } from "./base";
import type { Aggregate, Tags } from "../types";

// ─── Config types ─────────────────────────────────────────────────────────────

export type InfluxV1Config = {
  version: 1;
  host: string;
  /** Default: 8086 */
  port?: number;
  /** Default: "http" */
  protocol?: "http" | "https";
  database: string;
  retentionPolicy?: string;
  username?: string;
  password?: string;
};

export type InfluxV2Config = {
  version: 2;
  host: string;
  /** Default: 8086 */
  port?: number;
  /** Default: "https" */
  protocol?: "http" | "https";
  org: string;
  bucket: string;
  token: string;
};

export type InfluxConfig = (InfluxV1Config | InfluxV2Config) & {
  /** Transporter key used for IPC routing. Default: "influx". */
  key?: string;
  /** Maximum aggregates sent per second. Default: 10. */
  rateLimit?: number;
  /**
   * Compress each write request body with gzip. Default: `true`.
   *
   * InfluxDB recommends gzip for API writes — line protocol is highly repetitive
   * text and compresses well, especially for large batches.
   * Set to `false` if a proxy between the application and InfluxDB does not
   * forward `Content-Encoding` correctly.
   */
  gzip?: boolean;
  /**
   * Controls how aggregates are mapped to InfluxDB measurements.
   *
   * `"uri"` (default) — each metric URI becomes its own measurement.
   * ```
   * requests,namespace=app,route=/api value=42i <ts>
   * ```
   *
   * `"namespace"` — all metrics from a namespace share one measurement;
   * the metric URI is added as a `metric` tag for differentiation.
   * ```
   * app,metric=requests,route=/api value=42i <ts>
   * ```
   */
  measurementStrategy?: "uri" | "namespace";
  retry?: RetryConfig;
  queue?: QueueConfig;
};

// ─── HTTP helper ──────────────────────────────────────────────────────────────

function post(protocol: "http" | "https", options: http.RequestOptions, body: string | Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    const lib = protocol === "https" ? https : http;
    const req = lib.request(options, (res) => {
      res.resume(); // drain response body — required to free the socket
      if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
        resolve();
      } else {
        reject(new Error(`InfluxDB responded with HTTP ${res.statusCode}`));
      }
    });
    req.on("error", reject);
    req.end(body);
  });
}

// ─── Line Protocol helpers ────────────────────────────────────────────────────

/** Escape special characters in measurement names, tag keys, and tag values. */
function escapeName(s: string): string {
  return s.replace(/[, =]/g, (c) => `\\${c}`);
}

/** Format a single aggregate value as InfluxDB field set. */
function formatFields(value: unknown): string {
  if (typeof value === "number") {
    return Number.isInteger(value) ? `value=${value}i` : `value=${value}`;
  }
  if (typeof value === "object" && value !== null) {
    // Histogram aggregate: { count, min, max, mean, stddev }
    return Object.entries(value as Record<string, number>)
      .map(([k, v]) => (k === "count" ? `${escapeName(k)}=${Math.round(v)}i` : `${escapeName(k)}=${v}`))
      .join(",");
  }
  // Fallback — should not normally occur
  return `value="${String(value).replace(/["\\]/g, (c) => `\\${c}`)}"`;
}

// ─── Influx transporter ───────────────────────────────────────────────────────

export class Influx extends Transporter {
  override readonly key: string;
  override readonly rateLimit: number;
  override readonly retry: RetryConfig;
  override readonly queue: QueueConfig;

  private readonly strategy: "uri" | "namespace";
  private readonly protocol: "http" | "https";
  private readonly requestOptions: http.RequestOptions;
  private readonly gzip: boolean;

  constructor(private readonly config: InfluxConfig) {
    super();
    this.key = config.key ?? "influx";
    this.rateLimit = config.rateLimit ?? 10;
    this.retry = config.retry ?? {};
    this.queue = config.queue ?? {};
    this.strategy = config.measurementStrategy ?? "uri";
    this.gzip = config.gzip ?? true;
    this.protocol = config.protocol ?? (config.version === 2 ? "https" : "http");
    this.requestOptions = this.buildRequestOptions();
  }

  send(data: Aggregate<unknown>[]): Promise<void> {
    const body = data.map((d) => this.toLineProtocol(d)).join("\n");
    const payload: string | Buffer = this.gzip ? zlib.gzipSync(Buffer.from(body, "utf8")) : body;
    return post(this.protocol, this.requestOptions, payload);
  }

  // ── Line Protocol ──────────────────────────────────────────────────────────

  private toLineProtocol(data: Aggregate<unknown>): string {
    const tags = { ...data.tags };
    let measurement: string;

    if (this.strategy === "namespace") {
      measurement = escapeName(String(tags.namespace ?? "metrics"));
      delete tags.namespace;
    } else {
      measurement = escapeName(String(tags.uri ?? "metrics"));
      delete tags.uri;
    }

    const tagStr = this.formatTags(tags);
    const fieldStr = formatFields(data.value);
    const ts = data.timestamp; // already in ms; precision=ms set in URL
    return `${measurement}${tagStr ? `,${tagStr}` : ""} ${fieldStr} ${ts}`;
  }

  private formatTags(tags: Tags): string {
    return Object.entries(tags)
      .filter(([, v]) => v !== undefined && v !== null && v !== "")
      .map(([k, v]) => `${escapeName(k)}=${escapeName(String(v))}`)
      .join(",");
  }

  // ── Request options (computed once at construction) ────────────────────────

  private buildRequestOptions(): http.RequestOptions {
    const { host, port = 8086 } = this.config;
    const path = this.buildPath();
    const headers = this.buildHeaders();
    return { method: "POST", hostname: host, port, path, headers };
  }

  private buildPath(): string {
    const enc = encodeURIComponent;
    if (this.config.version === 2) {
      const { org, bucket } = this.config;
      return `/api/v2/write?org=${enc(org)}&bucket=${enc(bucket)}&precision=ms`;
    } else {
      const { database, retentionPolicy } = this.config;
      const rp = retentionPolicy ? `&rp=${enc(retentionPolicy)}` : "";
      return `/write?db=${enc(database)}${rp}&precision=ms`;
    }
  }

  private buildHeaders(): http.OutgoingHttpHeaders {
    const headers: http.OutgoingHttpHeaders = {
      "Content-Type": "text/plain; charset=utf-8",
    };
    if (this.gzip) headers["Content-Encoding"] = "gzip";
    if (this.config.version === 2) {
      headers["Authorization"] = `Token ${this.config.token}`;
    } else if (this.config.username && this.config.password) {
      const creds = Buffer.from(`${this.config.username}:${this.config.password}`).toString("base64");
      headers["Authorization"] = `Basic ${creds}`;
    }
    return headers;
  }
}
