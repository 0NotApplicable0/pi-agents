import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  assertCompetitionId,
  type Competition,
  competitionDir,
  configureVerifyConcurrency,
  configureVerifyEnv,
  discardWorkspaces,
  listCompetitions,
  prepareWorkspaces,
  readCompetition,
  runVerify,
  verifyEnvironment,
  verifySolver,
  writeCompetition,
} from "../../src/collab/compete.js";

const dirs: string[] = [];
afterEach(() => {
  configureVerifyEnv("scrub");
  configureVerifyConcurrency(4);
  for (const dir of dirs.splice(0))
    fs.rmSync(dir, { recursive: true, force: true });
});
function fixture() {
  const dir = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "compete-security-")),
  );
  dirs.push(dir);
  const cwd = path.join(dir, "project");
  fs.mkdirSync(cwd);
  fs.writeFileSync(path.join(cwd, "x"), "base\n");
  const collabRoot = path.join(dir, "collab");
  const ws = prepareWorkspaces({ collabRoot, cwd, id: "c1", solvers: ["s1"] });
  const competition: Competition = {
    protocol: 1,
    id: "c1",
    task: "test",
    createdAt: 1,
    deadline: 2,
    cwd: ws.cwd,
    root: ws.root,
    git: ws.git,
    verify: "touch marker",
    verifySource: "given",
    verifyTimeoutMs: 300,
    solvers: ws.entries,
    status: "running",
  };
  const entry = competition.solvers[0];
  if (!entry) throw new Error("Missing fixture entry");
  return { dir, cwd, collabRoot, competition, entry };
}

test("strict competition IDs, persisted ID mismatch and invalid list entries", () => {
  const f = fixture();
  for (const id of [
    "../x",
    "c1/../../x",
    "/tmp/c1",
    "c0",
    "c01",
    "c1000000000",
  ]) {
    expect(() => assertCompetitionId(id)).toThrow();
    expect(() => readCompetition(f.collabRoot, id)).toThrow();
  }
  writeCompetition(f.collabRoot, f.competition);
  expect(readCompetition(f.collabRoot, "c1")?.id).toBe("c1");
  const record = path.join(
    competitionDir(f.collabRoot, "c1"),
    "competition.json",
  );
  fs.writeFileSync(record, JSON.stringify({ ...f.competition, id: "c2" }));
  expect(() => readCompetition(f.collabRoot, "c1")).toThrow();
  fs.mkdirSync(path.join(f.collabRoot, "competitions/evil"));
  expect(listCompetitions(f.collabRoot)).toEqual([]);
});

test("persisted external workspace and option-like base commit are rejected", () => {
  const f = fixture();
  const record = path.join(
    competitionDir(f.collabRoot, "c1"),
    "competition.json",
  );
  writeCompetition(f.collabRoot, f.competition);
  fs.writeFileSync(
    record,
    JSON.stringify({
      ...f.competition,
      solvers: [{ ...f.entry, workspace: f.cwd, cwd: f.cwd }],
    }),
  );
  expect(() => readCompetition(f.collabRoot, "c1")).toThrow("Unsafe workspace");
  fs.writeFileSync(
    record,
    JSON.stringify({
      ...f.competition,
      solvers: [{ ...f.entry, base: "--output=/tmp/not-allowed" }],
    }),
  );
  expect(() => readCompetition(f.collabRoot, "c1")).toThrow("Unsafe workspace");
});

test("aborting a queued verify settles before the active command finishes", async () => {
  const f = fixture();
  configureVerifyConcurrency(1);
  const active = new AbortController();
  const queued = new AbortController();
  const first = runVerify("sleep 10", f.cwd, { signal: active.signal });
  try {
    const second = runVerify("touch must-not-run", f.cwd, {
      signal: queued.signal,
    });
    queued.abort();
    const result = await Promise.race([
      second,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Queued abort hung")), 1000),
      ),
    ]);
    expect(result.output).toBe("aborted before it ran");
    expect(fs.existsSync(path.join(f.cwd, "must-not-run"))).toBe(false);
  } finally {
    active.abort();
    await first;
  }
});

