/**
 * The parent's side of in-session collaboration:
 *
 * - `agent_compete` and `/compete`: start a competition (N isolated
 *   solvers and an optional judge in one graph), read its comparison,
 *   apply a solver's change to the main workspace, and discard it.
 * - `collab_status` and `/collab`: what a session's collab groups hold:
 *   members, claims, tasks, blackboard, and messages.
 * - `CollabMonitor`: marks stopped members exited, which releases their
 *   claims, and stops solvers that outlive their competition's deadline.
 *   Durable membership restores monitoring after a restart; successful deadline
 *   stops are remembered for this service's lifetime so users can resume solvers.
 */

import fs from "node:fs";
import path from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { AgentService } from "../agents/service.js";
import { errorText } from "../agents/spawn-support.js";
import {
  AgentError,
  type CompetitionOwner,
  type CompetitionOwnership,
  GraphStartedError,
  type SpawnSpec,
  THINKING_LEVELS,
} from "../agents/types.js";
import {
  applySolution,
  approveCompetitionVerification,
  assertBound,
  assertCompetitionId,
  assertProjectCwd,
  bracketJudgeJob,
  bracketsOf,
  COMPETE_TIMEOUT_MS,
  type Competition,
  type CompetitionState,
  collectDiff,
  compare,
  comparisonDetails,
  comparisonTable,
  competitionDir,
  DEFAULT_HINTS,
  detectVerify,
  discardWorkspaces,
  inspectCompetition,
  judgeJob,
  listCompetitionStates,
  mergeJob,
  prepareMergeWorkspace,
  prepareWorkspaces,
  readCompetition,
  readSubmission,
  readVerdict,
  reserveCompetitionId,
  SOLVER_COUNT,
  SOLVER_NAME,
  type SolverEntry,
  type SolverPlan,
  sealCompetition,
  solverJob,
  unsealCompetition,
  updateCompetition,
  VERIFY_TIMEOUT_MS,
  type VerifyApproval,
  verificationSnapshot,
  writeCompetition,
  writeSourcePatches,
} from "../collab/compete.js";
import {
  collabKey,
  collabStore,
  listGroups,
  resolveCollab,
} from "../collab/membership.js";
import {
  claimLine,
  entryLine,
  isClosedTask,
  messageLine,
  overview,
  taskLine,
} from "../collab/ops.js";
import type { SessionHost } from "./session.js";
import { inheritedTools, resolveSpawn } from "./spawn.js";

export const COLLAB_MESSAGE_TYPE = "pi-agents-collab";
const JUDGE_TOOLS = ["read", "grep", "find", "ls"];

/** What starting a competition asks for. */
export interface CompeteRequest {
  task: string;
  solvers?: number;
  variants?: Array<Partial<SolverPlan>>;
  model?: string;
  thinking?: string;
  verify?: string;
  judge?: boolean;
  judgeModel?: string;
  timeoutMinutes?: number;
  cwd: string;
  /** The current parent project; restricts fresh workspace bindings. */
  project?: string;
}

/** What merging solutions asks for. */
export interface MergeRequest {
  /** The solutions to combine; default the two best ranked. */
  from?: string[];
  guidance?: string;
  model?: string;
  thinking?: string;
  timeoutMinutes?: number;
  project?: string;
  approval?: VerifyApproval;
  authorized?: boolean;
}

/** Resolve one agent of a competition into a spawn: the Pi tool resolves
 * models, skills, and tools like `agent_spawn`; tests pass a plain one. */
export type CompetitorResolver = (request: {
  job: string;
  name: string;
  cwd: string;
  model?: string;
  thinking?: string;
  tools?: string[];
}) => Promise<SpawnSpec>;

function solverPlans(
  request: CompeteRequest,
  id: string,
  maxSolvers: number,
): SolverPlan[] {
  const count = request.variants?.length || request.solvers || 3;
  if (count < SOLVER_COUNT.min || count > maxSolvers)
    throw new AgentError(
      `A competition has ${SOLVER_COUNT.min} to ${maxSolvers} solvers, not ${count}${maxSolvers === SOLVER_COUNT.max ? " (the piAgents.maxSolvers setting raises the limit)" : ""}.`,
    );
  const names = new Set<string>();
  return Array.from({ length: count }, (_, index) => {
    const variant = request.variants?.[index] ?? {};
    let name =
      variant.name?.trim().replace(/[^A-Za-z0-9_-]/g, "-") ||
      (index < 26
        ? `${id}-${String.fromCharCode(97 + index)}`
        : `${id}-${index + 1}`);
    if (
      !SOLVER_NAME.test(name) ||
      name === `${id}-judge` ||
      name.startsWith(`${id}-judge-`) ||
      new RegExp(`^${id}-m\\d+$`).test(name)
    )
      throw new AgentError(
        `Invalid or reserved solver name ${JSON.stringify(name)}`,
      );
    const base = name;
    let suffix = index + 1;
    while (names.has(name)) {
      const ending = `-${suffix++}`;
      name = `${base.slice(0, 64 - ending.length)}${ending}`;
    }
    if (!SOLVER_NAME.test(name))
      throw new AgentError(`Invalid solver name ${JSON.stringify(name)}`);
    names.add(name);
    // Every solver gets a different default strategy; a given hint
    // replaces it, and an empty one means none.
    const hint = variant.hint ?? DEFAULT_HINTS[index];
    const model = variant.model ?? request.model;
    const thinking = variant.thinking ?? request.thinking;
    return {
      name,
      ...(hint ? { hint } : {}),
      ...(model ? { model } : {}),
      ...(thinking ? { thinking } : {}),
    };
  });
}

/** Missing projections must not make durable, unfinished owners look idle. */
function stateOf(service: AgentService, owner: CompetitionOwner): string {
  if (owner.stopped) return "stopped";
  return service.agentById(owner.agentId)?.state ?? "working";
}

