# ⚙️ Configuration

Configure the models agents use, how many agents work at once and how far
spawning reaches, and show agent counts in the footer.

## Models

An agent runs on your session's model unless Pi or a profile picks another.
Models resolve like `pi --model`: `sonnet` picks the newest Sonnet you have
credentials for, and an exact ID such as `claude-sonnet-4-6` picks that
version. Run `pi --list-models` to see what's available.

Pi learns which names are models from your scoped models, the ones you pick
with `/scoped-models` or `--models`. Scope the models you want agents to use,
and Pi picks them by name: "spawn a Luna agent" runs on your scoped Luna.

## Settings from other extensions

Extensions must opt into [agent hooks](./hooks.md); parent request hooks
aren't inherited automatically. For example, a compatible pi-service-tier
version can pass its service tiers and `/fast` overrides to agents.
Captured settings survive resumes and pass to the agents that agents
spawn. Later parent changes affect future agents only.

## Working agents

At most 32 agents work at once by default. Lower the cap to reduce
contention, for example on a local model server; raise it for larger teams,
or set it to `0` to turn it off. Set it in `~/.pi/agent/settings.json` or
your project's `.pi/settings.json`:

```json
{
  "piAgents": {
    "maxWorkingAgents": 1
  }
}
```

An agent keeps its slot until its work ends, including tool calls, but
yields it while a direct `agent_wait` call waits for the agents it spawned.
Agents over the cap wait in order and show as working. A later message to a
finished agent waits for a new slot.

Agents in every group, including spawned agents, share the cap. Your
session's own requests don't count toward it. Restart Pi after changing it.
Your provider's rate limits still apply: 100 agents each sending requests
every few seconds need a rate limit well above 30 requests per second.

## Rate limits and a token budget

When a provider answers an agent's request with a rate limit (HTTP 429,
"rate limit", "too many requests"), every agent's next request waits: until
the time the provider's `Retry-After` names, or else for a delay that
starts at 1 second and doubles to 60 seconds, with jitter, until a request
succeeds. Pi already retries the limited request itself; the shared pause
keeps the other agents from piling onto the provider meanwhile.

To keep agents under your provider's tokens-per-minute limit, set a
budget:

```json
{
  "piAgents": {
    "maxTokensPerMinute": 400000
  }
}
```

