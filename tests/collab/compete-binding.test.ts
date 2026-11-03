import { afterEach, expect, spyOn, test } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  applySolution,
  approveCompetitionVerification,
  assertBound,
  assertProjectCwd,
  type Competition,
  collectDiff,
  compare,
  comparisonTable,
  competitionDir,
  competitionSeal,
  configureVerifyConcurrency,
  discardWorkspaces,
  inspectCompetition,
  listCompetitionStates,
  listCompetitions,
  MAX_VERIFY_TIMEOUT_MS,
  prepareMergeWorkspace,
  prepareWorkspaces,
  readCompetition,
  runVerify,
  sealCompetition,
  unsealCompetition,
  updateCompetition,
  verificationSnapshot,
  verifySolver,
  writeCompetition,
  writeSubmission,
} from "../../src/collab/compete.js";

const dirs: string[] = [];
afterEach(() => {
  configureVerifyConcurrency(4);
  for (const dir of dirs.splice(0))
    fs.rmSync(dir, { recursive: true, force: true });
});

function fixture(solvers = ["s1"]) {
  const dir = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "compete-binding-")),
  );
  dirs.push(dir);
  const cwd = path.join(dir, "project");
  fs.mkdirSync(cwd);
  fs.writeFileSync(path.join(cwd, "x"), "base\n");
  const collabRoot = path.join(dir, "collab");
  const ws = prepareWorkspaces({ collabRoot, cwd, id: "c1", solvers });
  const competition: Competition = {
    protocol: 1,
    id: "c1",
    task: "test",
    createdAt: 1,
    deadline: 2,
    cwd: ws.cwd,
    root: ws.root,
    git: ws.git,
    verify: "touch approved",
    verifySource: "given",
    verifyTimeoutMs: 500,
    solvers: ws.entries,
    status: "running",
  };
  const entry = competition.solvers[0];
  if (!entry) throw new Error("Missing fixture entry");
  sealCompetition(collabRoot, competition);
  writeCompetition(collabRoot, competition);
  return { dir, cwd, collabRoot, competition, entry };
}

function reload(f: ReturnType<typeof fixture>) {
  const record = readCompetition(f.collabRoot, "c1");
  if (!record) throw new Error("Missing competition");
  return record;
}

const emptyDiff = { patch: "", files: [], hash: "empty" };

test("project preflight rejects outside and symlink sources before creating workspaces", () => {
  const f = fixture();
  const external = path.join(f.dir, "external");
  fs.mkdirSync(external);
  fs.writeFileSync(path.join(external, "private"), "must not copy");
  const link = path.join(f.cwd, "escape");
  fs.symlinkSync(external, link);
  for (const cwd of [external, link]) {
    const collabRoot = path.join(f.dir, "not-created");
    expect(() => assertProjectCwd(cwd, f.cwd)).toThrow(
      "outside the session project",
    );
    expect(() =>
      prepareWorkspaces({
        collabRoot,
        cwd,
        project: f.cwd,
        id: "c2",
        solvers: ["s1"],
      }),
    ).toThrow("outside the session project");
    expect(fs.existsSync(collabRoot)).toBe(false);
  }
  expect(fs.readFileSync(path.join(external, "private"), "utf8")).toBe(
    "must not copy",
  );
});

test("project preflight accepts canonical aliases and sibling cwd within the Git root", () => {
  const f = fixture();
  execFileSync("git", ["init", "-q", f.cwd]);
  execFileSync("git", ["-C", f.cwd, "add", "x"]);
  execFileSync("git", [
    "-C",
    f.cwd,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.com",
    "-c",
    "core.hooksPath=/dev/null",
    "commit",
    "-qm",
    "base",
  ]);
  const project = path.join(f.cwd, "one");
  const cwd = path.join(f.cwd, "two");
  fs.mkdirSync(project);
  fs.mkdirSync(cwd);
  const alias = path.join(f.dir, "alias");
  fs.symlinkSync(cwd, alias);
  expect(() => assertProjectCwd(alias, project)).not.toThrow();
  const ws = prepareWorkspaces({
    collabRoot: f.collabRoot,
    cwd: alias,
    project,
    id: "c2",
    solvers: ["s1"],
  });
  expect(ws.cwd).toBe(cwd);
  expect(ws.root).toBe(f.cwd);
});

