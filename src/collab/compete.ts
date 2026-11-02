/**
 * Competitions: several solvers solve the same task independently, each in
 * its own workspace, then their solutions are compared, judged, and one is
 * applied to the main workspace on the user's or parent's say-so.
 *
 * Everything here is plain files and Git, outside pi-durable, under the
 * session's collab directory:
 *
 *   competitions/<id>/competition.json   the record: task, workspaces, agents
 *   competitions/<id>/submissions/<solver>.json
 *   competitions/<id>/results/<solver>.json   verify result by diff hash
 *   competitions/<id>/verdict.json
 *   competitions/<id>/patches/<solver>.patch  what apply applies
 *   competitions/<id>/ws/<solver>/            the solver's workspace
 *
 * A workspace is a Git checkout whose base commit holds the main
 * workspace as it was at the start, uncommitted and untracked files
 * included: a detached worktree of the repository, or a copy with its own
 * repository outside Git. A solution is the diff of the workspace against
 * that base, so it applies to the main workspace with `git apply`.
 */

import { execFileSync, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { readJson, writeJsonAtomic } from "./files.js";

export const COMPETITION_PROTOCOL = 1;
/** Solvers in a competition: `max` is the default of the
 * `piAgents.maxSolvers` setting. */
export const SOLVER_COUNT = { min: 2, max: 6 } as const;
export const VERIFY_TIMEOUT_MS = 5 * 60_000;
export const COMPETE_TIMEOUT_MS = 30 * 60_000;
const OUTPUT_TAIL = 6_000;

/** Strategies that spread solvers out: solver N gets hint N unless the
 * call gives it one (an empty hint means none). */
export const DEFAULT_HINTS = [
  "Prefer the simplest, smallest change that fully solves the task.",
  "Prioritize robustness: handle edge cases and invalid input, and test them.",
  "Start by writing tests that pin down the expected behavior, then implement.",
  "Favor readability and clear structure over cleverness.",
  "Consider an alternative approach to the obvious one before you commit to it.",
  "Follow the conventions of the surrounding code closely and keep the change consistent with them.",
];

export interface SolverPlan {
  name: string;
  hint?: string;
  model?: string;
  thinking?: string;
}

export interface SolverEntry extends SolverPlan {
  /** The root of its checkout. */
  workspace: string;
  /** Where it works: the checkout plus the main workspace's subdirectory. */
  cwd: string;
  /** The commit its diff is taken against. */
  base: string;
  agentId?: string;
  /** For a merge: the solutions it combines, and what it was told. */
  merge?: { from: string[]; guidance?: string };
  /** When it's stopped if unfinished; default the competition's. */
  deadline?: number;
  /** Its own graph, for a merge. */
  graph?: string;
}

export type CompetitionStatus = "running" | "applied" | "discarded";

export interface Competition {
  protocol: number;
  id: string;
  task: string;
  createdAt: number;
  /** When unfinished solvers are stopped. */
  deadline: number;
  /** The main workspace: the directory the competition started in. */
  cwd: string;
  /** Where patches apply: the repository's top level, or `cwd`. */
  root: string;
  git: boolean;
  verify?: string;
  verifySource: "given" | "detected" | "none";
  verifyTimeoutMs: number;
  solvers: SolverEntry[];
  /** The final judge; with brackets, it judges the brackets' finalists. */
  judge?: { name: string; model?: string; thinking?: string; agentId?: string };
  /** When solvers outnumber what one judge compares: groups judged first,
   * each by its own judge. */
  brackets?: Bracket[];
  graph?: string;
  status: CompetitionStatus;
  /** Solvers stopped at the deadline. */
  timedOut?: string[];
  applied?: { solver: string; at: number; ok: boolean; output: string };
}

export interface Bracket {
  /** Its judge's agent name. */
  judge: string;
  agentId?: string;
  /** The solvers it judges. */
  solvers: string[];
}

/** Solvers of each bracket that reach the final. */
export const FINALISTS_PER_BRACKET = 2;
/** The characters of solutions one judge's comparison holds at most,
 * about 40k tokens, so a judge's prompt stays near or under 60k. */
export const JUDGE_BUDGET_CHARS = 160_000;

export interface Submission {
  solver: string;
  summary: string;
  approach: string;
  tests: string;
  confidence: number;
  caveats: string;
  submittedAt: number;
  files: DiffFile[];
  hash: string;
  verify?: VerifyResult;
}

export interface DiffFile {
  path: string;
  added: number;
  removed: number;
}

export interface Diff {
  patch: string;
  files: DiffFile[];
  hash: string;
}

export interface VerifyResult {
  command: string;
  /** The diff it ran on. */
  hash: string;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  output: string;
}

export interface Verdict {
  by: string;
  winner: string;
  ranking: string[];
  rationale: string;
  merge?: string;
  at: number;
}

// Files

export function competitionsRoot(collabRoot: string): string {
  return path.join(collabRoot, "competitions");
}

export function competitionDir(collabRoot: string, id: string): string {
  return path.join(competitionsRoot(collabRoot), id);
}

/** Reserve the next competition ID, `c1`, `c2`, …, by creating its
 * directory. */
export function reserveCompetitionId(collabRoot: string): string {
  const root = competitionsRoot(collabRoot);
  fs.mkdirSync(root, { recursive: true });
  for (let n = 1; ; n++) {
    try {
      fs.mkdirSync(path.join(root, `c${n}`));
      return `c${n}`;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
}

export function readCompetition(
  collabRoot: string,
  id: string,
): Competition | undefined {
  const record = readJson<Competition>(
    path.join(competitionDir(collabRoot, id), "competition.json"),
  );
  return record?.protocol === COMPETITION_PROTOCOL ? record : undefined;
}

export function writeCompetition(
  collabRoot: string,
  competition: Competition,
): void {
  writeJsonAtomic(
    path.join(competitionDir(collabRoot, competition.id), "competition.json"),
    competition,
  );
}

/** Change a competition's record; returns the new record. */
export function updateCompetition(
  collabRoot: string,
  id: string,
  change: (competition: Competition) => Competition,
): Competition {
  const current = readCompetition(collabRoot, id);
  if (!current) throw new Error(`No competition ${id}`);
  const next = change(current);
  writeCompetition(collabRoot, next);
  return next;
}

/** Every competition, newest first. */
export function listCompetitions(collabRoot: string): Competition[] {
  let names: string[] = [];
  try {
    names = fs.readdirSync(competitionsRoot(collabRoot));
  } catch {
    return [];
  }
  return names
    .flatMap((name) => {
      const record = readCompetition(collabRoot, name);
      return record ? [record] : [];
    })
    .sort((left, right) => right.createdAt - left.createdAt);
}

export function readSubmission(
  collabRoot: string,
  id: string,
  solver: string,
): Submission | undefined {
  return readJson<Submission>(
    path.join(competitionDir(collabRoot, id), "submissions", `${solver}.json`),
  );
}

export function writeSubmission(
  collabRoot: string,
  id: string,
  submission: Submission,
): void {
  writeJsonAtomic(
    path.join(
      competitionDir(collabRoot, id),
      "submissions",
      `${submission.solver}.json`,
    ),
    submission,
  );
}

export function readVerdict(
  collabRoot: string,
  id: string,
): Verdict | undefined {
  return readJson<Verdict>(
    path.join(competitionDir(collabRoot, id), "verdict.json"),
  );
}

export function writeVerdict(
  collabRoot: string,
  id: string,
  verdict: Verdict,
  bracket?: number,
): void {
  writeJsonAtomic(
    path.join(
      competitionDir(collabRoot, id),
      bracket === undefined ? "verdict.json" : `bracket-${bracket + 1}.json`,
    ),
    verdict,
  );
}

/** A bracket judge's verdict. */
export function readBracketVerdict(
  collabRoot: string,
  id: string,
  bracket: number,
): Verdict | undefined {
  return readJson<Verdict>(
    path.join(competitionDir(collabRoot, id), `bracket-${bracket + 1}.json`),
  );
}

/** Split solvers into brackets of at most `size`, as even as can be:
 * none when one judge compares them all. */
export function bracketsOf(
  solvers: readonly string[],
  size: number,
): string[][] {
  if (solvers.length <= size) return [];
  const count = Math.ceil(solvers.length / size);
  const brackets: string[][] = Array.from({ length: count }, () => []);
  solvers.forEach((name, index) => {
    brackets[Math.floor((index * count) / solvers.length)]?.push(name);
  });
  return brackets;
}

/** The solvers the final judge compares: each bracket's best by its
 * judge's ranking, or by the rubric where its judge gave no verdict. */
export async function finalists(
  collabRoot: string,
  competition: Competition,
): Promise<string[]> {
  const brackets = competition.brackets ?? [];
  if (brackets.length === 0)
    return competition.solvers.map((entry) => entry.name);
  const chosen: string[] = [];
  for (const [index, bracket] of brackets.entries()) {
    const verdict = readBracketVerdict(collabRoot, competition.id, index);
    const ranked = verdict?.ranking.length
      ? verdict.ranking
      : (
          await compare(
            collabRoot,
            competition,
            {},
            { verify: false, solvers: bracket.solvers },
          )
        ).suggested;
    chosen.push(
      ...ranked
        .filter((name) => bracket.solvers.includes(name))
        .slice(0, FINALISTS_PER_BRACKET),
    );
  }
  return chosen;
}

// Git

function git(cwd: string, args: string[], input?: string): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    input,
    maxBuffer: 256 * 1024 * 1024,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

function gitOk(cwd: string, args: string[]): boolean {
  try {
    git(cwd, args);
    return true;
  } catch {
    return false;
  }
}

function errorOutput(error: unknown): string {
  const failure = error as {
    stderr?: string;
    stdout?: string;
    message?: string;
  };
  return (
    `${failure.stdout ?? ""}${failure.stderr ?? ""}`.trim() ||
    failure.message ||
    String(error)
  );
}

const IDENTITY = [
  "-c",
  "user.name=pi-agents",
  "-c",
  "user.email=pi-agents@localhost",
  "-c",
  "commit.gpgsign=false",
];

/** What a solution leaves out: dependencies that workspaces link to the
 * main workspace, and caches. */
const PATHSPEC = [
  "--",
  ".",
  ":(exclude)node_modules",
  ":(glob,exclude)**/node_modules",
  ":(glob,exclude)**/__pycache__/**",
  ":(glob,exclude)**/.pytest_cache/**",
];

function commitAll(workspace: string, message: string): string {
  git(workspace, ["add", "-A", ...PATHSPEC]);
  git(workspace, [
    ...IDENTITY,
    "commit",
    "-q",
    "--no-verify",
    "--allow-empty",
    "-m",
    message,
  ]);
  return git(workspace, ["rev-parse", "HEAD"]).trim();
}

function repositoryOf(cwd: string): string | undefined {
  try {
    const top = git(cwd, ["rev-parse", "--show-toplevel"]).trim();
    return top && gitOk(top, ["rev-parse", "--verify", "-q", "HEAD"])
      ? top
      : undefined;
  } catch {
    return undefined;
  }
}

/** Directory levels below the main workspace searched for nested
 * `node_modules`, such as a monorepo's `packages/<name>/node_modules`. */
const DEPENDENCY_DEPTH = 3;
/** Directories that search reads at most, so a huge tree costs little. */
const DEPENDENCY_SCAN = 2_000;

/**
 * Share the main workspace's installed dependencies with a solver's
 * workspace: each `node_modules`, at the top and in packages up to
 * `DEPENDENCY_DEPTH` levels down, becomes a symlink to the main one, so
 * every solver uses one install and none runs its own. Python virtual
 * environments and build outputs aren't linked: they bind to the main
 * checkout's paths (editable installs, absolute paths in scripts), so
 * solvers' tests would run the main workspace's code.
 */
function linkDependencies(main: string, workspace: string): void {
  const link = (relative: string) => {
    const from = path.join(main, relative, "node_modules");
    const to = path.join(workspace, relative, "node_modules");
    if (
      fs.existsSync(from) &&
      fs.existsSync(path.dirname(to)) &&
      !fs.existsSync(to)
    )
      try {
        fs.symlinkSync(from, to, "dir");
      } catch {}
  };
  link("");
  let scanned = 0;
  const visit = (relative: string, depth: number) => {
    if (depth >= DEPENDENCY_DEPTH) return;
    let children: fs.Dirent[];
    try {
      children = fs.readdirSync(path.join(main, relative), {
        withFileTypes: true,
      });
    } catch {
      return;
    }
    for (const child of children) {
      if (
        !child.isDirectory() ||
        SKIPPED.has(child.name) ||
        child.name.startsWith(".") ||
        ++scanned > DEPENDENCY_SCAN
      )
        continue;
      const next = path.join(relative, child.name);
      link(next);
      visit(next, depth + 1);
    }
  };
  visit("", 0);
}

const SKIPPED = new Set(["node_modules", ".git"]);

export interface Workspaces {
  git: boolean;
  root: string;
  entries: Array<Pick<SolverEntry, "name" | "workspace" | "cwd" | "base">>;
}

/**
 * Create one workspace per solver under the competition's directory: a
 * detached worktree at HEAD with the main workspace's uncommitted and
 * untracked files committed on top, or a copy with a fresh repository.
 * Dependencies (`node_modules`, nested ones too) are linked, not copied.
 */
export function prepareWorkspaces(options: {
  collabRoot: string;
  id: string;
  cwd: string;
  solvers: readonly string[];
}): Workspaces {
  const cwd = path.resolve(options.cwd);
  const top = repositoryOf(cwd);
  const root = top ?? cwd;
  const relative = path.relative(root, cwd);
  const base = path.join(competitionDir(options.collabRoot, options.id), "ws");
  fs.mkdirSync(base, { recursive: true });
  // What the main workspace adds to HEAD, read once for every solver.
  const dirty = top ? git(top, ["diff", "HEAD", "--binary"]) : "";
  const untracked = top
    ? git(top, ["ls-files", "--others", "--exclude-standard", "-z"])
        .split("\0")
        .filter(
          (file) => file && !file.split("/").some((part) => SKIPPED.has(part)),
        )
    : [];
  const entries = options.solvers.map((name) => {
    const workspace = path.join(base, name);
    let commit: string;
    if (top) {
      git(top, ["worktree", "add", "--detach", "-q", workspace, "HEAD"]);
      if (dirty)
        git(workspace, ["apply", "--binary", "--whitespace=nowarn"], dirty);
      for (const file of untracked) {
        const target = path.join(workspace, file);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.cpSync(path.join(top, file), target, { verbatimSymlinks: true });
      }
      commit =
        dirty || untracked.length > 0
          ? commitAll(workspace, "pi-agents competition base")
          : git(workspace, ["rev-parse", "HEAD"]).trim();
    } else {
      fs.cpSync(cwd, workspace, {
        recursive: true,
        verbatimSymlinks: true,
        filter: (source) =>
          source === cwd || !SKIPPED.has(path.basename(source)),
      });
      git(workspace, ["init", "-q"]);
      commit = commitAll(workspace, "pi-agents competition base");
    }
    linkDependencies(root, workspace);
    if (relative) linkDependencies(cwd, path.join(workspace, relative));
    return {
      name,
      workspace,
      cwd: relative ? path.join(workspace, relative) : workspace,
      base: commit,
    };
  });
  return { git: top !== undefined, root, entries };
}

/** The solution: the workspace against its base, new files included. */
export function collectDiff(
  entry: Pick<SolverEntry, "workspace" | "base">,
): Diff {
  if (!fs.existsSync(entry.workspace))
    return { patch: "", files: [], hash: "missing" };
  git(entry.workspace, ["add", "-A", ...PATHSPEC]);
  const patch = git(entry.workspace, [
    "diff",
    "--cached",
    "--binary",
    entry.base,
    ...PATHSPEC,
  ]);
  const files = git(entry.workspace, [
    "diff",
    "--cached",
    "--numstat",
    entry.base,
    ...PATHSPEC,
  ])
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [added, removed, ...file] = line.split("\t");
      return {
        path: file.join("\t"),
        added: Number(added) || 0,
        removed: Number(removed) || 0,
      };
    });
  const hash = crypto
    .createHash("sha256")
    .update(patch)
    .digest("hex")
    .slice(0, 16);
  return { patch, files, hash };
}

/** The test command a project declares, if any. */
export function detectVerify(dir: string): string | undefined {
  const has = (name: string) => fs.existsSync(path.join(dir, name));
  if (has("package.json")) {
    const json = readJson<{ scripts?: Record<string, string> }>(
      path.join(dir, "package.json"),
    );
    const test = json?.scripts?.test;
    if (test && !/no test specified/.test(test)) {
      if (has("bun.lock") || has("bun.lockb")) return "bun run test";
      if (has("pnpm-lock.yaml")) return "pnpm test";
      if (has("yarn.lock")) return "yarn test";
      return "npm test";
    }
    if (has("bun.lock") || has("bun.lockb")) return "bun test";
  }
  if (has("Cargo.toml")) return "cargo test";
  if (has("go.mod")) return "go test ./...";
  if (
    has("pytest.ini") ||
    has("pyproject.toml") ||
    has("setup.cfg") ||
    has("tox.ini") ||
    has("conftest.py") ||
    has("tests") ||
    safeList(dir).some((name) => /^test_.*\.py$|_test\.py$/.test(name))
  )
    return "python3 -m pytest -q";
  if (has("Makefile")) {
    const text = fs.readFileSync(path.join(dir, "Makefile"), "utf8");
    if (/^test:/m.test(text)) return "make test";
  }
  return undefined;
}

function safeList(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

/** Verify commands share a pool of slots, so many solvers that submit at
 * once, or a comparison of many, don't run every test suite together. */
class Pool {
  private running = 0;
  private readonly waiting: Array<() => void> = [];
  constructor(public size: number) {}

  get active(): number {
    return this.running;
  }

  async run<T>(body: () => Promise<T>): Promise<T> {
    if (this.running >= this.size)
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    this.running += 1;
    try {
      return await body();
    } finally {
      this.running -= 1;
      if (this.running < this.size) this.waiting.shift()?.();
    }
  }
}

export const DEFAULT_VERIFY_CONCURRENCY = 4;
const verifyPool = new Pool(DEFAULT_VERIFY_CONCURRENCY);

/** How many verify commands run at once (`piAgents.verifyConcurrency`). */
export function configureVerifyConcurrency(size: number): void {
  verifyPool.size = Math.max(1, Math.floor(size));
}

/** Verify commands running now; for tests and status. */
export function runningVerifies(): number {
  return verifyPool.active;
}

/** Run a verify command in a workspace once a slot of the pool is free,
 * with a timeout, from then, that kills its process group. */
export function runVerify(
  command: string,
  cwd: string,
  options: { timeoutMs?: number; hash?: string; signal?: AbortSignal } = {},
): Promise<VerifyResult> {
  return verifyPool.run(() => spawnVerify(command, cwd, options));
}

function spawnVerify(
  command: string,
  cwd: string,
  options: { timeoutMs?: number; hash?: string; signal?: AbortSignal },
): Promise<VerifyResult> {
  const started = Date.now();
  if (options.signal?.aborted)
    return Promise.resolve({
      command,
      hash: options.hash ?? "",
      exitCode: null,
      timedOut: false,
      durationMs: 0,
      output: "aborted before it ran",
    });
  return new Promise((resolve) => {
    let output = "";
    let timedOut = false;
    const child = spawn("sh", ["-c", command], {
      cwd,
      detached: true,
      env: { ...process.env, CI: "1", FORCE_COLOR: "0" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const collect = (chunk: Buffer) => {
      output = (output + chunk.toString("utf8")).slice(-OUTPUT_TAIL * 2);
    };
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);
    const kill = () => {
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {}
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, options.timeoutMs ?? VERIFY_TIMEOUT_MS);
    const abort = () => kill();
    options.signal?.addEventListener("abort", abort, { once: true });
    const finish = (exitCode: number | null, extra = "") => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      resolve({
        command,
        hash: options.hash ?? "",
        exitCode,
        timedOut,
        durationMs: Date.now() - started,
        output: (output + extra).slice(-OUTPUT_TAIL),
      });
    };
    child.on("error", (error) => finish(null, `\n${error.message}`));
    child.on("close", (code) => finish(code));
  });
}

/** The verify result of a solver's current diff: cached by diff hash, or
 * run now. */
export async function verifySolver(
  collabRoot: string,
  competition: Competition,
  entry: SolverEntry,
  diff: Diff,
  signal?: AbortSignal,
): Promise<VerifyResult | undefined> {
  if (!competition.verify || !fs.existsSync(entry.cwd)) return undefined;
  const file = path.join(
    competitionDir(collabRoot, competition.id),
    "results",
    `${entry.name}.json`,
  );
  const cached = readJson<VerifyResult>(file);
  if (cached?.hash === diff.hash && cached.command === competition.verify)
    return cached;
  const result = await runVerify(competition.verify, entry.cwd, {
    timeoutMs: competition.verifyTimeoutMs,
    hash: diff.hash,
    ...(signal ? { signal } : {}),
  });
  if (!signal?.aborted) writeJsonAtomic(file, result);
  return result;
}

export function verifyLabel(result: VerifyResult | undefined): string {
  if (!result) return "—";
  if (result.timedOut) return "timeout";
  return result.exitCode === 0 ? "pass" : `fail (${result.exitCode})`;
}

// Comparison

export interface ComparisonRow {
  solver: string;
  state: string;
  submitted: boolean;
  submission?: Submission;
  diff: Diff;
  verify?: VerifyResult;
  workspace: string;
}

export interface Comparison {
  competition: Competition;
  rows: ComparisonRow[];
  /** Solvers by the mechanical rubric: verify passes, submitted,
   * confidence, smaller change. */
  suggested: string[];
  verdict?: Verdict;
}

function changed(diff: Diff): number {
  return diff.files.reduce((sum, file) => sum + file.added + file.removed, 0);
}

/** Gather every solver's diff, submission, and verify result. */
export async function compare(
  collabRoot: string,
  competition: Competition,
  states: Readonly<Record<string, string>>,
  options: { verify?: boolean; signal?: AbortSignal; solvers?: string[] } = {},
): Promise<Comparison> {
  const entries = options.solvers
    ? competition.solvers.filter((entry) =>
        options.solvers?.includes(entry.name),
      )
    : competition.solvers;
  // Verifies run side by side, as many as the pool allows.
  const rows = await Promise.all(
    entries.map(async (entry): Promise<ComparisonRow> => {
      const diff = collectDiff(entry);
      const submission = readSubmission(collabRoot, competition.id, entry.name);
      const verify =
        options.verify === false
          ? submission?.hash === diff.hash
            ? submission.verify
            : undefined
          : await verifySolver(
              collabRoot,
              competition,
              entry,
              diff,
              options.signal,
            );
      return {
        solver: entry.name,
        state:
          (competition.timedOut?.includes(entry.name)
            ? "timed out"
            : undefined) ??
          states[entry.name] ??
          "unknown",
        submitted: submission !== undefined,
        ...(submission ? { submission } : {}),
        diff,
        ...(verify ? { verify } : {}),
        workspace: entry.cwd,
      };
    }),
  );
  const score = (row: ComparisonRow): number[] => [
    row.diff.files.length > 0 ? 1 : 0,
    row.verify
      ? row.verify.exitCode === 0 && !row.verify.timedOut
        ? 1
        : 0
      : 0,
    row.submitted ? 1 : 0,
    row.submission?.confidence ?? 0,
    -changed(row.diff),
  ];
  const suggested = [...rows]
    .sort((left, right) => {
      const a = score(left);
      const b = score(right);
      for (let index = 0; index < a.length; index++)
        if ((a[index] as number) !== (b[index] as number))
          return (b[index] as number) - (a[index] as number);
      return 0;
    })
    .map((row) => row.solver);
  const verdict = readVerdict(collabRoot, competition.id);
  return { competition, rows, suggested, ...(verdict ? { verdict } : {}) };
}

function cell(text: string, max = 60): string {
  const line = text.replace(/\s+/g, " ").trim();
  return (line.length > max ? `${line.slice(0, max - 1)}…` : line).replace(
    /\|/g,
    "\\|",
  );
}

/** The comparison as a Markdown table, with the rubric's order and the
 * verdict. */
export function comparisonTable(comparison: Comparison): string {
  const { competition } = comparison;
  const lines = [
    `Competition ${competition.id} (${competition.status}): ${cell(competition.task, 100)}`,
    `Verify: ${competition.verify ? `\`${competition.verify}\` (${competition.verifySource})` : "none"}`,
    "",
    "| solver | state | submitted | verify | files | +/- | confidence | summary |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
    ...comparison.rows.map((row) => {
      const added = row.diff.files.reduce((sum, file) => sum + file.added, 0);
      const removed = row.diff.files.reduce(
        (sum, file) => sum + file.removed,
        0,
      );
      return `| ${row.solver} | ${row.state} | ${row.submitted ? "yes" : "no"} | ${verifyLabel(row.verify)} | ${row.diff.files.length} | +${added}/-${removed} | ${row.submission ? row.submission.confidence.toFixed(2) : "—"} | ${cell(row.submission?.summary ?? "")} |`;
    }),
    "",
    `Rubric order (changes, verify, submitted, confidence, smaller diff): ${comparison.suggested.join(" > ")}`,
    ...competition.solvers
      .filter((entry) => entry.merge)
      .map(
        (entry) =>
          `Merge ${entry.name} combines ${entry.merge?.from.join(" + ")}${entry.merge?.guidance ? ` (${cell(entry.merge.guidance, 80)})` : ""}`,
      ),
  ];
  const { verdict } = comparison;
  if (verdict)
    lines.push(
      `Verdict by ${verdict.by}: winner ${verdict.winner}; ranking ${verdict.ranking.join(" > ")}`,
      `Rationale: ${verdict.rationale}`,
      ...(verdict.merge ? [`Merge proposal: ${verdict.merge}`] : []),
    );
  if (competition.applied)
    lines.push(
      `Applied ${competition.applied.solver}: ${competition.applied.ok ? "ok" : "failed"}`,
    );
  return lines.join("\n");
}

/** Each solver's submission, verify output, and diff, for a judge. */
export function comparisonDetails(
  comparison: Comparison,
  options: { maxDiffChars?: number; budgetChars?: number } = {},
): string {
  // Each solution's diff shrinks so that all of them fit the budget, with
  // room for its submission and verify output.
  const share = Math.floor(
    (options.budgetChars ?? JUDGE_BUDGET_CHARS) /
      Math.max(1, comparison.rows.length),
  );
  const max = Math.max(
    1_000,
    Math.min(options.maxDiffChars ?? 8_000, share - 3_500),
  );
  return comparison.rows
    .map((row) => {
      const submission = row.submission;
      const diff =
        row.diff.patch.length > max
          ? `${row.diff.patch.slice(0, max)}\n… (${row.diff.patch.length - max} more characters; read the files in the workspace)`
          : row.diff.patch;
      return [
        `## ${row.solver} (${row.state})`,
        `Workspace: ${row.workspace}`,
        submission
          ? [
              `Summary: ${submission.summary}`,
              `Approach: ${submission.approach}`,
              `Tests: ${submission.tests}`,
              `Confidence: ${submission.confidence}`,
              `Caveats: ${submission.caveats || "none"}`,
            ].join("\n")
          : "No submission.",
        row.verify
          ? `Verify \`${row.verify.command}\`: ${verifyLabel(row.verify)} in ${Math.round(row.verify.durationMs / 100) / 10}s\n${row.verify.output.slice(-1_500).trim()}`
          : "Verify: not run",
        `Files: ${row.diff.files.map((file) => `${file.path} (+${file.added}/-${file.removed})`).join(", ") || "none"}`,
        diff ? `\`\`\`diff\n${diff}\n\`\`\`` : "No changes.",
      ].join("\n");
    })
    .join("\n\n");
}

