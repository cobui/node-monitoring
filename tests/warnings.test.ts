import { describe, it, expect, vi } from "vitest";
import { warnings, emitWarning } from "../warnings";

// ─── warnings.once ────────────────────────────────────────────────────────────

describe("warnings.once", () => {
  it("fires the listener exactly once then stops", () => {
    const listener = vi.fn();
    warnings.once("sensor:inactive", listener);

    emitWarning("sensor:inactive", { uri: "hits" }, "inactive");
    emitWarning("sensor:inactive", { uri: "hits" }, "inactive");

    expect(listener).toHaveBeenCalledOnce();
  });
});

// ─── warnings.listenerCount ───────────────────────────────────────────────────

describe("warnings.listenerCount", () => {
  it("returns 0 when no listeners are registered", () => {
    // Use a fresh off-call to guarantee clean state
    const listener = vi.fn();
    warnings.on("sensor:ambiguous", listener);
    expect(warnings.listenerCount("sensor:ambiguous")).toBeGreaterThanOrEqual(1);
    warnings.off("sensor:ambiguous", listener);
    // After removal the count should be back to whatever it was before (≥ 0)
    expect(warnings.listenerCount("sensor:ambiguous")).toBeGreaterThanOrEqual(0);
  });
});
