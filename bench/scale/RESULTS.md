# Scale benchmarks

Box: one Linux machine, Bun 1.4.2. "Before" is `integrated` (cf492e3) with
these benches; "after" is `scale-fixes`. Medians of the runs named.

## In-process store (bench-inproc.ts, 10 cycles per agent)

p95 ms per operation; `board.read(50)` is what `collab_board` read returns
(a full listing before, a digest after).

| N | ops/s before → after | board.read p95 | status (messages+tasks) p95 | claim p95 | peers p95 |
| --- | --- | --- | --- | --- | --- |
| 10 | 4449 → 10192 | 0.42 → 0.14 | 0.54 → 0.07 | 0.65 → 0.57 | 0.07 → 0.06 |
| 25 | 4122 → 11669 | 0.94 → 0.17 | 0.99 → 0.08 | 0.46 → 0.28 | 0.10 → 0.09 |
| 50 | 2401 → 10884 | 1.95 → 0.17 | 1.96 → 0.09 | 0.58 → 0.36 | 0.18 → 0.14 |
| 100 | 1574 → 9338 | 4.09 → 0.26 | 2.74 → 0.13 | 0.55 → 0.43 | 0.36 → 0.01 |

No resource was ever held twice in either.

## Growth (bench-growth.ts, median ms)

| Board entries / messages | board read | messages(50) | tasks |
| --- | --- | --- | --- |
| 1,000 | 3.9 → 0.4 | 0.4 → 0.0 | 1.8 → 0.0 |
| 5,000 | 21.6 → 1.2 | 1.8 → 0.0 | 3.2 → 0.0 |
| 20,000 | 105.2 → 3.6 | 7.0 → 0.0 | 10.3 → 0.0 |

| Claims held (100 members) | claim | claims() |
| --- | --- | --- |
| 100 | 0.6 → 0.3 | 0.3 → 0.1 |
| 500 | 1.8 → 0.6 | 1.4 → 0.2 |
| 2,000 | 6.5 → 2.1 | 4.8 → 0.8 |

Before, `tasks` folded only the newest 500 messages; after, it is the whole
log's table.

## N processes on one group (bench-procs.py, 20 cycles each)

Not the normal deployment (Pi runs every agent in one process), but the
worst case for the lock. Before: 4 runs; after: 3 runs, each alone on the box.

| N | p95 ms | max ms | lock timeouts | cycles/s | unique claims kept |
| --- | --- | --- | --- | --- | --- |
| 10 | 15 → 26 | 375 → 371 | 0 → 0 | 463 → 500 | all → all |
| 25 | 66 → 34 | 1500 → 972 | 0 → 0 | 301 → 465 | all → all |
| 50 | 421 → 83 | 4763 → 2202 | 0 → 0 | 202 → 439 | all → all |
| 100 | 2502 → 873 | 11113 → 6234 | 14 → 0 | 128 → 302 | 1985–1995 → 2000 of 2000 |

An `O_EXCL` marker file held with the hot claim saw no double holder in any
run, before or after. The timestamp check occasionally reports 2 holders
overlapping by under 12 µs in both versions: cross-CPU clock skew, since the
marker file never collided.

## Agents in one session (many-agents.ts, faux model, 300 ms latency)

| N | wall s | RSS MB | loop lag p95 / max ms |
| --- | --- | --- | --- |
| 10 | 2.6 → 2.6 | 139 → 138 | 3 / 6 → 2.5 / 9 |
| 25 | 3.1 → 3.0 | 162 → 163 | 2.5 / 9 → 3.2 / 9 |
| 50 | 3.3 → 3.6 | 182 → 193 | 12 / 29 → 7.7 / 31 |
| 100 | 5.4 → 5.4 | 239 → 241 | 54 / 123 → 67 / 148 |
| 100, `CAP=32` | 10.8 | 227 | 17.6 / 48 |

Six collab calls per agent are too few for the store to show here; the
harness dominates. With the default working cap of 32, 100 agents queue for
slots: at most 32 model requests at once.

## SQLite store, sub-teams, request pacing

The same benchmarks with the store on SQLite (the default since this
change), on the same box. Arrows read "files store → SQLite store";
`PI_AGENTS_COLLAB_STORE=files` gives the left-hand numbers.

### In-process (bench-inproc.ts, p95 ms)

