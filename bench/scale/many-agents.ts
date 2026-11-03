/**
 * N scripted agents in one session (faux model with a fixed latency), each
 * reading the board, claiming a file (with conflicts), posting, sending to
 * a peer, listing peers, and releasing. Run: N=100 LATENCY_MS=300 [CAP=32] bun bench/scale/many-agents.ts
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, type FauxResponseFactory } from "@earendil-works/pi-ai/providers/faux";
import { closeService, jsonlStorage, MODEL, openService, tempDir, textOf } from "../../tests/agents/helpers.js";

const N = Number(process.env.N ?? 10);
const LATENCY = Number(process.env.LATENCY_MS ?? 300);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let inflight = 0, peak = 0, calls = 0, firstCtx = 0, firstTools = 0, firstSys = 0;
const ctxBytes: number[] = [];
const finishedSet = new Set<number>();

const step: FauxResponseFactory = async (context) => {
  calls++; inflight++; peak = Math.max(peak, inflight);
  try {
    await sleep(LATENCY);
    const ctx = context as any;
    const size = JSON.stringify(ctx).length; ctxBytes.push(size);
    if (!firstCtx) { if (process.env.DEBUG) console.error(Object.keys(ctx), Object.keys(ctx.messages?.[0] ?? {}), JSON.stringify(ctx).slice(0, 1500)); firstCtx = size; firstTools = JSON.stringify(ctx.tools ?? []).length; firstSys = JSON.stringify(ctx.systemPrompt ?? ctx.system ?? "").length; }
    const msgs = ctx.messages as any[];
    const job = msgs.find((m) => m.role === "user" && /job (\d+)/.test(textOf(m.content)));
    const i = Number(/job (\d+)/.exec(textOf(job?.content))?.[1] ?? 0);
    const last = msgs.filter((m) => m.role !== "system").at(-1);
    if (last?.role === "user" && last !== job) return fauxAssistantMessage("ack");
    const done = msgs.filter((m) => m.role === "toolResult").length;
    const calls: Array<[string, object]> = [
      ["collab_board", { action: "read", limit: 50 }],
      ["collab_claim", { action: "claim", resources: [`f${i % Math.max(1, Math.floor(N / 2))}.js`], note: "edit" }],
      ["collab_board", { action: "post", kind: "finding", title: `finding of a${i}`, body: "z".repeat(300) }],
      ["collab_send", { to: `a${(i + 1) % N}`, type: "message", text: `hello from a${i}`, mode: "followUp" }],
      ["collab_peers", {}],
      ["collab_claim", { action: "release" }],
    ];
    const next = calls[done];
    if (next) return fauxAssistantMessage([fauxToolCall(next[0], next[1])], { stopReason: "toolUse" });
    finishedSet.add(i);
    return fauxAssistantMessage(`done a${i}`);
  } finally { inflight--; }
};

const faux = fauxProvider();
const models = createModels();
models.setProvider(faux.provider);
faux.setResponses(Array.from({ length: N * 20 + 50 }, () => step));

const base = tempDir("pi-scale-");
const root = path.join(base, "collab");
const cwd = path.join(base, "repo");
fs.mkdirSync(cwd, { recursive: true });
let lagMax = 0; const lags: number[] = [];
let expect = performance.now() + 50;
const lagTimer = setInterval(() => { const now = performance.now(); const lag = now - expect; lags.push(lag); lagMax = Math.max(lagMax, lag); expect = now + 50; }, 50);
const rss0 = process.memoryUsage().rss;
const t0 = performance.now();
const service = await openService({ ...(process.env.CAP ? { maxWorkingAgents: Number(process.env.CAP) } : {}), models, storage: await jsonlStorage(path.join(base, "store")), collab: { sessionId: () => "s1", root: () => root } });
const names = Array.from({ length: N }, (_, i) => `a${i}`);
for (let g = 0; g < N; g += 12)
  await service.spawnGraph({ agents: names.slice(g, g + 12).map((name, k) => ({ name, job: `job ${g + k}`, cwd, model: MODEL })) });
const tSpawned = performance.now();
let rssPeak = 0;
const deadline = Date.now() + Number(process.env.DEADLINE_MS ?? 15 * 60_000);
for (;;) {
  rssPeak = Math.max(rssPeak, process.memoryUsage().rss);
  const infos = names.map((n) => service.get(n));
  const finished = finishedSet.size;
  if (finished === N || Date.now() > deadline) break;
  if (process.env.DEBUG && Math.random() < 0.05) console.error(calls, infos.map((x) => `${x?.name}:${x?.state}:${(x?.result?.text ?? '').slice(0, 40)}`).join(' | '));
  await sleep(100);
}
const wall = performance.now() - t0;
await sleep(LATENCY * 3); // let follow-up acks run
const infos = names.map((n) => service.get(n));
const store = path.join(root, "s1");
const dirs = fs.existsSync(root) ? fs.readdirSync(root, { recursive: true }).length : 0;
clearInterval(lagTimer);
const sorted = [...lags].sort((a, b) => a - b);
const tools = infos[0] as any;
console.log(JSON.stringify({
  N, latencyMs: LATENCY, wallS: +(wall / 1000).toFixed(1), spawnS: +((tSpawned - t0) / 1000).toFixed(1),
  done: finishedSet.size, acks: calls - 7 * N,
  states: Object.entries(infos.reduce((m: any, x) => ((m[x?.state ?? "?"] = (m[x?.state ?? "?"] ?? 0) + 1), m), {})).map(([k, v]) => `${k}:${v}`).join(","),
  modelCalls: calls, peakConcurrentModelCalls: peak,
  idealWallS: +((7 * LATENCY) / 1000).toFixed(1),
  rssMB0: Math.round(rss0 / 1e6), rssPeakMB: Math.round(rssPeak / 1e6),
  loopLagP95ms: +(sorted[Math.floor(sorted.length * 0.95)] ?? 0).toFixed(1), loopLagMaxMs: +lagMax.toFixed(1),
  firstRequestChars: firstCtx, toolsChars: firstTools, systemChars: firstSys,
  maxRequestChars: Math.max(...ctxBytes), collabFiles: dirs,
}));
await closeService(service);
process.exit(0);
