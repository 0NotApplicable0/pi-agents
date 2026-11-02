/**
 * Collaboration within one Pi session. Every agent is a member of a collab
 * group, the default one unless its spawn names another:
 *
 * - The collab extension: `collab_board`, `collab_claim`, `collab_send`, and
 *   `collab_peers`, on the group's store under the session's storage.
 *   `collab_send` delivers through `agent_send`'s exactly-once path and logs
 *   the structured event (task_req, handoff, review_req, and their answers)
 *   to the group's store, which `/collab` folds into tasks.
 * - The compete extension of a competition's agents: solvers get
 *   `compete_submit`, judges `compete_compare` and `compete_verdict`.
 *   Messaging keeps them blind: nobody reaches them and they reach nobody
 *   (see `scopeOf`).
 *
 * Every write is safe to repeat: IDs and times are memoized in the tool
 * task, the store's files are create-once, and a submission or verdict is
 * overwritten with the same content.
 */

import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import type { Context } from "@earendil-works/chord";
import {
  defineExtension,
  defineTool,
  type Extension,
  section,
  type ToolExecutionApi,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import { Type } from "typebox";
import {
  type Comparison,
  type Competition,
  collectDiff,
  compare,
  comparisonDetails,
  comparisonTable,
  finalists,
  readCompetition,
  type SolverEntry,
  verifyLabel,
  verifySolver,
  writeSubmission,
  writeVerdict,
} from "../collab/compete.js";
import {
  type CollabMembership,
  collabKey,
  collabMember,
  collabStore,
  selfOf,
} from "../collab/membership.js";
import {
  type BoardArgs,
  board,
  type ClaimArgs,
  claims,
  type Self,
} from "../collab/ops.js";
import {
  boardParameters,
  COLLAB_BOARD_TOOL,
  COLLAB_CLAIM_TOOL,
  COLLAB_PEERS_TOOL,
  COLLAB_SEND_TOOL,
  COMPETE_COMPARE_TOOL,
  COMPETE_SUBMIT_TOOL,
  COMPETE_VERDICT_TOOL,
  claimParameters,
  collabSendParameters,
  submitParameters,
  verdictParameters,
} from "../collab/schema.js";
import {
  type CollabStore,
  type MessageType,
  OPENING_TYPES,
} from "../collab/store.js";
import type { MessagingHub } from "./hub.js";
import { type MessagingOptions, sendMessage } from "./messaging.js";
import {
  type AgentRecord,
  AgentsDoc,
  GraphsDoc,
  type GraphsState,
} from "./records.js";
import { errorText, textResult } from "./spawn-support.js";

export const COLLAB_EXTENSION = "pi-agents-collab";
export const COMPETE_EXTENSION = "pi-agents-compete";

/** Sub-teams and broadcasts: these defaults, or the session's settings. */
export interface TeamLimits {
  /** Agents per sub-team that one spawn forms. */
  teamSize: number;
  /** Recipients one broadcast reaches at most. */
  maxBroadcast: number;
  /** Broadcasts one member sends per minute. */
  broadcastsPerMinute: number;
}

export const TEAM_LIMITS: Readonly<TeamLimits> = {
  teamSize: 12,
  maxBroadcast: 16,
  broadcastsPerMinute: 3,
};

/** Members `collab_peers` lists per page. */
const PEERS_PAGE = 20;
/** Teams and roles its summary names before it counts the rest. */
const SUMMARY_NAMES = 12;

export interface CollabBinding {
  /** The Pi session that owns the agents. */
  sessionId: () => string;
  /** The session's collab directory: groups and competitions. */
  root: () => string;
}

/** A placeholder outside Pi, for tests that don't bind one. */
export function detachedCollab(): CollabBinding {
  return {
    sessionId: () => "detached",
    root: () => path.join(os.tmpdir(), "pi-agents-collab", "detached"),
  };
}

type Agents = Readonly<Record<string, AgentRecord>>;

interface Caller {
  agentId: string;
  record: AgentRecord;
  membership: CollabMembership;
  agents: Agents;
  graphs: Readonly<GraphsState> | undefined;
}

async function callerOf(
  api: Pick<ToolExecutionApi, "snapshot" | "conversationId">,
  context: Context,
): Promise<Caller | string> {
  const [state, graphs] = await Promise.all([
    api.snapshot(AgentsDoc, context),
    api.snapshot(GraphsDoc, context),
  ]);
  const agentId = String(api.conversationId);
  const record = state?.agents[agentId];
  if (!record?.collab) return "You aren't in a collab group.";
  return {
    agentId,
    record,
    membership: record.collab,
    agents: state?.agents ?? {},
    graphs,
  };
}

type Member = Caller & { store: CollabStore; self: Self };

/** The caller as a member of its group's store, registered on first use. */
async function memberOf(
  binding: CollabBinding,
  api: Pick<ToolExecutionApi, "snapshot" | "conversationId">,
  context: Context,
): Promise<Member | string> {
  const caller = await callerOf(api, context);
  if (typeof caller === "string") return caller;
  if (caller.membership.competition)
    return "A competition's agents work alone and have no collab group.";
  const store = collabStore(binding.root(), caller.membership.group);
  const known = store.member(collabKey(caller.agentId));
  const member =
    known?.status === "live"
      ? known
      : store.upsertMember(
          collabMember({
            agentId: caller.agentId,
            name: caller.record.name,
            role: caller.membership.role,
            group: caller.membership.group,
            ...(caller.membership.team ? { team: caller.membership.team } : {}),
            ...(caller.membership.lead ? { lead: true } : {}),
            cwd: caller.membership.cwd,
            state: "working",
            ...(known ? { joinedAt: known.joinedAt } : {}),
          }),
        );
  return { ...caller, store, self: selfOf(member) };
}

function shortHash(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex").slice(0, 10);
}

/** IDs of a write, stable across reruns of the call. */
async function writeIds(
  binding: CollabBinding,
  api: ToolExecutionApi,
  prefix: string,
  context: Context,
): Promise<{ id: string; at: number }> {
  return api.memo<{ id: string; at: number }>(
    "collab-ids",
    {
      id: `${prefix}-${shortHash(`${binding.sessionId()}|${api.conversationId}|${api.taskId}`)}`,
      at: api.now(),
    },
    context,
  );
}

function result(outcome: { text: string; error?: boolean }) {
  return textResult(outcome.text, outcome.error === true);
}

/** The other members of a group, open ones first. */
function groupMembers(
  agents: Agents,
  group: string,
  self?: string,
): Array<[string, AgentRecord]> {
  return Object.entries(agents)
    .filter(
      ([id, record]) =>
        id !== self &&
        record.collab?.group === group &&
        !record.collab.competition,
    )
    .sort(
      ([, left], [, right]) =>
        Number(left.closed === true) - Number(right.closed === true) ||
        left.createdAt - right.createdAt,
    );
}

function isOpening(type: MessageType): boolean {
  return (OPENING_TYPES as readonly string[]).includes(type);
}

/** What the recipient reads after `[from <sender>]`. */
export function collabText(message: {
  type: MessageType;
  task?: string;
  text: string;
  refs: readonly string[];
  sender: string;
}): string {
  const header =
    message.type === "message"
      ? `(collab message${message.task ? ` re ${message.task}` : ""})`
      : `(collab ${message.type} ${message.task})`;
  const refs = message.refs.length ? `\nrefs: ${message.refs.join(", ")}` : "";
  const hint =
    message.type === "review_req"
      ? `\n(Review it, then answer with collab_send to "${message.sender}", type review_done, task "${message.task}".)`
      : isOpening(message.type)
        ? `\n(Answer with collab_send to "${message.sender}": type task_ack when you take it, then task_done with the result or task_blocked with the reason, or task_clarify to ask; task "${message.task}".)`
        : "";
  return `${header}\n${message.text.trim()}${refs}${hint}`;
}

type SendPlan = {
  id: string;
  at: number;
  type: MessageType;
  task?: string;
  to: string;
  recipient: string;
  /** A broadcast's recipients, by ID and name; `to` names the audience. */
  broadcast?: Array<{ id: string; name: string }>;
};

/** Broadcasts each sender sent lately, by agent ID: their times. */
const broadcasts = new Map<string, number[]>();

/** Forget every sender's broadcasts, as a fresh process would; for
 * tests. */
export function forgetBroadcasts(): void {
  broadcasts.clear();
}

/** Plan a broadcast to the caller's team, a named team, or the group:
 * plain messages only, to at most `maxBroadcast` members, and at most
 * `broadcastsPerMinute` per sender. */
function planBroadcast(
  member: Member,
  args: { to: string; type?: MessageType },
  ids: { id: string; at: number },
  limits: TeamLimits,
  now: number,
): SendPlan | string {
  const to = args.to.trim();
  const { group, team: own } = member.membership;
  const team =
    to === "group" ? undefined : to === "team" ? own : to.slice(5).trim();
  if (to === "team" && !own)
    return `You aren't on a sub-team of collab group ${group}; send to "group", a team:<name>, or a member.`;
  if ((args.type ?? "message") !== "message")
    return `Broadcasts carry plain messages; send ${args.type} to one member.`;
  const recipients = groupMembers(member.agents, group, member.agentId).filter(
    ([, record]) =>
      !record.stopped &&
      record.closed !== true &&
      (team === undefined || record.collab?.team === team),
  );
  const audience = team === undefined ? `group ${group}` : `team ${team}`;
  if (recipients.length === 0) return `Nobody else in ${audience} to reach.`;
  if (recipients.length > limits.maxBroadcast)
    return `${audience} has ${recipients.length} other members, more than a broadcast reaches (${limits.maxBroadcast}, piAgents.maxBroadcast). Post to collab_board for everyone, or send to a team.`;
  const recent = (broadcasts.get(member.agentId) ?? []).filter(
    (at) => now - at < 60_000,
  );
  if (recent.length >= limits.broadcastsPerMinute) {
    const wait = Math.ceil((60_000 - (now - (recent[0] as number))) / 1000);
    return `You sent ${recent.length} broadcasts in the last minute (at most ${limits.broadcastsPerMinute}, piAgents.broadcastsPerMinute). Wait ${wait}s, message one member, or post to collab_board.`;
  }
  broadcasts.set(member.agentId, [...recent, now]);
  return {
    id: ids.id,
    at: ids.at,
    type: "message",
    to,
    recipient: audience,
    broadcast: recipients.map(([id, record]) => ({ id, name: record.name })),
  };
}

function isBroadcast(to: string): boolean {
  const target = to.trim();
  return target === "team" || target === "group" || target.startsWith("team:");
}

function planSend(
  member: Member,
  args: { to: string; type?: MessageType; task?: string; text: string },
  ids: { id: string; at: number },
): SendPlan | string {
  if (!args.text.trim()) return "The message must not be empty.";
  const type = args.type ?? "message";
  const given = args.task?.trim();
  if (type !== "message" && !isOpening(type) && !given)
    return `${type} needs the task ID of the request it answers (task: "...").`;
  const to = args.to.trim();
  let target: [string, AgentRecord] | undefined;
  if (to.startsWith("role:")) {
    const role = to.slice(5).trim();
    const matches = groupMembers(
      member.agents,
      member.membership.group,
      member.agentId,
    ).filter(([, record]) => record.collab?.role === role && !record.stopped);
    if (matches.length === 0)
      return `No member of collab group ${member.membership.group} has role ${role}.`;
    if (matches.length > 1)
      return `Several members have role ${role}: ${matches.map(([, record]) => record.name).join(", ")}. Name one.`;
    target = matches[0];
  } else {
    const byId = Object.hasOwn(member.agents, to)
      ? member.agents[to]
      : undefined;
    target = byId
      ? [to, byId]
      : Object.entries(member.agents)
          .filter(([, record]) => record.name === to)
          .sort(
            ([, left], [, right]) =>
              Number(left.closed === true) - Number(right.closed === true) ||
              right.createdAt - left.createdAt,
          )[0];
  }
  if (!target) return `No agent named ${to}.`;
  if (
    target[0] === member.agentId ||
    target[1].collab?.group !== member.membership.group ||
    target[1].collab?.competition
  )
    return `${target[1].name} isn't another member of collab group ${member.membership.group}; collab_send reaches group members only (agent_send reaches others).`;
  const task = isOpening(type) ? given || `t-${ids.id.slice(2)}` : given;
  return {
    id: ids.id,
    at: ids.at,
    type,
    ...(task ? { task } : {}),
    to: target[0],
    recipient: target[1].name,
  };
}

/** The tools of a collab group's members. */
export function createCollabExtension(
  binding: CollabBinding,
  hub: MessagingHub,
  options: MessagingOptions = {},
  teams: Partial<TeamLimits> = {},
): Extension {
  const limits: TeamLimits = { ...TEAM_LIMITS, ...teams };
  /** Send a planned broadcast: once to each recipient, each send exactly
   * once across reruns, then log it once. */
  const broadcast = async (
    member: Member,
    plan: SendPlan,
    text: string,
    refs: string[],
    api: ToolExecutionApi,
    context: Context,
  ) => {
    const reached: string[] = [];
    const missed: string[] = [];
    const message = collabText({
      type: "message",
      text,
      refs,
      sender: member.record.name,
    });
    for (const recipient of plan.broadcast ?? []) {
      const sent = await sendMessage(
        hub,
        options,
        {
          name: recipient.id,
          group: true,
          message: `(to ${plan.recipient}) ${message}`,
          mode: "followUp",
          slot: recipient.id,
        },
        api,
        context,
      );
      (sent.isError ? missed : reached).push(recipient.name);
    }
    member.store.log({
      id: plan.id,
      type: "message",
      from: member.self.key,
      fromName: member.self.name,
      to: plan.to,
      toName: plan.recipient,
      text: text.trim(),
      refs,
      mode: "followUp",
      sentAt: plan.at,
    });
    return textResult(
      `Message sent to ${reached.length} of ${plan.recipient}${reached.length ? `: ${reached.join(", ")}` : ""}.${missed.length ? ` Not reached (stopped or not started): ${missed.join(", ")}.` : ""}`,
      reached.length === 0,
    );
  };
  return defineExtension({
    name: COLLAB_EXTENSION,
    sections: [
      section("collab", async (input, context) => {
        const state = await input.read.snapshot(AgentsDoc, context);
        const self = String(input.conversationId);
        const record = state?.agents[self];
        const collab = record?.collab;
        if (!record || !collab || collab.competition) return undefined;
        // Fixed for the agent's life: a section that changes reaches the
        // agent as a new system message, so it names no members.
        return [
          `You are ${record.name}, role ${collab.role}, in collab group "${collab.group}" of this session; collab_peers lists the other members and what they do.`,
          ...(collab.team
            ? [
                collab.lead
                  ? `You lead sub-team "${collab.team}": coordinate its members, split the work, and keep the board current; agents you spawn join your team.`
                  : `You are on sub-team "${collab.team}": work with its members first (collab_send to "team" reaches them all), and with its lead when it has one.`,
              ]
            : []),
          "When others work alongside you, check collab_board and collab_claim list before you start, and post durable findings, decisions, open questions, and todos to collab_board so others needn't rediscover them; reference entries as board:<id>, and update them to done when finished.",
          "Before you change files others may touch, claim them with collab_claim; claims are advisory and all-or-nothing. On a conflict, coordinate with the holder or pick other work. Release claims when done.",
          "Use collab_send for structured work: task_req to ask for work, handoff to pass yours on, review_req to ask for a review. Answer requests with task_ack, then task_done (with the result) or task_blocked (with the reason), task_clarify to ask, or review_done, carrying the task ID.",
        ].join("\n");
      }),
    ],
    tools: [
      defineTool({
        name: COLLAB_PEERS_TOOL,
        description:
          "List the other members of your collab group with their role, sub-team, and state: counts by state, role, and team, then your sub-team (or the team or role you ask for), a page at a time.",
        parameters: peersParameters,
        replay: "safe",
        async execute(args, api, context) {
          const caller = await callerOf(api, context);
          if (typeof caller === "string") return textResult(caller, true);
          return textResult(
            peersReport(caller, args, (id) => hub.state(id) ?? "idle"),
          );
        },
      }),
      defineTool({
        name: COLLAB_SEND_TOOL,
        description:
          "Send a message or structured event to a member of your collab group: task_req, handoff, or review_req, and the answers task_ack, task_clarify, task_done, task_blocked, and review_done. Returns at once; replies arrive as [from <name>] input.",
        parameters: collabSendParameters,
        replay: "safe",
        async execute(args, api, context) {
          const member = await memberOf(binding, api, context);
          if (typeof member === "string") return textResult(member, true);
          // The first run binds the recipient and task; a rerun replays them.
          let plan = await api.memo<SendPlan>("collab-send", context);
          if (!plan) {
            const ids = await writeIds(binding, api, "m", context);
            const planned = isBroadcast(args.to)
              ? planBroadcast(member, args, ids, limits, api.now())
              : planSend(member, args, ids);
            if (typeof planned === "string") return textResult(planned, true);
            plan = await api.memo<SendPlan>("collab-send", planned, context);
          }
          const refs = args.refs ?? [];
          if (plan.broadcast)
            return broadcast(member, plan, args.text, refs, api, context);
          const sent = await sendMessage(
            hub,
            options,
            {
              name: plan.to,
              group: true,
              message: collabText({
                type: plan.type,
                ...(plan.task ? { task: plan.task } : {}),
                text: args.text,
                refs,
                sender: member.record.name,
              }),
              ...(args.mode ? { mode: args.mode } : {}),
            },
            api,
            context,
          );
          if (sent.isError) return sent;
          member.store.log({
            id: plan.id,
            type: plan.type,
            ...(plan.task ? { task: plan.task } : {}),
            from: member.self.key,
            fromName: member.self.name,
            to: collabKey(plan.to),
            toName: plan.recipient,
            text: args.text.trim(),
            refs,
            mode: args.mode ?? "followUp",
            sentAt: plan.at,
          });
          const what =
            plan.type === "message"
              ? "Message"
              : `${plan.type}${plan.task ? ` ${plan.task}` : ""}`;
          const replies =
            plan.type === "review_req"
              ? ` The review comes back as review_done with task "${plan.task}".`
              : isOpening(plan.type)
                ? ` Replies come back as task_ack/task_clarify/task_done/task_blocked with task "${plan.task}".`
                : "";
          return textResult(`${what} sent to ${plan.recipient}.${replies}`);
        },
      }),
      defineTool({
        name: COLLAB_BOARD_TOOL,
        description:
          "Your collab group's shared blackboard: read, post, and update findings, decisions, todos, questions, and notes that every member sees.",
        parameters: boardParameters,
        replay: "safe",
        async execute(args, api, context) {
          const member = await memberOf(binding, api, context);
          if (typeof member === "string") return textResult(member, true);
          const request = args as BoardArgs;
          try {
            const ids =
              request.action === "read"
                ? undefined
                : await writeIds(binding, api, "b", context);
            return result(board(member.store, member.self, request, ids));
          } catch (error) {
            return textResult(errorText(error), true);
          }
        },
      }),
      defineTool({
        name: COLLAB_CLAIM_TOOL,
        description:
          "Claim work (paths relative to your working directory, item:<board id>, or key:<text>) before you change it so other members avoid it; see others' claims; release yours when done. Advisory.",
        parameters: claimParameters,
        replay: "safe",
        async execute(args, api, context) {
          const member = await memberOf(binding, api, context);
          if (typeof member === "string") return textResult(member, true);
          try {
            return result(claims(member.store, member.self, args as ClaimArgs));
          } catch (error) {
            return textResult(errorText(error), true);
          }
        },
      }),
    ],
  });
}

const peersParameters = Type.Object({
  team: Type.Optional(
    Type.String({
      description:
        'A sub-team to list, or "all" for every member; default your own team (everyone in a small group)',
    }),
  ),
  role: Type.Optional(
    Type.String({ description: "List only members with this role" }),
  ),
  offset: Type.Optional(
    Type.Integer({ minimum: 0, description: "Members to skip, for paging" }),
  ),
  limit: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: 100,
      description: `Members per page; default ${PEERS_PAGE}`,
    }),
  ),
});

