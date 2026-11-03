# 🤖 pi-agents

Give [Pi](https://pi.dev) durable, named agents. Delegate a job, keep working
while the agent runs, and get its result back as a message. Watch any agent
live, talk to it, or stop it. Agents survive crashes and restarts.

Agents work as a team: they share a blackboard, claim files before they
change them, and hand off work and ask each other for reviews. Or several
agents solve the same task blind to each other, and you compare their
solutions, merge the best, and apply the one you pick.

> [!CAUTION]
> Agents can't use MCP servers
> ([earendil-works/pi#10837](https://github.com/earendil-works/pi/issues/10837))
> or tools from other extensions, such as web search
> ([earendil-works/pi#10386](https://github.com/earendil-works/pi/issues/10386)).
> They work with Pi's built-in tools: `read`, `bash`, `edit`, `write`, `grep`,
> `find`, `ls`, and `codemode`.

<table>
  <tr>
    <td width="50%"><img src="demo/agents.gif" alt="Pi starts an audit graph on three models whose reviewers delegate one helper per file, shows the live tree and the merged findings, browses the results in /agents, and spawns three agents that tell jokes"></td>
    <td width="50%"><img src="demo/messaging.gif" alt="Scout messages fixer about a concurrency bug, fixer patches it and replies, and Pi browses their exchange in /messages and attaches to both agents"></td>
  </tr>
  <tr>
    <td align="center">
      <strong>Delegate work to agents and graphs</strong><br>
      <small>Run parallel reviews, follow progress, and bring the findings together.</small>
    </td>
    <td align="center">
      <strong>Agents message each other</strong><br>
      <small>Coordinate a fix between agents, then browse their conversation.</small>
    </td>
  </tr>
</table>

## 🚀 Installation

```sh
pi install npm:pi-agents
```

## ✨ Usage

```text
Have an agent review src/run for error handling while we keep going.
```

```text
Spawn two agents in parallel: one maps the API surface, one checks the tests.
Merge their findings once both report back.
```

```text
Start a graph: three agents review src/run, src/ui, and src/host, and a
fourth merges their findings into one list of issues.
```

```text
Start an agent that may spawn agents: it finds every module under src, has
one agent review each, and returns one merged review.
```

Pi starts agents only when you ask for delegation. They work in the
background and return their final messages to your conversation. In a
graph, agents pass results to each other and Pi gets one message at the end.

## 🤝 Working together

The agents of a session are a team. Every agent is in the session's collab
group: it shares a blackboard of findings, decisions, questions, and todos
with the others, claims files before it changes them, and hands off work
and asks for reviews with structured messages. Use `/collab` to see group
coordination, including recent messages; `/collab messages` shows the latest
50 entries in the group's structured log. For the interactive stream,
including queued, delivered, and dropped agent messages, see
[`/messages`](docs/messaging.md). Give agents roles, or a group of their own.

```text
Spawn an implementer and a reviewer: the implementer adds input validation
to src/api/routes.ts, posting decisions to the board and claiming the file
first; the reviewer waits for a review request and answers it.
```

```text
/collab              group overview: members, claims, tasks, board, recent messages
/collab messages     latest 50 entries in the group's structured collab_send log
/collab board        the whole blackboard
/collab tasks        task_req/handoff/review_req and their answers
```

Or have several agents solve the same task independently, each in its own
worktree, and compare their solutions, or merge the best of them. Nothing
changes your workspace until you apply one:

```text
Run a competition with 3 solvers to fix the failing date parsing test;
verify with "bun test tests/date.test.ts" and let a judge pick.
```

```text
/compete show        the comparison table: verify result, diff size, confidence
/compete compare     run verify again everywhere and show each solution
/compete merge       an agent combines the two best into a new candidate
/compete apply c1 c1-b
/compete discard c1  remove the solvers' worktrees
```

Competitions require Git >=2.28 for worktrees and are not a sandbox: HOME,
files, network and linked dependencies remain accessible. Verification scrubs
sensitive environment names by default; model-requested verify commands require
UI confirmation and are refused unconfirmed headless. Explicit `/compete`
commands remain user-directed: after restart, slash compare/merge authorize the
saved verification without another prompt, after same-project and timeout checks.
Autonomous solver/judge verification stays skipped until freshly authorized;
unsealed cross-project apply fails closed and offers a patch instead. Detached
processes may outlive verification timeouts; no OS sandbox is provided.
Model-callable apply/discard intentionally have no runtime confirmation, so
prompt-injection risk remains. Existing resource
settings still accept project overrides, even in untrusted checkouts. See the
[security boundaries](docs/collab.md#verification-security) and
[environment policy](docs/configuration.md#verification-environment).

See [Working together](docs/collab.md) and its
[design](docs/collab-design.md).

## 🏗️ Architecture

Agents run inside Pi and use your Pi logins and models:

```text
╭─ Pi process ─────────────────────────────────────────────────────╮
│                                                                  │
│  ╭──────────────────╮ ╭────────────────────╮ ╭────────────────╮  │
│ ╭┤ ◆ Pi session:    │ │ ◇ optional         │ │ ▤ panel        │  │
│ ┊│   MCP, extension │ │   extensions, e.g. │ │ ⇄ attach view  │  │
│ ┊│   tools          │ │   pi-service-tier  │ │ ≡ /agents      │  │
│ ┊│                  │ │                    │ │ ✉ /messages    │  │
│ ┊╰───┬─────────▲────╯ ╰─────────┬──────────╯ ╰────────▲───────╯  │
│ ┊    │ agent_* │ results        ╎ hooks: capture at   │          │
│ ┊    │         │                ╎ spawn, hold calls,  │          │
│ ┊    ▼         │                ▼ adapt requests      │          │
│ ┊╭─────────────┴──────────────────────────────────────┴───────╮  │
│ ┊│  ✦ pi-agents: a thin bridge from Pi to pi-durable          │  │
│ ┊╰───┬─────────▲──────────────────────────────────────────────╯  │
│ ┊    │ start   │ state                                           │
│ ┊    │ message │ results                                         │
│ ┊    ▼ stop    │                                                 │
│ ┊╭─────────────┴──────────────────────────────────────────────╮  │
│ ┊│  pi-durable harness                                        │  │
│ ┊│                                                            │  │
│ ┊│   ◉ scout ─── message ──▶ ● notes                          │  │
│ ┊│                                                            │  │
│ ┊│   ╭─ graph ─────────────────────────╮  agent tools:        │  │
│ ┊│   │ ● map ─┬─▶ ◉ core ─┬─▶ ○ report │  read  bash  edit    │  │
│ ┊│   │        └─▶ ◉ ui ───┘            │  write  grep         │  │
│ ┊│   │            └─ ◉ ◉ ◉ spawned     │  find  ls  codemode  │  │
│ ┊│   ╰─────────────────────────────────╯                      │  │
│ ┊│                                                            │  │
│ ┊│   agents are conversations; turns, tool calls, and graphs  │  │
│ ┊│   are durable tasks that own what they start; model        │  │
│ ┊│   requests pass the hooks with each agent's snapshot       │  │
│ ┊╰─────────────────────────────┬──────────────────────────────╯  │
╰─┬──────────────────────────────┬─────────────────────────────────╯
  ┊ saves                        │ checkpoint every step
  ▼                              ▼
╭──────────────────────╮    ╭──────────────────────────────╮
│ ▤ Pi's session file  │    │ ▤ pi-agents store, one per   │
│   your conversation, │    │   session: agents and their  │
│   saved results, and │    │   hook snapshots, graphs,    │
│   message cards      │    │   messages, tasks            │
╰──────────────────────╯    ╰──────────────────────────────╯
```

## 📚 Documentation

- [Usage](docs/usage.md): glossary, states, skills, UI, commands, and tools.
- [Graphs](docs/graphs.md): coordinating agents, and agents that spawn agents.
- [Messaging](docs/messaging.md): using messages and their guarantees.
- [Agent profiles](docs/profiles.md): reusable settings and instructions.
- [Configuration](docs/configuration.md): models, requests, and footer counts.
- [Architecture](docs/architecture.md): recovery, storage, and lifecycle events.
- [Extension hooks](docs/hooks.md): capture settings, hold calls, and adapt requests.
- [Working together](docs/collab.md): collab groups and competitions in one session.
- [Collab design](docs/collab-design.md): how they work, and why.
