# Collab design

How agents of one Pi session work together in collab groups and
competitions, and why. [Working together](collab.md) is the user manual.

## Goals

1. **Teamwork inside a session**: agents that work on one problem share
   what they learn (a blackboard), avoid stepping on each other (claims),
   and pass work along explicitly (handoffs, task and review requests).
2. **Independent attempts, compared**: several agents solve the same task
   without seeing each other, every solution is checked the same way, the
   best parts can be merged into a new candidate, and the user picks or
   accepts a judge's pick.
3. **The user stays in charge**: nothing a competition does reaches the
   main workspace until the parent applies a named solver.

Constraints: part of every agent, like messaging, so teams need no setup;
leave graphs, messaging reach, results, and recovery as they are; keep
the prompt of an agent working alone short and stable; keep the
parent/child tool split (the parent reads and starts, agents act);
survive restarts like the session's agents; stay within one session, with
no cross-process registry, heartbeats, or delivery queues.

## Where it sits

```text
╭─ Pi session ──────────────────────────────────────────────────────────╮
│ parent tools: agent_* · agent_compete · collab_status                  │
│ commands: /agents /messages /collab /compete                           │
│                                                                        │
│  pi-agents service (pi-durable harness)                                │
│   ├─ collab group "main": impl ⇄ rev       tools: collab_board,        │
│   │    shared board, claims, log            collab_claim, collab_send, │
│   │                                         collab_peers               │
│   └─ graph compete-c1: c1-a  c1-b  c1-c ──▶ c1-judge                   │
│        each in its own worktree;            solvers: compete_submit    │
│        unreachable by messages              judge: compete_compare,    │
│                                                    compete_verdict     │
╰────────────────────────────────────────────────────────────────────────╯
   ~/.pi/agent/pi-agents/sessions/<session id>/
     storage/           the session's durable agents (unchanged)
     collab/groups/     one CollabStore per group
     collab/competitions/c1/  record, submissions, verify results,
                              verdict, patches, ws/<solver> worktrees
```

Code layout: `src/collab/` holds the plain-Node parts (the switch,
membership, the group store and its board and claim operations, the
competition record, workspaces, diffs, verify, comparison) with no
pi-durable imports; `src/agents/collab.ts` holds the child tools as a
pi-durable extension; `src/pi/collab.ts` holds the parent's tool, commands,
the `Competitions` controller, and the monitor.

## Collab groups

### Membership

Every agent is a member. `createGraph` and the spawning tool resolve a
membership for each new agent, the same way they resolve `spawn`:
`group` and `role` from the spawn (Pi's `agent_spawn` and agents'
`agent_spawn` both take them as plain fields), else the spawner's group
or `main`, and the profile or name. It's stored on the `AgentRecord`
(`collab: {group, role, team?, lead?, cwd, competition?, part?, solver?,
bracket?}`) and decides
the tool selection, next to messaging: members get the collab extension
and its four tools. A competition's agents carry their competition
instead and get the compete extension; their helpers get no membership,
so they stay out of reach. Records from before this version have no
membership and keep the tools they were created with.

The extension's prompt section names the agent's group and role and how
to use the board, claims, and messages. It names no members: a section
that changes reaches a running agent as a new system message, so the
section stays fixed for the agent's life, and `collab_peers` lists the
members when the agent asks.

### State

Each group is a `CollabStore` under `<session dir>/collab/groups/<group>/`,
created on a member's first collab tool call: members, claims, the board,
the message log, and the task table.

**SQLite.** The store is one SQLite database per group, `collab.db`,
through the `node:sqlite` module that Node 22.5+ and Bun ship (no native
dependency to install). It runs in WAL mode with `synchronous=NORMAL` and a
10 s busy timeout, so readers never block the writer, a crash loses at most
the last transaction's durability window but never corrupts the file, and
writers in several processes serialize (`BEGIN IMMEDIATE`). Tables:
`members`, `board` (each entry's summary in columns, with the full entry
beside it, indexed by finished and update time), `claims` (keyed by owner
and resource), `messages`, and `tasks` (each task's folded state, updated
in the same transaction that logs its message, so the table keeps every
task however old). A board digest, a claim check, or the task table is an
indexed query: their cost no longer grows with the files a group wrote.
Claim checks compute live holders in SQL (a member that is live, or
paused within the grace period) and delete expired claims as they claim.

