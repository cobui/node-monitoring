import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeTransporter(overrides: Record<string, unknown> = {}) {
  const t: any = {
    key: "test",
    rateLimit: 100, // 10ms interval — fast for tests
    retry: {},
    queue: { batchSize: 1 }, // batchSize:1 preserves one-item-per-drain for rate-limit tests
    send: vi.fn(),
    ...overrides,
  };
  return t;
}

function makeAggregate(namespace = "app"): import("../types").Aggregate<unknown> {
  return { tags: { namespace }, value: 1, timestamp: 0 };
}

// ─── TransportQueue constructor ──────────────────────────────────────────────

describe("TransportQueue constructor", () => {
  it("throws for rateLimit of 0", async () => {
    const { TransportQueue } = await import("../transport/queue.js");
    expect(() => new TransportQueue({ key: "t", rateLimit: 0, retry: {}, queue: {}, send: vi.fn() } as any)).toThrow(
      "invalid rateLimit",
    );
  });

  it("throws for negative rateLimit", async () => {
    const { TransportQueue } = await import("../transport/queue.js");
    expect(() => new TransportQueue({ key: "t", rateLimit: -5, retry: {}, queue: {}, send: vi.fn() } as any)).toThrow(
      "invalid rateLimit",
    );
  });
});

// ─── TransportQueue — edge cases ─────────────────────────────────────────────

describe("TransportQueue — edge cases", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("drain is a no-op when the queues are empty", async () => {
    const { TransportQueue } = await import("../transport/queue.js");
    const t = makeTransporter({ retry: { retries: 0 } });
    const q = new TransportQueue(t as any);
    // Call drain() directly on an empty queue — covers the batch.length === 0 guard.
    await (q as any).drain();
    expect(t.send).not.toHaveBeenCalled();
    q.destroy();
  });

  it("drainAll cancels a pending drain timer before flushing", async () => {
    const { TransportQueue } = await import("../transport/queue.js");
    const t = makeTransporter({ rateLimit: 1, retry: { retries: 0 } });
    const q = new TransportQueue(t as any);
    q.enqueue(makeAggregate()); // schedules a drain timer (1000ms)
    // drainAll() before the timer fires → cancels the timer, drains immediately.
    await q.drainAll();
    expect(t.send).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    q.destroy();
  });

  it("records loss with 'unknown' namespace when the namespace tag is absent", async () => {
    const { TransportQueue } = await import("../transport/queue.js");
    const t = makeTransporter({
      rateLimit: 1000,
      retry: { retries: 0 },
      queue: { maxSize: 0, lossInterval: 50 },
    });
    const q = new TransportQueue(t as any);
    q.enqueue({ tags: {}, value: 1, timestamp: 0 }); // no namespace tag → "unknown"
    await vi.advanceTimersByTimeAsync(50); // loss flush
    await vi.advanceTimersByTimeAsync(1000); // drain
    const lossCall = (t.send as any).mock.calls.find((c: any[]) => c[0][0]?.tags.metric === "monitoring.loss");
    expect(lossCall[0][0].tags.namespace).toBe("unknown");
    q.destroy();
  });
});

// ─── TransportQueue — basic drain ────────────────────────────────────────────

describe("TransportQueue.enqueue / drain", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("calls transporter.send after the rate-limit interval", async () => {
    const { TransportQueue } = await import("../transport/queue.js");
    const t = makeTransporter({ rateLimit: 10, retry: { retries: 0 } }); // 100ms
    const q = new TransportQueue(t as any);
    q.enqueue(makeAggregate());
    expect(t.send).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(100);
    expect(t.send).toHaveBeenCalledOnce();
    q.destroy();
  });

  it("sends one item per interval (rate limiting)", async () => {
    const { TransportQueue } = await import("../transport/queue.js");
    const t = makeTransporter({ rateLimit: 10, retry: { retries: 0 } });
    const q = new TransportQueue(t as any);
    q.enqueue(makeAggregate());
    q.enqueue(makeAggregate());
    await vi.advanceTimersByTimeAsync(100);
    expect(t.send).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(100);
    expect(t.send).toHaveBeenCalledTimes(2);
    q.destroy();
  });

  it("destroy cancels the pending drain timer", async () => {
    const { TransportQueue } = await import("../transport/queue.js");
    const t = makeTransporter({ rateLimit: 10, retry: { retries: 0 } });
    const q = new TransportQueue(t as any);
    q.enqueue(makeAggregate());
    q.destroy();
    await vi.advanceTimersByTimeAsync(200);
    expect(t.send).not.toHaveBeenCalled();
  });
});

