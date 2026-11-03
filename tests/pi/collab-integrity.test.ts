import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { AgentService } from "../../src/agents/service.js";
import {
  type CompetitionOwnership,
  GraphStartedError,
} from "../../src/agents/types.js";
import {
  collectDiff,
  competitionSeal,
  inspectCompetition,
  readCompetition,
  unsealCompetition,
  verifySolver,
  writeCompetition,
} from "../../src/collab/compete.js";
import { Competitions, registerCollab } from "../../src/pi/collab.js";
import type { SessionHost } from "../../src/pi/session.js";

const directories: string[] = [];
function temporary() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-collab-integrity-"));
  directories.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of directories.splice(0))
    fs.rmSync(dir, { recursive: true, force: true });
});
function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Missing fixture");
  return value;
}
const resolver = async (request: { name: string; cwd: string; job: string }) =>
  request;
function gitRepository() {
  const cwd = temporary();
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  git("init", "--quiet");
  git(
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.invalid",
    "-c",
    "core.hooksPath=/dev/null",
    "commit",
    "--allow-empty",
    "-m",
    "base",
    "--quiet",
  );
  return { cwd, git };
}
async function fixture(verify = "none") {
  const root = temporary();
  const cwd = temporary();
  fs.writeFileSync(path.join(cwd, "file.txt"), "base");
  const service = {
    spawnGraph: async () => ({ id: "initial", nodes: [] }),
    graphs: () => [],
    competitionOwners: async () => new Map(),
  } as unknown as AgentService;
  const competitions = new Competitions(() => root);
  const competition = await competitions.start(
    service,
    { task: "task", cwd, verify, solvers: 2, judge: false },
    resolver,
  );
  for (const entry of competition.solvers)
    fs.writeFileSync(path.join(entry.cwd, "file.txt"), entry.name);
  return { root, cwd, service, competitions, competition };
}
function registration(root: string, service: AgentService) {
  let tool: Parameters<ExtensionAPI["registerTool"]>[0] | undefined;
  let command: Parameters<ExtensionAPI["registerCommand"]>[1] | undefined;
  const messages: string[] = [];
  const pi = {
    registerTool(value: Parameters<ExtensionAPI["registerTool"]>[0]) {
      if (value.name === "agent_compete") tool = value;
    },
    registerCommand(
      name: string,
      value: Parameters<ExtensionAPI["registerCommand"]>[1],
    ) {
      if (name === "compete") command = value;
    },
    sendMessage(value: { content: string }) {
      messages.push(value.content);
    },
  } as unknown as ExtensionAPI;
  const host = {
    collabRoot: () => root,
    ensure: async () => service,
  } as unknown as SessionHost;
  return {
    ...registerCollab(pi, host),
    tool: required(tool),
    command: required(command),
    messages,
  };
}

