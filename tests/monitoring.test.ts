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
  it("stores each monitor so it can be retrieved by namespace", () => {
    const monitoring = new Monitoring();
    monitoring.add([makeConfig("app")]);
    expect(monitoring.get("app")).toBeInstanceOf(Monitor);
    monitoring.destroy();
  });

  it("registers all configs when given an array", () => {
    const monitoring = new Monitoring();
    monitoring.add([makeConfig("app"), makeConfig("auth", false)]);
    expect(monitoring.get("app")).toBeDefined();
    expect(monitoring.get("auth")).toBeDefined();
    monitoring.destroy();
  });

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
});

// ─── Monitoring.get ──────────────────────────────────────────────────────────

describe("Monitoring.get", () => {
  it("returns undefined for an unknown namespace", () => {
    const monitoring = new Monitoring();
    expect(monitoring.get("unknown")).toBeUndefined();
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
    const monitor = monitoring.get("app")!;
    const spy = vi.spyOn(monitor, "start").mockImplementation(() => {});
    monitoring.setNamespaceEnabled("app", true);
    expect(spy).toHaveBeenCalledOnce();
    monitoring.destroy();
  });

  it("stops the monitor when disabling an enabled namespace", () => {
    const monitoring = new Monitoring();
    monitoring.add([makeConfig("app")]);
    const monitor = monitoring.get("app")!;
    const spy = vi.spyOn(monitor, "stop").mockImplementation(() => {});
    monitoring.setNamespaceEnabled("app", false);
    expect(spy).toHaveBeenCalledOnce();
    monitoring.destroy();
  });

  it("is a no-op for an unknown namespace", () => {
    const monitoring = new Monitoring();
    expect(() => monitoring.setNamespaceEnabled("unknown", true)).not.toThrow();
  });

  it("respects the disabled intent on a subsequent start()", () => {
    const monitoring = new Monitoring();
    monitoring.add([makeConfig("app")]);
    const monitor = monitoring.get("app")!;
    monitoring.setNamespaceEnabled("app", false);
    const spy = vi.spyOn(monitor, "start").mockImplementation(() => {});
    monitoring.start();
    expect(spy).not.toHaveBeenCalled();
    monitoring.destroy();
  });
});

// ─── Monitoring.start ────────────────────────────────────────────────────────

describe("Monitoring.start", () => {
  it("starts all configured-enabled monitors", () => {
    const monitoring = new Monitoring();
    monitoring.add([makeConfig("app"), makeConfig("auth")]);
    const a = monitoring.get("app")!;
    const b = monitoring.get("auth")!;

    const spyA = vi.spyOn(a, "start").mockImplementation(() => {});
    const spyB = vi.spyOn(b, "start").mockImplementation(() => {});
    monitoring.start();

    expect(spyA).toHaveBeenCalledOnce();
    expect(spyB).toHaveBeenCalledOnce();
    monitoring.destroy();
  });

  it("skips monitors that were explicitly disabled", () => {
    const monitoring = new Monitoring();
    monitoring.add([makeConfig("app"), makeConfig("debug", false)]);
    const a = monitoring.get("app")!;
    const b = monitoring.get("debug")!;

    const spyA = vi.spyOn(a, "start").mockImplementation(() => {});
    const spyB = vi.spyOn(b, "start").mockImplementation(() => {});
    monitoring.start();

    expect(spyA).toHaveBeenCalledOnce();
    expect(spyB).not.toHaveBeenCalled();
    monitoring.destroy();
  });
});

// ─── Monitoring.stop ─────────────────────────────────────────────────────────

describe("Monitoring.stop", () => {
  it("calls stop on every registered monitor", () => {
    const monitoring = new Monitoring();
    monitoring.add([makeConfig("app"), makeConfig("auth")]);
    const a = monitoring.get("app")!;
    const b = monitoring.get("auth")!;

    const spyA = vi.spyOn(a, "stop").mockImplementation(() => {});
    const spyB = vi.spyOn(b, "stop").mockImplementation(() => {});
    monitoring.stop();

    expect(spyA).toHaveBeenCalledOnce();
    expect(spyB).toHaveBeenCalledOnce();
    monitoring.destroy();
  });

  it("does not change the configured intent — start() restarts enabled monitors", () => {
    const monitoring = new Monitoring();
    monitoring.add([makeConfig("app")]);
    const monitor = monitoring.get("app")!;
    monitoring.stop();
    const spy = vi.spyOn(monitor, "start").mockImplementation(() => {});
    monitoring.start();
    expect(spy).toHaveBeenCalledOnce();
    monitoring.destroy();
  });
});