// ─── TransportQueue — priority drain order ────────────────────────────────────

describe("TransportQueue — priority drain order", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("drains priority items before normal items", async () => {
    const { TransportQueue } = await import("../transport/queue.js");
    const order: unknown[] = [];
    const t = makeTransporter({
      rateLimit: 1, // 1000ms drain interval — slow enough that loss flush fires first
      retry: { retries: 0 },
      queue: { maxSize: 1, lossInterval: 50 },
      send: vi.fn((items: any[]) => {
        order.push(...items);
      }),
    });
    const q = new TransportQueue(t as any);

    // Fill the normal queue (one slot), then overflow — records loss
    q.enqueue({ tags: { namespace: "app" }, value: 1, timestamp: 0 });
    q.enqueue({ tags: { namespace: "app" }, value: 2, timestamp: 0 }); // overflows

    // t=50: loss flush fires → pushes loss aggregate to priorityQueue
    await vi.advanceTimersByTimeAsync(50);
    // t=1000: drain fires → should pick priorityQueue (loss) first
    await vi.advanceTimersByTimeAsync(950);
    expect((order[0] as any).tags.metric).toBe("monitoring.loss");

    // t=2000: next drain → normal item
    await vi.advanceTimersByTimeAsync(1000);
    expect((order[1] as any).tags.metric).toBeUndefined();
    q.destroy();
  });
});

// ─── TransportQueue — exponential backoff ────────────────────────────────────

describe("TransportQueue — exponential backoff", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("waits minTimeout before the first retry", async () => {
    const { TransportQueue } = await import("../transport/queue.js");
    const t = makeTransporter({
      rateLimit: 1000,
      retry: { retries: 1, minTimeout: 500, maxTimeout: 10_000, factor: 2 },
      send: vi.fn().mockRejectedValueOnce(new Error("fail")).mockResolvedValue(undefined),
    });
    const q = new TransportQueue(t as any);
    q.enqueue(makeAggregate());
    await vi.advanceTimersByTimeAsync(1); // drain fires, first attempt fails
    expect(t.send).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(499); // not yet at minTimeout
    expect(t.send).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1); // minTimeout reached — retry fires
    expect(t.send).toHaveBeenCalledTimes(2);
    q.destroy();
  });

  it("delay grows by factor on each attempt", async () => {
    const { TransportQueue } = await import("../transport/queue.js");
    const calls: number[] = [];
    let lastCallTime = 0;
    const t = makeTransporter({
      rateLimit: 1000,
      retry: { retries: 2, minTimeout: 100, maxTimeout: 10_000, factor: 3 },
      send: vi.fn().mockImplementation(() => {
        calls.push(Number(vi.getMockedSystemTime()) - lastCallTime);
        lastCallTime = Number(vi.getMockedSystemTime());
        return Promise.reject(new Error("fail"));
      }),
    });
    vi.setSystemTime(0);
    lastCallTime = 0;
    const q = new TransportQueue(t as any);
    q.enqueue(makeAggregate());
    await vi.advanceTimersByTimeAsync(1); // attempt 0
    await vi.advanceTimersByTimeAsync(100); // attempt 1 after 100ms (factor^0 * min)
    await vi.advanceTimersByTimeAsync(300); // attempt 2 after 300ms (factor^1 * min)
    expect(t.send).toHaveBeenCalledTimes(3);
    q.destroy();
  });

  it("caps delay at maxTimeout", async () => {
    const { TransportQueue } = await import("../transport/queue.js");
    const t = makeTransporter({
      rateLimit: 1000,
      retry: { retries: 1, minTimeout: 1_000, maxTimeout: 500, factor: 10 },
      send: vi.fn().mockRejectedValueOnce(new Error()).mockResolvedValue(undefined),
    });
    const q = new TransportQueue(t as any);
    q.enqueue(makeAggregate());
    await vi.advanceTimersByTimeAsync(1); // first attempt fails
    await vi.advanceTimersByTimeAsync(500); // capped at maxTimeout (not 1000*10)
    expect(t.send).toHaveBeenCalledTimes(2);
    q.destroy();
  });

  it("records loss after all retries exhausted", async () => {
    const { TransportQueue } = await import("../transport/queue.js");
    const t = makeTransporter({
      rateLimit: 1000,
      retry: { retries: 1, minTimeout: 10, maxTimeout: 10, factor: 1 },
      queue: { lossInterval: 100 },
      send: vi.fn().mockRejectedValue(new Error("always fails")),
    });
    const q = new TransportQueue(t as any);
    q.enqueue(makeAggregate("app"));
    await vi.advanceTimersByTimeAsync(1); // attempt 0 fails
    await vi.advanceTimersByTimeAsync(10); // retry 1 fails — loss recorded
    await vi.advanceTimersByTimeAsync(100); // loss flush fires
    // loss aggregate is in priority queue — drain it
    await vi.advanceTimersByTimeAsync(1);
    const lossCall = (t.send as any).mock.calls.find((c: any[]) => c[0][0]?.tags.metric === "monitoring.loss");
    expect(lossCall).toBeDefined();
    expect(lossCall[0][0].tags.namespace).toBe("app");
    expect(lossCall[0][0].value).toBe(1);
    q.destroy();
  });
});

