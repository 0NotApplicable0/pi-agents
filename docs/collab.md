# Working together

The agents of a Pi session are a team. Every agent you spawn, and every
agent they spawn, is a member of the session's collab group: it sees what
the others post to a shared blackboard, claims files before it changes
them, and exchanges structured messages (task requests, handoffs, review
requests) with the others. And when you want independent attempts rather
than teamwork, a competition has several agents solve the same task blind
to each other and compares their solutions.

- **Collab groups**: the blackboard, claims, and messages of the agents
  that work together. Pi reads them with `collab_status`, you with
  `/collab`.
- **Competitions**: `agent_compete` (or `/compete <task>`) runs 2–6 solvers
  (`piAgents.maxSolvers` raises the limit)
  on one task, each in its own Git worktree or copy, blind to each other. A
  verify command checks every submission, a judge ranks them, a merge agent
  can combine the best ones into a new candidate, and a solution reaches
  your workspace only when you apply it.

## Collab groups

### Groups and roles

Every agent joins the group `main`, with its profile or name as its role.
Agents that an agent spawns join their spawner's group. Two spawn fields
change that:

```json
{ "name": "impl", "job": "…", "role": "implementer" }
{ "name": "rev",  "job": "…", "role": "reviewer" }
{ "name": "docs", "job": "…", "group": "docs" }
```

`role` lets the others address an agent as `role:reviewer`; `group` puts a
team of agents in a group of its own, with its own board and claims. Just
ask Pi: "spawn an implementer and a reviewer for …".

Every agent has four collab tools besides its usual ones, and its prompt
names its group and role and how to use them:

