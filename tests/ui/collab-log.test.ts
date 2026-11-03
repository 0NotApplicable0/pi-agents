import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
  Theme,
} from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { collabStore, groupsRoot } from "../../src/collab/membership.js";
import {
  type CollabMessage,
  forgetCollabCaches,
} from "../../src/collab/store.js";
import { type CommandDeps, registerCommands } from "../../src/pi/commands.js";
import {
  CollabLog,
  type CollabLogSource,
  collabLogSource,
  openCollabLog,
} from "../../src/ui/collab-log.js";

function message(index: number): CollabMessage {
  return {
    protocol: 1,
    id: `m-${index}`,
    type: "task_req",
    task: `task-${index}`,
    from: "agent-a",
    fromName: "Alice",
    to: "agent-b",
    toName: "Bob",
    text: `Message ${index}`,
    refs: [`path:file-${index}.ts`],
    mode: "followUp",
    sentAt: index,
  };
}

function source(count = 501) {
  const history = Array.from({ length: count }, (_, i) => message(count - i));
  const reads: Array<[string, number]> = [];
  const data: CollabLogSource = {
    groups: () => ["docs", "main"],
    messages: (group, limit) => {
      reads.push([group, limit]);
      return group === "main" ? history.slice(0, limit) : [];
    },
  };
  return { data, reads, history };
}

function dialog(data: CollabLogSource) {
  let view!: Component;
  let close!: () => void;
  const ctx = {
    ui: {
      custom: (factory: Parameters<ExtensionContext["ui"]["custom"]>[0]) =>
        new Promise<void>((resolve) => {
          close = resolve;
          view = factory(
            { terminal: { rows: 30 }, requestRender() {} } as TUI,
            {
              fg: (_name: string, text: string) => text,
              bold: (text: string) => text,
            } as Theme,
            {} as Parameters<typeof factory>[2],
            resolve,
          );
        }),
    },
  } as unknown as Pick<ExtensionContext, "ui">;
  const opened = openCollabLog(ctx, data);
  return { view, close, opened };
}