test("missing cwd and removed workspaces remain readable and discard is idempotent", async () => {
  const f = fixture();
  f.entry.cwd = path.join(f.entry.workspace, "sub");
  fs.mkdirSync(f.entry.cwd);
  writeCompetition(f.collabRoot, f.competition);
  fs.rmdirSync(f.entry.cwd);
  expect(readCompetition(f.collabRoot, "c1")?.id).toBe("c1");
  expect(listCompetitions(f.collabRoot)).toHaveLength(1);
  expect(
    await verifySolver(f.collabRoot, f.competition, f.entry, {
      patch: "",
      files: [],
      hash: "x",
    }),
  ).toBeUndefined();
  expect(discardWorkspaces(f.collabRoot, f.competition)).toEqual({
    removed: ["s1"],
    refused: [],
  });
  expect(readCompetition(f.collabRoot, "c1")?.id).toBe("c1");
  expect(listCompetitions(f.collabRoot)).toHaveLength(1);
  expect(
    await verifySolver(f.collabRoot, f.competition, f.entry, {
      patch: "",
      files: [],
      hash: "x",
    }),
  ).toBeUndefined();
  expect(discardWorkspaces(f.collabRoot, f.competition)).toEqual({
    removed: [],
    refused: [],
  });
});

test("missing paths through escaping or dangling symlinks are still unsafe", async () => {
  const f = fixture();
  const link = path.join(f.entry.workspace, "escape");
  fs.symlinkSync(f.cwd, link);
  f.entry.cwd = path.join(link, "missing");
  writeCompetition(f.collabRoot, f.competition);
  expect(() => readCompetition(f.collabRoot, "c1")).toThrow("Unsafe workspace");
  await expect(
    verifySolver(f.collabRoot, f.competition, f.entry, {
      patch: "",
      files: [],
      hash: "x",
    }),
  ).rejects.toThrow("Unsafe workspace");
  expect(discardWorkspaces(f.collabRoot, f.competition)).toEqual({
    removed: [],
    refused: ["s1"],
  });
  fs.rmSync(f.entry.workspace, { recursive: true });
  fs.symlinkSync(path.join(f.dir, "nonexistent"), f.entry.workspace);
  f.entry.cwd = f.entry.workspace;
  expect(discardWorkspaces(f.collabRoot, f.competition)).toEqual({
    removed: [],
    refused: ["s1"],
  });
});

test("unsafe solver names are rejected before touching workspace paths", () => {
  const f = fixture();
  for (const name of ["..", ".hidden", "a/b", "/tmp/x"])
    expect(() =>
      prepareWorkspaces({
        collabRoot: f.collabRoot,
        cwd: f.cwd,
        id: "c2",
        solvers: [name],
      }),
    ).toThrow();
});

test("discard refuses external paths and workspace symlink targets", () => {
  const f = fixture();
  const external = path.join(f.dir, "external");
  fs.mkdirSync(external);
  fs.writeFileSync(path.join(external, "sentinel"), "keep");
  const original = f.entry.workspace;
  f.entry.workspace = external;
  f.entry.cwd = external;
  expect(discardWorkspaces(f.collabRoot, f.competition)).toEqual({
    removed: [],
    refused: ["s1"],
  });
  f.entry.workspace = original;
  fs.rmSync(original, { recursive: true });
  fs.symlinkSync(external, original);
  f.entry.cwd = original;
  expect(discardWorkspaces(f.collabRoot, f.competition)).toEqual({
    removed: [],
    refused: ["s1"],
  });
  expect(fs.readFileSync(path.join(external, "sentinel"), "utf8")).toBe("keep");
});

test("verify refuses tampered cwd before spawning; safe discard removes owned workspace", async () => {
  const f = fixture();
  const original = f.entry.cwd;
  f.entry.cwd = f.cwd;
  await expect(
    verifySolver(f.collabRoot, f.competition, f.entry, {
      patch: "",
      files: [],
      hash: "x",
    }),
  ).rejects.toThrow("Unsafe workspace");
  expect(fs.existsSync(path.join(f.cwd, "marker"))).toBe(false);
  f.entry.cwd = original;
  expect(discardWorkspaces(f.collabRoot, f.competition)).toEqual({
    removed: ["s1"],
    refused: [],
  });
});

