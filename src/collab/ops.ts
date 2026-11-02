/**
 * The collab operations behind the members' `collab_board` and
 * `collab_claim`, `/collab`, and `collab_status`: the blackboard, claims,
 * and one-screen views of a group. Each returns text for a model plus
 * structured data. Callers pass the IDs and times of writes, so a durable
 * tool can memoize them and a retried call writes the same files again,
 * which the store ignores.
 */

import * as path from "node:path";
import {
  BOARD_KINDS,
  BOARD_STATUSES,
  type BoardKind,
  type BoardStatus,
  type BoardSummary,
  type Claim,
  type CollabMessage,
  type CollabStore,
  canonicalPath,
  FINISHED_STATUSES,
  type MemberRecord,
  normalizeResource,
  type TaskView,
} from "./store.js";

/** Who acts: a registered member of the group. */
export type Self = Pick<MemberRecord, "key" | "name" | "cwd" | "role">;

export interface OpResult<T = unknown> {
  text: string;
  data: T;
  error?: boolean;
}

function ago(at: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.round(minutes / 60)}h ago`;
}

export function memberLine(member: MemberRecord): string {
  const status = member.status === "live" ? member.state : member.status;
  return `${member.name} role=${member.role} ${status} seen ${ago(member.updatedAt)}`;
}

// Blackboard

export interface BoardArgs {
  action: "read" | "post" | "update";
  kind?: string;
  title?: string;
  body?: string;
  refs?: string[];
  id?: string;
  status?: string;
  note?: string;
  limit?: number;
  /** For read: list finished entries too. */
  all?: boolean;
}

/** How many open entries a digest lists unless a limit says otherwise, and
 * how many finished ones it recalls. */
const DIGEST_OPEN = 30;
const DIGEST_FINISHED = 5;

export function entryLine(entry: BoardSummary): string {
  const refs = entry.refs.length > 0 ? ` refs=${entry.refs.join(",")}` : "";
  return `[${entry.id}] ${entry.kind}/${entry.status} "${entry.title}" by ${entry.authorName} ${ago(entry.updatedAt)}${refs}`;
}

function isKind(value: string | undefined): value is BoardKind {
  return (BOARD_KINDS as readonly string[]).includes(value ?? "");
}

function isStatus(value: string | undefined): value is BoardStatus {
  return (BOARD_STATUSES as readonly string[]).includes(value ?? "");
}

export function board(
  store: CollabStore,
  self: Self | undefined,
  args: BoardArgs,
  ids: { id: string; at: number } = {
    id: `b-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    at: Date.now(),
  },
): OpResult<{ entries: BoardSummary[] }> {
  if (args.kind && !isKind(args.kind))
    return {
      text: `Unknown kind ${args.kind}. Kinds: ${BOARD_KINDS.join(", ")}`,
      data: { entries: [] },
      error: true,
    };
  if (args.status && !isStatus(args.status))
    return {
      text: `Unknown status ${args.status}. Statuses: ${BOARD_STATUSES.join(", ")}`,
      data: { entries: [] },
      error: true,
    };
  if (args.action === "read") {
    if (args.id) {
      const entry = store.entry(args.id);
      if (!entry)
        return {
          text: `No board entry ${args.id}`,
          data: { entries: [] },
          error: true,
        };
      const history = entry.history
        .map(
          (each) =>
            `  - ${ago(each.at)} ${each.by}${each.status ? ` → ${each.status}` : ""}${each.note ? `: ${each.note}` : ""}`,
        )
        .join("\n");
      return {
        text: `${entryLine(entry)}\n${entry.body}${history ? `\nhistory:\n${history}` : ""}`,
        data: { entries: [entry] },
      };
    }
    if (!args.kind && !args.status && !args.all)
      return digest(store, args.limit ?? DIGEST_OPEN);
    const entries = store.summaries({
      ...(isKind(args.kind) ? { kind: args.kind } : {}),
      ...(isStatus(args.status) ? { status: args.status } : {}),
      all: args.all === true,
      limit: args.limit ?? DIGEST_OPEN,
    });
    return {
      text:
        entries.length === 0
          ? `No matching entries on the blackboard of ${store.group}.`
          : entries.map(entryLine).join("\n"),
      data: { entries },
    };
  }
  if (!self) throw new Error("Join the collab group to write to the board");
  if (args.action === "post") {
    if (!args.title?.trim())
      return {
        text: "A post needs a title",
        data: { entries: [] },
        error: true,
      };
    const entry = store.post({
      id: ids.id,
      kind: isKind(args.kind) ? args.kind : "note",
      title: args.title.trim(),
      body: args.body?.trim() ?? "",
      refs: args.refs ?? [],
      author: self.key,
      authorName: self.name,
      createdAt: ids.at,
      ...(isStatus(args.status) ? { status: args.status } : {}),
    });
    return {
      text: `Posted ${entryLine(entry)}. Reference it as board:${entry.id}.`,
      data: { entries: [entry] },
    };
  }
  if (!args.id)
    return {
      text: "An update needs the entry's id",
      data: { entries: [] },
      error: true,
    };
  const entry = store.update(args.id, self.name, {
    ...(isStatus(args.status) ? { status: args.status } : {}),
    ...(args.note ? { note: args.note } : {}),
    at: ids.at,
  });
  return { text: `Updated ${entryLine(entry)}`, data: { entries: [entry] } };
}