function counted(
  counts: Map<string, number>,
  describe = (name: string) => name,
) {
  const sorted = [...counts].sort(
    ([left, a], [right, b]) => b - a || left.localeCompare(right),
  );
  const shown = sorted
    .slice(0, SUMMARY_NAMES)
    .map(([name, count]) => `${describe(name)} ${count}`);
  const rest = sorted.length - SUMMARY_NAMES;
  return `${shown.join(", ")}${rest > 0 ? `, +${rest} more` : ""}`;
}

function tally(values: Iterable<string>): Map<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return counts;
}

/** What `collab_peers` shows: a summary that stays short however large
 * the group, then a page of the members asked for. */
export function peersReport(
  caller: Pick<Caller, "agentId" | "agents" | "membership">,
  args: { team?: string; role?: string; offset?: number; limit?: number },
  stateOf: (agentId: string) => string,
): string {
  const { group, team: own } = caller.membership;
  const others = groupMembers(caller.agents, group, caller.agentId);
  if (others.length === 0) return `You are alone in collab group ${group}.`;
  const state = ([id, record]: [string, AgentRecord]) =>
    record.stopped ? "stopped" : stateOf(id);
  const limit = args.limit ?? PEERS_PAGE;
  const offset = args.offset ?? 0;
  const teamName = args.team?.trim();
  const leads = new Map<string, string>();
  for (const [, record] of others)
    if (record.collab?.lead && record.collab.team && !record.stopped)
      leads.set(record.collab.team, record.name);
  if (caller.membership.lead && own) leads.set(own, "you");
  const teams = tally(
    others.flatMap(([, record]) =>
      record.collab?.team ? [record.collab.team] : [],
    ),
  );
  const filtered = !!(teamName || args.role);
  // A small group lists everyone; a large one the caller's own team.
  const scope =
    teamName && teamName !== "all"
      ? teamName
      : !filtered && others.length > limit && own
        ? own
        : undefined;
  const chosen = others
    .filter(
      ([, record]) =>
        (scope === undefined || record.collab?.team === scope) &&
        (!args.role || record.collab?.role === args.role),
    )
    .sort(
      ([, left], [, right]) =>
        Number(right.collab?.team === own) - Number(left.collab?.team === own),
    );
  const page = chosen.slice(offset, offset + limit);
  const lines: string[] = [];
  if (others.length > limit || teams.size > 0 || filtered) {
    lines.push(
      `Collab group ${group}: ${others.length} other members (${counted(tally(others.map(state)))}).`,
      `Roles: ${counted(tally(others.map(([, record]) => record.collab?.role ?? "?")))}.`,
    );
    if (teams.size > 0)
      lines.push(
        `Teams: ${counted(teams, (name) => (leads.has(name) ? `${name} (lead ${leads.get(name)})` : name))}${own ? `; yours: ${own}` : ""}.`,
      );
  }
  const what = scope
    ? `Team ${scope}${leads.has(scope) ? ` (lead ${leads.get(scope)})` : ""}`
    : args.role
      ? `Role ${args.role}`
      : `Collab group ${group}`;
  lines.push(
    page.length
      ? `${what}:\n${page
          .map(
            ([id, record]) =>
              `- ${record.name} role=${record.collab?.role} ${state([id, record])}${record.collab?.team ? ` team=${record.collab.team}` : ""}${record.collab?.lead ? " (lead)" : ""}`,
          )
          .join("\n")}`
      : `${what}: no members${offset ? ` past ${offset}` : ""}.`,
  );
  if (chosen.length > page.length)
    lines.push(
      `Showing ${offset + 1}–${offset + page.length} of ${chosen.length}${offset + page.length < chosen.length ? `; offset ${offset + page.length} lists more` : ""}. Filter with team (or "all") and role.`,
    );
  return lines.join("\n");
}

