import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { solverStates } from "../../src/agents/collab.js";
import type { AgentRecord } from "../../src/agents/records.js";
import type { AgentService } from "../../src/agents/service.js";
import {
  approveCompetitionVerification,
  type Competition,
  competitionDir,
  prepareWorkspaces,
  readSubmission,
  sealCompetition,
  unsealCompetition,
  verificationSnapshot,
  writeCompetition,
} from "../../src/collab/compete.js";
import {
  closeService,
  fauxModels,
  MODEL,
  openService,
  textOf,
  until,
} from "./helpers.js";

const services: AgentService[] = [];
const directories: string[] = [];
afterEach(async () => {
  for (const service of services.splice(0)) await closeService(service);
  for (const dir of directories.splice(0))
    fs.rmSync(dir, { recursive: true, force: true });
});

async function fixture(sealed: boolean) {
  const dir = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "agent-verify-approval-")),
  );
  directories.push(dir);
  const cwd = path.join(dir, "project");
  fs.mkdirSync(cwd);
  fs.writeFileSync(path.join(cwd, "x"), "base\n");
  const root = path.join(dir, "collab");
  const ws = prepareWorkspaces({
    collabRoot: root,
    cwd,
    id: "c1",
    solvers: ["s1"],
  });
  const marker = path.join(dir, "verified");
  const competition: Competition = {
    protocol: 1,
    id: "c1",
    task: "test approval",
    createdAt: 1,
    deadline: Date.now() + 60_000,
    cwd: ws.cwd,
    root: ws.root,
    git: ws.git,
    verify: `printf verified >> '${marker}'`,
    verifySource: "given",
    verifyTimeoutMs: 1_000,
    solvers: ws.entries,
    status: "running",
  };
  sealCompetition(root, competition);
  writeCompetition(root, competition);
  if (!sealed) unsealCompetition(root, "c1");
  const entry = ws.entries[0];
  if (!entry) throw new Error("Missing solver");
  fs.writeFileSync(path.join(entry.cwd, "x"), "solution\n");
  const service = await openService({
    collab: { root: () => root, sessionId: () => "test" },
    models: fauxModels((context) => {
      const last = context.messages
        .filter((message) => message.role !== "system")
        .at(-1);
      const text = textOf(last?.content);
      if (last?.role === "toolResult") return fauxAssistantMessage(text);
      const tool = text.endsWith("submit")
        ? "compete_submit"
        : text.endsWith("compare")
          ? "compete_compare"
          : undefined;
      return tool
        ? fauxAssistantMessage(
            [
              fauxToolCall(
                tool,
                tool === "compete_submit"
                  ? {
                      summary: "solution",
                      approach: "small change",
                      tests: "verify",
                      confidence: 0.9,
                    }
                  : {},
              ),
            ],
            { stopReason: "toolUse" },
          )
        : fauxAssistantMessage("ready");
    }),
  });
  services.push(service);
  await service.spawnGraph({
    agents: [
      {
        name: "solver",
        job: "ready",
        cwd: entry.cwd,
        model: MODEL,
        collab: {
          group: "c1",
          role: "solver",
          competition: "c1",
          part: "solver",
          solver: "s1",
        },
      },
      {
        name: "judge",
        job: "ready",
        cwd,
        model: MODEL,
        collab: {
          group: "c1",
          role: "judge",
          competition: "c1",
          part: "judge",
        },
      },
    ],
  });
  await until(
    () =>
      service.get("solver")?.state === "idle" &&
      service.get("judge")?.state === "idle",
  );
  return { root, cwd, marker, competition, service };
}

async function invoke(service: AgentService, tool: "submit" | "compare") {
  const name = tool === "submit" ? "solver" : "judge";
  const previous = service.get(name)?.result?.entryId;
  await service.prompt(name, tool, "followUp");
  await until(
    () =>
      service.get(name)?.state === "idle" &&
      service.get(name)?.result?.entryId !== previous,
  );
  return service.get(name)?.result?.text ?? "";
}

test("forged saved agent ID cannot redirect a solver submission to another entry", async () => {
  const f = await fixture(false);
  const solverId = f.service.get("solver")?.id;
  expect(solverId).toBeDefined();
  const other = prepareWorkspaces({
    collabRoot: f.root,
    cwd: f.cwd,
    id: "c1",
    solvers: ["s2"],
  }).entries[0];
  const own = f.competition.solvers.find((entry) => entry.name === "s1");
  if (!other || !own) throw new Error("Missing solvers");
  writeCompetition(f.root, {
    ...f.competition,
    solvers: [{ ...other, agentId: String(solverId) }, own],
  });

  expect(await invoke(f.service, "submit")).toContain("s1");
  expect(readSubmission(f.root, "c1", "s1")?.summary).toBe("solution");
  expect(readSubmission(f.root, "c1", "s2")).toBeUndefined();
});

