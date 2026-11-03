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
 *   competitions/<id>/results/<solver>.json   historical verify result
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
export const COMPETITION_ID = /^c[1-9]\d{0,8}$/;
export const SOLVER_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export function assertCompetitionId(id: string): void {
  if (typeof id !== "string" || !COMPETITION_ID.test(id))
    throw new Error(`Invalid competition ID: ${id}`);
}

function assertSolverName(name: string): void {
  if (typeof name !== "string" || !SOLVER_NAME.test(name))
    throw new Error(`Invalid solver name: ${name}`);
}

function contained(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
}

/** Resolve missing descendants through their nearest existing ancestor.
 * A dangling symlink is not an absent directory: realpath must reject it. */
function prospectiveRealpath(file: string): string {
  try {
    fs.lstatSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return path.join(
      prospectiveRealpath(path.dirname(file)),
      path.basename(file),
    );
  }
  return fs.realpathSync(file);
}

function safeEntry(
  collabRoot: string,
  competition: Competition,
  entry: SolverEntry,
): "safe" | "missing" | "unsafe" {
  try {
    assertCompetitionId(competition.id);
    assertSolverName(entry.name);
    if (!/^[0-9a-f]{40,64}$/.test(entry.base)) return "unsafe";
    const dir = competitionDir(collabRoot, competition.id);
    const workspace = path.join(dir, "ws", entry.name);
    if (
      path.resolve(entry.workspace) !== workspace ||
      !contained(workspace, path.resolve(entry.cwd))
    )
      return "unsafe";
    // Missing directories are allowed, but all existing ancestors must still
    // resolve to their expected location inside the trusted competition root.
    const trusted = fs.realpathSync(collabRoot);
    const canonicalDir = prospectiveRealpath(dir);
    if (canonicalDir !== path.join(trusted, "competitions", competition.id))
      return "unsafe";
    const canonicalWorkspace = prospectiveRealpath(workspace);
    if (canonicalWorkspace !== path.join(canonicalDir, "ws", entry.name))
      return "unsafe";
    if (!contained(canonicalWorkspace, prospectiveRealpath(entry.cwd)))
      return "unsafe";
    return fs.existsSync(workspace) && fs.existsSync(entry.cwd)
      ? "safe"
      : "missing";
  } catch {
    return "unsafe";
  }
}
/** Solvers in a competition: `max` is the default of the
 * `piAgents.maxSolvers` setting. */
export const SOLVER_COUNT = { min: 2, max: 6 } as const;
export const VERIFY_TIMEOUT_MS = 5 * 60_000;
export const MAX_VERIFY_TIMEOUT_MS = 60 * 60_000;

