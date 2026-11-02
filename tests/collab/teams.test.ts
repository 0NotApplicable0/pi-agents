/**
 * Large collab groups: sub-teams that spawns form, a short and paged
 * collab_peers, and broadcasts with a fanout cap and a rate limit.
 */

import { afterAll, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  type FauxResponseStep,
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { forgetBroadcasts, peersReport } from "../../src/agents/collab.js";
import type { AgentService } from "../../src/agents/service.js";
import { withTeam } from "../../src/collab/membership.js";
import {
  closeService,
  fauxModels,
  MODEL,
  openService,
  tempDir,
  textOf,
  until,
} from "../agents/helpers.js";

const step: FauxResponseStep = (context) => {
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

describe("sub-teams", () => {
  test("a spawn forms a team, split by teamSize; a named team wins", () => {
    const base = { group: "main", role: "dev", cwd: "/x" };
    const spawn = { name: "crew", count: 30, teamSize: 12 };
    expect(withTeam(base, { ...spawn, index: 0 }).team).toBe("crew-1");
    expect(withTeam(base, { ...spawn, index: 12 }).team).toBe("crew-2");
    expect(withTeam(base, { ...spawn, index: 29 }).team).toBe("crew-3");
    expect(withTeam(base, { ...spawn, count: 5, index: 2 }).team).toBe("crew");
    expect(
      withTeam(base, { ...spawn, count: 1, index: 0 }).team,
    ).toBeUndefined();
    expect(withTeam({ ...base, team: "ui" }, { ...spawn, index: 0 }).team).toBe(
      "ui",
    );
  });

  test("collab_peers summarizes a large group and pages the caller's team", () => {
    const agents: Record<string, never> = {};
    const record = (index: number) => ({
      name: `a${index}`,
      collab: {
        group: "main",
        role: index % 5 === 0 ? "reviewer" : "implementer",
        team: `crew-${Math.floor(index / 12) + 1}`,
        ...(index % 12 === 0 ? { lead: true } : {}),
        cwd: "/x",
      },
      ...(index === 7 ? { stopped: true } : {}),
    });
    for (let index = 0; index < 100; index += 1)
      (agents as Record<string, unknown>)[`id${index}`] = record(index);
    const caller = {
      agentId: "id1",
      agents,
      membership: {
        group: "main",
        role: "implementer",
        team: "crew-1",
        cwd: "/x",
      },
    } as never;
    const report = peersReport(caller, {}, () => "working");
    const lines = report.split("\n");
    // A summary, then the caller's own team: short however large the group.
    expect(lines.length).toBeLessThan(20);
    expect(report).not.toContain("- a12 ");
    expect(report).toContain("99 other members (working 98, stopped 1)");
    expect(report).toContain("Roles: implementer 79, reviewer 20");
    expect(report).toContain("crew-1 (lead a0)");
    expect(report).toContain("Team crew-1 (lead a0):");
    expect(report).toContain("- a0 role=reviewer working team=crew-1 (lead)");
    expect(report).toContain("- a7 role=implementer stopped team=crew-1");
    expect(report).not.toContain("- a12 ");

    const page = peersReport(
      caller,
      { team: "all", limit: 10, offset: 20 },
      () => "idle",
    );
    expect(page).toContain("Showing 21–30 of 99; offset 30 lists more");
    expect(
      page.split("\n").filter((line) => line.startsWith("- ")),
    ).toHaveLength(10);
    const reviewers = peersReport(
      caller,
      { role: "reviewer", limit: 100 },
      () => "idle",
    );
    expect(
      reviewers.split("\n").filter((line) => line.startsWith("- ")),
    ).toHaveLength(20);
  });

  test("a small group lists everyone without a summary", () => {
    const caller = {
      agentId: "1",
      agents: {
        "1": { name: "me", collab: { group: "g", role: "x", cwd: "/" } },
        "2": {
          name: "rev",
          collab: { group: "g", role: "reviewer", cwd: "/" },
        },
      },
      membership: { group: "g", role: "x", cwd: "/" },
    } as never;
    expect(peersReport(caller, {}, () => "idle")).toBe(
      "Collab group g:\n- rev role=reviewer idle",
    );
  });

  test("broadcasts reach a team or the group, within the fanout cap and rate limit", async () => {
    forgetBroadcasts();
    const base = tempDir("pi-collab-teams-");
    const root = path.join(base, "collab");
    const cwd = path.join(base, "repo");
    fs.mkdirSync(cwd, { recursive: true });
    const service = await openService({
      models: fauxModels(step),
      collab: { sessionId: () => "s1", root: () => root },
      spawningLimits: { perCall: 20, active: 20 },
      teams: { teamSize: 4, maxBroadcast: 6, broadcastsPerMinute: 2 },
    });
    services.push(service);
    const names = Array.from({ length: 10 }, (_, index) => `m${index}`);
    await service.spawnGraph({
      name: "crew",
      agents: names.map((name) => ({ name, job: "ready", cwd, model: MODEL })),
    });
    await until(() =>
      names.every((name) => service.get(name)?.state === "idle"),
    );
    expect(service.get("m0")?.collab).toMatchObject({ team: "crew-1" });
    expect(service.get("m5")?.collab).toMatchObject({ team: "crew-2" });
    expect(service.get("m9")?.collab).toMatchObject({ team: "crew-3" });

    const sent = await run(service, "m0", "collab_send", {
      to: "team",
      text: "team sync at noon",
    });
    expect(sent).toContain("Message sent to 3 of team crew-1: m1, m2, m3");
    for (const name of ["m1", "m2", "m3"])
      await until(() => result(service, name).includes("team sync at noon"));
    expect(result(service, "m4")).not.toContain("team sync");

    // The group has 9 others, more than the cap of 6.
    expect(
      await run(service, "m0", "collab_send", { to: "group", text: "all" }),
    ).toContain("more than a broadcast reaches (6");
    expect(
      await run(service, "m0", "collab_send", {
        to: "team:crew-3",
        type: "handoff",
        text: "x",
      }),
    ).toContain("Broadcasts carry plain messages");
    expect(
      await run(service, "m0", "collab_send", {
        to: "team:crew-3",
        text: "hi 3",
      }),
    ).toContain("Message sent to 2 of team crew-3");
    // Two broadcasts a minute: the third waits.
    expect(
      await run(service, "m0", "collab_send", { to: "team", text: "again" }),
    ).toContain("Wait");
    // Others have their own allowance.
    expect(
      await run(service, "m4", "collab_send", { to: "team", text: "from m4" }),
    ).toContain("Message sent to 3 of team crew-2");

    // A lead's agents join its team.
    await service.spawnGraph({
      agents: [
        {
          name: "boss",
          job: "ready",
          cwd,
          model: MODEL,
          spawn: true,
          collab: { team: "core", lead: true },
        },
      ],
    });
    await until(() => service.get("boss")?.state === "idle");
    await run(service, "boss", "agent_spawn", {
      agents: [{ name: "helper", job: "ready" }],
    });
    await until(() => result(service, "boss.helper").length > 0);
    expect(service.get("boss.helper")?.collab).toMatchObject({ team: "core" });
    expect(service.get("boss")?.collab).toMatchObject({
      team: "core",
      lead: true,
    });
    expect(await run(service, "m0", "collab_peers", {})).toContain(
      "core (lead boss)",
    );

    const peers = await run(service, "m0", "collab_peers", { team: "crew-2" });
    expect(peers).toContain("Team crew-2:");
    expect(peers).toContain("m5 role=m5");
  }, 30_000);
});
