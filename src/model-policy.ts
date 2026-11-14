import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai/compat";

export const EFFORTS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ModelSelection = Readonly<{
  provider: string;
  id: string;
  effort: (typeof EFFORTS)[number];
}>;
export type ModelPolicy = Readonly<{
  models?: readonly ModelSelection[];
  model?: ModelSelection;
  prewalk?: ModelSelection;
  /** Ordered routing policy, never a permission grant. */
  fallback?: readonly ModelSelection[];
}>;
export function modelSelection(value: unknown): ModelSelection {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Unsupported model selection: expected exact provider, id and effort");
  const item = value as Record<string, unknown>;
  if (
    Object.keys(item).some((key) => !["provider", "id", "effort"].includes(key)) ||
    typeof item.provider !== "string" ||
    !item.provider.trim() ||
    typeof item.id !== "string" ||
    !item.id.trim() ||
    !EFFORTS.includes(item.effort as ModelSelection["effort"])
  )
    throw new Error("Unsupported model selection: expected exact provider, id and effort");
  return { provider: item.provider, id: item.id, effort: item.effort as ModelSelection["effort"] };
}
export function sameSelection(a: ModelSelection, b: ModelSelection): boolean {
  return a.provider === b.provider && a.id === b.id && a.effort === b.effort;
}
export function allowsModel(policy: ModelPolicy, selection: ModelSelection): boolean {
  return (
    policy.models === undefined || policy.models.some((item) => sameSelection(item, selection))
  );
}
export function narrowModelPolicy(
  base: ModelPolicy,
  value: Record<string, unknown>,
  operator: boolean,
): ModelPolicy {
  let models = base.models;
  if (value.models !== undefined) {
    if (!Array.isArray(value.models) || value.models.length > 64)
      throw new Error("models must be a bounded exact selection array");
    models = value.models.map(modelSelection);
    if (
      !operator &&
      models.some((item) => !base.models?.some((allowed) => sameSelection(item, allowed)))
    )
      throw new Error("Cannot mint model grants");
  }
  let fallback = base.fallback;
  if (value.fallback !== undefined) {
    if (value.fallback === false) fallback = undefined;
    else {
      if (!Array.isArray(value.fallback) || !value.fallback.length || value.fallback.length > 64)
        throw new Error("fallback must be false or a finite nonempty exact selection array");
      fallback = value.fallback.map(modelSelection);
      if (
        fallback.some((item, index) =>
          fallback!.slice(0, index).some((prior) => sameSelection(prior, item)),
        )
      )
        throw new Error("Duplicate fallback target");
      if (!operator) {
        let index = -1;
        for (const target of fallback) {
          const next =
            base.fallback?.findIndex(
              (item, position) => position > index && sameSelection(item, target),
            ) ?? -1;
          if (next < 0) throw new Error("Cannot add or reorder fallback targets");
          index = next;
        }
      }
    }
  }
  if (fallback?.some((item) => !models?.some((grant) => sameSelection(item, grant))))
    throw new Error("Every fallback target requires an exact operator model grant");
  const policy: ModelPolicy = {
    models,
    fallback,
    model: value.model === undefined ? base.model : modelSelection(value.model),
    prewalk: value.prewalk === undefined ? base.prewalk : modelSelection(value.prewalk),
  };
  if (policy.fallback && policy.prewalk) throw new Error("fallback and prewalk cannot be combined");
  for (const selection of [policy.model, policy.prewalk])
    if (selection && !models?.some((item) => sameSelection(item, selection)))
      throw new Error("Model and prewalk selections require an exact operator model grant");
  if (
    !operator &&
    policy.prewalk &&
    (!base.prewalk || !sameSelection(policy.prewalk, base.prewalk))
  )
    throw new Error("Cannot mint prewalk grants");
  return policy;
}
export function validateModelSelection(
  ctx: Pick<ExtensionToolContext, "modelRegistry" | "scopedModels">,
  selection: ModelSelection,
) {
  const registry = ctx.modelRegistry;
  const model = registry.find(selection.provider, selection.id);
  if (!model || model.api === "pi-virtual" || !registry.getProvider(model.provider))
    throw new Error("Unsupported or unknown physical model selection");
  if (
    !registry
      .getAvailable()
      .some((item) => item.provider === model.provider && item.id === model.id) ||
    !registry.hasConfiguredAuth(model)
  )
    throw new Error("Model selection unavailable or missing configured parent authentication");
  if (
    ctx.scopedModels.length &&
    !ctx.scopedModels.some(
      (item) =>
        item.model.provider === model.provider &&
        item.model.id === model.id &&
        (item.thinkingLevel === undefined || item.thinkingLevel === selection.effort),
    )
  )
    throw new Error("Model selection outside parent scoped models/effort");
  if (![model.contextWindow, model.maxTokens].every((limit) => Number.isFinite(limit) && limit > 0))
    throw new Error("Model selection requires known finite context and output limits");
  if (!getSupportedThinkingLevels(model).includes(selection.effort))
    throw new Error("Unsupported model effort; silent coercion is denied");
  return model;
}
