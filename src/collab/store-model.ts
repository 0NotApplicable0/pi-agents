/** The collab store's records and the rules both backends share. */

import * as path from "node:path";

export const PROTOCOL = 1;

/** How long the claims of a paused member hold, so it can resume its work
 * before others take it. */
export const CLAIM_GRACE_MS = 10 * 60_000;

export type MemberStatus = "live" | "paused" | "exited";

export interface MemberRecord {
  protocol: number;
  /** `agent-<agent id>`, or `pi` for the parent. */
  key: string;
  /** Absent for the parent. */
  agentId?: string;
  name: string;
  role: string;
  group: string;
  /** Its sub-team, and whether it leads it. */
  team?: string;
  lead?: boolean;
  /** The directory its path claims are relative to. */
  cwd: string;
  joinedAt: number;
  updatedAt: number;
  /** The agent's state as the session last saw it, such as working or
   * idle. */
  state: string;
  status: MemberStatus;
}

export const TASK_TYPES = [
  "task_req",
  "task_ack",
  "task_clarify",
  "task_done",
  "task_blocked",
] as const;
/** Requests that open a task, like `task_req`: a handoff of work, and a
 * request for review, answered with `review_done`. */
export const OPENING_TYPES = ["task_req", "handoff", "review_req"] as const;
export const MESSAGE_TYPES = [
  "message",
  ...TASK_TYPES,
  "handoff",
  "review_req",
  "review_done",
] as const;
export type MessageType = (typeof MESSAGE_TYPES)[number];

export interface CollabMessage {
  protocol: number;
  id: string;
  type: MessageType;
  /** The task a structured message belongs to. */
  task?: string;
  /** Member keys and names of sender and recipient. */
  from: string;
  fromName: string;
  to: string;
  toName: string;
  text: string;
  /** References: `board:<id>`, `path:<path>`, `claim:<resource>`, URLs. */
  refs: string[];
  mode: "steer" | "followUp";
  sentAt: number;
}

export const BOARD_KINDS = [
  "finding",
  "decision",
  "todo",
  "question",
  "note",
] as const;
export type BoardKind = (typeof BOARD_KINDS)[number];
export const BOARD_STATUSES = ["open", "doing", "done", "dropped"] as const;
export type BoardStatus = (typeof BOARD_STATUSES)[number];

export interface BoardEntry {
  protocol: number;
  id: string;
  kind: BoardKind;
  title: string;
  body: string;
  refs: string[];
  author: string;
  authorName: string;
  createdAt: number;
  updatedAt: number;
  status: BoardStatus;
  history: Array<{
    at: number;
    by: string;
    status?: BoardStatus;
    note?: string;
  }>;
}

export interface Claim {
  resource: string;
  owner: string;
  ownerName: string;
  note?: string;
  claimedAt: number;
  expiresAt?: number;
}

export type ClaimOutcome =
  | { ok: true; claims: Claim[] }
  | { ok: false; conflicts: Claim[] };

/**
 * Normalize a claim resource: `item:<id>` and `key:<text>` stay as they
 * are; anything else is a path, relative to `cwd`, so the same file named
 * two ways is one resource.
 */
