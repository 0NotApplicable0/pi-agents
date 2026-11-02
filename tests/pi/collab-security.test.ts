import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { AgentService } from "../../src/agents/service.js";
import {
  type Competition,
  competitionSeal,
  readCompetition,
  unsealCompetition,
  writeCompetition,
} from "../../src/collab/compete.js";
import { collabStore } from "../../src/collab/membership.js";
import {
  Competitions,
  collabReport,
  confirmModelVerify,
  registerCollab,
} from "../../src/pi/collab.js";
import type { SessionHost } from "../../src/pi/session.js";

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Expected a test fixture");
  return value;
}

const directories: string[] = [];
function temporary() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-collab-security-"));
  directories.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of directories.splice(0))
    fs.rmSync(dir, { recursive: true, force: true });
});
const resolver = async (request: { name: string; cwd: string; job: string }) =>
  request;

describe("collab read boundary", () => {
  test("invalid and missing groups never create stores", () => {
    const root = temporary();
    for (const group of ["../escape", "/absolute", "x/../../escape"])
      expect(() => collabReport(root, group, "board")).toThrow();
    expect(collabReport(root, "missing", "board")).toContain("No collab group");
    expect(fs.readdirSync(root)).toEqual([]);
    collabStore(root, "main");
    expect(collabReport(root, "main", "board")).toContain("empty");
  });
  test("competition IDs are rejected at the public boundary", () => {
    const competitions = new Competitions(() => temporary());
    for (const id of ["../escape", "/absolute", "c1/../../escape", ""])
      expect(() => competitions.find(id)).toThrow();
  });
});

describe("model verification authorization", () => {
  test("headless and declined commands are refused; no command needs no approval", async () => {
    let prompts = 0;
    const ctx = {
      hasUI: false,
      ui: {
        confirm: async () => {
          prompts++;
          return false;
        },
      },
    } as unknown as ExtensionContext;
    await expect(confirmModelVerify(ctx, "touch sentinel")).rejects.toThrow(
      "UI confirmation",
    );
    expect(prompts).toBe(0);
    ctx.hasUI = true;
    await expect(confirmModelVerify(ctx, "touch sentinel")).rejects.toThrow(
      "not confirmed",
    );
    expect(prompts).toBe(1);
    await confirmModelVerify(ctx, undefined);
    expect(prompts).toBe(1);
    ctx.ui.confirm = async () => true;
    await confirmModelVerify(ctx, "bun test");
  });

  test("model start denied before creating competition; slash start still works headless", async () => {
    const root = temporary();
    const cwd = temporary();
    let tool: Parameters<ExtensionAPI["registerTool"]>[0] | undefined;
    const commands = new Map<
      string,
      Parameters<ExtensionAPI["registerCommand"]>[1]
    >();
    const pi = {
      registerTool: (value: Parameters<ExtensionAPI["registerTool"]>[0]) => {
        if (value.name === "agent_compete") tool = value;
      },
      registerCommand: (
        name: string,
        value: Parameters<ExtensionAPI["registerCommand"]>[1],
      ) => commands.set(name, value),
      sendMessage: () => {},
    } as unknown as ExtensionAPI;
    const host = {
      collabRoot: () => root,
      limits: () => ({ maxSolvers: 6, judgeBracketSize: 8 }),
      ensure: async () => ({}),
    } as unknown as SessionHost;
    const registered = registerCollab(pi, host);
    let starts = 0;
    registered.competitions.start = async (_service, request) => {
      starts++;
      throw new Error(`slash reached start: ${request.task}`);
    };
    const ctx = { cwd, hasUI: false } as Parameters<
      NonNullable<typeof tool>["execute"]
    >[4];
    try {
      await expect(
        required(tool).execute(
          "call",
          { task: "task", verify: "touch sentinel" },
          undefined,
          undefined,
          ctx,
        ),
      ).rejects.toThrow("UI confirmation");
      expect(starts).toBe(0);
      ctx.hasUI = true;
      ctx.ui = { confirm: async () => false } as ExtensionContext["ui"];
      await expect(
        required(tool).execute(
          "call",
          { task: "task", verify: "touch sentinel" },
          undefined,
          undefined,
          ctx,
        ),
      ).rejects.toThrow("not confirmed");
      expect(starts).toBe(0);
      ctx.hasUI = false;
      expect(fs.readdirSync(root)).toEqual([]);
      registered.competitions.find = () =>
        ({ verify: "touch sentinel" }) as ReturnType<Competitions["find"]>;
      registered.competitions.snapshot = () =>
        Object.freeze({ command: "touch sentinel", timeoutMs: 1000 });
      await expect(
        required(tool).execute(
          "call",
          { action: "compare" },
          undefined,
          undefined,
          ctx,
        ),
      ).rejects.toThrow("UI confirmation");
      await expect(
        required(tool).execute(
          "call",
          { action: "merge" },
          undefined,
          undefined,
          ctx,
        ),
      ).rejects.toThrow("UI confirmation");
      let mutations = 0;
      registered.competitions.apply = async () => {
        mutations++;
        return { ok: true, output: "applied", files: [] };
      };
      registered.competitions.discard = async () => {
        mutations++;
        return "discarded";
      };
      await required(tool).execute(
        "call",
        { action: "apply", solver: "c1-a" },
        undefined,
        undefined,
        ctx,
      );
      await required(tool).execute(
        "call",
        { action: "discard" },
        undefined,
        undefined,
        ctx,
      );
      expect(mutations).toBe(2); // D4 intentionally retains headless model authority.
      expect(fs.existsSync(path.join(cwd, "sentinel"))).toBe(false);
      await required(commands.get("compete")).handler(
        "task",
        ctx as Parameters<
          Parameters<ExtensionAPI["registerCommand"]>[1]["handler"]
        >[1],
      );
      expect(starts).toBe(1);
    } finally {
      registered.monitor.disarm();
    }
  });
});

