import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai/compat";
import { sameSelection, validateModelSelection, type ModelSelection } from "./model-policy.ts";

export type ProfileModelEntry = Readonly<{
  provider: string;
  id: string;
  name: string;
  providerLabel: string;
  efforts: readonly Readonly<{ effort: ModelSelection["effort"]; reason?: string }>[];
}>;
export type ProfileModelCatalog = Readonly<{
  entries: readonly ProfileModelEntry[];
  error?: string;
}>;
export type ProfileModelSource = () => ProfileModelCatalog;
export type ProfileModelPickOptions = {
  title: string;
  context: readonly string[];
  /** Undefined allows any accessible selection; [] permits none. Never creates grants. */
  allowed?: readonly ModelSelection[];
  excluded?: readonly ModelSelection[];
};

/** Snapshot only synchronous host metadata. Never refresh caches, resolve credentials or call providers. */
export function readProfileModelCatalog(
  ctx: Pick<ExtensionCommandContext, "modelRegistry" | "scopedModels">,
): ProfileModelCatalog {
  try {
    const registry = ctx.modelRegistry;
    if (registry.getError()) return { entries: [], error: "Host model metadata is unavailable." };
    const seen = new Set<string>();
    const entries: ProfileModelEntry[] = [];
    for (const model of registry.getAvailable()) {
      const key = JSON.stringify([model.provider, model.id]);
      if (
        seen.has(key) ||
        model.api === "pi-virtual" ||
        !registry.getProvider(model.provider) ||
        !registry.hasConfiguredAuth(model)
      )
        continue;
      seen.add(key);
      entries.push({
        provider: model.provider,
        id: model.id,
        name: model.name || model.id,
        providerLabel: registry.getProviderDisplayName(model.provider) || model.provider,
        efforts: getSupportedThinkingLevels(model).map((effort) => {
          try {
            validateModelSelection(ctx, { provider: model.provider, id: model.id, effort });
            return { effort };
          } catch {
            // Do not expose host exceptions or provider configuration in the presentation.
            const scoped =
              ctx.scopedModels.length &&
              !ctx.scopedModels.some(
                (item) =>
                  item.model.provider === model.provider &&
                  item.model.id === model.id &&
                  (item.thinkingLevel === undefined || item.thinkingLevel === effort),
              );
            return {
              effort,
              reason: scoped
                ? "Outside current session model/effort scope"
                : "Unavailable physical model metadata or configured access",
            };
          }
        }),
      });
    }
    return { entries };
  } catch {
    return {
      entries: [],
      error: "Host model metadata could not be read. Saved selections are retained.",
    };
  }
}

export function filterProfileModels(
  catalog: ProfileModelCatalog,
  query: string,
  provider = "",
): readonly ProfileModelEntry[] {
  const needle = query.toLocaleLowerCase();
  return catalog.entries.filter(
    (entry) =>
      (!provider || entry.provider === provider) &&
      `${entry.name} ${entry.providerLabel} ${entry.provider} ${entry.id}`
        .toLocaleLowerCase()
        .includes(needle),
  );
}

/** Undefined means eligible metadata, not profile authorization or a dispatch guarantee. */
export function profileModelReason(
  catalog: ProfileModelCatalog,
  selection: ModelSelection,
): string | undefined {
  if (catalog.error) return catalog.error;
  const entry = catalog.entries.find(
    (item) => item.provider === selection.provider && item.id === selection.id,
  );
  if (!entry) return "Unavailable in accessible catalog; saved selection retained";
  const effort = entry.efforts.find((item) => item.effort === selection.effort);
  return effort ? effort.reason : "Unsupported effort; saved selection retained";
}

export function profileModelLabel(catalog: ProfileModelCatalog, selection: ModelSelection): string {
  const entry = catalog.entries.find(
    (item) => item.provider === selection.provider && item.id === selection.id,
  );
  const reason = profileModelReason(catalog, selection);
  return `${entry ? `${entry.name} · ${entry.providerLabel}` : `${selection.id} · ${selection.provider}`} · ${selection.effort}${reason ? ` · Warning: ${reason}` : ""}`;
}

export function profileModelPickReason(
  catalog: ProfileModelCatalog,
  selection: ModelSelection,
  options: ProfileModelPickOptions,
): string | undefined {
  return (
    profileModelReason(catalog, selection) ??
    (options.allowed !== undefined &&
    !options.allowed.some((item) => sameSelection(item, selection))
      ? "Not authorized by exact grants; edit grants in Global first"
      : undefined) ??
    (options.excluded?.some((item) => sameSelection(item, selection))
      ? "Exact selection already present"
      : undefined)
  );
}