test("supplied project is checked for both prepared and already sealed records", () => {
  const f = fixture();
  const external = path.join(f.dir, "external");
  fs.mkdirSync(external);
  expect(() => assertBound(f.collabRoot, f.competition, external)).toThrow(
    "outside the session project",
  );
  const ws = prepareWorkspaces({
    collabRoot: f.collabRoot,
    cwd: f.cwd,
    id: "c2",
    solvers: ["s1"],
  });
  const record = { ...f.competition, id: "c2", solvers: ws.entries };
  expect(() => assertBound(f.collabRoot, record, external)).toThrow(
    "outside the session project",
  );
  expect(competitionSeal(f.collabRoot, "c2")).toBeUndefined();
  expect(assertBound(f.collabRoot, record, f.cwd)).toBe("anchored");
});

test("verification ignores forged disk results and reruns even after same-command reapproval", async () => {
  const f = fixture(["s1", "s2"]);
  unsealCompetition(f.collabRoot, "c1");
  const counter = path.join(f.dir, "runs");
  f.competition.verify = `printf x >> ${JSON.stringify(counter)}; exit 7`;
  approveCompetitionVerification(
    f.collabRoot,
    f.competition,
    verificationSnapshot(f.collabRoot, f.competition),
    f.cwd,
  );
  const resultFile = path.join(
    competitionDir(f.collabRoot, "c1"),
    "results",
    "s1.json",
  );
  fs.mkdirSync(path.dirname(resultFile), { recursive: true });
  const forged = {
    command: f.competition.verify,
    hash: emptyDiff.hash,
    exitCode: 0,
    timedOut: false,
    durationMs: 0,
    output: "forged",
  };
  fs.writeFileSync(resultFile, JSON.stringify(forged));
  const first = await verifySolver(
    f.collabRoot,
    f.competition,
    f.entry,
    emptyDiff,
  );
  expect(first?.exitCode).toBe(7);
  if (first) first.exitCode = 0;
  fs.writeFileSync(resultFile, JSON.stringify(forged));
  approveCompetitionVerification(
    f.collabRoot,
    f.competition,
    verificationSnapshot(f.collabRoot, f.competition),
    f.cwd,
  );
  expect(
    (await verifySolver(f.collabRoot, f.competition, f.entry, emptyDiff))
      ?.exitCode,
  ).toBe(7);
  expect(fs.readFileSync(counter, "utf8")).toBe("xx");
  await verifySolver(f.collabRoot, f.competition, f.entry, {
    ...emptyDiff,
    hash: "changed",
  });
  await verifySolver(
    f.collabRoot,
    f.competition,
    { ...f.entry, base: "a".repeat(40) },
    emptyDiff,
  );
  const sub = path.join(f.entry.cwd, "sub");
  fs.mkdirSync(sub);
  await verifySolver(
    f.collabRoot,
    f.competition,
    { ...f.entry, cwd: sub },
    emptyDiff,
  );
  const second = f.competition.solvers[1];
  if (!second) throw new Error("Missing second solver");
  await verifySolver(f.collabRoot, f.competition, second, emptyDiff);
  expect(fs.readFileSync(counter, "utf8")).toBe("xxxxxx");
  unsealCompetition(f.collabRoot, "c1");
  expect(
    (await verifySolver(f.collabRoot, f.competition, f.entry, emptyDiff))
      ?.skipped,
  ).toBe("unapproved");
  approveCompetitionVerification(
    f.collabRoot,
    f.competition,
    verificationSnapshot(f.collabRoot, f.competition),
    f.cwd,
  );
  expect(
    (await verifySolver(f.collabRoot, f.competition, f.entry, emptyDiff))
      ?.exitCode,
  ).toBe(7);
  expect(fs.readFileSync(counter, "utf8")).toBe("xxxxxxx");
  for (const change of [
    { verifyTimeoutMs: 700 },
    { verify: `printf x >> ${JSON.stringify(counter)}; exit 8` },
  ]) {
    unsealCompetition(f.collabRoot, "c1");
    Object.assign(f.competition, change);
    approveCompetitionVerification(
      f.collabRoot,
      f.competition,
      verificationSnapshot(f.collabRoot, f.competition),
      f.cwd,
    );
    const result = await verifySolver(
      f.collabRoot,
      f.competition,
      f.entry,
      emptyDiff,
    );
    expect(result?.exitCode).toBe(change.verify ? 8 : 7);
  }
  expect(fs.readFileSync(counter, "utf8")).toBe("xxxxxxxxx");
});

