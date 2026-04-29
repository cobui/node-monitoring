import { vi, describe, it, expect, beforeEach } from "vitest";
import { gunzipSync } from "node:zlib";
import type { Tags } from "../types.js";

// ─── HTTP mock ────────────────────────────────────────────────────────────────
// Intercepts http.request / https.request and captures the body written.
// Buffer bodies (gzip) are automatically decompressed so assertions always
// operate on plain-text line protocol regardless of compression setting.

type MockRequest = {
  protocol: "http" | "https";
  options: Record<string, unknown>;
  body: string;
};

const requests: MockRequest[] = [];

function makeMockLib(protocol: "http" | "https", statusCode = 204) {
  return {
    request: vi.fn((options: unknown, callback: (res: unknown) => void) => {
      const req = {
        on: vi.fn(),
        end: vi.fn((body: string | Buffer) => {
          const text = Buffer.isBuffer(body) ? gunzipSync(body).toString("utf8") : (body ?? "");
          requests.push({ protocol, options: options as Record<string, unknown>, body: text });
          callback({ statusCode, resume: vi.fn() });
        }),
      };
      return req;
    }),
  };
}

vi.mock("node:http", () => makeMockLib("http"));
vi.mock("node:https", () => makeMockLib("https"));

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeAggregate(tags: Tags, value: unknown, timestamp = 1_000) {
  return { tags, value, timestamp };
}

beforeEach(() => {
  requests.length = 0;
  vi.resetModules();
});

// ─── Line Protocol — "uri" strategy ──────────────────────────────────────────

describe('Influx line protocol — "uri" strategy', () => {
  it("uses the uri tag as measurement name and strips namespace tag by default", async () => {
    const { Influx } = await import("../transport/influx.js");
    const influx = new Influx({ version: 2, host: "h", org: "o", bucket: "b", token: "t" });
    await influx.send([makeAggregate({ uri: "requests", namespace: "app", route: "/api" }, 42)]);
    const lp = requests[0].body;
    expect(lp).toMatch(/^requests,/);
    expect(lp).not.toContain("namespace=");
    expect(lp).toContain("route=/api");
    expect(lp).not.toContain("uri=");
  });

  it("keeps namespace as a tag when includeNamespaceTag is true", async () => {
    const { Influx } = await import("../transport/influx.js");
    const influx = new Influx({ version: 2, host: "h", org: "o", bucket: "b", token: "t", includeNamespaceTag: true });
    await influx.send([makeAggregate({ uri: "requests", namespace: "app", route: "/api" }, 42)]);
    const lp = requests[0].body;
    expect(lp).toMatch(/^requests,/);
    expect(lp).toContain("namespace=app");
    expect(lp).toContain("route=/api");
    expect(lp).not.toContain("uri=");
  });

  it("formats integer counter values with i suffix", async () => {
    const { Influx } = await import("../transport/influx.js");
    const influx = new Influx({ version: 2, host: "h", org: "o", bucket: "b", token: "t" });
    await influx.send([makeAggregate({ uri: "hits", namespace: "app" }, 100)]);
    expect(requests[0].body).toContain("value=100i");
  });

  it("formats float gauge values without i suffix", async () => {
    const { Influx } = await import("../transport/influx.js");
    const influx = new Influx({ version: 2, host: "h", org: "o", bucket: "b", token: "t" });
    await influx.send([makeAggregate({ uri: "memory", namespace: "app" }, 3.14)]);
    expect(requests[0].body).toContain("value=3.14");
    expect(requests[0].body).not.toContain("3.14i");
  });

  it("expands histogram aggregates into multiple fields", async () => {
    const { Influx } = await import("../transport/influx.js");
    const influx = new Influx({ version: 2, host: "h", org: "o", bucket: "b", token: "t" });
    await influx.send([
      makeAggregate(
        { uri: "latency", namespace: "app" },
        { count: 100, min: 1.2, max: 500.3, mean: 45.6, stddev: 12.3 },
      ),
    ]);
    const lp = requests[0].body;
    expect(lp).toContain("count=100i");
    expect(lp).toContain("min=1.2");
    expect(lp).toContain("max=500.3");
    expect(lp).toContain("mean=45.6");
    expect(lp).toContain("stddev=12.3");
    expect(lp).not.toContain("value=");
  });

  it("falls back to tags.uri as measurement for loss records (no uri tag)", async () => {
    const { Influx } = await import("../transport/influx.js");
    const influx = new Influx({ version: 2, host: "h", org: "o", bucket: "b", token: "t" });
    await influx.send([makeAggregate({ namespace: "app", uri: "monitoring.loss" }, 3)]);
    const lp = requests[0].body;
    // Dots are allowed in measurement names in InfluxDB; escaped comma/space/equals only
    expect(lp).toMatch(/^monitoring\.loss[, ]/);
  });

  it("includes the timestamp at the end of the line", async () => {
    const { Influx } = await import("../transport/influx.js");
    const influx = new Influx({ version: 2, host: "h", org: "o", bucket: "b", token: "t" });
    await influx.send([makeAggregate({ uri: "hits", namespace: "app" }, 1, 1234567890)]);
    expect(requests[0].body.trimEnd()).toMatch(/1234567890$/);
  });
});

