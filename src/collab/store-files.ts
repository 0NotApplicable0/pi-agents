/**
 * The file store of one collab group, where SQLite is unavailable: its
 * members, blackboard, advisory claims, and the log of structured messages,
 * in files in the group's directory.
 *
 *   <group>/
 *     members/<key>.json        one per member, rewritten as its state moves
 *     board/<id>.json           blackboard entries, created once, updated
 *                               under the lock
 *     board.jsonl               the board's index: a summary line per post
 *                               and update
 *     claims.json               the claim table, changed under the lock
 *     messages/<time>-<id>.json the message log
 *     messages.jsonl            the log's index: a line per message, which
 *                               the task table folds
 *     .lock/                    the group's lock directory
 *
 * Every write is atomic, and writes that callers retry (posts, logged
 * messages) are create-once by ID, so a retried tool call after a crash
 * neither duplicates nor tears anything. Members live while their status
 * says so: the session host marks stopped agents exited, which releases
 * their claims.
 *
 * The entry and message files are the record; the two indexes let reads
 * skip scanning them. A process keeps a fold of each index and reads only
 * what was appended since its last read, so reads cost what changed, not
 * what exists. A write repairs an index line a crash lost, and a group
 * from before the indexes gets them built from its files once. Members are
 * cached per process too, refreshed when their directory changes and at
 * least every few seconds, so claim checks don't read a file per claim.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
  appendJsonLine,
  appendJsonLines,
  createJsonOnce,
  JsonlTail,
  readJson,
  readJsonDir,
  safeName,
  withLock,
  writeJsonAtomic,
} from "./files.js";
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
  foldTask,
  isFinished,
  type MemberRecord,
  type MemberStatus,
  overlaps,
  PROTOCOL,
  type StoreBackend,
  summaryOf,
  type TaskView,
} from "./store-model.js";

/** How many recent messages a process keeps in memory. */
const RECENT_MESSAGES = 200;
/** How long cached members are trusted while their directory looks
 * unchanged. */
const MEMBERS_TTL_MS = 2_000;
/** A directory changed this close to when its members were read may have
 * changed again within the same clock tick, so its copy isn't trusted. */
const RACY_MS = 50;

/** One process's view of a group, shared by its stores. */
interface GroupCache {
  members?: {
    mtimeMs: number;
    loadedAt: number;
    byKey: Map<string, MemberRecord>;
  };
  board?: { tail: JsonlTail<BoardSummary>; byId: Map<string, BoardSummary> };
  log?: {
    tail: JsonlTail<CollabMessage>;
    seen: Set<string>;
    recent: CollabMessage[];
    tasks: Map<string, TaskView>;
  };
  /** Whether this process made sure the indexes exist. */
  indexed?: { board?: boolean; log?: boolean };
}

const caches = new Map<string, GroupCache>();

/** Drop what this process cached of every group, so stores read the
 * files again as a fresh process would. */
export function forgetFileCaches(): void {
  caches.clear();
}

function cacheOf(dir: string): GroupCache {
  let cache = caches.get(dir);
  if (!cache) {
    cache = {};
    caches.set(dir, cache);
  }
  return cache;
}

export class FileStore implements StoreBackend {
  readonly group: string;
  readonly dir: string;
  private readonly cache: GroupCache;

  constructor(root: string, group: string) {
    this.group = group;
    this.dir = path.join(root, group);
    this.cache = cacheOf(this.dir);
  }

  private lock<T>(body: () => T): T {
    return withLock(path.join(this.dir, ".lock"), body);
  }

  // Members

  private memberFile(key: string): string {
    return path.join(this.dir, "members", `${safeName(key)}.json`);
  }

  private membersDir(): string {
    return path.join(this.dir, "members");
  }

