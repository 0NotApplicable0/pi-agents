# Agent extension hooks

Co-loaded Pi extensions can capture state when agents are created, hold
model calls, and modify requests. Policy and user controls stay in your
extension; registration is optional.

## Register hooks

Register a listener in your extension factory. Pi-agents discovers callbacks
when the session starts, after all extension factories have loaded, and again
on reload or session replacement.

```ts
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AgentHooksDiscovery } from "pi-agents/hooks";

export default function (pi: ExtensionAPI) {
  pi.events.on("pi-agents:hooks:discover", (value) => {
    const discovery = value as AgentHooksDiscovery | undefined;
    if (discovery?.protocol !== 1 || typeof discovery.register !== "function")
      return;
    discovery.register({
      namespace: "my-extension",
      onAgentCreate: ({ parent }) => ({
        version: 1,
        owner: parent.sessionId,
      }),
      onAgentRequest: ({ state, model }, payload) => {
        // Read your stored state and return a provider-specific replacement.
        // Undefined leaves the payload unchanged.
        return undefined;
      },
    });
  });
}
```

The import from `pi-agents/hooks` is type-only. Consumers can implement the
same structural contract without importing or depending on pi-agents.

Registration is synchronous. Call `register` before the listener returns;
registrations after discovery finishes are ignored. Late-loaded registrations
require a reload. Pi removes an extension's `pi.events` listeners on reload
and session replacement.

Namespaces start with an ASCII letter or digit, contain only letters, digits,
`.`, `_`, `/`, or `-`, and are at most 128 characters. Pi-agents ignores
malformed registrations and every registration of a namespace that more than
one extension claims, and reports both in one notice. Agents keep working; an
ignored namespace behaves like an absent extension.

## Capture state

`onAgentCreate(ctx)` runs synchronously once per spawn from Pi, after
validation. A group with one or several agents counts as one spawn; agents
spawned by another agent inherit its snapshot instead of calling this hook.
It receives:

- `ctx.parent.sessionId`: the owning Pi session.
- `ctx.parent.branch`: a detached, frozen snapshot of its active branch at
  creation, including custom entries. Use this rather than cached
  `session_start` state to recover branch-local settings.

The context describes the parent, not the new agent: its model and provider
are known only per request, possibly after routing.

Return JSON or `undefined`. Pi-agents stores JSON under your namespace in each
agent's durable record, outside its prompt and Pi's transcript. Use a
version field inside your state if its format may evolve. Don't store secrets:
state is persisted in agent storage, not an encrypted credential store.

State must contain only plain objects, arrays, finite numbers, strings,
booleans, and null. Cycles, promises, functions, class instances, and nested
`undefined` values are rejected. Depth is limited to 32 and the combined
namespace map to 8 KiB per agent. Returned values are detached before storage.

Creation callbacks are snapshot operations, not exactly-once side effects:
a failed spawn can be attempted again. A thrown error or invalid state fails
creation without creating a partial group.

### Inheritance

- Agents in a group share the snapshot captured at creation, even if they
  start later.
- Agents spawned by another agent copy their spawner's entire state map
  without invoking creation callbacks.
- Follow-ups, retries, compaction, stop/reopen, and session recovery retain
  the stored state. Parent changes affect future top-level spawns only.

## Transform requests

`onAgentRequest(ctx, payload)` runs when the provider has built a generation
or compaction request. It can return a replacement synchronously or through
a promise. `undefined` preserves the incoming payload; any other value,
including `null`, replaces it.

The context contains:

| Field | Meaning |
| --- | --- |
| `sessionId` | Owning Pi session |
| `agent.id`, `agent.name` | Committed agent identity |
| `model.provider`, `model.api`, `model.id` | Actual dispatched model, after routing |
| `state` | Your namespace's detached, deeply frozen JSON, or `undefined` |
| `signal` | The child request's abort signal, when available |

Hooks run in lexicographic namespace order, each seeing the preceding
result. Request hooks run even without stored state; stateful consumers
must handle `undefined`.