**Retention.** After writes, a store prunes its group at most every 30 s,
on an unreferenced timer off the tool call's path: it keeps the newest
`piAgents.collabRetainMessages` (10,000) messages,
`collabRetainFinished` (2,000) done or dropped board entries, and
`collabRetainClosedTasks` (5,000) closed tasks. Open entries and open tasks
are never pruned.

**Migration.** A group that a previous version kept as JSON files is
imported into the database on first open, once (members, board, claims,
messages in time order, which rebuild the task table); the files stay
where they were, unread. Downgrading reads the files again, without what
the database added since.

**Fallback.** Where `node:sqlite` is missing (Node before 22.5), the store
falls back to the earlier file layout: JSON files with atomic writes,
create-once posts, a lock directory for read-modify-write, and two
append-only indexes (`board.jsonl`, `messages.jsonl`) that a store tails
from the offset it last read. It has no retention. A group whose database
exists but can't be opened is an error rather than a silent fallback, so
no member writes to a store the others don't read.
`PI_AGENTS_COLLAB_STORE=files` forces the file store, for comparison or
debugging.

Status changes run from the parent's monitor (on every service change,
throttled to 2 s, and every 10 s once the session has agents), only for
members whose state changed: it marks stopped agents `exited`, which drops
their claims, and copies agents' states to their records for `/collab`.
These are short synchronous transactions on the event loop; with SQLite a
status write costs tens of microseconds. A member is live while its record
says `live`; nothing heartbeats, since every member lives in this process.
Sessions without storage use a temp directory.

Store keys are `agent-<id>`; members are addressed by their agent names.

### Sub-teams and broadcasts

A membership can name a `team` and whether the agent is its `lead`. A spawn
of several agents forms a team named after its graph, split in chunks of
`piAgents.teamSize`; an agent a lead spawns joins the lead's team; an
explicit `team` wins. `collab_peers` renders a summary (counts by state,
role, and team, at most 12 names each) and one page of members (20 by
default): the caller's team when the group is larger than a page.

A broadcast (`collab_send` to `team`, `team:<name>`, or `group`) resolves
its recipients once, when the call is first planned, and memoizes them with
the plan, so a replayed call sends to the same members. Each recipient's
send is a separate `sendMessage` with its own memo slot, so a crash halfway
sends each at most once; the group logs one message addressed to the
audience. A per-sender rate limit (`broadcastsPerMinute`, in memory) and a
fanout cap (`maxBroadcast`) bound how many deliveries one agent causes;
the rest of a large group should read the board.

### Model requests

Two harness hooks pace model requests across agents, after the
working-agents cap admitted the agent (`src/host/requests.ts`):
`GenerationTask.beforeRequest` waits, and `afterResponse` settles with the
response's usage and error. A rate-limit error pauses every agent's next
request until the provider's `Retry-After`, else for an exponential delay
(1 s doubling to 60 s, jittered) that a success resets; pi-ai still retries
the limited request itself. With `piAgents.maxTokensPerMinute`, a FIFO
queue admits a request when the last 60 s of usage, plus the estimates of
requests in flight (context characters / 4), leave room; compactions
(`CompactionTask.beforeCompact`) count by estimate. The budget is a
per-process estimate: it can't see the user's own requests or other
clients of the same key, and a request a restart resumes mid-stream passes
no hook.

### Messages

`collab_send` resolves the recipient (name, ID, or `role:<role>` among live
members), refuses anyone outside the sender's group, and delivers through
the same `sendMessage` path as `agent_send`, so delivery, steering, and the
`/messages` browser work as before. The send is memoized per tool call, so a
replayed call after a crash doesn't send twice. The message is logged to
the group (`store.log`, no delivery queue), which folds the task state for
`/collab tasks` and the overview in the same transaction.