describe("project preflight", () => {
  test("direct start rejects external cwd before reserving an ID or copying", async () => {
    const root = temporary();
    const cwd = temporary();
    const project = temporary();
    fs.writeFileSync(path.join(cwd, "outside-secret"), "must not copy");
    const competitions = new Competitions(() => root);
    await expect(
      competitions.start(
        {} as AgentService,
        { task: "task", cwd, project },
        resolver,
      ),
    ).rejects.toThrow("outside the session project");
    expect(fs.readdirSync(root)).toEqual([]);
    expect(fs.readdirSync(project)).toEqual([]);
  });

  test("model external cwd is rejected before detect/confirmation/start", async () => {
    const root = temporary();
    const project = temporary();
    const outside = temporary();
    fs.writeFileSync(
      path.join(outside, "package.json"),
      JSON.stringify({ scripts: { test: "touch forbidden" } }),
    );
    fs.writeFileSync(path.join(outside, "outside-secret"), "must not copy");
    const linked = path.join(project, "linked");
    fs.symlinkSync(outside, linked);
    let tool: Parameters<ExtensionAPI["registerTool"]>[0] | undefined;
    const pi = {
      registerTool(value: Parameters<ExtensionAPI["registerTool"]>[0]) {
        if (value.name === "agent_compete") tool = value;
      },
      registerCommand() {},
    } as unknown as ExtensionAPI;
    const host = {
      collabRoot: () => root,
      ensure: async () => ({}),
    } as unknown as SessionHost;
    const r = registerCollab(pi, host);
    let prompts = 0;
    let starts = 0;
    r.competitions.start = async () => {
      starts++;
      throw new Error("must not start");
    };
    const ctx = {
      cwd: project,
      hasUI: true,
      ui: {
        confirm: async () => {
          prompts++;
          return true;
        },
      },
    } as unknown as ExtensionContext;
    try {
      for (const cwd of [outside, linked])
        await expect(
          required(tool).execute(
            "call",
            { task: "task", cwd },
            undefined,
            undefined,
            ctx,
          ),
        ).rejects.toThrow("outside the session project");
      expect(prompts).toBe(0);
      expect(starts).toBe(0);
      expect(fs.readdirSync(root)).toEqual([]);
      expect(fs.existsSync(path.join(outside, "forbidden"))).toBe(false);
    } finally {
      r.monitor.disarm();
    }
  });
});