test("solver states use durable competition membership, not saved agent IDs", async () => {
  const f = await fixture(false);
  const record = (
    competition: string,
    part: "solver" | "judge",
    solver: string,
    stopped = false,
  ): AgentRecord => ({
    name: solver,
    profile: null,
    job: "ready",
    createdAt: 1,
    closed: false,
    ambientSkills: false,
    nextRequest: 0,
    requests: {},
    delivered: [],
    graph: "g1",
    depth: 0,
    stopped,
    collab: {
      group: competition,
      role: part,
      competition,
      part,
      solver,
      cwd: f.cwd,
    },
  });
  const agents = {
    unrelated: record("c2", "solver", "s1", true),
    judge: record("c1", "judge", "s1", true),
    actual: record("c1", "solver", "s1"),
    stopped: record("c1", "solver", "s2", true),
  };
  const entry = f.competition.solvers[0];
  if (!entry) throw new Error("Missing solver");
  const competition = {
    ...f.competition,
    solvers: ["s1", "s2"].map((name) => ({
      ...entry,
      name,
      agentId: "unrelated",
    })),
  };
  const queried: string[] = [];
  expect(
    solverStates(competition, agents, (id) => {
      queried.push(id);
      return "working";
    }),
  ).toEqual({ s1: "working", s2: "stopped" });
  expect(queried).toEqual(["actual"]);
  expect(solverStates(competition, {}, () => "working")).toEqual({
    s1: "unknown",
    s2: "unknown",
  });
});

test("sealed start lets autonomous submit and compare verify in the same process", async () => {
  const f = await fixture(true);
  expect(await invoke(f.service, "submit")).toContain(": pass.");
  expect(readSubmission(f.root, "c1", "s1")?.verify?.exitCode).toBe(0);
  expect(await invoke(f.service, "compare")).toContain("| pass |");
  expect(fs.readFileSync(f.marker, "utf8")).toBe("verifiedverified");
});

test("restored tools do not present an old cached verification pass as fresh approval", async () => {
  const f = await fixture(true);
  expect(await invoke(f.service, "submit")).toContain(": pass.");
  unsealCompetition(f.root, "c1");
  expect(await invoke(f.service, "compare")).toContain(
    "Verification skipped/unapproved",
  );
  expect(await invoke(f.service, "submit")).toContain(
    "Verification skipped/unapproved",
  );
  expect(readSubmission(f.root, "c1", "s1")?.verify).toBeUndefined();
  const cached = JSON.parse(
    fs.readFileSync(
      path.join(competitionDir(f.root, "c1"), "results", "s1.json"),
      "utf8",
    ),
  );
  expect(cached.skipped).toBeUndefined();
  expect(cached.exitCode).toBe(0);
  expect(fs.readFileSync(f.marker, "utf8")).toBe("verified");
});

for (const tool of ["submit", "compare"] as const) {
  test(`restored autonomous ${tool} skips unapproved verification without caching it`, async () => {
    const f = await fixture(false);
    const output = await invoke(f.service, tool);
    expect(output).toContain("Verification skipped/unapproved");
    expect(output).not.toContain("Fix the failure");
    expect(output).not.toContain(": pass");
    expect(fs.existsSync(f.marker)).toBe(false);
    expect(readSubmission(f.root, "c1", "s1")?.verify).toBeUndefined();
    expect(
      fs.existsSync(
        path.join(competitionDir(f.root, "c1"), "results", "s1.json"),
      ),
    ).toBe(false);

    const snapshot = verificationSnapshot(f.root, f.competition);
    approveCompetitionVerification(f.root, f.competition, snapshot, f.cwd);
    expect(await invoke(f.service, tool)).not.toContain("skipped/unapproved");
    expect(fs.readFileSync(f.marker, "utf8")).toBe("verified");
  });

  for (const mutation of ["command", "timeout"] as const) {
    test(`sealed ${tool} rejects saved verification ${mutation} mutation`, async () => {
      const f = await fixture(true);
      writeCompetition(f.root, {
        ...f.competition,
        ...(mutation === "command"
          ? { verify: `printf changed >> '${f.marker}'` }
          : { verifyTimeoutMs: 2_000 }),
      });
      expect(await invoke(f.service, tool)).toContain(
        "changed on disk since verification was approved",
      );
      expect(fs.existsSync(f.marker)).toBe(false);
      expect(readSubmission(f.root, "c1", "s1")).toBeUndefined();
    });
  }
}
