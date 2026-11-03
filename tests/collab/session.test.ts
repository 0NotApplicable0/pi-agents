/**
 * Agents of one session working together: a collab group's blackboard,
 * advisory claims, structured messages, and the parent's view of it.
 */

import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  type FauxResponseStep,
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import type { AgentService } from "../../src/agents/service.js";
import { collabStore } from "../../src/collab/membership.js";
import { CollabStore } from "../../src/collab/store.js";
import {
  CollabMonitor,
  Competitions,
  collabReport,
  registerCollab,
} from "../../src/pi/collab.js";
import {
  closeService,
  fauxModels,
  MODEL,
  openService,
  tempDir,
  textOf,
  until,
} from "../agents/helpers.js";

/** `tool <name> <json>` input calls the tool; anything else is echoed. */
const step: FauxResponseStep = (context) => {
  // Section updates arrive as system messages; the turn's input precedes.
  const last = context.messages.filter((each) => each.role !== "system").at(-1);
  const text = textOf(last?.content);
  const command = /^(?:\[user\] )?tool (\S+) (.*)$/s.exec(text);
  if (last?.role === "user" && command)
    return fauxAssistantMessage(
      [fauxToolCall(command[1] as string, JSON.parse(command[2] as string))],
      { stopReason: "toolUse" },
    );
  if (last?.role === "toolResult") return fauxAssistantMessage(`tool: ${text}`);
  return fauxAssistantMessage(`got: ${text}`);
};

const services: AgentService[] = [];
afterAll(async () => {
  for (const service of services) await closeService(service);
});

const result = (service: AgentService, name: string) =>
  service.get(name)?.result?.text ?? "";

async function run(
  service: AgentService,
  name: string,
  tool: string,
  args: object,
) {
  const before = service.get(name)?.result?.text;
  await service.prompt(
    name,
    `tool ${tool} ${JSON.stringify(args)}`,
    "followUp",
  );
  await until(
    () =>
      service.get(name)?.state === "idle" &&
      result(service, name) !== before &&
      result(service, name).startsWith("tool:"),
  );
  return result(service, name);
}