test("ignored verification inputs rerun with an identical diff on submit and compare", async () => {
  const f = fixture();
  unsealCompetition(f.collabRoot, "c1");
  f.competition.verify = "grep -qx good ignored.flag";
  approveCompetitionVerification(
    f.collabRoot,
    f.competition,
    verificationSnapshot(f.collabRoot, f.competition),
    f.cwd,
  );
  fs.writeFileSync(path.join(f.entry.cwd, ".gitignore"), "ignored.flag\n");
  const flag = path.join(f.entry.cwd, "ignored.flag");
  fs.writeFileSync(flag, "good\n");
  const diff = collectDiff(f.entry);
  expect(
    (await verifySolver(f.collabRoot, f.competition, f.entry, diff))?.exitCode,
  ).toBe(0);
  fs.writeFileSync(flag, "bad\n");
  expect(collectDiff(f.entry)).toEqual(diff);
  expect(
    (await verifySolver(f.collabRoot, f.competition, f.entry, diff))?.exitCode,
  ).toBe(1);
  fs.writeFileSync(flag, "good\n");
  expect(
    (await compare(f.collabRoot, f.competition, {})).rows[0]?.verify?.exitCode,
  ).toBe(0);
  fs.writeFileSync(flag, "bad\n");
  const compared = await compare(f.collabRoot, f.competition, {});
  expect(compared.rows[0]?.diff).toEqual(diff);
  expect(compared.rows[0]?.verify?.exitCode).toBe(1);
});

test("last process result is immutable for display and ranking, and cleared on unseal", async () => {
  const f = fixture(["s1", "s2"]);
  unsealCompetition(f.collabRoot, "c1");
  f.competition.verify = "grep -qx good ignored.flag";
  approveCompetitionVerification(
    f.collabRoot,
    f.competition,
    verificationSnapshot(f.collabRoot, f.competition),
    f.cwd,
  );
  for (const entry of f.competition.solvers) {
    fs.writeFileSync(path.join(entry.cwd, ".gitignore"), "ignored.flag\n");
    fs.writeFileSync(
      path.join(entry.cwd, "ignored.flag"),
      entry.name === "s1" ? "bad\n" : "good\n",
    );
  }
  const checked = await compare(f.collabRoot, f.competition, {});
  const result = checked.rows[1]?.verify;
  if (!result) throw new Error("Missing verification result");
  result.exitCode = 1;
  const displayed = await compare(
    f.collabRoot,
    f.competition,
    {},
    { verify: false },
  );
  expect(displayed.rows[1]?.verify?.exitCode).toBe(0);
  expect(displayed.suggested).toEqual(["s2", "s1"]);
  unsealCompetition(f.collabRoot, "c1");
  const restored = await compare(
    f.collabRoot,
    f.competition,
    {},
    { verify: false },
  );
  expect(restored.rows.every((row) => row.verify === undefined)).toBe(true);
  expect(restored.suggested).toEqual(["s1", "s2"]);
  approveCompetitionVerification(
    f.collabRoot,
    f.competition,
    verificationSnapshot(f.collabRoot, f.competition),
    f.cwd,
  );
  expect(
    (
      await compare(f.collabRoot, f.competition, {}, { verify: false })
    ).rows.every((row) => row.verify === undefined),
  ).toBe(true);
});