// Merges

/**
 * A merge's workspace: a worktree of a source solution's repository at
 * that solution's base, so every source's patch applies to it, with
 * dependencies linked like the solvers'.
 */
export function prepareMergeWorkspace(
  collabRoot: string,
  competition: Competition,
  name: string,
  source: SolverEntry,
): Pick<SolverEntry, "name" | "workspace" | "cwd" | "base"> {
  const workspace = path.join(
    competitionDir(collabRoot, competition.id),
    "ws",
    name,
  );
  if (fs.existsSync(workspace))
    throw new Error(`The workspace of ${name} exists already`);
  git(source.workspace, [
    "worktree",
    "add",
    "--detach",
    "-q",
    workspace,
    source.base,
  ]);
  const relative = path.relative(source.workspace, source.cwd);
  linkDependencies(competition.root, workspace);
  if (relative)
    linkDependencies(competition.cwd, path.join(workspace, relative));
  return {
    name,
    workspace,
    cwd: relative ? path.join(workspace, relative) : workspace,
    base: source.base,
  };
}

/** Each source's patch, written for the merge to read or `git apply`. */
export function writeSourcePatches(
  collabRoot: string,
  competition: Competition,
  merge: string,
  sources: readonly SolverEntry[],
): Record<string, string> {
  const dir = path.join(
    competitionDir(collabRoot, competition.id),
    "merges",
    merge,
  );
  fs.mkdirSync(dir, { recursive: true });
  return Object.fromEntries(
    sources.map((source) => {
      const file = path.join(dir, `${source.name}.patch`);
      fs.writeFileSync(file, collectDiff(source).patch);
      return [source.name, file];
    }),
  );
}