describe("post-spawn ownership", () => {
  for (const operation of ["start", "merge"] as const) {
    for (const stopFails of [false, true]) {
      test(`${operation}: failed persistence ${stopFails ? "preserves orphan ownership on stop failure" : "awaits stop before cleanup"}`, async () => {
        const f = await fixture();
        const id = operation === "start" ? "c2" : f.competition.id;
        const recordPath = path.join(
          f.root,
          "competitions",
          id,
          "competition.json",
        );
        let workspaces: string[] = [];
        let release: (() => void) | undefined;
        let stopping: (() => void) | undefined;
        const stopped = new Promise<void>((resolve) => {
          release = resolve;
        });
        const stoppingStarted = new Promise<void>((resolve) => {
          stopping = resolve;
        });
        f.service.spawnGraph = async () => {
          const record = required(readCompetition(f.root, id));
          const entries =
            operation === "start" ? record.solvers : record.solvers.slice(-1);
          workspaces = entries.map((entry) => entry.workspace);
          f.service.competitionOwners = async () =>
            new Map([
              [
                id,
                {
                  agents: entries.map((entry) => ({
                    agentId: `agent-${entry.name}`,
                    graph: "orphan-graph",
                    part: "solver" as const,
                    solver: entry.name,
                    stopped: false,
                  })),
                  graphs: [{ id: "orphan-graph", closed: false }],
                },
              ],
            ]);
          fs.rmSync(recordPath);
          fs.mkdirSync(recordPath); // Inject the post-spawn record failure.
          return {
            id: "orphan-graph",
            nodes: entries.map((entry) => ({
              name: entry.name,
              agentId: `agent-${entry.name}`,
            })),
          } as Awaited<ReturnType<AgentService["spawnGraph"]>>;
        };
        f.service.stopTarget = async (target) => {
          expect(target).toEqual({ kind: "graph", id: "orphan-graph" });
          expect(
            workspaces.every((workspace) => fs.existsSync(workspace)),
          ).toBe(true);
          required(stopping)();
          await stopped;
          if (stopFails) throw new Error("injected stop failure");
        };
        const pending =
          operation === "start"
            ? f.competitions.start(
                f.service,
                {
                  task: "task",
                  cwd: f.cwd,
                  solvers: 2,
                  judge: false,
                  verify: "none",
                },
                resolver,
              )
            : f.competitions.merge(
                f.service,
                id,
                { from: f.competition.solvers.map((entry) => entry.name) },
                resolver,
              );
        const outcome = pending.then(
          () => "unexpected success",
          (error: Error) => error.message,
        );
        await stoppingStarted;
        expect(workspaces.every((workspace) => fs.existsSync(workspace))).toBe(
          true,
        );
        required(release)();
        const message = await outcome;
        expect(message).not.toBe("unexpected success");
        expect(workspaces.every((workspace) => fs.existsSync(workspace))).toBe(
          stopFails,
        );
        if (stopFails) {
          expect(message).toContain("orphan-graph");
          expect(message).toContain("Recovery ownership:");
          const owner = operation === "start" ? "start" : `${id}-m1`;
          const recovery = JSON.parse(
            fs.readFileSync(
              path.join(f.root, "competitions", id, `orphan-${owner}.json`),
              "utf8",
            ),
          );
          expect(recovery.graph).toBe("orphan-graph");
          expect(
            recovery.competition.solvers.map(
              (entry: { workspace: string }) => entry.workspace,
            ),
          ).toEqual(workspaces);
          expect(
            recovery.competition.solvers.every(
              (entry: { agentId?: string }) => entry.agentId,
            ),
          ).toBe(true);
          // Even after record repair/restart, missing graph projection must not
          // allow discard to delete a workspace whose owner failed to stop.
          fs.rmSync(recordPath, { recursive: true });
          writeCompetition(f.root, recovery.competition);
          const restored = new Competitions(() => f.root);
          await expect(restored.discard(f.service, id)).rejects.toThrow(
            "injected stop failure",
          );
          fs.rmSync(
            path.join(f.root, "competitions", id, `orphan-${owner}.json`),
          );
          // Losing the sidecar does not lose this process's captured owner.
          await expect(f.competitions.discard(f.service, id)).rejects.toThrow(
            "injected stop failure",
          );
          expect(
            workspaces.every((workspace) => fs.existsSync(workspace)),
          ).toBe(true);
        }
        // A failed merge must never delete its source candidates.
        expect(
          f.competition.solvers.every((entry) =>
            fs.existsSync(entry.workspace),
          ),
        ).toBe(true);
      });
    }
  }
});