function statesOf(
  service: AgentService,
  competition: Competition,
  ownership: CompetitionOwnership | undefined,
): Record<string, string> {
  return Object.fromEntries(
    competition.solvers.map((entry) => {
      const owners =
        ownership?.agents.filter(
          (owner) => owner.part === "solver" && owner.solver === entry.name,
        ) ?? [];
      const states = owners.map((owner) => stateOf(service, owner));
      return [
        entry.name,
        states.find((state) => ACTIVE.has(state)) ?? states[0] ?? "unknown",
      ];
    }),
  );
}

const ACTIVE = new Set(["working", "waiting"]);
// Persisted timedOut names are diagnostic, not authority to skip a first stop.
// Keep successful stops across monitor/Competitions recreation, but not services.
const expiredSolvers = new WeakMap<AgentService, Set<string>>();

/** Competitions of one session: what `agent_compete` and `/compete` do. */
export class Competitions {
  private readonly root: () => string | undefined;
  private readonly maxSolvers: () => number;
  private readonly bracketSize: () => number;

  constructor(
    root: () => string | undefined,
    maxSolvers: () => number = () => SOLVER_COUNT.max,
    bracketSize: () => number = () => 8,
  ) {
    this.root = root;
    this.maxSolvers = maxSolvers;
    this.bracketSize = bracketSize;
  }

  private requireRoot(): string {
    const root = this.root();
    if (!root) throw new AgentError("Agents aren't ready in this session yet");
    return root;
  }

  /** A competition by ID, or the newest. */
  find(id?: string): Competition {
    const root = this.requireRoot();
    if (id !== undefined) assertCompetitionId(id);
    const selected = id ?? listCompetitionStates(root)[0]?.competition.id;
    const competition = selected ? readCompetition(root, selected) : undefined;
    if (!competition)
      throw new AgentError(id ? `No competition ${id}` : "No competitions yet");
    return competition;
  }

  inspect(id?: string): CompetitionState {
    const root = this.requireRoot();
    if (id !== undefined) assertCompetitionId(id);
    const state = id
      ? inspectCompetition(root, id)
      : listCompetitionStates(root)[0];
    if (!state)
      throw new AgentError(id ? `No competition ${id}` : "No competitions yet");
    return state;
  }

  list(): Competition[] {
    const root = this.root();
    return root
      ? listCompetitionStates(root).map((state) => state.competition)
      : [];
  }

  snapshot(competition: Competition): VerifyApproval | undefined {
    return verificationSnapshot(this.requireRoot(), competition);
  }

  /** Stop only durable owners. Mixed graphs are handled agent by agent. */
  private async stopOwners(
    service: AgentService,
    ownership: CompetitionOwnership | undefined,
    solver?: string,
  ): Promise<void> {
    const agents =
      ownership?.agents.filter(
        (owner) => solver === undefined || owner.solver === solver,
      ) ?? [];
    const graphs =
      ownership?.graphs.filter(
        (graph) =>
          solver === undefined ||
          ownership.agents.every(
            (owner) => owner.graph !== graph.id || owner.solver === solver,
          ),
      ) ?? [];
    const stopped = new Set<string>();
    for (const graph of graphs) {
      // Closed graphs can still have owners needing cleanup after a failed refresh.
      if (
        graph.closed &&
        !agents.some((owner) => owner.graph === graph.id && !owner.stopped)
      )
        continue;
      await service.stopTarget({ kind: "graph", id: graph.id });
      stopped.add(graph.id);
    }
    for (const owner of agents)
      if (!owner.stopped && !stopped.has(owner.graph))
        await service.stopTarget({ kind: "agent", id: owner.agentId });
  }

  /** Even an untyped spawn failure can follow a durable commit. Reconcile before
   * deleting anything; diagnostic markers never authorize stopping a target. */
  private async stopFailedSpawn(
    root: string,
    service: AgentService,
    competition: Competition,
    graph: string | undefined,
    owner: string,
    failure: unknown,
    solver?: string,
  ): Promise<void> {
    try {
      const ownership = (await service.competitionOwners()).get(competition.id);
      if (
        graph &&
        !ownership?.graphs.some((each) => each.id === graph) &&
        !ownership?.agents.some((each) => each.graph === graph)
      )
        throw new AgentError(
          `Committed graph ${graph} has no durable competition ownership`,
        );
      await this.stopOwners(service, ownership, solver);
    } catch (stopError) {
      let recovery = "Ownership metadata could not be saved.";
      try {
        // Diagnostic only, never authority for verification or project binding.
        // Exclusive creation refuses a pre-existing file or symlink.
        const file = path.join(
          competitionDir(root, competition.id),
          `orphan-${owner}.json`,
        );
        fs.writeFileSync(
          file,
          JSON.stringify({ graph, competition }, null, 2),
          { flag: "wx", mode: 0o600 },
        );
        recovery = `Recovery ownership: ${file}.`;
      } catch {}
      throw new AgentError(
        `${errorText(failure)}; reconciling/stopping owners${graph ? ` of graph ${graph}` : ""} failed: ${errorText(stopError)}. Competition ${competition.id} workspaces were preserved: ${competition.solvers.map((entry) => entry.workspace).join(", ")}. ${recovery} Resolve durable ownership before removing its workspaces.`,
      );
    }
  }