describe("restored competition integrity", () => {
  test("explicit slash compare reauthorizes restored verification without UI", async () => {
    const root = temporary();
    const cwd = temporary();
    const service = {
      spawnGraph: async () => ({ id: "graph", nodes: [] }),
      competitionOwners: async () => new Map(),
    } as unknown as AgentService;
    const competitions = new Competitions(() => root);
    const competition = await competitions.start(
      service,
      {
        task: "task",
        cwd,
        solvers: 2,
        judge: false,
        verify: "printf approved > marker",
      },
      resolver,
    );
    unsealCompetition(root, competition.id);
    const commands = new Map<
      string,
      Parameters<ExtensionAPI["registerCommand"]>[1]
    >();
    const pi = {
      registerTool() {},
      registerCommand(
        name: string,
        command: Parameters<ExtensionAPI["registerCommand"]>[1],
      ) {
        commands.set(name, command);
      },
      sendMessage() {},
    } as unknown as ExtensionAPI;
    const host = {
      collabRoot: () => root,
      ensure: async () => service,
    } as unknown as SessionHost;
    const registered = registerCollab(pi, host);
    const ctx = { cwd, hasUI: false } as Parameters<
      Parameters<ExtensionAPI["registerCommand"]>[1]["handler"]
    >[1];
    try {
      await required(commands.get("compete")).handler(
        `compare ${competition.id}`,
        ctx,
      );
      expect(competitionSeal(root, competition.id)).toBeDefined();
      for (const entry of competition.solvers)
        expect(fs.readFileSync(path.join(entry.cwd, "marker"), "utf8")).toBe(
          "approved",
        );
    } finally {
      registered.monitor.disarm();
    }
  });

  test("model approval cannot authorize a changed command or timeout", async () => {
    for (const field of ["verify", "verifyTimeoutMs"] as const) {
      const root = temporary();
      const cwd = temporary();
      const service = {
        spawnGraph: async () => ({ id: "graph", nodes: [] }),
      } as unknown as AgentService;
      const competitions = new Competitions(() => root);
      const competition = await competitions.start(
        service,
        {
          task: "task",
          cwd,
          solvers: 2,
          judge: false,
          verify: "touch sentinel",
        },
        resolver,
      );
      unsealCompetition(root, competition.id);
      let tool: Parameters<ExtensionAPI["registerTool"]>[0] | undefined;
      const pi = {
        registerTool(value: Parameters<ExtensionAPI["registerTool"]>[0]) {
          if (value.name === "agent_compete") tool = value;
        },
        registerCommand() {},
      } as unknown as ExtensionAPI;
      const host = {
        collabRoot: () => root,
        ensure: async () => service,
      } as unknown as SessionHost;
      const registered = registerCollab(pi, host);
      const ctx = {
        cwd,
        hasUI: true,
        ui: {
          confirm: async (_title: string, message: string) => {
            expect(message).toContain("touch sentinel");
            expect(message).toContain(
              `Timeout: ${competition.verifyTimeoutMs} ms`,
            );
            const changed = required(readCompetition(root, competition.id));
            if (field === "verify") changed.verify = "touch different-sentinel";
            else
              changed.verifyTimeoutMs = Math.max(
                1,
                competition.verifyTimeoutMs - 1,
              );
            writeCompetition(root, changed);
            return true;
          },
        },
      } as Parameters<NonNullable<typeof tool>["execute"]>[4];
      try {
        await expect(
          required(tool).execute(
            "call",
            { action: "compare", id: competition.id },
            undefined,
            undefined,
            ctx,
          ),
        ).rejects.toThrow("changed after approval");
        expect(fs.existsSync(path.join(cwd, "sentinel"))).toBe(false);
        expect(
          competition.solvers.every(
            (entry) =>
              !fs.existsSync(path.join(entry.cwd, "different-sentinel")),
          ),
        ).toBe(true);
      } finally {
        registered.monitor.disarm();
      }
    }
  });

  test("unsafe records remain visible and discard preserves external paths", async () => {
    const root = temporary();
    const cwd = temporary();
    const external = temporary();
    fs.writeFileSync(path.join(external, "sentinel"), "keep");
    const service = {
      spawnGraph: async () => ({ id: "graph", nodes: [] }),
      graphs: () => [],
      competitionOwners: async () => new Map(),
    } as unknown as AgentService;
    const competitions = new Competitions(() => root);
    const competition = await competitions.start(
      service,
      { task: "task", cwd, solvers: 2, judge: false, verify: "none" },
      resolver,
    );
    const changed: Competition = {
      ...competition,
      solvers: competition.solvers.map((entry, index) =>
        index === 0 ? { ...entry, cwd: external, workspace: external } : entry,
      ),
    };
    writeCompetition(root, changed);
    expect(competitions.list().map((record) => record.id)).toContain(
      competition.id,
    );
    expect(await competitions.report(service, competition.id)).toContain(
      "unsafe paths refused",
    );
    expect(await competitions.discard(service, competition.id)).toContain(
      "Refused unsafe paths",
    );
    expect(fs.readFileSync(path.join(external, "sentinel"), "utf8")).toBe(
      "keep",
    );
  });
});

