/**
 * Extensions' `beforeAgentTool` as one pi-durable `ToolTask.beforeTool`
 * hook. It runs for every tool call of every agent, model-issued or nested,
 * before pi-durable records the call's intent. Every failure blocks.
 */
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  AgentDoc,
  type ConversationId,
  type Harness,
  type HookApi,
  type HookRegistration,
  hook,
  ToolTask,
} from "@earendil-works/pi-durable";
import { AgentsDoc, GraphsDoc } from "../agents/records.js";
import type {
  AgentHooks,
  AgentToolContext,
  AgentToolSpawner,
  AgentToolTranscript,
} from "../hooks.js";
import { freezeValue } from "./hook-state.js";

/** The harness the hooks read context from, once it is open. */
export class ToolGate {
  private harness: Harness | undefined;
  private readonly hooksOf: readonly AgentHooks[];
  /** Registrations that gate tools, in namespace order. */
  constructor(
    private readonly sessionId: string,
    hooks: readonly AgentHooks[],
    /** Why every call is blocked: a tool approval registration was lost. */
    private readonly denial?: string,
    /** Working directory of agents that record none. */
    private readonly cwd: string = process.cwd(),
  ) {
    this.hooksOf = hooks
      .filter((each) => each.beforeAgentTool)
      .sort((a, b) =>
        a.namespace < b.namespace ? -1 : a.namespace > b.namespace ? 1 : 0,
      );
  }

  get active(): boolean {
    return this.hooksOf.length > 0 || this.denial !== undefined;
  }

  bind(harness: Harness): void {
    this.harness = harness;
  }

  unbind(): void {
    this.harness = undefined;
  }

  /** The pi-durable hooks; none without consumers, so nothing changes. */
  get hooks(): HookRegistration[] {
    if (!this.active) return [];
    return [
      hook(ToolTask, {
        beforeTool: (call, api, context) =>
          this.decide(call, api, context).catch((error) => {
            // Cancellation ends the call; it is not a verdict for the model.
            if (context.abortSignal?.aborted) throw error;
            return {
              block: `Blocked: tool approval failed (${detail(error)})`,
            };
          }),
      }),
    ];
  }