  /** Create the workspaces and start the solvers and judge as one graph,
   * whose result (the judge's verdict, or every solver's answer) arrives
   * like any graph's. */
  async start(
    service: AgentService,
    request: CompeteRequest,
    resolve: CompetitorResolver,
  ): Promise<Competition> {
    const root = this.requireRoot();
    if (!request.task.trim()) throw new AgentError("Name the task to solve");
    if (request.project) assertProjectCwd(request.cwd, request.project);
    const id = reserveCompetitionId(root);
    let competition: Competition | undefined;
    let started: string | undefined;
    let spawning = false;
    try {
      const plans = solverPlans(request, id, this.maxSolvers());
      const given = request.verify?.trim();
      const verify =
        given && given !== "none"
          ? given
          : given === "none"
            ? undefined
            : detectVerify(request.cwd);
      const workspaces = prepareWorkspaces({
        collabRoot: root,
        id,
        cwd: request.cwd,
        project: request.project,
        solvers: plans.map((plan) => plan.name),
      });
      const createdAt = Date.now();
      competition = {
        protocol: 1,
        id,
        task: request.task.trim(),
        createdAt,
        deadline:
          createdAt +
          (request.timeoutMinutes
            ? request.timeoutMinutes * 60_000
            : COMPETE_TIMEOUT_MS),
        cwd: workspaces.cwd,
        root: workspaces.root,
        git: workspaces.git,
        ...(verify ? { verify } : {}),
        verifySource:
          given && given !== "none" ? "given" : verify ? "detected" : "none",
        verifyTimeoutMs: VERIFY_TIMEOUT_MS,
        solvers: plans.map((plan, index) => ({
          ...plan,
          ...(workspaces.entries[index] as Omit<SolverEntry, keyof SolverPlan>),
        })),
        ...(request.judge === false
          ? {}
          : {
              judge: {
                name: `${id}-judge`,
                ...(request.judgeModel || request.model
                  ? { model: request.judgeModel ?? request.model }
                  : {}),
                ...(request.thinking ? { thinking: request.thinking } : {}),
              },
            }),
        status: "running",
      };
      if (competition.judge) {
        const brackets = bracketsOf(
          plans.map((plan) => plan.name),
          this.bracketSize(),
        );
        if (brackets.length > 0)
          competition.brackets = brackets.map((solvers, index) => ({
            judge: `${id}-judge-${index + 1}`,
            solvers,
          }));
      }
      assertBound(root, competition, request.project);
      sealCompetition(root, competition);
      writeCompetition(root, competition);
      const current = competition;
      const solvers = await Promise.all(
        current.solvers.map(async (entry) => ({
          ...(await resolve({
            job: solverJob(current, entry),
            name: entry.name,
            cwd: entry.cwd,
            ...(entry.model ? { model: entry.model } : {}),
            ...(entry.thinking ? { thinking: entry.thinking } : {}),
          })),
          collab: {
            group: id,
            role: "solver",
            competition: id,
            part: "solver" as const,
            solver: entry.name,
          },
        })),
      );
      const judge = current.judge
        ? {
            ...(await resolve({
              job: judgeJob(current),
              name: current.judge.name,
              cwd: current.cwd,
              tools: JUDGE_TOOLS,
              ...(current.judge.model ? { model: current.judge.model } : {}),
              ...(current.judge.thinking
                ? { thinking: current.judge.thinking }
                : {}),
            })),
            after: current.solvers.map((entry) => entry.name),
            collab: {
              group: id,
              role: "judge",
              competition: id,
              part: "judge" as const,
            },
          }
        : undefined;
      // Bracket judges each rank a group of solvers; the final judge,
      // after them, compares their finalists.
      const bracketJudges = await Promise.all(
        (current.brackets ?? []).map(async (bracket, index) => ({
          ...(await resolve({
            job: bracketJudgeJob(current, index),
            name: bracket.judge,
            cwd: current.cwd,
            tools: JUDGE_TOOLS,
            ...(current.judge?.model ? { model: current.judge.model } : {}),
            ...(current.judge?.thinking
              ? { thinking: current.judge.thinking }
              : {}),
          })),
          after: bracket.solvers,
          collab: {
            group: id,
            role: "judge",
            competition: id,
            part: "judge" as const,
            bracket: index,
          },
        })),
      );
      if (judge && bracketJudges.length > 0)
        judge.after = (current.brackets ?? []).map((each) => each.judge);
      spawning = true;
      const graph = await service.spawnGraph({
        name: `compete-${id}`,
        agents: [...solvers, ...bracketJudges, ...(judge ? [judge] : [])],
        maxAgents: plans.length + bracketJudges.length + 1,
      });
      started = graph.id;
      const byName = new Map(
        graph.nodes.map((node) => [node.name, node.agentId]),
      );
      const own = (record: Competition): Competition => ({
        ...record,
        graph: graph.id,
        solvers: record.solvers.map((entry) => ({
          ...entry,
          ...(byName.get(entry.name)
            ? { agentId: byName.get(entry.name) }
            : {}),
        })),
        ...(record.brackets
          ? {
              brackets: record.brackets.map((bracket) => ({
                ...bracket,
                ...(byName.get(bracket.judge)
                  ? { agentId: byName.get(bracket.judge) }
                  : {}),
              })),
            }
          : {}),
        ...(record.judge
          ? {
              judge: {
                ...record.judge,
                ...(byName.get(record.judge.name)
                  ? { agentId: byName.get(record.judge.name) }
                  : {}),
              },
            }
          : {}),
      });
      competition = own(current);
      competition = updateCompetition(root, id, own);
      return competition;
    } catch (error) {
      if (spawning && competition)
        await this.stopFailedSpawn(
          root,
          service,
          competition,
          error instanceof GraphStartedError ? error.graphId : started,
          "start",
          error,
        );
      if (competition) {
        discardWorkspaces(root, competition);
        unsealCompetition(root, id);
        try {
          writeCompetition(root, { ...competition, status: "discarded" });
        } catch {
          // The original persistence failure remains the actionable error.
        }
      } else
        fs.rmSync(path.join(root, "competitions", id), {
          recursive: true,
          force: true,
        });
      throw error;
    }
  }