it("falls back to 'metrics' as measurement when neither uri nor metric tag is set", async () => {
  const { Influx } = await import("../transport/influx.js");
  const influx = new Influx({ version: 2, host: "h", org: "o", bucket: "b", token: "t" });
  await influx.send([makeAggregate({}, 1)]);
  expect(requests[0].body).toMatch(/^metrics /);
});

it("omits the tag set separator when the aggregate has no extra tags", async () => {
  const { Influx } = await import("../transport/influx.js");
  const influx = new Influx({ version: 2, host: "h", org: "o", bucket: "b", token: "t" });
  // Only uri tag — deleted during serialisation, leaving tags empty.
  await influx.send([makeAggregate({ uri: "hits" }, 1)]);
  // No comma between measurement and field set.
  expect(requests[0].body).toMatch(/^hits value=/);
});

it("formats non-number, non-object values as quoted strings (fallback)", async () => {
  const { Influx } = await import("../transport/influx.js");
  const influx = new Influx({ version: 2, host: "h", org: "o", bucket: "b", token: "t" });
  await influx.send([makeAggregate({ uri: "hits", namespace: "app" }, "raw-string")]);
  expect(requests[0].body).toContain('value="raw-string"');
});

// ─── Line Protocol — "namespace" strategy ────────────────────────────────────

describe('Influx line protocol — "namespace" strategy', () => {
  it("uses namespace as measurement and adds metric tag from uri", async () => {
    const { Influx } = await import("../transport/influx.js");
    const influx = new Influx({
      version: 2,
      host: "h",
      org: "o",
      bucket: "b",
      token: "t",
      measurementStrategy: "namespace",
    });
    await influx.send([makeAggregate({ uri: "requests", namespace: "app", route: "/api" }, 42)]);
    const lp = requests[0].body;
    expect(lp).toMatch(/^app,/);
    expect(lp).toContain("uri=requests");
    expect(lp).not.toContain("namespace=");
  });

  it("falls back to 'metrics' as measurement when namespace tag is missing", async () => {
    const { Influx } = await import("../transport/influx.js");
    const influx = new Influx({
      version: 2,
      host: "h",
      org: "o",
      bucket: "b",
      token: "t",
      measurementStrategy: "namespace",
    });
    // No namespace tag → falls back to "metrics" as measurement name.
    await influx.send([makeAggregate({ uri: "hits" }, 42)]);
    expect(requests[0].body).toMatch(/^metrics[, ]/);
  });

  it("handles loss records: measurement = namespace, keeps metric tag", async () => {
    const { Influx } = await import("../transport/influx.js");
    const influx = new Influx({
      version: 2,
      host: "h",
      org: "o",
      bucket: "b",
      token: "t",
      measurementStrategy: "namespace",
    });
    await influx.send([makeAggregate({ namespace: "app", metric: "monitoring.loss" }, 3)]);
    const lp = requests[0].body;
    expect(lp).toMatch(/^app[, ]/);
    expect(lp).toContain("metric=monitoring.loss");
    expect(lp).not.toContain("namespace=");
  });
});

