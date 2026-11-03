/**
 * Collab groups: the agents of one Pi session that share a blackboard,
 * advisory claims, and a log of structured messages. Every agent is a
 * member: of the default group, or of the group its spawn names (helpers
 * default to their spawner's). A competition's solvers, judge, and merger
 * carry their competition instead and never see a group's board.
 *
 * A group's state lives in a `CollabStore` under the session's storage, so
 * it survives restarts like the session's agents: the session host marks
 * stopped agents exited, which releases their claims.
 */

import fs from "node:fs";
import path from "node:path";
import type { Self } from "./ops.js";
import { CollabStore, type MemberRecord } from "./store.js";

export const DEFAULT_GROUP = "main";

/** What a spawn asks for. */
export type CollabRequest = {
  group?: string;
  role?: string;
  team?: string;
  lead?: boolean;
};

/** An agent's resolved membership, stored with its record. */
export type CollabMembership = {
  group: string;
  role: string;
  /** Its sub-team within the group. */
  team?: string;
  /** Whether it leads its sub-team. */
  lead?: boolean;
  /** Set for a competition's agents: the competition's ID. */
  competition?: string;
  /** What the agent does in its competition. */
  part?: "solver" | "judge";
  /** A solver's entry in its competition. */
  solver?: string;
  /** A bracket judge's bracket, from 0. */
  bracket?: number;
  /** The directory its path claims are relative to: its working directory
   * at spawn. */
  cwd: string;
};

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** Resolve a request: the default group, and the role of the profile or
 * name. */
export function resolveCollab(
  request: CollabRequest & Partial<CollabMembership>,
  fallbackRole: string,
  cwd: string,
): CollabMembership {
  const group = request.group?.trim() || DEFAULT_GROUP;
  if (!NAME.test(group))
    throw new Error(
      `Collab group ${JSON.stringify(group)} must be letters, digits, dots, dashes, or underscores`,
    );
  const team = request.team?.trim();
  if (team && !NAME.test(team))
    throw new Error(
      `Team ${JSON.stringify(team)} must be letters, digits, dots, dashes, or underscores`,
    );
  return {
    group,
    role: request.role?.trim() || fallbackRole,
    ...(team ? { team } : {}),
    ...(request.lead ? { lead: true } : {}),
    ...(request.competition ? { competition: request.competition } : {}),
    ...(request.part ? { part: request.part } : {}),
    ...(request.solver ? { solver: request.solver } : {}),
    ...(request.bracket !== undefined ? { bracket: request.bracket } : {}),
    cwd,
  };
}

/** A membership with its sub-team: the one it names, else the team of the
 * spawn it came with, split into teams of `teamSize` when the spawn is
 * larger. An agent spawned alone joins no team. */
export function withTeam(
  membership: CollabMembership,
  spawn: { name: string; index: number; count: number; teamSize: number },
): CollabMembership {
  if (membership.team || membership.competition || spawn.count < 2)
    return membership;
  const team =
    spawn.count > spawn.teamSize
      ? `${spawn.name}-${Math.floor(spawn.index / spawn.teamSize) + 1}`
      : spawn.name;
  return { ...membership, team };
}

/** The directory of a session's collab state. */
export function groupsRoot(collabRoot: string): string {
  return path.join(collabRoot, "groups");
}

/** The groups of a session that have state, by name. */
export function listGroups(collabRoot: string): string[] {
  try {
    return fs
      .readdirSync(groupsRoot(collabRoot), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

export function collabStore(collabRoot: string, group: string): CollabStore {
  return new CollabStore(groupsRoot(collabRoot), group);
}

/** An agent's key in its group. */
export function collabKey(agentId: string): string {
  return `agent-${agentId}`;
}

/** The parent's key, for what the user posts from `/collab`. */
export const PARENT_KEY = "pi";

export function collabMember(options: {
  agentId?: string;
  name: string;
  role: string;
  group: string;
  team?: string;
  lead?: boolean;
  cwd: string;
  state: string;
  joinedAt?: number;
}): Omit<MemberRecord, "protocol"> {
  const now = Date.now();
  return {
    key: options.agentId ? collabKey(options.agentId) : PARENT_KEY,
    ...(options.agentId ? { agentId: options.agentId } : {}),
    name: options.name,
    role: options.role,
    group: options.group,
    ...(options.team ? { team: options.team } : {}),
    ...(options.lead ? { lead: true } : {}),
    cwd: options.cwd,
    joinedAt: options.joinedAt ?? now,
    updatedAt: now,
    state: options.state,
    status: "live",
  };
}

export function selfOf(member: MemberRecord): Self {
  return {
    key: member.key,
    name: member.name,
    cwd: member.cwd,
    role: member.role,
  };
}