  /** The comparison table; with `verify`, verify runs afresh and the details
   * follow. */
  async report(
    service: AgentService,
    id: string | undefined,
    options: {
      verify?: boolean;
      details?: boolean;
      signal?: AbortSignal;
      approval?: VerifyApproval;
      authorized?: boolean;
      project?: string;
    } = {},
  ): Promise<string> {
    const root = this.requireRoot();
    const { competition, unsafe } = this.inspect(id);
    if (unsafe.length) {
      const message = `Competition ${competition.id} (${competition.status}): unsafe paths refused: ${unsafe.join(", ")}. Status and discard remain available; comparison and verification are disabled.`;
      if (options.verify) throw new AgentError(message);
      return message;
    }
    if (options.authorized)
      approveCompetitionVerification(
        root,
        competition,
        options.approval,
        options.project,
      );
    const ownership = (await service.competitionOwners()).get(competition.id);
    const states = statesOf(service, competition, ownership);
    const comparison = await compare(this.requireRoot(), competition, states, {
      verify: options.verify === true,
      ...(options.approval ? { approval: options.approval } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    });
    const working = competition.solvers.filter((entry) =>
      ACTIVE.has(states[entry.name] ?? ""),
    );
    const left =
      Math.min(
        ...working.map((entry) => entry.deadline ?? competition.deadline),
      ) - Date.now();
    const judgeOwner = ownership?.agents.find(
      (owner) => owner.part === "judge" && owner.bracket === undefined,
    );
    const judge = judgeOwner
      ? service.agentById(judgeOwner.agentId)
      : undefined;
    const lines = [
      comparisonTable(comparison),
      ...(competition.brackets?.length
        ? [
            `Bracket judges: ${competition.brackets
              .map((bracket, index) => {
                const owner = ownership?.agents.find(
                  (owner) => owner.part === "judge" && owner.bracket === index,
                );
                const agent = owner
                  ? service.agentById(owner.agentId)
                  : undefined;
                return `${index + 1} ${bracket.judge} ${agent?.state ?? "pending"} (${bracket.solvers.join(", ")})`;
              })
              .join("; ")}`,
          ]
        : []),
      ...(judge ? [`Judge ${judge.name}: ${judge.state}`] : []),
      ...(competition.status !== "discarded" && working.length > 0
        ? [
            left > 0
              ? `${working.map((entry) => entry.name).join(", ")} still work${working.length === 1 ? "s" : ""}; unfinished work stops in ${Math.ceil(left / 60_000)} min.`
              : "Past the deadline; unfinished solvers are being stopped.",
          ]
        : []),
      `Workspaces: ${competition.solvers.map((entry) => `${entry.name} ${entry.cwd}`).join("; ")}`,
    ];
    if (options.details)
      lines.push("", comparisonDetails(comparison, { maxDiffChars: 4_000 }));
    return lines.join("\n");
  }

  /** Apply a solver's change to the main workspace. */
  async apply(
    service: AgentService,
    id: string | undefined,
    solver: string,
    project?: string,
  ) {
    const root = this.requireRoot();
    const competition = this.find(id);
    if (competition.status === "discarded")
      throw new AgentError(`Competition ${competition.id} was discarded`);
    const ownership = (await service.competitionOwners()).get(competition.id);
    if (ACTIVE.has(statesOf(service, competition, ownership)[solver] ?? ""))
      throw new AgentError(
        `${solver} still works; wait for it, or stop it first`,
      );
    const outcome = applySolution(root, competition, solver, { project });
    updateCompetition(root, competition.id, (record) => ({
      ...record,
      ...(outcome.ok ? { status: "applied" as const } : {}),
      applied: {
        solver,
        at: Date.now(),
        ok: outcome.ok,
        output: outcome.output,
      },
    }));
    return outcome;
  }

  /**
   * Start an agent that combines solutions in a workspace of its own and
   * submits the result as one more candidate, named `<id>-m<n>`. Like any
   * solution, it reaches the main workspace only through `apply`.
   */
  async merge(
    service: AgentService,
    id: string | undefined,
    request: MergeRequest,
    resolve: CompetitorResolver,
  ): Promise<SolverEntry> {
    const root = this.requireRoot();
    const competition = this.find(id);
    if (request.authorized)
      approveCompetitionVerification(
        root,
        competition,
        request.approval,
        request.project,
      );
    assertBound(root, competition, request.project);
    if (competition.status === "discarded")
      throw new AgentError(`Competition ${competition.id} was discarded`);
    const names = request.from?.length
      ? [...new Set(request.from.map((name) => name.trim()))]
      : await this.bestRanked(service, competition);
    const ownership = (await service.competitionOwners()).get(competition.id);
    const states = statesOf(service, competition, ownership);
    const sources = names.map((name) => {
      const entry = competition.solvers.find((each) => each.name === name);
      if (!entry)
        throw new AgentError(
          `No solver ${name} in ${competition.id}; solvers: ${competition.solvers.map((each) => each.name).join(", ")}`,
        );
      if (ACTIVE.has(states[name] ?? ""))
        throw new AgentError(`${name} still works; wait for it first`);
      if (!fs.existsSync(entry.workspace))
        throw new AgentError(`${name}'s workspace is gone`);
      if (collectDiff(entry).files.length === 0)
        throw new AgentError(`${name} changed nothing`);
      return entry;
    });
    if (sources.length < 2)
      throw new AgentError(
        `A merge needs two or more solutions with changes${request.from?.length ? "" : `; ${competition.id} has ${sources.length}`}.`,
      );
    const merges = competition.solvers.filter((entry) => entry.merge).length;
    const name = `${competition.id}-m${merges + 1}`;
    const first = sources[0] as SolverEntry;
    const workspace = prepareMergeWorkspace(root, competition, name, first, {
      project: request.project,
    });
    const guidance = request.guidance?.trim();
    const model = request.model ?? first.model;
    const thinking = request.thinking ?? first.thinking;
    const entry: SolverEntry = {
      ...workspace,
      ...(model ? { model } : {}),
      ...(thinking ? { thinking } : {}),
      merge: {
        from: sources.map((source) => source.name),
        ...(guidance ? { guidance } : {}),
      },
      deadline:
        Date.now() +
        (request.timeoutMinutes
          ? request.timeoutMinutes * 60_000
          : COMPETE_TIMEOUT_MS),
    };
    let added = false;
    let started: string | undefined;
    let spawning = false;
    let owned = entry;
    try {
      const patches = writeSourcePatches(root, competition, name, sources);
      const current = updateCompetition(root, competition.id, (record) => ({
        ...record,
        solvers: [...record.solvers, entry],
      }));
      added = true;
      const verdict = readVerdict(root, competition.id);
      const job = mergeJob(
        current,
        entry,
        sources.map((source) => {
          const submission = readSubmission(root, competition.id, source.name);
          return {
            entry: source,
            patch: patches[source.name] as string,
            ...(submission ? { submission } : {}),
          };
        }),
        verdict,
      );
      const spec = {
        ...(await resolve({
          job,
          name,
          cwd: entry.cwd,
          ...(model ? { model } : {}),
          ...(thinking ? { thinking } : {}),
        })),
        collab: {
          group: competition.id,
          role: "merger",
          competition: competition.id,
          part: "solver" as const,
          solver: name,
        },
      };
      spawning = true;
      const graph = await service.spawnGraph({
        name: `compete-${name}`,
        agents: [spec],
      });
      started = graph.id;
      const agentId = graph.nodes.find((node) => node.name === name)?.agentId;
      owned = { ...entry, graph: graph.id, ...(agentId ? { agentId } : {}) };
      const updated = updateCompetition(root, competition.id, (record) => ({
        ...record,
        solvers: record.solvers.map((each) =>
          each.name === name ? owned : each,
        ),
      }));
      return updated.solvers.find((each) => each.name === name) as SolverEntry;
    } catch (error) {
      if (spawning)
        await this.stopFailedSpawn(
          root,
          service,
          { ...competition, solvers: [owned] },
          error instanceof GraphStartedError ? error.graphId : started,
          name,
          error,
          name,
        );
      discardWorkspaces(
        root,
        { ...competition, solvers: [entry] },
        { project: request.project },
      );
      if (added) {
        try {
          updateCompetition(root, competition.id, (record) => ({
            ...record,
            solvers: record.solvers.filter((each) => each.name !== name),
          }));
        } catch {
          // Preserve the original failure; stopped workspaces are already safe.
        }
      }
      throw error;
    }
  }

  /** The two best solutions with changes: by the verdict's ranking, else
   * by the rubric. */
  private async bestRanked(
    service: AgentService,
    competition: Competition,
  ): Promise<string[]> {
    const root = this.requireRoot();
    const comparison = await compare(
      root,
      competition,
      statesOf(
        service,
        competition,
        (await service.competitionOwners()).get(competition.id),
      ),
      { verify: false },
    );
    const usable = new Set(
      comparison.rows
        .filter((row) => row.diff.files.length > 0 && !ACTIVE.has(row.state))
        .map((row) => row.solver),
    );
    const order = [
      ...(comparison.verdict?.ranking ?? []),
      ...comparison.suggested,
    ];
    return [...new Set(order)].filter((name) => usable.has(name)).slice(0, 2);
  }

  /** Stop what still works and remove the workspaces. */
  async discard(
    service: AgentService,
    id: string | undefined,
    project?: string,
  ): Promise<string> {
    const root = this.requireRoot();
    const { competition } = this.inspect(id);
    const dir = competitionDir(root, competition.id);
    // Neither saved graph IDs nor recovery sidecars are authority to stop work.
    const ownership = (await service.competitionOwners()).get(competition.id);
    await this.stopOwners(service, ownership);
    const { removed, refused } = discardWorkspaces(root, competition, {
      project,
    });
    for (const name of fs.readdirSync(dir))
      if (/^orphan-.*\.json$/.test(name)) fs.unlinkSync(path.join(dir, name));
    unsealCompetition(root, competition.id);
    updateCompetition(
      root,
      competition.id,
      (record) => ({
        ...record,
        status: record.status === "applied" ? "applied" : "discarded",
      }),
      { allowUnsafe: true },
    );
    return `Discarded competition ${competition.id}: removed ${removed.length} workspace${removed.length === 1 ? "" : "s"}.${refused.length ? ` Refused unsafe paths: ${refused.join(", ")}.` : ""} Submissions, the verdict, and patches stay in ${path.join(root, "competitions", competition.id)}.`;
  }

  /** Stop the unfinished solvers of competitions past their deadline. */
  async expire(service: AgentService, now = Date.now()): Promise<string[]> {
    const root = this.root();
    if (!root) return [];
    const stopped: string[] = [];
    let expiredIds = expiredSolvers.get(service);
    if (!expiredIds) {
      expiredIds = new Set();
      expiredSolvers.set(service, expiredIds);
    }
    const ownership = await service.competitionOwners();
    for (const { competition } of listCompetitionStates(root)) {
      const overdue =
        ownership.get(competition.id)?.agents.filter((owner) => {
          if (
            owner.part !== "solver" ||
            owner.stopped ||
            expiredIds.has(owner.agentId)
          )
            return false;
          const entry = competition.solvers.find(
            (each) => each.name === owner.solver,
          );
          return (
            (entry?.deadline ?? competition.deadline) <= now &&
            ACTIVE.has(stateOf(service, owner))
          );
        }) ?? [];
      if (overdue.length === 0) continue;
      const expired: string[] = [];
      for (const owner of overdue) {
        try {
          await service.stopTarget({
            kind: "agent",
            id: owner.agentId,
          });
          expiredIds.add(owner.agentId);
          const name = owner.solver ?? owner.agentId;
          stopped.push(name);
          expired.push(name);
        } catch {}
      }
      if (expired.length) {
        try {
          updateCompetition(
            root,
            competition.id,
            (record) => ({
              ...record,
              timedOut: [...new Set([...(record.timedOut ?? []), ...expired])],
            }),
            { allowUnsafe: true },
          );
        } catch {
          // A broken record must not prevent stopping other competitions.
        }
      }
    }
    return stopped;
  }
}

/** Marks stopped members exited and enforces deadlines, throttled. */
export class CollabMonitor {
  private last = 0;
  private running = false;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly host: Pick<SessionHost, "current" | "collabRoot">,
    private readonly competitions: Competitions,
  ) {}

