/**
 * Tests Monitor behaviour on the cluster primary process (isWorker = false).
 * Kept in a separate file because the cluster mock must be set at module level
 * and differs from the worker-mode mock in monitor.test.ts.
 */

import { vi, describe, it, expect } from "vitest";

vi.mock("node:cluster", () => ({ default: { isWorker: false } }));

vi.mock("../runtime/context", () => ({
  activateContext: vi.fn(),
  deactivateContext: vi.fn(),
  destroyContext: vi.fn(),
  bumpVersion: vi.fn(),
}));

vi.mock("../transport/factory", () => ({
  createTransporter: vi.fn(() => ({
    key: "primary-test",
    rateLimit: 10,
    retry: {},
    queue: {},
    send: vi.fn().mockResolvedValue(undefined),
  })),
  isTransporterRef: vi.fn().mockReturnValue(false),
}));

vi.mock("../transport/listener", () => ({
  activateListener: vi.fn(),
  deactivateListener: vi.fn(),
}));

// Return a real TransportQueue so instanceof checks pass.
vi.mock("../transport/queues", async () => {
  const { TransportQueue } = await import("../transport/queue");
  return {
    acquireQueue: vi.fn((t) => new TransportQueue(t)),
    releaseQueue: vi.fn(),
    getQueue: vi.fn(),
  };
});

import { TransportQueue } from "../transport/queue";
import { Monitor } from "../monitor";
import type { MonitorConfig } from "../monitor";
import { activateListener } from "../transport/listener";

function makeConfig(): MonitorConfig {
  return {
    namespace: "primary-test",
    transporter: { type: "influx", version: 2, host: "h", org: "o", bucket: "b", token: "t" },
  };
}

// ─── Monitor.flush — primary process ─────────────────────────────────────────

describe("Monitor — primary process", () => {
  it("activates the listener on start()", () => {
    const monitor = new Monitor(makeConfig());
    monitor.start();
    expect(vi.mocked(activateListener)).toHaveBeenCalledOnce();
    monitor.destroy();
  });

  it("calls drainAll on the TransportQueue sink during flush()", async () => {
    const drainSpy = vi.spyOn(TransportQueue.prototype, "drainAll").mockResolvedValue(undefined);

    const monitor = new Monitor(makeConfig());
    monitor.start();
    await monitor.flush();

    expect(drainSpy).toHaveBeenCalledOnce();

    drainSpy.mockRestore();
    monitor.destroy();
  });

  it("flush() awaits drainAll before resolving", async () => {
    let resolveDrain!: () => void;
    const drainSpy = vi
      .spyOn(TransportQueue.prototype, "drainAll")
      .mockImplementation(() => new Promise<void>((r) => { resolveDrain = r; }));

    const monitor = new Monitor(makeConfig());
    monitor.start();

    let flushed = false;
    const flushPromise = monitor.flush().then(() => { flushed = true; });

    // Yield twice: once for collector.flush() to start, once for collect() to complete —
    // only then does monitor.flush() reach drainAll() and set resolveDrain.
    await Promise.resolve();
    await Promise.resolve();

    expect(flushed).toBe(false); // drainAll called but not yet resolved
    resolveDrain();
    await flushPromise;
    expect(flushed).toBe(true);

    drainSpy.mockRestore();
    monitor.destroy();
  });
});
