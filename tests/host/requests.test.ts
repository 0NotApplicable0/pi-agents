import { describe, expect, spyOn, test } from "bun:test";
import type { Context } from "@earendil-works/chord";
import {
  estimateTokens,
  isRateLimit,
  ModelRequests,
  retryAfterMs,
} from "../../src/host/requests.js";
import { DEFAULT_LIMITS, readLimits } from "../../src/host/settings.js";

const context = (signal?: AbortSignal) =>
  ({ ...(signal ? { abortSignal: signal } : {}) }) as unknown as Context;

/** Invoke the registered hooks without constructing a durable session. */
function requestHooks(requests: ModelRequests) {
  type Api = { conversationId: string; taskId: string };
  type Request = { messages: unknown[] };
  return {
    generation: requests.hooks[0]?.handlers as unknown as {
      beforeRequest(request: Request, api: Api, ctx: Context): Promise<unknown>;
      afterResponse(
        message: {
          usage: { totalTokens: number };
          stopReason?: string;
          errorMessage?: string;
        },
        api: Api,
      ): void;
    },
    compaction: requests.hooks[1]?.handlers as unknown as {
      beforeCompact(request: Request, api: Api, ctx: Context): Promise<unknown>;
    },
  };
}

/** Whether a promise settled by the next turns of the event loop. */
async function settled(promise: Promise<unknown>): Promise<boolean> {
  let done = false;
  promise.then(
    () => {
      done = true;
    },
    () => {
      done = true;
    },
  );
  for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 1));
  return done;
}

describe("rate-limit errors", () => {
  test("recognizes a provider's rate limit and its delay", () => {
    expect(isRateLimit("429 Too Many Requests")).toBe(true);
    expect(isRateLimit("Rate limit reached for requests")).toBe(true);
    expect(isRateLimit("RESOURCE_EXHAUSTED: quota")).toBe(true);
    expect(isRateLimit("500 internal error")).toBe(false);
    expect(isRateLimit(undefined)).toBe(false);
    expect(retryAfterMs("429; retry-after: 7")).toBe(7_000);
    expect(retryAfterMs("retry-after-ms: 250")).toBe(250);
    expect(retryAfterMs("Please retry in 300ms")).toBe(300);
    expect(retryAfterMs("Server requested 30s retry delay")).toBe(30_000);
    expect(retryAfterMs("slow down")).toBeUndefined();
  });

  test("a request's estimate is its context's characters over four", () => {
    expect(estimateTokens([{ text: "x".repeat(389) }])).toBe(100);
  });
});