describe("unsafe records and expiry", () => {
  test("unsafe newest record cannot redirect privileged defaults; expiry still stops every overdue solver and retries failures", async () => {
    const f = await fixture();
    const external = temporary();
    const changed = {
      ...f.competition,
      deadline: 1,
      solvers: f.competition.solvers.map((entry, index) => ({
        ...entry,
        agentId: `agent-${index}`,
        ...(index === 0 ? { cwd: external, workspace: external } : {}),
      })),
    };
    writeCompetition(f.root, changed);
    const owners: CompetitionOwnership = {
      agents: changed.solvers.map((entry, index) => ({
        agentId: `agent-${index}`,
        graph: "initial",
        part: "solver",
        solver: entry.name,
        stopped: false,
      })),
      graphs: [],
    };
    f.service.competitionOwners = async () => new Map([[changed.id, owners]]);
    f.service.agentById = () =>
      ({ state: "working" }) as ReturnType<AgentService["agentById"]>;
    f.service.isStopped = () => false;
    const stopped: string[] = [];
    f.service.stopTarget = async (target) => {
      stopped.push(target.id);
      if (target.id === "agent-0" && stopped.length === 1)
        throw new Error("retry me");
      required(
        owners.agents.find((owner) => owner.agentId === target.id),
      ).stopped = true;
    };
    expect(f.competitions.list()).toHaveLength(1);
    expect(() => f.competitions.find()).toThrow("Unsafe workspace");
    await expect(
      f.competitions.report(f.service, undefined, { verify: true }),
    ).rejects.toThrow("unsafe paths refused");
    expect(await f.competitions.expire(f.service, 2)).toEqual([
      changed.solvers[1]?.name as string,
    ]);
    expect(stopped).toEqual(["agent-0", "agent-1"]);
    expect(await new Competitions(() => f.root).expire(f.service, 2)).toEqual([
      changed.solvers[0]?.name as string,
    ]);
    expect(
      required(inspectCompetition(f.root, changed.id)).competition.timedOut,
    ).toHaveLength(2);
    unsealCompetition(f.root, changed.id);
    expect(await f.competitions.discard(f.service, changed.id)).toContain(
      "Refused unsafe paths",
    );
    expect(fs.existsSync(external)).toBe(true);
    expect(fs.existsSync(required(changed.solvers[1]).workspace)).toBe(false);
  });

  test("successful expiry survives monitor recreation and user resume; new durable IDs keep their own deadline", async () => {
    const f = await fixture();
    const entry = required(f.competition.solvers[0]);
    const owner = {
      agentId: "original",
      graph: "initial",
      part: "solver" as const,
      solver: entry.name,
      stopped: false,
    };
    const owners: CompetitionOwnership = { agents: [owner], graphs: [] };
    f.service.competitionOwners = async () => new Map([["c1", owners]]);
    f.service.agentById = () =>
      ({ state: "working" }) as ReturnType<AgentService["agentById"]>;
    const stopped: string[] = [];
    f.service.stopTarget = async (target) => {
      stopped.push(target.id);
      required(
        owners.agents.find((each) => each.agentId === target.id),
      ).stopped = true;
    };
    writeCompetition(f.root, { ...f.competition, deadline: 1 });
    expect(await f.competitions.expire(f.service, 2)).toEqual([entry.name]);
    expect(owner.stopped).toBe(true);
    // A user message clears the durable stopped flag and resumes this solver.
    owner.stopped = false;
    writeCompetition(f.root, { ...f.competition, deadline: 1, timedOut: [] });
    const restored = new Competitions(() => f.root);
    expect(await restored.expire(f.service, 2)).toEqual([]);
    expect(stopped).toEqual(["original"]);
    // The same solver name does not exempt a newly owned agent from expiry.
    const replacement = { ...owner, agentId: "replacement" };
    owners.agents.push(replacement);
    writeCompetition(f.root, {
      ...f.competition,
      deadline: 1,
      timedOut: [entry.name],
      solvers: f.competition.solvers.map((each) =>
        each.name === entry.name ? { ...each, deadline: 10 } : each,
      ),
    });
    expect(await restored.expire(f.service, 9)).toEqual([]);
    expect(await restored.expire(f.service, 10)).toEqual([entry.name]);
    replacement.stopped = false;
    expect(await f.competitions.expire(f.service, 11)).toEqual([]);
    expect(stopped).toEqual(["original", "replacement"]);
  });

  test("an unsafe competition and a failed stop do not block another competition's expiry", async () => {
    const f = await fixture();
    const next = await f.competitions.start(
      f.service,
      { task: "next", cwd: f.cwd, verify: "none", solvers: 2, judge: false },
      resolver,
    );
    const external = temporary();
    writeCompetition(f.root, {
      ...f.competition,
      deadline: 1,
      solvers: f.competition.solvers.map((entry, index) =>
        index === 0 ? { ...entry, workspace: external, cwd: external } : entry,
      ),
    });
    writeCompetition(f.root, { ...next, deadline: 1 });
    f.service.competitionOwners = async () =>
      new Map(
        [f.competition, next].map((competition) => [
          competition.id,
          {
            agents: [
              {
                agentId: competition.id,
                graph: "initial",
                part: "solver" as const,
                solver: required(competition.solvers[0]).name,
                stopped: false,
              },
            ],
            graphs: [],
          },
        ]),
      );
    f.service.agentById = () => undefined;
    const attempted: string[] = [];
    f.service.stopTarget = async (target) => {
      attempted.push(target.id);
      if (target.id === "c1") throw new Error("retry later");
    };
    expect(await f.competitions.expire(f.service, 2)).toEqual([
      required(next.solvers[0]).name,
    ]);
    expect(attempted.sort()).toEqual(["c1", "c2"]);
    expect(fs.existsSync(external)).toBe(true);
  });

  test("unsealed cross-project apply returns a patch without changing either project", async () => {
    const f = await fixture();
    unsealCompetition(f.root, f.competition.id);
    const other = temporary();
    await expect(
      f.competitions.apply(
        f.service,
        f.competition.id,
        required(f.competition.solvers[0]).name,
        other,
      ),
    ).rejects.toThrow(
      "outside the session project. Nothing applied; the patch is at",
    );
    const patch = path.join(
      f.root,
      "competitions",
      f.competition.id,
      "patches",
      `${required(f.competition.solvers[0]).name}.patch`,
    );
    expect(fs.readFileSync(patch, "utf8")).toContain("file.txt");
    expect(fs.readFileSync(path.join(f.cwd, "file.txt"), "utf8")).toBe("base");
    expect(fs.readdirSync(other)).toEqual([]);
    expect(await f.competitions.discard(f.service, f.competition.id)).toContain(
      "removed 2 workspaces",
    );
  });
});