/** The board's counts in a line. */
export function boardCountsLine(store: CollabStore): string | undefined {
  const counts = store.boardCounts();
  if (counts.total === 0) return undefined;
  const statuses = Object.entries(counts.byStatus)
    .filter(([, count]) => count > 0)
    .map(([status, count]) => `${count} ${status}`)
    .join(", ");
  const kinds = Object.entries(counts.openByKind)
    .map(([kind, count]) => `${count} ${kind}`)
    .join(", ");
  return `${counts.total} entries: ${statuses}${kinds ? `. Unfinished by kind: ${kinds}` : ""}.`;
}

/**
 * What a plain read shows: counts, the unfinished entries newest first,
 * and the last few finished ones. Finished entries stay readable by ID,
 * status, or `all`.
 */
function digest(
  store: CollabStore,
  limit: number,
): OpResult<{ entries: BoardSummary[] }> {
  const counts = boardCountsLine(store);
  if (!counts)
    return {
      text: `The blackboard of ${store.group} is empty.`,
      data: { entries: [] },
    };
  const open = store.summaries({ limit: limit + 1 });
  const shown = open.slice(0, limit);
  const recent = FINISHED_STATUSES.flatMap((status) =>
    store.summaries({ status, limit: DIGEST_FINISHED }),
  )
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .slice(0, DIGEST_FINISHED);
  const { byStatus } = store.boardCounts();
  const finishedCount = FINISHED_STATUSES.reduce(
    (sum, status) => sum + (byStatus[status] ?? 0),
    0,
  );
  const lines = [`Blackboard of ${store.group}: ${counts}`];
  lines.push(
    shown.length > 0
      ? `Unfinished, newest first:\n${shown.map((entry) => `  ${entryLine(entry)}`).join("\n")}${open.length > limit ? "\n  … more: read with a kind, a status, or a higher limit" : ""}`
      : "Nothing unfinished.",
  );
  if (recent.length > 0)
    lines.push(
      `Recently finished (${recent.length} of ${finishedCount}; status "done" or "dropped", or all: true, lists them):\n${recent.map((entry) => `  ${entryLine(entry)}`).join("\n")}`,
    );
  return { text: lines.join("\n"), data: { entries: shown } };
}

// Claims

export interface ClaimArgs {
  action: "claim" | "release" | "list";
  resources?: string[];
  note?: string;
  ttlMinutes?: number;
}

function resourceLabel(resource: string, cwd?: string): string {
  if (!cwd || !resource.startsWith("path:")) return resource;
  return `path:${path.relative(canonicalPath("", cwd), resource.slice(5)) || "."}`;
}

export function claimLine(claim: Claim): string {
  return formatClaim(claim);
}