test("historical submission verification is labeled recorded and earns no score credit", async () => {
  const f = fixture(["s1", "s2"]);
  for (const entry of f.competition.solvers) {
    fs.writeFileSync(path.join(entry.cwd, "x"), "changed\n");
    const diff = collectDiff(entry);
    writeSubmission(f.collabRoot, "c1", {
      solver: entry.name,
      summary: "done",
      approach: "test",
      tests: "test",
      caveats: "",
      submittedAt: 1,
      confidence: entry.name === "s1" ? 0.1 : 0.9,
      files: diff.files,
      hash: diff.hash,
      ...(entry.name === "s1"
        ? {
            verify: {
              command: "forged",
              hash: diff.hash,
              exitCode: 0,
              timedOut: false,
              durationMs: 0,
              output: "forged",
              recorded: false,
            },
          }
        : {}),
    });
  }
  const result = await compare(
    f.collabRoot,
    f.competition,
    {},
    { verify: false },
  );
  expect(comparisonTable(result)).toContain("pass (recorded)");
  expect(result.suggested).toEqual(["s2", "s1"]);
  expect(fs.existsSync(path.join(f.entry.cwd, "approved"))).toBe(false);
});

test("inspection retains unsafe entries so lifecycle updates and safe cleanup can proceed", () => {
  const f = fixture(["s1", "s2"]);
  const external = path.join(f.dir, "external");
  fs.mkdirSync(external);
  fs.writeFileSync(path.join(external, "sentinel"), "keep");
  const unsafe = f.competition.solvers[1];
  if (!unsafe) throw new Error("Missing second solver");
  unsafe.workspace = external;
  unsafe.cwd = external;
  writeCompetition(f.collabRoot, f.competition);
  expect(inspectCompetition(f.collabRoot, "c1")?.unsafe).toEqual(["s2"]);
  expect(
    listCompetitionStates(f.collabRoot).map((state) => state.competition.id),
  ).toEqual(["c1"]);
  expect(listCompetitions(f.collabRoot)).toEqual([]);
  expect(() => reload(f)).toThrow("Unsafe workspace");
  expect(() =>
    updateCompetition(f.collabRoot, "c1", (record) => record),
  ).toThrow("Unsafe workspace");
  expect(
    updateCompetition(
      f.collabRoot,
      "c1",
      (record) => ({ ...record, timedOut: ["s1"] }),
      { allowUnsafe: true },
    ).timedOut,
  ).toEqual(["s1"]);
  expect(discardWorkspaces(f.collabRoot, f.competition)).toEqual({
    removed: ["s1"],
    refused: ["s2"],
  });
  expect(fs.readFileSync(path.join(external, "sentinel"), "utf8")).toBe("keep");
});

test("duplicate names and invalid base remain visible but cannot be used for cleanup", () => {
  const f = fixture();
  f.competition.solvers.push({ ...f.entry });
  writeCompetition(f.collabRoot, f.competition);
  expect(inspectCompetition(f.collabRoot, "c1")?.unsafe).toEqual(["s1", "s1"]);
  expect(discardWorkspaces(f.collabRoot, f.competition)).toEqual({
    removed: [],
    refused: ["s1", "s1"],
  });
  f.competition.solvers = [{ ...f.entry, base: "--bad" }];
  writeCompetition(f.collabRoot, f.competition);
  expect(inspectCompetition(f.collabRoot, "c1")?.unsafe).toEqual(["s1"]);
  expect(() => reload(f)).toThrow("Unsafe workspace");
});