describe("durable competition membership", () => {
  test("hostile IDs cannot hide real owners, redirect expiry, or stop unrelated graphs", async () => {
    const f = await fixture();
    const first = required(f.competition.solvers[0]);
    const second = required(f.competition.solvers[1]);
    const owners: CompetitionOwnership = {
      agents: [
        {
          agentId: "real-a",
          graph: "pure",
          part: "solver",
          solver: first.name,
          stopped: false,
        },
        {
          agentId: "real-b",
          graph: "mixed",
          part: "solver",
          solver: second.name,
          stopped: false,
        },
        { agentId: "real-judge", graph: "pure", part: "judge", stopped: false },
      ],
      graphs: [{ id: "pure", closed: false }],
    };
    f.service.competitionOwners = async () =>
      new Map([[f.competition.id, owners]]);
    // A failed projection refresh must not make real owners appear finished.
    f.service.agentById = () => undefined;
    const stopped: unknown[] = [];
    f.service.stopTarget = async (target) => {
      stopped.push(target);
    };
    writeCompetition(f.root, {
      ...f.competition,
      graph: "unrelated-graph",
      deadline: 1,
      timedOut: [first.name, second.name],
      solvers: [
        { ...first, agentId: "unrelated-agent", graph: "unrelated-merge" },
      ],
    });
    await expect(
      f.competitions.apply(f.service, "c1", first.name),
    ).rejects.toThrow("still works");
    await expect(
      f.competitions.merge(
        f.service,
        "c1",
        { from: [first.name, second.name] },
        resolver,
      ),
    ).rejects.toThrow("still works");
    expect(await f.competitions.report(f.service, "c1")).toContain(
      "unfinished solvers are being stopped",
    );
    expect(await f.competitions.expire(f.service, 2)).toEqual([
      first.name,
      second.name,
    ]);
    expect(stopped).toEqual([
      { kind: "agent", id: "real-a" },
      { kind: "agent", id: "real-b" },
    ]);
    stopped.length = 0;
    // Sidecar IDs are diagnostic too, never authority for a stop operation.
    fs.writeFileSync(
      path.join(f.root, "competitions/c1/orphan-forged.json"),
      JSON.stringify({ graph: "unrelated-graph" }),
    );
    await f.competitions.discard(f.service, "c1", f.cwd);
    expect(stopped).toEqual([
      { kind: "graph", id: "pure" },
      { kind: "agent", id: "real-b" },
    ]);
    expect(fs.existsSync(second.workspace)).toBe(true); // Omitted path is not deletion authority.
  });

  test("unavailable ownership refuses active-state decisions and destructive cleanup", async () => {
    const f = await fixture();
    f.service.competitionOwners = async () => {
      throw new Error("ownership unavailable");
    };
    let stops = 0;
    f.service.stopTarget = async () => {
      stops++;
    };
    await expect(
      f.competitions.discard(f.service, "c1", f.cwd),
    ).rejects.toThrow("ownership unavailable");
    await expect(
      f.competitions.expire(f.service, Number.MAX_SAFE_INTEGER),
    ).rejects.toThrow("ownership unavailable");
    await expect(
      f.competitions.apply(
        f.service,
        "c1",
        required(f.competition.solvers[0]).name,
      ),
    ).rejects.toThrow("ownership unavailable");
    await expect(f.competitions.report(f.service, "c1")).rejects.toThrow(
      "ownership unavailable",
    );
    expect(stops).toBe(0);
    expect(
      f.competition.solvers.every((entry) => fs.existsSync(entry.workspace)),
    ).toBe(true);
  });
});

