import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import {
  type FauxResponseStep,
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import type { AgentService } from "../../src/agents/service.js";
import type { AgentHooks, AgentToolContext } from "../../src/hooks.js";
import { readRequiredToolGates } from "../../src/host/settings.js";
import { requiredGateDenial } from "../../src/host/tool-hooks.js";
import {
  briefly,
  closeService,
  createFaux,
  jsonlStorage,
  MODEL,
  openService,
  tempDir,
  textOf,
  until,
} from "../agents/helpers.js";

let services: AgentService[] = [];
afterEach(async () => {
  for (const service of services) await closeService(service);
  services = [];
});

/** Jobs of the form `write <file>` write it; `lead <file>` spawns a
 * helper that writes it; `script <code>` runs a codemode script. */
function models() {
  const { faux, models } = createFaux();
  const step: FauxResponseStep = (context) => {
    const last = context.messages.at(-1);
    const text = textOf(last?.content);
    if (last?.role === "toolResult")
      return fauxAssistantMessage(`final: ${text}`);
    if (text.startsWith("write "))
      return fauxAssistantMessage(
        [
          fauxToolCall("write", {
            path: text.slice(6),
            content: "written",
          }),
        ],
        { stopReason: "toolUse" },
      );
    if (text.startsWith("lead "))
      return fauxAssistantMessage(
        [
          fauxToolCall("agent_spawn", {
            agents: [{ name: "kid", job: `write ${text.slice(5)}` }],
          }),
        ],
        { stopReason: "toolUse" },
      );
    if (text.startsWith("script "))
      return fauxAssistantMessage(
        [fauxToolCall("codemode", { code: text.slice(7) })],
        { stopReason: "toolUse" },
      );
    return fauxAssistantMessage(`done: ${text}`);
  };
  faux.setResponses(Array.from({ length: 100 }, () => step));
  return models;
}

async function open(hooks: AgentHooks[]) {
  const service = await openService({ models: models(), hooks });
  services.push(service);
  return service;
}

const agent = (name: string, job: string, extra = {}) => ({
  name,
  job,
  cwd: ".",
  model: MODEL,
  tools: ["write", "codemode"],
  ...extra,
});

const gate = (
  namespace: string,
  beforeAgentTool: AgentHooks["beforeAgentTool"],
): AgentHooks => ({ namespace, beforeAgentTool });

describe("beforeAgentTool", () => {
  test("allows, blocks with a reason, and passes trusted context", async () => {
    const dir = tempDir();
    const seen: AgentToolContext[] = [];
    const service = await open([
      gate("policy", async (ctx) => {
        seen.push(ctx);
        if (String(ctx.input.path).endsWith("denied"))
          return { block: true, reason: "not today" };
      }),
    ]);
    const ok = path.join(dir, "ok");
    const denied = path.join(dir, "denied");
    const graph = await service.spawnGraph({
      agents: [agent("a", `write ${ok}`), agent("b", `write ${denied}`)],
    });
    await service.wait([graph.id]);
    expect(fs.existsSync(ok)).toBe(true);
    expect(fs.existsSync(denied)).toBe(false);
    expect(service.get("b")?.result?.text).toContain("not today");
    const ctx = seen.find((each) => each.agent.name === "a");
    expect(ctx).toMatchObject({
      sessionId: "test-parent",
      agent: { name: "a" },
      model: { provider: MODEL.provider, id: MODEL.modelId },
      toolName: "write",
      input: { path: ok, content: "written" },
      depth: 1,
    });
    expect(ctx?.toolCallId).toBeTruthy();
    expect(ctx?.parent).toBeUndefined();
    expect(ctx?.spawner).toBeUndefined();
    expect(Object.isFrozen(ctx?.input)).toBe(true);
    const transcript = await ctx?.context();
    expect(transcript?.job).toBe(`write ${ok}`);
    expect(JSON.stringify(transcript?.messages)).toContain(`write ${ok}`);
    expect(Object.isFrozen(transcript?.messages)).toBe(true);
  });

  test("spawned helpers are gated and see their direct spawner", async () => {
    const dir = tempDir();
    const target = path.join(dir, "kid");
    const seen: AgentToolContext[] = [];
    const service = await open([
      gate("policy", async (ctx) => {
        seen.push(ctx);
        if (ctx.toolName === "write") return { block: true };
      }),
    ]);
    await service.spawnGraph({
      agents: [agent("lead", `lead ${target}`, { spawn: true })],
    });
    await until(() => seen.some((ctx) => ctx.toolName === "write"));
    expect(fs.existsSync(target)).toBe(false);
    const spawn = seen.find((ctx) => ctx.toolName === "agent_spawn");
    expect(spawn?.agent.name).toBe("lead"); // Spawning itself is gated.
    const write = seen.find((ctx) => ctx.toolName === "write");
    expect(write?.agent.name).toBe("lead.kid");
    expect(write?.depth).toBe(2);
    expect(write?.spawner?.agent.name).toBe("lead");
    expect(write?.spawner?.model).toEqual({
      provider: MODEL.provider,
      id: MODEL.modelId,
    });
    const parent = await write?.spawner?.context();
    expect(parent?.job).toBe(`lead ${target}`);
    expect(JSON.stringify(parent?.messages)).toContain("agent_spawn");
  });

  test("nested codemode calls are gated and name their caller", async () => {
    const dir = tempDir();
    const target = path.join(dir, "nested");
    const seen: AgentToolContext[] = [];
    const service = await open([
      gate("policy", (ctx) => {
        seen.push(ctx);
        if (ctx.parent) return { block: true, reason: "nested no" };
      }),
    ]);
    await service.spawnGraph({
      agents: [
        agent(
          "script",
          `script return await tools.write({ path: ${JSON.stringify(target)}, content: "x" });`,
        ),
      ],
    });
    await service.wait(["script"]);
    expect(fs.existsSync(target)).toBe(false);
    expect(service.get("script")?.result?.text).toContain("nested no");
    const outer = seen.find((ctx) => ctx.toolName === "codemode");
    const inner = seen.find((ctx) => ctx.toolName === "write");
    expect(outer?.parent).toBeUndefined();
    expect(inner?.parent?.toolCallId).toBe(outer?.toolCallId);
  });

  test("hooks run in namespace order; a block stops later hooks", async () => {
    const dir = tempDir();
    const target = path.join(dir, "ordered");
    const order: string[] = [];
    const service = await open([
      gate("b", () => {
        order.push("b");
      }),
      gate("a", () => {
        order.push("a");
        return { block: true, reason: "a says no" };
      }),
    ]);
    await service.spawnGraph({ agents: [agent("x", `write ${target}`)] });
    await until(() => service.get("x")?.result !== undefined);
    expect(order).toEqual(["a"]);
    expect(fs.existsSync(target)).toBe(false);
  });

  test.each([
    ["a throw", () => Promise.reject(new Error("boom"))],
    ["a malformed result", () => ({ allow: true }) as never],
    ["block false", () => ({ block: false }) as never],
    ["a true result", () => true as never],
  ])("%s blocks", async (_name, behave) => {
    const dir = tempDir();
    const target = path.join(dir, "failed");
    const service = await open([gate("policy", behave)]);
    await service.spawnGraph({ agents: [agent("x", `write ${target}`)] });
    await until(() => service.get("x")?.result !== undefined);
    expect(fs.existsSync(target)).toBe(false);
  });

  test("a pending hook holds the tool; stopping ends the wait", async () => {
    const dir = tempDir();
    const target = path.join(dir, "pending");
    let entered = 0;
    const service = await open([
      // Ignores its signal.
      gate("policy", () => {
        entered++;
        return new Promise(() => {});
      }),
    ]);
    await service.spawnGraph({ agents: [agent("x", `write ${target}`)] });
    await until(() => entered === 1);
    await briefly(undefined, 100);
    expect(fs.existsSync(target)).toBe(false);
    await service.stop("x");
    await until(() => service.get("x")?.state !== "working");
    await briefly(undefined, 50);
    expect(fs.existsSync(target)).toBe(false);
  });

  test("a lost registration blocks every tool call and reports the cwd", async () => {
    const dir = tempDir();
    const target = path.join(dir, "denied-all");
    const service = await openService({
      models: models(),
      hooks: [],
      toolDenial: "duplicate tool approval namespace",
    });
    services.push(service);
    await service.spawnGraph({ agents: [agent("x", `write ${target}`)] });
    await until(() => service.get("x")?.result !== undefined);
    expect(fs.existsSync(target)).toBe(false);
    expect(service.get("x")?.result?.text).toContain("unavailable");
  });

  test("an agent without a recorded cwd reports the host's", async () => {
    const seen: AgentToolContext[] = [];
    const dir = tempDir();
    const service = await open([
      gate("policy", (ctx) => {
        seen.push(ctx);
      }),
    ]);
    await service.spawnGraph({
      agents: [agent("x", `write ${path.join(dir, "f")}`)],
    });
    await until(() => seen.length > 0);
    expect(typeof seen[0]?.cwd).toBe("string");
    expect(seen[0]?.cwd.length).toBeGreaterThan(0);
  });

  test("a required gate missing after restart blocks resumed agents", async () => {
    const directory = tempDir();
    const target = path.join(tempDir(), "resumed");
    let entered = 0;
    const first = await openService({
      models: models(),
      storage: await jsonlStorage(directory),
      hooks: [
        gate("approvals", () => {
          entered++;
          return new Promise(() => {});
        }),
      ],
    });
    await first.spawnGraph({ agents: [agent("x", `write ${target}`)] });
    await until(() => entered === 1);
    await closeService(first);
    // The extension is gone, but settings still require it.
    const denial = requiredGateDenial(["approvals"], []);
    expect(denial).toContain("approvals");
    const second = await openService({
      models: models(),
      storage: await jsonlStorage(directory),
      hooks: [],
      toolDenial: denial,
    });
    services.push(second);
    await until(
      () => second.get("x")?.result?.text?.includes("unavailable") === true,
    );
    expect(fs.existsSync(target)).toBe(false);
  });

  test("required gate settings and registrations", () => {
    const set = (value: unknown) =>
      readRequiredToolGates({
        piAgents: { requiredToolGateNamespaces: value },
      });
    expect(readRequiredToolGates({})).toEqual({ namespaces: [], errors: [] });
    expect(set(["a", "a", "b"]).namespaces).toEqual(["a", "b"]);
    expect(set("a").errors).toHaveLength(1);
    expect(set([1]).errors).toHaveLength(1);
    const ok = { namespace: "a", beforeAgentTool: () => undefined };
    expect(requiredGateDenial([], [])).toBeUndefined();
    expect(requiredGateDenial(["a"], [ok])).toBeUndefined();
    expect(requiredGateDenial(["a"], [{ namespace: "a" }])).toBeDefined();
    expect(requiredGateDenial(["a", "b"], [ok])).toContain("b");
    expect(requiredGateDenial([], [], ["bad"])).toContain("bad");
  });

  test("without a consumer nothing is gated", async () => {
    const dir = tempDir();
    const target = path.join(dir, "free");
    const service = await open([{ namespace: "plain" }]);
    await service.spawnGraph({ agents: [agent("x", `write ${target}`)] });
    await until(() => fs.existsSync(target));
  });
});
