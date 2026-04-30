import { vi, describe, it, expect, beforeEach } from "vitest";
import { Monitoring } from "../monitoring";
import { Monitor } from "../monitor";
import type { MonitorConfig } from "../monitor";

vi.mock("node:cluster", () => ({
  default: { isWorker: true },
}));

vi.mock("../runtime/context", () => ({
  activateContext: vi.fn(),
  deactivateContext: vi.fn(),
  destroyContext: vi.fn(),
  bumpVersion: vi.fn(),
  getContext: vi.fn().mockReturnValue({ active: false, version: 0 }),
}));

vi.mock("../transport/factory", () => ({
  createTransporter: vi.fn(() => ({
    key: "test",
    rateLimit: 10,
    retry: {},
    queue: {},
    send: vi.fn(),
  })),
  isTransporterRef: vi.fn().mockReturnValue(false),
}));

import { activateContext, deactivateContext, destroyContext, getContext } from "../runtime/context";

beforeEach(() => {
  vi.mocked(activateContext).mockReset();
  vi.mocked(deactivateContext).mockReset();
  vi.mocked(destroyContext).mockReset();
  vi.mocked(getContext).mockReset().mockReturnValue({ active: false, version: 0 });
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeConfig(namespace: string, enabled?: boolean): MonitorConfig {
  return {
    namespace,
    transporter: { type: "influx", version: 2, host: "h", org: "o", bucket: "b", token: "t" },
    ...(enabled !== undefined ? { enabled } : {}),
  };
}

// ─── Monitoring.add ──────────────────────────────────────────────────────────

describe("Monitoring.add", () => {
  it("auto-starts the monitor when enabled is true (default)", () => {
    const monitoring = new Monitoring();
    monitoring.add([makeConfig("app")]);
    expect(activateContext).toHaveBeenCalledWith("app", expect.anything(), expect.anything());
    monitoring.destroy();
  });

  it("does not start the monitor when enabled is false", () => {
    const monitoring = new Monitoring();
    monitoring.add([makeConfig("app", false)]);
    expect(activateContext).not.toHaveBeenCalled();
    monitoring.destroy();
  });

  it("registers all configs when given an array", () => {
    const monitoring = new Monitoring();
    monitoring.add([makeConfig("app"), makeConfig("auth", false)]);
    expect(activateContext).toHaveBeenCalledWith("app", expect.anything(), expect.anything());
    expect(activateContext).not.toHaveBeenCalledWith("auth", expect.anything(), expect.anything());
    monitoring.destroy();
  });
});

// ─── Monitoring.isNamespaceEnabled ───────────────────────────────────────────

describe("Monitoring.isNamespaceEnabled", () => {
  it("returns the context active flag for a known namespace", () => {
    vi.mocked(getContext).mockReturnValue({ active: true, version: 1 });
    const monitoring = new Monitoring();
    monitoring.add([makeConfig("app")]);
    expect(monitoring.isNamespaceEnabled("app")).toBe(true);
    monitoring.destroy();
  });

  it("returns false when the context is inactive", () => {
    vi.mocked(getContext).mockReturnValue({ active: false, version: 0 });
    const monitoring = new Monitoring();
    monitoring.add([makeConfig("app", false)]);
    expect(monitoring.isNamespaceEnabled("app")).toBe(false);
    monitoring.destroy();
  });
});

// ─── Monitoring.setEnabled ───────────────────────────────────────────────────

describe("Monitoring.setEnabled", () => {
  it("starts the monitor when enabling a disabled namespace", () => {
    const monitoring = new Monitoring();
    monitoring.add([makeConfig("app", false)]);
    const spy = vi.spyOn(Monitor.prototype, "start").mockImplementation(() => {});
    monitoring.setNamespaceEnabled("app", true);
    expect(spy).toHaveBeenCalledOnce();
    spy.mockRestore();
    monitoring.destroy();
  });

  it("stops the monitor when disabling an enabled namespace", () => {
    const monitoring = new Monitoring();
    monitoring.add([makeConfig("app")]);
    const spy = vi.spyOn(Monitor.prototype, "stop").mockImplementation(() => {});
    monitoring.setNamespaceEnabled("app", false);
    expect(spy).toHaveBeenCalledOnce();
    spy.mockRestore();
    monitoring.destroy();
  });

  it("is a no-op for an unknown namespace", () => {
    const monitoring = new Monitoring();
    expect(() => monitoring.setNamespaceEnabled("unknown", true)).not.toThrow();
  });

  it("respects the disabled intent on a subsequent start()", () => {
    const monitoring = new Monitoring();
    monitoring.add([makeConfig("app")]);
    monitoring.setNamespaceEnabled("app", false);
    const spy = vi.spyOn(Monitor.prototype, "start").mockImplementation(() => {});
    monitoring.start();
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
    monitoring.destroy();
  });
});

// ─── Monitoring.start ────────────────────────────────────────────────────────

describe("Monitoring.start", () => {
  it("starts all configured-enabled monitors", () => {
    const monitoring = new Monitoring();
    monitoring.add([makeConfig("app"), makeConfig("auth")]);
    const spy = vi.spyOn(Monitor.prototype, "start").mockImplementation(() => {});
    monitoring.start();
    expect(spy).toHaveBeenCalledTimes(2);
    spy.mockRestore();
    monitoring.destroy();
  });

  it("skips monitors that were explicitly disabled", () => {
    const monitoring = new Monitoring();
    monitoring.add([makeConfig("app"), makeConfig("debug", false)]);
    const spy = vi.spyOn(Monitor.prototype, "start").mockImplementation(() => {});
    monitoring.start();
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
    monitoring.destroy();
  });
});

// ─── Monitoring.stop ─────────────────────────────────────────────────────────

describe("Monitoring.stop", () => {
  it("calls stop on every registered monitor", () => {
    const monitoring = new Monitoring();
    monitoring.add([makeConfig("app"), makeConfig("auth")]);
    const spy = vi.spyOn(Monitor.prototype, "stop").mockImplementation(() => {});
    monitoring.stop();
    expect(spy).toHaveBeenCalledTimes(2);
    spy.mockRestore();
    monitoring.destroy();
  });

  it("does not change the configured intent — start() restarts enabled monitors", () => {
    const monitoring = new Monitoring();
    monitoring.add([makeConfig("app")]);
    monitoring.stop();
    const spy = vi.spyOn(Monitor.prototype, "start").mockImplementation(() => {});
    monitoring.start();
    expect(spy).toHaveBeenCalledOnce();
    spy.mockRestore();
    monitoring.destroy();
  });
});

// ─── Monitoring.reschedule ───────────────────────────────────────────────────

describe("Monitoring.reschedule", () => {
  it("delegates to the monitor's rescheduleMetric", () => {
    const monitoring = new Monitoring();
    monitoring.add([makeConfig("app")]);
    const spy = vi.spyOn(Monitor.prototype, "rescheduleMetric").mockImplementation(() => {});
    monitoring.reschedule("app", "http.requests", 5000);
    expect(spy).toHaveBeenCalledWith("http.requests", 5000);
    spy.mockRestore();
    monitoring.destroy();
  });

  it("is a no-op for an unknown namespace", () => {
    const monitoring = new Monitoring();
    expect(() => monitoring.reschedule("unknown", "http.requests", 5000)).not.toThrow();
  });
});

// ─── Monitoring.start (single namespace) ─────────────────────────────────────

describe("Monitoring.start — single namespace", () => {
  it("starts only the given namespace when its intent is enabled", () => {
    const monitoring = new Monitoring();
    monitoring.add([makeConfig("app"), makeConfig("auth")]);
    const spy = vi.spyOn(Monitor.prototype, "start").mockImplementation(() => {});
    monitoring.start("app");
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
    monitoring.destroy();
  });

  it("does not start when the namespace intent is disabled", () => {
    const monitoring = new Monitoring();
    monitoring.add([makeConfig("app", false)]);
    const spy = vi.spyOn(Monitor.prototype, "start").mockImplementation(() => {});
    monitoring.start("app");
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
    monitoring.destroy();
  });
});

// ─── Monitoring.flush (single namespace) ─────────────────────────────────────

describe("Monitoring.flush — single namespace", () => {
  it("flushes only the given namespace", async () => {
    const monitoring = new Monitoring();
    monitoring.add([makeConfig("app"), makeConfig("auth")]);
    const spy = vi.spyOn(Monitor.prototype, "flush").mockResolvedValue(undefined);
    await monitoring.flush("app");
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
    monitoring.destroy();
  });
});

// ─── Monitoring.stop (single namespace) ──────────────────────────────────────

describe("Monitoring.stop — single namespace", () => {
  it("stops only the given namespace", () => {
    const monitoring = new Monitoring();
    monitoring.add([makeConfig("app"), makeConfig("auth")]);
    const spy = vi.spyOn(Monitor.prototype, "stop").mockImplementation(() => {});
    monitoring.stop("app");
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
    monitoring.destroy();
  });
});

// ─── Monitoring.destroy ──────────────────────────────────────────────────────

describe("Monitoring.destroy", () => {
  it("calls destroy on every registered monitor", () => {
    const monitoring = new Monitoring();
    monitoring.add([makeConfig("app"), makeConfig("auth")]);
    const spy = vi.spyOn(Monitor.prototype, "destroy").mockImplementation(() => {});
    monitoring.destroy();
    expect(spy).toHaveBeenCalledTimes(2);
    spy.mockRestore();
  });

  it("removes a single namespace when given", () => {
    const monitoring = new Monitoring();
    monitoring.add([makeConfig("app"), makeConfig("auth")]);
    const spy = vi.spyOn(Monitor.prototype, "destroy").mockImplementation(() => {});
    monitoring.destroy("app");
    expect(spy).toHaveBeenCalledTimes(1);
    // auth monitor is still alive
    expect(destroyContext).not.toHaveBeenCalledWith("auth");
    spy.mockRestore();
    monitoring.destroy();
  });

  it("clears all internal state after full destroy", () => {
    const monitoring = new Monitoring();
    monitoring.add([makeConfig("app")]);
    vi.spyOn(Monitor.prototype, "destroy").mockImplementation(() => {});
    monitoring.destroy();
    // A subsequent destroy should be a no-op (map is empty)
    expect(() => monitoring.destroy()).not.toThrow();
  });
});