describe("spawn rejection reconciliation", () => {
  for (const operation of ["start", "merge"] as const) {
    for (const failure of ["typed", "ambiguous", "lookup"] as const) {
      test(`${operation}: ${failure} postcommit rejection reconciles before deletion`, async () => {
        const f = await fixture();
        const id = operation === "start" ? "c2" : "c1";
        let committed = false;
        let entries = f.competition.solvers.slice(0, 0);
        const sources: CompetitionOwnership = {
          agents: f.competition.solvers.map((entry) => ({
            agentId: `source-${entry.name}`,
            graph: "source-graph",
            part: "solver",
            solver: entry.name,
            stopped: false,
          })),
          graphs: [{ id: "source-graph", closed: false }],
        };
        f.service.agentById = () =>
          ({ state: "idle" }) as ReturnType<AgentService["agentById"]>;
        f.service.competitionOwners = async () => {
          if (!committed) return new Map([["c1", sources]]);
          if (failure === "lookup") throw new Error("ownership lookup failed");
          return new Map([
            [
              id,
              {
                agents: [
                  ...(operation === "merge" ? sources.agents : []),
                  ...entries.map((entry) => ({
                    agentId: `real-${entry.name}`,
                    graph: "committed",
                    part: "solver" as const,
                    solver: entry.name,
                    stopped: false,
                  })),
                ],
                graphs: [
                  ...(operation === "merge" ? sources.graphs : []),
                  { id: "committed", closed: false },
                ],
              },
            ],
          ]);
        };
        f.service.spawnGraph = async () => {
          const record = required(readCompetition(f.root, id));
          entries =
            operation === "start" ? record.solvers : record.solvers.slice(-1);
          committed = true;
          if (failure === "typed")
            throw new GraphStartedError(
              "committed",
              entries.map((entry) => `real-${entry.name}`),
              new Error("refresh failed"),
            );
          throw new Error("ambiguous commit failure");
        };
        const stopped: unknown[] = [];
        f.service.stopTarget = async (target) => {
          expect(entries.every((entry) => fs.existsSync(entry.workspace))).toBe(
            true,
          );
          stopped.push(target);
        };
        const pending =
          operation === "start"
            ? f.competitions.start(
                f.service,
                {
                  task: "task",
                  cwd: f.cwd,
                  project: f.cwd,
                  solvers: 2,
                  judge: false,
                  verify: "none",
                },
                resolver,
              )
            : f.competitions.merge(
                f.service,
                id,
                { from: f.competition.solvers.map((entry) => entry.name) },
                resolver,
              );
        await expect(pending).rejects.toThrow(
          failure === "typed" ? "refresh failed" : "ambiguous commit failure",
        );
        expect(entries.length).toBe(operation === "start" ? 2 : 1);
        expect(entries.every((entry) => fs.existsSync(entry.workspace))).toBe(
          failure === "lookup",
        );
        expect(stopped).toEqual(
          failure === "lookup" ? [] : [{ kind: "graph", id: "committed" }],
        );
        if (failure === "lookup") {
          const marker = path.join(
            f.root,
            "competitions",
            id,
            `orphan-${operation === "start" ? "start" : "c1-m1"}.json`,
          );
          expect(fs.existsSync(marker)).toBe(true);
          await expect(
            new Competitions(() => f.root).discard(f.service, id, f.cwd),
          ).rejects.toThrow("ownership lookup failed");
        }
        expect(
          f.competition.solvers.every((entry) =>
            fs.existsSync(entry.workspace),
          ),
        ).toBe(true);
      });
    }
  }
});

