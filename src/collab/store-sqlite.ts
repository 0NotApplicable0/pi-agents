/**
 * The collab store of one group in a SQLite database, `<group>/collab.db`,
 * through the `node:sqlite` module that Node (22.13 and later) and Bun
 * ship, so nothing native is installed.
 *
 * The database runs in WAL mode: readers never wait for the writer, and a
 * write is one transaction, atomic across a crash. Writes that change
 * shared state (claims, board updates, status changes) take the write lock
 * first (`BEGIN IMMEDIATE`), so concurrent writers, in this process or
 * another, serialize there instead of on a lock directory. Writes callers
 * retry stay create-once by ID, as in the file store.
 *
 * Board entries keep their summary columns beside the full entry, so a
 * board read selects and orders in SQL; the task table is kept as rows,
 * updated in the transaction that logs each message, so tasks outlive the
 * messages that retention prunes.
 */

import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as path from "node:path";
import { readJson, readJsonDir } from "./files.js";
import {
  BOARD_STATUSES,
  type BoardEntry,
  type BoardKind,
  type BoardStatus,
  type BoardSummary,
  byTime,
  CLAIM_GRACE_MS,
  type Claim,
  type ClaimOutcome,
  type CollabMessage,
  FINISHED_STATUSES,
  foldTask,
  isFinished,
  type MemberRecord,
  type MemberStatus,
  overlaps,
  PROTOCOL,
  type Retention,
  type StoreBackend,
  summaryOf,
  type TaskView,
} from "./store-model.js";

/** The database file of a group. */
export const DATABASE_FILE = "collab.db";
const SCHEMA_VERSION = "1";
/** How long a write waits for another writer before it fails. */
const BUSY_TIMEOUT_MS = 10_000;

type Value = string | number | null;
type Row = Record<string, Value>;
interface Statement {
  run(...values: Value[]): { changes: number | bigint };
  get(...values: Value[]): Row | undefined;
  all(...values: Value[]): Row[];
}
interface Database {
  exec(sql: string): void;
  prepare(sql: string): Statement;
  close(): void;
}
type DatabaseClass = new (file: string) => Database;

let loaded: { DatabaseSync?: DatabaseClass } | undefined;

/**
 * `node:sqlite`'s database class, or undefined where the runtime has none
 * (or `PI_AGENTS_COLLAB_STORE=files` asks for the file store). Node 22
 * warns once that the module is experimental; that warning is swallowed.
 */
