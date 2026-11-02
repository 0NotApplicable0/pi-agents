/**
 * Pacing of every agent's model requests in one session: a shared backoff
 * when a provider rate-limits, and an optional token budget per minute.
 *
 * - Backoff: a request that ends in a rate-limit error (HTTP 429, "rate
 *   limit", "too many requests") holds every agent's next request until the
 *   provider's Retry-After, when its error names one, else for an
 *   exponential delay (1 s doubling to 60 s, with jitter) that a success
 *   resets. pi-ai already retries a single request after Retry-After; this
 *   keeps the other agents from piling onto a limited provider meanwhile.
 * - Budget: with `piAgents.maxTokensPerMinute`, a request waits until the
 *   tokens of the last minute's requests, plus those in flight, leave room
 *   for its estimate (its context's characters / 4). A response replaces
 *   the estimate with the tokens its usage reports. A request larger than
 *   the whole budget runs alone.
 *
 * Both act in the hooks before generation requests and compactions, after
 * the working-agents cap admitted the agent. Requests that a restart
 * resumes mid-stream pass no hook. The budget is this process's estimate:
 * it can't see other clients on the same key, so set it under the
 * provider's limit.
 */

import type { Context } from "@earendil-works/chord";
import {
  CompactionTask,
  GenerationTask,
  type HookRegistration,
  hook,
} from "@earendil-works/pi-durable";

const WINDOW_MS = 60_000;
const BACKOFF_MIN_MS = 1_000;
const BACKOFF_MAX_MS = 60_000;

/** Whether an error message is a provider's rate limit. */
export function isRateLimit(text: string | undefined): boolean {
  return (
    text !== undefined &&
    /\b429\b|rate[ _-]?limit|too many requests|resource[ _-]?exhausted/i.test(
      text,
    )
  );
}

/** The delay an error message asks for, in milliseconds: `retry-after:
 * 7`, `Retry after 2.5s`, `retry in 300ms`, or pi-ai's `Server requested
 * 30s retry delay`. */
export function retryAfterMs(text: string | undefined): number | undefined {
  if (!text) return undefined;
  const match =
    /retry[- ]?after(?:-ms)?["':=\s]*([\d.]+)\s*(ms|milliseconds?|s|sec(?:onds?)?)?/i.exec(
      text,
    ) ??
    /retry (?:again )?in\s*([\d.]+)\s*(ms|milliseconds?|s|sec(?:onds?)?)?/i.exec(
      text,
    ) ??
    /requested ([\d.]+)(s) retry delay/i.exec(text);
  if (!match) return undefined;
  const value = Number.parseFloat(match[1] as string);
  if (!Number.isFinite(value) || value < 0) return undefined;
  const unit = match[2]?.toLowerCase() ?? "s";
  const ms =
    unit.startsWith("ms") || unit.startsWith("milli") ? value : value * 1_000;
  return /retry[- ]?after-ms/i.test(match[0]) ? value : ms;
}

/** Tokens a request's context holds, roughly. */
export function estimateTokens(messages: readonly unknown[]): number {
  let chars = 0;
  for (const message of messages) chars += JSON.stringify(message).length;
  return Math.ceil(chars / 4);
}

interface Waiter {
  agentId: string;
  estimate: number;
  admit: () => void;
}

export interface ModelRequestOptions {
  /** Tokens per minute across agents; absent for no budget. */
  tokensPerMinute?: number;
  now?: () => number;
  random?: () => number;
}

