import { afterEach, expect, spyOn, test } from "bun:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { AgentsDoc, GraphsDoc } from "../../src/agents/records.js";
import type { AgentService } from "../../src/agents/service.js";
import {
  AgentError,
  type GraphInfo,
  GraphStartedError,
  type SpawnSpec,
} from "../../src/agents/types.js";
import { closeService, hostOf, MODEL, openService } from "./helpers.js";

const services: AgentService[] = [];
afterEach(async () => {
  for (const service of services.splice(0)) await closeService(service);
});

async function open(options: Parameters<typeof openService>[0] = {}) {
  const service = await openService({ refreshDelayMs: 60_000, ...options });
  services.push(service);
  return service;
}

function solver(name: string, competition = "c1"): SpawnSpec {
  return {
    name,
    job: "solve",
    cwd: process.cwd(),
    model: MODEL,
    collab: { competition, part: "solver", solver: name },
  };
}

function agentId(graph: GraphInfo, index = 0): string {
  const id = graph.nodes[index]?.agentId;
  if (!id) throw new Error("Missing graph node");
  return id;
}

test.each(["refresh", "requireGraph"] as const)(
  "spawnGraph reports committed ownership when %s fails",
  async (method) => {
    const service = await open();
    const failure = new Error("injected read-back failure");
    const internals = service as unknown as {
      refresh(ids: string[]): Promise<void>;
      requireGraph(id: string): GraphInfo;
    };
    const injected = spyOn(internals, method).mockImplementationOnce(() => {
      throw failure;
    });
    let caught: unknown;
    try {
      await service.spawnGraph({ agents: [solver("s1")] });
    } catch (error) {
      caught = error;
    } finally {
      injected.mockRestore();
    }
    expect(caught).toBeInstanceOf(GraphStartedError);
    if (!(caught instanceof GraphStartedError)) throw caught;
    expect(caught.cause).toBe(failure);
    expect(caught.message).toContain(failure.message);
    expect(caught.agents).toHaveLength(1);
    const ownership = (await service.competitionOwners()).get("c1");
    expect(ownership?.agents.map((owner) => owner.agentId)).toEqual(
      caught.agents,
    );
    expect(ownership?.graphs).toEqual([{ id: caught.graphId, closed: false }]);
    const harness = hostOf(service).harness.harness;
    const records = await harness.snapshot(GraphsDoc, BACKGROUND_CONTEXT);
    expect(records?.graphs[caught.graphId]?.nodes[0]?.agent).toBe(
      caught.agents[0],
    );

    await service.stopTarget({ kind: "graph", id: caught.graphId });
    const stopped = (await service.competitionOwners()).get("c1");
    expect(stopped?.graphs).toEqual([{ id: caught.graphId, closed: true }]);
    expect(stopped?.agents[0]?.stopped).toBe(true);
  },
);

test("spawnGraph keeps validation and creation-hook failures unchanged", async () => {
  const failure = new Error("capture failed before commit");
  const service = await open({
    captureExtensionState: () => {
      throw failure;
    },
  });
  let invalid: unknown;
  try {
    await service.spawnGraph({ agents: [] });
  } catch (error) {
    invalid = error;
  }
  expect(invalid).toBeInstanceOf(AgentError);
  expect(invalid).not.toBeInstanceOf(GraphStartedError);
  await expect(service.spawnGraph({ agents: [solver("s1")] })).rejects.toBe(
    failure,
  );
  expect((await service.competitionOwners()).size).toBe(0);
});

test("spawnGraph keeps commit failures unchanged", async () => {
  const service = await open();
  const failure = new Error("commit failed");
  const commit = spyOn(
    hostOf(service).harness.anchor,
    "commit",
  ).mockRejectedValueOnce(failure);
  try {
    await expect(service.spawnGraph({ agents: [solver("s1")] })).rejects.toBe(
      failure,
    );
  } finally {
    commit.mockRestore();
  }
  expect((await service.competitionOwners()).size).toBe(0);
});

