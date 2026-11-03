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
 *   the whole budget fails fast. Aborted or stale reservations release
 *   their estimates; a late response still counts its actual usage.
 *   Compaction estimates are capped at the budget so an oversized context
 *   can still compact, admitted alone and charging one full budget.
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
const RESERVATION_LEASE_MS = 120_000;
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

interface Reservation {
  estimate: number;
  expiresAt: number;
  cleanup: () => void;
  settled: boolean;
}

interface Waiter {
  reservation: Reservation;
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
  /** Each admission owns its reservation, independently of its conversation. */
  private readonly inflight = new Set<Reservation>();
  private readonly reservations = new Map<string, Reservation[]>();
  /** Deferred responses run in a new phase runtime, but retain their task ID. */
  private readonly generation = new Map<string, Reservation>();
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
          const taskId = String(api.taskId);
          const previous = this.generation.get(taskId);
          // A prior attempt may have ended without reaching afterResponse.
          if (previous) {
            this.release(previous);
            this.generation.delete(taskId);
            this.pump();
          }
          const reservation = await this.reserve(
            this.tokensPerMinute ? estimateTokens(request.messages) : 0,
            context,
          );
          this.generation.set(taskId, reservation);
          return undefined;
        },
        afterResponse: (message, api) => {
          this.finish(this.generation.get(String(api.taskId)), {
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
        beforeCompact: async (compaction, _api, context) => {
          // Unlike generation, compaction must be able to shrink a context
          // larger than the budget; cap its reservation and estimate charge.
          const estimate = this.tokensPerMinute
            ? Math.min(
                estimateTokens(compaction.messages),
                this.tokensPerMinute,
              )
            : 0;
          const reservation = await this.reserve(estimate, context);
          // The summary's usage reaches no hook: charge without declaring
          // a provider success (which would reset rate-limit backoff).
          this.finish(reservation, { tokens: estimate }, false);
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
    for (const reservation of this.inflight) total += reservation.estimate;
    return total;
  }

  /** When requests may start again after a rate limit, or 0. */
  get backoffUntil(): number {
    return this.pausedUntil > this.now() ? this.pausedUntil : 0;
  }

  async acquire(
    agentId: string,
    estimate: number,
    context: Context,
  ): Promise<void> {
    const reservation = await this.reserve(estimate, context);
    const pending = this.reservations.get(agentId) ?? [];
    pending.push(reservation);
    this.reservations.set(agentId, pending);
  }

  private reserve(estimate: number, context: Context): Promise<Reservation> {
    const signal = context.abortSignal;
    signal?.throwIfAborted();
    if (this.tokensPerMinute !== undefined && estimate > this.tokensPerMinute)
      return Promise.reject(
        new Error(
          `Request estimate ${estimate} exceeds token budget ${this.tokensPerMinute}`,
        ),
      );
    return new Promise((resolve, reject) => {
      const reservation: Reservation = {
        estimate,
        expiresAt: 0,
        cleanup: () => signal?.removeEventListener("abort", onAbort),
        settled: false,
      };
      const waiter: Waiter = {
        reservation,
        admit: () => resolve(reservation),
      };
      const onAbort = () => {
        const index = this.waiting.indexOf(waiter);
        if (index >= 0) this.waiting.splice(index, 1);
        this.release(reservation);
        reject(signal?.reason);
        this.pump();
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.waiting.push(waiter);
      this.pump();
    });
  }

  private release(reservation: Reservation): void {
    this.inflight.delete(reservation);
    reservation.cleanup();
  }

  /** A request ended: its usage replaces its estimate, and a rate limit
   * pauses every request. */
  settle(agentId: string, outcome: { tokens: number; error?: string }): void {
    const pending = this.reservations.get(agentId);
    const reservation = pending?.shift();
    if (pending?.length === 0) this.reservations.delete(agentId);
    this.finish(reservation, outcome);
  }

  private finish(
    reservation: Reservation | undefined,
    outcome: { tokens: number; error?: string },
    response = true,
  ): void {
    if (reservation) {
      if (reservation.settled) return;
      reservation.settled = true;
      this.release(reservation);
    }
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
    } else if (response && !outcome.error) this.strikes = 0;
    this.pump();
  }

  private expire(): void {
    const now = this.now();
    for (const reservation of this.inflight)
      if (reservation.expiresAt <= now) this.release(reservation);
    // Bound correlation records too. Responses beyond the lease still charge
    // usage through finish(undefined), without touching another reservation.
    for (const [taskId, reservation] of this.generation)
      if (reservation.expiresAt <= now) this.generation.delete(taskId);
    const from = now - WINDOW_MS;
    let drop = 0;
    while (drop < this.spent.length && (this.spent[drop]?.at ?? 0) <= from)
      drop += 1;
    if (drop) this.spent.splice(0, drop);
  }

  /** Admit waiting requests in order while the budget has room; then wait
   * for the backoff's end or the window's oldest tokens to leave. */
  private pump(): void {
    this.expire();
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
        if (budget !== undefined && next.reservation.estimate > 0) {
          const used = this.used();
          if (used + next.reservation.estimate > budget) {
            const oldest = this.spent[0];
            wake = oldest ? oldest.at + WINDOW_MS : undefined;
            for (const reservation of this.inflight)
              wake = Math.min(wake ?? Infinity, reservation.expiresAt);
            break;
          }
        }
        this.waiting.shift();
        next.reservation.expiresAt = now + RESERVATION_LEASE_MS;
        this.inflight.add(next.reservation);
        next.admit();
      }
    if (wake !== undefined && this.waiting.length > 0) {
      this.timer = setTimeout(() => this.pump(), Math.max(1, wake - now));
      this.timer.unref?.();
    }
  }
}