describe("restart discard project binding", () => {
  for (const origin of ["model", "slash"] as const) {
    test(`${origin} discard unregisters in-project worktrees without approving verification`, async () => {
      const root = temporary();
      const cwd = temporary();
      const git = (...args: string[]) =>
        execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
      git("init", "--quiet");
      git(
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.invalid",
        "-c",
        "core.hooksPath=/dev/null",
        "commit",
        "--allow-empty",
        "-m",
        "base",
        "--quiet",
      );
      const service = {
        spawnGraph: async () => ({ id: "initial", nodes: [] }),
        competitionOwners: async () => new Map(),
      } as unknown as AgentService;
      const competitions = new Competitions(() => root);
      const competition = await competitions.start(
        service,
        {
          task: "task",
          cwd,
          project: cwd,
          verify: "touch forbidden",
          solvers: 2,
          judge: false,
        },
        resolver,
      );
      expect(
        git("worktree", "list", "--porcelain").match(/^worktree /gm),
      ).toHaveLength(3);
      unsealCompetition(root, competition.id);
      const r = registration(root, service);
      const ctx = {
        cwd,
        hasUI: false,
        ui: {
          confirm: async () => {
            throw new Error("must not prompt");
          },
        },
      } as unknown as ExtensionContext;
      try {
        if (origin === "model")
          await r.tool.execute(
            "call",
            { action: "discard", id: "c1" },
            undefined,
            undefined,
            ctx,
          );
        else
          await r.command.handler(
            "discard c1",
            ctx as Parameters<typeof r.command.handler>[1],
          );
        expect(
          git("worktree", "list", "--porcelain").match(/^worktree /gm),
        ).toHaveLength(1);
        expect(competitionSeal(root, "c1")).toBeUndefined();
        expect(
          competition.solvers.every((entry) => !fs.existsSync(entry.workspace)),
        ).toBe(true);
        expect(fs.existsSync(path.join(cwd, "forbidden"))).toBe(false);
      } finally {
        r.monitor.disarm();
      }
    });
  }

  test("outside-project restored discard removes only contained workspaces and updates status", async () => {
    const f = await fixture();
    unsealCompetition(f.root, "c1");
    const other = temporary();
    fs.writeFileSync(path.join(other, "sentinel"), "keep");
    expect(
      await new Competitions(() => f.root).discard(f.service, "c1", other),
    ).toContain("removed 2 workspaces");
    expect(
      f.competition.solvers.every((entry) => !fs.existsSync(entry.workspace)),
    ).toBe(true);
    expect(required(readCompetition(f.root, "c1")).status).toBe("discarded");
    expect(fs.readFileSync(path.join(other, "sentinel"), "utf8")).toBe("keep");
  });

  for (const git of [false, true]) {
    test(`deleted ${git ? "Git subdirectory" : "source cwd"} falls back to contained discard and updates status`, async () => {
      const root = temporary();
      const repository = git ? gitRepository() : undefined;
      const project = repository?.cwd ?? temporary();
      const cwd = path.join(project, "source");
      fs.mkdirSync(cwd);
      fs.writeFileSync(path.join(cwd, "file.txt"), "base");
      const service = {
        spawnGraph: async () => ({ id: "initial", nodes: [] }),
        competitionOwners: async () => new Map(),
      } as unknown as AgentService;
      const competitions = new Competitions(() => root);
      const competition = await competitions.start(
        service,
        {
          task: "task",
          cwd,
          project,
          verify: "none",
          solvers: 2,
          judge: false,
        },
        resolver,
      );
      unsealCompetition(root, "c1");
      fs.rmSync(cwd, { recursive: true });
      const r = registration(root, service);
      const ctx = { cwd: project, hasUI: false } as ExtensionContext;
      try {
        const outcome = await r.tool.execute(
          "call",
          { action: "discard", id: "c1" },
          undefined,
          undefined,
          ctx,
        );
        expect(outcome.content).toEqual([
          {
            type: "text",
            text: expect.stringContaining("removed 2 workspaces"),
          },
        ]);
        expect(required(readCompetition(root, "c1")).status).toBe("discarded");
        expect(
          competition.solvers.every((entry) => !fs.existsSync(entry.workspace)),
        ).toBe(true);
        if (repository) {
          // No trusted source binding: deletion is allowed, Git mutation is not.
          expect(
            repository
              .git("worktree", "list", "--porcelain")
              .match(/^worktree /gm),
          ).toHaveLength(3);
        }
      } finally {
        r.monitor.disarm();
      }
    });
  }
});