Hook errors fail the request instead of silently sending the original payload.
The agent's error names the namespace and hook and includes the message of a
thrown `Error` or string, shortened to one line. Pi-agents never adds state or
payload contents; keep them out of your error messages too. Async hooks should
honor the signal. Cancellation ends the host's wait but cannot forcibly stop
arbitrary extension code.
Callbacks can run more than once if a provider rebuilds a request, so make
them idempotent and avoid mutating payloads retained by other code.

These hooks do not run for the parent, classifier/image calls, router-internal
calls, or deferred polling. Custom providers must honor Pi's `onPayload`
contract. Request purpose is not exposed.

## Hold requests

`beforeAgentRequest(ctx)` runs before each generation request and compaction
summary of an agent, before credentials resolve and the request is built. The
call waits until the callback returns or its promise settles. For example,
hold agents' calls during peak pricing:

```ts
discovery.register({
  namespace: "peak-pricing",
  beforeAgentRequest: async ({ model, signal }) => {
    while (isPeak(model.provider, Date.now())) await sleep(60_000, signal);
  },
});
```

The context contains:

| Field | Meaning |
| --- | --- |
| `sessionId` | Owning Pi session |
| `agent.id`, `agent.name` | Committed agent identity |
| `model.provider`, `model.api`, `model.id` | The agent's model; routing may still dispatch to another |
| `operation` | `generation` or `compaction` |
| `state` | Your namespace's detached, deeply frozen JSON, or `undefined` |
| `signal` | The agent's abort signal, when available |

Holding isn't stopping. A held agent stays working: it receives messages,
and tools it already called finish. Only the held call waits.

Your extension owns hold state and controls, such as a command to release
holds and a status entry explaining why agents wait.

- **Cancellation.** Stopping or interrupting the agent, stopping its graph,
  and shutting down end the wait, even if the callback ignores the signal.
  Honor the signal so your own code stops too.
- **Errors.** A throw neither holds nor fails the call: pi-agents reports the
  error with your namespace, and the call proceeds. To fail closed, catch
  errors in the callback and keep waiting.
- **Order.** Callbacks run in lexicographic namespace order, each after the
  previous one returned, so a call proceeds once none holds it.
- **Repeats.** The callback runs again for retries and for calls that resume
  after a restart. A compaction that a restart resumes mid-summary passes
  without it, and so does deferred polling.
- **Working-agent cap.** Callbacks run before an agent takes a slot. A run
  held at its first call takes none, but an agent held later in its run
  keeps its slot, so other agents may wait behind it.

Like the other hooks, it doesn't run for the parent or for classifier and
image calls.

## Optional consumers

If an extension is absent, its stored state remains intact but no callback
applies it. Pi-agents issues no warning and never substitutes current settings.
Loading the extension again restores its ability to interpret that state.

Snapshots never change, so a consumer must keep reading every state shape it
ever wrote. Reject an unknown state `version` explicitly, but within a known
version ignore fields and values you don't recognize. An older consumer then
still reads what a newer one wrote, and no agent fails every request over
state nobody can repair.

## Gate tool calls

`beforeAgentTool(ctx)` runs before every tool call of every agent, before
pi-durable records the call's intent. That includes model-issued calls,
spawning and messaging tools, `codemode` itself, and the calls a `codemode`
script makes (nested calls, with `ctx.parent` set). It is pi-durable's
`ToolTask.beforeTool`, so a blocked call never executes.

Return `undefined` to allow, or `{ block: true, reason? }` to block; the agent
sees `Tool call blocked: <reason>`. Anything else blocks: a throw, a rejected
promise, a malformed result such as `{ block: false }`, an aborted call, or
a call from a conversation pi-agents has no record of. Hooks cannot rewrite
arguments. Parallel tool calls of one agent, and calls of different agents,
run their hooks concurrently, once per call: keep callbacks reentrant and key
any state by `toolCallId`. Cancellation is not reported to the model as a
block; the call ends as aborted. Hooks run one at a time in namespace order, and the first block
wins. Cancellation ends the wait even if the callback ignores `ctx.signal`,
and the tool does not run.