describe("/message-board", () => {
  test("non-terminal invocation explains the limitation without opening storage or a dialog", async () => {
    const commands = new Map<
      string,
      Parameters<ExtensionAPI["registerCommand"]>[1]
    >();
    registerCommands(
      {
        registerCommand: (name, options) => commands.set(name, options),
      } as unknown as ExtensionAPI,
      {
        focus: {},
        host: {
          collabRoot: () => {
            throw new Error("must not open storage");
          },
        },
      } as unknown as CommandDeps,
    );
    const notices: string[] = [];
    await commands.get("message-board")?.handler("main", {
      mode: "rpc",
      hasUI: true,
      ui: {
        notify: (text: string) => notices.push(text),
        custom: () => {
          throw new Error("must not open dialog");
        },
      },
    } as unknown as Parameters<
      NonNullable<ReturnType<typeof commands.get>>["handler"]
    >[1]);
    expect(notices).toEqual(["/message-board needs Pi's terminal UI."]);
  });
  test("defaults to main, grows on boundary navigation, retains selection and reaches the oldest retained message", () => {
    const { data, reads } = source();
    const log = new CollabLog(data);
    expect(log.group).toBe("main");
    expect(reads).toEqual([["main", 201]]);
    expect(log.items).toHaveLength(200);
    log.move(199);
    log.move(1);
    expect(log.selected).toBe(200);
    expect(log.items[200]?.id).toBe("m-301");
    log.loadMore();
    expect(log.selected).toBe(200);
    expect(log.hasMore).toBe(false);
    log.move(1000);
    expect(log.items[log.selected]?.id).toBe("m-1");
    expect(reads.map((read) => read[1])).toEqual([201, 401, 801]);
  });

  test("filter searches names, types, tasks, references and older history on demand", () => {
    const { data, reads } = source();
    const log = new CollabLog(data);
    for (const query of [
      "ALICE",
      "bob",
      "task_req",
      "task-501",
      "path:file-501.ts",
    ]) {
      log.search(query);
      expect(log.items[0]?.id).toBe("m-501");
    }
    log.search("Message 1");
    expect(log.items).toHaveLength(0);
    expect(reads).toHaveLength(1);
    log.loadMore();
    expect(log.items.length).toBeGreaterThan(0);
    log.loadMore();
    expect(log.items.some((item) => item.id === "m-1")).toBe(true);
    log.search("");
    log.move(20);
    const id = log.items[log.selected]?.id;
    log.refresh();
    expect(log.items[log.selected]?.id).toBe(id);
    log.switchGroup(1);
    expect(log.group).toBe("docs");
    expect(log.items).toEqual([]);
    log.switchGroup(-1);
    expect(log.group).toBe("main");
    expect(log.items).toHaveLength(200);
  });

  test("unknown and invalid groups never open a store or create directories", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-collab-log-"));
    try {
      collabStore(root, "main").log(message(1));
      const before = fs.readdirSync(groupsRoot(root));
      for (const group of ["missing", "../escape", "main other"])
        expect(() => new CollabLog(collabLogSource(root), group)).toThrow();
      expect(fs.readdirSync(groupsRoot(root))).toEqual(before);
      expect(fs.existsSync(path.join(root, "escape"))).toBe(false);
      const { data, reads } = source();
      expect(() => new CollabLog(data, "missing")).toThrow("No collab group");
      expect(reads).toEqual([]);
      expect(() => new CollabLog({ ...data, groups: () => [] })).toThrow(
        "No collab groups yet",
      );
    } finally {
      forgetCollabCaches();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("Tab discovers new groups and recovers when the selected group disappears", () => {
    const { data } = source();
    let groups = ["main"];
    data.groups = () => groups;
    const log = new CollabLog(data);
    groups = ["main", "new"];
    log.switchGroup(1);
    expect(log.group).toBe("new");
    groups = ["main"];
    log.switchGroup(-1);
    expect(log.group).toBe("main");
    groups = [];
    expect(() => log.switchGroup(1)).toThrow("No collab groups yet");
    expect(log.group).toBe("main");
  });

  test("Tab and Shift+Tab refresh a sole group without losing depth or selection", async () => {
    const { data, reads } = source(1000);
    data.groups = () => ["main"];
    const { view, close, opened } = dialog(data);
    view.handleInput?.("\u000c"); // 400 loaded
    for (let i = 0; i < 30; i++) view.handleInput?.("\u001b[6~"); // Select beyond initial 200.
    view.handleInput?.("\r");
    expect(view.render(100).join("\n")).toContain("m-700 · task_req");
    for (const key of ["\t", "\u001b[Z"]) {
      view.handleInput?.(key);
      expect(reads.at(-1)).toEqual(["main", 401]);
      const frame = view.render(100).join("\n");
      expect(frame).toContain("Message board · main (400+)");
      expect(frame).toContain("m-700 · task_req");
    }
    close();
    await opened;
  });

  test("filter input rejects pasted control characters and line separators but accepts printable Unicode", async () => {
    const { data } = source();
    const { view, close, opened } = dialog(data);
    view.handleInput?.("Alice");
    for (const control of [
      "\n",
      "\r",
      "\t",
      "\u0000",
      "\u001b",
      "\u007f",
      "\u0085",
      "\u2028",
      "\u2029",
    ]) {
      view.handleInput?.(`Bob${control}extra`);
      const frame = view.render(100).join("\n");
      expect(frame).toContain("Alice▌");
      expect(frame).not.toContain("extra");
    }
    view.handleInput?.("\u001b"); // Clear filter.
    view.handleInput?.("Zoë 日本");
    expect(view.render(100).join("\n")).toContain("Zoë 日本▌");
    close();
    await opened;
  });

  test("failed reads preserve state and keyboard errors stay visible without recreating removed groups", async () => {
    const { data, reads } = source();
    const original = data.messages;
    let failure = false;
    data.messages = (group, limit) => {
      if (failure || group === "docs") throw new Error("Store unavailable");
      return original(group, limit);
    };
    const log = new CollabLog(data);
    log.move(20);
    const id = log.items[log.selected]?.id;
    expect(() => log.switchGroup(1)).toThrow("Store unavailable");
    expect(log.group).toBe("main");
    expect(log.items[log.selected]?.id).toBe(id);
    failure = true;
    expect(() => log.loadMore()).toThrow();
    failure = false;
    log.loadMore();
    expect(reads.at(-1)?.[1]).toBe(401); // Failed load did not grow the limit.

    const { view, close, opened } = dialog(data);
    for (const key of ["\t", "\u0012", "\u000c"]) {
      failure = key !== "\t";
      expect(() => view.handleInput?.(key)).not.toThrow();
      expect(view.render(100).join("\n")).toContain("Store unavailable");
      expect(view.render(100).join("\n")).toContain("Message board · main");
    }
    data.groups = () => ["docs"];
    const before = reads.length;
    view.handleInput?.("\u0012");
    expect(view.render(100).join("\n")).toContain("No collab group main");
    expect(reads).toHaveLength(before);
    view.handleInput?.("\u001b");
    close();
    await opened;
  });

  test("filtered boundary navigation does not repeatedly read older history", () => {
    const { data, reads } = source();
    const log = new CollabLog(data);
    log.search("not present");
    for (let i = 0; i < 10; i++) log.move(1);
    expect(reads).toHaveLength(1);
    log.loadMore();
    expect(reads).toHaveLength(2);
  });

  test("End progressively reaches the oldest retained match and can be cancelled", async () => {
    const { data, reads } = source(10000);
    const { view, close, opened } = dialog(data);
    view.handleInput?.("Message 1");
    view.handleInput?.("\u001b[F");
    expect(reads).toHaveLength(1); // Loading yields before each read.
    for (let i = 0; i < 100 && (reads.at(-1)?.[1] ?? 0) < 12801; i++)
      await new Promise((resolve) => setTimeout(resolve, 2));
    expect(reads.at(-1)?.[1]).toBe(12801);
    view.handleInput?.("\r");
    expect(view.render(100).join("\n")).toContain("m-1 · task_req");
    view.handleInput?.("\u001b");
    view.handleInput?.("\u001b");
    view.handleInput?.("\t");
    view.handleInput?.("\t"); // main, reset to initial window
    const before = reads.length;
    view.handleInput?.("\u001b[F");
    view.handleInput?.("\u001b"); // cancel and close
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(reads).toHaveLength(before);
    close();
    await opened;
  });

  test("detail pane height stays fixed across short and long messages", async () => {
    const { data, history } = source();
    const long = history[1];
    if (!long) throw new Error("Missing test message");
    long.text = Array.from({ length: 30 }, (_, i) => `Line ${i}`).join("\n");
    const { view, close, opened } = dialog(data);
    view.handleInput?.("\r");
    const short = view.render(100).length;
    view.handleInput?.("\u001b[B");
    expect(view.render(100)).toHaveLength(short);
    close();
    await opened;
  });

  test("dialog windows large logs, handles keys, and restores the panel on close", async () => {
    const { data, reads } = source(10000);
    let view: Component | undefined;
    let close: (() => void) | undefined;
    const suppressed: boolean[] = [];
    const ctx = {
      ui: {
        custom: (factory: Parameters<ExtensionContext["ui"]["custom"]>[0]) =>
          new Promise<void>((resolve) => {
            close = resolve;
            view = factory(
              { terminal: { rows: 30 }, requestRender() {} } as TUI,
              {
                fg: (_name: string, text: string) => text,
                bold: (text: string) => text,
              } as Theme,
              {} as Parameters<typeof factory>[2],
              resolve,
            );
          }),
      },
    } as unknown as Pick<ExtensionContext, "ui">;
    const opened = openCollabLog(ctx, data, undefined, {
      setSuppressed: (value) => {
        suppressed.push(value);
      },
    });
    expect(view).toBeDefined();
    for (let i = 0; i < 7; i++) view?.handleInput?.("\u000c"); // Ctrl+L
    expect(reads.at(-1)?.[1]).toBe(12801);
    const frame = view?.render(100) ?? [];
    expect(frame.length).toBeLessThan(30);
    expect(frame.join("\n")).toContain("10000");
    const count = reads.length;
    view?.render(100);
    expect(reads).toHaveLength(count);
    view?.handleInput?.("\r");
    expect(view?.render(100).join("\n")).toContain("task-10000");
    view?.handleInput?.("\u001b"); // close detail pane
    view?.handleInput?.("Alice");
    expect(view?.render(100).join("\n")).toContain("Alice▌");
    view?.handleInput?.("\u001b"); // clear filter
    view?.handleInput?.("\t");
    expect(view?.render(100).join("\n")).toContain("docs");
    view?.handleInput?.("\u001b"); // close
    close?.();
    await opened;
    expect(suppressed).toEqual([true, false]);
  });
});
