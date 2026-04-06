import { Registry } from "../registry";
import { Recorder } from "./recorder";
import { Context } from "../types";

const context = new Map<string, Context>();

export function getContext(namespace: string): Context {
  let ctx = context.get(namespace);
  if (!ctx) {
    ctx = { active: false, version: 0 };
    context.set(namespace, ctx);
  }
  return ctx;
}

export function activateContext(namespace: string, registry: Registry, recorder: Recorder): void {
  const ctx = getContext(namespace);
  ctx.registry = registry;
  ctx.recorder = recorder;
  ctx.version++;
  ctx.active = true;
}

export function deactivateContext(namespace: string, clearReferences: boolean): void {
  const ctx = getContext(namespace);
  ctx.active = false;
  if (clearReferences) {
    ctx.registry = undefined;
    ctx.recorder = undefined;
  }
  ctx.version++;
}

export function destroyContext(namespace: string): void {
  context.delete(namespace);
}

export function bumpVersion(namespace: string): void {
  const ctx = getContext(namespace);
  ctx.version++;
}

/**
 * Returns the namespaces of all currently active contexts.
 * Used by sensors to resolve the target namespace when none is specified.
 */
export function getActiveNamespaces(): string[] {
  const active: string[] = [];
  for (const [ns, ctx] of context) {
    if (ctx.active) active.push(ns);
  }
  return active;
}