| Field | Meaning |
| --- | --- |
| `sessionId` | Owning Pi session |
| `agent.id`, `agent.name`, `depth` | Committed agent identity; depth 1 for agents the session started |
| `model` | The agent's model |
| `cwd` | The agent's working directory, else the host's default |
| `toolName`, `toolCallId` | The call; both come from the host |
| `parent.toolCallId` | The calling tool call, for nested calls |
| `input` | Deeply frozen arguments, after pi-durable validated and coerced them |
| `spawner` | `{ agent, model?, context() }` of the agent that spawned this one; absent when the Pi session itself did |
| `context()` | `{ job, instructions?, messages, entries }`: the agent's own model context, read when first called, detached and frozen. `entries` splits it per committed entry with `kind` and `durableWork` |
| `signal` | The call's abort signal |

Identity comes from committed host records, never from the arguments. An
agent deeper than depth 1 must have a recorded spawner; if the record is
missing the call is blocked rather than treated as started by the session.
Message text is not authenticated: `user` messages may carry text from the
session, other agents, or tool output, so treat them as data. Only entries
with `durableWork: true` were appended by the host's own tasks.
`messages` are pi-ai model messages. `context()` is not pinned to a revision;
read it before awaiting other work if freshness matters. Hooks that need a
model call it themselves.

### Require the capability

Hosts that predate this hook ignore `beforeAgentTool`, which would leave
calls ungated. Check for the capability and the acknowledgement:

```ts
discovery.register({
  namespace: "approvals",
  beforeAgentTool: async (ctx) => decide(ctx),
  // Called synchronously after discovery, before any agent resumes.
  onAgentToolRegistration: ({ accepted, reason }) => {
    gated = accepted && discovery.capabilities?.beforeAgentTool === 1;
  },
});
```

Without `capabilities.beforeAgentTool` the host cannot gate anything: refuse
to run agents or warn the user. If any tool approval registration is lost
(a duplicate namespace, an invalid namespace or callback, or a throwing
`onAgentToolRegistration`), pi-agents fails closed: it tells registrants
`accepted: false`, reports why in one notice, and makes agents unavailable for
the session (see below). Fix the registration and reload.

### Require a gate for the session

Registration is per session start, so an extension that is removed, fails to
load, or loads after discovery leaves stored agents ungated when they resume.
To forbid that, name the namespace in your **global** Pi settings
(`~/.pi/agent/settings.json`; project settings are ignored for this):

```json
{ "piAgents": { "requiredToolGateNamespaces": ["approvals"] } }
```

While any listed namespace has no accepted `beforeAgentTool` registration,
or any registration was lost, pi-agents does not open the session's agents at
all: nothing resumes, spawning fails, and the reason is reported. It cannot
merely block new hook calls, because a call already past its gate may continue
after a restart without asking again (see Replay limits). A malformed value blocks too. The default is
empty, so existing setups are unchanged; an extension that needs the
guarantee must have its installer write this setting. Compatibility: hosts
before this setting ignore it, so also check `capabilities.beforeAgentTool`.
The requirement only protects calls while pi-agents runs; it cannot stop
agents of an older pi-agents version or processes outside pi-agents.

### Replay limits

The hook runs before intent. After a restart, a call that never recorded
intent runs the hook again. A call whose intent was recorded is **not** asked
again: pi-durable reruns it only if both the stored and current tool policy
say `safe` (`grep`, `find`, `ls`, `codemode`, and the messaging and collab
tools that declare `replay: "safe"`), and otherwise ends it as interrupted
without running it (`read`, `bash`, `edit` and `write` do not declare it).
A replay under an unchanged gate and tool policy therefore counts as the
earlier approval, not a fresh decision; executions are not rechecked. A rerun
`codemode` script is not asked again, but the nested calls it makes run
through the hook again. This is why a missing required gate makes the whole
session unavailable instead of only blocking new calls.
