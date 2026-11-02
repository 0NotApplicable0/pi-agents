/**
 * A competition in one session: three scripted solvers in a temporary Git
 * repository solve the same task blind to each other, a judge compares
 * them, and the parent applies the winner.
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
  DEFAULT_HINTS,
  readSubmission,
  readVerdict,
} from "../../src/collab/compete.js";
import { Competitions, type CompetitorResolver } from "../../src/pi/collab.js";
import {
  closeService,
  fauxModels,
  heldUntilAborted,
  MODEL,
  openService,
  tempDir,
  textOf,
  until,
} from "../agents/helpers.js";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, stdio: "pipe" }).toString().trim();

const SOLUTIONS: Record<string, string> = {
  // Correct and small.
  "c1-a": "module.exports = (a, b) => a + b;\n",
  // Wrong: verify fails.
  "c1-b": "module.exports = (a, b) => a - b;\n",
};

function call(name: string, args: Record<string, unknown>) {
  return fauxAssistantMessage([fauxToolCall(name, args)], {
    stopReason: "toolUse",
  });
}

/** Solvers write their solution with bash and submit it; c1-c works until
 * it's stopped. The judge compares and picks the best. Others run
 * `tool <name> <json>` prompts. */
const step: FauxResponseStep = async (context, options) => {
  const messages = context.messages.filter((each) => each.role !== "system");
  const first = textOf(messages.find((each) => each.role === "user")?.content);
  const last = messages.at(-1);
  const text = textOf(last?.content);
  const command = /^(?:\[user\] )?tool (\S+) (.*)$/s.exec(text);
  if (last?.role === "user" && command)
    return call(command[1] as string, JSON.parse(command[2] as string));
  if (
    last?.role === "toolResult" &&
    !first.includes("You are solver") &&
    !first.includes("You judge") &&
    !first.includes("You merge solutions")
  )
    return fauxAssistantMessage(`tool: ${text}`);
  const merging = first.includes("You merge solutions");
  const solver =
    /You are solver "([^"]+)"/.exec(first)?.[1] ??
    (merging ? "merger" : undefined);
  if (solver) {
    if (last?.role === "user" && /^\[user\]/.test(text) === false) {
      if (solver === "c1-c") {
        await heldUntilAborted(options?.signal);
        return fauxAssistantMessage("stopped");
      }
      const workspace = /Your workspace is (\S+), a private/.exec(first)?.[1];
      if (merging) {
        // Take c1-a's patch and add what c1-b "got right": a comment.
        const patch = /- c1-a: workspace \S+; patch (\S+)/.exec(first)?.[1];
        return call("bash", {
          command: `cd ${workspace} && git apply ${patch} && printf '// merged: c1-a with c1-b\\n' >> sum.js && echo written`,
        });
      }
      return call("bash", {
        command: `cd ${workspace} && printf '%s' '${SOLUTIONS[solver]}' > sum.js && echo written`,
      });
    }
    if (text.includes("written"))
      return call("compete_submit", {
        summary: `${solver} implements sum`,
        approach: "One line",
        tests: "node check.js",
        confidence: solver === "c1-b" ? 0.6 : 0.9,
      });
    if (text.includes("Submitted"))
      return fauxAssistantMessage(`${solver} done: ${text.slice(0, 300)}`);
    return fauxAssistantMessage(`${solver}: ${text.slice(0, 200)}`);
  }
  if (first.includes("You judge competition")) {
    if (last?.role !== "toolResult") return call("compete_compare", {});
    if (text.includes("| solver |"))
      return call("compete_verdict", {
        winner: "c1-a",
        ranking: ["c1-a", "c1-b", "c1-c"],
        rationale: "c1-a passes verify; c1-b fails it; c1-c never finished.",
      });
    return fauxAssistantMessage(`Winner c1-a. ${text}`);
  }
  return fauxAssistantMessage(`done: ${text.slice(0, 200)}`);
};

const services: AgentService[] = [];
afterAll(async () => {
  for (const service of services) await closeService(service);
});

const plain: CompetitorResolver = async (request) => ({
  job: request.job,
  name: request.name,
  cwd: request.cwd,
  model: MODEL,
  ...(request.tools ? { tools: request.tools } : {}),
});

