/**
 * Competitions with many solvers: verify commands share a bounded pool,
 * bracket judges rank groups before the final judge sees the finalists,
 * and a judge's comparison stays within its budget.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  type FauxResponseStep,
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import type { AgentService } from "../../src/agents/service.js";
import {
  bracketsOf,
  type Comparison,
  comparisonDetails,
  configureVerifyConcurrency,
  DEFAULT_VERIFY_CONCURRENCY,
  readBracketVerdict,
  readVerdict,
  runningVerifies,
  runVerify,
} from "../../src/collab/compete.js";
import { Competitions, type CompetitorResolver } from "../../src/pi/collab.js";
import {
  closeService,
  fauxModels,
  MODEL,
  openService,
  tempDir,
  textOf,
  until,
} from "../agents/helpers.js";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, stdio: "pipe" }).toString().trim();

function call(name: string, args: Record<string, unknown>) {
  return fauxAssistantMessage([fauxToolCall(name, args)], {
    stopReason: "toolUse",
  });
}

/** What the final judge's compete_compare showed. */
let finalComparison = "";

/** Solvers c1-a, c1-c, c1-e write a correct sum; the others a wrong one.
 * Judges rank by the rubric line of compete_compare. */
const step: FauxResponseStep = async (context) => {
  const messages = context.messages.filter((each) => each.role !== "system");
  const first = textOf(messages.find((each) => each.role === "user")?.content);
  const last = messages.at(-1);
  const text = textOf(last?.content);
  const solver = /You are solver "([^"]+)"/.exec(first)?.[1];
  if (solver) {
    if (last?.role === "user") {
      const workspace = /Your workspace is (\S+), a private/.exec(first)?.[1];
      const good = ["c1-a", "c1-c", "c1-e"].includes(solver);
      return call("bash", {
        command: `cd ${workspace} && printf '%s' 'module.exports = (a, b) => a ${good ? "+" : "-"} b;\n' > sum.js && echo written`,
      });
    }
    if (text.includes("written"))
      return call("compete_submit", {
        summary: `${solver} implements sum`,
        approach: "One line",
        tests: "node check.js",
        confidence: 0.8,
      });
    return fauxAssistantMessage(`${solver} done`);
  }
  const bracket = /You judge bracket (\d+)/.exec(first)?.[1];
  const final = first.includes("You are the final judge");
  if (bracket || final) {
    if (last?.role !== "toolResult") return call("compete_compare", {});
    if (text.includes("| solver |")) {
      if (final) finalComparison = text;
      const ranking = (/Rubric order[^:]*: (.*)/.exec(text)?.[1] ?? "")
        .split(" > ")
        .map((each) => each.trim());
      return call("compete_verdict", {
        winner: ranking[0],
        ranking,
        rationale: "By the rubric.",
      });
    }
    return fauxAssistantMessage(`judged: ${text.slice(0, 200)}`);
  }
  return fauxAssistantMessage(`done: ${text.slice(0, 200)}`);
};

const services: AgentService[] = [];
afterAll(async () => {
  configureVerifyConcurrency(DEFAULT_VERIFY_CONCURRENCY);
  for (const service of services) await closeService(service);
});

const plain: CompetitorResolver = async (request) => ({
  job: request.job,
  name: request.name,
  cwd: request.cwd,
  model: MODEL,
  ...(request.tools ? { tools: request.tools } : {}),
});