export function sqliteDatabase(): DatabaseClass | undefined {
  if (process.env.PI_AGENTS_COLLAB_STORE === "files") return undefined;
  if (!loaded) {
    loaded = {};
    const emit = process.emitWarning;
    process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
      const text = typeof warning === "string" ? warning : warning?.message;
      if (String(text).includes("SQLite")) return;
      return (emit as (...args: unknown[]) => void).call(
        process,
        warning,
        ...rest,
      );
    }) as typeof process.emitWarning;
    try {
      const module = (process.getBuiltinModule?.("node:sqlite") ??
        createRequire(import.meta.url)("node:sqlite")) as
        | { DatabaseSync?: DatabaseClass }
        | undefined;
      if (typeof module?.DatabaseSync === "function")
        loaded.DatabaseSync = module.DatabaseSync;
    } catch {
      // No SQLite here: the file store serves.
    } finally {
      process.emitWarning = emit;
    }
  }
  return loaded.DatabaseSync;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS members (
  key TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  record TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS board (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  finished INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  summary TEXT NOT NULL,
  entry TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS board_order ON board (finished, updated_at DESC);
CREATE INDEX IF NOT EXISTS board_status ON board (status, updated_at DESC);
CREATE INDEX IF NOT EXISTS board_kind ON board (kind, finished, updated_at DESC);
CREATE TABLE IF NOT EXISTS board_counts (
  status TEXT NOT NULL,
  kind TEXT NOT NULL,
  finished INTEGER NOT NULL,
  count INTEGER NOT NULL,
  PRIMARY KEY (status, kind)
);
CREATE TRIGGER IF NOT EXISTS board_counted AFTER INSERT ON board BEGIN
  INSERT INTO board_counts (status, kind, finished, count)
  VALUES (NEW.status, NEW.kind, NEW.finished, 1)
  ON CONFLICT (status, kind) DO UPDATE SET count = count + 1;
END;
CREATE TRIGGER IF NOT EXISTS board_uncounted AFTER DELETE ON board BEGIN
  UPDATE board_counts SET count = count - 1
  WHERE status = OLD.status AND kind = OLD.kind;
END;
CREATE TRIGGER IF NOT EXISTS board_recounted AFTER UPDATE OF status, kind ON board
WHEN OLD.status IS NOT NEW.status OR OLD.kind IS NOT NEW.kind BEGIN
  UPDATE board_counts SET count = count - 1
  WHERE status = OLD.status AND kind = OLD.kind;
  INSERT INTO board_counts (status, kind, finished, count)
  VALUES (NEW.status, NEW.kind, NEW.finished, 1)
  ON CONFLICT (status, kind) DO UPDATE SET count = count + 1;
END;
CREATE TABLE IF NOT EXISTS claims (
  owner TEXT NOT NULL,
  resource TEXT NOT NULL,
  owner_name TEXT NOT NULL,
  note TEXT,
  claimed_at INTEGER NOT NULL,
  expires_at INTEGER,
  PRIMARY KEY (owner, resource)
);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  sent_at INTEGER NOT NULL,
  message TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_time ON messages (sent_at, id);
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  closed INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  task TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS tasks_time ON tasks (updated_at DESC);
`;

/** Statuses after which a task waits on nobody. */
const CLOSED_TASKS = new Set(["task_done", "task_blocked", "review_done"]);

const FINISHED_SQL = FINISHED_STATUSES.map((status) => `'${status}'`).join(
  ", ",
);

function parse<T>(row: Row | undefined, column: string): T | undefined {
  const text = row?.[column];
  return typeof text === "string" ? (JSON.parse(text) as T) : undefined;
}

function claimOf(row: Row): Claim {
  return {
    resource: String(row.resource),
    owner: String(row.owner),
    ownerName: String(row.owner_name),
    ...(typeof row.note === "string" ? { note: row.note } : {}),
    claimedAt: Number(row.claimed_at),
    ...(row.expires_at !== null && row.expires_at !== undefined
      ? { expiresAt: Number(row.expires_at) }
      : {}),
  };
}

type CacheKey = "members" | "tasks";

interface Connection {
  db: Database;
  statements: Map<string, Statement>;
  /** Reads this process folded, valid while the database's version holds. */
  cache: Map<string, unknown>;
  version: string;
}

const connections = new Map<string, Connection>();

/** Close every database this process opened, as a fresh process would
 * start; for tests. */
export function closeCollabDatabases(): void {
  for (const connection of connections.values())
    try {
      connection.db.close();
    } catch {}
  connections.clear();
}

/** Whether a group's directory holds a database already. */
export function hasDatabase(dir: string): boolean {
  return fs.existsSync(path.join(dir, DATABASE_FILE));
}

export class SqliteStore implements StoreBackend {
  /** The group's connection: this process's, opened again after
   * `closeCollabDatabases`. */
  private get connection(): Connection {
    return connections.get(this.dir) ?? this.open();
  }

  /** Open the group's database, creating it and importing a file store's
   * group once. Throws where SQLite can't open it; the caller falls back. */
  constructor(
    readonly dir: string,
    private readonly Database: DatabaseClass,
  ) {
    if (!connections.has(dir)) this.open();
  }

  private open(): Connection {
    const { dir } = this;
    fs.mkdirSync(dir, { recursive: true });
    const db = new this.Database(path.join(dir, DATABASE_FILE));
    try {
      db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
      db.exec("PRAGMA journal_mode = WAL");
      // With WAL, NORMAL keeps every commit atomic and survives a process
      // crash; only a power loss can drop the last commits.
      db.exec("PRAGMA synchronous = NORMAL");
      db.exec(SCHEMA);
    } catch (error) {
      db.close();
      throw error;
    }
    const connection: Connection = {
      db,
      statements: new Map<string, Statement>(),
      cache: new Map(),
      version: "",
    };
    connections.set(dir, connection);
    try {
      this.migrate();
    } catch (error) {
      connections.delete(dir);
      db.close();
      throw error;
    }
    return connection;
  }

  private statement(sql: string): Statement {
    let statement = this.connection.statements.get(sql);
    if (!statement) {
      statement = this.connection.db.prepare(sql);
      this.connection.statements.set(sql, statement);
    }
    return statement;
  }

  /**
   * A list read once and kept while no other connection commits
   * (`data_version` moves only with their commits); this connection's own
   * writes update or drop it as they go. Callers get a copy of the list,
   * and must not change its items.
   */
  private cached<T>(key: CacheKey, read: () => T[]): T[] {
    const connection = this.connection;
    const version = String(
      this.statement("PRAGMA data_version").get()?.data_version,
    );
    if (version !== connection.version) {
      connection.cache.clear();
      connection.version = version;
    }
    let list = connection.cache.get(key) as T[] | undefined;
    if (!list) {
      list = read();
      connection.cache.set(key, list);
    }
    return [...list];
  }

  /** Change a cached list in place, or drop it, after this connection
   * wrote. */
  private touch<T>(key: CacheKey, change?: (list: T[]) => void): void {
    const { cache } = this.connection;
    const list = cache.get(key) as T[] | undefined;
    if (!list) return;
    if (change) change(list);
    else cache.delete(key);
  }

  /** Run `body` in one transaction; `write` takes the write lock first, so
   * what it reads stays current until it commits. */
  private transaction<T>(body: () => T, write = true): T {
    const { db } = this.connection;
    db.exec(write ? "BEGIN IMMEDIATE" : "BEGIN");
    try {
      const value = body();
      db.exec("COMMIT");
      return value;
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {}
      // What the transaction wrote through to the cache is undone too.
      this.connection.cache.clear();
      throw error;
    }
  }

  /** Import a group the file store kept, once: its files stay but are no
   * longer read. */
  private migrate(): void {
    // The board's counts follow it through triggers; a database written
    // before them counts once.
    if (!this.statement("SELECT value FROM meta WHERE key = ?").get("counts"))
      this.transaction(() => {
        this.statement("DELETE FROM board_counts").run();
        this.statement(
          "INSERT INTO board_counts (status, kind, finished, count) SELECT status, kind, MAX(finished), COUNT(*) FROM board GROUP BY status, kind",
        ).run();
        this.statement(
          "INSERT OR REPLACE INTO meta (key, value) VALUES ('counts', '1')",
        ).run();
      });
    const done = this.statement("SELECT value FROM meta WHERE key = ?").get(
      "schema",
    );
    if (done) return;
    this.transaction(() => {
      if (this.statement("SELECT value FROM meta WHERE key = ?").get("schema"))
        return;
      for (const { value } of readJsonDir<MemberRecord>(
        path.join(this.dir, "members"),
      ))
        if (value.protocol === PROTOCOL) this.putMember(value);
      for (const { value } of readJsonDir<BoardEntry>(
        path.join(this.dir, "board"),
      ))
        this.putEntry(value, "insert");
      const claims =
        readJson<{ claims: Claim[] }>(path.join(this.dir, "claims.json"))
          ?.claims ?? [];
      for (const claim of claims) this.putClaim(claim);
      const messages = readJsonDir<CollabMessage>(
        path.join(this.dir, "messages"),
      )
        .map(({ value }) => value)
        .filter((message) => message.protocol === PROTOCOL)
        .sort(byTime);
      for (const message of messages) this.insertMessage(message);
      this.statement("INSERT INTO meta (key, value) VALUES (?, ?)").run(
        "schema",
        SCHEMA_VERSION,
      );
    });
  }

  // Members

  private putMember(record: MemberRecord): void {
    this.statement(
      "INSERT OR REPLACE INTO members (key, status, updated_at, record) VALUES (?, ?, ?, ?)",
    ).run(record.key, record.status, record.updatedAt, JSON.stringify(record));
    this.touch("members");
  }

  upsertMember(member: Omit<MemberRecord, "protocol">): MemberRecord {
    const record: MemberRecord = { protocol: PROTOCOL, ...member };
    this.putMember(record);
    return record;
  }

  member(key: string): MemberRecord | undefined {
    return parse<MemberRecord>(
      this.statement("SELECT record FROM members WHERE key = ?").get(key),
      "record",
    );
  }

  setStatus(key: string, status: MemberStatus, state?: string): void {
    this.transaction(() => {
      const member = this.member(key);
      if (!member) return;
      this.putMember({
        ...member,
        status,
        ...(state ? { state } : {}),
        updatedAt: Date.now(),
      });
    });
  }

  members(): MemberRecord[] {
    return this.cached("members", () =>
      this.statement("SELECT record FROM members")
        .all()
        .map((row) => parse<MemberRecord>(row, "record") as MemberRecord)
        .sort(
          (left, right) =>
            Number(right.status === "live") - Number(left.status === "live") ||
            left.name.localeCompare(right.name),
        ),
    );
  }

  // Messages

  /** Store a message unless stored, folding it into its task. Inside a
   * transaction. */
  private insertMessage(record: CollabMessage): boolean {
    const inserted = this.statement(
      "INSERT OR IGNORE INTO messages (id, sent_at, message) VALUES (?, ?, ?)",
    ).run(record.id, record.sentAt, JSON.stringify(record));
    if (Number(inserted.changes) === 0) return false;
    if (!record.task || record.type === "message") return true;
    const tasks = new Map<string, TaskView>();
    const known = parse<TaskView>(
      this.statement("SELECT task FROM tasks WHERE id = ?").get(record.task),
      "task",
    );
    if (known) tasks.set(known.id, known);
    foldTask(tasks, record);
    const task = tasks.get(record.task);
    if (task) {
      this.statement(
        "INSERT OR REPLACE INTO tasks (id, closed, updated_at, task) VALUES (?, ?, ?, ?)",
      ).run(
        task.id,
        CLOSED_TASKS.has(task.status) ? 1 : 0,
        task.updatedAt,
        JSON.stringify(task),
      );
      this.touch<TaskView>("tasks", (list) => {
        const index = list.findIndex((each) => each.id === task.id);
        if (index >= 0) list.splice(index, 1);
        // Newest first: a new message's task usually goes first.
        let at = 0;
        while (
          at < list.length &&
          (list[at] as TaskView).updatedAt > task.updatedAt
        )
          at += 1;
        list.splice(at, 0, task);
      });
    }
    return true;
  }

  log(message: Omit<CollabMessage, "protocol">): CollabMessage {
    const record: CollabMessage = { protocol: PROTOCOL, ...message };
    this.transaction(() => this.insertMessage(record));
    return record;
  }

  messages(limit = 50): CollabMessage[] {
    return this.statement(
      "SELECT message FROM messages ORDER BY sent_at DESC, id DESC LIMIT ?",
    )
      .all(limit)
      .map((row) => parse<CollabMessage>(row, "message") as CollabMessage);
  }

  tasks(): TaskView[] {
    return this.cached("tasks", () =>
      this.statement("SELECT task FROM tasks ORDER BY updated_at DESC")
        .all()
        .map((row) => parse<TaskView>(row, "task") as TaskView),
    );
  }

  // Blackboard

  /** Insert an entry, or with `update` change it in place, so the count
   * triggers see an update rather than a replace. */
  private putEntry(entry: BoardEntry, mode: "insert" | "update") {
    return this.statement(
      mode === "insert"
        ? "INSERT OR IGNORE INTO board (id, kind, status, finished, updated_at, summary, entry) VALUES (?, ?, ?, ?, ?, ?, ?)"
        : "INSERT INTO board (id, kind, status, finished, updated_at, summary, entry) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET kind = excluded.kind, status = excluded.status, finished = excluded.finished, updated_at = excluded.updated_at, summary = excluded.summary, entry = excluded.entry",
    ).run(
      entry.id,
      entry.kind,
      entry.status,
      isFinished(entry) ? 1 : 0,
      entry.updatedAt,
      JSON.stringify(summaryOf(entry)),
      JSON.stringify(entry),
    );
  }

  post(
    entry: Omit<
      BoardEntry,
      "protocol" | "createdAt" | "updatedAt" | "status" | "history"
    > & { createdAt?: number; status?: BoardStatus },
  ): BoardEntry {
    const at = entry.createdAt ?? Date.now();
    const record: BoardEntry = {
      protocol: PROTOCOL,
      ...entry,
      status: entry.status ?? "open",
      createdAt: at,
      updatedAt: at,
      history: [],
    };
    if (Number(this.putEntry(record, "insert").changes) > 0) return record;
    return this.entry(record.id) ?? record;
  }

  entry(id: string): BoardEntry | undefined {
    return parse<BoardEntry>(
      this.statement("SELECT entry FROM board WHERE id = ?").get(id),
      "entry",
    );
  }

  update(
    id: string,
    by: string,
    change: { status?: BoardStatus; note?: string; at?: number },
  ): BoardEntry {
    return this.transaction(() => {
      const entry = this.entry(id);
      if (!entry) throw new Error(`No board entry ${id}`);
      const at = change.at ?? Date.now();
      // A retried update finds its own history entry and changes nothing.
      if (
        entry.history.some(
          (each) =>
            each.at === at &&
            each.by === by &&
            each.status === change.status &&
            each.note === change.note,
        )
      )
        return entry;
      const updated: BoardEntry = {
        ...entry,
        ...(change.status ? { status: change.status } : {}),
        updatedAt: at,
        history: [
          ...entry.history,
          {
            at,
            by,
            ...(change.status ? { status: change.status } : {}),
            ...(change.note ? { note: change.note } : {}),
          },
        ],
      };
      this.putEntry(updated, "update");
      return updated;
    });
  }

  private select(
    column: "summary" | "entry",
    options: {
      kind?: BoardKind;
      status?: BoardStatus;
      all?: boolean;
      limit?: number;
    },
  ): Row[] {
    const where: string[] = [];
    const values: Value[] = [];
    if (options.kind) {
      where.push("kind = ?");
      values.push(options.kind);
    }
    if (options.status) {
      where.push("status = ?");
      values.push(options.status);
    } else if (!options.all) where.push("finished = 0");
    const limit = options.limit ?? 50;
    values.push(Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : -1);
    return this.statement(
      `SELECT ${column} FROM board${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY finished, updated_at DESC LIMIT ?`,
    ).all(...values);
  }

  summaries(
    options: {
      kind?: BoardKind;
      status?: BoardStatus;
      all?: boolean;
      limit?: number;
    } = {},
  ): BoardSummary[] {
    return this.select("summary", options).map(
      (row) => parse<BoardSummary>(row, "summary") as BoardSummary,
    );
  }

  board(
    options: {
      kind?: BoardKind;
      status?: BoardStatus;
      all?: boolean;
      limit?: number;
    } = {},
  ): BoardEntry[] {
    return this.select("entry", options).map(
      (row) => parse<BoardEntry>(row, "entry") as BoardEntry,
    );
  }

  boardCounts(): {
    total: number;
    byStatus: Record<BoardStatus, number>;
    openByKind: Partial<Record<BoardKind, number>>;
  } {
    const byStatus = Object.fromEntries(
      BOARD_STATUSES.map((status) => [status, 0]),
    ) as Record<BoardStatus, number>;
    const openByKind: Partial<Record<BoardKind, number>> = {};
    let total = 0;
    for (const row of this.statement(
      "SELECT status, kind, finished, count FROM board_counts WHERE count > 0",
    ).all()) {
      const count = Number(row.count);
      const status = String(row.status) as BoardStatus;
      const kind = String(row.kind) as BoardKind;
      total += count;
      byStatus[status] = (byStatus[status] ?? 0) + count;
      if (Number(row.finished) === 0)
        openByKind[kind] = (openByKind[kind] ?? 0) + count;
    }
    return { total, byStatus, openByKind };
  }

  // Claims

  private putClaim(claim: Claim): void {
    this.statement(
      "INSERT OR REPLACE INTO claims (owner, resource, owner_name, note, claimed_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(
      claim.owner,
      claim.resource,
      claim.ownerName,
      claim.note ?? null,
      claim.claimedAt,
      claim.expiresAt ?? null,
    );
  }

  /** Owners whose claims hold: live members, and paused ones within the
   * grace period. */
  private holders(now: number): Set<string> {
    return new Set(
      this.statement(
        "SELECT key FROM members WHERE status = 'live' OR (status = 'paused' AND updated_at > ?)",
      )
        .all(now - CLAIM_GRACE_MS)
        .map((row) => String(row.key)),
    );
  }

  /** The claims that still hold: unexpired, of a holding owner. */
  private holding(now: number, owner?: string): Claim[] {
    const holders = this.holders(now);
    const rows = owner
      ? this.statement(
          "SELECT * FROM claims WHERE owner = ? AND (expires_at IS NULL OR expires_at > ?)",
        ).all(owner, now)
      : this.statement(
          "SELECT * FROM claims WHERE expires_at IS NULL OR expires_at > ? ORDER BY claimed_at, rowid",
        ).all(now);
    return rows
      .filter((row) => holders.has(String(row.owner)))
      .map((row) => claimOf(row));
  }

  claims(): Claim[] {
    return this.holding(Date.now());
  }

  claim(
    owner: Pick<MemberRecord, "key" | "name">,
    resources: string[],
    options: { note?: string; ttlMs?: number } = {},
  ): ClaimOutcome {
    return this.transaction((): ClaimOutcome => {
      const now = Date.now();
      const current = this.holding(now);
      const conflicts = current.filter(
        (claim) =>
          claim.owner !== owner.key &&
          resources.some((resource) => overlaps(resource, claim.resource)),
      );
      if (conflicts.length > 0) return { ok: false, conflicts };
      // Claims that no longer hold go as the table changes.
      this.statement(
        "DELETE FROM claims WHERE expires_at IS NOT NULL AND expires_at <= ?",
      ).run(now);
      const fresh = [...new Set(resources)].map(
        (resource): Claim => ({
          resource,
          owner: owner.key,
          ownerName: owner.name,
          ...(options.note ? { note: options.note } : {}),
          claimedAt: now,
          ...(options.ttlMs ? { expiresAt: now + options.ttlMs } : {}),
        }),
      );
      for (const claim of fresh) this.putClaim(claim);
      return { ok: true, claims: fresh };
    });
  }

  release(owner: string, resources?: string[]): Claim[] {
    return this.transaction(() => {
      const now = Date.now();
      const released = this.holding(now, owner).filter(
        (claim) => !resources || resources.includes(claim.resource),
      );
      if (!resources)
        this.statement("DELETE FROM claims WHERE owner = ?").run(owner);
      else
        for (const resource of resources)
          this.statement(
            "DELETE FROM claims WHERE owner = ? AND resource = ?",
          ).run(owner, resource);
      return released;
    });
  }

  // Retention

  prune(retention: Retention): {
    messages: number;
    entries: number;
    tasks: number;
  } {
    this.connection.cache.clear();
    return this.transaction(() => {
      const keep = (table: string, where: string, order: string, n: number) =>
        Number(
          this.statement(
            `DELETE FROM ${table} WHERE ${where ? `${where} AND ` : ""}rowid NOT IN (SELECT rowid FROM ${table}${where ? ` WHERE ${where}` : ""} ORDER BY ${order} LIMIT ?)`,
          ).run(n).changes,
        );
      return {
        messages: keep(
          "messages",
          "",
          "sent_at DESC, id DESC",
          retention.messages,
        ),
        entries: keep(
          "board",
          `status IN (${FINISHED_SQL})`,
          "updated_at DESC",
          retention.finishedEntries,
        ),
        tasks: keep(
          "tasks",
          "closed = 1",
          "updated_at DESC",
          retention.closedTasks,
        ),
      };
    });
  }

  /** Rows per table, for reports and tests. */
  counts(): Record<string, number> {
    return Object.fromEntries(
      ["members", "board", "claims", "messages", "tasks"].map((table) => [
        table,
        Number(
          this.statement(`SELECT COUNT(*) AS count FROM ${table}`).get()?.count,
        ),
      ]),
    );
  }
}