export function mergeJob(
  competition: Competition,
  entry: SolverEntry,
  sources: ReadonlyArray<{
    entry: SolverEntry;
    patch: string;
    submission?: Submission;
  }>,
  verdict?: Verdict,
): string {
  return [
    `You merge solutions in competition ${competition.id}: ${sources.length} solvers solved the task below independently. Combine the best parts of their solutions into one that is better than each.`,
    "",
    "Task:",
    competition.task,
    "",
    "Solutions:",
    ...sources.map(({ entry: source, patch, submission }) =>
      [
        `- ${source.name}: workspace ${source.cwd}; patch ${patch}`,
        ...(submission
          ? [
              `  Summary: ${submission.summary}`,
              `  Approach: ${submission.approach}`,
              `  Caveats: ${submission.caveats || "none"}`,
              ...(submission.verify
                ? [`  Verify: ${verifyLabel(submission.verify)}`]
                : []),
            ]
          : ["  (no submission)"]),
      ].join("\n"),
    ),
    ...(verdict
      ? [
          "",
          `The judge ranked ${verdict.ranking.join(" > ")}: ${verdict.rationale}`,
          ...(verdict.merge ? [`Its merge proposal: ${verdict.merge}`] : []),
        ]
      : []),
    ...(entry.merge?.guidance ? ["", `Guidance: ${entry.merge.guidance}`] : []),
    "",
    `Your workspace is ${entry.cwd}, a private copy of the project at the same starting point as every solution, so each patch applies there (\`git apply <patch>\`). Read the solutions' workspaces and patches as you need, but change files only in your workspace.`,
    competition.verify
      ? `The verify command \`${competition.verify}\` checks solutions; compete_submit runs it in your workspace.`
      : "There is no verify command: run whatever tests fit the task.",
    "When the merged solution is ready, run its tests, then call compete_submit with your summary (name what you took from which solution), approach, tests and their results, confidence (0 to 1), and caveats. If verify fails, fix it and submit again. Then answer with a short summary. Nothing reaches the main workspace unless the user applies your solution.",
  ].join("\n");
}

