---
title: Gate agent tool calls from extensions
type: feature
authors:
  - 0NotApplicable0
created: 2026-11-03T12:00:00.000000Z
---

Co-loaded extensions can register `beforeAgentTool` to allow or block every tool call of every agent, including nested `codemode` calls, before it runs. Failures, malformed answers, and cancellation block the call. Discovery advertises a `beforeAgentTool` capability and acknowledges registrations, so an extension can refuse to run on hosts that cannot enforce it.
