import { describe, expect, test } from "bun:test";
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

  test("a request larger than the budget runs alone", async () => {
    const requests = new ModelRequests({ tokensPerMinute: 100 });
    expect(await settled(requests.acquire("a", 5_000, context()))).toBe(true);
    const b = requests.acquire("b", 10, context());
    expect(await settled(b)).toBe(false);
    requests.settle("a", { tokens: 0 });
    expect(await settled(b)).toBe(true);
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
