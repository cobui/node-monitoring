# node-monitoring

Lightweight monitoring for Node.js. Define metrics in YAML, drop sensors in your code, data goes to InfluxDB.

---

## Quick start

Parse your config file and pass it directly to `monitoring.add()`

```ts
import { Monitoring, loadConfig, Counter, Gauge, Histogram } from "node-monitoring";

const config = loadConfig("monitoring.yml") as any;
const monitoring = new Monitoring();

monitoring.add(config);

// Sensors can be created anywhere — no reference to `monitoring` needed
const requests = Counter.create("http.requests", "app");
const latency = Histogram.create("http.latency", "app");
const memory = Gauge.create("process.mem", "app");

// In your request handler:
requests.increment(1, { route: "/api/users", method: "GET" });
latency.record(42, { route: "/api/users" });
memory.set(process.memoryUsage().heapUsed / 1024 / 1024);

// Before process exit: flush(), then destroy().
// flush() resolves only after all data is sent; destroy() clears remaining handles.
await monitoring.flush();
monitoring.destroy();
```

See `config.example.yml` for a full annotated config file.

---

## Sensors

Sensors are the primary recording API.

```ts
import { Counter, Gauge, Histogram } from "node-monitoring";

const hits = Counter.create("http.requests", "app");
const memory = Gauge.create("process.mem", "app");
const latency = Histogram.create("http.latency", "app");
```

| Sensor      | Metric type | Method                     | Use for                                           |
| ----------- | ----------- | -------------------------- | ------------------------------------------------- |
| `Counter`   | counter     | `increment(delta?, tags?)` | Events (requests, errors, cache hits)             |
| `Gauge`     | gauge       | `set(value, tags?)`        | Current values (memory, queue depth, connections) |
| `Histogram` | histogram   | `record(value, tags?)`     | Distributions (latencies, sizes, durations)       |

```ts
hits.increment(); // +1
hits.increment(5); // +5
hits.increment({ route: "/api" }); // +1 with tags (shorthand)

memory.set(process.memoryUsage().heapUsed);

latency.record(42, { route: "/api", status: "200" });
```

> If a sensor fires before its namespace is active, or the URI doesn't match a registered metric, a warning is emitted once per sensor. See [Warnings](#warnings) below.

---

## Metric types

| Type        | `reset` default                        |
| ----------- | -------------------------------------- |
| `counter`   | `true` (per-interval rate)             |
| `histogram` | `true` (per-interval distribution)     |
| `gauge`     | `false` (current value, never cleared) |

Counter and histogram reset after each collection cycle because you typically want per-interval rates and distributions, not cumulative totals. Gauge never resets because it represents an instantaneous value, when clearing it would produce a gap until the next `set()` call.

Set `reset: false` on a counter to get a monotonic total (diff/rate at query time).

---

## MetricConfig

```ts
{
  uri:      string;          // identifier unique to namespace, e.g. "http.requests"
  type:     "counter" | "gauge" | "histogram";
  interval: number;          // collection interval in milliseconds

  // Optional
  reset?:    boolean;        // defaults: counter/histogram=true, gauge=false
  enabled?:  boolean;        // default: true
  tags?:     Record<string, string | number | boolean>;  // added to every data point
  exclude?:  string[];       // strip these tag keys before hashing to reduce cardinality
  cache?:    { max?: number }; // max distinct tag combinations to track (default: 1000)
}
```

---

## Lifecycle

```ts
const monitoring = new Monitoring();

// Add a namespace — starts immediately when enabled: true (default)
monitoring.add([{ namespace: "app", transporter: ..., metrics: [...] }]);

// Start / pause all enabled namespaces
monitoring.start();
monitoring.stop();

// Per-namespace control
monitoring.setNamespaceEnabled("app", false);  // pause
monitoring.setNamespaceEnabled("app", true);   // resume
monitoring.isEnabled("app");          // → boolean

// Per-metric control
monitoring.setMetricEnabled("http.requests", false);
monitoring.reschedule("http.requests", 30_000);

// Before process exit: flush buffered data, then destroy.
// flush() waits until every queued item has been sent (or exhausted retries),
// but it does NOT close all handles — the loss-reporting timer inside the
// transport queue stays alive until destroy() is called. Always pair them.
await monitoring.flush();
monitoring.destroy();
```

