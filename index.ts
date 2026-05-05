// ── Lifecycle ─────────────────────────────────────────────────────────────────
export { Monitoring } from "./monitoring";
export { Monitor } from "./monitor";
export type { MonitorConfig } from "./monitor";

// ── Sensors ───────────────────────────────────────────────────────────────────
export { Counter, Gauge, Histogram } from "./sensor";

// ── Types ─────────────────────────────────────────────────────────────────────
export type { Tags, MetricConfig, MetricType, HistogramAggregate } from "./types";

// ── Transport config ──────────────────────────────────────────────────────────
export type { TransporterConfig } from "./transport/factory";
export type { InfluxConfig, InfluxV1Config, InfluxV2Config, InfluxV3Config } from "./transport/influx";

// ── Config loader ─────────────────────────────────────────────────────────────
export { loadConfig } from "./config";

// ── Warnings ──────────────────────────────────────────────────────────────────
export { warnings } from "./warnings";
export type { SensorInactiveWarning, SensorNotFoundWarning, SensorAmbiguousWarning, TransportLossWarning } from "./warnings";
