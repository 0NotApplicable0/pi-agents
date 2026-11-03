import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { claims, overview } from "../../src/collab/ops.js";
import {
  CollabStore,
  canonicalPath,
  forgetCollabCaches,
  normalizeResource,
  overlaps,
} from "../../src/collab/store.js";

const roots: string[] = [];
const saved = process.env.PI_AGENTS_COLLAB_STORE;
afterEach(() => {
  forgetCollabCaches();
  if (saved === undefined) delete process.env.PI_AGENTS_COLLAB_STORE;
  else process.env.PI_AGENTS_COLLAB_STORE = saved;
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-claims-paths-"));
  roots.push(root);
  fs.mkdirSync(path.join(root, "pkg"));
  return root;
}

test("paths use real-file absolute identity across cwds and accept parents", () => {
  const root = fixture();
  const pkg = path.join(root, "pkg");
  const file = normalizeResource("pkg/x.ts", root);
  expect(normalizeResource("x.ts", pkg)).toBe(file);
  expect(normalizeResource(path.join(root, "pkg/x.ts"), pkg)).toBe(file);
  expect(normalizeResource("../pkg/x.ts", pkg)).toBe(file);
  expect(normalizeResource("..", pkg)).toBe(normalizeResource(".", root));
  expect(normalizeResource("../..", pkg)).toBe(
    `path:${canonicalPath("../..", pkg)}`,
  );
  expect(
    overlaps(
      normalizeResource("src", root),
      normalizeResource("src/y.ts", pkg),
    ),
  ).toBe(false);
  expect(overlaps(normalizeResource("pkg", root), file)).toBe(true);
  expect(overlaps("path:/", file)).toBe(true);
  expect(
    overlaps(
      normalizeResource("pkg/x", root),
      normalizeResource("pkg/xy", root),
    ),
  ).toBe(false);
  expect(normalizeResource("item:b1", root)).toBe("item:b1");
  expect(normalizeResource("key: .. ", root)).toBe("key:..");
});

test("symlinked ancestors and nonexistent suffixes resolve consistently, worktrees stay separate", () => {
  const root = fixture();
  const alias = path.join(root, "alias");
  fs.symlinkSync(path.join(root, "pkg"), alias, "dir");
  expect(canonicalPath("new/deep/x.ts", alias)).toBe(
    canonicalPath("new/deep/x.ts", path.join(root, "pkg")),
  );
  expect(normalizeResource("x.ts", alias)).toBe(
    normalizeResource("pkg/x.ts", root),
  );
  fs.mkdirSync(path.join(root, "worktree"));
  expect(
    overlaps(
      normalizeResource("x.ts", alias),
      normalizeResource("x.ts", path.join(root, "worktree")),
    ),
  ).toBe(false);
});

for (const backend of ["sqlite", "files"] as const) {
  describe(`${backend} path claims`, () => {
    test("conflicts, viewer-relative text, and release preserve canonical stored identity", () => {
      if (backend === "files") process.env.PI_AGENTS_COLLAB_STORE = "files";
      else delete process.env.PI_AGENTS_COLLAB_STORE;
      const root = fixture();
      const store = new CollabStore(path.join(root, "collab"), "g");
      expect(store.kind).toBe(backend);
      const register = (name: string, cwd: string) =>
        store.upsertMember({
          key: name,
          name,
          cwd,
          role: "worker",
          group: "g",
          joinedAt: Date.now(),
          updatedAt: Date.now(),
          state: "working",
          status: "live",
        });
      const a = register("a", root);
      const b = register("b", path.join(root, "pkg"));
      expect(
        claims(store, a, { action: "claim", resources: ["pkg/x.ts"] }).error,
      ).toBeUndefined();
      const canonical = normalizeResource("pkg/x.ts", root);
      const conflict = claims(store, b, {
        action: "claim",
        resources: ["x.ts"],
      });
      expect(conflict.error).toBe(true);
      expect(conflict.text).toContain("path:x.ts held by a");
      expect(conflict.data.conflicts?.[0]?.resource).toBe(canonical);
      expect(claims(store, b, { action: "list" }).text).toContain(
        "path:x.ts held by a",
      );
      expect(overview(store, { cwd: b.cwd })).toContain("path:x.ts held by a");
      expect(store.claims()[0]?.resource).toBe(canonical);
      expect(
        claims(store, a, { action: "release", resources: [canonical] }).data
          .claims,
      ).toHaveLength(1);
      expect(store.claims()).toEqual([]);
    });
  });
}
