/** pi-agents' settings in Pi's merged settings. */

/** The settings key under which pi-agents reads its configuration. */
export const SETTINGS_KEY = "piAgents";

/**
 * A positive integer setting under `piAgents`. Absent means unset; anything
 * but a positive integer is an error.
 */
export function readPositiveInteger(
  settings: unknown,
  key: string,
): { value?: number; error?: string } {
  const section =
    typeof settings === "object" && settings !== null
      ? (settings as Record<string, unknown>)[SETTINGS_KEY]
      : undefined;
  if (section === undefined) return {};
  if (typeof section !== "object" || section === null || Array.isArray(section))
    return { error: `${SETTINGS_KEY} must be an object` };
  const value = (section as Record<string, unknown>)[key];
  if (value === undefined) return {};
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1)
    return {
      error: `${SETTINGS_KEY}.${key} must be a positive integer, not ${JSON.stringify(value)}`,
    };
  return { value };
}

/** How far agents reach, from `piAgents` settings over these defaults. */
export interface Limits {
  /** Agents one spawn starts, yours or an agent's. */
  maxAgentsPerSpawn: number;
  /** Agents one agent spawns over its life. */
  maxSpawnedPerAgent: number;
  /** Agents spawned by agents whose initial jobs are unfinished at once. */
  maxActiveSpawned: number;
  /** How deep agents nest: agents at this depth can't spawn. */
  maxDepth: number;
  /** Solvers in one competition. */
  maxSolvers: number;
  /** Agents working at once; absent for no cap. */
  maxWorkingAgents?: number;
  /** Model tokens per minute across every agent; absent for no budget. */
  maxTokensPerMinute?: number;
  /** Agents per sub-team that one spawn forms on its own. */
  teamSize: number;
  /** Recipients one collab broadcast reaches at most. */
  maxBroadcast: number;
  /** Broadcasts one member sends per minute. */
  broadcastsPerMinute: number;
  /** Verify commands that run at once. */
  verifyConcurrency: number;
  /** Solvers one judge compares: more go to bracket judges first. */
  judgeBracketSize: number;
  /** Newest messages a collab group keeps. */
  collabRetainMessages: number;
  /** Newest finished board entries a collab group keeps. */
  collabRetainFinished: number;
  /** Newest closed tasks a collab group keeps. */
  collabRetainClosedTasks: number;
}

export const DEFAULT_LIMITS: Readonly<
  Required<Omit<Limits, "maxTokensPerMinute">> &
    Pick<Limits, "maxTokensPerMinute">
> = {
  maxAgentsPerSpawn: 12,
  maxSpawnedPerAgent: 24,
  maxActiveSpawned: 16,
  maxDepth: 3,
  maxSolvers: 6,
  maxWorkingAgents: 32,
  teamSize: 12,
  maxBroadcast: 16,
  broadcastsPerMinute: 3,
  verifyConcurrency: 4,
  judgeBracketSize: 8,
  collabRetainMessages: 10_000,
  collabRetainFinished: 2_000,
  collabRetainClosedTasks: 5_000,
};

/** A judge compares at least this many solvers before brackets form. */
const MIN_BRACKET = 4;

const MIN_SOLVERS = 2;

/**
 * The limits in Pi's merged settings. A missing or invalid value keeps its
 * default, with an error for the invalid one. `maxWorkingAgents: 0` turns
 * the working-agent cap off.
 */
export function readLimits(settings: unknown): {
  limits: Limits;
  errors: string[];
} {
  const errors: string[] = [];
  const limits: Limits = { ...DEFAULT_LIMITS };
  for (const key of [
    "maxAgentsPerSpawn",
    "maxSpawnedPerAgent",
    "maxActiveSpawned",
    "maxDepth",
    "maxSolvers",
    "teamSize",
    "maxBroadcast",
    "broadcastsPerMinute",
    "verifyConcurrency",
    "judgeBracketSize",
    "collabRetainMessages",
    "collabRetainFinished",
    "collabRetainClosedTasks",
  ] as const) {
    const { value, error } = readPositiveInteger(settings, key);
    if (error) errors.push(error);
    else if (value !== undefined) limits[key] = value;
  }
  if (limits.maxSolvers < MIN_SOLVERS) {
    errors.push(
      `${SETTINGS_KEY}.maxSolvers must be at least ${MIN_SOLVERS}, not ${limits.maxSolvers}`,
    );
    limits.maxSolvers = DEFAULT_LIMITS.maxSolvers;
  }
  if (limits.judgeBracketSize < MIN_BRACKET) {
    errors.push(
      `${SETTINGS_KEY}.judgeBracketSize must be at least ${MIN_BRACKET}, not ${limits.judgeBracketSize}`,
    );
    limits.judgeBracketSize = DEFAULT_LIMITS.judgeBracketSize;
  }
  const section =
    typeof settings === "object" && settings !== null
      ? (settings as Record<string, unknown>)[SETTINGS_KEY]
      : undefined;
  // 0 turns these off.
  for (const key of ["maxWorkingAgents", "maxTokensPerMinute"] as const) {
    const given =
      typeof section === "object" && section !== null
        ? (section as Record<string, unknown>)[key]
        : undefined;
    if (given === 0) delete limits[key];
    else if (given !== undefined) {
      const { value, error } = readPositiveInteger(settings, key);
      if (error)
        errors.push(
          `${error.replace("must be a positive integer", `must be a positive integer or 0 (${key === "maxWorkingAgents" ? "no cap" : "no budget"})`)}`,
        );
      else if (value !== undefined) limits[key] = value;
    }
  }
  // An object error repeats per key; report it once.
  return { limits, errors: [...new Set(errors)] };
}