  /** The members as this process last read them, read again when their
   * directory changed (each write renames a file into it), when it changed
   * just before the read, or when the copy is a few seconds old. */
  private memberMap(): Map<string, MemberRecord> {
    let mtimeMs = -1;
    try {
      mtimeMs = fs.statSync(this.membersDir()).mtimeMs;
    } catch {}
    const now = Date.now();
    const cached = this.cache.members;
    if (
      cached &&
      cached.mtimeMs === mtimeMs &&
      cached.loadedAt - mtimeMs > RACY_MS &&
      now - cached.loadedAt < MEMBERS_TTL_MS
    )
      return cached.byKey;
    const byKey = new Map<string, MemberRecord>();
    for (const { value } of readJsonDir<MemberRecord>(this.membersDir()))
      if (value.protocol === PROTOCOL) byKey.set(value.key, value);
    this.cache.members = { mtimeMs, loadedAt: now, byKey };
    return byKey;
  }

  /** Write a member and keep this process's copy current. */
  private writeMember(record: MemberRecord): void {
    writeJsonAtomic(this.memberFile(record.key), record);
    const cached = this.cache.members;
    if (!cached) return;
    cached.byKey.set(record.key, record);
    try {
      cached.mtimeMs = fs.statSync(this.membersDir()).mtimeMs;
    } catch {}
  }

  /** Register or refresh a member. */
  upsertMember(member: Omit<MemberRecord, "protocol">): MemberRecord {
    const record: MemberRecord = { protocol: PROTOCOL, ...member };
    this.writeMember(record);
    return record;
  }

  member(key: string): MemberRecord | undefined {
    return this.memberMap().get(key);
  }

  /** Change a member's status and state, keeping its entry. */
  setStatus(key: string, status: MemberStatus, state?: string): void {
    // The file, not the cache: a status write must not lose another
    // process's newer one.
    const member = readJson<MemberRecord>(this.memberFile(key));
    if (!member) return;
    this.writeMember({
      ...member,
      status,
      ...(state ? { state } : {}),
      updatedAt: Date.now(),
    });
  }

  /** Every member, live ones first. */
  members(): MemberRecord[] {
    return [...this.memberMap().values()].sort(
      (left, right) =>
        Number(right.status === "live") - Number(left.status === "live") ||
        left.name.localeCompare(right.name),
    );
  }

  // Messages

  private logName(message: Pick<CollabMessage, "sentAt" | "id">): string {
    return `${String(message.sentAt).padStart(15, "0")}-${safeName(message.id)}.json`;
  }

  private logIndex(): string {
    return path.join(this.dir, "messages.jsonl");
  }

  /** The log's fold, current with its index. */
  private logState(): NonNullable<GroupCache["log"]> {
    this.ensureLogIndex();
    let state = this.cache.log;
    if (!state) {
      const fresh: NonNullable<GroupCache["log"]> = {
        seen: new Set(),
        recent: [],
        tasks: new Map(),
        tail: new JsonlTail<CollabMessage>(
          this.logIndex(),
          (message) => {
            if (message.protocol !== PROTOCOL || fresh.seen.has(message.id))
              return;
            fresh.seen.add(message.id);
            fresh.recent.push(message);
            if (fresh.recent.length > RECENT_MESSAGES * 2)
              fresh.recent = fresh.recent.sort(byTime).slice(-RECENT_MESSAGES);
            foldTask(fresh.tasks, message);
          },
          () => {
            fresh.seen.clear();
            fresh.recent = [];
            fresh.tasks.clear();
          },
        ),
      };
      state = fresh;
      this.cache.log = state;
    }
    state.tail.catchUp();
    return state;
  }

  /** Index a group's messages that came before the index, once. */
  private ensureLogIndex(): void {
    if (!this.cache.indexed) this.cache.indexed = {};
    const indexed = this.cache.indexed;
    if (indexed.log) return;
    if (!fs.existsSync(this.logIndex())) {
      const dir = path.join(this.dir, "messages");
      if (fs.existsSync(dir))
        this.lock(() => {
          if (fs.existsSync(this.logIndex())) return;
          appendJsonLines(
            this.logIndex(),
            readJsonDir<CollabMessage>(dir).map(({ value }) => value),
          );
        });
    }
    indexed.log = true;
  }

