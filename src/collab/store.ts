/**
 * The store of one collab group: its members, blackboard, advisory claims,
 * and the log of structured messages, in the group's directory under the
 * session's collab directory.
 *
 * A group lives in a SQLite database (`collab.db`, see `store-sqlite.ts`)
 * where the runtime ships `node:sqlite`, as Node 22.13+ and Bun do, and in
 * plain files (`store-files.ts`) where it doesn't or the database can't
 * open. A group the file store kept moves into the database the first time
 * a process with SQLite opens it. Either way every write is atomic and the
 * writes callers retry are create-once by ID, so a retried tool call after
 * a crash neither duplicates nor tears anything.
 *
 * The database keeps what retention allows (`DEFAULT_RETENTION`, or the
 * `piAgents.collabRetain*` settings): the newest messages, finished board
 * entries, and closed tasks. Pruning runs on a timer after writes, off the
 * tool calls that write.
 */

import * as path from "node:path";
import { FileStore, forgetFileCaches } from "./store-files.js";
import {
  type BoardEntry,
  type BoardKind,
  type BoardStatus,
  type BoardSummary,
  type Claim,
  type ClaimOutcome,
  type CollabMessage,
  DEFAULT_RETENTION,
  type MemberRecord,
  type MemberStatus,
  type Retention,
  type StoreBackend,
  type TaskView,
} from "./store-model.js";
import {
  closeCollabDatabases,
  hasDatabase,
  SqliteStore,
  sqliteDatabase,
} from "./store-sqlite.js";

export * from "./store-model.js";

/** How often a group is pruned at most, while it is written. */
const PRUNE_INTERVAL_MS = 30_000;

let retention: Retention = { ...DEFAULT_RETENTION };

/** Set what stores keep from now on (the session's settings). */
export function configureRetention(next: Partial<Retention>): void {
  retention = { ...DEFAULT_RETENTION, ...next };
}

export function currentRetention(): Retention {
  return { ...retention };
}

/** Groups whose prune is due or pending, by directory. */
const pruning = new Map<
  string,
  { last: number; timer?: ReturnType<typeof setTimeout> }
>();

/** Drop what this process cached and opened of every group, so stores
 * read their group again as a fresh process would. */
export function forgetCollabCaches(): void {
  forgetFileCaches();
  closeCollabDatabases();
  for (const state of pruning.values())
    if (state.timer) clearTimeout(state.timer);
  pruning.clear();
}

/** The backend of a group: its database where SQLite works here, else its
 * files. */
function openBackend(dir: string): StoreBackend {
  const Database = sqliteDatabase();
  if (Database)
    try {
      return new SqliteStore(dir, Database);
    } catch (error) {
      // A database that exists but won't open holds the group's state: the
      // files would show an empty group, so fail loudly instead.
      if (hasDatabase(dir)) throw error;
    }
  return new FileStore(path.dirname(dir), path.basename(dir));
}

type BoardQuery = {
  kind?: BoardKind;
  status?: BoardStatus;
  all?: boolean;
  limit?: number;
};

export class CollabStore {
  readonly group: string;
  readonly dir: string;
  /** Which store keeps the group. */
  readonly kind: "sqlite" | "files";
  private readonly backend: StoreBackend;

  constructor(root: string, group: string) {
    this.group = group;
    this.dir = path.join(root, group);
    this.backend = openBackend(this.dir);
    this.kind = this.backend instanceof SqliteStore ? "sqlite" : "files";
  }

  /** Prune soon, unless a prune ran lately: on an unreferenced timer, so
   * it neither delays the write nor keeps the process alive. */
  private wrote(): void {
    if (this.kind !== "sqlite") return;
    const state = pruning.get(this.dir) ?? { last: 0 };
    pruning.set(this.dir, state);
    if (state.timer || Date.now() - state.last < PRUNE_INTERVAL_MS) return;
    state.timer = setTimeout(() => {
      state.timer = undefined;
      state.last = Date.now();
      try {
        this.prune();
      } catch {
        // A busy database prunes next time.
      }
    }, 1_000);
    state.timer.unref?.();
  }

  /** Drop what retention lets go now; returns how much went. */
  prune(keep: Retention = retention): {
    messages: number;
    entries: number;
    tasks: number;
  } {
    return this.backend.prune(keep);
  }

  // Members

  /** Register or refresh a member. */
  upsertMember(member: Omit<MemberRecord, "protocol">): MemberRecord {
    return this.backend.upsertMember(member);
  }

  member(key: string): MemberRecord | undefined {
    return this.backend.member(key);
  }

  /** Change a member's status and state, keeping its entry. */
  setStatus(key: string, status: MemberStatus, state?: string): void {
    this.backend.setStatus(key, status, state);
  }

  /** Every member, live ones first. */
  members(): MemberRecord[] {
    return this.backend.members();
  }

  // Messages

  /** Log a message that `agent_send`'s path delivered. Safe to repeat. */
  log(message: Omit<CollabMessage, "protocol">): CollabMessage {
    const record = this.backend.log(message);
    this.wrote();
    return record;
  }

  /** The newest messages, newest first. */
  messages(limit = 50): CollabMessage[] {
    return this.backend.messages(limit);
  }

  /** The task table: every structured task the group's messages opened,
   * with its latest state, requester, and assignees, newest first. Kept
   * apart from the log, so tasks outlive the messages retention drops. */
  tasks(): TaskView[] {
    return this.backend.tasks();
  }

  // Blackboard

  /** Post an entry once; a repeat with the same ID returns the stored
   * entry. */
  post(
    entry: Omit<
      BoardEntry,
      "protocol" | "createdAt" | "updatedAt" | "status" | "history"
    > & { createdAt?: number; status?: BoardStatus },
  ): BoardEntry {
    const record = this.backend.post(entry);
    this.wrote();
    return record;
  }

  entry(id: string): BoardEntry | undefined {
    return this.backend.entry(id);
  }

  /** Change an entry's status or append a note, atomically. */
  update(
    id: string,
    by: string,
    change: { status?: BoardStatus; note?: string; at?: number },
  ): BoardEntry {
    const record = this.backend.update(id, by, change);
    this.wrote();
    return record;
  }

  /** Summaries of entries: unfinished ones first, then newest first.
   * Finished entries (done, dropped) are left out unless `all` or a status
   * asks for them. */
  summaries(options: BoardQuery = {}): BoardSummary[] {
    return this.backend.summaries(options);
  }

  /** Entries in full, chosen like `summaries`. */
  board(options: BoardQuery = {}): BoardEntry[] {
    return this.backend.board(options);
  }

  /** How many entries the board has, by status and, for open ones, by
   * kind. */
  boardCounts(): {
    total: number;
    byStatus: Record<BoardStatus, number>;
    openByKind: Partial<Record<BoardKind, number>>;
  } {
    return this.backend.boardCounts();
  }

  // Claims

  /** The claims that hold: unexpired, and their owner is live, or paused
   * within the grace period. */
  claims(): Claim[] {
    return this.backend.claims();
  }

  /**
   * Claim resources, all or nothing. Resources the owner already holds are
   * renewed; a resource that overlaps another owner's claim fails the
   * whole call and returns the conflicts.
   */
  claim(
    owner: Pick<MemberRecord, "key" | "name">,
    resources: string[],
    options: { note?: string; ttlMs?: number } = {},
  ): ClaimOutcome {
    return this.backend.claim(owner, resources, options);
  }

  /** Release an owner's claims: these resources, or all of them. Returns
   * what it released. */
  release(owner: string, resources?: string[]): Claim[] {
    return this.backend.release(owner, resources);
  }
}