// ─── Monitoring.reschedule ───────────────────────────────────────────────────

describe("Monitoring.reschedule", () => {
  it("delegates to the monitor's rescheduleMetric", () => {
    const monitoring = new Monitoring();
    monitoring.add([makeConfig("app")]);
    const monitor = monitoring.get("app")!;
    const spy = vi.spyOn(monitor, "rescheduleMetric").mockImplementation(() => {});
    monitoring.reschedule("app", "http.requests", 5000);
    expect(spy).toHaveBeenCalledWith("http.requests", 5000);
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
    const a = monitoring.get("app")!;
    const b = monitoring.get("auth")!;
    const spyA = vi.spyOn(a, "start").mockImplementation(() => {});
    const spyB = vi.spyOn(b, "start").mockImplementation(() => {});
    monitoring.start("app");
    expect(spyA).toHaveBeenCalledOnce();
    expect(spyB).not.toHaveBeenCalled();
    monitoring.destroy();
  });

  it("does not start when the namespace intent is disabled", () => {
    const monitoring = new Monitoring();
    monitoring.add([makeConfig("app", false)]);
    const monitor = monitoring.get("app")!;
    const spy = vi.spyOn(monitor, "start").mockImplementation(() => {});
    monitoring.start("app");
    expect(spy).not.toHaveBeenCalled();
    monitoring.destroy();
  });
});

// ─── Monitoring.flush (single namespace) ─────────────────────────────────────

describe("Monitoring.flush — single namespace", () => {
  it("flushes only the given namespace", async () => {
    const monitoring = new Monitoring();
    monitoring.add([makeConfig("app"), makeConfig("auth")]);
    const a = monitoring.get("app")!;
    const b = monitoring.get("auth")!;
    const spyA = vi.spyOn(a, "flush").mockResolvedValue(undefined);
    const spyB = vi.spyOn(b, "flush").mockResolvedValue(undefined);
    await monitoring.flush("app");
    expect(spyA).toHaveBeenCalledOnce();
    expect(spyB).not.toHaveBeenCalled();
    monitoring.destroy();
  });
});

// ─── Monitoring.stop (single namespace) ──────────────────────────────────────

describe("Monitoring.stop — single namespace", () => {
  it("stops only the given namespace", () => {
    const monitoring = new Monitoring();
    monitoring.add([makeConfig("app"), makeConfig("auth")]);
    const a = monitoring.get("app")!;
    const b = monitoring.get("auth")!;
    const spyA = vi.spyOn(a, "stop").mockImplementation(() => {});
    const spyB = vi.spyOn(b, "stop").mockImplementation(() => {});
    monitoring.stop("app");
    expect(spyA).toHaveBeenCalledOnce();
    expect(spyB).not.toHaveBeenCalled();
    monitoring.destroy();
  });
});

// ─── Monitoring.destroy ──────────────────────────────────────────────────────

describe("Monitoring.destroy", () => {
  it("calls destroy on every registered monitor", () => {
    const monitoring = new Monitoring();
    monitoring.add([makeConfig("app"), makeConfig("auth")]);
    const a = monitoring.get("app")!;
    const b = monitoring.get("auth")!;

    const spyA = vi.spyOn(a, "destroy").mockImplementation(() => {});
    const spyB = vi.spyOn(b, "destroy").mockImplementation(() => {});
    monitoring.destroy();

    expect(spyA).toHaveBeenCalledOnce();
    expect(spyB).toHaveBeenCalledOnce();
  });

  it("clears the internal monitor map", () => {
    const monitoring = new Monitoring();
    monitoring.add([makeConfig("app")]);

    vi.spyOn(monitoring.get("app")!, "destroy").mockImplementation(() => {});
    monitoring.destroy();

    expect(monitoring.get("app")).toBeUndefined();
  });
});