// ─── TransportQueue — max size / overflow ────────────────────────────────────

describe("TransportQueue — max size", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("drops the incoming item when the normal queue is full", async () => {
    const { TransportQueue } = await import("../transport/queue.js");
    const t = makeTransporter({ rateLimit: 1, retry: { retries: 0 }, queue: { maxSize: 1 } });
    const q = new TransportQueue(t as any);
    q.enqueue(makeAggregate()); // accepted
    q.enqueue(makeAggregate()); // dropped — queue full
    // only 1 item in queue
    await vi.advanceTimersByTimeAsync(1000);
    expect(t.send).toHaveBeenCalledTimes(1);
    q.destroy();
  });

  it("records a loss for the dropped item's namespace", async () => {
    const { TransportQueue } = await import("../transport/queue.js");
    const t = makeTransporter({
      rateLimit: 1,
      retry: { retries: 0 },
      queue: { maxSize: 0, lossInterval: 50 },
    });
    const q = new TransportQueue(t as any);
    q.enqueue(makeAggregate("myns")); // maxSize=0 → always overflows
    await vi.advanceTimersByTimeAsync(50); // loss flush
    await vi.advanceTimersByTimeAsync(1000); // drain loss aggregate
    const lossCall = (t.send as any).mock.calls.find((c: any[]) => c[0][0]?.tags.metric === "monitoring.loss");
    expect(lossCall).toBeDefined();
    expect(lossCall[0][0].tags.namespace).toBe("myns");
    expect(lossCall[0][0].value).toBe(1);
    q.destroy();
  });

  it("accumulates multiple overflows into one loss aggregate per namespace", async () => {
    const { TransportQueue } = await import("../transport/queue.js");
    const t = makeTransporter({
      rateLimit: 1000, // 1ms drain interval — drain quickly
      retry: { retries: 0 },
      queue: { maxSize: 0, lossInterval: 50, batchSize: 1 },
      send: vi.fn(),
    });
    const q = new TransportQueue(t as any);
    q.enqueue(makeAggregate("ns1"));
    q.enqueue(makeAggregate("ns1"));
    q.enqueue(makeAggregate("ns2"));
    await vi.advanceTimersByTimeAsync(50); // flush — 2 loss aggregates pushed to priorityQueue
    await vi.advanceTimersByTimeAsync(10); // drain both (2 × 1ms interval)
    const lossCalls = (t.send as any).mock.calls.filter((c: any[]) => c[0][0]?.tags.metric === "monitoring.loss");
    const ns1Loss = lossCalls.find((c: any[]) => c[0][0]?.tags.namespace === "ns1");
    const ns2Loss = lossCalls.find((c: any[]) => c[0][0]?.tags.namespace === "ns2");
    expect(ns1Loss[0][0].value).toBe(2);
    expect(ns2Loss[0][0].value).toBe(1);
    q.destroy();
  });
});

// ─── TransportQueue — loss accumulator ───────────────────────────────────────