describe("unsealed merge rollback", () => {
  for (const knownProject of [true, false]) {
    test(`resolver failure ${knownProject ? "unregisters with an authorized project" : "uses contained-only cleanup without a project"}`, async () => {
      const root = temporary();
      const { cwd, git } = gitRepository();
      fs.writeFileSync(path.join(cwd, "file.txt"), "base");
      const service = {
        spawnGraph: async () => ({ id: "initial", nodes: [] }),
        competitionOwners: async () => new Map(),
      } as unknown as AgentService;
      const competitions = new Competitions(() => root);
      const competition = await competitions.start(
        service,
        {
          task: "task",
          cwd,
          project: cwd,
          verify: "none",
          solvers: 2,
          judge: false,
        },
        resolver,
      );
      for (const entry of competition.solvers)
        fs.writeFileSync(path.join(entry.cwd, "file.txt"), entry.name);
      if (knownProject) unsealCompetition(root, "c1");
      let workspace = "";
      await expect(
        competitions.merge(
          service,
          "c1",
          {
            from: competition.solvers.map((entry) => entry.name),
            ...(knownProject ? { project: cwd } : {}),
          },
          async (request) => {
            workspace = request.cwd;
            // Without caller project context, a lost seal must not authorize Git.
            if (!knownProject) unsealCompetition(root, "c1");
            throw new Error("resolve failed");
          },
        ),
      ).rejects.toThrow("resolve failed");
      expect(workspace).not.toBe("");
      expect(fs.existsSync(workspace)).toBe(false);
      expect(required(readCompetition(root, "c1")).solvers).toHaveLength(2);
      expect(
        competition.solvers.every((entry) => fs.existsSync(entry.workspace)),
      ).toBe(true);
      expect(
        git("worktree", "list", "--porcelain").match(/^worktree /gm),
      ).toHaveLength(knownProject ? 3 : 4);
    });
  }
});