An agent's request then waits until the tokens of the last minute's
requests, plus those still running, leave room for its own. A request's
size is estimated from its context (characters / 4) until its response
reports the real usage. A request estimated larger than the whole budget fails
immediately. Aborting releases its outstanding estimate without charging unknown
usage; a late response still accounts for actual usage. Stale reservations expire
after 120 seconds. Compactions retain their estimated charge.
Requests wait in order after an agent got its [working slot](#working-agents),
and compactions count too. The budget is off by default, and `0` turns it
off. It counts only this Pi session's agents, not your own requests or other
clients on the same API key, so set it below the provider's limit.

## Spawning limits

These limits keep a runaway spawn in check. Their defaults suit most
sessions; raise them for bigger teams:

| Setting | Default | Limits |
| --- | --- | --- |
| `maxAgentsPerSpawn` | 12 | Agents one `agent_spawn` call starts, yours or an agent's. |
| `maxSpawnedPerAgent` | 24 | Children one agent spawns over its lifetime, completed and cancelled ones included; it never replenishes. |
| `maxActiveSpawned` | 16 | Spawned agents with unfinished initial jobs in the session, including those waiting on dependencies. Later messages to agents whose initial jobs finished don't count toward it, but do toward `maxWorkingAgents`. |
| `maxDepth` | 3 | How deep agents nest: your agents are at depth 1, and agents at this depth can't spawn. |
| `maxSolvers` | 6 | Solvers in one [competition](./collab.md#competitions). |
| `maxWorkingAgents` | 32 | Agents working at once; `0` for no cap. |
| `maxTokensPerMinute` | off | Model tokens per minute across agents; see [rate limits](#rate-limits-and-a-token-budget). |
| `teamSize` | 12 | Agents per [sub-team](./collab.md#sub-teams) that one spawn forms; larger spawns split into teams of this size. |
| `maxBroadcast` | 16 | Recipients one `collab_send` broadcast to a team or the group reaches. |
| `broadcastsPerMinute` | 3 | Broadcasts one agent sends per minute. |
| `verifyConcurrency` | 4 | Competition verify commands that run at once. |
| `judgeBracketSize` | 8 | Solvers one judge compares; more [go to bracket judges](./collab.md#many-solvers) first. At least 4. |
| `collabRetainMessages` | 10000 | Newest messages each collab group keeps. |
| `collabRetainFinished` | 2000 | Newest finished (done or dropped) board entries each collab group keeps. |
| `collabRetainClosedTasks` | 5000 | Newest closed tasks each collab group keeps. |

Every value is a positive integer (`maxWorkingAgents` and
`maxTokensPerMinute` may be `0`); an invalid one keeps its default, and Pi
says so. For a team of 100 agents
that a lead agent spawns and coordinates:

```json
{
  "piAgents": {
    "maxAgentsPerSpawn": 100,
    "maxSpawnedPerAgent": 100,
    "maxActiveSpawned": 100,
    "maxWorkingAgents": 100
  }
}
```

Pi alone can start 100 agents in one call with just `maxAgentsPerSpawn`.
See [agents that spawn agents](./graphs.md#agents-that-spawn-agents).

## Verification environment

The following `piAgents` settings are read **only from global settings**
(`~/.pi/agent/settings.json`), when agents first open. Project settings cannot
loosen this environment policy:

| Setting | Default | Meaning |
| --- | --- | --- |
| `verifyEnv` | `"scrub"` | `"scrub"`, `"minimal"`, or `"inherit"`. |
| `verifyEnvPassthrough` | `[]` | Environment variable names explicitly allowed through any mode. |

`"scrub"` removes names containing `TOKEN`, `SECRET`, `PASSWORD`, `PASSWD`,
`KEY`, `CREDENTIAL`, `AUTH`, `COOKIE`, or `CONNECTION_STRING`/`CONNECTIONSTRING`
(case-insensitively), plus `DATABASE_URL`, `SENTRY_DSN`, `REDIS_URL`, `GIT_*`,
`BASH_ENV`, `ENV`, `SHELLOPTS`, `BASHOPTS`, `NODE_OPTIONS`, `LD_*`, and `DYLD_*`. It preserves ordinary environment
variables, including PATH and HOME. This is best-effort name filtering, not
comprehensive secret detection.
`"minimal"` keeps PATH, HOME, USER, LOGNAME, SHELL, TMPDIR, TMP, TEMP, LANG,
`LC_*`, SYSTEMROOT and WINDIR. `"inherit"` keeps the full environment.
All modes force `CI=1` and `FORCE_COLOR=0`. Explicit passthrough names override
filtering and may expose credentials; use sparingly. Invalid settings keep the
safe defaults and report an error. Restart the session after changes.

Model-requested verification additionally requires interactive UI approval;
unconfirmed headless execution is refused. Explicit user `/compete` commands do
not need this approval. No mode is a filesystem or network sandbox: HOME,
credentials on disk and shared `node_modules` remain accessible.

Approved verification runs again on every submit or verifying comparison, even
when the command and diff hash are unchanged: ignored files and shared dependencies
can affect the outcome. The last in-process result is retained only for display
and ranking when verification is explicitly disabled, and is cleared on unseal.
Saved results are historical, not authority to skip execution or award a passing
verification score after restart.

Resource, concurrency, token-budget and other existing settings intentionally
continue to use Pi's **merged project settings**, including untrusted checkouts.
A project can override global resource/cost limits. Review `.pi/settings.json`
before using agents in an unfamiliar repository; environment policy does not
protect against project-controlled spending or resource changes.

## Pi settings agents follow

Agents follow your Pi settings for provider retries and timeouts, retries
after errors, compaction, and how steering and follow-up messages queue.
They read them when the session first uses agents, so restart Pi after
changing them.

Compaction follows Pi's per-model token settings too: an agent on a model
listed in `compaction.modelOverrides` compacts with that entry's
`reserveTokens` and `keepRecentTokens`, keyed by the exact
`provider/modelId`. Pi's [settings reference](https://pi.dev/docs/latest/settings#per-model-compaction-overrides)
describes them.

Agents' model requests identify themselves to providers as Pi's do. While
Pi's install telemetry is on, which the `enableInstallTelemetry` setting or
the `PI_TELEMETRY` environment variable controls, requests to OpenRouter,
NVIDIA NIM, and OpenCode name Pi as the app that sent them; with it off,
they name no app.

## Storage retention

[Agent storage](./architecture.md#storage) remains after Pi deletes its
session file. To remove inactive stores, set a retention period in
`~/.pi/agent/settings.json` or your project's `.pi/settings.json`:

```json
{
  "piAgents": {
    "retentionDays": 30
  }
}
```

A store is old when neither it nor its agents' data changed for that many
days. When Pi starts, pi-agents deletes old stores in the background. It
keeps the current session's store and stores another running Pi holds, and
deleting one removes its agents for good. Without the setting, stores stay
forever. Changes apply the next time Pi starts.

## Footer counters

With [pi-fancy-footer](https://github.com/mavam/pi-fancy-footer), enable the
`agents` widget through `/fancy-footer` to show counts by state, such as
`2◉ 1● 3◌`. Counts include closed agents, but not closed spawned agents.