| N | ops/s | board.read p95 | status p95 | claim p95 | peers p95 |
| --- | --- | --- | --- | --- | --- |
| 10 | 10192 → 17527 | 0.14 → 0.18 | 0.07 → 0.10 | 0.57 → 0.09 | 0.06 → 0.01 |
| 25 | 11669 → 16642 | 0.17 → 0.20 | 0.08 → 0.09 | 0.28 → 0.07 | 0.09 → 0.00 |
| 50 | 10884 → 14898 | 0.17 → 0.20 | 0.09 → 0.08 | 0.36 → 0.13 | 0.14 → 0.00 |
| 100 | 9338 → 12010 | 0.26 → 0.23 | 0.13 → 0.08 | 0.43 → 0.17 | 0.01 → 0.00 |

The store keeps one connection per group per process, caches the member
list and the task table until another connection commits (`PRAGMA
data_version`), and keeps board counts in a trigger-maintained table, so a
read is an indexed query or a cache hit.

### Growth (bench-growth.ts, median ms)

| Board entries / messages | board read | messages(50) | tasks |
| --- | --- | --- | --- |
| 1,000 | 0.4 → 0.1 | 0.0 → 0.1 | 0.0 → 0.0 |
| 5,000 | 1.2 → 0.1 | 0.0 → 0.1 | 0.0 → 0.0 |
| 20,000 | 3.6 → 0.2 | 0.0 → 0.1 | 0.0 → 0.0 |

| Claims held (100 members) | claim | claims() |
| --- | --- | --- |
| 100 | 0.3 → 0.2 | 0.1 → 0.1 |
| 500 | 0.6 → 0.5 | 0.2 → 0.4 |
| 2,000 | 2.1 → 2.1 | 0.8 → 1.3 |

The database for 20,000 entries and 20,000 messages is about 31 MB;
retention (`collabRetention`) keeps a long run from growing without bound.

### N processes on one group (bench-procs.py, 20 cycles each)

Files store: 3 runs; SQLite: 2 runs.

| N | p95 ms | max ms | lock timeouts | cycles/s | unique claims kept |
| --- | --- | --- | --- | --- | --- |
| 10 | 6–48 → 5–15 | 366–609 → 234–435 | 0 → 0 | 262–511 → 440–790 | all → all |
| 25 | 34–274 → 5–22 | 1019–2127 → 1660–1736 | 0 → 0 | 160–471 → 279–295 | all → all |
| 50 | 64–915 → 35–39 | 2142–4808 → 3640–3741 | 0 → 0 | 205–450 → 263–270 | all → all |
| 100 | 964–1320 → 93–132 | 7477–12407 → 7761–8549 | 0–15 → 0 | 158–247 → 231–254 | 1985–2000 → 2000 of 2000 |

The SQLite tail is steady across runs where the files store's swung by an
order of magnitude. The max is almost always each process's first
operation: all N processes start in the same millisecond and SQLite's busy
handler is not fair, so the last of 100 simultaneous first writers waits
seconds. After that burst, p95 holds. No resource was held twice
(`O_EXCL` marker), and no write was lost.

### Agents in one session (many-agents.ts, faux model, 300 ms latency)

| N | wall s | RSS MB | loop lag p95 / max ms | collab files |
| --- | --- | --- | --- | --- |
| 10 | 2.6 → 2.6 | 138 → 139 | 2.5 / 9 → 2.9 / 5 | 38 → 5 |
| 25 | 3.0 → 3.1 | 163 → 173 | 3.2 / 9 → 3.6 / 10 | 83 → 5 |
| 50 | 3.6 → 3.5 | 193 → 195 | 7.7 / 31 → 11 / 30 | 158 → 5 |
| 100 | 5.4 → 5.4–6.3 | 241 → 237–243 | 67 / 148 → 15–97 / 131–234 | 308 → 5 |
| 100, `CAP=32` | 10.8 → 11.0 | 227 → 231 | 17.6 / 48 → 13 / 47 | 308 → 5 |

Loop lag at N=100 without a cap swings between runs (3 runs: 97, 15, 59 ms
p95); it is the harness's 100 simultaneous faux streams. The first request
is 769 characters larger: the team lines in the collab section and the new
tool parameters (`collab_peers` paging and filters).