describe("approval binding and restart slash commands", () => {
  for (const action of ["compare", "merge"] as const) {
    test(`model ${action} keeps one resolved ID across confirmation`, async () => {
      const f = await fixture("printf approved > marker");
      unsealCompetition(f.root, f.competition.id);
      const r = registration(f.root, f.service);
      const merge = r.competitions.merge.bind(r.competitions);
      r.competitions.merge = (service, id, request) =>
        merge(service, id, request, resolver);
      const ctx = {
        cwd: f.cwd,
        hasUI: true,
        ui: {
          confirm: async () => {
            await f.competitions.start(
              f.service,
              {
                task: "newest",
                cwd: f.cwd,
                solvers: 2,
                judge: false,
                verify: "touch wrong-marker",
              },
              resolver,
            );
            return true;
          },
        },
      } as ExtensionContext;
      try {
        await r.tool.execute("call", { action }, undefined, undefined, ctx);
        expect(competitionSeal(f.root, f.competition.id)).toBeDefined();
        const newest = required(readCompetition(f.root, "c2"));
        expect(newest.solvers).toHaveLength(2);
        expect(
          newest.solvers.every(
            (entry) => !fs.existsSync(path.join(entry.cwd, "wrong-marker")),
          ),
        ).toBe(true);
        if (action === "compare")
          expect(
            fs.existsSync(
              path.join(required(f.competition.solvers[0]).cwd, "marker"),
            ),
          ).toBe(true);
        else
          expect(required(readCompetition(f.root, "c1")).solvers).toHaveLength(
            3,
          );
      } finally {
        r.monitor.disarm();
      }
    });

    test(`model ${action} rejects command removal, insertion, and timeout mutation during approval`, async () => {
      for (const mutation of ["remove", "insert", "timeout"] as const) {
        const f = await fixture(
          mutation === "insert" ? "none" : "touch forbidden",
        );
        unsealCompetition(f.root, f.competition.id);
        const r = registration(f.root, f.service);
        const mutate = () => {
          const changed = required(readCompetition(f.root, f.competition.id));
          if (mutation === "remove") delete changed.verify;
          else if (mutation === "insert") changed.verify = "touch forbidden";
          else changed.verifyTimeoutMs++;
          writeCompetition(f.root, changed);
        };
        // With no command there is no prompt; inject at snapshot return instead.
        if (mutation === "insert") {
          const snapshot = r.competitions.snapshot.bind(r.competitions);
          r.competitions.snapshot = (competition) => {
            const value = snapshot(competition);
            mutate();
            return value;
          };
        }
        const ctx = {
          cwd: f.cwd,
          hasUI: true,
          ui: {
            confirm: async () => {
              mutate();
              return true;
            },
          },
        } as unknown as ExtensionContext;
        try {
          await expect(
            r.tool.execute("call", { action }, undefined, undefined, ctx),
          ).rejects.toThrow("changed after approval");
          expect(
            f.competition.solvers.every(
              (entry) => !fs.existsSync(path.join(entry.cwd, "forbidden")),
            ),
          ).toBe(true);
          expect(required(readCompetition(f.root, "c1")).solvers).toHaveLength(
            2,
          );
        } finally {
          r.monitor.disarm();
        }
      }
    });

    test(`restart slash ${action} runs saved verification without another prompt`, async () => {
      const f = await fixture("printf approved > marker");
      unsealCompetition(f.root, f.competition.id);
      const r = registration(f.root, f.service);
      const merge = r.competitions.merge.bind(r.competitions);
      r.competitions.merge = (service, id, request) =>
        merge(service, id, request, resolver);
      const ctx = {
        cwd: f.cwd,
        hasUI: false,
        ui: {
          confirm: async () => {
            throw new Error("must not prompt");
          },
        },
      } as unknown as Parameters<typeof r.command.handler>[1];
      try {
        await r.command.handler(`${action} c1`, ctx);
        expect(competitionSeal(f.root, "c1")).toBeDefined();
        const record = required(readCompetition(f.root, "c1"));
        if (action === "merge") {
          const entry = required(record.solvers.at(-1));
          expect(entry.name).toBe("c1-m1");
          const verified = await verifySolver(
            f.root,
            record,
            entry,
            collectDiff(entry),
          );
          expect(verified?.exitCode).toBe(0);
        }
        const entry = required(
          action === "merge" ? record.solvers.at(-1) : record.solvers[0],
        );
        expect(fs.readFileSync(path.join(entry.cwd, "marker"), "utf8")).toBe(
          "approved",
        );
      } finally {
        r.monitor.disarm();
      }
    });

    test(`restart slash ${action} refuses inconsistent project and excessive timeout`, async () => {
      for (const invalid of ["project", "timeout", "cwd"] as const) {
        const f = await fixture("touch forbidden");
        unsealCompetition(f.root, f.competition.id);
        const record = required(readCompetition(f.root, "c1"));
        if (invalid === "timeout") record.verifyTimeoutMs = 60 * 60_000 + 1;
        if (invalid === "cwd") {
          const sub = path.join(f.cwd, "sub");
          fs.mkdirSync(sub);
          record.cwd = fs.realpathSync(sub);
        }
        writeCompetition(f.root, record);
        const r = registration(f.root, f.service);
        const ctx = {
          cwd: invalid === "project" ? temporary() : f.cwd,
          hasUI: false,
        } as Parameters<typeof r.command.handler>[1];
        try {
          await r.command.handler(`${action} c1`, ctx);
          expect(r.messages.join("\n")).toContain("Competition:");
          expect(competitionSeal(f.root, "c1")).toBeUndefined();
          expect(
            f.competition.solvers.every(
              (entry) => !fs.existsSync(path.join(entry.cwd, "forbidden")),
            ),
          ).toBe(true);
        } finally {
          r.monitor.disarm();
        }
      }
    });
  }
});