export function normalizeResource(resource: string, cwd: string): string {
  const text = resource.trim();
  const match = /^([a-z]+):(.*)$/.exec(text);
  if (match && match[1] !== "path") return `${match[1]}:${match[2]?.trim()}`;
  let file = (match ? match[2] : text)?.trim() ?? "";
  if (path.isAbsolute(file)) file = path.relative(cwd, file);
  file = path.posix.normalize(file.split(path.sep).join("/"));
  if (file === "." || file === "./") file = "";
  file = file.replace(/^\.\//, "");
  if (file.startsWith("../"))
    throw new Error(
      `Claimed path ${resource} lies outside your working directory`,
    );
  return `path:${file}`;
}

/** Whether two normalized resources conflict: equal, or one path holds
 * the other. `path:` (the whole tree) holds every path. */
export function overlaps(left: string, right: string): boolean {
  if (left === right) return true;
  if (!left.startsWith("path:") || !right.startsWith("path:")) return false;
  const a = left.slice(5).replace(/\/$/, "");
  const b = right.slice(5).replace(/\/$/, "");
  if (a === "" || b === "") return true;
  return a === b || b.startsWith(`${a}/`) || a.startsWith(`${b}/`);
}

/** What the board's index keeps of an entry: all but body and history. */
export type BoardSummary = Omit<BoardEntry, "protocol" | "body" | "history">;

/** Statuses of entries that are finished: out of the default board view. */
export const FINISHED_STATUSES: readonly BoardStatus[] = ["done", "dropped"];

export function isFinished(entry: Pick<BoardEntry, "status">): boolean {
  return FINISHED_STATUSES.includes(entry.status);
}

export function byTime(left: CollabMessage, right: CollabMessage): number {
  return left.sentAt - right.sentAt || left.id.localeCompare(right.id);
}

/** Fold one message into the task table: an opening request starts a
 * task, and later messages about it move its state. */
export function foldTask(
  tasks: Map<string, TaskView>,
  message: CollabMessage,
): void {
  if (!message.task || message.type === "message") return;
  const known = tasks.get(message.task);
  if ((OPENING_TYPES as readonly string[]).includes(message.type)) {
    if (known) {
      known.assignees = [...new Set([...known.assignees, message.toName])];
      return;
    }
    tasks.set(message.task, {
      id: message.task,
      requester: message.fromName,
      assignees: [message.toName],
      status: message.type as TaskStatus,
      title: message.text.split("\n")[0]?.slice(0, 120) ?? "",
      refs: message.refs,
      updatedAt: message.sentAt,
      last: message.text,
    });
    return;
  }
  // Answers to a request this group never saw are dropped, as are those
  // older than the task's latest state.
  if (!known || message.sentAt < known.updatedAt) return;
  known.status = message.type as TaskStatus;
  known.updatedAt = message.sentAt;
  known.last = `${message.fromName}: ${message.text}`;
  known.refs = [...new Set([...known.refs, ...message.refs])];
}

export function summaryOf(entry: BoardEntry): BoardSummary {
  const {
    protocol: _protocol,
    body: _body,
    history: _history,
    ...rest
  } = entry;
  return rest;
}

export type TaskStatus = Exclude<MessageType, "message">;

export interface TaskView {
  id: string;
  requester: string;
  assignees: string[];
  status: TaskStatus;
  title: string;
  refs: string[];
  updatedAt: number;
  last: string;
}

/** How much of a group's history the store keeps: the newest messages,
 * the newest finished board entries, and the newest closed tasks. Open
 * entries and tasks are always kept. */
export interface Retention {
  messages: number;
  finishedEntries: number;
  closedTasks: number;
}

export const DEFAULT_RETENTION: Readonly<Retention> = {
  messages: 10_000,
  finishedEntries: 2_000,
  closedTasks: 5_000,
};

type BoardQuery = {
  kind?: BoardKind;
  status?: BoardStatus;
  all?: boolean;
  limit?: number;
};

/** What a group's store does, whichever keeps it. */
export interface StoreBackend {
  upsertMember(member: Omit<MemberRecord, "protocol">): MemberRecord;
  member(key: string): MemberRecord | undefined;
  setStatus(key: string, status: MemberStatus, state?: string): void;
  members(): MemberRecord[];
  log(message: Omit<CollabMessage, "protocol">): CollabMessage;
  messages(limit?: number): CollabMessage[];
  tasks(): TaskView[];
  post(
    entry: Omit<
      BoardEntry,
      "protocol" | "createdAt" | "updatedAt" | "status" | "history"
    > & { createdAt?: number; status?: BoardStatus },
  ): BoardEntry;
  entry(id: string): BoardEntry | undefined;
  update(
    id: string,
    by: string,
    change: { status?: BoardStatus; note?: string; at?: number },
  ): BoardEntry;
  summaries(options?: BoardQuery): BoardSummary[];
  board(options?: BoardQuery): BoardEntry[];
  boardCounts(): {
    total: number;
    byStatus: Record<BoardStatus, number>;
    openByKind: Partial<Record<BoardKind, number>>;
  };
  claims(): Claim[];
  claim(
    owner: Pick<MemberRecord, "key" | "name">,
    resources: string[],
    options?: { note?: string; ttlMs?: number },
  ): ClaimOutcome;
  release(owner: string, resources?: string[]): Claim[];
  /** Drop what retention lets go; returns how much went. */
  prune(retention: Retention): {
    messages: number;
    entries: number;
    tasks: number;
  };
}