  /** Log a message that `agent_send`'s path delivered. Safe to repeat. */
  log(message: Omit<CollabMessage, "protocol">): CollabMessage {
    const record: CollabMessage = { protocol: PROTOCOL, ...message };
    this.ensureLogIndex();
    const created = createJsonOnce(
      path.join(this.dir, "messages", this.logName(record)),
      record,
    );
    // A retry after a crash between the two writes adds the lost line.
    if (created || !this.logState().seen.has(record.id))
      appendJsonLine(this.logIndex(), record);
    return record;
  }

  /** The newest messages, newest first. */
  messages(limit = 50): CollabMessage[] {
    if (limit <= RECENT_MESSAGES) {
      const recent = this.logState().recent;
      return [...recent].sort(byTime).slice(-limit).reverse();
    }
    const dir = path.join(this.dir, "messages");
    let names: string[];
    try {
      names = fs.readdirSync(dir).filter((name) => name.endsWith(".json"));
    } catch {
      return [];
    }
    return names
      .sort()
      .slice(-limit)
      .reverse()
      .flatMap((name) => {
        const value = readJson<CollabMessage>(path.join(dir, name));
        return value ? [value] : [];
      });
  }

  /** The task table: every structured task the group's messages opened,
   * with its latest state, requester, and assignees, newest first. Kept
   * as state from the whole log, so old tasks never drop out. */
  tasks(): TaskView[] {
    return [...this.logState().tasks.values()]
      .map((task) => ({ ...task }))
      .sort((left, right) => right.updatedAt - left.updatedAt);
  }

  // Blackboard

  private boardFile(id: string): string {
    return path.join(this.dir, "board", `${safeName(id)}.json`);
  }

  private boardIndex(): string {
    return path.join(this.dir, "board.jsonl");
  }

  /** The board's summaries, current with its index. */
  private boardState(): Map<string, BoardSummary> {
    this.ensureBoardIndex();
    let state = this.cache.board;
    if (!state) {
      const byId = new Map<string, BoardSummary>();
      state = {
        byId,
        tail: new JsonlTail<BoardSummary>(
          this.boardIndex(),
          (summary) => {
            const known = byId.get(summary.id);
            if (!known || summary.updatedAt >= known.updatedAt)
              byId.set(summary.id, summary);
          },
          () => byId.clear(),
        ),
      };
      this.cache.board = state;
    }
    state.tail.catchUp();
    return state.byId;
  }

  /** Index a group's entries that came before the index, once. */
  private ensureBoardIndex(): void {
    if (!this.cache.indexed) this.cache.indexed = {};
    const indexed = this.cache.indexed;
    if (indexed.board) return;
    if (!fs.existsSync(this.boardIndex())) {
      const dir = path.join(this.dir, "board");
      if (fs.existsSync(dir))
        this.lock(() => {
          if (fs.existsSync(this.boardIndex())) return;
          appendJsonLines(
            this.boardIndex(),
            readJsonDir<BoardEntry>(dir).map(({ value }) => summaryOf(value)),
          );
        });
    }
    indexed.board = true;
  }

  /** Index an entry unless the index has this version of it already. */
  private indexEntry(entry: BoardEntry, force: boolean): void {
    const known = force ? undefined : this.boardState().get(entry.id);
    if (
      force ||
      !known ||
      known.updatedAt !== entry.updatedAt ||
      known.status !== entry.status
    )
      appendJsonLine(this.boardIndex(), summaryOf(entry));
  }