test("structural invalidity and timeouts above 60 minutes remain rejected", () => {
  const f = fixture();
  for (const timeout of [0, -1, MAX_VERIFY_TIMEOUT_MS + 1]) {
    writeCompetition(f.collabRoot, {
      ...f.competition,
      verifyTimeoutMs: timeout,
    });
    expect(() => inspectCompetition(f.collabRoot, "c1")).toThrow(
      "Invalid competition record",
    );
    expect(() =>
      runVerify("touch forbidden", f.cwd, { timeoutMs: timeout }),
    ).toThrow("Invalid verification timeout");
  }
  writeCompetition(f.collabRoot, {
    ...f.competition,
    verifyTimeoutMs: MAX_VERIFY_TIMEOUT_MS,
  });
  expect(
    inspectCompetition(f.collabRoot, "c1")?.competition.verifyTimeoutMs,
  ).toBe(MAX_VERIFY_TIMEOUT_MS);
  writeCompetition(f.collabRoot, { ...f.competition, cwd: "relative" });
  expect(() => inspectCompetition(f.collabRoot, "c1")).toThrow(
    "Invalid competition record",
  );
  expect(fs.existsSync(path.join(f.cwd, "forbidden"))).toBe(false);
});

test("start seal survives disk reload and rejects root, cwd, git, command and timeout changes", async () => {
  const f = fixture();
  expect(Object.isFrozen(competitionSeal(f.collabRoot, "c1"))).toBe(true);
  const record = reload(f);
  expect(assertBound(f.collabRoot, record)).toBe("sealed");
  expect(
    (await verifySolver(f.collabRoot, record, f.entry, emptyDiff))?.exitCode,
  ).toBe(0);
  expect(fs.existsSync(path.join(f.entry.cwd, "approved"))).toBe(true);
  const external = path.join(f.dir, "external");
  fs.mkdirSync(external);
  fs.writeFileSync(path.join(external, "x"), "base\n");
  for (const changed of [
    { root: external },
    { cwd: external },
    { git: !record.git },
    { verify: "touch forbidden" },
    { verifyTimeoutMs: record.verifyTimeoutMs + 1 },
  ]) {
    const tampered = { ...record, ...changed };
    expect(() => applySolution(f.collabRoot, tampered, "s1")).toThrow(
      "changed on disk",
    );
    expect(() =>
      prepareMergeWorkspace(f.collabRoot, tampered, "merged", f.entry),
    ).toThrow("changed on disk");
    await expect(
      verifySolver(f.collabRoot, tampered, f.entry, emptyDiff),
    ).rejects.toThrow("changed on disk");
  }
  expect(fs.readFileSync(path.join(external, "x"), "utf8")).toBe("base\n");
  expect(fs.existsSync(path.join(f.entry.cwd, "forbidden"))).toBe(false);
  expect(
    fs.existsSync(
      path.join(competitionDir(f.collabRoot, "c1"), "ws", "merged"),
    ),
  ).toBe(false);
  expect(
    fs.existsSync(path.join(competitionDir(f.collabRoot, "c1"), "patches")),
  ).toBe(false);
});

test("unsealed records cannot verify, even using a cached result, until freshly approved", async () => {
  const f = fixture();
  const snapshot = verificationSnapshot(f.collabRoot, f.competition);
  expect(snapshot).toEqual({ command: "touch approved", timeoutMs: 500 });
  expect(Object.isFrozen(snapshot)).toBe(true);
  unsealCompetition(f.collabRoot, "c1");
  const resultFile = path.join(
    competitionDir(f.collabRoot, "c1"),
    "results",
    "s1.json",
  );
  fs.mkdirSync(path.dirname(resultFile), { recursive: true });
  const forged = JSON.stringify({
    command: "touch approved",
    hash: "empty",
    exitCode: 0,
  });
  fs.writeFileSync(resultFile, forged);
  const record = reload(f);
  const skipped = await verifySolver(f.collabRoot, record, f.entry, emptyDiff);
  expect(skipped?.skipped).toBe("unapproved");
  expect(fs.readFileSync(resultFile, "utf8")).toBe(forged);
  expect(fs.existsSync(path.join(f.entry.cwd, "approved"))).toBe(false);
  expect(() =>
    approveCompetitionVerification(f.collabRoot, record, snapshot),
  ).toThrow("not bound");
  approveCompetitionVerification(f.collabRoot, record, snapshot, f.cwd);
  expect(
    (await verifySolver(f.collabRoot, reload(f), f.entry, emptyDiff))?.exitCode,
  ).toBe(0);
  expect(fs.existsSync(path.join(f.entry.cwd, "approved"))).toBe(true);
});

