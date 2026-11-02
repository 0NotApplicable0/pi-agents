// In-process store benchmark: one Pi process runs every agent, and every
// store call is synchronous, so calls serialize on the event loop.
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { board } from "../../src/collab/ops.ts";
import { CollabStore } from "../../src/collab/store.ts";

const pct = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p * s.length))] ?? 0; };
function du(dir: string): { files: number; bytes: number } {
  let files = 0, bytes = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { const r = du(p); files += r.files; bytes += r.bytes; } else { files++; bytes += fs.statSync(p).size; }
  }
  return { files, bytes };
}
const CYCLES = Number(process.env.CYCLES ?? 10);
const rows: any[] = [];
for (const N of [10, 25, 50, 100]) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `scale-${N}-`));
  const store = new CollabStore(root, "main");
  const members = Array.from({ length: N }, (_, i) => ({ key: `agent-${i}`, agentId: `${i}`, name: `a${i}`, role: i % 2 ? "reviewer" : "implementer", group: "main", cwd: "/repo", joinedAt: 0, updatedAt: Date.now(), state: "working", status: "live" as const }));
  for (const m of members) store.upsertMember(m);
  const lat: Record<string, number[]> = {};
  const time = <T>(op: string, f: () => T): T => { const t = performance.now(); const r = f(); (lat[op] ??= []).push(performance.now() - t); return r; };
  let conflicts = 0, granted = 0, dup = 0, seq = 0;
  const F = N * 2; // file pool: conflicts are common
  const t0 = performance.now();
  for (let c = 0; c < CYCLES; c++) {
    for (const m of members) {
      const i = Number(m.agentId);
      time("board.post", () => store.post({ id: `b-${c}-${i}`, kind: "finding", title: `finding ${c} of ${m.name}`, body: "x".repeat(300), refs: [`path:f${i}.js`], author: m.key, authorName: m.name }));
      const files = [0, 1, 2].map((k) => `path:f${(i * 7 + c * 3 + k * 11) % F}.js`);
      time("release", () => store.release(m.key)); // last cycle's claims
      const out = time("claim", () => store.claim(m, files));
      if (out.ok) granted++; else conflicts++;
      time("send(log)", () => store.log({ id: `m-${++seq}`, type: "task_req", task: `t-${seq}`, from: m.key, fromName: m.name, to: `agent-${(i + 1) % N}`, toName: `a${(i + 1) % N}`, text: "please review " + "y".repeat(200), refs: [], mode: "followUp", sentAt: Date.now() }));
      // What collab_board read returns: a digest since scale-fixes.
      time("board.read(50)", () => board(store, undefined, { action: "read", limit: 50 }));
      time("claim.list", () => store.claims());
      time("peers(members)", () => store.members());
      time("status(messages50+tasks500)", () => { store.messages(50); store.tasks(); });
      if (c % 2 === 0) time("board.update", () => store.update(`b-${c}-${i}`, m.key, { status: "done", note: "ok" }));
    }
    // A monitor tick: one member read per agent (plus a write on change).
    time("monitor.tick", () => { for (const m of members) store.member(m.key); });
  }
  const wall = performance.now() - t0;
  // Correctness: a resource is never held twice.
  const held = store.claims().map((c) => c.resource);
  dup = held.length - new Set(held).size;
  const ops = Object.values(lat).reduce((s, xs) => s + xs.length, 0);
  const size = du(path.join(root, "main"));
  const row: any = { N, cycles: CYCLES, ops, wallMs: Math.round(wall), opsPerSec: Math.round(ops / (wall / 1000)), granted, conflicts, dupClaims: dup, files: size.files, kb: Math.round(size.bytes / 1024) };
  for (const [op, xs] of Object.entries(lat)) row[op] = `${pct(xs, 0.5).toFixed(2)}/${pct(xs, 0.95).toFixed(2)}/${Math.max(...xs).toFixed(1)}`;
  rows.push(row);
  console.log(JSON.stringify(row));
}
fs.writeFileSync("/tmp/inproc.json", JSON.stringify(rows, null, 2));
