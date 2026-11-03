import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  applySolution,
  type Competition,
  collectDiff,
  discardWorkspaces,
  prepareWorkspaces,
} from "../../src/collab/compete.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    fs.rmSync(dir, { recursive: true, force: true });
});
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" });
function fixture(commit = true) {
  const dir = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "compete-git-")),
  );
  dirs.push(dir);
  const cwd = path.join(dir, "repo");
  fs.mkdirSync(cwd);
  git(cwd, "init", "-q");
  fs.writeFileSync(path.join(cwd, "sum.js"), "old\n");
  if (commit) {
    git(cwd, "add", ".");
    git(
      cwd,
      "-c",
      "user.name=test",
      "-c",
      "user.email=test@localhost",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-qm",
      "base",
    );
  }
  return { dir, cwd, collabRoot: path.join(dir, "collab") };
}
function firstEntry(ws: ReturnType<typeof prepareWorkspaces>) {
  const entry = ws.entries[0];
  if (!entry) throw new Error("Missing fixture entry");
  return entry;
}
function record(ws: ReturnType<typeof prepareWorkspaces>): Competition {
  return {
    protocol: 1,
    id: "c1",
    task: "test",
    createdAt: 1,
    deadline: 2,
    cwd: ws.cwd,
    root: ws.root,
    git: ws.git,
    verifySource: "none",
    verifyTimeoutMs: 300,
    solvers: ws.entries,
    status: "running",
  };
}

