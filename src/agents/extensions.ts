/**
 * pi-agents' behavior as pi-durable extensions, so any registry can install
 * it, the way Pi's session worker installs its coding tools and prompt. A
 * host creates them, installs them in the registry of the harness it opens,
 * and hands the harness to `AgentService`. Every agent names the extensions
 * it selects, so the harness's default selection, such as Pi's own tools
 * and prompt in a session worker, never reaches agents.
 */

import {
  defineExtension,
  type Extension,
  type HookRegistration,
  type Registry,
} from "@earendil-works/pi-durable";
import { createPromptExtension, type PromptOptions } from "../host/prompt.js";
import { ModelRequests } from "../host/requests.js";
import { createToolsExtension } from "../host/tools.js";
import { WorkingAgents } from "../host/working.js";
import {
  type CollabBinding,
  collabSelection,
  createCollabExtension,
  createCompeteExtension,
  detachedCollab,
  type TeamLimits,
} from "./collab.js";
import { createGraphsExtension } from "./graphs.js";
import { MessagingHub } from "./hub.js";
import {
  createMessagingExtension,
  type MessagingOptions,
} from "./messaging.js";
import { SPAWNING_LIMITS, type SpawningLimits } from "./spawn-support.js";
import { spawningTools } from "./spawning.js";
import type { HelperResolver } from "./types.js";

export interface AgentExtensions {
  /** The tools agents select from. */
  tools: Extension;
  /** The system prompt of agents. */
  prompt: Extension;
  /** Graph and node tasks; they resolve from the registry, and agents never
   * select them. */
  graphs: Extension;
  /** `agent_spawn`, `agent_wait`, and `agent_stop`; only agents that may spawn select it. */
  spawning: Extension;
  /** `agent_send` and `agent_status`; every agent selects it. */
  messaging: Extension;
  /** `collab_board`, `collab_claim`, `collab_send`, and `collab_peers`;
   * only agents spawned into a collab group select it. */
  collab: Extension;
  /** The tools of a competition's solvers and judge. */
  compete: Extension;
  /** Where the session keeps its collab groups and competitions. */
  collabBinding: CollabBinding;
  /** What the messaging tools share with the service. */
  hub: MessagingHub;
  /** The cap on agents that work at once; the host observes its harness
   * with it. */
  working?: WorkingAgents;
  /** The pacing of model requests: rate-limit backoff and the token
   * budget. */
  requests: ModelRequests;
  /** How far spawning reaches. */
  limits: SpawningLimits;
  /** Stop running scripts, after the harness closed. */
  close(): Promise<void>;
}

export interface AgentExtensionOptions {
  prompt: PromptOptions;
  /** Resolves the profiles, models, and skills of helpers. */
  resolveHelper: HelperResolver;
  /** Spawning limits from settings, over the defaults. */
  spawningLimits?: Partial<SpawningLimits>;
  messaging?: MessagingOptions;
  /** How many agents work at once; unlimited when absent. */
  maxWorkingAgents?: number;
  /** Model tokens per minute across agents; no budget when absent. */
  maxTokensPerMinute?: number;
  /** Sub-teams and broadcasts in collab groups. */
  teams?: Partial<TeamLimits>;
  /** Co-loaded extensions' hooks on every agent's requests. */
  hooks?: readonly HookRegistration[];
  /** The session and directory of collab groups and competitions; a
   * temporary placeholder without it, for tests. */
  collab?: CollabBinding;
}

export function createAgentExtensions(
  options: AgentExtensionOptions,
): AgentExtensions {
  const { extension, close } = createToolsExtension();
  const working =
    options.maxWorkingAgents === undefined
      ? undefined
      : new WorkingAgents(options.maxWorkingAgents);
  const requests = new ModelRequests(
    options.maxTokensPerMinute === undefined
      ? {}
      : { tokensPerMinute: options.maxTokensPerMinute },
  );
  // Every agent selects the tools, so their hooks see every request.
  // Extensions' hooks run before the cap's, so a held run takes no slot;
  // the budget and backoff pace agents the cap admitted.
  const hooks = [
    ...(extension.hooks ?? []),
    ...(options.hooks ?? []),
    ...(working?.hooks ?? []),
    ...requests.hooks,
  ];
  const tools = hooks.length > 0 ? { ...extension, hooks } : extension;
  const prompt = createPromptExtension(options.prompt);
  const hub = new MessagingHub();
  const limits = {
    ...SPAWNING_LIMITS,
    ...(options.teams?.teamSize ? { teamSize: options.teams.teamSize } : {}),
    ...options.spawningLimits,
  };
  const pause = working
    ? { pause: (agentId: string) => working.pause(agentId) }
    : {};
  const messaging = createMessagingExtension(hub, options.messaging);
  const collabBinding = options.collab ?? detachedCollab();
  const collab = createCollabExtension(
    collabBinding,
    hub,
    options.messaging,
    options.teams,
  );
  const compete = createCompeteExtension(collabBinding, hub);
  let spawning: Extension | undefined;
  const spawnTools = spawningTools({
    resolve: options.resolveHelper,
    limits,
    hub,
    ...pause,
    // What a new agent selects besides its own tools.
    selection: (spawn, group) => {
      const joined = collabSelection({ collab, compete }, group);
      return {
        extensions: [
          tools,
          prompt,
          ...(spawn && spawning ? [spawning] : []),
          messaging,
          ...joined.extensions,
        ],
        tools: [
          ...(spawn ? (spawning?.tools ?? []) : []),
          ...(messaging.tools ?? []),
          ...joined.tools,
        ],
      };
    },
  });
  spawning = defineExtension({
    name: "pi-agents-spawning",
    tools: spawnTools,
  });
  return {
    tools,
    prompt,
    graphs: createGraphsExtension(),
    spawning,
    messaging,
    collab,
    compete,
    collabBinding,
    hub,
    ...(working ? { working } : {}),
    requests,
    limits,
    close,
  };
}

export function installAgentExtensions(
  registry: Registry,
  extensions: AgentExtensions,
): void {
  for (const extension of [
    extensions.tools,
    extensions.prompt,
    extensions.graphs,
    extensions.spawning,
    extensions.messaging,
    extensions.collab,
    extensions.compete,
  ])
    registry.install(extension);
}

/**
 * What an agent selects: its tools and prompt, the spawning tools when it
 * may spawn, and messaging when it may message other agents.
 */
export function agentSelection(
  extensions: AgentExtensions,
  options: { spawn?: boolean; messaging?: boolean } = {},
): Extension[] {
  return [
    extensions.tools,
    extensions.prompt,
    ...(options.spawn ? [extensions.spawning] : []),
    ...(options.messaging ? [extensions.messaging] : []),
  ];
}