---

## Transporter config — InfluxDB

### InfluxDB v2 (InfluxDB Cloud / OSS 2.x)

```yaml
transporter:
  type: influx
  version: 2
  key:
    influx # default: "influx". Namespaces sharing the same key share one queue
    # and rate limit. Give each transporter its own key when you want
    # independent queues (e.g. different InfluxDB hosts or rate limits).
  host: influxdb.example.com
  port: 8086 # default: 8086
  protocol: https # default: https
  org: my-org
  bucket: app-metrics
  token: "YOUR_TOKEN"

  rateLimit: 20 # requests per second (default: 10)
  measurementStrategy: uri # "uri" (default) or "namespace" (see below)

  retry:
    retries: 3 # attempts after the first (default: 3)
    minTimeout: 1000 # ms before first retry (default: 1000)
    maxTimeout: 30000 # upper bound on backoff (default: 30000)
    factor: 2 # exponential multiplier (default: 2)

  queue:
    maxSize: 10000 # drop incoming when queue exceeds this (default: unlimited)
    lossInterval: 300000 # ms between loss-record flushes (default: 5 min)
```

### InfluxDB v1 (InfluxDB OSS 1.x)

```yaml
transporter:
  type: influx
  version: 1
  key: influx # default: "influx" — see note in v2 section above
  host: influx-legacy.internal
  port: 8086
  protocol: http # default: http
  database: app-metrics
  retentionPolicy: 90d # optional
  username: monitor # optional -> omit both username and password for unauthenticated instances
  password: "YOUR_PASSWORD" # optional -> must be provided together with username
```

### Measurement strategy

| Strategy        | Measurement name                      | When to use                                       |
| --------------- | ------------------------------------- | ------------------------------------------------- |
| `uri` (default) | The metric URI (e.g. `http.requests`) | Each metric has its own schema                    |
| `namespace`     | The namespace (e.g. `app`)            | All metrics in one place; URI kept as a `uri` tag |

### Namespace tag (`includeNamespaceTag`)

By default the `namespace` value is **not** added as a tag on every data point. For most setups this is the right choice — with `measurementStrategy: namespace` the namespace is already the measurement name, and with `measurementStrategy: uri` and a single namespace it would just be a constant on every row.

Set `includeNamespaceTag: true` on a namespace config when you use `measurementStrategy: uri` **and** have multiple namespaces writing to the same transporter. This lets you filter by namespace in InfluxDB without it being the measurement name.

```yaml
- namespace: app
  includeNamespaceTag: true   # stamps namespace: "app" on every aggregate
  transporter:
    type: influx
    measurementStrategy: uri
    ...
```

---

## Cluster mode

No setup required. On worker processes, aggregates are forwarded to the primary via IPC. The primary consolidates them in a shared rate-limited queue. There is always only one queue per transporter key, regardless of how many workers or namespaces share it.

---

## Warnings

Sensors emit a typed warning event the first time an issue is detected. By default warnings fall through to `console.warn`. Subscribe to any category to route them to your own logger or suppress them entirely:

```ts
import { warnings } from "node-monitoring";

warnings.on("sensor:inactive", ({ uri, namespace }) => {
  /* namespace not started */
});
warnings.on("sensor:not-found", ({ uri, namespace, type }) => {
  /* URI not registered */
});
warnings.on("sensor:ambiguous", ({ uri, namespaces }) => {
  /* multiple active namespaces, no explicit ns */
});
warnings.on("transport:loss", ({ uri, namespaces }) => {
  /* queue dropped measurements after last failed retry */
});
```

Each sensor warning fires at most once per sensor instance.

---

## Design notes

**No silent failures.** Sensors emit a one-time warning if the namespace is not active or the URI is not found, so misconfigurations surface immediately without spamming logs.

**No TTL on metric cache.** TTL causes implicit counter resets and breaks rate/diff queries. Metrics accumulate until a collection cycle runs; `reset: true` clears them after.

**Tag ordering.** Tags are sorted alphabetically before sending to the backend to improve Influx performance.

**Loss records.** When the queue is full or retries are exhausted, lost items are counted per namespace and flushed as a `monitoring.loss` aggregate at a configurable interval. This lets you track dropped metrics without flooding the queue.