test("changing command or timeout during approval cannot approve the replacement", () => {
  const f = fixture();
  unsealCompetition(f.collabRoot, "c1");
  const approval = verificationSnapshot(f.collabRoot, reload(f));
  for (const changed of [
    { verify: "touch forbidden" },
    { verifyTimeoutMs: 999 },
  ]) {
    writeCompetition(f.collabRoot, { ...f.competition, ...changed });
    expect(() =>
      approveCompetitionVerification(f.collabRoot, reload(f), approval, f.cwd),
    ).toThrow("changed after approval");
  }
  expect(competitionSeal(f.collabRoot, "c1")).toBeUndefined();
  expect(fs.existsSync(path.join(f.entry.cwd, "forbidden"))).toBe(false);
});

test("queued verification executes captured command and timeout, not later object mutations", async () => {
  const f = fixture();
  configureVerifyConcurrency(1);
  const controller = new AbortController();
  const blocker = runVerify("sleep 10", f.cwd, { signal: controller.signal });
  const approval = verificationSnapshot(f.collabRoot, f.competition);
  const queued = verifySolver(
    f.collabRoot,
    f.competition,
    f.entry,
    emptyDiff,
    undefined,
    approval,
  );
  f.competition.verify = "touch forbidden";
  f.competition.verifyTimeoutMs = MAX_VERIFY_TIMEOUT_MS + 1;
  f.entry.cwd = f.cwd;
  controller.abort();
  await blocker;
  const result = await queued;
  expect(result?.command).toBe("touch approved");
  expect(result?.exitCode).toBe(0);
  expect(fs.existsSync(path.join(f.entry.workspace, "approved"))).toBe(true);
  expect(fs.existsSync(path.join(f.cwd, "approved"))).toBe(false);
  expect(fs.existsSync(path.join(f.entry.workspace, "forbidden"))).toBe(false);
});

test("restored apply requires independent project context and rejects external roots", () => {
  const f = fixture();
  fs.writeFileSync(path.join(f.entry.cwd, "x"), "changed\n");
  expect(collectDiff(f.entry).files).toHaveLength(1);
  unsealCompetition(f.collabRoot, "c1");
  expect(() => applySolution(f.collabRoot, f.competition, "s1")).toThrow(
    "not bound",
  );
  const external = path.join(f.dir, "external");
  fs.mkdirSync(external);
  fs.writeFileSync(path.join(external, "x"), "base\n");
  const tampered = { ...f.competition, root: external, cwd: external };
  expect(() =>
    applySolution(f.collabRoot, tampered, "s1", { project: f.cwd }),
  ).toThrow("outside the session project");
  const handoff = path.join(
    competitionDir(f.collabRoot, "c1"),
    "patches",
    "s1.patch",
  );
  expect(fs.readFileSync(handoff, "utf8")).toContain("+changed");
  expect(() =>
    applySolution(f.collabRoot, tampered, "s1", { project: f.cwd }),
  ).toThrow(handoff);
  expect(() =>
    assertBound(f.collabRoot, { ...f.competition, git: true }, f.cwd),
  ).toThrow("changed on disk");
  expect(fs.readFileSync(path.join(external, "x"), "utf8")).toBe("base\n");
  expect(
    applySolution(f.collabRoot, f.competition, "s1", { project: f.cwd }).ok,
  ).toBe(true);
  expect(fs.readFileSync(path.join(f.cwd, "x"), "utf8")).toBe("changed\n");
});

