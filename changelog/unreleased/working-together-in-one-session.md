---
title: Agents work as a team, or compete on one task
type: feature
created: 2026-11-02T01:56:02.000000Z
---

Every agent is now a member of its session's collab group (`main`, or the group its spawn names with `group`; helpers join their spawner's). Members share a blackboard (`collab_board`), claim files before they change them (`collab_claim`), list each other (`collab_peers`), and exchange task, handoff, and review requests (`collab_send`, addressing others by name or `role:<role>`); their prompt tells them to use the board and claims when others work alongside them. `/collab` and `collab_status` show a group. `agent_compete` and `/compete <task>` run 2–6 solvers on the same task, each in its own Git worktree or copy and blind to the others, with a different default strategy each; a verify command checks every solution, a judge ranks them, `/compete merge` has an agent combine the best into a new candidate, and a solution reaches your workspace only when you apply it.