describe("competition lifecycle safety", () => {
  test("forged timedOut cannot suppress a first stop, including in a new service", async () => {
    const root = temporary();
    const cwd = temporary();
    const service = {
      spawnGraph: async () => ({ id: "initial", nodes: [] }),
    } as unknown as AgentService;
    const competitions = new Competitions(() => root);
    const competition = await competitions.start(
      service,
      { task: "task", cwd, solvers: 2, judge: false, verify: "none" },
      resolver,
    );
    const entry = required(competition.solvers[0]);
    service.competitionOwners = async () =>
      new Map([
        [
          competition.id,
          {
            agents: [
              {
                agentId: "durable-solver",
                graph: "initial",
                part: "solver" as const,
                solver: entry.name,
                stopped: false,
              },
            ],
            graphs: [],
          },
        ],
      ]);
    service.agentById = () =>
      ({ state: "working" }) as ReturnType<AgentService["agentById"]>;
    const stopped: string[] = [];
    service.stopTarget = async (target) => {
      stopped.push(target.id);
    };
    writeCompetition(root, {
      ...competition,
      deadline: 1,
      timedOut: [entry.name],
    });
    expect(await competitions.expire(service, 2)).toEqual([entry.name]);
    expect(await new Competitions(() => root).expire(service, 2)).toEqual([]);
    const restarted = {
      competitionOwners: service.competitionOwners,
      agentById: service.agentById,
      stopTarget: service.stopTarget,
    } as unknown as AgentService;
    // A genuinely new service has no trusted memory of this ID's earlier stop.
    expect(await competitions.expire(restarted, 2)).toEqual([entry.name]);
    expect(stopped).toEqual(["durable-solver", "durable-solver"]);
  });

  test("unsafe and generated solver names fail before graph spawn", async () => {
    const root = temporary();
    const cwd = temporary();
    const competitions = new Competitions(() => root);
    for (const names of [
      ["..", "safe"],
      [".hidden", "safe"],
      ["c1-judge", "safe"],
      ["c1-m1", "safe"],
    ]) {
      // Each test has its own root so the reserved ID is c1.
      const temporaryRoot = temporary();
      const own = new Competitions(() => temporaryRoot);
      await expect(
        own.start(
          {} as AgentService,
          {
            task: "task",
            cwd,
            verify: "none",
            variants: names.map((name) => ({ name })),
          },
          resolver,
        ),
      ).rejects.toThrow();
    }
    expect(competitions.list()).toEqual([]);
  });

  test("solver names normalize spaces and punctuation and uniquify collisions", async () => {
    const root = temporary();
    const cwd = temporary();
    const competitions = new Competitions(() => root);
    const service = {
      spawnGraph: async () => ({ id: "graph", nodes: [] }),
    } as unknown as AgentService;
    const competition = await competitions.start(
      service,
      {
        task: "task",
        cwd,
        judge: false,
        verify: "none",
        variants: ["fast path", "fast-path-3", "fast.path", "fast path"].map(
          (name) => ({ name }),
        ),
      },
      resolver,
    );
    expect(competition.solvers.map((entry) => entry.name)).toEqual([
      "fast-path",
      "fast-path-3",
      "fast-path-4",
      "fast-path-5",
    ]);
  });

  test("duplicate maximum-length solver names stay valid and distinct", async () => {
    const root = temporary();
    const cwd = temporary();
    const competitions = new Competitions(() => root);
    const service = {
      spawnGraph: async () => ({ id: "graph", nodes: [] }),
    } as unknown as AgentService;
    const name = "a".repeat(64);
    const competition = await competitions.start(
      service,
      {
        task: "task",
        cwd,
        judge: false,
        verify: "none",
        variants: [{ name }, { name }],
      },
      resolver,
    );
    expect(competition.solvers.map((entry) => entry.name)).toEqual([
      name,
      `${"a".repeat(62)}-2`,
    ]);
  });

  test("post-spawn persistence and stop failures preserve workspaces", async () => {
    const root = temporary();
    const cwd = temporary();
    fs.writeFileSync(path.join(cwd, "file.txt"), "keep");
    const competitions = new Competitions(() => root);
    let workspaces: string[] = [];
    let stops = 0;
    const service = {
      competitionOwners: async () =>
        new Map([
          ["c1", { agents: [], graphs: [{ id: "graph", closed: false }] }],
        ]),
      spawnGraph: async () => {
        const record = required(readCompetition(root, "c1"));
        workspaces = record.solvers.map((entry) => entry.workspace);
        const recordPath = path.join(
          root,
          "competitions",
          "c1",
          "competition.json",
        );
        fs.rmSync(recordPath);
        fs.mkdirSync(recordPath);
        return { id: "graph", nodes: [] };
      },
      stopTarget: async () => {
        stops++;
        throw new Error("injected stop failure");
      },
    } as unknown as AgentService;
    await expect(
      competitions.start(
        service,
        { task: "task", cwd, solvers: 2, judge: false, verify: "none" },
        resolver,
      ),
    ).rejects.toThrow();
    expect(stops).toBe(1);
    expect(workspaces.length).toBe(2);
    expect(workspaces.every((workspace) => fs.existsSync(workspace))).toBe(
      true,
    );
  });

  test("post-merge persistence and stop failures preserve its workspace", async () => {
    const root = temporary();
    const cwd = temporary();
    fs.writeFileSync(path.join(cwd, "file.txt"), "base");
    const competitions = new Competitions(() => root);
    const service = {
      spawnGraph: async () => ({ id: "initial", nodes: [] }),
      competitionOwners: async () => new Map(),
    } as unknown as AgentService;
    const competition = await competitions.start(
      service,
      { task: "task", cwd, solvers: 2, judge: false, verify: "none" },
      resolver,
    );
    for (const entry of competition.solvers)
      fs.writeFileSync(path.join(entry.cwd, "file.txt"), entry.name);
    let workspace = "";
    let stops = 0;
    service.stopTarget = async () => {
      stops++;
      throw new Error("injected stop failure");
    };
    service.spawnGraph = async () => {
      workspace = required(
        required(readCompetition(root, "c1")).solvers.at(-1),
      ).workspace;
      const recordPath = path.join(
        root,
        "competitions",
        "c1",
        "competition.json",
      );
      fs.rmSync(recordPath);
      fs.mkdirSync(recordPath);
      service.competitionOwners = async () =>
        new Map([
          [
            "c1",
            {
              agents: [
                {
                  agentId: "merger",
                  graph: "merge",
                  part: "solver",
                  solver: "c1-m1",
                  stopped: false,
                },
              ],
              graphs: [{ id: "merge", closed: false }],
            },
          ],
        ]);
      return { id: "merge", nodes: [] } as unknown as Awaited<
        ReturnType<AgentService["spawnGraph"]>
      >;
    };
    await expect(
      competitions.merge(
        service,
        "c1",
        { from: competition.solvers.map((entry) => entry.name) },
        resolver,
      ),
    ).rejects.toThrow();
    expect(stops).toBe(1);
    expect(workspace).not.toBe("");
    expect(fs.existsSync(workspace)).toBe(true);
  });

  test("pre-spawn resolver failure cleans workspaces", async () => {
    const root = temporary();
    const cwd = temporary();
    const competitions = new Competitions(() => root);
    await expect(
      competitions.start(
        {} as AgentService,
        { task: "task", cwd, solvers: 2, judge: false, verify: "none" },
        async () => {
          throw new Error("resolve failed");
        },
      ),
    ).rejects.toThrow("resolve failed");
    const record = required(readCompetition(root, "c1"));
    expect(record.status).toBe("discarded");
    expect(
      record.solvers.every((entry) => !fs.existsSync(entry.workspace)),
    ).toBe(true);
  });
});
