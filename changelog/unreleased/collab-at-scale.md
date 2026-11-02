---
title: Larger teams, and a collab store that stays fast as it grows
type: feature
created: 2026-11-02T03:07:31.000000Z
---

Spawning limits are settings now: `piAgents.maxAgentsPerSpawn` (12), `maxSpawnedPerAgent` (24), `maxActiveSpawned` (16), `maxDepth` (3), and `maxSolvers` (6) raise them, so Pi or a lead agent can run a team of 100. `piAgents.maxWorkingAgents` caps agents that work at once at 32 by default; `0` turns the cap off. A plain `collab_board` read returns a digest (counts, unfinished entries, the last finished ones), and entries marked done or dropped leave it; `kind`, `status`, or `all: true` lists entries. Board reads, the task table, and claim checks use indexes and caches instead of reading every file, and the task table keeps every task, however old. Taking over a dead process's collab lock no longer can remove a lock another process just took.