for (const unsafe of [false, true])
  test(`restored project-bound discard unregisters Git worktrees${unsafe ? " while refusing an unsafe entry" : ""} without approving verification`, () => {
    const f = fixture();
    execFileSync("git", ["init", "-q", f.cwd]);
    execFileSync("git", ["-C", f.cwd, "add", "x"]);
    execFileSync("git", [
      "-C",
      f.cwd,
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "-c",
      "core.hooksPath=/dev/null",
      "commit",
      "-qm",
      "base",
    ]);
    const ws = prepareWorkspaces({
      collabRoot: f.collabRoot,
      cwd: f.cwd,
      project: f.cwd,
      id: "c2",
      solvers: ["s1", "s2"],
    });
    const competition = {
      ...f.competition,
      id: "c2",
      cwd: ws.cwd,
      root: ws.root,
      git: ws.git,
      solvers: ws.entries,
    };
    writeCompetition(f.collabRoot, competition);
    const record = readCompetition(f.collabRoot, "c2");
    if (!record) throw new Error("Missing restored competition");
    unsealCompetition(f.collabRoot, "c2");
    const external = path.join(f.dir, "external");
    fs.mkdirSync(external);
    fs.writeFileSync(path.join(external, "sentinel"), "keep");
    const worktrees = () =>
      execFileSync("git", ["-C", f.cwd, "worktree", "list", "--porcelain"], {
        encoding: "utf8",
      });
    if (unsafe) {
      const entry = record.solvers[1];
      if (!entry) throw new Error("Missing second solver");
      entry.workspace = external;
      entry.cwd = external;
    }
    expect(discardWorkspaces(f.collabRoot, record, { project: f.cwd })).toEqual(
      {
        removed: unsafe ? ["s1"] : ["s1", "s2"],
        refused: unsafe ? ["s2"] : [],
      },
    );
    expect(competitionSeal(f.collabRoot, "c2")).toBeUndefined();
    const remaining = worktrees();
    expect(remaining).not.toContain(
      path.join(competitionDir(f.collabRoot, "c2"), "ws", "s1"),
    );
    expect(
      remaining.split("\n").filter((line) => line.startsWith("worktree ")),
    ).toHaveLength(unsafe ? 2 : 1);
    expect(fs.readFileSync(path.join(external, "sentinel"), "utf8")).toBe(
      "keep",
    );
  });

for (const change of ["deleted cwd", "changed Git root", "outside project"]) {
  test(`project binding failure (${change}) allows contained cleanup without Git cleanup`, () => {
    const f = fixture(["s1", "s2"]);
    unsealCompetition(f.collabRoot, "c1");
    const external = path.join(f.dir, "external");
    fs.mkdirSync(external);
    fs.writeFileSync(path.join(external, "sentinel"), "keep");
    const unsafe = f.competition.solvers[1];
    if (!unsafe) throw new Error("Missing second solver");
    fs.rmSync(unsafe.workspace, { recursive: true });
    fs.symlinkSync(external, unsafe.workspace);
    if (change === "deleted cwd") fs.rmSync(f.cwd, { recursive: true });
    if (change === "changed Git root") {
      execFileSync("git", ["init", "-q", f.dir]);
      execFileSync("git", ["-C", f.dir, "add", "project/x"]);
      execFileSync("git", [
        "-C",
        f.dir,
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.com",
        "-c",
        "core.hooksPath=/dev/null",
        "commit",
        "-qm",
        "new root",
      ]);
      expect(() => assertBound(f.collabRoot, f.competition, f.cwd)).toThrow(
        "changed on disk",
      );
    }
    const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
    const bin = path.join(f.dir, "bin");
    const marker = path.join(f.dir, "git-cleanup");
    fs.mkdirSync(bin);
    fs.writeFileSync(
      path.join(bin, "git"),
      `#!/bin/sh\ncase "$*" in *worktree*) touch ${JSON.stringify(marker)};; esac\nexec ${JSON.stringify(realGit)} "$@"\n`,
      { mode: 0o755 },
    );
    const savedPath = process.env.PATH;
    try {
      process.env.PATH = `${bin}:${savedPath}`;
      expect(
        discardWorkspaces(f.collabRoot, f.competition, {
          project: change === "outside project" ? external : f.cwd,
        }),
      ).toEqual({ removed: ["s1"], refused: ["s2"] });
      expect(fs.existsSync(f.entry.workspace)).toBe(false);
      expect(fs.lstatSync(unsafe.workspace).isSymbolicLink()).toBe(true);
      expect(fs.readFileSync(path.join(external, "sentinel"), "utf8")).toBe(
        "keep",
      );
      expect(fs.existsSync(marker)).toBe(false);
    } finally {
      if (savedPath === undefined) delete process.env.PATH;
      else process.env.PATH = savedPath;
    }
  });
}