  /** Check every few seconds, also while nothing changes, so deadlines
   * hold in a quiet session. */
  arm(intervalMs = 10_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(true), intervalMs);
    this.timer.unref?.();
  }

  disarm(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async tick(force = false): Promise<void> {
    const now = Date.now();
    if (this.running || (!force && now - this.last < 2_000)) return;
    const service = this.host.current();
    const root = this.host.collabRoot();
    if (!service || !root) return;
    this.arm();
    this.running = true;
    this.last = now;
    try {
      for (const info of service.list({ includeClosed: true })) {
        if (!info.collab || info.collab.competition) continue;
        const store = collabStore(root, info.collab.group);
        const key = collabKey(info.id);
        const member = store.member(key);
        if (member?.status !== "live") continue;
        // Stopped members leave, releasing their claims; the others' states
        // stay current for /collab.
        if (service.isStopped(info.id))
          store.setStatus(key, "exited", "stopped");
        else if (member.state !== info.state)
          store.setStatus(key, "live", info.state);
      }
      await this.competitions.expire(service, now);
    } catch {
      // The next tick tries again.
    } finally {
      this.running = false;
    }
  }
}

/** What `/collab` and `collab_status` show of a session's groups. */
export function collabReport(
  root: string | undefined,
  group: string | undefined,
  view: string,
): string {
  if (!root) return "Agents aren't ready in this session yet.";
  // Validate before opening a store: a status read must not create a group.
  if (group !== undefined) resolveCollab({ group }, "parent", root);
  const groups = listGroups(root);
  if (group !== undefined && !groups.includes(group))
    return `No collab group ${group}.`;
  if (view === "groups" || (!group && groups.length === 0))
    return groups.length
      ? `Collab groups: ${groups.join(", ")}`
      : "No collab groups yet. Every agent you spawn joins the main group (or the group it names) and shares its blackboard, claims, and structured messages.";
  const name = group ?? (groups.includes("main") ? "main" : groups[0]);
  if (!name) return "No collab groups yet.";
  resolveCollab({ group: name }, "parent", root);
  const store = collabStore(root, name);
  switch (view) {
    case "board":
      return (
        store
          .board({ all: true, limit: 100 })
          .map(
            (entry) =>
              `${entryLine(entry)}${entry.body ? `\n  ${entry.body.replace(/\n/g, "\n  ")}` : ""}`,
          )
          .join("\n") || `The blackboard of ${name} is empty.`
      );
    case "claims":
      return (
        store.claims().map(claimLine).join("\n") || `No claims in ${name}.`
      );
    case "tasks":
      return (
        store
          .tasks()
          .map((task) => `${isClosedTask(task) ? "✓" : "•"} ${taskLine(task)}`)
          .join("\n") || `No tasks in ${name}.`
      );
    case "messages":
      return (
        store.messages(50).reverse().map(messageLine).join("\n") ||
        `No messages in ${name}.`
      );
    default:
      return overview(store);
  }
}

