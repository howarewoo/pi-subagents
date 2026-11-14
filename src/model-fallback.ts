import { isRetryableAssistantError, type AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import {
  allowsModel,
  sameSelection,
  validateModelSelection,
  type ModelSelection,
} from "./model-policy.ts";
import type { ChildSnapshot, StartTask } from "./delegation-types.ts";

export const FALLBACK_RETRIES = 2;

export type FallbackState = NonNullable<ChildSnapshot["fallback"]>;
type Context = Pick<ExtensionToolContext, "modelRegistry" | "scopedModels">;

/** Task input may remove destinations, never supply or reorder them. */
export function taskFallback(
  input: Pick<StartTask, "profile" | "model" | "fallback">,
): readonly ModelSelection[] | undefined {
  const configured = input.profile.fallback;
  if (
    configured &&
    (!configured.length ||
      configured.length > 64 ||
      configured.some((target, index) =>
        configured.slice(0, index).some((prior) => sameSelection(prior, target)),
      ))
  )
    throw new Error("fallback requires a finite nonempty chain without duplicate targets");
  if (input.fallback === true && !configured)
    throw new Error("fallback requires an operator profile chain");
  if (!configured || input.fallback === false || (input.model && input.fallback !== true)) return;
  if (input.profile.prewalk) throw new Error("fallback and prewalk cannot be combined");
  let chain = configured;
  if (input.model) {
    const start = chain.findIndex((target) => sameSelection(target, input.model!));
    if (start < 0) throw new Error("Explicit fallback model must belong to the profile chain");
    chain = chain.slice(start);
  }
  chain = chain.filter((target) => allowsModel(input.profile, target));
  if (!chain.length || (input.model && !sameSelection(chain[0], input.model)))
    throw new Error("No authorized fallback targets remain");
  return chain;
}

/** Availability is not authorization: scopes and virtual targets always fail closed. */
export function authorizeFallback(ctx: Context, chain: readonly ModelSelection[]): void {
  for (const target of chain) {
    if (
      ctx.scopedModels.length &&
      !ctx.scopedModels.some(
        (entry) =>
          entry.model.provider === target.provider &&
          entry.model.id === target.id &&
          (entry.thinkingLevel === undefined || entry.thinkingLevel === target.effort),
      )
    )
      throw new Error("Fallback target outside parent scoped models/effort");
    if (ctx.modelRegistry.find(target.provider, target.id)?.api === "pi-virtual")
      throw new Error("Fallback targets must be physical models");
  }
}

export function availableFallback(
  ctx: Context,
  state: FallbackState,
  start: number,
): FallbackState {
  authorizeFallback(ctx, state.chain);
  const skipped = [...state.skipped];
  for (let index = start; index < state.chain.length; index++) {
    const target = state.chain[index];
    const model = ctx.modelRegistry.find(target.provider, target.id);
    let reason: string | undefined;
    if (!model || !ctx.modelRegistry.getProvider(target.provider))
      reason = "missing catalog model/provider";
    else if (
      !ctx.modelRegistry.hasConfiguredAuth(model) ||
      !ctx.modelRegistry
        .getAvailable()
        .some((item) => item.provider === target.provider && item.id === target.id)
    )
      reason = "unavailable or missing configured authentication";
    if (reason) {
      skipped.push({ target, reason });
      continue;
    }
    validateModelSelection(ctx, target);
    return {
      ...state,
      index,
      failures: index === state.index ? state.failures : 0,
      exhausted: false,
      skipped,
    };
  }
  return { ...state, index: state.chain.length, failures: 0, exhausted: true, skipped };
}

export function initialFallback(ctx: Context, chain: readonly ModelSelection[]): FallbackState {
  const state = availableFallback(
    ctx,
    { chain, index: 0, failures: 0, exhausted: false, skipped: [], attempts: [] },
    0,
  );
  if (state.exhausted) throw new Error("No available authorized fallback targets");
  return state;
}

function exhaustedFallbackBudget(error: string): boolean {
  return /insufficient[_ ](?:quota|credits?)|quota.*(?:exceed|exhaust)|out of (?:budget|credits)|credits?.*(?:exhaust|deplet)|(?:exhaust|deplet).*credits?|credit balance.*too low|spend.?limit.*(?:reach|exceed|exhaust)|(?:reach|exceed|exhaust).*spend.?limit|billing.*(?:limit|exhaust|quota)|usage.?limit|available balance|GoUsageLimitError|FreeUsageLimitError/i.test(
    error,
  );
}

/** Billing exhaustion may be an invalid request, but never overrides authorization failures. */
export function terminalFallbackError(error: string): boolean {
  return (
    /\b(?:401|403)\b|api.?key|credential|not configured|authenticat|unauthorized|permission|refusal|cancel/i.test(
      error,
    ) ||
    (/\b400\b|invalid.request/i.test(error) && !exhaustedFallbackBudget(error))
  );
}

export function recoverableFallback(message: AssistantMessage): boolean {
  if (message.stopReason !== "error" || terminalFallbackError(message.errorMessage ?? ""))
    return false;
  return exhaustedFallbackBudget(message.errorMessage ?? "") || isRetryableAssistantError(message);
}