// Apply and discard

/** Apply a solver's diff to the main workspace: cleanly, or with a
 * three-way merge in a repository, which may leave conflicts. */
export function applySolution(
  collabRoot: string,
  competition: Competition,
  solver: string,
): { ok: boolean; output: string; files: DiffFile[] } {
  const entry = competition.solvers.find((each) => each.name === solver);
  if (!entry)
    throw new Error(
      `No solver ${solver} in ${competition.id}; solvers: ${competition.solvers.map((each) => each.name).join(", ")}`,
    );
  const diff = collectDiff(entry);
  if (!diff.patch.trim())
    return { ok: false, output: `${solver} changed nothing.`, files: [] };
  const file = path.join(
    competitionDir(collabRoot, competition.id),
    "patches",
    `${solver}.patch`,
  );
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, diff.patch);
  const where = competition.root;
  try {
    git(where, ["apply", "--check", "--binary", file]);
    git(where, ["apply", "--binary", file]);
    return {
      ok: true,
      output: `Applied ${solver}'s change to ${where}: ${diff.files.map((each) => each.path).join(", ")}.`,
      files: diff.files,
    };
  } catch (error) {
    if (!competition.git)
      return {
        ok: false,
        output: `${solver}'s change doesn't apply cleanly to ${where}; nothing changed:\n${errorOutput(error)}\nThe patch is at ${file}.`,
        files: diff.files,
      };
  }
  try {
    const output = git(where, ["apply", "--3way", "--binary", file]);
    return {
      ok: true,
      output:
        `Applied ${solver}'s change to ${where} with a three-way merge (the files are staged).\n${output}`.trim(),
      files: diff.files,
    };
  } catch (error) {
    return {
      ok: false,
      output: `${solver}'s change conflicts with ${where}; resolve the conflict markers git left, or revert them:\n${errorOutput(error)}\nThe patch is at ${file}.`,
      files: diff.files,
    };
  }
}