describe("model requests", () => {
  test("without a budget, requests pass at once", async () => {
    const requests = new ModelRequests();
    for (const agent of ["a", "b", "c"])
      expect(await settled(requests.acquire(agent, 0, context()))).toBe(true);
    expect(requests.queued).toBe(0);
  });

  test("the budget holds requests, in order, until the window has room", async () => {
    let now = 1_000_000;
    const requests = new ModelRequests({
      tokensPerMinute: 1_000,
      now: () => now,
    });
    expect(await settled(requests.acquire("a", 600, context()))).toBe(true);
    const b = requests.acquire("b", 600, context());
    const c = requests.acquire("c", 100, context());
    expect(await settled(b)).toBe(false);
    // First in, first out: c waits behind b though it would fit.
    expect(await settled(c)).toBe(false);
    expect(requests.queued).toBe(2);
    // a's response reports its real usage, which stays in the window.
    requests.settle("a", { tokens: 700 });
    expect(requests.used()).toBe(700);
    expect(await settled(b)).toBe(false);
    now += 61_000;
    requests.settle("other", { tokens: 0 });
    expect(await settled(b)).toBe(true);
    expect(await settled(c)).toBe(true);
    expect(requests.used()).toBe(700);
  });

  test("a request larger than the budget fails fast without blocking the queue", async () => {
    const requests = new ModelRequests({ tokensPerMinute: 100 });
    await expect(requests.acquire("a", 101, context())).rejects.toThrow(
      "exceeds token budget 100",
    );
    expect(requests.queued).toBe(0);
    expect(requests.used()).toBe(0);
    await requests.acquire("b", 100, context());
    requests.settle("b", { tokens: 0 });
  });

  test("abort after admission frees capacity, wakes waiters, and allows late usage", async () => {
    const requests = new ModelRequests({ tokensPerMinute: 100 });
    const controller = new AbortController();
    await requests.acquire("a", 100, context(controller.signal));
    const b = requests.acquire("b", 100, context());
    expect(await settled(b)).toBe(false);
    controller.abort();
    await b;
    expect(requests.used()).toBe(100);
    // A late response charges a's actual usage, without releasing b.
    requests.settle("a", { tokens: 25 });
    expect(requests.used()).toBe(125);
    requests.settle("b", { tokens: 0 });
    expect(requests.used()).toBe(25);
  });

  test("abort after settlement is a no-op for a newer reservation", async () => {
    const requests = new ModelRequests({ tokensPerMinute: 100 });
    const controller = new AbortController();
    await requests.acquire("a", 100, context(controller.signal));
    requests.settle("a", { tokens: 0 });
    await requests.acquire("a", 80, context());
    controller.abort();
    expect(requests.used()).toBe(80);
    requests.settle("a", { tokens: 0 });
  });

  test("stale reservations wake a waiter at the 120-second lease, and settle late", async () => {
    let now = 10_000;
    const requests = new ModelRequests({
      tokensPerMinute: 100,
      now: () => now,
    });
    let wake: (() => void) | undefined;
    let delay: number | undefined;
    const timer = spyOn(globalThis, "setTimeout").mockImplementation(
      (callback, ms) => {
        wake = callback as () => void;
        delay = ms;
        return { unref() {} } as unknown as ReturnType<typeof setTimeout>;
      },
    );
    const clear = spyOn(globalThis, "clearTimeout").mockImplementation(
      () => {},
    );
    try {
      await requests.acquire("a", 100, context());
      const b = requests.acquire("b", 100, context());
      expect(requests.queued).toBe(1);
      expect(delay).toBe(120_000);
      expect(wake).toBeDefined();
      now += 120_000;
      wake?.();
      await b;
      expect(requests.queued).toBe(0);
      expect(requests.used()).toBe(100);
      requests.settle("a", { tokens: 30 });
      expect(requests.used()).toBe(130);
      requests.settle("b", { tokens: 0 });
    } finally {
      timer.mockRestore();
      clear.mockRestore();
    }
  }, 1_000);

  test("simultaneous generation tasks and compaction share usage, not reservations", async () => {
    const requests = new ModelRequests({ tokensPerMinute: 1_000 });
    const { generation, compaction } = requestHooks(requests);
    const first = { conversationId: "same", taskId: "g1" };
    const second = { conversationId: "same", taskId: "g2" };
    const compact = { conversationId: "same", taskId: "c1" };
    const messages = [{ text: "x".repeat(389) }]; // 100 tokens each
    await Promise.all([
      generation.beforeRequest({ messages }, first, context()),
      generation.beforeRequest({ messages }, second, context()),
      compaction.beforeCompact({ messages }, compact, context()),
    ]);
    expect(requests.used()).toBe(300);
    generation.afterResponse({ usage: { totalTokens: 20 } }, first);
    expect(requests.used()).toBe(220);
    generation.afterResponse({ usage: { totalTokens: 30 } }, second);
    expect(requests.used()).toBe(150);
    // Repeated delivery cannot charge the same response twice.
    generation.afterResponse({ usage: { totalTokens: 30 } }, second);
    expect(requests.used()).toBe(150);
  });

  test("deferred success and error responses settle across distinct phase runtimes", async () => {
    const requests = new ModelRequests({ tokensPerMinute: 200 });
    const { generation } = requestHooks(requests);
    const request = { messages: [{ text: "x".repeat(389) }] };
    for (const error of [undefined, "429; retry-after-ms: 1"]) {
      const taskId = error ? "error-task" : "success-task";
      const requestApi = { conversationId: "same", taskId };
      const pollApi = { conversationId: "same", taskId };
      expect(requestApi).not.toBe(pollApi);
      await generation.beforeRequest(request, requestApi, context());
      generation.afterResponse(
        {
          usage: { totalTokens: 20 },
          ...(error ? { stopReason: "error", errorMessage: error } : {}),
        },
        pollApi,
      );
      expect(requests.used()).toBe(error ? 40 : 20);
    }
    expect(requests.limited).toBe(1);
  }, 1_000);

  test("the next request releases an unseen attempt of the same task", async () => {
    const requests = new ModelRequests({ tokensPerMinute: 100 });
    const { generation } = requestHooks(requests);
    const request = { messages: [{ text: "x".repeat(389) }] };
    const controller = new AbortController();
    await generation.beforeRequest(
      request,
      { conversationId: "same", taskId: "retry-task" },
      context(controller.signal),
    );
    // A stream error skipped afterResponse; retry uses a fresh phase API.
    await generation.beforeRequest(
      request,
      { conversationId: "same", taskId: "retry-task" },
      context(),
    );
    expect(requests.used()).toBe(100);
    controller.abort();
    expect(requests.used()).toBe(100);
    generation.afterResponse(
      { usage: { totalTokens: 10 } },
      { conversationId: "same", taskId: "retry-task" },
    );
    expect(requests.used()).toBe(10);
  }, 1_000);

  test("oversized compaction waits to run alone and charges only the budget", async () => {
    const requests = new ModelRequests({ tokensPerMinute: 100 });
    await requests.acquire("busy", 10, context());
    const compact = requestHooks(requests).compaction.beforeCompact(
      { messages: [{ text: "x".repeat(1_989) }] }, // 500 tokens
      { conversationId: "same", taskId: "compact" },
      context(),
    );
    expect(await settled(compact)).toBe(false);
    requests.settle("busy", { tokens: 0 });
    await compact;
    expect(requests.used()).toBe(100);
    const controller = new AbortController();
    const next = requests.acquire("next", 1, context(controller.signal));
    expect(await settled(next)).toBe(false);
    controller.abort(new Error("test cleanup"));
    await expect(next).rejects.toThrow("test cleanup");
  }, 1_000);

  test("late generation response cannot release another task's reservation", async () => {
    const requests = new ModelRequests({ tokensPerMinute: 200 });
    const { generation } = requestHooks(requests);
    const first = { conversationId: "same", taskId: "g1" };
    const second = { conversationId: "same", taskId: "g2" };
    const controller = new AbortController();
    const request = { messages: [{ text: "x".repeat(389) }] };
    await generation.beforeRequest(request, first, context(controller.signal));
    controller.abort();
    expect(requests.used()).toBe(0);
    await generation.beforeRequest(request, second, context());
    generation.afterResponse({ usage: { totalTokens: 40 } }, first);
    expect(requests.used()).toBe(140);
    generation.afterResponse({ usage: { totalTokens: 40 } }, first);
    expect(requests.used()).toBe(140);
    generation.afterResponse({ usage: { totalTokens: 20 } }, second);
    expect(requests.used()).toBe(60);
  }, 1_000);

  test("compaction charging does not reset exponential backoff", async () => {
    let now = 0;
    const requests = new ModelRequests({
      tokensPerMinute: 1_000,
      now: () => now,
      random: () => 0,
    });
    requests.settle("rate", { tokens: 0, error: "429" });
    now = 1_000;
    await requestHooks(requests).compaction.beforeCompact(
      { messages: [{ text: "x".repeat(389) }] },
      { conversationId: "same", taskId: "c1" },
      context(),
    );
    expect(requests.used()).toBe(100);
    requests.settle("rate", { tokens: 0, error: "429" });
    expect(requests.backoffUntil).toBe(3_000);
  });

  test("a rate limit pauses every agent until Retry-After, then resumes", async () => {
    const requests = new ModelRequests();
    await requests.acquire("a", 0, context());
    requests.settle("a", {
      tokens: 0,
      error: "429 Too Many Requests; retry-after-ms: 80",
    });
    expect(requests.limited).toBe(1);
    expect(requests.backoffUntil).toBeGreaterThan(Date.now());
    const started = Date.now();
    const b = requests.acquire("b", 0, context());
    expect(await settled(b)).toBe(false);
    await b;
    expect(Date.now() - started).toBeGreaterThanOrEqual(60);
  });

  test("without Retry-After the backoff doubles, and a success resets it", () => {
    let now = 0;
    const requests = new ModelRequests({ now: () => now, random: () => 0 });
    requests.settle("a", { tokens: 0, error: "rate limit" });
    expect(requests.backoffUntil).toBe(1_000);
    now = 1_000;
    requests.settle("a", { tokens: 0, error: "rate limit" });
    expect(requests.backoffUntil).toBe(3_000);
    now = 3_000;
    requests.settle("a", { tokens: 0, error: "rate limit" });
    expect(requests.backoffUntil).toBe(7_000);
    now = 7_000;
    requests.settle("a", { tokens: 10 });
    requests.settle("a", { tokens: 0, error: "rate limit" });
    expect(requests.backoffUntil).toBe(8_000);
    // Other errors neither pause nor reset.
    now = 8_000;
    requests.settle("a", { tokens: 0, error: "overloaded 500" });
    expect(requests.backoffUntil).toBe(0);
  });

  test("an agent stopped while it waits leaves the queue", async () => {
    const requests = new ModelRequests({ tokensPerMinute: 100 });
    await requests.acquire("a", 100, context());
    const controller = new AbortController();
    const b = requests.acquire("b", 50, context(controller.signal));
    const c = requests.acquire("c", 50, context());
    controller.abort(new Error("stopped"));
    await expect(b).rejects.toThrow("stopped");
    expect(requests.queued).toBe(1);
    requests.settle("a", { tokens: 0 });
    expect(await settled(c)).toBe(true);
  });

  test("it hooks generation requests and compactions", () => {
    expect(new ModelRequests().hooks).toHaveLength(2);
  });
});

