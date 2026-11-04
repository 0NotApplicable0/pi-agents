/** Optional lifecycle protocol for co-loaded Pi extensions. */
import type { Message } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

export type AgentExtensionValue =
  | null
  | boolean
  | number
  | string
  | AgentExtensionValue[]
  | { [key: string]: AgentExtensionValue };

export type AgentExtensionState = Record<string, AgentExtensionValue>;

export type ReadonlyAgentExtensionValue =
  | null
  | boolean
  | number
  | string
  | readonly ReadonlyAgentExtensionValue[]
  | { readonly [key: string]: ReadonlyAgentExtensionValue };

export interface AgentCreateContext {
  readonly parent: {
    readonly sessionId: string;
    /** The active branch at creation, detached and frozen on first read. */
    readonly branch: readonly SessionEntry[];
  };
}

export interface AgentRequestContext {
  /** Owning Pi session, not the provider's conversation identity. */
  readonly sessionId: string;
  readonly agent: { readonly id: string; readonly name: string };
  /** Actual dispatched model, after routing. */
  readonly model: {
    readonly provider: string;
    readonly api: string;
    readonly id: string;
  };
  readonly state: ReadonlyAgentExtensionValue | undefined;
  readonly signal?: AbortSignal;
}

export interface AgentBeforeRequestContext {
  /** Owning Pi session. */
  readonly sessionId: string;
  readonly agent: { readonly id: string; readonly name: string };
  /** The agent's model; routing may still dispatch to another. */
  readonly model: {
    readonly provider: string;
    readonly api: string;
    readonly id: string;
  };
  readonly operation: "generation" | "compaction";
  readonly state: ReadonlyAgentExtensionValue | undefined;
  readonly signal?: AbortSignal;
}

/** A conversation's context as the model sees it, detached and frozen. */
export interface AgentToolTranscript {
  /** The agent's task: the instructions it was started with. */
  readonly job: string;
  /** Extra instructions stored for its conversation, if any. */
  readonly instructions?: string;
  /** Model messages of its active context, oldest first. */
  readonly messages: readonly Message[];
  /**
   * The same context per committed entry, with how each was written. Text
   * in `user` messages is NOT authenticated: it may come from the Pi
   * session, another agent, or tool output. Only `durableWork: true`
   * entries were appended by the host's own tasks (model and tool results).
   */
  readonly entries: readonly {
    readonly kind: string;
    readonly durableWork: boolean;
    readonly messages: readonly Message[];
  }[];
}

/** An agent that spawned the calling agent, read from committed records. */
export interface AgentToolSpawner {
  readonly agent: { readonly id: string; readonly name: string };
  readonly model?: { readonly provider: string; readonly id: string };
  /** The spawner's own context, read on first call. */
  context(): Promise<AgentToolTranscript>;
}

/** One tool call of an agent, before it executes. Identity comes from
 * committed host records, never from the call's arguments. */
export interface AgentToolContext {
  /** Owning Pi session. */
  readonly sessionId: string;
  readonly agent: { readonly id: string; readonly name: string };
  /** The agent's model. */
  readonly model: {
    readonly provider: string;
    readonly api: string;
    readonly id: string;
  };
  /** The agent's working directory: its own, else the host's default. */
  readonly cwd: string;
  readonly toolName: string;
  readonly toolCallId: string;
  /** Set for a nested call (codemode scripts): the calling tool call. */
  readonly parent?: { readonly toolCallId: string };
  /** Validated arguments, deeply frozen. */
  readonly input: Readonly<Record<string, unknown>>;
  /** Spawn depth: 1 for agents the Pi session's parent started. */
  readonly depth: number;
  /** The direct spawner agent. Absent when the Pi session itself started
   * the agent (then the Pi session is the parent), and for records that
   * predate the information: absence is never evidence of either. */
  readonly spawner?: AgentToolSpawner;
  /** The calling agent's own context, read on first call. */
  context(): Promise<AgentToolTranscript>;
  readonly signal?: AbortSignal;
}

/** Return nothing to allow. Anything but `undefined` or `{ block: true }`
 * blocks, as does a throw or an aborted call. Arguments can't be rewritten. */
export type AgentToolDecision =
  | undefined
  | { readonly block: true; readonly reason?: string };

/** Accepted or refused registration of `beforeAgentTool`. */
export interface AgentToolRegistration {
  readonly accepted: boolean;
  readonly reason?: string;
}

export interface AgentHooks {
  /** Stable extension-owned namespace. Also keys its persisted state. */
  readonly namespace: string;
  /** Synchronous and side-effect-free. Runs once per spawn: a graph's
   * nodes share one snapshot, and helpers inherit without calling it. */
  readonly onAgentCreate?: (
    ctx: AgentCreateContext,
  ) => AgentExtensionValue | undefined;
  /** Generation and compaction. May repeat; must be idempotent.
   * Undefined preserves the payload; any other value replaces it. */
  readonly onAgentRequest?: (
    ctx: AgentRequestContext,
    payload: unknown,
  ) => unknown | Promise<unknown>;
  /** Before each generation request and compaction summary, before
   * credentials resolve. The call waits until this returns or settles.
   * A throw is reported and doesn't stop the call. */
  readonly beforeAgentRequest?: (
    ctx: AgentBeforeRequestContext,
  ) => void | Promise<void>;
  /** Before every tool call of every agent, nested calls included, before
   * it executes. Hooks run one at a time in namespace order; the first
   * block wins. Fails closed. Requires the `beforeAgentTool` capability. */
  readonly beforeAgentTool?: (
    ctx: AgentToolContext,
  ) => AgentToolDecision | Promise<AgentToolDecision>;
  /** Called synchronously once discovery ended, before any agent resumes,
   * with whether `beforeAgentTool` will gate every agent tool call. */
  readonly onAgentToolRegistration?: (result: AgentToolRegistration) => void;
}

/** Respond synchronously from a listener registered during extension loading. */
export interface AgentHooksDiscovery {
  readonly protocol: 1;
  /** Absent in hosts that can't enforce `beforeAgentTool`: refuse then. */
  readonly capabilities?: { readonly beforeAgentTool: 1 };
  register(hooks: AgentHooks): void;
}

export const AGENT_HOOKS_DISCOVER = "pi-agents:hooks:discover";