// Competitions

type Contestant = Caller & { competition: Competition };

async function contestantOf(
  binding: CollabBinding,
  api: Pick<ToolExecutionApi, "snapshot" | "conversationId">,
  context: Context,
  part: "solver" | "judge",
): Promise<Contestant | string> {
  const caller = await callerOf(api, context);
  if (typeof caller === "string") return caller;
  const { competition: id } = caller.membership;
  if (!id || caller.membership.part !== part)
    return `Only a competition's ${part} can use this tool.`;
  const competition = readCompetition(binding.root(), id);
  if (!competition) return `Competition ${id} is gone.`;
  return { ...caller, competition };
}

/** Each solver's state as its record and the service see it. */
export function solverStates(
  competition: Competition,
  agents: Agents,
  state: (agentId: string) => string | undefined,
): Record<string, string> {
  return Object.fromEntries(
    competition.solvers.map((entry) => {
      const record = entry.agentId ? agents[entry.agentId] : undefined;
      const value = !record
        ? "unknown"
        : record.stopped
          ? "stopped"
          : (state(entry.agentId as string) ?? "idle");
      return [entry.name, value];
    }),
  );
}

function solverEntry(contestant: Contestant): SolverEntry | undefined {
  const { competition, membership, agentId } = contestant;
  return competition.solvers.find(
    (entry) => entry.name === membership.solver || entry.agentId === agentId,
  );
}