Protocol:

| Type | Opens a task | Closes it |
| --- | --- | --- |
| `task_req`, `handoff`, `review_req` | yes | |
| `task_ack`, `task_clarify` | | |
| `task_done`, `review_done` | | yes |
| `task_blocked` | | |

Task IDs are `t-<random>`; answers must carry one. Log entries are rows
of the `messages` table (JSON files `messages/<time>-<id>.json` in the file
store) with `{type, task, from, fromName, to, toName, text, refs, mode,
sentAt}`.

### Reach

Messaging reach (`scopeOf`) gains two rules: for `collab_send`, members
of a collab group reach each other wherever they were spawned
(`agent_send`'s reach is unchanged, so graphs keep their shape);
competition agents reach only their own helpers, and nobody else reaches
them.

## Competitions

### Flow

```text
agent_compete start ─▶ reserve c<N> (mkdir) ─▶ prepare workspaces
   ─▶ write competition.json ─▶ spawnGraph compete-cN:
        c<N>-a … (solvers, job = task + workspace + strategy + verify)
        c<N>-judge-<k> (past judgeBracketSize solvers: after its bracket)
        c<N>-judge (after: all solvers, or every bracket judge; read-only tools)
solver: work in ws/<name> ─▶ compete_submit ─▶ diff + verify ─▶ submissions/<name>.json
bracket judge: compete_compare (its bracket) ─▶ compete_verdict ─▶ bracket-<k>.json
judge:  compete_compare (all, or each bracket's top 2) ─▶ compete_verdict ─▶ verdict.json
graph ends ─▶ the judge's answer reaches the parent as one message
parent: status / compare (re-verify changed diffs)
   ─▶ merge on request: c<N>-m<k> in its own graph compete-c<N>-m<k>
        ─▶ compete_submit ─▶ one more candidate (row in the table)
   ─▶ apply <solver or merge> ─▶ discard
monitor: past the deadline, stop unfinished solvers (timedOut); judge still runs
```

### Workspaces

In a Git repository each solver gets a detached `git worktree` of `HEAD`
under `competitions/<id>/ws/<solver>`. If the main workspace is dirty, its
tracked diff and untracked files (minus ignored ones) are copied in and
committed there as the base, so solvers start from what the user sees and
diffs show only the solver's work. Outside Git the directory is copied and
`git init`-ed with a base commit for the same diffs. `node_modules`, at
the top and nested up to three levels down (a monorepo's packages), is
symlinked to the main workspace's, not copied or installed again.

A diff is `git add -A` then `git diff --cached --binary <base>`, excluding
`node_modules`, `__pycache__`, and `.pytest_cache`.

Solver N gets default strategy N (`DEFAULT_HINTS`), so solvers diverge by
default; a hint in `variants` replaces it, and `""` removes it.

### Submissions, verify, comparison

`compete_submit` stores `{summary, approach, tests, confidence, caveats,
files[{path, added, removed}], hash, verify}`. The latest submission
counts. Verify runs `sh -c <command>` in the workspace with `CI=1`, a
timeout (5 min) that kills the process group, and the output's tail; results
are cached by diff hash in `results/<solver>.json`, so compare reruns only
what changed. Every verify run, at submission or in a comparison, takes a
slot of one pool of `piAgents.verifyConcurrency` (4); its timeout starts
when it runs. A comparison verifies its rows in parallel through the pool.
Its details give each solution's diff an equal share of a 160,000-character
budget (at most 8,000 each), so a judge's prompt stays near 40k tokens.

Past `piAgents.judgeBracketSize` solvers, solvers split into even
brackets, each with a judge whose `compete_compare` and `compete_verdict`
cover its bracket. The final judge runs after them and compares the
finalists: each bracket's top 2 by its verdict, or by the rubric where a
bracket judge gave none.

The comparison table has one row per solver: state, submitted, verify,
files, lines, confidence, summary, plus a rubric order (has changes →
verify passes → submitted → confidence → smaller diff) as a tiebreak
suggestion. The judge sees the table and each submission's details and
diff (truncated) and can read the workspaces.

`verdict.json`: `{by, winner, ranking[], rationale, merge?, at}`.
`compete_verdict` checks the names against the competition.

### Merges

`merge` picks its sources (given, or the two best ranked with changes:
the verdict's ranking, then the rubric order), checks they're idle, still
have workspaces, and changed something, and needs two or more. It then:

1. creates `ws/<id>-m<k>` with `git worktree add --detach` from the first
   source's repository at that source's base commit, so every source's
   patch applies there (outside Git, the source's copy is a repository too);
2. writes each source's patch to `merges/<id>-m<k>/<source>.patch`;
3. appends a solver entry `{name, workspace, cwd, base, merge: {from,
   guidance?}, deadline, graph, agentId}` to `competition.json`;
4. spawns the merger as a one-agent graph `compete-<id>-m<k>` with the
   solver part (only `compete_submit` beyond its usual tools), the task,
   the sources' workspaces, patches, and submissions, the verdict, and any
   guidance.

The merger's submission and verify result are stored like a solver's, so
the table, compare, the rubric, and apply treat it as one more candidate.
If anything fails before the agent starts, the workspace and entry are
removed. Deadlines are per entry, and the monitor enforces them in
competitions that aren't discarded, so a merge started after an apply
still times out.

### Apply and discard

Apply is a parent action naming a solver; it never runs on its own. It
refuses while the solver works, saves `patches/<solver>.patch`, runs `git
apply --check` then `git apply` at the repository root, and in a Git
repository falls back to `git apply --3way`. Discard stops the competition's
graph and any merge's graph still working, removes the worktrees (`git
worktree remove --force`, then `prune`), and keeps the record, submissions,
and patches.

### Durability

The competition's agents are ordinary durable agents in an ordinary graph,
so they resume after a restart like any other. Everything else is files:
the record, submissions, results, verdict. The `Competitions` controller
keeps no state in memory, so a restarted Pi reads the same competitions.
IDs are reserved with `mkdir`, so two starts never share one.

## Relation to pi-agents

Collab adds two spawn fields, a membership on every agent record, two
child extensions, two parent tools, two commands, and two reach rules.
Graphs, messaging, profiles, hooks, and storage are used as they are.

Each agent carries four more tool schemas and a four-line prompt section,
about 1,100 tokens per request (about 900 for the schemas, 200 for the
section), cached with the rest of the prompt since neither changes.
That is the price of a team that needs no setup.

## Limitations and next steps

- **Blindness is advisory at the file level.** Solvers can't message each
  other, but their worktrees are siblings on disk; a solver that reads
  `../` could see another's work. Real isolation needs a sandbox or
  per-solver temp roots outside the session tree.
- **Claims are advisory.** Edits aren't blocked; agents are told to claim
  and to respect conflicts.
- **Merges are agent work.** A merge is only as good as the merging agent,
  and nothing re-judges it automatically; compare it, or ask for a new
  judgement.
- **Verify trusts the command.** It runs with the user's permissions in each
  workspace; a destructive command is destructive N times.
- **Dependencies**: `node_modules`, at the top and nested in packages up
  to three levels down, is linked; virtualenvs, build caches, or `target/`
  are rebuilt per solver, which costs time. They aren't linked because
  they bind to the main checkout's paths.
- **Stale worktrees**: if a session's storage is pruned without `discard`,
  Git keeps worktree entries until `git worktree prune`.
- **Cost**: N solvers plus a judge cost roughly N+1 times one attempt;
  past `judgeBracketSize` solvers, each bracket's judge adds one more.
- Next: per-solver sandboxes; re-judging after a merge; competitions as graph nodes (compete inside a
  larger plan); a TUI view of the comparison table.
