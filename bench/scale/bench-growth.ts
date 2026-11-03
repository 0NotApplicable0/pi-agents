import * as fs from "node:fs"; import * as path from "node:path"; import * as os from "node:os";
import { board } from "../../src/collab/ops.ts";
import { CollabStore } from "../../src/collab/store.ts";
const med = (f: () => void, n = 7) => { const xs: number[] = []; for (let i = 0; i < n; i++) { const t = performance.now(); f(); xs.push(performance.now() - t); } return xs.sort((a, b) => a - b)[Math.floor(n / 2)]!.toFixed(1); };
const store = new CollabStore(fs.mkdtempSync(path.join(os.tmpdir(), "growth-")), "main");
console.log(JSON.stringify({ store: store.kind }));
// The database with its WAL, or the file store's claims file.
const size = (file: string) => (fs.existsSync(file) ? fs.statSync(file).size : 0);
const storeKb = () => Math.round((store.kind === "sqlite" ? size(path.join(store.dir, "collab.db")) + size(path.join(store.dir, "collab.db-wal")) : size(path.join(store.dir, "claims.json"))) / 1024);
for (let i = 0; i < 100; i++) store.upsertMember({ key: `agent-${i}`, agentId: `${i}`, name: `a${i}`, role: "r", group: "main", cwd: "/r", joinedAt: 0, updatedAt: Date.now(), state: "working", status: "live" });
let b = 0, m = 0, c: string[] = [];
for (const target of [1000, 5000, 20000]) {
  while (b < target) { store.post({ id: `b${b}`, kind: "finding", title: `t${b}`, body: "x".repeat(300), refs: [], author: "agent-1", authorName: "a1" }); b++; }
  while (m < target) { store.log({ id: `m${m}`, type: "message", from: "agent-1", fromName: "a1", to: "agent-2", toName: "a2", text: "y".repeat(200), refs: [], mode: "followUp", sentAt: 1e12 + m }); m++; }
  console.log(JSON.stringify({ entries: target, "board.read(50) ms": med(() => board(store, undefined, { action: "read", limit: 50 })), "messages(50) ms": med(() => store.messages(50)), "tasks ms": med(() => store.tasks()) }));
}
// Claims table growth: holds() checks each claim's owner.
const owners = Array.from({ length: 100 }, (_, i) => ({ key: `agent-${i}`, name: `a${i}` }));
for (const per of [1, 5, 20]) {
  for (const o of owners) store.release(o.key);
  for (const [i, o] of owners.entries()) store.claim(o, Array.from({ length: per }, (_, k) => `path:d${i}/f${k}.js`));
  console.log(JSON.stringify({ claimsHeld: 100 * per, "claim ms": med(() => store.claim(owners[0]!, ["path:d0/x.js"])), "claims() ms": med(() => store.claims()), "store kB": storeKb() }));
}