for (const abort of [false, true])
  test(`verify ${abort ? "abort" : "timeout"} is bounded with a detached pipe holder`, async () => {
    const f = fixture();
    const pidFile = path.join(f.dir, "pid");
    const script = `const fs = require('fs'); const cp = require('child_process'); const c = cp.spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {detached:true,stdio:['ignore',1,2]}); fs.writeFileSync(${JSON.stringify(pidFile)}, String(c.pid)); c.unref(); setInterval(()=>{},1000);`;
    const controller = new AbortController();
    const timer = abort ? setTimeout(() => controller.abort(), 300) : undefined;
    try {
      const result = await runVerify(
        `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`,
        f.cwd,
        { timeoutMs: abort ? 10000 : 300, signal: controller.signal },
      );
      expect(result.timedOut).toBe(!abort);
      expect(result.durationMs).toBeLessThan(4000);
    } finally {
      clearTimeout(timer);
      if (fs.existsSync(pidFile))
        try {
          process.kill(Number(fs.readFileSync(pidFile, "utf8")), "SIGKILL");
        } catch {}
    }
  }, 6000);

test("scrub defaults drop planted credentials, preserve PATH, and control passthrough", async () => {
  const source = {
    PATH: "/bin",
    HOME: "/home/test",
    ANTHROPIC_API_KEY: "secret",
    FOO_TOKEN: "token",
    DATABASE_URL: "postgres://user:password@localhost/db",
    SENTRY_DSN: "https://secret@example.invalid/1",
    REDIS_URL: "redis://:password@localhost/0",
    database_url: "postgres://user:password@localhost/db",
    CUSTOM: "value",
    BASH_ENV: "/hostile",
  };
  expect(verifyEnvironment(source)).toEqual({
    PATH: "/bin",
    HOME: "/home/test",
    CUSTOM: "value",
    CI: "1",
    FORCE_COLOR: "0",
  });
  configureVerifyEnv("minimal");
  expect(verifyEnvironment(source).CUSTOM).toBeUndefined();
  configureVerifyEnv("inherit");
  expect(verifyEnvironment(source).FOO_TOKEN).toBe("token");
  configureVerifyEnv("scrub", [
    "FOO_TOKEN",
    "DATABASE_URL",
    "SENTRY_DSN",
    "REDIS_URL",
  ]);
  for (const key of [
    "FOO_TOKEN",
    "DATABASE_URL",
    "SENTRY_DSN",
    "REDIS_URL",
  ] as const)
    expect(verifyEnvironment(source)[key]).toBe(source[key]);
  expect(verifyEnvironment(source).database_url).toBeUndefined();
  configureVerifyEnv("scrub");
  const keys = [
    "ANTHROPIC_API_KEY",
    "DATABASE_URL",
    "SENTRY_DSN",
    "REDIS_URL",
  ] as const;
  const saved = keys.map((key) => process.env[key]);
  for (const key of keys) process.env[key] = "planted-secret-must-not-leak";
  try {
    const result = await runVerify(
      'printf "%s%s%s%s" "$ANTHROPIC_API_KEY" "$DATABASE_URL" "$SENTRY_DSN" "$REDIS_URL"',
      fixture().cwd,
    );
    expect(result.exitCode).toBe(0);
    expect(result.output).toBe("");
    configureVerifyEnv("scrub", ["DATABASE_URL", "SENTRY_DSN", "REDIS_URL"]);
    const passed = await runVerify(
      'printf "%s%s%s" "$DATABASE_URL" "$SENTRY_DSN" "$REDIS_URL"',
      fixture().cwd,
    );
    expect(passed.exitCode).toBe(0);
    expect(passed.output).toBe("planted-secret-must-not-leak".repeat(3));
  } finally {
    keys.forEach((key, index) => {
      const value = saved[index];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    });
  }
});