// ─── Tag escaping ─────────────────────────────────────────────────────────────

describe("Influx line protocol — tag escaping", () => {
  it("escapes spaces in tag values", async () => {
    const { Influx } = await import("../transport/influx.js");
    const influx = new Influx({ version: 2, host: "h", org: "o", bucket: "b", token: "t" });
    await influx.send([makeAggregate({ uri: "hits", namespace: "app", host: "my server" }, 1)]);
    expect(requests[0].body).toContain("host=my\\ server");
  });

  it("escapes commas in tag values", async () => {
    const { Influx } = await import("../transport/influx.js");
    const influx = new Influx({ version: 2, host: "h", org: "o", bucket: "b", token: "t" });
    await influx.send([makeAggregate({ uri: "hits", namespace: "app", region: "us,east" }, 1)]);
    expect(requests[0].body).toContain("region=us\\,east");
  });

  it("escapes equals in tag values", async () => {
    const { Influx } = await import("../transport/influx.js");
    const influx = new Influx({ version: 2, host: "h", org: "o", bucket: "b", token: "t" });
    await influx.send([makeAggregate({ uri: "hits", namespace: "app", label: "k=v" }, 1)]);
    expect(requests[0].body).toContain("label=k\\=v");
  });
});

// ─── URL construction ─────────────────────────────────────────────────────────

describe("Influx URL construction", () => {
  it("V2: path includes org, bucket, and precision=ms", async () => {
    const { Influx } = await import("../transport/influx.js");
    const influx = new Influx({
      version: 2,
      host: "influx.example.com",
      org: "myorg",
      bucket: "mybucket",
      token: "t",
    });
    await influx.send([makeAggregate({ uri: "x", namespace: "app" }, 1)]);
    const { options } = requests[0];
    expect(options.path).toContain("/api/v2/write");
    expect(options.path).toContain("org=myorg");
    expect(options.path).toContain("bucket=mybucket");
    expect(options.path).toContain("precision=ms");
  });

  it("V1: path includes db and precision=ms", async () => {
    const { Influx } = await import("../transport/influx.js");
    const influx = new Influx({
      version: 1,
      host: "influx.internal",
      database: "metrics",
    });
    await influx.send([makeAggregate({ uri: "x", namespace: "app" }, 1)]);
    const { options } = requests[0];
    expect(options.path).toContain("/write");
    expect(options.path).toContain("db=metrics");
    expect(options.path).toContain("precision=ms");
    expect(options.path).not.toContain("rp=");
  });

  it("V1 with retentionPolicy: path includes rp", async () => {
    const { Influx } = await import("../transport/influx.js");
    const influx = new Influx({
      version: 1,
      host: "h",
      database: "metrics",
      retentionPolicy: "90d",
    });
    await influx.send([makeAggregate({ uri: "x", namespace: "app" }, 1)]);
    expect(requests[0].options.path).toContain("rp=90d");
  });

  it("uses the configured port", async () => {
    const { Influx } = await import("../transport/influx.js");
    const influx = new Influx({
      version: 2,
      host: "h",
      port: 9999,
      org: "o",
      bucket: "b",
      token: "t",
    });
    await influx.send([makeAggregate({ uri: "x", namespace: "app" }, 1)]);
    expect(requests[0].options.port).toBe(9999);
  });
});

// ─── Auth headers ─────────────────────────────────────────────────────────────

