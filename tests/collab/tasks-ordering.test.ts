import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { overview } from "../../src/collab/ops.js";
import {
  type CollabMessage,
  CollabStore,
  foldTask,
  forgetCollabCaches,
  type TaskView,
} from "../../src/collab/store.js";

function message(type: CollabMessage["type"], sentAt: number): CollabMessage {
  const opening = type === "task_req" || type === "review_req";
  return {
    protocol: 1,
    id: `${type}-${sentAt}`,
    task: "t1",
    type,
    from: opening ? "requester" : "worker",
    fromName: opening ? "requester" : "worker",
    to: opening ? "worker" : "requester",
    toName: opening ? "worker" : "requester",
    text: opening ? "Requested title\nDetails" : "Finished result",
    refs: [opening ? "board:request" : "board:answer"],
    mode: "followUp",
    sentAt,
  };
}

for (const [request, answer] of [
  ["task_req", "task_done"],
  ["review_req", "review_done"],
] as const) {
  test(`${answer} before ${request} retains answer and enriches request metadata`, () => {
    const normal = new Map<string, TaskView>();
    const reversed = new Map<string, TaskView>();
    foldTask(normal, message(request, 10));
    foldTask(normal, message(answer, 20));
    foldTask(reversed, message(answer, 20));
    foldTask(reversed, message(request, 10));
    const task = reversed.get("t1");
    expect(task).toMatchObject({
      status: answer,
      title: "Requested title",
      requester: "requester",
      assignees: ["worker"],
      updatedAt: 20,
      last: "worker: Finished result",
    });
    expect(task?.refs.toSorted()).toEqual(normal.get("t1")?.refs.toSorted());
    foldTask(reversed, message("task_ack", 15));
    expect(reversed.get("t1")?.status).toBe(answer);
  });
}

const roots: string[] = [];
const saved = process.env.PI_AGENTS_COLLAB_STORE;
afterEach(() => {
  forgetCollabCaches();
  if (saved === undefined) delete process.env.PI_AGENTS_COLLAB_STORE;
  else process.env.PI_AGENTS_COLLAB_STORE = saved;
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});

for (const backend of ["sqlite", "files"] as const) {
  describe(`${backend} task ordering`, () => {
    for (const answer of [
      "task_ack",
      "task_clarify",
      "task_blocked",
    ] as const) {
      test(`orphan ${answer} stays out of open work until its request arrives`, () => {
        if (backend === "files") process.env.PI_AGENTS_COLLAB_STORE = "files";
        else delete process.env.PI_AGENTS_COLLAB_STORE;
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-task-orphan-"));
        roots.push(root);
        let store = new CollabStore(root, "g");
        store.log(message(answer, 20));
        forgetCollabCaches();
        store = new CollabStore(root, "g");
        // Preserve the answer internally, but don't advertise phantom work.
        expect(store.tasks()[0]).toMatchObject({
          status: answer,
          requester: "",
        });
        expect(overview(store)).toContain("Open tasks (0)");
        store.log(message("task_req", 10));
        expect(overview(store)).toContain("Open tasks (1)");
        expect(store.tasks()[0]).toMatchObject({
          status: answer,
          requester: "requester",
          title: "Requested title",
          updatedAt: 20,
        });
      });
    }
    for (const reversed of [false, true]) {
      test(`request and answer persist across reopen, reversed=${reversed}`, () => {
        if (backend === "files") process.env.PI_AGENTS_COLLAB_STORE = "files";
        else delete process.env.PI_AGENTS_COLLAB_STORE;
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-task-order-"));
        roots.push(root);
        let store = new CollabStore(root, "g");
        expect(store.kind).toBe(backend);
        store.log(
          message(reversed ? "task_done" : "task_req", reversed ? 20 : 10),
        );
        forgetCollabCaches();
        store = new CollabStore(root, "g");
        store.log(
          message(reversed ? "task_req" : "task_done", reversed ? 10 : 20),
        );
        forgetCollabCaches();
        expect(new CollabStore(root, "g").tasks()[0]).toMatchObject({
          id: "t1",
          status: "task_done",
          title: "Requested title",
          requester: "requester",
          assignees: ["worker"],
          updatedAt: 20,
          last: "worker: Finished result",
        });
      });
    }
  });
}