/** Remove the solvers' workspaces; submissions, verdicts, and patches
 * stay. */
export function discardWorkspaces(competition: Competition): string[] {
  const removed: string[] = [];
  for (const entry of competition.solvers) {
    if (!fs.existsSync(entry.workspace)) continue;
    if (competition.git)
      try {
        git(competition.root, [
          "worktree",
          "remove",
          "--force",
          entry.workspace,
        ]);
      } catch {}
    fs.rmSync(entry.workspace, { recursive: true, force: true });
    removed.push(entry.name);
  }
  if (competition.git)
    try {
      git(competition.root, ["worktree", "prune"]);
    } catch {}
  return removed;
}

// Jobs

export function solverJob(
  competition: Competition,
  entry: SolverEntry,
): string {
  const others = competition.solvers.length - 1;
  return [
    `You are solver "${entry.name}" in competition ${competition.id}: you and ${others} other solver${others === 1 ? "" : "s"} solve the same task independently${competition.judge ? ", then a judge compares the solutions" : ""}. You can't see or message the other solvers, and they can't see you.`,
    "",
    "Task:",
    competition.task,
    "",
    `Your workspace is ${entry.cwd}, a private copy of the project. Work only there: don't read or change files outside it.`,
    ...(entry.hint ? [`Strategy: ${entry.hint}`] : []),
    competition.verify
      ? `The verify command \`${competition.verify}\` checks solutions; compete_submit runs it in your workspace.`
      : "There is no verify command: run whatever tests fit the task.",
    "When your solution is ready, run its tests, then call compete_submit with your summary, approach, tests and their results, confidence (0 to 1), and caveats. It returns your diff's files and the verify result; if verify fails, fix it and submit again (the last submission counts). Then answer with a short summary of your solution.",
  ].join("\n");
}