describe("Influx auth headers", () => {
  it("V2: sends Token auth header", async () => {
    const { Influx } = await import("../transport/influx.js");
    const influx = new Influx({
      version: 2,
      host: "h",
      org: "o",
      bucket: "b",
      token: "supersecret",
    });
    await influx.send([makeAggregate({ uri: "x", namespace: "app" }, 1)]);
    const headers = requests[0].options.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Token supersecret");
  });

  it("V1 with credentials: sends Basic auth header", async () => {
    const { Influx } = await import("../transport/influx.js");
    const influx = new Influx({
      version: 1,
      host: "h",
      database: "db",
      username: "admin",
      password: "pass",
    });
    await influx.send([makeAggregate({ uri: "x", namespace: "app" }, 1)]);
    const headers = requests[0].options.headers as Record<string, string>;
    const expected = "Basic " + Buffer.from("admin:pass").toString("base64");
    expect(headers["Authorization"]).toBe(expected);
  });

  it("V1 without credentials: no Authorization header", async () => {
    const { Influx } = await import("../transport/influx.js");
    const influx = new Influx({ version: 1, host: "h", database: "db" });
    await influx.send([makeAggregate({ uri: "x", namespace: "app" }, 1)]);
    const headers = requests[0].options.headers as Record<string, string>;
    expect(headers["Authorization"]).toBeUndefined();
  });
});

// ─── HTTP protocol selection ──────────────────────────────────────────────────

describe("Influx HTTP protocol selection", () => {
  it("V1 defaults to http", async () => {
    const { Influx } = await import("../transport/influx.js");
    const influx = new Influx({ version: 1, host: "h", database: "db" });
    await influx.send([makeAggregate({ uri: "x", namespace: "app" }, 1)]);
    expect(requests[0].protocol).toBe("http");
  });

  it("V2 defaults to https", async () => {
    const { Influx } = await import("../transport/influx.js");
    const influx = new Influx({ version: 2, host: "h", org: "o", bucket: "b", token: "t" });
    await influx.send([makeAggregate({ uri: "x", namespace: "app" }, 1)]);
    expect(requests[0].protocol).toBe("https");
  });

  it("protocol override works for V2", async () => {
    const { Influx } = await import("../transport/influx.js");
    const influx = new Influx({
      version: 2,
      host: "h",
      org: "o",
      bucket: "b",
      token: "t",
      protocol: "http",
    });
    await influx.send([makeAggregate({ uri: "x", namespace: "app" }, 1)]);
    expect(requests[0].protocol).toBe("http");
  });
});

// ─── gzip compression ────────────────────────────────────────────────────────

describe("Influx gzip compression", () => {
  it("sets Content-Encoding: gzip header by default", async () => {
    const { Influx } = await import("../transport/influx.js");
    const influx = new Influx({ version: 2, host: "h", org: "o", bucket: "b", token: "t" });
    await influx.send([makeAggregate({ uri: "x", namespace: "app" }, 1)]);
    const { options, body } = requests[0];
    expect((options.headers as Record<string, string>)["Content-Encoding"]).toBe("gzip");
    expect(body).toMatch(/^x[ ,]/); // mock auto-decompresses — confirms round-trip is valid
  });

  it("omits Content-Encoding header and sends plain text when gzip: false", async () => {
    const { Influx } = await import("../transport/influx.js");
    const influx = new Influx({
      version: 2,
      host: "h",
      org: "o",
      bucket: "b",
      token: "t",
      gzip: false,
    });
    await influx.send([makeAggregate({ uri: "x", namespace: "app" }, 1)]);
    const { options, body } = requests[0];
    expect((options.headers as Record<string, string>)["Content-Encoding"]).toBeUndefined();
    expect(body).toMatch(/^x[ ,]/);
  });
});

// ─── send() error handling ────────────────────────────────────────────────────

describe("Influx send() errors", () => {
  it("rejects when the server returns a non-2xx status", async () => {
    // Override the mock to return 400
    const httpMod = await import("node:http");
    vi.mocked(httpMod).request.mockImplementationOnce(((_options: unknown, callback: (res: unknown) => void) => ({
      on: vi.fn(),
      end: vi.fn(() => callback({ statusCode: 400, resume: vi.fn() })),
    })) as any);

    const { Influx } = await import("../transport/influx.js");
    const influx = new Influx({ version: 1, host: "h", database: "db", protocol: "http" });
    await expect(influx.send([makeAggregate({ uri: "x", namespace: "app" }, 1)])).rejects.toThrow("400");
  });
});
