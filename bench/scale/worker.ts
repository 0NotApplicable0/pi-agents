import * as fs from "node:fs";
import { CollabStore } from "../../src/collab/store.ts";
const [root, idx, iters, startAt] = [process.argv[2]!, Number(process.argv[3]), Number(process.argv[4]), Number(process.argv[5])];
const store = new CollabStore(root, "main");
const me = { key: `agent-${idx}`, name: `a${idx}` };
while (Date.now() < startAt) {}
const lat: number[] = []; let timeouts = 0, hot = 0, errors = 0, violations = 0;
for (let k = 0; k < iters; k++) {
  const t = performance.now();
  try {
    // A unique resource each time (must never be lost) plus a hot one.
    const uniq = store.claim(me, [`path:u${idx}/${k}.js`]);
    if (!uniq.ok) errors++;
    const h = store.claim(me, ["path:hot.js"]);
    if (h.ok) { hot++; let marker: number | undefined; try { marker = fs.openSync(`${root}/hot.owner`, "wx"); } catch { violations++; } fs.appendFileSync(`${root}/hot.log`, `A ${idx} ${process.hrtime.bigint()}\n`); fs.appendFileSync(`${root}/hot.log`, `R ${idx} ${process.hrtime.bigint()}\n`); if (marker !== undefined) { fs.closeSync(marker); fs.unlinkSync(`${root}/hot.owner`); } store.release(me.key, ["path:hot.js"]); }
    store.update("shared", me.key, { note: `${idx}-${k}`, at: Date.now() * 1000 + idx * 100 + k });
  } catch (e) { if (String(e).includes("Timed out")) timeouts++; else { errors++; console.error(String(e).slice(0, 200)); } }
  lat.push(performance.now() - t);
}
console.log(JSON.stringify({ idx, lat, timeouts, hot, errors, violations }));