describe("competitions", () => {
  test("three blind solvers, a verify command, a judge, and an explicit apply", async () => {
    const base = tempDir("pi-compete-");
    const repo = path.join(base, "repo");
    const collabRoot = path.join(base, "collab");
    fs.mkdirSync(repo);
    git(repo, "init", "-q", "-b", "main");
    fs.writeFileSync(path.join(repo, "sum.js"), "module.exports = () => 0;\n");
    fs.writeFileSync(
      path.join(repo, "check.js"),
      "const sum = require('./sum.js');\nprocess.exit(sum(2, 3) === 5 ? 0 : 1);\n",
    );
    fs.writeFileSync(path.join(repo, "README.md"), "# sum\n");
    git(repo, "add", ".");
    git(
      repo,
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@t",
      "commit",
      "-qm",
      "init",
    );
    // Uncommitted and untracked work is part of every workspace's base.
    fs.writeFileSync(path.join(repo, "README.md"), "# sum\n\nDirty.\n");
    fs.writeFileSync(path.join(repo, "notes.txt"), "untracked\n");

    const service = await openService({
      models: fauxModels(step),
      collab: { sessionId: () => "s1", root: () => collabRoot },
    });
    services.push(service);
    // A top-level agent outside the competition.
    await service.spawnGraph({
      agents: [{ name: "other", job: "ready", cwd: repo, model: MODEL }],
    });
    await until(() => service.get("other")?.state === "idle");

    const competitions = new Competitions(() => collabRoot);
    const competition = await competitions.start(
      service,
      {
        task: "Make sum(a, b) return a + b.",
        cwd: repo,
        verify: "node check.js",
      },
      plain,
    );
    expect(competition.id).toBe("c1");
    expect(competition.solvers.map((each) => each.name)).toEqual([
      "c1-a",
      "c1-b",
      "c1-c",
    ]);
    expect(competition.git).toBe(true);
    // Every solver gets a different default strategy, the first one too.
    expect(competition.solvers.map((each) => each.hint)).toEqual(
      DEFAULT_HINTS.slice(0, 3),
    );
    for (const entry of competition.solvers) {
      expect(entry.agentId).toBeDefined();
      // Each workspace starts from the main workspace, dirty files included.
      expect(
        fs.readFileSync(path.join(entry.cwd, "README.md"), "utf8"),
      ).toContain("Dirty.");
      expect(fs.existsSync(path.join(entry.cwd, "notes.txt"))).toBe(true);
    }
    // Solvers get only compete_submit; the judge reads and judges.
    const solver = service.get("c1-a");
    expect(solver?.tools).toContain("compete_submit");
    expect(solver?.tools).not.toContain("collab_board");
    expect(service.get("c1-judge")?.tools).toEqual(
      expect.arrayContaining(["compete_compare", "compete_verdict", "read"]),
    );
    expect(service.get("c1-judge")?.tools).not.toContain("bash");

    await until(
      () =>
        readSubmission(collabRoot, "c1", "c1-a") !== undefined &&
        readSubmission(collabRoot, "c1", "c1-b") !== undefined,
      10_000,
    );
    const a = readSubmission(collabRoot, "c1", "c1-a");
    expect(a?.files.map((file) => file.path)).toEqual(["sum.js"]);
    expect(a?.verify?.exitCode).toBe(0);
    expect(readSubmission(collabRoot, "c1", "c1-b")?.verify?.exitCode).toBe(1);

    // Blind: solvers reach nobody, and nobody reaches them.
    await service.prompt("c1-a", "tool agent_status {}", "followUp");
    await until(() =>
      (service.get("c1-a")?.result?.text ?? "").startsWith("c1-a: "),
    );
    expect(service.get("c1-a")?.result?.text).toContain("No other agents.");
    await service.prompt("other", "tool agent_status {}", "followUp");
    await until(() =>
      (service.get("other")?.result?.text ?? "").startsWith("tool:"),
    );
    expect(service.get("other")?.result?.text).not.toContain("c1-");
    // The session's other agents are in the default group, without them.
    expect(service.get("other")?.tools).toContain("collab_board");
    expect(service.get("other")?.collab?.group).toBe("main");
    expect(solver?.collab).toMatchObject({ competition: "c1", part: "solver" });
    await service.prompt("other", "tool collab_peers {}", "followUp");
    await until(() =>
      (service.get("other")?.result?.text ?? "").includes("collab group"),
    );
    expect(service.get("other")?.result?.text).not.toContain("c1-");
    await service.prompt(
      "other",
      'tool collab_send {"to":"c1-a","text":"psst"}',
      "followUp",
    );
    await until(() =>
      (service.get("other")?.result?.text ?? "").includes("c1-a"),
    );
    expect(service.get("other")?.result?.text).toContain(
      "isn't another member",
    );

    // The main workspace is untouched while they work.
    expect(fs.readFileSync(path.join(repo, "sum.js"), "utf8")).toBe(
      "module.exports = () => 0;\n",
    );

    // c1-c still works; past the deadline, it's stopped and the judge runs.
    expect(service.get("c1-c")?.state).toBe("working");
    expect(await competitions.expire(service, Date.now() + 3_600_000)).toEqual([
      "c1-c",
    ]);
    await until(() => readVerdict(collabRoot, "c1") !== undefined, 10_000);
    expect(readVerdict(collabRoot, "c1")).toMatchObject({
      by: "c1-judge",
      winner: "c1-a",
    });

    const report = await competitions.report(service, "c1", { verify: true });
    expect(report).toContain("| c1-a | idle | yes | pass | 1 | +1/-1 | 0.90 |");
    expect(report).toContain("| c1-b | idle | yes | fail (1) |");
    expect(report).toContain("| c1-c | timed out | no | fail (1) | 0 |");
    expect(report).toContain("Verdict by c1-judge: winner c1-a");
    expect(report).toContain(
      "Rubric order (changes, verify, submitted, confidence, smaller diff): c1-a > c1-b > c1-c",
    );

    // A merge needs two solutions with changes.
    await expect(
      competitions.merge(service, "c1", { from: ["c1-a", "c1-c"] }, plain),
    ).rejects.toThrow("c1-c changed nothing");
    await expect(
      competitions.merge(service, "c1", { from: ["c1-a"] }, plain),
    ).rejects.toThrow("two or more");
    // By default it combines the two best ranked with changes, in a
    // workspace of its own, and submits a new candidate.
    const merge = await competitions.merge(service, "c1", {}, plain);
    expect(merge).toMatchObject({
      name: "c1-m1",
      merge: { from: ["c1-a", "c1-b"] },
    });
    expect(merge.agentId).toBeDefined();
    expect(service.get("c1-m1")?.tools).toContain("compete_submit");
    await until(
      () =>
        readSubmission(collabRoot, "c1", "c1-m1") !== undefined &&
        service.get("c1-m1")?.state === "idle",
      10_000,
    );
    expect(readSubmission(collabRoot, "c1", "c1-m1")?.verify?.exitCode).toBe(0);
    const merged = await competitions.report(service, "c1");
    expect(merged).toContain(
      "| c1-m1 | idle | yes | pass | 1 | +2/-1 | 0.90 |",
    );
    expect(merged).toContain("Merge c1-m1 combines c1-a + c1-b");
    // Nothing reached the main workspace.
    expect(fs.readFileSync(path.join(repo, "sum.js"), "utf8")).toBe(
      "module.exports = () => 0;\n",
    );

    // Only an explicit apply changes the main workspace, with the chosen
    // candidate's change alone.
    const applied = competitions.apply(service, "c1", "c1-m1");
    expect(applied.ok).toBe(true);
    expect(fs.readFileSync(path.join(repo, "sum.js"), "utf8")).toBe(
      `${SOLUTIONS["c1-a"]}// merged: c1-a with c1-b\n`,
    );
    expect(fs.readFileSync(path.join(repo, "README.md"), "utf8")).toContain(
      "Dirty.",
    );
    expect(competitions.find("c1").status).toBe("applied");
    // The state is on disk: a fresh instance, as after a restart, sees it.
    expect(new Competitions(() => collabRoot).find("c1")).toMatchObject({
      status: "applied",
      applied: { solver: "c1-m1", ok: true },
    });

    // Discarding removes the worktrees; the record stays.
    const discarded = await competitions.discard(service, "c1");
    expect(discarded).toContain("removed 4 workspaces");
    for (const entry of competition.solvers)
      expect(fs.existsSync(entry.workspace)).toBe(false);
    expect(git(repo, "worktree", "list")).not.toContain("c1-a");
    expect(git(repo, "worktree", "list")).not.toContain("c1-m1");
  }, 40_000);

  test("piAgents.maxSolvers raises the solver limit past 6", async () => {
    const base = tempDir("pi-compete-many-");
    const dir = path.join(base, "plain");
    const collabRoot = path.join(base, "collab");
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, "sum.js"), "module.exports = () => 0;\n");
    const service = await openService({
      models: fauxModels(step),
      collab: { sessionId: () => "s3", root: () => collabRoot },
    });
    services.push(service);
    const competitions = new Competitions(
      () => collabRoot,
      () => 9,
    );
    await expect(
      competitions.start(service, { task: "x", cwd: dir, solvers: 10 }, plain),
    ).rejects.toThrow("2 to 9 solvers");
    // Nine solvers and a judge are one graph past the per-spawn limit.
    const competition = await competitions.start(
      service,
      { task: "Make sum add.", cwd: dir, solvers: 9, verify: "none" },
      plain,
    );
    expect(competition.solvers).toHaveLength(9);
    expect(competition.solvers.at(-1)?.name).toBe("c1-i");
    expect(service.get("c1-judge")).toBeDefined();
  }, 40_000);

  test("a copy outside Git, and a failed start leaves nothing behind", async () => {
    const base = tempDir("pi-compete-copy-");
    const dir = path.join(base, "plain");
    const collabRoot = path.join(base, "collab");
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, "sum.js"), "module.exports = () => 0;\n");
    const service = await openService({
      models: fauxModels(step),
      collab: { sessionId: () => "s2", root: () => collabRoot },
    });
    services.push(service);
    const competitions = new Competitions(() => collabRoot);
    await expect(
      competitions.start(service, { task: "x", cwd: dir, solvers: 9 }, plain),
    ).rejects.toThrow("2 to 6 solvers");
    expect(fs.readdirSync(path.join(collabRoot, "competitions"))).toEqual([]);
    const competition = await competitions.start(
      service,
      {
        task: "Make sum add.",
        cwd: dir,
        // A given hint replaces the default; an empty one means none.
        variants: [{ hint: "Use the + operator." }, { hint: "" }],
        judge: false,
        verify: "none",
      },
      plain,
    );
    expect(competition.git).toBe(false);
    expect(competition.verify).toBeUndefined();
    await until(
      () =>
        readSubmission(collabRoot, competition.id, "c1-a") !== undefined &&
        service.get("c1-a")?.state === "idle",
      10_000,
    );
    expect(competition.solvers.map((each) => each.hint)).toEqual([
      "Use the + operator.",
      undefined,
    ]);
    // A merge outside Git works in a worktree of a solution's copy.
    await until(
      () =>
        readSubmission(collabRoot, competition.id, "c1-b") !== undefined &&
        service.get("c1-b")?.state === "idle",
      10_000,
    );
    const merge = await competitions.merge(
      service,
      competition.id,
      { guidance: "Keep c1-a's operator." },
      plain,
    );
    expect(merge.merge).toEqual({
      from: ["c1-a", "c1-b"],
      guidance: "Keep c1-a's operator.",
    });
    await until(
      () =>
        readSubmission(collabRoot, competition.id, "c1-m1") !== undefined &&
        service.get("c1-m1")?.state === "idle",
      10_000,
    );
    expect(fs.readFileSync(path.join(dir, "sum.js"), "utf8")).toBe(
      "module.exports = () => 0;\n",
    );
    const applied = competitions.apply(service, competition.id, "c1-m1");
    expect(applied.ok).toBe(true);
    expect(fs.readFileSync(path.join(dir, "sum.js"), "utf8")).toBe(
      `${SOLUTIONS["c1-a"]}// merged: c1-a with c1-b\n`,
    );
    await competitions.discard(service, competition.id);
  }, 30_000);
});