/** The tools of a competition's solvers and judge. */
export function createCompeteExtension(
  binding: CollabBinding,
  hub: MessagingHub,
): Extension {
  return defineExtension({
    name: COMPETE_EXTENSION,
    sections: [
      section("compete", async (input, context) => {
        const state = await input.read.snapshot(AgentsDoc, context);
        const collab = state?.agents[String(input.conversationId)]?.collab;
        if (!collab?.competition) return undefined;
        return collab.part === "judge"
          ? `You judge ${collab.bracket !== undefined ? `bracket ${collab.bracket + 1} of ` : ""}competition ${collab.competition}. Use compete_compare, then compete_verdict. Change no files.`
          : `You are a solver in competition ${collab.competition}. You work alone in your own workspace (${collab.cwd}); stay inside it. Finish with compete_submit.`;
      }),
    ],
    tools: [
      defineTool({
        name: COMPETE_SUBMIT_TOOL,
        description:
          "Submit your solution to the competition: your summary, approach, tests, confidence, and caveats. The tool takes your workspace's diff and runs the verify command, and returns both; submit again after a fix, the last submission counts.",
        parameters: submitParameters,
        replay: "safe",
        async execute(args, api, context) {
          const contestant = await contestantOf(
            binding,
            api,
            context,
            "solver",
          );
          if (typeof contestant === "string")
            return textResult(contestant, true);
          const { competition } = contestant;
          if (competition.status !== "running")
            return textResult(
              `Competition ${competition.id} ended (${competition.status}); submissions are closed.`,
              true,
            );
          const entry = solverEntry(contestant);
          if (!entry)
            return textResult(
              `You aren't a solver of competition ${competition.id}.`,
              true,
            );
          try {
            const diff = collectDiff(entry);
            const verify = await verifySolver(
              binding.root(),
              competition,
              entry,
              diff,
            );
            const at = await api.memo<number>("compete-at", api.now(), context);
            writeSubmission(binding.root(), competition.id, {
              solver: entry.name,
              summary: args.summary.trim(),
              approach: args.approach.trim(),
              tests: args.tests.trim(),
              confidence: Math.max(0, Math.min(1, args.confidence)),
              caveats: args.caveats?.trim() ?? "",
              submittedAt: at,
              files: diff.files,
              hash: diff.hash,
              ...(verify ? { verify } : {}),
            });
            const files = diff.files.length
              ? diff.files
                  .map(
                    (file) => `${file.path} (+${file.added}/-${file.removed})`,
                  )
                  .join(", ")
              : "none: your workspace has no changes";
            const verdict = verify
              ? `Verify \`${verify.command}\`: ${verifyLabel(verify)}.${verify.exitCode === 0 && !verify.timedOut ? "" : `\n${verify.output.slice(-2_000).trim()}\nFix the failure and submit again.`}`
              : "No verify command.";
            return textResult(
              `Submitted ${entry.name}'s solution. Files: ${files}.\n${verdict}`,
            );
          } catch (error) {
            return textResult(errorText(error), true);
          }
        },
      }),
      defineTool({
        name: COMPETE_COMPARE_TOOL,
        description:
          "Compare the competition's solutions: a table of states, verify results, diff sizes, and confidence, then each solver's submission, verify output, and diff.",
        parameters: Type.Object({}),
        replay: "safe",
        async execute(_args, api, context) {
          const contestant = await contestantOf(binding, api, context, "judge");
          if (typeof contestant === "string")
            return textResult(contestant, true);
          try {
            const { competition, membership } = contestant;
            // A bracket judge compares its bracket; the final judge the
            // brackets' finalists.
            const solvers =
              membership.bracket !== undefined
                ? competition.brackets?.[membership.bracket]?.solvers
                : competition.brackets?.length
                  ? await finalists(binding.root(), competition)
                  : undefined;
            const comparison: Comparison = await compare(
              binding.root(),
              competition,
              solverStates(competition, contestant.agents, (id) =>
                hub.state(id),
              ),
              solvers ? { solvers } : {},
            );
            return textResult(
              `${comparisonTable(comparison)}\n\n${comparisonDetails(comparison)}`,
            );
          } catch (error) {
            return textResult(errorText(error), true);
          }
        },
      }),
      defineTool({
        name: COMPETE_VERDICT_TOOL,
        description:
          "Record your verdict: the winner, the ranking, your rationale, and an optional merge proposal. The user decides what to apply.",
        parameters: verdictParameters,
        replay: "safe",
        async execute(args, api, context) {
          const contestant = await contestantOf(binding, api, context, "judge");
          if (typeof contestant === "string")
            return textResult(contestant, true);
          const { bracket } = contestant.membership;
          const names =
            bracket !== undefined
              ? (contestant.competition.brackets?.[bracket]?.solvers ?? [])
              : contestant.competition.solvers.map((entry) => entry.name);
          const unknown = [args.winner, ...args.ranking].filter(
            (name) => !names.includes(name),
          );
          if (unknown.length)
            return textResult(
              `Unknown solvers ${[...new Set(unknown)].join(", ")}; solvers: ${names.join(", ")}.`,
              true,
            );
          const at = await api.memo<number>("compete-at", api.now(), context);
          writeVerdict(
            binding.root(),
            contestant.competition.id,
            {
              by: contestant.record.name,
              winner: args.winner,
              ranking: args.ranking,
              rationale: args.rationale.trim(),
              ...(args.merge?.trim() ? { merge: args.merge.trim() } : {}),
              at,
            },
            bracket,
          );
          return textResult(
            bracket !== undefined
              ? `Recorded bracket ${bracket + 1}: ${args.ranking.join(" > ")}.`
              : `Recorded: ${args.winner} wins (${args.ranking.join(" > ")}).`,
          );
        },
      }),
    ],
  });
}

const SOLVER_TOOLS = [COMPETE_SUBMIT_TOOL];
const JUDGE_TOOLS = [COMPETE_COMPARE_TOOL, COMPETE_VERDICT_TOOL];

/** What a membership adds to an agent: the collab tools for a group's
 * members, a solver's or judge's tools in a competition, or, for `all`,
 * every one of them (the tools an agent doesn't pass on to helpers). */
export function collabSelection(
  extensions: { collab: Extension; compete: Extension },
  membership: CollabMembership | "all" | undefined,
): { extensions: Extension[]; tools: ToolRegistration[] } {
  if (!membership) return { extensions: [], tools: [] };
  if (membership === "all")
    return {
      extensions: [extensions.collab, extensions.compete],
      tools: [
        ...(extensions.collab.tools ?? []),
        ...(extensions.compete.tools ?? []),
      ],
    };
  if (!membership.competition)
    return {
      extensions: [extensions.collab],
      tools: [...(extensions.collab.tools ?? [])],
    };
  const names = membership.part === "judge" ? JUDGE_TOOLS : SOLVER_TOOLS;
  return {
    extensions: [extensions.compete],
    tools: (extensions.compete.tools ?? []).filter((tool) =>
      names.includes(tool.name),
    ),
  };
}