function assertVerifyTimeout(timeoutMs: number): void {
  if (
    !Number.isFinite(timeoutMs) ||
    timeoutMs <= 0 ||
    timeoutMs > MAX_VERIFY_TIMEOUT_MS
  )
    throw new Error(
      "Invalid verification timeout (must be > 0 and <= 60 minutes)",
    );
}
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
  skipped?: "unapproved";
  /** Historical disk data, not an authoritative verification result. */
  recorded?: boolean;
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
  assertCompetitionId(id);
  const root = competitionsRoot(collabRoot);
  const dir = path.resolve(root, id);
  for (const candidate of [root, dir]) {
    try {
      if (fs.lstatSync(candidate).isSymbolicLink())
        throw new Error(`Unsafe competition directory: ${candidate}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return dir;
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

export interface CompetitionState {
  competition: Competition;
  unsafe: string[];
}

/** Inspection retains unsafe entries for status, expiry and contained cleanup. */
export function inspectCompetition(
  collabRoot: string,
  id: string,
): CompetitionState | undefined {
  const record = readJson<Competition>(
    path.join(competitionDir(collabRoot, id), "competition.json"),
  );
  if (!record || record.protocol !== COMPETITION_PROTOCOL) return undefined;
  if (
    record.id !== id ||
    typeof record.task !== "string" ||
    !Number.isFinite(record.createdAt) ||
    !Number.isFinite(record.deadline) ||
    typeof record.git !== "boolean" ||
    (record.verify !== undefined && typeof record.verify !== "string") ||
    !["given", "detected", "none"].includes(record.verifySource) ||
    !Number.isFinite(record.verifyTimeoutMs) ||
    record.verifyTimeoutMs <= 0 ||
    record.verifyTimeoutMs > MAX_VERIFY_TIMEOUT_MS ||
    !["running", "applied", "discarded"].includes(record.status) ||
    !Array.isArray(record.solvers) ||
    !record.solvers.every(
      (entry) =>
        entry &&
        typeof entry.name === "string" &&
        typeof entry.workspace === "string" &&
        typeof entry.cwd === "string" &&
        typeof entry.base === "string",
    ) ||
    typeof record.cwd !== "string" ||
    !path.isAbsolute(record.cwd) ||
    typeof record.root !== "string" ||
    !path.isAbsolute(record.root)
  )
    throw new Error(`Invalid competition record: ${id}`);
  const counts = solverCounts(record);
  const unsafe = record.solvers
    .filter(
      (entry) =>
        counts.get(entry.name) !== 1 ||
        safeEntry(collabRoot, record, entry) === "unsafe",
    )
    .map((entry) => entry.name);
  return { competition: record, unsafe };
}

function solverCounts(competition: Competition): Map<string, number> {
  const counts = new Map<string, number>();
  for (const entry of competition.solvers)
    counts.set(entry.name, (counts.get(entry.name) ?? 0) + 1);
  return counts;
}

/** Privileged callers still require every workspace to be safe. */
export function readCompetition(
  collabRoot: string,
  id: string,
): Competition | undefined {
  const state = inspectCompetition(collabRoot, id);
  if (state?.unsafe.length)
    throw new Error(`Unsafe workspace in competition record: ${id}`);
  return state?.competition;
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
  options: { allowUnsafe?: boolean } = {},
): Competition {
  const current = options.allowUnsafe
    ? inspectCompetition(collabRoot, id)?.competition
    : readCompetition(collabRoot, id);
  if (!current) throw new Error(`No competition ${id}`);
  const next = change(current);
  if (next.id !== id) throw new Error("Competition ID cannot change");
  writeCompetition(collabRoot, next);
  return next;
}

/** Every competition, newest first. */
export function listCompetitions(collabRoot: string): Competition[] {
  return listCompetitionStates(collabRoot)
    .filter((state) => state.unsafe.length === 0)
    .map((state) => state.competition);
}

export function listCompetitionStates(collabRoot: string): CompetitionState[] {
  let names: string[] = [];
  try {
    names = fs.readdirSync(competitionsRoot(collabRoot));
  } catch {
    return [];
  }
  return names
    .flatMap((name) => {
      if (!COMPETITION_ID.test(name)) return [];
      try {
        const record = inspectCompetition(collabRoot, name);
        return record ? [record] : [];
      } catch {
        return [];
      }
    })
    .sort(
      (left, right) => right.competition.createdAt - left.competition.createdAt,
    );
}

export function readSubmission(
  collabRoot: string,
  id: string,
  solver: string,
): Submission | undefined {
  assertSolverName(solver);
  return readJson<Submission>(
    path.join(competitionDir(collabRoot, id), "submissions", `${solver}.json`),
  );
}

export function writeSubmission(
  collabRoot: string,
  id: string,
  submission: Submission,
): void {
  assertSolverName(submission.solver);
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

function git(
  cwd: string,
  args: string[],
  input?: string,
  isolated = false,
): string {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
  );
  return execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
    cwd,
    env: {
      ...env,
      ...(isolated ? { GIT_CEILING_DIRECTORIES: path.dirname(cwd) } : {}),
    },
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

const DIFF_FLAGS = [
  "--no-ext-diff",
  "--no-textconv",
  "--no-color",
  "--no-renames",
  "--src-prefix=a/",
  "--dst-prefix=b/",
];

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
      ? fs.realpathSync(top)
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

export interface VerifyApproval {
  readonly command: string;
  readonly timeoutMs: number;
}

export interface CompetitionSeal {
  readonly cwd: string;
  readonly root: string;
  readonly git: boolean;
  readonly verify?: VerifyApproval;
  readonly verifyTimeoutMs: number;
}

type ProjectBinding = Pick<CompetitionSeal, "cwd" | "root" | "git">;
// Process-local integrity only: records/worktrees remain writable by the user
// and their commands. Nothing persisted on disk can grant verification approval.
const seals = new Map<string, CompetitionSeal>();
const verified = new WeakMap<
  CompetitionSeal,
  Map<string, { key: string; result: Readonly<VerifyResult> }>
>();
const prepared = new Map<string, ProjectBinding>();

function bindingKey(collabRoot: string, id: string): string {
  assertCompetitionId(id);
  return `${fs.realpathSync(collabRoot)}\0${id}`;
}

export function competitionSeal(
  collabRoot: string,
  id: string,
): CompetitionSeal | undefined {
  return seals.get(bindingKey(collabRoot, id));
}

export function unsealCompetition(collabRoot: string, id: string): void {
  const key = bindingKey(collabRoot, id);
  const seal = seals.get(key);
  if (seal) verified.delete(seal);
  seals.delete(key);
  prepared.delete(key);
}

function assertProjectFields(
  competition: Competition,
  binding: ProjectBinding,
): void {
  if (
    competition.cwd !== binding.cwd ||
    competition.root !== binding.root ||
    competition.git !== binding.git
  )
    throw new Error(
      `Competition ${competition.id} changed on disk since it was bound to its project`,
    );
  if (
    fs.realpathSync(competition.root) !== competition.root ||
    fs.realpathSync(competition.cwd) !== competition.cwd
  )
    throw new Error(`Competition ${competition.id} project path changed`);
}

/** Validate the source before inspecting commands or copying any files. Git
 * subdirectories may use their repository root, but never an external root. */
export function assertProjectCwd(cwd: string, project: string): void {
  const canonicalProject = fs.realpathSync(project);
  const root = repositoryOf(canonicalProject) ?? canonicalProject;
  const canonicalCwd = fs.realpathSync(cwd);
  if (!contained(root, canonicalCwd))
    throw new Error("Competition cwd is outside the session project");
  const sourceRoot = repositoryOf(canonicalCwd) ?? canonicalCwd;
  if (!contained(root, sourceRoot))
    throw new Error("Competition root is outside the session project");
}

/** Bind restored records only within the caller's independently known project.
 * Missing project context fails closed; never discover Git in an arbitrary root. */
export function assertBound(
  collabRoot: string,
  competition: Competition,
  project?: string,
): "sealed" | "anchored" {
  assertVerifyTimeout(competition.verifyTimeoutMs);
  if (project) {
    assertProjectCwd(competition.cwd, project);
    assertProjectCwd(competition.root, project);
  }
  const key = bindingKey(collabRoot, competition.id);
  const seal = seals.get(key);
  if (seal) {
    assertProjectFields(competition, seal);
    if (
      competition.verify !== seal.verify?.command ||
      competition.verifyTimeoutMs !== seal.verifyTimeoutMs
    )
      throw new Error(
        `Competition ${competition.id} changed on disk since verification was approved`,
      );
    return "sealed";
  }
  const binding = prepared.get(key);
  if (binding) {
    assertProjectFields(competition, binding);
    return "anchored";
  }
  if (!project)
    throw new Error(
      `Competition ${competition.id} is not bound to this session project`,
    );
  const cwd = fs.realpathSync(project);
  const root = repositoryOf(cwd) ?? cwd;
  if (
    !contained(root, competition.root) ||
    !contained(root, competition.cwd) ||
    !contained(root, fs.realpathSync(competition.root)) ||
    !contained(root, fs.realpathSync(competition.cwd))
  )
    throw new Error(
      `Competition ${competition.id} is outside the session project`,
    );
  const top = repositoryOf(competition.cwd);
  assertProjectFields(competition, {
    cwd: fs.realpathSync(competition.cwd),
    root: top ?? competition.cwd,
    git: top !== undefined,
  });
  const relative = path.relative(competition.root, competition.cwd);
  if (
    competition.solvers.some(
      (entry) => path.relative(entry.workspace, entry.cwd) !== relative,
    )
  )
    throw new Error(
      `Competition ${competition.id} workspace project path changed`,
    );
  return "anchored";
}

/** Only call with the trusted start object, or after fresh UI approval below. */
export function sealCompetition(
  collabRoot: string,
  competition: Competition,
): void {
  assertBound(collabRoot, competition, competition.cwd);
  const key = bindingKey(collabRoot, competition.id);
  if (seals.has(key)) return;
  seals.set(
    key,
    Object.freeze({
      cwd: competition.cwd,
      root: competition.root,
      git: competition.git,
      verifyTimeoutMs: competition.verifyTimeoutMs,
      ...(competition.verify
        ? {
            verify: Object.freeze({
              command: competition.verify,
              timeoutMs: competition.verifyTimeoutMs,
            }),
          }
        : {}),
    }),
  );
}

/** Capture before presenting the approval UI; execute only these exact values. */
export function verificationSnapshot(
  collabRoot: string,
  competition: Competition,
): VerifyApproval | undefined {
  assertVerifyTimeout(competition.verifyTimeoutMs);
  if (competitionSeal(collabRoot, competition.id))
    assertBound(collabRoot, competition);
  return competition.verify
    ? Object.freeze({
        command: competition.verify,
        timeoutMs: competition.verifyTimeoutMs,
      })
    : undefined;
}

export function approveCompetitionVerification(
  collabRoot: string,
  competition: Competition,
  approval: VerifyApproval | undefined,
  project?: string,
): void {
  if (
    competition.verify !== approval?.command ||
    (approval && competition.verifyTimeoutMs !== approval.timeoutMs)
  )
    throw new Error(
      `Competition ${competition.id} verification changed after approval`,
    );
  assertBound(collabRoot, competition, project);
  sealCompetition(collabRoot, competition);
}

export interface Workspaces {
  cwd: string;
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
  project?: string;
  solvers: readonly string[];
}): Workspaces {
  if (options.project) assertProjectCwd(options.cwd, options.project);
  assertCompetitionId(options.id);
  for (const name of options.solvers) assertSolverName(name);
  if (new Set(options.solvers).size !== options.solvers.length)
    throw new Error("Duplicate solver names");
  const cwd = fs.realpathSync(options.cwd);
  const top = repositoryOf(cwd);
  const root = top ?? cwd;
  const relative = path.relative(root, cwd);
  const base = path.join(competitionDir(options.collabRoot, options.id), "ws");
  fs.mkdirSync(base, { recursive: true });
  if (
    fs.realpathSync(base) !==
    path.join(
      fs.realpathSync(options.collabRoot),
      "competitions",
      options.id,
      "ws",
    )
  )
    throw new Error("Unsafe workspace directory");
  // What the main workspace adds to HEAD, read once for every solver.
  const dirty = top
    ? git(top, ["diff", ...DIFF_FLAGS, "HEAD", "--binary"])
    : "";
  const untracked = top
    ? git(top, ["ls-files", "--others", "--exclude-standard", "-z"])
        .split("\0")
        .filter(
          (file) => file && !file.split("/").some((part) => SKIPPED.has(part)),
        )
    : [];
  const created: string[] = [];
  let entries: Workspaces["entries"];
  try {
    entries = options.solvers.map((name) => {
      const workspace = path.join(base, name);
      if (fs.existsSync(workspace))
        throw new Error(`Workspace already exists: ${workspace}`);
      created.push(workspace);
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
      // Preserve the caller's spelling for dependency links when it names the
      // root; workspace identities and working directories remain canonical.
      linkDependencies(relative ? root : path.resolve(options.cwd), workspace);
      if (relative) {
        fs.mkdirSync(path.join(workspace, relative), { recursive: true });
        linkDependencies(cwd, path.join(workspace, relative));
      }
      return {
        name,
        workspace,
        cwd: relative ? path.join(workspace, relative) : workspace,
        base: commit,
      };
    });
  } catch (error) {
    for (const workspace of created.reverse()) {
      if (top) gitOk(top, ["worktree", "remove", "--force", workspace]);
      fs.rmSync(workspace, { recursive: true, force: true });
    }
    if (top) gitOk(top, ["worktree", "prune"]);
    throw error;
  }
  const binding = { cwd, git: top !== undefined, root };
  prepared.set(
    bindingKey(options.collabRoot, options.id),
    Object.freeze(binding),
  );
  return { ...binding, entries };
}

/** The solution: the workspace against its base, new files included. */
export function collectDiff(
  entry: Pick<SolverEntry, "workspace" | "base">,
): Diff {
  if (!fs.existsSync(entry.workspace))
    return { patch: "", files: [], hash: "missing" };
  if (!/^[0-9a-f]{40,64}$/.test(entry.base))
    throw new Error("Invalid workspace base commit");
  git(entry.workspace, ["add", "-A", ...PATHSPEC]);
  const patch = git(entry.workspace, [
    "diff",
    "--cached",
    ...DIFF_FLAGS,
    "--binary",
    entry.base,
    ...PATHSPEC,
  ]);
  const files = git(entry.workspace, [
    "diff",
    "--cached",
    ...DIFF_FLAGS,
    "--numstat",
    "-z",
    entry.base,
    ...PATHSPEC,
  ])
    .split("\0")
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

  async run<T>(body: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (this.running >= this.size)
      await new Promise<void>((resolve, reject) => {
        const ready = () => {
          signal?.removeEventListener("abort", abort);
          resolve();
        };
        const abort = () => {
          const index = this.waiting.indexOf(ready);
          if (index >= 0) this.waiting.splice(index, 1);
          reject(new Error("Verify aborted while waiting"));
        };
        if (signal?.aborted) return abort();
        this.waiting.push(ready);
        signal?.addEventListener("abort", abort, { once: true });
      });
    this.running += 1;
    try {
      return await body();
    } finally {
      this.running -= 1;
      if (this.running < this.size) this.waiting.shift()?.();
    }
  }
}

export type VerifyEnvMode = "scrub" | "minimal" | "inherit";
let verifyEnvMode: VerifyEnvMode = "scrub";
let verifyEnvPassthrough: readonly string[] = [];

export function configureVerifyEnv(
  mode: VerifyEnvMode,
  passthrough: readonly string[] = [],
): void {
  if (!["scrub", "minimal", "inherit"].includes(mode))
    throw new Error("Invalid verify environment mode");
  verifyEnvMode = mode;
  verifyEnvPassthrough = [...passthrough];
}

/** Environment filtering is not isolation: commands still have HOME, files,
 * shared dependencies and the user's filesystem permissions. */
export function verifyEnvironment(
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    const allowed =
      verifyEnvMode === "inherit" ||
      (verifyEnvMode === "minimal"
        ? /^(PATH|HOME|USER|LOGNAME|SHELL|TMPDIR|TMP|TEMP|LANG|LC_.*|SYSTEMROOT|WINDIR)$/i.test(
            key,
          )
        : !/(TOKEN|SECRET|PASSWORD|PASSWD|KEY|CREDENTIAL|AUTH|COOKIE|CONNECTION_?STRING)/i.test(
            key,
          ) &&
          !/^(DATABASE_URL|SENTRY_DSN|REDIS_URL|GIT_.*|BASH_ENV|ENV|SHELLOPTS|BASHOPTS|NODE_OPTIONS|LD_.*|DYLD_.*)$/i.test(
            key,
          ));
    if (allowed || verifyEnvPassthrough.includes(key)) env[key] = value;
  }
  return { ...env, CI: "1", FORCE_COLOR: "0" };
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
  assertVerifyTimeout(options.timeoutMs ?? VERIFY_TIMEOUT_MS);
  // Capture before a pool wait: callers cannot swap command settings while queued.
  const snapshot = { ...options };
  return verifyPool
    .run(() => spawnVerify(command, cwd, snapshot), snapshot.signal)
    .catch((error) => {
      if (!options.signal?.aborted) throw error;
      return {
        command,
        hash: options.hash ?? "",
        exitCode: null,
        timedOut: false,
        durationMs: 0,
        output: "aborted before it ran",
      };
    });
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
      env: verifyEnvironment(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    const collect = (chunk: Buffer) => {
      output = (output + chunk.toString("utf8")).slice(-OUTPUT_TAIL * 2);
    };
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);
    let settled = false;
    let grace: ReturnType<typeof setTimeout> | undefined;
    const kill = () => {
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {}
      // Detached descendants can keep pipes open after the shell exits.
      grace ??= setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
        finish(null);
      }, 1000);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, options.timeoutMs ?? VERIFY_TIMEOUT_MS);
    const abort = () => kill();
    options.signal?.addEventListener("abort", abort, { once: true });
    const finish = (exitCode: number | null, extra = "") => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(grace);
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

function verificationKey(
  competition: Competition,
  entry: SolverEntry,
  diff: Diff,
): string {
  return JSON.stringify([
    competition.cwd,
    competition.root,
    competition.git,
    entry.base,
    entry.cwd,
    diff.hash,
    competition.verify,
    competition.verifyTimeoutMs,
  ]);
}

/** Always run approved verification: ignored files and shared dependencies can
 * change without changing the diff. Retain the last process-local result only
 * for display/ranking when verification is explicitly disabled. */
export async function verifySolver(
  collabRoot: string,
  competition: Competition,
  entry: SolverEntry,
  diff: Diff,
  signal?: AbortSignal,
  approval?: VerifyApproval,
): Promise<VerifyResult | undefined> {
  const state = safeEntry(collabRoot, competition, entry);
  if (state === "unsafe") throw new Error(`Unsafe workspace for ${entry.name}`);
  if (state === "missing" || !competition.verify) return undefined;
  assertVerifyTimeout(competition.verifyTimeoutMs);
  const seal = competitionSeal(collabRoot, competition.id);
  if (seal) assertBound(collabRoot, competition);
  const approved = approval ?? seal?.verify;
  if (!approved)
    return {
      command: competition.verify,
      hash: diff.hash,
      exitCode: null,
      timedOut: false,
      durationMs: 0,
      output: "not run: verification is not approved in this session process",
      skipped: "unapproved",
    };
  if (
    approved.command !== competition.verify ||
    approved.timeoutMs !== competition.verifyTimeoutMs
  )
    throw new Error(
      `Competition ${competition.id} verification changed after approval`,
    );
  // A caller's approval alone is not a project binding. Restored records must
  // pass approveCompetitionVerification with independent project context first.
  assertBound(collabRoot, competition);
  const command = approved.command;
  const timeoutMs = approved.timeoutMs;
  const cwd = entry.cwd;
  const file = path.join(
    competitionDir(collabRoot, competition.id),
    "results",
    `${entry.name}.json`,
  );
  const cacheKey = verificationKey(competition, entry, diff);
  const name = entry.name;
  const result = await runVerify(command, cwd, {
    timeoutMs,
    hash: diff.hash,
    ...(signal ? { signal } : {}),
  });
  if (!signal?.aborted) {
    if (seal && competitionSeal(collabRoot, competition.id) === seal) {
      let cache = verified.get(seal);
      if (!cache) {
        cache = new Map();
        verified.set(seal, cache);
      }
      cache.set(name, { key: cacheKey, result: Object.freeze({ ...result }) });
    }
    writeJsonAtomic(file, result);
  }
  return result;
}

export function verifyLabel(result: VerifyResult | undefined): string {
  if (!result) return "—";
  const label = result.skipped
    ? result.skipped
    : result.timedOut
      ? "timeout"
      : result.exitCode === 0
        ? "pass"
        : `fail (${result.exitCode})`;
  return result.recorded ? `${label} (recorded)` : label;
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
  options: {
    verify?: boolean;
    signal?: AbortSignal;
    solvers?: string[];
    approval?: VerifyApproval;
  } = {},
): Promise<Comparison> {
  const entries = options.solvers
    ? competition.solvers.filter((entry) =>
        options.solvers?.includes(entry.name),
      )
    : competition.solvers;
  // Verifies run side by side, as many as the pool allows.
  const rows = await Promise.all(
    entries.map(async (entry): Promise<ComparisonRow> => {
      if (safeEntry(collabRoot, competition, entry) === "unsafe")
        throw new Error(`Unsafe workspace for ${entry.name}`);
      const diff = collectDiff(entry);
      const submission = readSubmission(collabRoot, competition.id, entry.name);
      const seal = competitionSeal(collabRoot, competition.id);
      const last = seal && verified.get(seal)?.get(entry.name);
      const verify =
        options.verify === false
          ? last?.key === verificationKey(competition, entry, diff)
            ? { ...last.result }
            : submission?.hash === diff.hash && submission.verify
              ? { ...submission.verify, recorded: true }
              : undefined
          : await verifySolver(
              collabRoot,
              competition,
              entry,
              diff,
              options.signal,
              options.approval,
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
      ? row.verify.exitCode === 0 &&
        !row.verify.timedOut &&
        !row.verify.skipped &&
        !row.verify.recorded
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
  options: { project?: string } = {},
): Pick<SolverEntry, "name" | "workspace" | "cwd" | "base"> {
  assertBound(collabRoot, competition, options.project);
  assertSolverName(name);
  if (safeEntry(collabRoot, competition, source) !== "safe")
    throw new Error(`Unsafe workspace for ${source.name}`);
  const workspace = path.join(
    competitionDir(collabRoot, competition.id),
    "ws",
    name,
  );
  if (fs.existsSync(workspace))
    throw new Error(`The workspace of ${name} exists already`);
  const relative = path.relative(source.workspace, source.cwd);
  const entry = {
    name,
    workspace,
    cwd: relative ? path.join(workspace, relative) : workspace,
    base: source.base,
  };
  if (safeEntry(collabRoot, competition, entry) === "unsafe")
    throw new Error(`Unsafe workspace for ${name}`);
  try {
    git(source.workspace, [
      "worktree",
      "add",
      "--detach",
      "-q",
      workspace,
      source.base,
    ]);
    linkDependencies(competition.root, workspace);
    if (relative)
      linkDependencies(competition.cwd, path.join(workspace, relative));
    return entry;
  } catch (error) {
    if (safeEntry(collabRoot, competition, entry) !== "unsafe") {
      if (safeEntry(collabRoot, competition, source) === "safe")
        gitOk(source.workspace, ["worktree", "remove", "--force", workspace]);
      if (safeEntry(collabRoot, competition, entry) !== "unsafe")
        fs.rmSync(workspace, { recursive: true, force: true });
    }
    if (safeEntry(collabRoot, competition, source) === "safe")
      gitOk(source.workspace, ["worktree", "prune"]);
    throw error;
  }
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
                ? [
                    `  Verify: ${verifyLabel({ ...submission.verify, recorded: true })}`,
                  ]
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

function gitReverseCheck(
  cwd: string,
  file: string,
  isolated: boolean,
): boolean {
  try {
    git(
      cwd,
      [
        "apply",
        "--reverse",
        "--check",
        "--binary",
        "--whitespace=nowarn",
        file,
      ],
      undefined,
      isolated,
    );
    return true;
  } catch {
    return false;
  }
}

/** Apply a solver's diff to the main workspace: cleanly, or with a
 * three-way merge in a repository, which may leave conflicts. */
export function applySolution(
  collabRoot: string,
  competition: Competition,
  solver: string,
  options: { project?: string } = {},
): { ok: boolean; output: string; files: DiffFile[] } {
  let bindingError: unknown;
  try {
    assertBound(collabRoot, competition, options.project);
  } catch (error) {
    if (competitionSeal(collabRoot, competition.id)) throw error;
    bindingError = error;
  }
  assertSolverName(solver);
  const entry = competition.solvers.find((each) => each.name === solver);
  if (!entry)
    throw new Error(
      `No solver ${solver} in ${competition.id}; solvers: ${competition.solvers.map((each) => each.name).join(", ")}`,
    );
  if (safeEntry(collabRoot, competition, entry) === "unsafe")
    throw new Error(`Unsafe workspace for ${solver}`);
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
  if (bindingError)
    throw new Error(
      `${errorOutput(bindingError)}. Nothing applied; the patch is at ${file}.`,
    );
  const where = competition.root;
  try {
    git(
      where,
      ["apply", "--check", "--binary", "--whitespace=nowarn", file],
      undefined,
      !competition.git,
    );
    git(
      where,
      ["apply", "--binary", "--whitespace=nowarn", file],
      undefined,
      !competition.git,
    );
    if (!gitReverseCheck(where, file, !competition.git))
      return {
        ok: false,
        output: `Apply did not produce the expected change. The patch is at ${file}.`,
        files: diff.files,
      };
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
    const output = git(where, [
      "apply",
      "--3way",
      "--binary",
      "--whitespace=nowarn",
      file,
    ]);
    // A three-way merge may legitimately differ from the literal patch.
    // Preserve Git's success/conflict semantics rather than reverse-check it.
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
export function discardWorkspaces(
  collabRoot: string,
  competition: Competition,
  options?: { project?: string },
): { removed: string[]; refused: string[] };
/** Legacy callers cannot supply a trusted root: fail closed without deleting. */
export function discardWorkspaces(competition: Competition): string[];
export function discardWorkspaces(
  rootOrCompetition: string | Competition,
  record?: Competition,
  options: { project?: string } = {},
): { removed: string[]; refused: string[] } | string[] {
  if (typeof rootOrCompetition !== "string") return [];
  if (!record) throw new Error("Competition required");
  const competition = record;
  const removed: string[] = [];
  const refused: string[] = [];
  let prune = false;
  let bound = false;
  try {
    // Cleanup binds only the source project. Entry safety is checked separately
    // below so one hostile cwd cannot block cleanup of the other workspaces.
    assertBound(
      rootOrCompetition,
      { ...competition, solvers: [] },
      options.project,
    );
    bound = true;
  } catch {
    // A missing or changed project must not block contained-only cleanup.
    // Never run Git cleanup in an unbound root; registrations may remain stale.
  }
  const counts = solverCounts(competition);
  for (const entry of competition.solvers) {
    if (
      counts.get(entry.name) !== 1 ||
      safeEntry(rootOrCompetition, competition, entry) === "unsafe"
    ) {
      refused.push(entry.name);
      continue;
    }
    if (!fs.existsSync(entry.workspace)) {
      prune ||= bound && competition.git;
      continue;
    }
    if (bound && competition.git)
      try {
        git(competition.root, [
          "worktree",
          "remove",
          "--force",
          entry.workspace,
        ]);
      } catch {
        prune = true;
      }
    fs.rmSync(entry.workspace, { recursive: true, force: true });
    removed.push(entry.name);
  }
  if (prune) gitOk(competition.root, ["worktree", "prune", "--expire", "now"]);
  return { removed, refused };
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
