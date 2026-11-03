/**
 * The collab store at scale, in SQLite and in files: board digests, the
 * task table, and claims, across fresh processes; then what only the
 * database does: importing a file group, retention, and WAL.
 */

import { afterAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { board, overview } from "../../src/collab/ops.js";
import {
  CLAIM_GRACE_MS,
  type Claim,
  CollabStore,
  forgetCollabCaches,
  type MemberRecord,
} from "../../src/collab/store.js";
import { tempDir } from "../agents/helpers.js";

function member(store: CollabStore, name: string): MemberRecord {
  return store.upsertMember({
    key: `agent-${name}`,
    agentId: name,
    name,
    role: "worker",
    group: store.group,
    cwd: "/repo",
    joinedAt: Date.now(),
    updatedAt: Date.now(),
    state: "working",
    status: "live",
  });
}

function post(store: CollabStore, id: string, title: string, at = Date.now()) {
  return store.post({
    id,
    kind: "todo",
    title,
    body: `body of ${title}`,
    refs: [],
    author: "agent-a",
    authorName: "a",
    createdAt: at,
  });
}

let root: string;
const saved = process.env.PI_AGENTS_COLLAB_STORE;
afterAll(() => {
  if (saved === undefined) delete process.env.PI_AGENTS_COLLAB_STORE;
  else process.env.PI_AGENTS_COLLAB_STORE = saved;
  forgetCollabCaches();
});

for (const backend of ["sqlite", "files"] as const)
  describe(`${backend} store`, () => {
    beforeEach(() => {
      if (backend === "files") process.env.PI_AGENTS_COLLAB_STORE = "files";
      else delete process.env.PI_AGENTS_COLLAB_STORE;
      root = tempDir("pi-collab-store-");
      forgetCollabCaches();
    });

    test("opens the backend it names", () => {
      expect(new CollabStore(root, "g").kind).toBe(backend);
    });

    describe("the board", () => {
      test("a plain read is a digest; finished entries leave it", () => {
        const store = new CollabStore(root, "g");
        post(store, "b1", "alpha", 1_000);
        post(store, "b2", "beta", 2_000);
        post(store, "b3", "gamma", 3_000);
        store.update("b2", "agent-a", { status: "done", at: 4_000 });

        expect(store.summaries().map((entry) => entry.id)).toEqual([
          "b3",
          "b1",
        ]);
        expect(store.summaries({ all: true }).map((entry) => entry.id)).toEqual(
          ["b3", "b1", "b2"],
        );
        expect(store.boardCounts()).toMatchObject({
          total: 3,
          byStatus: { open: 2, done: 1 },
          openByKind: { todo: 2 },
        });

        const digest = board(store, undefined, { action: "read" }).text;
        expect(digest).toContain("3 entries: 2 open, 1 done");
        expect(digest).toContain("Unfinished, newest first");
        expect(digest.indexOf("gamma")).toBeLessThan(digest.indexOf("alpha"));
        expect(digest).toContain("Recently finished (1 of 1");
        expect(digest.split("Recently")[0]).not.toContain("beta");
        const listing = board(store, undefined, { action: "read" }).data;
        expect(listing?.entries.map((entry) => entry.id)).toEqual(["b3", "b1"]);

        const all = board(store, undefined, { action: "read", all: true }).text;
        expect(all).toContain("beta");
        const done = board(store, undefined, {
          action: "read",
          status: "done",
        });
        expect(done.data?.entries.map((entry) => entry.id)).toEqual(["b2"]);
        // One entry by ID still reads in full, finished or not.
        expect(
          board(store, undefined, { action: "read", id: "b2" }).text,
        ).toContain("body of beta");
        expect(overview(store)).toContain("3 entries");
      });

      test("out-of-order updates keep summaries current and timestamps monotonic", () => {
        const store = new CollabStore(root, "g");
        post(store, "b1", "one", 1_000);
        post(store, "b2", "two", 2_000);
        store.update("b1", "agent-a", { status: "doing", at: 5_000 });
        // Populate the index fold before an older update is appended.
        expect(store.summaries()[0]?.status).toBe("doing");
        const change = { status: "done" as const, note: "late", at: 3_000 };
        const updated = store.update("b1", "agent-b", change);
        expect(updated.updatedAt).toBe(5_000);
        expect(updated.history.map((each) => each.at)).toEqual([5_000, 3_000]);
        expect(store.update("b1", "agent-b", change)).toEqual(updated);

        const check = (current: CollabStore) => {
          const summary = current
            .summaries({ all: true })
            .find((each) => each.id === "b1");
          expect(summary).toMatchObject({ status: "done", updatedAt: 5_000 });
          expect(current.entry("b1")).toEqual(updated);
          expect(current.summaries().map((each) => each.id)).toEqual(["b2"]);
          expect(current.boardCounts().byStatus).toMatchObject({
            open: 1,
            doing: 0,
            done: 1,
          });
        };
        check(store);
        forgetCollabCaches();
        check(new CollabStore(root, "g"));
      });

      test("an empty board says so", () => {
        const store = new CollabStore(root, "g");
        expect(board(store, undefined, { action: "read" }).text).toContain(
          "is empty",
        );
      });

      test("a fresh process rebuilds from the index, and a missing index from the entries", () => {
        const store = new CollabStore(root, "g");
        for (let index = 0; index < 40; index++)
          post(store, `b${index}`, `entry ${index}`, 1_000 + index);
        store.update("b5", "agent-a", { status: "doing", at: 5_000 });
        const before = store.summaries({ all: true, limit: 100 });

        forgetCollabCaches();
        expect(
          new CollabStore(root, "g").summaries({ all: true, limit: 100 }),
        ).toEqual(before);

        if (backend !== "files") return;
        // A group from before the index migrates once.
        fs.rmSync(path.join(store.dir, "board.jsonl"));
        forgetCollabCaches();
        const migrated = new CollabStore(root, "g");
        expect(migrated.summaries({ all: true, limit: 100 })).toEqual(before);
        expect(fs.existsSync(path.join(store.dir, "board.jsonl"))).toBe(true);
        post(migrated, "b40", "after", 9_000);
        expect(migrated.summaries({ limit: 1 })[0]?.id).toBe("b40");
      });

      test("other stores of the group see posts and updates", () => {
        const left = new CollabStore(root, "g");
        post(left, "b1", "one", 1_000);
        forgetCollabCaches();
        const right = new CollabStore(root, "g");
        expect(right.summaries().map((entry) => entry.id)).toEqual(["b1"]);
        forgetCollabCaches();
        // A write by "another process" after this one read the index.
        const other = new CollabStore(root, "g");
        post(other, "b2", "two", 2_000);
        other.update("b1", "agent-b", { status: "done", at: 3_000 });
        expect(right.summaries().map((entry) => entry.id)).toEqual(["b2"]);
        expect(right.boardCounts().byStatus).toMatchObject({
          open: 1,
          done: 1,
        });
      });
    });

    describe("the task table", () => {
      test("a task older than 500 messages stays, also after a restart", () => {
        const store = new CollabStore(root, "g");
        const send = (
          id: string,
          type: "task_req" | "task_done" | "message",
          at: number,
          task?: string,
        ) =>
          store.log({
            id,
            type,
            ...(task ? { task } : {}),
            from: "agent-a",
            fromName: "a",
            to: "agent-b",
            toName: "b",
            text: `${type} ${id}`,
            refs: [],
            mode: "followUp",
            sentAt: at,
          });
        send("m-old", "task_req", 1, "t-old");
        for (let index = 0; index < 600; index++)
          send(`m${index}`, "message", 10 + index);
        send("m-new", "task_req", 1_000, "t-new");
        send("m-done", "task_done", 1_001, "t-new");

        const check = (tasks: ReturnType<CollabStore["tasks"]>) => {
          expect(tasks.map((task) => task.id)).toEqual(["t-new", "t-old"]);
          expect(tasks[0]?.status).toBe("task_done");
          expect(tasks[1]?.status).toBe("task_req");
        };
        check(store.tasks());
        expect(store.messages(10)[0]?.id).toBe("m-done");
        forgetCollabCaches();
        check(new CollabStore(root, "g").tasks());
        if (backend !== "files") return;
        // Without the index, the messages rebuild it.
        fs.rmSync(path.join(store.dir, "messages.jsonl"));
        forgetCollabCaches();
        const rebuilt = new CollabStore(root, "g");
        check(rebuilt.tasks());
        expect(rebuilt.messages(1000)).toHaveLength(603);
      });
    });

    describe("claims", () => {
      test("legacy migration skips invalid paths, preserves valid claims, and stays idempotent", () => {
        let store = new CollabStore(root, "g");
        const a = member(store, "a");
        const b = member(store, "b");
        const cwd = fs.realpathSync(root);
        fs.mkdirSync(path.join(cwd, "pkg"));
        fs.symlinkSync("loop", path.join(cwd, "loop"));
        store.upsertMember({ ...a, cwd });
        store.upsertMember({ ...b, cwd: path.join(cwd, "pkg") });
        const identity = `path:${path.join(cwd, "pkg", "x.ts")}`;
        const legacy: Claim[] = [
          {
            owner: a.key,
            ownerName: "a",
            resource: "path:pkg/x.ts",
            claimedAt: 1,
            note: "kept",
            expiresAt: Date.now() + 60_000,
          },
          { owner: b.key, ownerName: "b", resource: "path:x.ts", claimedAt: 2 },
          { owner: a.key, ownerName: "a", resource: "path:", claimedAt: 3 },
          {
            owner: b.key,
            ownerName: "b",
            resource: `path:${path.join(cwd, "absolute.ts")}`,
            claimedAt: 4,
          },
          {
            owner: a.key,
            ownerName: "a",
            resource: "key:opaque",
            claimedAt: 5,
          },
          { owner: b.key, ownerName: "b", resource: "item:b1", claimedAt: 6 },
          {
            owner: "missing",
            ownerName: "missing",
            resource: "path:lost.ts",
            claimedAt: 7,
          },
          {
            owner: "missing",
            ownerName: "missing",
            resource: "key:lost",
            claimedAt: 8,
          },
          {
            owner: a.key,
            ownerName: "a",
            resource: "path:loop/x.ts",
            claimedAt: 9,
          },
        ];
        if (backend === "files") {
          fs.writeFileSync(
            path.join(store.dir, "claims.json"),
            JSON.stringify({ claims: legacy }),
          );
        } else {
          const { DatabaseSync } = process.getBuiltinModule("node:sqlite") as {
            DatabaseSync: new (
              file: string,
            ) => {
              exec(sql: string): void;
              prepare(sql: string): {
                run(...args: (string | number | null)[]): unknown;
              };
              close(): void;
            };
          };
          const db = new DatabaseSync(path.join(store.dir, "collab.db"));
          try {
            db.exec("DELETE FROM meta WHERE key = 'claims'");
            for (const claim of legacy)
              db.prepare(
                "INSERT INTO claims (owner, resource, owner_name, note, claimed_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
              ).run(
                claim.owner,
                claim.resource,
                claim.ownerName,
                claim.note ?? null,
                claim.claimedAt,
                claim.expiresAt ?? null,
              );
          } finally {
            db.close();
          }
        }
        const warning = spyOn(process, "emitWarning").mockImplementation(
          () => {},
        );
        try {
          forgetCollabCaches();
          store = new CollabStore(root, "g");
          const expected = legacy.slice(0, 6).map((claim, index) => ({
            ...claim,
            resource:
              index < 2
                ? identity
                : index === 2
                  ? `path:${cwd}`
                  : claim.resource,
          }));
          expect(store.claims()).toEqual(expected);
          expect(store.claims()).toEqual(expected);
          forgetCollabCaches();
          store = new CollabStore(root, "g");
          expect(store.claims()).toEqual(expected);
          expect(store.release(a.key, [identity])).toEqual([expected[0]]);
          forgetCollabCaches();
          expect(new CollabStore(root, "g").claims()).toEqual(
            expected.slice(1),
          );
          expect(warning).toHaveBeenCalledTimes(1);
          expect(warning).toHaveBeenCalledWith(
            "Dropped an invalid legacy path claim during collab migration",
            { code: "PI_AGENTS_COLLAB_CLAIM_MIGRATION" },
          );
        } finally {
          warning.mockRestore();
        }
      });

      test("a member that exits loses its claims, in this process and a fresh one", () => {
        const store = new CollabStore(root, "g");
        const a = member(store, "a");
        const b = member(store, "b");
        expect(store.claim(a, ["src/x.ts"]).ok).toBe(true);
        expect(store.claim(b, ["src/x.ts"]).ok).toBe(false);
        store.setStatus(a.key, "exited");
        expect(store.claims()).toEqual([]);
        expect(store.claim(b, ["src/x.ts"]).ok).toBe(true);
        forgetCollabCaches();
        const fresh = new CollabStore(root, "g");
        expect(fresh.claims().map((claim) => claim.ownerName)).toEqual(["b"]);
        expect(fresh.member(a.key)?.status).toBe("exited");
        expect(fresh.claim(a, ["src/x.ts"]).ok).toBe(false);
      });

      for (const restart of [false, true]) {
        for (const reclaim of [false, true]) {
          test(`exited claims never revive (restart=${restart}, reclaim=${reclaim})`, () => {
            let store = new CollabStore(root, "g");
            const a = member(store, "a");
            const b = member(store, "b");
            store.claim(a, ["src/x.ts"]);
            store.setStatus(a.key, "exited");
            if (reclaim) expect(store.claim(b, ["src/x.ts"]).ok).toBe(true);
            if (restart) {
              forgetCollabCaches();
              store = new CollabStore(root, "g");
            }
            member(store, "a");
            const expected = reclaim ? [b.key] : [];
            expect(store.claims().map((claim) => claim.owner)).toEqual(
              expected,
            );
            forgetCollabCaches();
            expect(
              new CollabStore(root, "g").claims().map((claim) => claim.owner),
            ).toEqual(expected);
          });
        }

        test(`stale paused claims never revive (restart=${restart})`, () => {
          let store = new CollabStore(root, "g");
          const a = member(store, "a");
          store.claim(a, ["src/x.ts"]);
          store.setStatus(a.key, "paused");
          expect(store.claims()).toHaveLength(1);
          const clock = spyOn(Date, "now").mockReturnValue(
            Date.now() + CLAIM_GRACE_MS + 1,
          );
          try {
            if (restart) {
              forgetCollabCaches();
              store = new CollabStore(root, "g");
            }
            member(store, "a");
            expect(store.claims()).toEqual([]);
            forgetCollabCaches();
            expect(new CollabStore(root, "g").claims()).toEqual([]);
          } finally {
            clock.mockRestore();
          }
        });
      }

      test("resuming a stale paused member through setStatus cannot revive claims", () => {
        const store = new CollabStore(root, "g");
        const a = member(store, "a");
        const b = member(store, "b");
        store.claim(a, ["src/x.ts"]);
        store.setStatus(a.key, "paused");
        const clock = spyOn(Date, "now").mockReturnValue(
          Date.now() + CLAIM_GRACE_MS + 1,
        );
        try {
          store.setStatus(a.key, "live");
          expect(store.claims()).toEqual([]);
          expect(store.claim(b, ["src/x.ts"]).ok).toBe(true);
          forgetCollabCaches();
          expect(
            new CollabStore(root, "g").claims().map((claim) => claim.owner),
          ).toEqual([b.key]);
        } finally {
          clock.mockRestore();
        }
      });

      test("even a conflicting claim purges nonholders before they can register", () => {
        const store = new CollabStore(root, "g");
        const a = member(store, "a");
        const b = member(store, "b");
        store.claim(a, ["busy"]);
        // Low-level callers can leave a claim without a member record.
        store.claim({ key: "agent-unknown", name: "unknown" }, ["orphan"]);
        const persistedCount = () => {
          if (backend === "files")
            return JSON.parse(
              fs.readFileSync(path.join(store.dir, "claims.json"), "utf8"),
            ).claims.length;
          const { DatabaseSync } = process.getBuiltinModule("node:sqlite") as {
            DatabaseSync: new (
              file: string,
            ) => {
              prepare(sql: string): { get(): { count: number } };
              close(): void;
            };
          };
          const db = new DatabaseSync(path.join(store.dir, "collab.db"));
          try {
            return db.prepare("SELECT COUNT(*) AS count FROM claims").get()
              .count;
          } finally {
            db.close();
          }
        };
        expect(persistedCount()).toBe(2);
        expect(store.claim(b, ["busy"]).ok).toBe(false);
        expect(persistedCount()).toBe(1);
        member(store, "unknown");
        expect(store.claims().map((claim) => claim.resource)).toEqual(["busy"]);
        forgetCollabCaches();
        expect(
          new CollabStore(root, "g").claims().map((claim) => claim.resource),
        ).toEqual(["busy"]);
      });

      test("a status another process writes reaches this one's cache", () => {
        const store = new CollabStore(root, "g");
        const a = member(store, "a");
        const b = member(store, "b");
        store.claim(a, ["src/x.ts"]);
        expect(store.claims()).toHaveLength(1);
        // Another process: its own cache, the same files.
        forgetCollabCaches();
        new CollabStore(root, "g").setStatus(a.key, "exited");
        expect(store.claim(b, ["src/x.ts"]).ok).toBe(true);
      });

      test("100 members claim, post, and send without double holders", () => {
        const store = new CollabStore(root, "g");
        const members = Array.from({ length: 100 }, (_, index) =>
          member(store, `m${index}`),
        );
        const won = new Map<string, string>();
        for (const [index, each] of members.entries()) {
          const resource = `src/f${index % 50}.ts`;
          const outcome = store.claim(each, [resource]);
          if (outcome.ok) won.set(resource, each.name);
          else expect(outcome.conflicts[0]?.ownerName).toBe(won.get(resource));
          post(store, `b${index}`, `finding of ${each.name}`, 1_000 + index);
          store.log({
            id: `m${index}`,
            type: "task_req",
            task: `t${index}`,
            from: each.key,
            fromName: each.name,
            to: members[(index + 1) % 100]?.key ?? "",
            toName: members[(index + 1) % 100]?.name ?? "",
            text: `task of ${each.name}`,
            refs: [],
            mode: "followUp",
            sentAt: 1_000 + index,
          });
        }
        expect(won.size).toBe(50);
        const held = store.claims();
        expect(held).toHaveLength(50);
        expect(new Set(held.map((claim) => claim.resource)).size).toBe(50);
        expect(store.members()).toHaveLength(100);
        expect(store.boardCounts().total).toBe(100);
        expect(store.tasks()).toHaveLength(100);
        // The first half release; the other half take the files over.
        for (const each of members.slice(0, 50)) store.release(each.key);
        for (const each of members.slice(50))
          expect(
            store.claim(each, [`src/f${Number(each.name.slice(1)) % 50}.ts`])
              .ok,
          ).toBe(true);
        forgetCollabCaches();
        const fresh = new CollabStore(root, "g");
        expect(new Set(fresh.claims().map((claim) => claim.ownerName))).toEqual(
          new Set(members.slice(50).map((each) => each.name)),
        );
        expect(fresh.tasks()).toHaveLength(100);
        expect(fresh.summaries({ limit: 200 })).toHaveLength(100);
      });
    });
  });

describe("the database", () => {
  beforeEach(() => {
    delete process.env.PI_AGENTS_COLLAB_STORE;
    root = tempDir("pi-collab-db-");
    forgetCollabCaches();
  });

  test("imports a group the file store kept, once", () => {
    process.env.PI_AGENTS_COLLAB_STORE = "files";
    const files = new CollabStore(root, "g");
    const a = member(files, "a");
    post(files, "b1", "kept", 1_000);
    files.update("b1", a.key, { status: "doing", at: 2_000 });
    files.claim(a, ["src/x.ts"]);
    files.log({
      id: "m1",
      type: "task_req",
      task: "t1",
      from: a.key,
      fromName: "a",
      to: "agent-b",
      toName: "b",
      text: "do it",
      refs: [],
      mode: "followUp",
      sentAt: 3_000,
    });
    delete process.env.PI_AGENTS_COLLAB_STORE;
    forgetCollabCaches();

    const db = new CollabStore(root, "g");
    expect(db.kind).toBe("sqlite");
    expect(fs.existsSync(path.join(db.dir, "collab.db"))).toBe(true);
    expect(db.member(a.key)?.name).toBe("a");
    expect(db.entry("b1")?.status).toBe("doing");
    expect(db.claims().map((claim) => claim.resource)).toEqual(["src/x.ts"]);
    expect(db.tasks().map((task) => task.id)).toEqual(["t1"]);
    expect(db.messages()).toHaveLength(1);
    // Later writes go to the database only; the import doesn't repeat.
    post(db, "b2", "new", 4_000);
    forgetCollabCaches();
    expect(new CollabStore(root, "g").boardCounts().total).toBe(2);
  });

  test("retention prunes old messages, finished entries, and closed tasks; open ones stay", () => {
    const store = new CollabStore(root, "g");
    for (let index = 0; index < 50; index++) {
      post(store, `b${index}`, `entry ${index}`, 1_000 + index);
      if (index < 40)
        store.update(`b${index}`, "agent-a", {
          status: "done",
          at: 2_000 + index,
        });
      store.log({
        id: `m${index}`,
        type: "task_req",
        task: `t${index}`,
        from: "agent-a",
        fromName: "a",
        to: "agent-b",
        toName: "b",
        text: `task ${index}`,
        refs: [],
        mode: "followUp",
        sentAt: 1_000 + index,
      });
      if (index < 30)
        store.log({
          id: `d${index}`,
          type: "task_done",
          task: `t${index}`,
          from: "agent-b",
          fromName: "b",
          to: "agent-a",
          toName: "a",
          text: "done",
          refs: [],
          mode: "followUp",
          sentAt: 5_000 + index,
        });
    }
    const pruned = store.prune({
      messages: 20,
      finishedEntries: 5,
      closedTasks: 10,
    });
    expect(pruned).toEqual({ messages: 60, entries: 35, tasks: 20 });
    expect(store.messages(1_000)).toHaveLength(20);
    // The ten open entries and five newest finished ones remain.
    expect(store.boardCounts().byStatus).toMatchObject({ open: 10, done: 5 });
    expect(store.entry("b39")?.status).toBe("done");
    expect(store.entry("b0")).toBeUndefined();
    // Twenty open tasks and the ten newest closed ones remain, also with
    // their messages gone.
    const tasks = store.tasks();
    expect(tasks.filter((task) => task.status === "task_req")).toHaveLength(20);
    expect(tasks.filter((task) => task.status === "task_done")).toHaveLength(
      10,
    );
    expect(
      store.prune({ messages: 20, finishedEntries: 5, closedTasks: 10 }),
    ).toEqual({ messages: 0, entries: 0, tasks: 0 });
  });

  test("runs in WAL mode, and writers in several processes serialize", async () => {
    const store = new CollabStore(root, "g");
    member(store, "a");
    const script = path.join(root, "writer.ts");
    fs.writeFileSync(
      script,
      `import { CollabStore } from ${JSON.stringify(path.resolve("src/collab/store.ts"))};
const [root, name] = process.argv.slice(2);
const store = new CollabStore(root, "g");
const self = store.upsertMember({ key: "agent-" + name, name, role: "w", group: "g", cwd: "/", joinedAt: 1, updatedAt: Date.now(), state: "working", status: "live" });
let won = 0;
for (let index = 0; index < 40; index++) {
  store.post({ id: name + "-" + index, kind: "note", title: "t", body: "", refs: [], author: self.key, authorName: name });
  const outcome = store.claim(self, ["src/hot.ts"]);
  if (outcome.ok) { won++; store.release(self.key); }
}
console.log(won);
`,
    );
    const runs = await Promise.all(
      ["p1", "p2", "p3", "p4"].map(async (name) => {
        const child = Bun.spawn(["bun", script, root, name], {
          // This test's environment, not the one the runner started with.
          env: { ...process.env },
          stdout: "pipe",
          stderr: "pipe",
        });
        const out = await new Response(child.stdout).text();
        expect(await child.exited).toBe(0);
        return Number(out.trim());
      }),
    );
    expect(runs.every((won) => won > 0)).toBe(true);
    forgetCollabCaches();
    const fresh = new CollabStore(root, "g");
    expect(fresh.boardCounts().total).toBe(160);
    expect(fresh.claims()).toEqual([]);
    const { DatabaseSync } = process.getBuiltinModule("node:sqlite") as {
      DatabaseSync: new (
        file: string,
      ) => { prepare(sql: string): { get(): unknown }; close(): void };
    };
    const db = new DatabaseSync(path.join(fresh.dir, "collab.db"));
    expect(db.prepare("PRAGMA journal_mode").get()).toEqual({
      journal_mode: "wal",
    });
    db.close();
  });
});