describe("collab in one session", () => {
  test("store: a member lives until it's marked exited, which drops its claims", () => {
    const store = new CollabStore(tempDir("pi-collab-store-"), "g");
    const member = {
      key: "agent-1",
      agentId: "1",
      name: "impl",
      role: "implementer",
      group: "g",
      cwd: "/x",
      joinedAt: 0,
      // Long past: liveness doesn't depend on recent updates.
      updatedAt: 0,
      state: "idle",
      status: "live" as const,
    };
    store.upsertMember(member);
    expect(store.members().map((each) => each.name)).toEqual(["impl"]);
    expect(store.claim(member, ["path:src"]).ok).toBe(true);
    expect(
      store.claim({ key: "agent-2", name: "rev" }, ["path:src/a.ts"]),
    ).toMatchObject({ ok: false, conflicts: [{ ownerName: "impl" }] });
    store.setStatus("agent-1", "paused");
    // A paused member's claims hold through the grace period.
    expect(store.claims().map((claim) => claim.resource)).toEqual(["path:src"]);
    store.setStatus("agent-1", "exited", "stopped");
    expect(store.members()[0]).toMatchObject({
      status: "exited",
      state: "stopped",
    });
    expect(store.claims()).toEqual([]);
  });

  test("board, claims, review and handoff within one group; groups stay apart", async () => {
    const base = tempDir("pi-collab-");
    const root = path.join(base, "collab");
    const cwd = path.join(base, "repo");
    fs.mkdirSync(path.join(cwd, "src"), { recursive: true });
    const binding = { sessionId: () => "s1", root: () => root };
    const service = await openService({
      models: fauxModels(step),
      collab: binding,
    });
    services.push(service);
    await service.spawnGraph({
      agents: [
        {
          name: "impl",
          job: "ready",
          cwd,
          model: MODEL,
          collab: { role: "implementer" },
        },
        {
          name: "rev",
          job: "ready",
          cwd,
          model: MODEL,
          collab: { role: "reviewer" },
        },
        {
          name: "far",
          job: "ready",
          cwd,
          model: MODEL,
          collab: { group: "docs" },
        },
        {
          name: "plain",
          job: "ready",
          cwd,
          model: MODEL,
          spawn: true,
        },
      ],
    });
    await until(() =>
      ["impl", "rev", "far", "plain"].every(
        (name) => service.get(name)?.state === "idle",
      ),
    );

    // Every agent is a member, of the default group unless it names one.
    for (const name of ["impl", "rev", "far", "plain"])
      expect(service.get(name)?.tools, name).toEqual(
        expect.arrayContaining([
          "collab_board",
          "collab_claim",
          "collab_send",
          "collab_peers",
        ]),
      );
    expect(service.get("plain")?.collab).toMatchObject({
      group: "main",
      role: "plain",
    });
    expect(service.get("impl")?.collab).toMatchObject({
      group: "main",
      role: "implementer",
    });
    expect(service.get("far")?.collab).toMatchObject({
      group: "docs",
      role: "far",
    });

    const peers = await run(service, "impl", "collab_peers", {});
    expect(peers).toContain("rev role=reviewer");
    expect(peers).not.toContain("far");

    // Claims: advisory and all-or-nothing, with the holder named.
    expect(
      await run(service, "impl", "collab_claim", {
        action: "claim",
        resources: ["src/a.ts"],
      }),
    ).toContain("Claimed path:src/a.ts");
    const conflict = await run(service, "rev", "collab_claim", {
      action: "claim",
      resources: ["src"],
    });
    expect(conflict).toContain("overlap");
    expect(conflict).toContain("impl");
    // Another group has its own claims.
    expect(
      await run(service, "far", "collab_claim", {
        action: "claim",
        resources: ["src"],
      }),
    ).toContain("Claimed path:src");

    // The blackboard.
    const posted = await run(service, "impl", "collab_board", {
      action: "post",
      kind: "decision",
      title: "Use a Map for the cache",
      body: "O(1) lookups",
    });
    const entry = /board:(\S+?)\./.exec(posted)?.[1];
    expect(entry).toBeDefined();
    expect(
      await run(service, "rev", "collab_board", { action: "read" }),
    ).toContain("Use a Map for the cache");
    expect(
      await run(service, "far", "collab_board", { action: "read" }),
    ).not.toContain("Use a Map");

    // A review request by role, answered with review_done.
    const sent = await run(service, "impl", "collab_send", {
      to: "role:reviewer",
      type: "review_req",
      text: "Please review src/a.ts",
      refs: [`board:${entry}`, "path:src/a.ts"],
    });
    expect(sent).toContain("review_req");
    expect(sent).toContain("sent to rev");
    const task = /task "([^"]+)"/.exec(sent)?.[1] as string;
    expect(task).toBeDefined();
    await until(() =>
      result(service, "rev").includes("Please review src/a.ts"),
    );
    expect(result(service, "rev")).toContain("review_req");
    expect(result(service, "rev")).toContain(`board:${entry}`);
    await run(service, "rev", "collab_send", {
      to: "impl",
      type: "review_done",
      task,
      text: "Looks good",
    });
    await until(() => result(service, "impl").includes("Looks good"));

    // A handoff opens a task too.
    const handoff = await run(service, "impl", "collab_send", {
      to: "rev",
      type: "handoff",
      text: "Finish the docs",
    });
    expect(handoff).toContain("task_ack/task_clarify/task_done/task_blocked");

    // Answers need the task ID; other groups are out of reach.
    expect(
      await run(service, "rev", "collab_send", {
        to: "impl",
        type: "task_done",
        text: "x",
      }),
    ).toContain("needs the task ID");
    expect(
      await run(service, "far", "collab_send", { to: "impl", text: "hi" }),
    ).toContain("isn't another member of collab group docs");

    const store = collabStore(root, "main");
    expect(store.tasks().map((each) => [each.status, each.assignees])).toEqual(
      expect.arrayContaining([
        ["review_done", ["rev"]],
        ["handoff", ["rev"]],
      ]),
    );

    // The parent's view.
    expect(collabReport(root, undefined, "groups")).toBe(
      "Collab groups: docs, main",
    );
    expect(collabReport(root, "main", "board")).toContain(
      "Use a Map for the cache",
    );
    expect(collabReport(root, "main", "claims")).toContain("impl");
    expect(collabReport(root, "main", "tasks")).toContain(`✓`);
    expect(collabReport(root, "main", "overview")).toContain("rev");

    // The monitor keeps members' states current, and a stopped member's
    // claims are released.
    const monitor = new CollabMonitor(
      { current: () => service, collabRoot: () => root } as never,
      new Competitions(() => root),
    );
    await monitor.tick(true);
    expect(collabReport(root, "main", "overview")).toContain(
      "rev role=reviewer idle",
    );
    await service.stop("impl");
    await monitor.tick(true);
    monitor.disarm();
    expect(collabReport(root, "main", "claims")).toBe("No claims in main.");
    expect(
      await run(service, "rev", "collab_claim", {
        action: "claim",
        resources: ["src"],
      }),
    ).toContain("Claimed path:src");
    // The section tells the others who left.
    expect(await run(service, "rev", "collab_peers", {})).toContain(
      "impl role=implementer stopped",
    );

    // Agents that agents spawn join their spawner's group unless they name
    // another. collab_send reaches the group across graphs; agent_send's
    // reach is unchanged.
    await run(service, "plain", "agent_spawn", {
      agents: [
        { name: "h", job: 'tool collab_send {"to":"rev","text":"hi from h"}' },
        { name: "k", job: 'tool agent_send {"name":"rev","message":"hi"}' },
        { name: "d", job: "ready", group: "docs", role: "writer" },
      ],
    });
    await until(() =>
      ["plain.h", "plain.k", "plain.d"].every(
        (name) => result(service, name).length > 0,
      ),
    );
    expect(service.get("plain.h")?.collab).toMatchObject({
      group: "main",
      role: "h",
    });
    expect(service.get("plain.h")?.tools).toContain("collab_board");
    expect(service.get("plain.d")?.collab).toMatchObject({
      group: "docs",
      role: "writer",
    });
    expect(result(service, "plain.h")).toContain("sent to rev");
    await until(() => result(service, "rev").includes("hi from h"));
    expect(result(service, "plain.k")).toContain("within your reach");
  }, 30_000);
});

describe("registration", () => {
  function fakePi() {
    const tools = new Map<string, { defaultActive?: boolean }>();
    const commands = new Map<string, unknown>();
    const pi = {
      registerTool: (tool: { name: string; defaultActive?: boolean }) =>
        tools.set(tool.name, tool),
      registerCommand: (name: string, command: unknown) =>
        commands.set(name, command),
    } as never;
    return { pi, tools, commands };
  }

  test("parent tools and commands are always there", () => {
    const host = { collabRoot: () => undefined, current: () => undefined };
    const fake = fakePi();
    registerCollab(fake.pi, host as never).monitor.disarm();
    expect([...fake.tools.keys()]).toEqual(["agent_compete", "collab_status"]);
    expect([...fake.commands.keys()]).toEqual(["collab", "compete"]);
  });
});
