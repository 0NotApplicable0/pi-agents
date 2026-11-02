/**
 * File primitives of the collab store: atomic JSON writes (temp file and
 * rename), create-once writes that make retries idempotent, directory scans
 * that skip torn or foreign files, and a lock directory with stale-owner
 * recovery for read-modify-write sections. Everything is local and
 * synchronous, so a crash leaves either the old or the new file, never a
 * partial one.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

let counter = 0;

function tempName(file: string): string {
  counter = (counter + 1) % 1_000_000;
  return path.join(
    path.dirname(file),
    `.${path.basename(file)}.${process.pid}.${Date.now()}.${counter}.tmp`,
  );
}

/** Replace `file` with `value` atomically. */
export function writeJsonAtomic(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = tempName(file);
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600,
  });
  fs.renameSync(temp, file);
}

/**
 * Create `file` with `value` unless it exists. Returns whether this call
 * created it. The content appears whole: it is written to a temp file and
 * hard-linked into place, which fails if the name is taken.
 */
export function createJsonOnce(file: string, value: unknown): boolean {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file)) return false;
  const temp = tempName(file);
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600,
  });
  try {
    fs.linkSync(temp, file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  } finally {
    fs.rmSync(temp, { force: true });
  }
}

export function readJson<T>(file: string): T | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return undefined;
  }
}

/** The JSON files of a directory, parsed, skipping unreadable ones. */
export function readJsonDir<T>(
  directory: string,
): Array<{ file: string; value: T }> {
  let names: string[];
  try {
    names = fs.readdirSync(directory);
  } catch {
    return [];
  }
  return names
    .filter((name) => name.endsWith(".json") && !name.startsWith("."))
    .sort()
    .flatMap((name) => {
      const file = path.join(directory, name);
      const value = readJson<T>(file);
      return value === undefined ? [] : [{ file, value }];
    });
}

/** Whether a process with this PID runs on this host. */
export function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export const HOST = os.hostname();

/** A lock older than this whose owner is gone, or any lock older than
 * `LOCK_MAX_AGE_MS`, is stale: critical sections take milliseconds. */
const LOCK_STALE_MS = 2_000;
const LOCK_MAX_AGE_MS = 30_000;
const LOCK_TIMEOUT_MS = 10_000;

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Which lock it is: a new one may reuse the inode, not the old time. */
function lockIdentity(stat: fs.Stats): string {
  return `${stat.ino}:${stat.mtimeMs}`;
}

/** The identity of a lock whose holder died, or undefined while it
 * lives. */
function staleLock(directory: string): string | undefined {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(directory);
  } catch {
    return undefined;
  }
  const age = Date.now() - stat.mtimeMs;
  if (age > LOCK_MAX_AGE_MS) return lockIdentity(stat);
  if (age < LOCK_STALE_MS) return undefined;
  const owner = readJson<{ pid?: number; host?: string }>(
    path.join(directory, "owner.json"),
  );
  // The owner file read must belong to the lock judged: a lock released
  // and taken again meanwhile is fresh, and its owner may not have
  // written the file yet.
  const identity = lockIdentity(stat);
  if (!sameLock(directory, identity)) return undefined;
  if (!owner) return identity;
  return owner.host === HOST && !processAlive(owner.pid ?? -1)
    ? identity
    : undefined;
}

function sameLock(directory: string, identity: string): boolean {
  try {
    return lockIdentity(fs.statSync(directory)) === identity;
  } catch {
    return false;
  }
}

/**
 * Run `body` while holding the lock directory `directory`. `mkdir` is
 * atomic, so exactly one process holds it; a holder that died is detected
 * by PID (same host) or age, and its lock is taken over.
 */
export function withLock<T>(directory: string, body: () => T): T {
  fs.mkdirSync(path.dirname(directory), { recursive: true });
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  let delay = 2;
  for (;;) {
    try {
      fs.mkdirSync(directory);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const stale = staleLock(directory);
      if (stale !== undefined) {
        // Rename first so two processes can't both remove a fresh lock,
        // and only the lock judged stale: another process may have taken
        // it over already and made a fresh one.
        const grave = `${directory}.stale.${process.pid}.${Date.now()}`;
        try {
          if (!sameLock(directory, stale)) continue;
          fs.renameSync(directory, grave);
          fs.rmSync(grave, { recursive: true, force: true });
        } catch {}
        continue;
      }
      if (Date.now() > deadline)
        throw new Error(`Timed out waiting for the collab lock ${directory}`);
      sleepSync(delay);
      delay = Math.min(delay * 2, 50);
    }
  }
  try {
    fs.writeFileSync(
      path.join(directory, "owner.json"),
      JSON.stringify({ pid: process.pid, host: HOST, at: Date.now() }),
    );
    return body();
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

/** A file-name-safe rendering of an arbitrary key. */
export function safeName(key: string): string {
  return key.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 120);
}

/**
 * Append one JSON record as a line. The leading newline keeps a line that a
 * crash tore apart from swallowing the next record: the torn part becomes
 * a line of its own, which readers skip.
 */
export function appendJsonLine(file: string, value: unknown): void {
  appendJsonLines(file, [value]);
}

export function appendJsonLines(file: string, values: unknown[]): void {
  if (values.length === 0) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(
    file,
    `${values.map((value) => `\n${JSON.stringify(value)}`).join("")}\n`,
    { mode: 0o600 },
  );
}

/**
 * A reader of an append-only JSON-lines file that remembers how far it
 * read: each call parses only what was appended since, up to the last
 * complete line. A file that was replaced or shrank is read again from the
 * start, after `reset`.
 */
export class JsonlTail<T> {
  private offset = 0;
  private inode: number | undefined;

  constructor(
    readonly file: string,
    private readonly apply: (record: T) => void,
    private readonly reset: () => void,
  ) {}

  /** Apply new records; false when the file doesn't exist. */
  catchUp(): boolean {
    let fd: number;
    try {
      fd = fs.openSync(this.file, "r");
    } catch {
      return false;
    }
    try {
      const stat = fs.fstatSync(fd);
      if (stat.ino !== this.inode || stat.size < this.offset) {
        this.inode = stat.ino;
        this.offset = 0;
        this.reset();
      }
      if (stat.size === this.offset) return true;
      const buffer = Buffer.alloc(stat.size - this.offset);
      const read = fs.readSync(fd, buffer, 0, buffer.length, this.offset);
      const end = buffer.subarray(0, read).lastIndexOf(10);
      if (end < 0) return true;
      for (const line of buffer.subarray(0, end).toString("utf8").split("\n")) {
        if (!line) continue;
        let record: T;
        try {
          record = JSON.parse(line) as T;
        } catch {
          continue;
        }
        this.apply(record);
      }
      this.offset += end + 1;
      return true;
    } finally {
      fs.closeSync(fd);
    }
  }
}