const competeParameters = Type.Object({
  action: Type.Optional(
    StringEnum(
      ["start", "status", "compare", "merge", "apply", "discard"] as const,
      {
        description:
          '"start" (default) a competition; "status" its table; "compare" runs verify everywhere and shows each solution; "merge" starts an agent that combines solutions (from, default the two best ranked) into a new candidate; "apply" a solver\'s or merge\'s change to the main workspace, only when the user asks; "discard" stops it and removes its workspaces',
      },
    ),
  ),
  task: Type.Optional(
    Type.String({
      description:
        "For start: the self-contained task every solver solves; solvers can't see this conversation",
    }),
  ),
  solvers: Type.Optional(
    Type.Integer({
      minimum: SOLVER_COUNT.min,
      description:
        "For start: how many solvers; default 3, at most 6 unless the session raised the limit",
    }),
  ),
  variants: Type.Optional(
    Type.Array(
      Type.Object({
        name: Type.Optional(
          Type.String({
            description:
              "Solver name: letters, digits, underscores and dashes; starts with a letter or digit, at most 64 characters. Other characters become dashes; duplicates receive a numeric suffix. Judge and merge names are reserved.",
          }),
        ),
        hint: Type.Optional(
          Type.String({
            description:
              'A strategy for this solver, replacing its default one; "" for none',
          }),
        ),
        model: Type.Optional(Type.String()),
        thinking: Type.Optional(StringEnum(THINKING_LEVELS)),
      }),
      {
        minItems: SOLVER_COUNT.min,
        description:
          "For start: one entry per solver, with its own strategy or model; replaces solvers",
      },
    ),
  ),
  model: Type.Optional(
    Type.String({
      description: "For start: every agent's model; for merge: the merger's",
    }),
  ),
  thinking: Type.Optional(StringEnum(THINKING_LEVELS)),
  verify: Type.Optional(
    Type.String({
      description:
        'For start: the command that checks a solution, run in each workspace, such as "bun test"; detected from the project by default; "none" for none',
    }),
  ),
  judge: Type.Optional(
    Type.Boolean({
      description:
        "For start: add a judge that ranks the solutions after the solvers; default true. Without one, every solver's answer arrives",
    }),
  ),
  judgeModel: Type.Optional(Type.String()),
  timeoutMinutes: Type.Optional(
    Type.Number({
      minimum: 1,
      description:
        "For start and merge: stop solvers or the merger still working after this long; default 30",
    }),
  ),
  cwd: Type.Optional(
    Type.String({ description: "For start: the main workspace" }),
  ),
  id: Type.Optional(
    Type.String({
      description: "The competition, such as c1; default the newest",
    }),
  ),
  solver: Type.Optional(
    Type.String({
      description: "For apply: the solver or merge whose change to apply",
    }),
  ),
  from: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "For merge: the solvers whose solutions to combine; default the two best ranked by the verdict, else the rubric",
    }),
  ),
  guidance: Type.Optional(
    Type.String({
      description:
        "For merge: what to take from which solution, such as the judge's merge proposal or the user's wishes",
    }),
  ),
});

function show(pi: ExtensionAPI, content: string): void {
  pi.sendMessage({ customType: COLLAB_MESSAGE_TYPE, content, display: true });
}

/** Model-selected shell commands require an interactive, explicit approval.
 * Slash commands are user-originated and do not pass through this gate. */