test("diff and apply ignore hostile config/environment and preserve exact numstat paths", () => {
  const f = fixture();
  for (const [key, value] of Object.entries({
    "diff.noprefix": "true",
    "diff.mnemonicPrefix": "true",
    "color.ui": "always",
    "diff.external": "false",
    "core.quotePath": "true",
    "apply.whitespace": "error",
  }))
    git(f.cwd, "config", key, value);
  fs.writeFileSync(path.join(f.cwd, "sum.js"), "dirty\n");
  fs.writeFileSync(path.join(f.cwd, "untracked"), "base\n");
  const saved = { ...process.env };
  try {
    process.env.GIT_DIR = "/does/not/exist";
    process.env.GIT_WORK_TREE = "/does/not/exist";
    process.env.GIT_INDEX_FILE = "/does/not/exist/index";
    process.env.GIT_CONFIG_COUNT = "1";
    process.env.GIT_CONFIG_KEY_0 = "diff.noprefix";
    process.env.GIT_CONFIG_VALUE_0 = "true";
    process.env.GIT_EXTERNAL_DIFF = "false";
    const ws = prepareWorkspaces({ ...f, id: "c1", solvers: ["s1"] });
    const entry = firstEntry(ws);
    expect(fs.readFileSync(path.join(entry.cwd, "sum.js"), "utf8")).toBe(
      "dirty\n",
    );
    expect(fs.readFileSync(path.join(entry.cwd, "untracked"), "utf8")).toBe(
      "base\n",
    );
    fs.writeFileSync(path.join(entry.cwd, "ü x.js"), "new  \n");
    const diff = collectDiff(entry);
    expect(diff.patch).toContain("a/");
    expect(diff.patch).toContain("b/");
    expect(diff.files).toEqual([{ path: "ü x.js", added: 1, removed: 0 }]);
    expect(applySolution(f.collabRoot, record(ws), "s1").ok).toBe(true);
    expect(fs.readFileSync(path.join(f.cwd, "ü x.js"), "utf8")).toBe("new  \n");
  } finally {
    for (const key of Object.keys(process.env))
      if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
});

test("global excludes remain active when copying and collecting workspaces", () => {
  const f = fixture();
  const home = path.join(f.dir, "home");
  fs.mkdirSync(home);
  const excludes = path.join(home, "ignore");
  fs.writeFileSync(excludes, "secret.env\n");
  fs.writeFileSync(
    path.join(home, ".gitconfig"),
    `[core]\nexcludesFile = ${excludes}\n[diff]\nnoprefix = true\nmnemonicPrefix = true\nexternal = false\n[color]\nui = always\n`,
  );
  fs.writeFileSync(path.join(f.cwd, "secret.env"), "must not be copied\n");
  fs.writeFileSync(path.join(f.cwd, "public.txt"), "public\n");
  const saved = process.env.HOME;
  process.env.HOME = home;
  try {
    const ws = prepareWorkspaces({ ...f, id: "c1", solvers: ["s1"] });
    const entry = firstEntry(ws);
    expect(fs.existsSync(path.join(entry.workspace, "secret.env"))).toBe(false);
    expect(
      fs.readFileSync(path.join(entry.workspace, "public.txt"), "utf8"),
    ).toBe("public\n");
    fs.writeFileSync(
      path.join(entry.workspace, "secret.env"),
      "must not be staged\n",
    );
    fs.writeFileSync(path.join(entry.workspace, "public.txt"), "changed\n");
    const diff = collectDiff(entry);
    expect(diff.files.map((file) => file.path)).toEqual(["public.txt"]);
    expect(diff.patch).toContain("diff --git a/public.txt b/public.txt");
  } finally {
    if (saved === undefined) delete process.env.HOME;
    else process.env.HOME = saved;
  }
});

test("failed worktree removal falls back to deletion and prunes registration", () => {
  const f = fixture();
  const ws = prepareWorkspaces({ ...f, id: "c1", solvers: ["s1"] });
  const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  const bin = path.join(f.dir, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(
    path.join(bin, "git"),
    `#!/bin/sh\ncase " $* " in *" worktree remove "*) exit 1;; esac\nexec '${realGit}' "$@"\n`,
    { mode: 0o755 },
  );
  const saved = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${saved}`;
  try {
    expect(discardWorkspaces(f.collabRoot, record(ws))).toEqual({
      removed: ["s1"],
      refused: [],
    });
    expect(fs.existsSync(firstEntry(ws).workspace)).toBe(false);
    expect(
      git(f.cwd, "worktree", "list", "--porcelain").match(/^worktree /gm),
    ).toHaveLength(1);
    expect(discardWorkspaces(f.collabRoot, record(ws))).toEqual({
      removed: [],
      refused: [],
    });
  } finally {
    if (saved === undefined) delete process.env.PATH;
    else process.env.PATH = saved;
  }
});

test("unborn repo subdirectory applies to that directory, not a successful no-op", () => {
  const f = fixture(false);
  const sub = path.join(f.cwd, "sub");
  fs.mkdirSync(sub);
  fs.writeFileSync(path.join(sub, "sum.js"), "old\n");
  const ws = prepareWorkspaces({ ...f, cwd: sub, id: "c1", solvers: ["s1"] });
  fs.writeFileSync(path.join(firstEntry(ws).cwd, "sum.js"), "new\n");
  expect(applySolution(f.collabRoot, record(ws), "s1").ok).toBe(true);
  expect(fs.readFileSync(path.join(sub, "sum.js"), "utf8")).toBe("new\n");
});

test("successful no-op apply fails the reverse check and retains its patch", () => {
  const f = fixture(false);
  const ws = prepareWorkspaces({ ...f, id: "c1", solvers: ["s1"] });
  fs.writeFileSync(path.join(firstEntry(ws).cwd, "sum.js"), "new\n");
  const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  const bin = path.join(f.dir, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(
    path.join(bin, "git"),
    `#!/bin/sh\ncase " $* " in\n  *" apply "*) case " $* " in *" --reverse "*) exit 1;; *) exit 0;; esac;;\nesac\nexec '${realGit}' "$@"\n`,
    { mode: 0o755 },
  );
  const saved = process.env.PATH;
  process.env.PATH = `${bin}${path.delimiter}${saved}`;
  try {
    const result = applySolution(f.collabRoot, record(ws), "s1");
    expect(result.ok).toBe(false);
    expect(result.output).toContain("patches/s1.patch");
    expect(fs.readFileSync(path.join(f.cwd, "sum.js"), "utf8")).toBe("old\n");
  } finally {
    if (saved === undefined) delete process.env.PATH;
    else process.env.PATH = saved;
  }
});

for (const conflict of [false, true])
  test(`three-way apply preserves ${conflict ? "conflict markers" : "nonoverlapping main changes"}`, () => {
    const f = fixture();
    const lines = Array.from({ length: 12 }, (_, index) => `line ${index}`);
    fs.writeFileSync(path.join(f.cwd, "sum.js"), `${lines.join("\n")}\n`);
    git(f.cwd, "add", ".");
    git(
      f.cwd,
      "-c",
      "user.name=test",
      "-c",
      "user.email=test@localhost",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-qm",
      "lines",
    );
    const ws = prepareWorkspaces({ ...f, id: "c1", solvers: ["s1"] });
    const solution = [...lines];
    solution[2] = "solver change";
    fs.writeFileSync(
      path.join(firstEntry(ws).cwd, "sum.js"),
      `${solution.join("\n")}\n`,
    );
    lines[conflict ? 2 : 4] = "main change";
    fs.writeFileSync(path.join(f.cwd, "sum.js"), `${lines.join("\n")}\n`);
    git(f.cwd, "add", ".");
    const result = applySolution(f.collabRoot, record(ws), "s1");
    expect(result.ok).toBe(!conflict);
    const contents = fs.readFileSync(path.join(f.cwd, "sum.js"), "utf8");
    expect(contents).toContain("main change");
    expect(contents).toContain("solver change");
    expect(contents.includes("<<<<<<<")).toBe(conflict);
  });

test("canonical symlink cwd and ignored empty cwd remain usable", () => {
  const f = fixture();
  const sub = path.join(f.cwd, "ignored");
  fs.mkdirSync(sub);
  fs.writeFileSync(path.join(f.cwd, ".gitignore"), "ignored/\n");
  const alias = path.join(f.dir, "alias");
  fs.symlinkSync(sub, alias);
  const ws = prepareWorkspaces({ ...f, cwd: alias, id: "c1", solvers: ["s1"] });
  expect(ws.cwd).toBe(fs.realpathSync(sub));
  const entry = firstEntry(ws);
  expect(entry.cwd).toBe(path.join(entry.workspace, "ignored"));
  expect(fs.statSync(entry.cwd).isDirectory()).toBe(true);
});

test("partial preparation rolls back only created worktrees and never runs hooks", () => {
  const f = fixture();
  const marker = path.join(f.dir, "hook-ran");
  for (const name of ["post-checkout", "post-commit"]) {
    const hook = path.join(f.cwd, ".git", "hooks", name);
    fs.writeFileSync(hook, `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
  }
  fs.writeFileSync(path.join(f.cwd, "sum.js"), "dirty\n");
  const preexisting = path.join(f.collabRoot, "competitions/c1/ws/s2");
  fs.mkdirSync(preexisting, { recursive: true });
  fs.writeFileSync(path.join(preexisting, "x"), "sentinel");
  expect(() =>
    prepareWorkspaces({ ...f, id: "c1", solvers: ["s1", "s2"] }),
  ).toThrow();
  expect(fs.existsSync(path.join(f.collabRoot, "competitions/c1/ws/s1"))).toBe(
    false,
  );
  expect(fs.readFileSync(path.join(preexisting, "x"), "utf8")).toBe("sentinel");
  expect(
    git(f.cwd, "worktree", "list", "--porcelain").match(/^worktree /gm),
  ).toHaveLength(1);
  expect(fs.existsSync(marker)).toBe(false);
});