describe("competitions at scale", () => {
  test("brackets split solvers evenly, only past the bracket size", () => {
    const names = (count: number) =>
      Array.from({ length: count }, (_, index) => `s${index}`);
    expect(bracketsOf(names(8), 8)).toEqual([]);
    expect(bracketsOf(names(10), 4).map((each) => each.length)).toEqual([
      4, 3, 3,
    ]);
    const forty = bracketsOf(names(40), 8);
    expect(forty).toHaveLength(5);
    expect(forty.flat()).toEqual(names(40));
  });

  test("verify commands run at most verifyConcurrency at once", async () => {
    configureVerifyConcurrency(2);
    const dir = tempDir("pi-verify-pool-");
    let peak = 0;
    const sampler = setInterval(() => {
      peak = Math.max(peak, runningVerifies());
    }, 5);
    const started = Date.now();
    const results = await Promise.all(
      Array.from({ length: 6 }, () => runVerify("sleep 0.15", dir)),
    );
    clearInterval(sampler);
    expect(results.every((each) => each.exitCode === 0)).toBe(true);
    expect(peak).toBe(2);
    // Three rounds of two; the timeout counts from each one's start.
    expect(Date.now() - started).toBeGreaterThanOrEqual(400);
    expect(Math.max(...results.map((each) => each.durationMs))).toBeLessThan(
      400,
    );
    configureVerifyConcurrency(DEFAULT_VERIFY_CONCURRENCY);
  });

  test("a comparison of many solutions shares the judge's budget", () => {
    const rows = Array.from({ length: 40 }, (_, index) => ({
      solver: `s${index}`,
      state: "idle",
      submitted: false,
      diff: { patch: "+x\n".repeat(10_000), files: [], hash: "h" },
      workspace: "/w",
    }));
    const details = comparisonDetails({
      competition: {} as never,
      rows,
      suggested: [],
    } as Comparison);
    expect(details.length).toBeLessThan(170_000);
    const few = comparisonDetails({
      competition: {} as never,
      rows: rows.slice(0, 2),
      suggested: [],
    } as Comparison);
    // Few solutions keep the usual 8,000 characters each.
    expect(few).toContain("(22000 more characters");
  });

  test("bracket judges rank groups; the final judge compares their finalists", async () => {
    const base = tempDir("pi-compete-brackets-");
    const repo = path.join(base, "repo");
    const collabRoot = path.join(base, "collab");
    fs.mkdirSync(repo);
    git(repo, "init", "-q", "-b", "main");
    fs.writeFileSync(path.join(repo, "sum.js"), "module.exports = () => 0;\n");
    fs.writeFileSync(
      path.join(repo, "check.js"),
      "const sum = require('./sum.js');\nprocess.exit(sum(2, 3) === 5 ? 0 : 1);\n",
    );
    git(repo, "add", ".");
    git(
      repo,
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@t",
      "commit",
      "-qm",
      "i",
    );

    const service = await openService({
      models: fauxModels(step),
      collab: { sessionId: () => "s1", root: () => collabRoot },
      spawningLimits: { perCall: 20, active: 20 },
    });
    services.push(service);
    const competitions = new Competitions(
      () => collabRoot,
      () => 10,
      () => 4,
    );
    const competition = await competitions.start(
      service,
      {
        task: "Make sum(a, b) return a + b.",
        cwd: repo,
        verify: "node check.js",
        solvers: 6,
      },
      plain,
    );
    expect(competition.brackets?.map((each) => each.solvers)).toEqual([
      ["c1-a", "c1-b", "c1-c"],
      ["c1-d", "c1-e", "c1-f"],
    ]);
    expect(competition.brackets?.every((each) => each.agentId)).toBe(true);
    expect(service.get("c1-judge-1")?.collab).toMatchObject({
      part: "judge",
      bracket: 0,
    });
    // The final judge waits for the bracket judges.
    expect(service.get("c1-judge")?.state).not.toBe("working");

    await until(() => readVerdict(collabRoot, "c1") !== undefined, 15_000);
    const one = readBracketVerdict(collabRoot, "c1", 0);
    const two = readBracketVerdict(collabRoot, "c1", 1);
    expect(one?.by).toBe("c1-judge-1");
    expect(one?.ranking.slice(0, 2)).toEqual(["c1-a", "c1-c"]);
    expect(two?.ranking[0]).toBe("c1-e");
    // The final judge saw each bracket's top two, not the others.
    for (const name of ["c1-a", "c1-c", "c1-e"])
      expect(finalComparison).toContain(`| ${name} |`);
    expect(finalComparison).not.toContain("| c1-b |");
    expect(finalComparison.match(/^\| c1-/gm)).toHaveLength(4);
    expect(readVerdict(collabRoot, "c1")).toMatchObject({
      by: "c1-judge",
      winner: "c1-a",
    });
    const report = await competitions.report(service, "c1");
    expect(report).toContain("Bracket judges: 1 c1-judge-1");
  }, 30_000);
});

test("workspaces link the main workspace's node_modules, nested ones too", async () => {
  const { prepareWorkspaces } = await import("../../src/collab/compete.js");
  const base = tempDir("pi-compete-deps-");
  const repo = path.join(base, "repo");
  for (const dir of [
    "node_modules/x",
    "packages/app/node_modules/y",
    "packages/app/src",
  ])
    fs.mkdirSync(path.join(repo, dir), { recursive: true });
  fs.writeFileSync(path.join(repo, ".gitignore"), "node_modules\n");
  fs.writeFileSync(path.join(repo, "packages/app/src/index.js"), "1\n");
  git(repo, "init", "-q", "-b", "main");
  git(repo, "add", ".");
  git(repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "i");
  const workspaces = prepareWorkspaces({
    collabRoot: path.join(base, "collab"),
    id: "c9",
    cwd: repo,
    solvers: ["s1"],
  });
  const workspace = workspaces.entries[0]?.workspace as string;
  expect(fs.readlinkSync(path.join(workspace, "node_modules"))).toBe(
    path.join(repo, "node_modules"),
  );
  expect(
    fs.readlinkSync(path.join(workspace, "packages/app/node_modules")),
  ).toBe(path.join(repo, "packages/app/node_modules"));
  git(repo, "worktree", "remove", "--force", workspace);
});