  /** Post an entry once; a repeat with the same ID returns the stored
   * entry. */
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
    this.ensureBoardIndex();
    if (createJsonOnce(this.boardFile(record.id), record)) {
      this.indexEntry(record, true);
      return record;
    }
    const stored = this.entry(record.id) ?? record;
    this.indexEntry(stored, false);
    return stored;
  }

  entry(id: string): BoardEntry | undefined {
    return readJson<BoardEntry>(this.boardFile(id));
  }

  /** Change an entry's status or append a note, under the lock. */
  update(
    id: string,
    by: string,
    change: { status?: BoardStatus; note?: string; at?: number },
  ): BoardEntry {
    return this.lock(() => {
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
      ) {
        this.indexEntry(entry, false);
        return entry;
      }
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
      writeJsonAtomic(this.boardFile(id), updated);
      this.indexEntry(updated, true);
      return updated;
    });
  }

  /** Summaries of entries, from the index: unfinished ones first, then
   * newest first. Finished entries (done, dropped) are left out unless
   * `all` or a status asks for them. */
  summaries(
    options: {
      kind?: BoardKind;
      status?: BoardStatus;
      all?: boolean;
      limit?: number;
    } = {},
  ): BoardSummary[] {
    return [...this.boardState().values()]
      .filter((entry) => !options.kind || entry.kind === options.kind)
      .filter((entry) =>
        options.status
          ? entry.status === options.status
          : options.all || !isFinished(entry),
      )
      .sort(
        (left, right) =>
          Number(isFinished(left)) - Number(isFinished(right)) ||
          right.updatedAt - left.updatedAt,
      )
      .slice(0, options.limit ?? 50);
  }

  /** Entries in full, chosen like `summaries`: only these files are read. */
  board(
    options: {
      kind?: BoardKind;
      status?: BoardStatus;
      all?: boolean;
      limit?: number;
    } = {},
  ): BoardEntry[] {
    return this.summaries(options).flatMap((summary) => {
      const entry = this.entry(summary.id);
      return entry ? [entry] : [];
    });
  }

  /** How many entries the board has, by status and, for open ones, by
   * kind. */
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
    for (const entry of this.boardState().values()) {
      total += 1;
      byStatus[entry.status] = (byStatus[entry.status] ?? 0) + 1;
      if (!isFinished(entry))
        openByKind[entry.kind] = (openByKind[entry.kind] ?? 0) + 1;
    }
    return { total, byStatus, openByKind };
  }

  // Claims

  private claimsFile(): string {
    return path.join(this.dir, "claims.json");
  }

  private readClaims(): Claim[] {
    return readJson<{ claims: Claim[] }>(this.claimsFile())?.claims ?? [];
  }

  /** Whether a claim still holds: unexpired, and its owner is live, or
   * paused within the grace period. */
  private holds(
    claim: Claim,
    now: number,
    members: Map<string, MemberRecord>,
  ): boolean {
    if (claim.expiresAt !== undefined && claim.expiresAt <= now) return false;
    const owner = members.get(claim.owner);
    if (!owner || owner.status === "exited") return false;
    if (owner.status === "live") return true;
    return now - owner.updatedAt < CLAIM_GRACE_MS;
  }

  claims(): Claim[] {
    const now = Date.now();
    const members = this.memberMap();
    return this.readClaims().filter((claim) => this.holds(claim, now, members));
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
    return this.lock(() => {
      const now = Date.now();
      const members = this.memberMap();
      const current = this.readClaims().filter((claim) =>
        this.holds(claim, now, members),
      );
      const conflicts = current.filter(
        (claim) =>
          claim.owner !== owner.key &&
          resources.some((resource) => overlaps(resource, claim.resource)),
      );
      if (conflicts.length > 0) return { ok: false, conflicts };
      const kept = current.filter(
        (claim) =>
          claim.owner !== owner.key || !resources.includes(claim.resource),
      );
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
      writeJsonAtomic(this.claimsFile(), { claims: [...kept, ...fresh] });
      return { ok: true, claims: fresh };
    });
  }

  /** Release an owner's claims: these resources, or all of them. Returns
   * what it released. */
  release(owner: string, resources?: string[]): Claim[] {
    return this.lock(() => {
      const now = Date.now();
      const members = this.memberMap();
      const current = this.readClaims().filter((claim) =>
        this.holds(claim, now, members),
      );
      const released = current.filter(
        (claim) =>
          claim.owner === owner &&
          (!resources || resources.includes(claim.resource)),
      );
      writeJsonAtomic(this.claimsFile(), {
        claims: current.filter((claim) => !released.includes(claim)),
      });
      return released;
    });
  }

  /** The file store keeps everything: retention needs the SQLite store. */
  prune(): { messages: number; entries: number; tasks: number } {
    return { messages: 0, entries: 0, tasks: 0 };
  }
}
