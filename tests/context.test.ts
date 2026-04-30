import { describe, it, expect, afterEach } from "vitest";
import { activateContext, deactivateContext, destroyContext, getActiveNamespaces } from "../runtime/context";
import { Registry } from "../registry";

// Tests for the real (non-mocked) context module.
// Uses a dedicated namespace to avoid interference with other tests;
// destroyContext cleans up the singleton map in afterEach.

const NS = "context-unit-test";

afterEach(() => {
  destroyContext(NS);
});

describe("getActiveNamespaces", () => {
  it("returns the namespace when its context is active", () => {
    const registry = new Registry(NS);
    activateContext(NS, registry);

    expect(getActiveNamespaces()).toContain(NS);

    deactivateContext(NS, true);
  });

  it("excludes namespaces whose context is inactive", () => {
    const registry = new Registry(NS);
    activateContext(NS, registry);
    deactivateContext(NS, false);

    expect(getActiveNamespaces()).not.toContain(NS);
  });
});