  private async decide(
    call: {
      id: string;
      name: string;
      arguments: unknown;
      parent?: { callId: string };
    },
    api: HookApi,
    context: Context,
  ): Promise<{ block: string } | undefined> {
    const signal = context.abortSignal;
    signal?.throwIfAborted();
    if (this.denial !== undefined)
      return {
        block: `Blocked: tool approval is unavailable (${this.denial})`,
      };
    const harness = this.harness;
    if (!harness) throw new Error("harness not ready");
    const id = String(api.conversationId);
    const [agents, graphs, durable] = await Promise.all([
      api.snapshot(AgentsDoc, context),
      api.snapshot(GraphsDoc, context),
      api.snapshot(AgentDoc, api.conversationId, context),
    ]);
    const agent = agents?.agents[id];
    if (!agent) throw new Error("not a known agent");
    const ref = durable?.model;
    const model = ref && api.models.getModel(ref.provider, ref.modelId);
    if (!model) throw new Error("unknown model");
    const owner = graphs?.graphs[agent.graph]?.owner?.agent;
    const reader = (agentId: string, job: string, instructions?: string) => {
      let pending: Promise<AgentToolTranscript> | undefined;
      return () => {
        pending ??= (async () => {
          const conversation = await harness.conversation(
            Number(agentId) as ConversationId,
            BACKGROUND_CONTEXT,
          );
          if (!conversation) throw new Error("conversation not found");
          const view = await conversation.context(BACKGROUND_CONTEXT);
          return freezeValue(
            structuredClone({
              job,
              ...(instructions ? { instructions } : {}),
              messages: view.messages,
              entries: view.entries.map((entry, index) => ({
                kind: entry.kind,
                durableWork: entry.byTaskId !== undefined,
                messages: view.contributions[index] ?? [],
              })),
            }),
          ) as AgentToolTranscript;
        })();
        return pending;
      };
    };
    let spawner: AgentToolSpawner | undefined;
    const spawnerRecord = owner ? agents?.agents[owner] : undefined;
    if (owner && spawnerRecord) {
      const spawnerState = await api.snapshot(
        AgentDoc,
        Number(owner) as ConversationId,
        context,
      );
      const spawnerModel = spawnerState?.model;
      spawner = Object.freeze({
        agent: Object.freeze({ id: owner, name: spawnerRecord.name }),
        ...(spawnerModel
          ? {
              model: Object.freeze({
                provider: spawnerModel.provider,
                id: spawnerModel.modelId,
              }),
            }
          : {}),
        context: reader(owner, spawnerRecord.job, spawnerState?.instructions),
      });
    } else if (owner || agent.depth > 1) {
      // A nested agent always has a recorded spawner; never guess the root.
      throw new Error("spawner record missing");
    }
    const input = freezeValue(
      structuredClone(call.arguments ?? {}),
    ) as AgentToolContext["input"];
    const ctx: AgentToolContext = Object.freeze({
      sessionId: this.sessionId,
      agent: Object.freeze({ id, name: agent.name }),
      model: Object.freeze({
        provider: model.provider,
        api: model.api,
        id: model.id,
      }),
      cwd: durable?.cwd ?? this.cwd,
      toolName: call.name,
      toolCallId: call.id,
      ...(call.parent
        ? { parent: Object.freeze({ toolCallId: call.parent.callId }) }
        : {}),
      input,
      depth: agent.depth,
      ...(spawner ? { spawner } : {}),
      context: reader(id, agent.job, durable?.instructions),
      ...(signal ? { signal } : {}),
    });
    for (const consumer of this.hooksOf) {
      signal?.throwIfAborted();
      const callback = consumer.beforeAgentTool;
      if (!callback) continue;
      let result: unknown;
      try {
        result = await abortable(
          Promise.resolve().then(() => callback(ctx)),
          signal,
        );
      } catch (error) {
        signal?.throwIfAborted();
        return {
          block: `Blocked: ${consumer.namespace} could not approve this call (${detail(error)})`,
        };
      }
      signal?.throwIfAborted();
      if (result === undefined) continue;
      const verdict = result as { block?: unknown; reason?: unknown };
      if (
        typeof result === "object" &&
        result !== null &&
        verdict.block === true
      ) {
        const reason =
          typeof verdict.reason === "string" && verdict.reason.trim()
            ? verdict.reason.trim().slice(0, 1000)
            : `Blocked by ${consumer.namespace}`;
        return { block: reason };
      }
      return {
        block: `Blocked: ${consumer.namespace} returned an invalid decision`,
      };
    }
    return undefined;
  }
}

/**
 * Why agents must not run: a required gate namespace has no accepted
 * `beforeAgentTool` registration (its extension is absent, removed,
 * duplicated or invalid), or the requirement itself is unreadable.
 */
export function requiredGateDenial(
  required: readonly string[],
  hooks: readonly AgentHooks[],
  settingsErrors: readonly string[] = [],
): string | undefined {
  if (settingsErrors.length > 0)
    return `invalid tool gate requirement: ${settingsErrors.join("; ")}`;
  const missing = required.filter(
    (namespace) =>
      !hooks.some(
        (hook) => hook.namespace === namespace && hook.beforeAgentTool,
      ),
  );
  return missing.length > 0
    ? `required tool gate not registered: ${missing.join(", ")}`
    : undefined;
}

function detail(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.replace(/\s+/g, " ").trim().slice(0, 200);
}

/** Stop waiting when aborted, even if the listener ignores its signal. */
async function abortable<T>(
  value: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (!signal) return value;
  let abort!: () => void;
  const cancelled = new Promise<never>((_resolve, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
  try {
    return await Promise.race([value, cancelled]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}