describe("TransportQueue — loss accumulator", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("loss timer does not start until the first loss is recorded", async () => {
    const { TransportQueue } = await import("../transport/queue.js");
    const t = makeTransporter({ rateLimit: 10, retry: { retries: 0 } });
    const q = new TransportQueue(t as any);
    // no enqueue — no loss — timer count should only include drain timer (0 here)
    expect(vi.getTimerCount()).toBe(0);
    q.destroy();
  });

  it("loss timer starts on first loss and resets the accumulator after flushing", async () => {
    const { TransportQueue } = await import("../transport/queue.js");
    const t = makeTransporter({
      rateLimit: 1,
      retry: { retries: 0 },
      queue: { maxSize: 0, lossInterval: 200 },
    });
    const q = new TransportQueue(t as any);
    q.enqueue(makeAggregate("app")); // overflow → loss recorded
    q.enqueue(makeAggregate("app")); // second loss

    await vi.advanceTimersByTimeAsync(200); // first flush
    await vi.advanceTimersByTimeAsync(1000); // drain
    const calls1 = (t.send as any).mock.calls.filter((c: any[]) => c[0][0]?.tags.metric === "monitoring.loss");
    expect(calls1[0][0][0].value).toBe(2); // both accumulated

    // no new losses — next flush is a no-op (accumulator empty)
    await vi.advanceTimersByTimeAsync(200);
    const calls2 = (t.send as any).mock.calls.filter((c: any[]) => c[0][0]?.tags.metric === "monitoring.loss");
    expect(calls2.length).toBe(1); // still only one loss aggregate sent
    q.destroy();
  });

  it("destroy clears the loss timer and accumulator", async () => {
    const { TransportQueue } = await import("../transport/queue.js");
    const t = makeTransporter({
      rateLimit: 1,
      retry: { retries: 0 },
      queue: { maxSize: 0, lossInterval: 50 },
    });
    const q = new TransportQueue(t as any);
    q.enqueue(makeAggregate("app")); // records a loss, starts loss timer
    q.destroy();
    await vi.advanceTimersByTimeAsync(200); // loss timer should be gone
    expect(t.send).not.toHaveBeenCalled();
  });
});

// ─── WorkerSender ─────────────────────────────────────────────────────────────

describe("WorkerSender", () => {
  it("calls process.send with the correct TransportMessage shape", async () => {
    const { WorkerSender } = await import("../transport/sender.js");
    const processSend = vi.spyOn(process, "send").mockImplementation(() => true);
    const sender = new WorkerSender("mykey");
    const data = { tags: { env: "prod" }, value: 42, timestamp: 1000 };
    sender.enqueue(data);
    expect(processSend).toHaveBeenCalledWith({
      type: "monitoring:transport",
      key: "mykey",
      data,
    });
    processSend.mockRestore();
  });

  it("never calls transporter.send directly", async () => {
    const { WorkerSender } = await import("../transport/sender.js");
    const fakeSend = vi.fn();
    vi.spyOn(process, "send").mockImplementation(() => true);
    const sender = new WorkerSender("k");
    sender.enqueue({ tags: {}, value: 1, timestamp: 0 });
    expect(fakeSend).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });
});

// ─── Queue registry ───────────────────────────────────────────────────────────

describe("acquireQueue / releaseQueue", () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    const { _reset } = await import("../transport/queues.js");
    _reset();
  });
  afterEach(() => vi.useRealTimers());

  it("returns the same queue instance for the same transporter key", async () => {
    const { acquireQueue, releaseQueue } = await import("../transport/queues.js");
    const t = makeTransporter({ key: "shared" });
    const q1 = acquireQueue(t as any);
    const q2 = acquireQueue(t as any);
    expect(q1).toBe(q2);
    releaseQueue("shared");
    releaseQueue("shared");
  });

  it("returns different instances for different keys", async () => {
    const { acquireQueue, releaseQueue } = await import("../transport/queues.js");
    const q1 = acquireQueue(makeTransporter({ key: "a" }) as any);
    const q2 = acquireQueue(makeTransporter({ key: "b" }) as any);
    expect(q1).not.toBe(q2);
    releaseQueue("a");
    releaseQueue("b");
  });

  it("does not destroy the queue while references remain", async () => {
    const { acquireQueue, releaseQueue, getQueue } = await import("../transport/queues.js");
    const t = makeTransporter({ key: "held" });
    acquireQueue(t as any);
    acquireQueue(t as any);
    releaseQueue("held");
    expect(getQueue("held")).toBeDefined();
    releaseQueue("held");
    expect(getQueue("held")).toBeUndefined();
  });

  it("creates a fresh queue after full release", async () => {
    const { acquireQueue, releaseQueue } = await import("../transport/queues.js");
    const t = makeTransporter({ key: "fresh" });
    const q1 = acquireQueue(t as any);
    releaseQueue("fresh");
    const q2 = acquireQueue(t as any);
    expect(q1).not.toBe(q2);
    releaseQueue("fresh");
  });

  it("releaseQueue is a no-op for an unknown key", async () => {
    const { releaseQueue } = await import("../transport/queues.js");
    expect(() => releaseQueue("nonexistent")).not.toThrow();
  });
});

