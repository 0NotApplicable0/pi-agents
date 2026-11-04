import { describe, expect, test } from "bun:test";
import {
  createEventBus,
  type ExtensionContext,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import {
  AGENT_HOOKS_DISCOVER,
  type AgentHooksDiscovery,
} from "../../src/hooks.js";
import { copyExtensionValue, hookError } from "../../src/host/hook-state.js";
import { captureAgentState, discoverAgentHooks } from "../../src/pi/hooks.js";

describe("agent hook discovery and capture", () => {
  test("optional, ordered, synchronous discovery with detached creation state", () => {
    const events = createEventBus();
    expect(discoverAgentHooks(events)).toEqual({ hooks: [], problems: [] });
    const source = { version: 1, settings: { enabled: true } };
    let late: AgentHooksDiscovery | undefined;
    events.on(AGENT_HOOKS_DISCOVER, (message) => {
      late = message as AgentHooksDiscovery;
      late.register({ namespace: "z" });
      late.register({
        namespace: "a",
        onAgentCreate: (ctx) => {
          const { branch } = ctx.parent;
          expect(Object.isFrozen(branch.at(-1))).toBe(true);
          expect(ctx.parent.branch).toBe(branch); // Shared, detached once.
          expect(branch.at(-1)?.type).toBe("custom");
          return source;
        },
      });
    });
    const { hooks, problems } = discoverAgentHooks(events);
    late?.register({ namespace: "late" });
    expect(problems).toEqual([]);
    expect(hooks.map((hook) => hook.namespace)).toEqual(["a", "z"]);
    const manager = SessionManager.inMemory();
    manager.appendCustomEntry("settings", { enabled: true });
    const state = captureAgentState(hooks, {
      sessionManager: manager,
    } as ExtensionContext);
    source.settings.enabled = false;
    expect(state).toEqual({ a: { version: 1, settings: { enabled: true } } });
    expect(
      Object.isFrozen(manager.getBranch().at(-1)), // Pi's entries stay its own.
    ).toBe(false);
  });

  test("broken registrations are ignored; capture errors still fail creation", () => {
    const events = createEventBus();
    events.on(AGENT_HOOKS_DISCOVER, (message) => {
      const discovery = message as AgentHooksDiscovery;
      discovery.register({ namespace: "duplicate" });
      discovery.register({ namespace: "duplicate" });
      discovery.register({ namespace: "not valid" });
      discovery.register({
        namespace: "not-a-function",
        beforeAgentRequest: 1 as never,
      });
      discovery.register({ namespace: "kept" });
    });
    const { hooks, problems } = discoverAgentHooks(events);
    expect(hooks.map((hook) => hook.namespace)).toEqual(["kept"]);
    expect(problems).toEqual([
      'invalid registration "not valid"',
      'invalid registration "not-a-function"',
      'duplicate namespace "duplicate"',
    ]);
    const ctx = {
      sessionManager: SessionManager.inMemory(),
    } as ExtensionContext;
    expect(() =>
      captureAgentState(
        [
          {
            namespace: "broken",
            onAgentCreate: () => {
              throw new Error("no");
            },
          },
        ],
        ctx,
      ),
    ).toThrow("Agent extension broken: onAgentCreate failed: no");
    expect(() =>
      captureAgentState(
        [{ namespace: "big", onAgentCreate: () => "x".repeat(9 * 1024) }],
        ctx,
      ),
    ).toThrow("exceeds 8 KiB");
  });

  test("errors name the hook and keep only a message as detail", () => {
    expect(hookError("ns", "onAgentRequest", { secret: 1 }).message).toBe(
      "Agent extension ns: onAgentRequest failed",
    );
    expect(
      hookError("ns", "onAgentRequest", new Error("bad\nstate")).message,
    ).toBe("Agent extension ns: onAgentRequest failed: bad state");
  });

  test("state rejects values JSON would lose or change", () => {
    const cycle: unknown[] = [];
    cycle.push(cycle);
    for (const value of [
      cycle,
      { missing: undefined },
      Infinity,
      new Date(),
      Promise.resolve(1),
      () => 1,
      [undefined],
    ])
      expect(() => copyExtensionValue(value)).toThrow();
    expect(copyExtensionValue({ value: null, array: [1, true, "x"] })).toEqual({
      value: null,
      array: [1, true, "x"],
    });
  });
});

describe("beforeAgentTool discovery", () => {
  test("advertises the capability and acknowledges registrations synchronously", () => {
    const events = createEventBus();
    const acks: Record<string, unknown> = {};
    let capabilities: unknown;
    events.on(AGENT_HOOKS_DISCOVER, (message) => {
      const discovery = message as AgentHooksDiscovery;
      capabilities = discovery.capabilities;
      discovery.register({
        namespace: "good",
        beforeAgentTool: () => undefined,
        onAgentToolRegistration: (result) => {
          acks.good = result;
        },
      });
      for (const copy of [1, 2])
        discovery.register({
          namespace: "twin",
          beforeAgentTool: () => undefined,
          onAgentToolRegistration: (result) => {
            acks[`twin${copy}`] = result;
          },
        });
      discovery.register({
        namespace: "bad",
        beforeAgentTool: "no" as never,
      });
    });
    const { hooks, problems } = discoverAgentHooks(events);
    expect(capabilities).toEqual({ beforeAgentTool: 1 });
    expect(hooks.map((hook) => hook.namespace)).toEqual(["good"]);
    // The duplicate and invalid registrations block all tools, so none is accepted.
    expect(acks.good).toMatchObject({ accepted: false });
    expect(acks.twin1).toMatchObject({ accepted: false });
    expect(acks.twin2).toMatchObject({ accepted: false });
    expect(problems.some((each) => each.includes("bad"))).toBe(true);
  });

  test("a clean registration is acknowledged as accepted", () => {
    let ack: unknown;
    discoverAgentHooks({
      emit: (_name, message) =>
        (message as AgentHooksDiscovery).register({
          namespace: "good",
          beforeAgentTool: () => undefined,
          onAgentToolRegistration: (result) => {
            ack = result;
          },
        }),
    });
    expect(ack).toEqual({ accepted: true });
  });

  test("a throwing acknowledgement is reported, not fatal", () => {
    const events = createEventBus();
    events.on(AGENT_HOOKS_DISCOVER, (message) => {
      (message as AgentHooksDiscovery).register({
        namespace: "x",
        onAgentToolRegistration: () => {
          throw new Error("nope");
        },
      });
    });
    const { hooks, problems } = discoverAgentHooks(events);
    expect(hooks).toHaveLength(1);
    expect(problems[0]).toContain("nope");
  });
});

describe("beforeAgentTool registration failures deny tools", () => {
  const discover = (
    register: (discovery: AgentHooksDiscovery) => void,
  ): ReturnType<typeof discoverAgentHooks> => {
    const events = createEventBus();
    events.on(AGENT_HOOKS_DISCOVER, (message) =>
      register(message as AgentHooksDiscovery),
    );
    return discoverAgentHooks(events);
  };

  test("clean registrations deny nothing", () => {
    expect(
      discover((d) =>
        d.register({ namespace: "ok", beforeAgentTool: () => undefined }),
      ).toolDenial,
    ).toBeUndefined();
  });

  test("duplicates, invalid registrations, and a failing ack deny", () => {
    const acks: unknown[] = [];
    const duplicate = discover((d) => {
      for (const _ of [1, 2])
        d.register({ namespace: "dup", beforeAgentTool: () => undefined });
      d.register({
        namespace: "other",
        beforeAgentTool: () => undefined,
        onAgentToolRegistration: (result) => acks.push(result),
      });
    });
    expect(duplicate.toolDenial).toContain("dup");
    expect(acks).toEqual([
      { accepted: false, reason: "tool calls are blocked" },
    ]);
    expect(
      discover((d) =>
        d.register({ namespace: "bad ns", beforeAgentTool: () => undefined }),
      ).toolDenial,
    ).toBeDefined();
    expect(
      discover((d) =>
        d.register({ namespace: "x", beforeAgentTool: "no" as never }),
      ).toolDenial,
    ).toBeDefined();
    expect(
      discover((d) =>
        d.register({
          namespace: "x",
          beforeAgentTool: () => undefined,
          onAgentToolRegistration: () => {
            throw new Error("ack");
          },
        }),
      ).toolDenial,
    ).toBeDefined();
    // Lifecycle-only duplicates don't touch tool gating.
    expect(
      discover((d) => {
        d.register({ namespace: "life" });
        d.register({ namespace: "life" });
      }).toolDenial,
    ).toBeUndefined();
  });
});