test("piAgents.maxTokensPerMinute is off unless set; 0 turns it off", () => {
  expect(readLimits({}).limits.maxTokensPerMinute).toBeUndefined();
  expect(
    readLimits({ piAgents: { maxTokensPerMinute: 200_000 } }).limits
      .maxTokensPerMinute,
  ).toBe(200_000);
  const off = readLimits({ piAgents: { maxTokensPerMinute: 0 } });
  expect(off.errors).toEqual([]);
  expect(off.limits.maxTokensPerMinute).toBeUndefined();
  const wrong = readLimits({ piAgents: { maxTokensPerMinute: -5 } });
  expect(wrong.errors.join()).toContain("or 0 (no budget)");
});

test("the scale settings read like the other limits", () => {
  const { limits, errors } = readLimits({
    piAgents: {
      teamSize: 16,
      maxBroadcast: 20,
      broadcastsPerMinute: 5,
      verifyConcurrency: 2,
      judgeBracketSize: 6,
      collabRetainMessages: 500,
      collabRetainFinished: 50,
      collabRetainClosedTasks: 70,
    },
  });
  expect(errors).toEqual([]);
  expect(limits).toMatchObject({
    teamSize: 16,
    maxBroadcast: 20,
    broadcastsPerMinute: 5,
    verifyConcurrency: 2,
    judgeBracketSize: 6,
    collabRetainMessages: 500,
    collabRetainFinished: 50,
    collabRetainClosedTasks: 70,
  });
  const small = readLimits({ piAgents: { judgeBracketSize: 2, teamSize: 0 } });
  expect(small.limits.judgeBracketSize).toBe(DEFAULT_LIMITS.judgeBracketSize);
  expect(small.limits.teamSize).toBe(DEFAULT_LIMITS.teamSize);
  expect(small.errors).toHaveLength(2);
});