| Tool | What it does |
| --- | --- |
| `collab_peers` | The other members, their roles, sub-teams, and states. In a group larger than a page (20), counts by state, role, and team, then the caller's own team; `team` (or `"all"`), `role`, `offset`, and `limit` filter and page. |
| `collab_board` | Read, post, and update entries: `finding`, `decision`, `question`, `todo`, `note`. Reference one as `board:<id>`. A plain read is a digest: counts, the unfinished entries newest first, and the last few finished ones; `kind`, `status`, or `all: true` lists entries, and an `id` reads one in full. Marking an entry `done` or `dropped` moves it out of the digest. |
| `collab_claim` | Claim paths (relative to the agent's directory), `item:<board id>`, or `key:<text>`; list claims; release. Advisory and all-or-nothing: a conflict names the holder and claims nothing. |
| `collab_send` | Send a message or structured event to a member by name or `role:<role>`, or broadcast a plain message to `team`, `team:<name>`, or `group`. |

`collab_send` types:

| Type | Meaning | Answered with |
| --- | --- | --- |
| `message` | Plain message (default). | — |
| `task_req` | Asks for work; gets a task ID. | `task_ack`, `task_clarify`, `task_done`, `task_blocked` |
| `handoff` | Passes your work on; gets a task ID. | as `task_req` |
| `review_req` | Asks for a review; gets a task ID. | `review_done` |

Answers carry the task ID. Messages reach the recipient like `agent_send`
messages, headed `(collab review_req t-a61f5d1a4f)` with the refs and a
hint how to answer, and are logged in the group so you can follow each
task's state. `collab_send` reaches every member of the sender's group,
wherever it was spawned, and nobody outside it; `agent_send` keeps its
[usual reach](messaging.md).

### Sub-teams

Agents spawned together form a sub-team named after their spawn; a spawn
of more than `piAgents.teamSize` (12) agents splits into teams of that
size (`crew-1`, `crew-2`, …). An agent spawned alone joins none. A spawn
field names a team and its lead:

```json
{ "name": "lead-ui", "job": "…", "team": "ui", "lead": true, "spawn": true }
```

Agents a lead spawns join its team. Each agent's prompt names its team,
and a lead's tells it to coordinate the team. In a large group,
`collab_peers` stays short: counts by state, role, and team (with each
team's lead), then the caller's team, a page at a time.

`collab_send` to `team` reaches the sender's team, `team:<name>` another
team, and `group` every member; stopped members are skipped. A broadcast
carries a plain message, reaches at most `piAgents.maxBroadcast` (16)
recipients, and each agent sends at most `piAgents.broadcastsPerMinute`
(3) a minute. For news the whole of a large group needs, post to the board
instead.

An agent working alone ignores the tools; nothing is written until an
agent uses one. Agents of a session started before this version keep the
tools they had.

### Example: a board and claims in one session

```text
Spawn two agents. impl (role implementer): add input
validation to src/api/routes.ts; claim the file first, post each decision
to the board, then send role:reviewer a review_req referencing the file and
your decisions. rev (role reviewer): reply ready and wait; when a
review_req arrives, read the file and the referenced board entries, then
answer with review_done.
```

While they work:

```text
/collab
Collab group main  (…/sessions/<id>/collab/groups/main)
Members (2)
  impl role=implementer working seen 0s ago
  rev role=reviewer idle seen 4s ago
Claims (1)
  path:src/api/routes.ts held by impl since 1m ago
Open tasks (1)
  t-54d8be0930 handoff impl → rev "Finish the docs" 0s ago
Blackboard (1)
  [b-527e02c25e] decision/open "Reject unknown fields with 400" by impl 1m ago
Recent messages (3)
  6:03:17 PM impl → rev [handoff t-54d8be0930] Finish the docs
  6:02:51 PM rev → impl [review_done t-a61f5d1a4f] Looks good
  6:02:30 PM impl → rev [review_req t-a61f5d1a4f] Please review src/api/routes.ts
```

```text
/collab board        every entry with its body, finished ones too
/collab claims       who holds what
/collab tasks        each task and its latest state, ✓ when done
/collab messages     the structured message log
/collab groups       the session's groups
/collab docs board   another group's board
```

Pi itself can read the same with the `collab_status` tool, so you can ask
"what has the team decided so far?".

When a member is stopped, its claims are released and `collab_peers`
shows it stopped. `/collab` lists the members that have used a collab
tool.

## Competitions

### Verification security

Competitions require Git >=2.28 when using Git worktrees. Workspaces separate
changes, not permissions: they are **not a sandbox**. Commands can access HOME,
other files and the network, and linked `node_modules` are shared and writable.
Use only trusted projects and commands, without live credentials. Verification
has a bounded wait and attempts to terminate its process group, but detached
processes that escape the group can outlive a timeout or abort. No OS sandbox
or guarantee of descendant termination is provided.

Model calls to `agent_compete` that start verification, compare with verification,
or merge a verified competition require UI confirmation of the shell command.
This includes project-detected commands. Declining runs nothing; headless model
calls with a verify command are refused. Set `verify: "none"` when starting to
avoid verification. Explicit `/compete` commands remain user-directed and do not
show this confirmation. Approval covers the command, not the code it later runs:
solvers can change tests and project scripts before verification.

Verification defaults to a scrubbed environment, not full inheritance. See
[verification environment settings](./configuration.md#verification-environment)
for the exact modes and global-only opt-outs. Filtering cannot prevent commands
from reading credentials from disk or abusing shared dependencies.

### Starting one

Ask Pi in words, or use the command:

```text
Implement slugify in slugify.js so the tests pass, as a competition with 3
solvers; verify with "node --test" and let a judge pick.
```

```text
/compete Make the flaky retry test in tests/retry.test.ts deterministic
```

Pi calls `agent_compete` with `action: "start"`:

| Field | Default | Meaning |
| --- | --- | --- |
| `task` | required | Self-contained: solvers can't see your conversation. |
| `solvers` | 3 | 2–6, or up to `piAgents.maxSolvers`. |
| `variants` | spread strategies | Per solver: `name`, `hint` (a strategy; replaces the default, `""` for none), `model`, `thinking`. |
| `model`, `thinking` | Pi's | For every agent. |
| `verify` | detected | A shell command run in each workspace; `"none"` turns it off. Detection tries `package.json` test (bun/pnpm/yarn/npm), `cargo test`, `go test ./...`, pytest, `make test`. |
| `judge` | true | Spawn a judge once the solvers finish. |
| `judgeModel` | `model` | The judge's model. |
| `timeoutMinutes` | 30 | Unfinished solvers are stopped then; the judge still runs. |

A model-provided `cwd` must resolve inside the current session project (including
its Git root). This is checked before reserving a competition ID, detecting or
confirming verification, or copying any source files; symlinks cannot redirect
the copy outside that project.

Every solver gets a different default strategy, in order: the smallest
change; robustness; tests first; readability; an alternative approach;
the code's conventions. That keeps them from all writing the same thing.
A `hint` you give a solver replaces its default, and `""` gives it none.

Solvers aren't members of the collab group. Each solver works in its own workspace under the session directory: a
detached Git worktree of `HEAD` with your uncommitted and untracked changes
copied in, or a plain copy outside Git. It can't see or message the other
solvers, and nobody else can message it. When done it calls
`compete_submit` with its summary, approach, tests, confidence, and
caveats; the tool records its diff and runs the verify command. The judge
gets read-only tools, `compete_compare`, and `compete_verdict` (winner,
ranking, rationale, and a merge proposal when parts of several solutions
belong together).

You get one message when it's over: the judge's verdict, or the solvers'
answers without a judge.

### Reading the comparison

```text
/compete show c1
Competition c1 (running): Implement slugify in slugify.js so the tests pass
Verify: `node --test` (given)

| solver | state | submitted | verify | files | +/- | confidence | summary |
| --- | --- | --- | --- | --- | --- | --- | --- |
| c1-a | idle | yes | pass | 1 | +6/-1 | 1.00 | Implement slugify: NFD accent strip… |
| c1-b | idle | yes | pass | 1 | +6/-1 | 0.95 | Implement slugify: NFD normalize… |
| c1-c | idle | yes | pass | 1 | +8/-1 | 0.95 | Implement slugify: NFD normalize… |

Rubric order (changes, verify, submitted, confidence, smaller diff): c1-a > c1-b > c1-c
Verdict by c1-judge: winner c1-a; ranking c1-a > c1-b > c1-c
Rationale: All three pass node --test 5/5 …
```

`/compete compare` reruns verify for every solver and adds each solver's
approach, tests, caveats, verify output, and diff. Submission also runs verify
afresh, even when the diff is unchanged: ignored files, dependencies and other
verification inputs may have changed. `/compete list` lists the session's
competitions.

### Many solvers

With `piAgents.maxSolvers` raised, a competition can have dozens of
solvers. Past `piAgents.judgeBracketSize` (8) solvers, they're split into
even brackets of at most that size. Each bracket gets a judge
(`<id>-judge-1`, …) that ranks its solvers once they're done; the final
judge then compares the top 2 of every bracket (by its judge's ranking, or
by the rubric when a bracket judge gave no verdict). A judge's comparison
also shrinks each diff so all of them fit about 160,000 characters (some
40,000 tokens), so no judge's prompt grows with the number of solvers.

Verify commands, at submission and in comparisons, run at most
`piAgents.verifyConcurrency` (4) at once; the others wait, and each one's
timeout starts when it runs. Every workspace links the main workspace's
`node_modules`, nested ones in packages too, instead of installing its
own. Python virtual environments and build directories aren't shared:
they point at the main checkout, so solvers' tests would run its code.
Install those per workspace in the verify command, or use a tool with a
shared cache (`uv`, `pip`'s cache, Cargo's registry).

### Merging solutions

When solutions each get something right, have an agent combine them:

```text
/compete merge                 the two best ranked of the newest competition
/compete merge c1 c1-a c1-c    chosen solutions
```

```text
Merge c1-a and c1-c: keep c1-a's parser and c1-c's error messages.
```

Pi calls `agent_compete` with `action: "merge"`, `from` (default: the two
best ranked with changes, by the judge's ranking, else the rubric order),
and `guidance`, `model`, `thinking`, and `timeoutMinutes` if you like. The
merger works in a scratch workspace of its own, at the same starting point
as the solutions, so their patches apply there. It gets each solution's
workspace, patch, and submission, and the judge's ranking and merge
proposal. It submits like a solver, so verify runs, and the result appears
as one more candidate, `c1-m1`:

```text
| c1-m1 | idle | yes | pass | 1 | +2/-1 | 0.90 | c1-m1 combines … |
Merge c1-m1 combines c1-a + c1-b
```

The merge never touches your workspace. Apply it like any solution:
`/compete apply c1 c1-m1`. You can merge again, or merge a merge.

### Applying and cleaning up

```text
/compete apply c1 c1-a
/compete discard c1
```

Or ask Pi: "apply c1-a". Any candidate applies the same way, a merge
included. `apply` is the only step that touches your
workspace: it applies the solver's diff with `git apply` after a `--check`,
so a patch that doesn't fit changes nothing. In a Git repository it then
tries a three-way merge, which stages the files and, on a conflict, leaves
conflict markers to resolve. It refuses while that solver still works. Pi's tool guidance
tells it to apply only when you ask. Workspaces stay until `discard`, which
stops the competition's agents, merges included, and removes its worktrees;
its record stays. Model-callable apply/discard intentionally require no runtime
confirmation, including headless calls. The guidance to apply only when asked is
not an authorization boundary: prompt injection can still cause model-initiated
application or deletion of competition workspaces. IDs, persisted records and
workspace paths are validated independently; unsafe deletion paths are refused.

### Restarts

Competitions and groups live under the session's storage. After a restart
or `/resume`, `/compete show` and `/collab` show the same state, agents
resume as usual, and deadlines are enforced by the session's monitor.

A successful deadline stop is remembered by durable agent ID for the lifetime
of that service, including when its monitor is recreated. A user message can
resume that solver without the next monitor tick immediately stopping it again.
A newly owned agent ID still has its own deadline, even with the same solver
name; failed stops are retried. Saved `timedOut` names are diagnostics only and
cannot suppress a first deadline stop. After an actual service/process restart,
this memory is lost: a resumed overdue solver may cautiously be stopped again.

Verification approval is process-local, not trusted from persisted records.
After restart, automatic solver/judge verification is skipped until the command
is freshly authorized. Model compare/merge captures the exact command and timeout
before showing confirmation; changes during the prompt are refused. Explicit
`/compete compare` or `/compete merge` provides user authorization without a second
UI prompt, including headless sessions. The saved command is read once for this
authorization, with a positive timeout of at most 60 minutes; command or timeout
changes before execution are rejected. This intentionally trusts a saved command
when the user types the slash command: an agent-writable record is not tamper-proof.
A restored record must pass root/cwd consistency checks and bind to the current
project before verification, merge, or application; those operations fail closed
for records outside that project. An unsuccessful cross-project apply offers a
patch for manual review/application rather than writing to the recorded project.

Status/list and discard remain available for records with unsafe or missing
workspaces. Status reports unsafe entries without reading their diffs; discard
removes only validated workspace paths and reports refused entries. Restored
in-project discard also removes Git worktree registrations, without approving or
running saved verification. If the source cwd is deleted, the project binding
fails, or trusted project context is unavailable, cleanup falls back to contained
workspace directory removal only; it does not remove/prune Git registrations.
This also permits safe discard after restarting in another project, without
modifying that project's files. Stale registrations may remain and need a later
`git worktree prune` from the independently verified original repository. Failed
merge rollback uses project-aware cleanup when authorized project context is
available, otherwise the same contained-only fallback applies. One unsafe entry
does not prevent the monitor from stopping other overdue owners.

Active-state checks, discard and expiry use durable service membership, not
agent or graph IDs in `competition.json`. Missing IDs in that record do not hide
real owners; forged IDs cannot target unrelated work. Only wholly owned graphs
are stopped together; owners in mixed graphs are stopped individually. If durable
ownership cannot be read, operations requiring it fail closed and retain the
workspaces rather than assuming agents are stopped.

A start or merge failure can occur after its graph was committed, even before
the graph ID is returned. The extension reconciles durable owners and waits for
them to stop before deleting affected workspaces. If lookup or stopping fails,
it preserves those workspaces and attempts to save `orphan-start.json` or
`orphan-<merge-name>.json` beside `competition.json`, with available graph and
workspace details. These files are diagnostics, never authority to stop work,
run verification, or apply patches. Retrying discard reconciles durable ownership
again and removes the markers only after safe cleanup. If the main record is
unusable, keep the reported paths and review them before manual recovery. Never
delete a workspace while its owner may still be running.