function formatClaim(claim: Claim, cwd?: string): string {
  const expires = claim.expiresAt
    ? ` expires in ${Math.max(0, Math.round((claim.expiresAt - Date.now()) / 60000))}m`
    : "";
  return `${resourceLabel(claim.resource, cwd)} held by ${claim.ownerName} since ${ago(claim.claimedAt)}${claim.note ? ` (${claim.note})` : ""}${expires}`;
}

export function claims(
  store: CollabStore,
  self: Self | undefined,
  args: ClaimArgs,
): OpResult<{ claims: Claim[]; conflicts?: Claim[] }> {
  if (args.action === "list") {
    const held = store.claims();
    return {
      text:
        held.length === 0
          ? `No claims in ${store.group}.`
          : held.map((claim) => formatClaim(claim, self?.cwd)).join("\n"),
      data: { claims: held },
    };
  }
  if (!self) throw new Error("Join the collab group to claim work");
  let resources: string[] | undefined;
  try {
    resources = args.resources?.map((resource) =>
      normalizeResource(resource, self.cwd),
    );
  } catch (error) {
    return {
      text: error instanceof Error ? error.message : String(error),
      data: { claims: [] },
      error: true,
    };
  }
  if (args.action === "release") {
    const released = store.release(self.key, resources);
    return {
      text:
        released.length === 0
          ? "You held none of these claims."
          : `Released ${released.map((claim) => resourceLabel(claim.resource, self.cwd)).join(", ")}.`,
      data: { claims: released },
    };
  }
  if (!resources || resources.length === 0)
    return {
      text: "Name the resources to claim: paths, item:<id>, or key:<text>",
      data: { claims: [] },
      error: true,
    };
  const outcome = store.claim(self, resources, {
    ...(args.note ? { note: args.note } : {}),
    ...(args.ttlMinutes ? { ttlMs: args.ttlMinutes * 60_000 } : {}),
  });
  if (!outcome.ok)
    return {
      text: `Not claimed; these overlap others' claims:\n${outcome.conflicts.map((claim) => formatClaim(claim, self.cwd)).join("\n")}\nCoordinate with the holders (collab_send) or pick other work.`,
      data: { claims: [], conflicts: outcome.conflicts },
      error: true,
    };
  return {
    text: `Claimed ${outcome.claims.map((claim) => resourceLabel(claim.resource, self.cwd)).join(", ")}. Release them with collab_claim action "release" when done.`,
    data: { claims: outcome.claims },
  };
}

// Views

export function taskLine(task: TaskView): string {
  return `${task.id} ${task.status} ${task.requester} → ${task.assignees.join(", ")} "${task.title}" ${ago(task.updatedAt)}`;
}

export function messageLine(message: CollabMessage): string {
  const first = message.text.split("\n")[0] ?? "";
  return `${new Date(message.sentAt).toLocaleTimeString()} ${message.fromName} → ${message.toName} [${message.type}${message.task ? ` ${message.task}` : ""}] ${first.slice(0, 100)}`;
}

/** One screen of a group: members, claims, open tasks, board, and the
 * latest messages. */
export function overview(
  store: CollabStore,
  options: { messages?: number; cwd?: string } = {},
): string {
  const members = store.members();
  const held = store.claims();
  const tasks = store
    .tasks()
    .filter((task) => task.requester !== "" && !isClosedTask(task));
  const entries = store.summaries({ limit: 10 });
  const counts = boardCountsLine(store);
  const messages = store.messages(options.messages ?? 10);
  const section = (title: string, lines: string[]) =>
    `${title} (${lines.length})${lines.length ? `\n${lines.map((line) => `  ${line}`).join("\n")}` : ""}`;
  return [
    `Collab group ${store.group}  (${store.dir})`,
    section("Members", members.map(memberLine)),
    section(
      "Claims",
      held.map((claim) => formatClaim(claim, options.cwd)),
    ),
    section("Open tasks", tasks.map(taskLine)),
    section("Blackboard", counts ? [counts, ...entries.map(entryLine)] : []),
    section("Recent messages", messages.map(messageLine)),
  ].join("\n");
}

/** Whether a task ended: done, or its review came back. */
export function isClosedTask(task: Pick<TaskView, "status">): boolean {
  return task.status === "task_done" || task.status === "review_done";
}