test("merge dependency failure rolls back the new worktree and Git registration", () => {
  const f = fixture();
  const worktrees = () =>
    execFileSync(
      "git",
      ["-C", f.entry.workspace, "worktree", "list", "--porcelain"],
      { encoding: "utf8" },
    );
  const before = worktrees();
  const workspace = path.join(
    competitionDir(f.collabRoot, "c1"),
    "ws",
    "merged",
  );
  const original = fs.existsSync;
  const exists = spyOn(fs, "existsSync").mockImplementation((file) => {
    if (file === path.join(f.cwd, "node_modules"))
      throw new Error("dependency failure");
    return original(file);
  });
  try {
    expect(() =>
      prepareMergeWorkspace(f.collabRoot, f.competition, "merged", f.entry),
    ).toThrow("dependency failure");
  } finally {
    exists.mockRestore();
  }
  expect(fs.existsSync(workspace)).toBe(false);
  expect(worktrees()).toBe(before);
  expect(fs.readFileSync(path.join(f.entry.cwd, "x"), "utf8")).toBe("base\n");
});

test("merge preparation preserves preexisting paths and refuses escaping or dangling links", () => {
  const f = fixture();
  const workspace = path.join(
    competitionDir(f.collabRoot, "c1"),
    "ws",
    "merged",
  );
  fs.mkdirSync(workspace);
  fs.writeFileSync(path.join(workspace, "sentinel"), "keep");
  expect(() =>
    prepareMergeWorkspace(f.collabRoot, f.competition, "merged", f.entry),
  ).toThrow("exists already");
  expect(fs.readFileSync(path.join(workspace, "sentinel"), "utf8")).toBe(
    "keep",
  );
  fs.rmSync(workspace, { recursive: true });
  fs.symlinkSync(f.cwd, workspace);
  expect(() =>
    prepareMergeWorkspace(f.collabRoot, f.competition, "merged", f.entry),
  ).toThrow("exists already");
  expect(fs.readFileSync(path.join(f.cwd, "x"), "utf8")).toBe("base\n");
  fs.unlinkSync(workspace);
  fs.symlinkSync(path.join(f.dir, "missing"), workspace);
  expect(() =>
    prepareMergeWorkspace(f.collabRoot, f.competition, "merged", f.entry),
  ).toThrow("Unsafe workspace");
  expect(fs.lstatSync(workspace).isSymbolicLink()).toBe(true);
});

test("unbound discard removes only contained workspaces and never invokes Git in recorded root", () => {
  const f = fixture();
  unsealCompetition(f.collabRoot, "c1");
  const bin = path.join(f.dir, "bin");
  const marker = path.join(f.dir, "git-invoked");
  fs.mkdirSync(bin);
  fs.writeFileSync(
    path.join(bin, "git"),
    `#!/bin/sh\ntouch ${JSON.stringify(marker)}\nexit 1\n`,
    { mode: 0o755 },
  );
  const savedPath = process.env.PATH;
  try {
    process.env.PATH = `${bin}:${savedPath}`;
    const tampered = { ...f.competition, root: f.dir, cwd: f.dir, git: true };
    expect(discardWorkspaces(f.collabRoot, tampered)).toEqual({
      removed: ["s1"],
      refused: [],
    });
    expect(fs.existsSync(marker)).toBe(false);
    expect(fs.existsSync(f.cwd)).toBe(true);
  } finally {
    if (savedPath === undefined) delete process.env.PATH;
    else process.env.PATH = savedPath;
  }
});
