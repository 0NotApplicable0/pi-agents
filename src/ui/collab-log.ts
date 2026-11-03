/** Read-only, windowed view of one group's retained collab_send log. */
import {
  type ExtensionContext,
  getMarkdownTheme,
} from "@earendil-works/pi-coding-agent";
import {
  type Component,
  getKeybindings,
  isKeyRelease,
  parseKey,
  type TUI,
  truncateToWidth,
} from "@earendil-works/pi-tui";
import {
  collabStore,
  DEFAULT_GROUP,
  listGroups,
  resolveCollab,
} from "../collab/membership.js";
import type { CollabMessage } from "../collab/store.js";
import { sanitizeLine } from "./format.js";
import {
  boxLine,
  edgeLine,
  fitHints,
  paneLayout,
  renderDetail,
  windowDetail,
} from "./frame.js";
import {
  firstLine,
  formatClock,
  type MessageStyle,
  themeStyle,
} from "./messages.js";
import type { AgentPanel } from "./panel.js";

export interface CollabLogSource {
  groups(): string[];
  /** Newest first. The caller validates the group before reading. */
  messages(group: string, limit: number): CollabMessage[];
}

export function collabLogSource(root: string): CollabLogSource {
  return {
    groups: () => listGroups(root),
    messages: (group, limit) => collabStore(root, group).messages(limit),
  };
}

/** Data and selection stay cached; rendering only formats visible rows. */
export class CollabLog {
  groups: string[];
  group: string;
  query = "";
  items: CollabMessage[] = [];
  selected = 0;
  hasMore = false;
  private limit = 200;
  private loaded: CollabMessage[] = [];

  constructor(
    private readonly source: CollabLogSource,
    group?: string,
  ) {
    this.groups = source.groups();
    this.group =
      group ??
      (this.groups.includes(DEFAULT_GROUP)
        ? DEFAULT_GROUP
        : (this.groups[0] ?? DEFAULT_GROUP));
    // Opening a store can create it. Validate syntax AND existence first.
    resolveCollab({ group: this.group }, "parent", ".");
    if (!this.groups.includes(this.group))
      throw new Error(
        group ? `No collab group ${group}.` : "No collab groups yet.",
      );
    this.refresh();
  }

  private read(group: string, limit: number): CollabMessage[] {
    // Check every read: switching or refreshing must not recreate removed groups.
    resolveCollab({ group }, "parent", ".");
    if (!this.source.groups().includes(group))
      throw new Error(`No collab group ${group}.`);
    return this.source.messages(group, limit + 1);
  }

  private replace(messages: CollabMessage[], id?: string): void {
    this.hasMore = messages.length > this.limit;
    this.loaded = messages.slice(0, this.limit);
    this.filter(id);
  }

  refresh(): void {
    const messages = this.read(this.group, this.limit);
    this.replace(messages, this.items[this.selected]?.id);
  }

  private filter(id?: string): void {
    const needle = this.query.trim().toLowerCase();
    this.items = this.loaded.filter(
      (message) =>
        !needle ||
        [
          message.id,
          message.fromName,
          message.toName,
          message.type,
          message.task ?? "",
          message.mode,
          message.text,
          ...message.refs,
        ].some((field) => field.toLowerCase().includes(needle)),
    );
    this.selected = Math.max(
      0,
      this.items.findIndex((message) => message.id === id),
    );
  }

  search(query: string): void {
    this.query = query;
    this.filter();
  }

  loadMore(): void {
    if (!this.hasMore) return;
    const limit = this.limit * 2;
    const messages = this.read(this.group, limit);
    this.limit = limit;
    this.replace(messages, this.items[this.selected]?.id);
  }

  move(delta: number): void {
    const hadItems = this.items.length > 0;
    // A filtered boundary can remain unchanged after loading: require explicit
    // Ctrl+L or End rather than repeatedly reading history on held arrow keys.
    if (
      !this.query.trim() &&
      this.selected + delta >= this.items.length &&
      this.hasMore
    )
      this.loadMore();
    this.selected = Math.max(
      0,
      Math.min(this.items.length - 1, this.selected + (hadItems ? delta : 0)),
    );
  }

