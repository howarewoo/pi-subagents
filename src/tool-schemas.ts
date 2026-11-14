import { Type } from "typebox";
import { EFFORTS } from "./model-policy.ts";
import { COORDINATION_ACTIONS } from "./profiles.ts";

const role = Type.Union([
  Type.Literal("general"),
  Type.Literal("scout"),
  Type.Literal("review"),
  Type.Literal("implementation"),
]);
const limits = Type.Object(
  {
    depth: Type.Optional(Type.Integer({ minimum: 0 })),
    spawns: Type.Optional(Type.Integer({ minimum: 0 })),
    deadlineMs: Type.Optional(Type.Integer({ minimum: 1 })),
    requests: Type.Optional(Type.Integer({ minimum: 1 })),
    tools: Type.Optional(Type.Integer({ minimum: 1 })),
  },
  { additionalProperties: false },
);
const modelSelection = Type.Object(
  {
    provider: Type.String({ minLength: 1 }),
    id: Type.String({ minLength: 1 }),
    effort: Type.Enum(EFFORTS),
  },
  { additionalProperties: false },
);
const assignment = {
  cwd: Type.Optional(
    Type.String({
      minLength: 1,
      description:
        "Existing workspace; absolute or relative to root parent cwd. No new permissions or sandbox.",
    }),
  ),
  models: Type.Optional(Type.Array(modelSelection, { maxItems: 64 })),
  model: Type.Optional(modelSelection),
  fallback: Type.Optional(
    Type.Boolean({
      description:
        "Enable the operator profile chain; explicit model overrides remain pinned unless true. false disables chaining.",
    }),
  ),
  assignment: Type.Optional(Type.String({ minLength: 1 })),
  taskFile: Type.Optional(Type.String({ minLength: 1 })),
  resultSchema: Type.Optional(Type.Unknown()),
  profile: role,
  spawn: Type.Optional(Type.Array(role)),
  coordination: Type.Optional(
    Type.Array(Type.Union(COORDINATION_ACTIONS.map((action) => Type.Literal(action)))),
  ),
  limits: Type.Optional(limits),
};
const item = Type.Object(assignment, { additionalProperties: false });
export const parameters = Type.Union([
  Type.Object(
    { ...assignment, background: Type.Optional(Type.Boolean()) },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      tasks: Type.Array(item, { minItems: 1, maxItems: 64 }),
      background: Type.Optional(Type.Boolean()),
    },
    { additionalProperties: false },
  ),
]);

const identity = Type.Object(
  { id: Type.String({ minLength: 1 }), generation: Type.Integer({ minimum: 1 }) },
  { additionalProperties: false },
);
export const coordinationParameters = Type.Union([
  Type.Object(
    {
      action: Type.Literal("message"),
      target: Type.Optional(identity),
      text: Type.String({ minLength: 1, maxLength: 4096 }),
      mode: Type.Optional(
        Type.Union([Type.Literal("inbox"), Type.Literal("steer"), Type.Literal("followUp")]),
      ),
    },
    { additionalProperties: false },
  ),
  Type.Object({ action: Type.Literal("inbox") }, { additionalProperties: false }),
  Type.Object(
    {
      action: Type.Literal("wait"),
      target: Type.Optional(identity),
      messageId: Type.Optional(Type.String({ minLength: 1 })),
      timeoutMs: Type.Integer({ minimum: 1, maximum: 60000 }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      action: Type.Union([Type.Literal("park"), Type.Literal("stop"), Type.Literal("status")]),
      target: identity,
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      action: Type.Union([Type.Literal("followup"), Type.Literal("revive")]),
      target: identity,
      assignment: Type.String({ minLength: 1 }),
      resultSchema: Type.Optional(Type.Unknown()),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      action: Type.Literal("resume"),
      target: identity,
      assignment: Type.String({ minLength: 1 }),
    },
    { additionalProperties: false },
  ),
]);

const worker = Type.Union([role, Type.Literal("worker")]);
const compatibleItem = Type.Object(
  {
    agent: worker,
    task: Type.String({ minLength: 1 }),
    cwd: Type.Optional(
      Type.String({
        minLength: 1,
        description:
          "Existing workspace; absolute or relative to root parent cwd. Omit to inherit the call default.",
      }),
    ),
    model: Type.Optional(Type.Union([modelSelection, Type.String({ minLength: 1 })])),
    limits: Type.Optional(limits),
  },
  { additionalProperties: false },
);
export const compatibleParameters = Type.Union([
  Type.Object(
    { ...compatibleItem.properties, async: Type.Optional(Type.Boolean()) },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      tasks: Type.Array(compatibleItem, { minItems: 1, maxItems: 64 }),
      async: Type.Optional(Type.Boolean()),
      cwd: Type.Optional(Type.String({ minLength: 1 })),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    { action: Type.Union([Type.Literal("list"), Type.Literal("agents")]) },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      action: Type.Union([Type.Literal("status"), Type.Literal("stop")]),
      id: Type.String({ minLength: 1 }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      action: Type.Union([Type.Literal("steer"), Type.Literal("resume")]),
      id: Type.String({ minLength: 1 }),
      message: Type.String({ minLength: 1 }),
    },
    { additionalProperties: false },
  ),
]);
