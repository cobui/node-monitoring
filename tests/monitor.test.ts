import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import { Monitor } from "../monitor";
import type { MonitorConfig } from "../monitor";

// Run all tests as a cluster worker so Monitor never tries to instantiate
// TransportListener — listener behaviour is tested in transport/listener tests.
vi.mock("node:cluster", () => ({
  default: { isWorker: true },
}));

vi.mock("../runtime/context", () => ({
  activateContext: vi.fn(),
  deactivateContext: vi.fn(),
  destroyContext: vi.fn(),
  bumpVersion: vi.fn(),
}));

vi.mock("../transport/factory", () => ({
  createTransporter: vi.fn(() => ({
    key: "test",
    rateLimit: 10,
    retry: {},
    queue: {},
    send: vi.fn(),
  })),
}));

import { activateContext, deactivateContext, destroyContext } from "../runtime/context";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeConfig(overrides: Partial<MonitorConfig> = {}): MonitorConfig {
  return {
    namespace: "test",
    transporter: { type: "influx", version: 2, host: "h", org: "o", bucket: "b", token: "t" },
    ...overrides,
  };
}

beforeEach(() => {
  vi.mocked(activateContext).mockReset();
  vi.mocked(deactivateContext).mockReset();
  vi.mocked(destroyContext).mockReset();
});

// ─── Monitor.start ───────────────────────────────────────────────────────────

describe("Monitor.start", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("activates the context with the correct namespace, registry, and recorder", () => {
    const monitor = new Monitor(makeConfig({ namespace: "myapp" }));
    monitor.start();

    expect(activateContext).toHaveBeenCalledOnce();
    expect(activateContext).toHaveBeenCalledWith("myapp", expect.anything(), expect.anything());
    monitor.destroy();
  });

  it("starts the collector timers", () => {
    const monitor = new Monitor(
      makeConfig({
        metrics: [{ uri: "hits", type: "counter", interval: 1000, reset: false, enabled: true }],
      }),
    );
    monitor.start();
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    monitor.destroy();
  });

  it("is idempotent — a second call does not create duplicate timers", () => {
    const monitor = new Monitor(
      makeConfig({
        metrics: [{ uri: "hits", type: "counter", interval: 1000, reset: false, enabled: true }],
      }),
    );
    monitor.start();
    const timersBefore = vi.getTimerCount();
    monitor.start();
    expect(vi.getTimerCount()).toBe(timersBefore);
    monitor.destroy();
  });
});

// ─── Monitor.stop ────────────────────────────────────────────────────────────

describe("Monitor.stop", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("deactivates the context without clearing references", () => {
    const monitor = new Monitor(makeConfig({ namespace: "myapp" }));
    monitor.start();
    monitor.stop();

    expect(deactivateContext).toHaveBeenCalledWith("myapp", false);
  });

  it("clears the collector timers", () => {
    const monitor = new Monitor(
      makeConfig({
        metrics: [{ uri: "hits", type: "counter", interval: 1000, reset: false, enabled: true }],
      }),
    );
    monitor.start();
    monitor.stop();
    expect(vi.getTimerCount()).toBe(0);
  });
});

// ─── Monitor.destroy ─────────────────────────────────────────────────────────

describe("Monitor.destroy", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("deactivates context and clears all references", () => {
    const monitor = new Monitor(makeConfig({ namespace: "myapp" }));
    monitor.start();
    monitor.destroy();

    expect(deactivateContext).toHaveBeenCalledWith("myapp", true);
  });

  it("removes the context from the runtime map", () => {
    const monitor = new Monitor(makeConfig({ namespace: "myapp" }));
    monitor.start();
    monitor.destroy();

    expect(destroyContext).toHaveBeenCalledWith("myapp");
  });

  it("clears the collector timers", () => {
    const monitor = new Monitor(
      makeConfig({
        metrics: [{ uri: "hits", type: "counter", interval: 1000, reset: false, enabled: true }],
      }),
    );
    monitor.start();
    monitor.destroy();
    expect(vi.getTimerCount()).toBe(0);
  });
});

// ─── Monitor.setMetricEnabled ────────────────────────────────────────────────

describe("Monitor.setMetricEnabled", () => {
  it("does not throw for a registered uri", () => {
    const monitor = new Monitor(
      makeConfig({
        metrics: [{ uri: "hits", type: "counter", interval: 1000, reset: false, enabled: true }],
      }),
    );
    expect(() => monitor.setMetricEnabled("hits", false)).not.toThrow();
  });

  it("does not throw for an unknown uri", () => {
    const monitor = new Monitor(makeConfig());
    expect(() => monitor.setMetricEnabled("nonexistent", false)).not.toThrow();
  });
});