  switchGroup(delta: number): void {
    const groups = this.source.groups();
    if (!groups.length) throw new Error("No collab groups yet.");
    const index = groups.indexOf(this.group);
    const next =
      index < 0
        ? delta > 0
          ? 0
          : groups.length - 1
        : (index + delta + groups.length) % groups.length;
    const group = groups[next] ?? this.group;
    if (group === this.group) {
      this.refresh();
      this.groups = groups;
      return;
    }
    // Read before changing any state, so a failed switch leaves the old view.
    const messages = this.read(group, 200);
    this.groups = groups;
    this.group = group;
    this.limit = 200;
    this.replace(messages);
  }
}

export function collabLogRow(
  message: CollabMessage,
  width: number,
  style: MessageStyle,
): string {
  const { color, bold } = style;
  return truncateToWidth(
    `${color("dim", formatClock(message.sentAt))} ${bold(sanitizeLine(message.fromName))}${color("dim", " → ")}${bold(sanitizeLine(message.toName))} ${color("accent", message.type)} ${color("dim", firstLine(message.text))}`,
    width,
    "…",
  );
}

class CollabLogView implements Component {
  private reading = false;
  private detailOffset = 0;
  private detailMax = 0;
  private detailAnchor: string | undefined;
  private error: string | undefined;
  private endTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly tui: TUI,
    private readonly style: MessageStyle,
    private readonly log: CollabLog,
    private readonly done: () => void,
  ) {}

  render(width: number): string[] {
    const { color } = this.style;
    const { items, selected, query, group, hasMore } = this.log;
    const title = `Message board · ${group} (${items.length}${hasMore ? "+" : ""})${query ? ` · ${sanitizeLine(query)}▌` : ""}${this.endTimer ? " · loading older…" : ""}`;
    const lines = [edgeLine(["╭", "╮"], color("accent", title), width, color)];
    const inner = Math.max(8, width - 4);
    const message = items[selected];
    const layout = paneLayout(this.tui.terminal.rows, items.length);
    const rows = this.reading
      ? layout.tableRows
      : layout.tableRows + layout.detailRows + 1;
    const start = Math.max(
      0,
      Math.min(selected - Math.floor(rows / 2), items.length - rows),
    );
    for (const [offset, item] of items.slice(start, start + rows).entries()) {
      const marker = start + offset === selected ? color("accent", "▸ ") : "  ";
      lines.push(
        boxLine(
          `${marker}${collabLogRow(item, inner - 2, this.style)}`,
          width,
          color,
        ),
      );
    }
    if (!message)
      lines.push(
        boxLine(
          color(
            "dim",
            query
              ? hasMore
                ? "No loaded messages match. Ctrl+L searches older history."
                : "No retained messages match."
              : "No collab messages yet.",
          ),
          width,
          color,
        ),
      );
    if (this.reading && message) {
      const anchor = `${group}:${message.id}`;
      if (anchor !== this.detailAnchor) {
        this.detailAnchor = anchor;
        this.detailOffset = 0;
      }
      lines.push(edgeLine(["├", "┤"], "", width, color));
      const detail = renderDetail(
        [
          sanitizeLine(
            `${message.id} · ${message.type} · ${message.mode}${message.task ? ` · task ${message.task}` : ""}`,
          ),
          ...(message.refs.length
            ? [sanitizeLine(`Refs: ${message.refs.join(", ")}`)]
            : []),
          { markdown: message.text },
        ],
        inner,
        color,
        getMarkdownTheme(),
      );
      const window = windowDetail(
        detail,
        layout.detailRows,
        this.detailOffset,
        color,
      );
      this.detailOffset = window.offset;
      this.detailMax = window.maxOffset;
      for (const line of window.shown)
        lines.push(boxLine("text" in line ? line.text : "", width, color));
      for (let i = window.shown.length; i < layout.detailRows; i++)
        lines.push(boxLine("", width, color));
    }
    if (this.error)
      lines.push(
        boxLine(color("error", sanitizeLine(this.error)), width, color),
      );
    lines.push(
      edgeLine(
        ["╰", "╯"],
        color(
          "dim",
          fitHints(
            [
              "↑↓ move",
              "type to filter",
              "⏎ read",
              ...(this.reading ? ["⇧↑↓ scroll"] : []),
              ...(hasMore ? ["ctrl+l older", "end oldest"] : []),
              "tab group",
              "ctrl+r refresh",
              "esc back",
            ],
            width - 6,
          ),
        ),
        width,
        color,
      ),
      "",
    );
    return lines;
  }

  handleInput(data: string): void {
    if (isKeyRelease(data)) return;
    this.dispose(); // Any key cancels an in-progress End traversal.
    this.error = undefined;
    try {
      this.input(data);
    } catch (error) {
      this.error = error instanceof Error ? error.message : String(error);
    }
    this.tui.requestRender();
  }

  private input(data: string): void {
    const key = parseKey(data) ?? data;
    const bindings = getKeybindings();
    if (bindings.matches(data, "tui.select.cancel")) {
      if (this.reading) this.reading = false;
      else if (this.log.query) this.log.search("");
      else {
        this.done();
        return;
      }
    } else if (key === "tab" || key === "shift+tab") {
      this.log.switchGroup(key === "tab" ? 1 : -1);
      this.detailOffset = 0;
    } else if (key === "ctrl+l") this.log.loadMore();
    else if (key === "ctrl+r") this.log.refresh();
    else if (key === "shift+up" || key === "shift+down")
      this.detailOffset = Math.max(
        0,
        Math.min(
          this.detailMax,
          this.detailOffset + (key === "shift+up" ? -1 : 1),
        ),
      );
    else if (key === "up" || bindings.matches(data, "tui.select.up"))
      this.log.move(-1);
    else if (key === "down" || bindings.matches(data, "tui.select.down"))
      this.log.move(1);
    else if (key === "pageUp") this.log.move(-10);
    else if (key === "pageDown") this.log.move(10);
    else if (key === "home") this.log.selected = 0;
    else if (key === "end") this.oldest();
    else if (bindings.matches(data, "tui.select.confirm"))
      this.reading = !this.reading;
    else if (key === "backspace") this.log.search(this.log.query.slice(0, -1));
    else if (
      key === "space" ||
      (data.length > 0 && !/[\p{Cc}\p{Zl}\p{Zp}]/u.test(data))
    )
      this.log.search(this.log.query + (key === "space" ? " " : data));
  }

  private oldest(): void {
    this.log.selected = Math.max(0, this.log.items.length - 1);
    if (!this.log.hasMore) return;
    // Yield between latest-N reads so End never loops through history in one
    // keyboard callback. Any subsequent key (including Esc) cancels the work.
    this.endTimer = setTimeout(() => {
      this.endTimer = undefined;
      try {
        this.log.loadMore();
        this.oldest();
      } catch (error) {
        this.error = error instanceof Error ? error.message : String(error);
      }
      this.tui.requestRender();
    }, 0);
  }

  dispose(): void {
    if (this.endTimer) clearTimeout(this.endTimer);
    this.endTimer = undefined;
  }

  invalidate(): void {}
}

export async function openCollabLog(
  ctx: Pick<ExtensionContext, "ui">,
  source: CollabLogSource,
  group?: string,
  panel?: Pick<AgentPanel, "setSuppressed">,
): Promise<void> {
  const log = new CollabLog(source, group);
  panel?.setSuppressed(true);
  try {
    await ctx.ui.custom<void>(
      (tui, theme, _bindings, done) =>
        new CollabLogView(tui, themeStyle(theme), log, () => done(undefined)),
    );
  } finally {
    panel?.setSuppressed(false);
  }
}