/** The job of a bracket's judge: rank its solvers, so the best reach the
 * final. */
export function bracketJudgeJob(
  competition: Competition,
  bracket: number,
): string {
  const solvers = competition.brackets?.[bracket]?.solvers ?? [];
  return [
    `You judge bracket ${bracket + 1} of ${competition.brackets?.length ?? 1} in competition ${competition.id}: ${solvers.length} solvers (${solvers.join(", ")}) solved the task below independently, each in its own workspace. Your top ${FINALISTS_PER_BRACKET} go on to the final judge.`,
    "",
    "Task:",
    competition.task,
    "",
    "Call compete_compare to see your bracket's submissions, diffs, and verify results. Rank them by: verify passes; correctness and completeness for the task; simplicity and size of the change; risk in their caveats. Read files in their workspaces when the diff isn't enough, but change nothing.",
    "Then call compete_verdict with your bracket's winner, its full ranking, and your rationale. Finally answer with the ranking in a line.",
  ].join("\n");
}

export function judgeJob(competition: Competition): string {
  const brackets = competition.brackets?.length ?? 0;
  return [
    brackets > 0
      ? `You are the final judge of competition ${competition.id}: ${competition.solvers.length} solvers solved the task below independently, each in its own workspace; ${brackets} bracket judges ranked them in groups, and compete_compare shows you each bracket's top ${FINALISTS_PER_BRACKET}.`
      : `You judge competition ${competition.id}: ${competition.solvers.length} solvers (${competition.solvers.map((each) => each.name).join(", ")}) solved the task below independently, each in its own workspace.`,
    "",
    "Task:",
    competition.task,
    "",
    "Call compete_compare to see their submissions, diffs, and verify results. Rank them by: verify passes; correctness and completeness for the task; simplicity and size of the change; risk in their caveats. Read files in their workspaces when the diff isn't enough, but change nothing.",
    "Then call compete_verdict with the winner, the full ranking, your rationale, and, when parts of several solutions should be combined, a merge proposal. Finally answer with the winner and why in a few lines. You don't apply anything: the user applies the winner.",
  ].join("\n");
}
