/** Tool parameters of the collab and competition tools. */

import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { BOARD_KINDS, BOARD_STATUSES, MESSAGE_TYPES } from "./store.js";

export const COLLAB_BOARD_TOOL = "collab_board";
export const COLLAB_CLAIM_TOOL = "collab_claim";
export const COLLAB_SEND_TOOL = "collab_send";
export const COLLAB_PEERS_TOOL = "collab_peers";
export const COMPETE_SUBMIT_TOOL = "compete_submit";
export const COMPETE_COMPARE_TOOL = "compete_compare";
export const COMPETE_VERDICT_TOOL = "compete_verdict";

/** A spawned agent's collab group. Every agent is in one. */
export const groupParameter = Type.Optional(
  Type.String({
    description:
      'Collab group within this session: "main" for your agents, or the spawner\'s group for agents an agent spawns. Agents of one group share a blackboard and claims and message each other with collab_send; name another group to keep a team apart',
  }),
);

/** A spawned agent's role in its collab group. */
export const roleParameter = Type.Optional(
  Type.String({
    description:
      "Role in the collab group, such as implementer or reviewer; others address it as role:<role>. Defaults to the profile or name",
  }),
);

/** A spawned agent's sub-team in its collab group. */
export const teamParameter = Type.Optional(
  Type.String({
    description:
      'Sub-team within the collab group, of about 12 agents: its members see each other first in collab_peers and reach each other with collab_send to "team". Defaults to the agents of one spawn (split into teams of piAgents.teamSize), or to its spawner\'s team when the spawner leads one',
  }),
);

/** Whether a spawned agent leads its sub-team. */
export const leadParameter = Type.Optional(
  Type.Boolean({
    description:
      "This agent leads its sub-team: it coordinates the team, and agents it spawns join the team. Default false",
  }),
);

export const collabSendParameters = Type.Object({
  to: Type.String({
    description:
      'Recipient: an agent name or ID within your reach, "role:<role>" for the one group member with that role, or a broadcast of a plain message: "team" (your sub-team), "team:<name>", or "group" (everyone; small groups only)',
  }),
  type: Type.Optional(
    StringEnum(MESSAGE_TYPES, {
      description:
        '"message" (default); "task_req" asks for work and "handoff" hands yours over, both answered with task_ack, task_clarify, task_done, or task_blocked; "review_req" asks for a review, answered with review_done',
    }),
  ),
  text: Type.String({ description: "The message, task, or result" }),
  task: Type.Optional(
    Type.String({
      description:
        "Task ID: required for answers (task_ack, task_clarify, task_done, task_blocked, review_done); task_req, handoff, and review_req without one get a new ID",
    }),
  ),
  refs: Type.Optional(
    Type.Array(Type.String(), {
      description:
        'References such as "board:<id>", "path:src/x.ts", or "task:<id>"',
    }),
  ),
  mode: Type.Optional(
    StringEnum(["followUp", "steer"] as const, {
      description:
        'How a working recipient gets it: "followUp" (default) after its current work, "steer" at its next step',
    }),
  ),
});

export const submitParameters = Type.Object({
  summary: Type.String({ description: "What your solution does, in a line" }),
  approach: Type.String({
    description: "How you solved it and why, in a few sentences",
  }),
  tests: Type.String({
    description: "The tests you ran or wrote, and their results",
  }),
  confidence: Type.Number({
    minimum: 0,
    maximum: 1,
    description: "How sure you are that the solution is correct, 0 to 1",
  }),
  caveats: Type.Optional(
    Type.String({ description: "Known gaps, risks, or assumptions" }),
  ),
});

export const verdictParameters = Type.Object({
  winner: Type.String({ description: "The best solver's name" }),
  ranking: Type.Array(Type.String(), {
    description: "Every solver, best first",
  }),
  rationale: Type.String({ description: "Why, in a few sentences" }),
  merge: Type.Optional(
    Type.String({
      description:
        "When parts of other solutions should be combined with the winner's: what to take from which solver",
    }),
  ),
});

export const boardParameters = Type.Object({
  action: StringEnum(["read", "post", "update"] as const, {
    description:
      '"read" without filters gives a digest: counts, unfinished entries, and the last finished ones; with id, one entry in full; with kind, status, or all, a listing. "post" adds an entry, "update" changes its status (done or dropped finishes it) or adds a note',
  }),
  kind: Type.Optional(
    StringEnum(BOARD_KINDS, { description: "Entry kind; a filter for read" }),
  ),
  title: Type.Optional(Type.String({ description: "Title of a new post" })),
  body: Type.Optional(Type.String({ description: "Body of a new post" })),
  refs: Type.Optional(
    Type.Array(Type.String(), {
      description: 'References such as "path:src/x.ts" or "board:<id>"',
    }),
  ),
  id: Type.Optional(
    Type.String({ description: "Entry ID for read or update" }),
  ),
  status: Type.Optional(
    StringEnum(BOARD_STATUSES, {
      description: "New status for update; a filter for read",
    }),
  ),
  note: Type.Optional(Type.String({ description: "Note to add with update" })),
  limit: Type.Optional(Type.Number({ minimum: 1, maximum: 200 })),
  all: Type.Optional(
    Type.Boolean({
      description: "For read: list finished (done, dropped) entries too",
    }),
  ),
});

export const claimParameters = Type.Object({
  action: StringEnum(["claim", "release", "list"] as const, {
    description:
      '"claim" takes resources all-or-nothing, "release" gives yours back (all of them without resources), "list" shows every claim',
  }),
  resources: Type.Optional(
    Type.Array(Type.String(), {
      description:
        'Absolute paths or paths relative to your working directory (including ..; a directory claims its descendants), "item:<board id>", or "key:<anything>". Paths identify canonical real files across working directories; separate worktrees are independent',
    }),
  ),
  note: Type.Optional(Type.String({ description: "What you're doing" })),
  ttlMinutes: Type.Optional(
    Type.Number({
      minimum: 1,
      description: "Expire the claim after this many minutes",
    }),
  ),
});