export class ModelRequests {
  readonly tokensPerMinute: number | undefined;
  private readonly now: () => number;
  private readonly random: () => number;
  /** Tokens of requests that ended within the window. */
  private spent: Array<{ at: number; tokens: number }> = [];
  /** Estimates of requests in flight, by agent. */
  private readonly inflight = new Map<string, number>();
  private readonly waiting: Waiter[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  /** No request starts before this time. */
  private pausedUntil = 0;
  private strikes = 0;
  /** Rate limits seen, for status. */
  limited = 0;

  readonly hooks: readonly HookRegistration[];

  constructor(options: ModelRequestOptions = {}) {
    this.tokensPerMinute = options.tokensPerMinute;
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
    this.hooks = [
      hook(GenerationTask, {
        beforeRequest: async (request, api, context) => {
          await this.acquire(
            String(api.conversationId),
            this.tokensPerMinute ? estimateTokens(request.messages) : 0,
            context,
          );
          return undefined;
        },
        afterResponse: (message, api) => {
          this.settle(String(api.conversationId), {
            tokens:
              message.usage.totalTokens ||
              message.usage.input +
                message.usage.output +
                message.usage.cacheRead +
                message.usage.cacheWrite,
            ...(message.stopReason === "error" && message.errorMessage
              ? { error: message.errorMessage }
              : {}),
          });
        },
      }),
      hook(CompactionTask, {
        beforeCompact: async (compaction, api, context) => {
          const agentId = String(api.conversationId);
          const estimate = this.tokensPerMinute
            ? estimateTokens(compaction.messages)
            : 0;
          await this.acquire(agentId, estimate, context);
          // The summary's usage reaches no hook: its estimate counts.
          this.settle(agentId, { tokens: estimate });
          return undefined;
        },
      }),
    ];
  }

  /** Requests waiting for the budget or a backoff. */
  get queued(): number {
    return this.waiting.length;
  }

  /** Tokens of the last minute, in flight included. */
  used(): number {
    this.expire();
    let total = 0;
    for (const each of this.spent) total += each.tokens;
    for (const estimate of this.inflight.values()) total += estimate;
    return total;
  }

  /** When requests may start again after a rate limit, or 0. */
  get backoffUntil(): number {
    return this.pausedUntil > this.now() ? this.pausedUntil : 0;
  }

  acquire(agentId: string, estimate: number, context: Context): Promise<void> {
    const signal = context.abortSignal;
    signal?.throwIfAborted();
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        agentId,
        estimate,
        admit: () => {
          signal?.removeEventListener("abort", onAbort);
          resolve();
        },
      };
      const onAbort = () => {
        const index = this.waiting.indexOf(waiter);
        if (index >= 0) this.waiting.splice(index, 1);
        reject(signal?.reason);
        this.pump();
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.waiting.push(waiter);
      this.pump();
    });
  }

  /** A request ended: its usage replaces its estimate, and a rate limit
   * pauses every request. */
  settle(agentId: string, outcome: { tokens: number; error?: string }): void {
    this.inflight.delete(agentId);
    const now = this.now();
    if (outcome.tokens > 0)
      this.spent.push({ at: now, tokens: outcome.tokens });
    if (outcome.error && isRateLimit(outcome.error)) {
      this.limited += 1;
      this.strikes += 1;
      const given = retryAfterMs(outcome.error);
      const asked =
        given === undefined ? undefined : Math.min(given, BACKOFF_MAX_MS * 5);
      const delay =
        asked ??
        Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** (this.strikes - 1)) *
          (1 - this.random() * 0.25);
      this.pausedUntil = Math.max(this.pausedUntil, now + delay);
    } else if (!outcome.error) this.strikes = 0;
    this.pump();
  }

  private expire(): void {
    const from = this.now() - WINDOW_MS;
    let drop = 0;
    while (drop < this.spent.length && (this.spent[drop]?.at ?? 0) <= from)
      drop += 1;
    if (drop) this.spent.splice(0, drop);
  }

  /** Admit waiting requests in order while the budget has room; then wait
   * for the backoff's end or the window's oldest tokens to leave. */
  private pump(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    const now = this.now();
    let wake: number | undefined;
    if (this.pausedUntil > now) wake = this.pausedUntil;
    else
      while (this.waiting.length > 0) {
        const next = this.waiting[0] as Waiter;
        const budget = this.tokensPerMinute;
        if (budget !== undefined && next.estimate > 0) {
          const used = this.used();
          if (used > 0 && used + next.estimate > budget) {
            // Room comes as the oldest spent tokens leave the window; with
            // only requests in flight, their responses pump again.
            const oldest = this.spent[0];
            wake = oldest ? oldest.at + WINDOW_MS + 1 : undefined;
            break;
          }
        }
        this.waiting.shift();
        // One request of an agent is in flight at a time: a new one
        // replaces an estimate whose request ended unseen (aborted).
        if (next.estimate > 0) this.inflight.set(next.agentId, next.estimate);
        next.admit();
      }
    if (wake !== undefined && this.waiting.length > 0) {
      this.timer = setTimeout(() => this.pump(), Math.max(1, wake - now));
      this.timer.unref?.();
    }
  }
}