export async function confirmModelVerify(
  ctx: Pick<ExtensionContext, "hasUI" | "ui">,
  command: string | undefined,
  timeoutMs?: number,
): Promise<void> {
  if (!command) return;
  if (!ctx.hasUI)
    throw new AgentError(
      "Model-requested verification requires UI confirmation; use /compete explicitly or disable verify with verify: none.",
    );
  if (
    !(await ctx.ui.confirm(
      "Run competition verification?",
      `Run this shell command in competition workspaces?\n\n${command}${timeoutMs === undefined ? "" : `\nTimeout: ${timeoutMs} ms`}\n\nThe environment is filtered by default, but this is not a sandbox: files, HOME, network and shared dependencies remain accessible.`,
    ))
  )
    throw new AgentError("Competition verification was not confirmed");
}

function reply(text: string) {
  return { content: [{ type: "text" as const, text }], details: {} };
}

/** The Pi tools and commands: `agent_compete`, `collab_status`,
 * `/compete`, and `/collab`. */
export function registerCollab(
  pi: ExtensionAPI,
  host: SessionHost,
): { competitions: Competitions; monitor: CollabMonitor } {
  const competitions = new Competitions(
    () => host.collabRoot(),
    () => host.limits().maxSolvers,
    () => host.limits().judgeBracketSize,
  );
  const monitor = new CollabMonitor(host, competitions);
  const resolver =
    (ctx: ExtensionContext): CompetitorResolver =>
    (request) => {
      const tools = inheritedTools(pi.getActiveTools());
      return resolveSpawn(
        {
          job: request.job,
          name: request.name,
          cwd: request.cwd,
          ...(request.model ? { model: request.model } : {}),
          ...(request.thinking ? { thinking: request.thinking } : {}),
          ...(request.tools ? { tools: request.tools } : {}),
        },
        ctx,
        {
          skills: host.skills.get,
          thinking: pi.getThinkingLevel(),
          ...(tools ? { tools } : {}),
        },
      );
    };

  pi.registerTool({
    name: "agent_compete",
    label: "Compete",
    description:
      "Have several agents solve the same task independently, each in its own copy of the workspace and blind to the others, then compare their solutions: diffs, a verify command's results, and an optional judge's ranking. Returns at once; the judge's verdict (or the solvers' answers) arrives as one message. Nothing reaches the main workspace until action apply, which you run only when the user asks.",
    promptGuidelines: [
      "Use agent_compete when the user wants several independent attempts at one task compared, not for ordinary parallel work (agent_spawn).",
      "Never apply a competition's solution unless the user asked for it.",
      "When solutions each get something right, offer action merge; a merge is one more candidate, applied like any other only when the user asks.",
    ],
    parameters: competeParameters,
    async execute(_id, params, signal, _onUpdate, ctx) {
      let service: AgentService;
      try {
        service = await host.ensure(ctx);
      } catch (error) {
        throw new Error(`Agents are unavailable: ${errorText(error)}`);
      }
      monitor.arm();
      const action = params.action ?? "start";
      try {
        if (action === "start") {
          if (!params.task?.trim()) throw new Error("start needs a task");
          const cwd = path.resolve(ctx.cwd, params.cwd ?? ".");
          assertProjectCwd(cwd, ctx.cwd);
          const given = params.verify?.trim();
          const verify =
            given === "none" ? undefined : given || detectVerify(cwd);
          await confirmModelVerify(ctx, verify, VERIFY_TIMEOUT_MS);
          const competition = await competitions.start(
            service,
            {
              task: params.task,
              cwd,
              project: ctx.cwd,
              ...(params.solvers ? { solvers: params.solvers } : {}),
              ...(params.variants ? { variants: params.variants } : {}),
              ...(params.model ? { model: params.model } : {}),
              ...(params.thinking ? { thinking: params.thinking } : {}),
              // Freeze the command approved above, including no command.
              verify: verify ?? "none",
              ...(params.judge !== undefined ? { judge: params.judge } : {}),
              ...(params.judgeModel ? { judgeModel: params.judgeModel } : {}),
              ...(params.timeoutMinutes
                ? { timeoutMinutes: params.timeoutMinutes }
                : {}),
            },
            resolver(ctx),
          );
          return reply(startedText(competition));
        }
        if (action === "status")
          return reply(await competitions.report(service, params.id));
        if (action === "compare") {
          const competition = competitions.find(params.id);
          const approval = competitions.snapshot(competition);
          await confirmModelVerify(ctx, approval?.command, approval?.timeoutMs);
          return reply(
            await competitions.report(service, competition.id, {
              verify: true,
              details: true,
              approval,
              authorized: true,
              project: ctx.cwd,
              ...(signal ? { signal } : {}),
            }),
          );
        }
        if (action === "merge") {
          const competition = competitions.find(params.id);
          const approval = competitions.snapshot(competition);
          await confirmModelVerify(ctx, approval?.command, approval?.timeoutMs);
          const entry = await competitions.merge(
            service,
            competition.id,
            {
              approval,
              authorized: true,
              project: ctx.cwd,
              ...(params.from ? { from: params.from } : {}),
              ...(params.guidance ? { guidance: params.guidance } : {}),
              ...(params.model ? { model: params.model } : {}),
              ...(params.thinking ? { thinking: params.thinking } : {}),
              ...(params.timeoutMinutes
                ? { timeoutMinutes: params.timeoutMinutes }
                : {}),
            },
            resolver(ctx),
          );
          return reply(mergeStartedText(entry, params.id));
        }
        if (action === "apply") {
          if (!params.solver) throw new Error("apply needs the solver");
          const outcome = await competitions.apply(
            service,
            params.id,
            params.solver,
            ctx.cwd,
          );
          if (!outcome.ok) throw new Error(outcome.output);
          return reply(outcome.output);
        }
        return reply(await competitions.discard(service, params.id, ctx.cwd));
      } catch (error) {
        throw new Error(errorText(error));
      }
    },
  });

  pi.registerTool({
    name: "collab_status",
    label: "Collab status",
    description:
      "Read this session's collab groups: members, claims, open tasks, blackboard, and recent structured messages of its agents.",
    parameters: Type.Object({
      group: Type.Optional(
        Type.String({
          description: 'The group; default "main" or the only one',
        }),
      ),
      view: Type.Optional(
        StringEnum([
          "overview",
          "board",
          "claims",
          "tasks",
          "messages",
          "groups",
        ] as const),
      ),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      await host.ensure(ctx).catch(() => undefined);
      return reply(
        collabReport(
          host.collabRoot(),
          params.group,
          params.view ?? "overview",
        ),
      );
    },
  });

  pi.registerCommand("collab", {
    description:
      "Show this session's collab groups: /collab [group] [board|claims|tasks|messages|groups]",
    getArgumentCompletions: (prefix) => {
      const words = ["board", "claims", "tasks", "messages", "groups"].filter(
        (word) => word.startsWith(prefix),
      );
      return words.length
        ? words.map((value) => ({ value, label: value }))
        : null;
    },
    handler: async (args, ctx) => {
      await host.ensure(ctx).catch(() => undefined);
      const words = args.trim().split(/\s+/).filter(Boolean);
      const views = [
        "board",
        "claims",
        "tasks",
        "messages",
        "groups",
        "overview",
      ];
      const view = words.find((word) => views.includes(word)) ?? "overview";
      const group = words.find((word) => !views.includes(word));
      show(pi, collabReport(host.collabRoot(), group, view));
    },
  });

  pi.registerCommand("compete", {
    description:
      "Competitions: /compete [list] | show [id] | compare [id] | merge [id] [solvers…] | apply <id> <solver> | discard [id] | <task> to start one with 3 solvers",
    getArgumentCompletions: (prefix) => {
      const words = [
        "list",
        "show",
        "compare",
        "merge",
        "apply",
        "discard",
        "help",
      ].filter((word) => word.startsWith(prefix));
      return words.length
        ? words.map((value) => ({ value, label: value }))
        : null;
    },
    handler: async (args, ctx) => {
      const words = args.trim().split(/\s+/).filter(Boolean);
      const command = words[0] ?? "list";
      try {
        const service = await host.ensure(ctx);
        monitor.arm();
        switch (command) {
          case "help":
            return show(pi, COMPETE_USAGE);
          case "list": {
            const all = competitions.list();
            return show(
              pi,
              all.length
                ? all
                    .map(
                      (competition) =>
                        `${competition.id} ${competition.status} ${competition.solvers.length} solvers${competition.applied ? `, applied ${competition.applied.solver}` : ""}: ${competition.task.split("\n")[0]?.slice(0, 80)}`,
                    )
                    .join("\n")
                : `No competitions yet.\n${COMPETE_USAGE}`,
            );
          }
          case "show":
            return show(pi, await competitions.report(service, words[1]));
          case "compare": {
            const competition = competitions.find(words[1]);
            const approval = competitions.snapshot(competition);
            return show(
              pi,
              await competitions.report(service, competition.id, {
                verify: true,
                details: true,
                approval,
                authorized: true,
                project: ctx.cwd,
              }),
            );
          }
          case "apply": {
            const [id, solver] =
              words.length >= 3 ? [words[1], words[2]] : [undefined, words[1]];
            if (!solver) return show(pi, "Usage: /compete apply <id> <solver>");
            return show(
              pi,
              (await competitions.apply(service, id, solver, ctx.cwd)).output,
            );
          }
          case "merge": {
            // merge [id] [solver …]: a first word naming a competition is
            // its ID.
            const rest = words.slice(1);
            const id =
              rest[0] && competitions.list().some((each) => each.id === rest[0])
                ? rest.shift()
                : undefined;
            const competition = competitions.find(id);
            const approval = competitions.snapshot(competition);
            const entry = await competitions.merge(
              service,
              competition.id,
              {
                ...(rest.length ? { from: rest } : {}),
                approval,
                authorized: true,
                project: ctx.cwd,
              },
              resolver(ctx),
            );
            return show(pi, mergeStartedText(entry, id));
          }
          case "discard":
            return show(
              pi,
              await competitions.discard(service, words[1], ctx.cwd),
            );
          default: {
            const competition = await competitions.start(
              service,
              { task: args.trim(), cwd: ctx.cwd, project: ctx.cwd },
              resolver(ctx),
            );
            return show(pi, startedText(competition));
          }
        }
      } catch (error) {
        show(pi, `Competition: ${errorText(error)}`);
      }
    },
  });

  return { competitions, monitor };
}

const COMPETE_USAGE = [
  "/compete <task>                  start a competition: 3 solvers and a judge",
  "/compete list                    competitions of this session",
  "/compete show [id]               the comparison table (cached verify results)",
  "/compete compare [id]            run verify everywhere; table and each solution",
  "/compete merge [id] [solvers…]   combine solutions (default the two best) into a new candidate",
  "/compete apply <id> <solver>     apply a solver's or merge's change to this workspace",
  "/compete discard [id]            stop it and remove its workspaces",
].join("\n");

function mergeStartedText(entry: SolverEntry, id: string | undefined): string {
  const competition = entry.name.replace(/-m\d+$/, "");
  return [
    `Started ${entry.name}: it combines ${entry.merge?.from.join(" + ")} in its own workspace (${entry.cwd}), runs verify, and submits the result as a new candidate of ${id ?? competition}.`,
    `Its answer arrives as one message. Then compare it (agent_compete action "status", or /compete show ${competition}) and apply ${entry.name} only when the user asks; nothing changed in this workspace.`,
  ].join("\n");
}

function startedText(competition: Competition): string {
  return [
    `Started competition ${competition.id}: ${competition.solvers.length} solvers (${competition.solvers.map((entry) => entry.name).join(", ")}), each in its own ${competition.git ? "worktree" : "copy"} of ${competition.root}${competition.judge ? `; judge ${competition.judge.name} ranks them once they finished` : ""}.`,
    `Verify: ${competition.verify ? `\`${competition.verify}\` (${competition.verifySource})` : "none"}. Unfinished solvers stop after ${Math.round((competition.deadline - competition.createdAt) / 60_000)} min.`,
    `${competition.judge ? "The judge's verdict arrives" : "The solvers' answers arrive"} as one message. Then: agent_compete action "status" or "compare" (or /compete show ${competition.id}), and action "apply" with a solver only when the user asks.`,
  ].join("\n");
}