// ─── Listener ─────────────────────────────────────────────────────────────────

vi.mock("node:cluster", () => {
  const handlers: Map<string, Set<(...args: unknown[]) => void>> = new Map();
  return {
    default: {
      on: vi.fn((event: string, fn: (...args: unknown[]) => void) => {
        if (!handlers.has(event)) handlers.set(event, new Set());
        handlers.get(event)!.add(fn);
      }),
      off: vi.fn((event: string, fn: (...args: unknown[]) => void) => {
        handlers.get(event)?.delete(fn);
      }),
      _emit: (event: string, ...args: unknown[]) => {
        for (const fn of handlers.get(event) ?? []) fn(...args);
      },
      _handlers: handlers,
    },
  };
});

describe("activateListener / deactivateListener", () => {
  beforeEach(async () => {
    const { _reset: resetListener } = await import("../transport/listener.js");
    const { _reset: resetQueues } = await import("../transport/queues.js");
    resetListener();
    resetQueues();
    vi.useFakeTimers();
    const cluster = (await import("node:cluster")).default as any;
    cluster.on.mockClear();
    cluster.off.mockClear();
  });
  afterEach(() => vi.useRealTimers());

  it("attaches one cluster handler on first activateListener", async () => {
    const { activateListener, deactivateListener } = await import("../transport/listener.js");
    const cluster = (await import("node:cluster")).default as any;
    activateListener();
    expect(cluster.on).toHaveBeenCalledOnce();
    deactivateListener();
  });

  it("does not attach a second handler on a second call", async () => {
    const { activateListener, deactivateListener } = await import("../transport/listener.js");
    const cluster = (await import("node:cluster")).default as any;
    activateListener();
    activateListener();
    expect(cluster.on).toHaveBeenCalledOnce();
    deactivateListener();
    deactivateListener();
  });

  it("does not detach until all references are released", async () => {
    const { activateListener, deactivateListener } = await import("../transport/listener.js");
    const cluster = (await import("node:cluster")).default as any;
    activateListener();
    activateListener();
    deactivateListener();
    expect(cluster.off).not.toHaveBeenCalled();
    deactivateListener();
    expect(cluster.off).toHaveBeenCalledOnce();
  });

  it("routes a matching IPC message into the registered queue", async () => {
    const { acquireQueue, _reset: resetQueues } = await import("../transport/queues.js");
    const { activateListener, deactivateListener } = await import("../transport/listener.js");
    const cluster = (await import("node:cluster")).default as any;

    const t = makeTransporter({ key: "routed", rateLimit: 1000, retry: { retries: 0 } });
    acquireQueue(t as any);
    activateListener();

    const data = { tags: { namespace: "app" }, value: 99, timestamp: 0 };
    cluster._emit("message", {}, { type: "monitoring:transport", key: "routed", data });

    await vi.advanceTimersByTimeAsync(1);
    expect(t.send).toHaveBeenCalledWith([data]);

    deactivateListener();
    resetQueues();
  });

  it("ignores IPC messages with an unknown key", async () => {
    const { activateListener, deactivateListener } = await import("../transport/listener.js");
    const cluster = (await import("node:cluster")).default as any;
    activateListener();
    expect(() =>
      cluster._emit(
        "message",
        {},
        {
          type: "monitoring:transport",
          key: "unknown",
          data: { tags: { namespace: "app" }, value: 1, timestamp: 0 },
        },
      ),
    ).not.toThrow();
    deactivateListener();
  });

  it("deactivateListener is a no-op when refCount is already 0", async () => {
    const { deactivateListener } = await import("../transport/listener.js");
    const cluster = (await import("node:cluster")).default as any;
    // refCount is 0 after resetListener in beforeEach
    deactivateListener();
    expect(cluster.off).not.toHaveBeenCalled();
  });

  it("_reset removes the handler when one is active", async () => {
    const { activateListener, _reset } = await import("../transport/listener.js");
    const cluster = (await import("node:cluster")).default as any;
    activateListener(); // sets handler
    _reset(); // should call cluster.off with the handler
    expect(cluster.off).toHaveBeenCalledOnce();
  });

  it("ignores non-transport IPC messages", async () => {
    const { activateListener, deactivateListener } = await import("../transport/listener.js");
    const cluster = (await import("node:cluster")).default as any;
    activateListener();
    expect(() => cluster._emit("message", {}, { type: "something-else" })).not.toThrow();
    deactivateListener();
  });
});