test("competitionOwners groups only pure graphs and retains mixed-graph owners", async () => {
  const service = await open();
  const pure = await service.spawnGraph({
    name: "competition",
    agents: [
      solver("s1"),
      {
        name: "judge",
        job: "judge",
        cwd: process.cwd(),
        model: MODEL,
        collab: { competition: "c1", part: "judge", bracket: 0 },
      },
    ],
  });
  const plain = await service.spawnGraph({
    agents: [{ name: "plain", job: "work", cwd: process.cwd(), model: MODEL }],
  });
  const mixed = await service.spawnGraph({
    name: "mixed",
    agents: [
      solver("s2"),
      { name: "other", job: "work", cwd: process.cwd(), model: MODEL },
      solver("s3", "c2"),
    ],
  });
  const ownership = await service.competitionOwners();
  expect(ownership.get("c1")).toEqual({
    agents: [
      {
        agentId: agentId(pure),
        graph: pure.id,
        part: "solver",
        solver: "s1",
        stopped: false,
      },
      {
        agentId: agentId(pure, 1),
        graph: pure.id,
        part: "judge",
        bracket: 0,
        stopped: false,
      },
      {
        agentId: agentId(mixed),
        graph: mixed.id,
        part: "solver",
        solver: "s2",
        stopped: false,
      },
    ],
    graphs: [{ id: pure.id, closed: false }],
  });
  expect(ownership.get("c2")?.agents.map((owner) => owner.agentId)).toEqual([
    agentId(mixed, 2),
  ]);
  expect(ownership.get("c2")?.graphs).toEqual([]);
  expect(
    [...ownership.values()].flatMap((owners) =>
      owners.agents.map((owner) => owner.agentId),
    ),
  ).not.toContain(agentId(plain));
  expect(ownership.size).toBe(2);
});

test("competitionOwners reads durable records, including closed owners, not the projection", async () => {
  const service = await open();
  const graph = await service.spawnGraph({ agents: [solver("s1")] });
  const id = agentId(graph);
  await hostOf(service).harness.harness.commit(async (tx) => {
    const record = (await tx.doc(AgentsDoc)).agents[id];
    if (!record?.collab) throw new Error("Missing membership");
    record.collab.competition = "c2";
    record.closed = true;
    record.stopped = true;
    const savedGraph = (await tx.doc(GraphsDoc)).graphs[graph.id];
    if (!savedGraph) throw new Error("Missing graph");
    savedGraph.closed = true;
  }, BACKGROUND_CONTEXT);
  expect(service.get(id)?.collab?.competition).toBe("c1");
  const ownership = await service.competitionOwners();
  expect(ownership.has("c1")).toBe(false);
  expect(ownership.get("c2")?.agents[0]?.stopped).toBe(true);
  expect(ownership.get("c2")?.graphs).toEqual([{ id: graph.id, closed: true }]);
});

test("competitionOwners excludes helpers and missing, empty, or spawned graphs", async () => {
  const service = await open();
  const helper = await service.spawnGraph({ agents: [solver("helper")] });
  const missing = await service.spawnGraph({ agents: [solver("missing")] });
  const empty = await service.spawnGraph({ agents: [solver("empty")] });
  const spawned = await service.spawnGraph({ agents: [solver("spawned")] });
  await hostOf(service).harness.harness.commit(async (tx) => {
    const helperRecord = (await tx.doc(AgentsDoc)).agents[agentId(helper)];
    if (!helperRecord) throw new Error("Missing helper");
    helperRecord.depth = 2;
    const graphs = (await tx.doc(GraphsDoc)).graphs;
    const emptyGraph = graphs[empty.id];
    const spawnedGraph = graphs[spawned.id];
    if (!emptyGraph || !spawnedGraph) throw new Error("Missing graphs");
    delete graphs[missing.id];
    emptyGraph.nodes = [];
    spawnedGraph.owner = { agent: agentId(helper), tool: 1 };
  }, BACKGROUND_CONTEXT);
  const ownership = (await service.competitionOwners()).get("c1");
  expect(ownership?.agents.map((owner) => owner.agentId)).toEqual([
    agentId(missing),
    agentId(empty),
    agentId(spawned),
  ]);
  expect(ownership?.graphs).toEqual([]);
});

test("competitionOwners propagates storage errors", async () => {
  const service = await open();
  const failure = new Error("storage unavailable");
  const snapshot = spyOn(
    hostOf(service).harness.harness,
    "snapshot",
  ).mockRejectedValueOnce(failure);
  try {
    await expect(service.competitionOwners()).rejects.toBe(failure);
  } finally {
    snapshot.mockRestore();
  }
});
