import { truncateToWidth } from "@earendil-works/pi-tui";
import { bundledProfiles, type Profile, type ProfileCatalog } from "./profiles.ts";
import { safe } from "./thread.ts";

export type ProfileSetting =
  | "description"
  | "prompt"
  | "route"
  | "tools"
  | "skills"
  | "delegation"
  | "leafTools"
  | "advanced";
export const profileSettingLabels: Record<ProfileSetting, string> = {
  description: "Description",
  prompt: "Instructions",
  route: "Models",
  tools: "Tools",
  skills: "Skills",
  delegation: "Delegation",
  leafTools: "Reviewed tools",
  advanced: "Advanced",
};
export const profileSettingHelp: Record<ProfileSetting, string> = {
  description: "Description: a short explanation of this profile.",
  prompt: "Instructions (prompt): complete child instructions, not parent conversation/history.",
  route:
    "Models: first entry is the default, followed by ordered fallbacks. Exact grants remain separate.",
  tools:
    "Tools: maximum allowlist, not a count of callable tools. Explicit empty denies; reset inherits.",
  skills: "Skills: exact path grants. Explicit empty denies; inherited values remain inspectable.",
  delegation:
    "Delegation: spawn targets and coordination actions are separate permission ceilings.",
  leafTools:
    "Reviewed tools (leafTools): trusted reviewed code, not a sandbox or forwarding grant.",
  advanced:
    "Advanced: routing policy, exact model grants, authority, profile actions and source diagnostics.",
};
export function profileOverview(profile: Profile, route?: string) {
  const preview = (text: string) => truncateToWidth(safe(text).replaceAll(/\s+/g, " "), 58);
  return [
    { heading: "Profile", settings: ["description", "prompt"] },
    { heading: "Model", settings: ["route"] },
    {
      heading: "Access",
      settings: [
        "tools",
        "skills",
        "delegation",
        ...(profile.name === "general" ? ["leafTools"] : []),
      ],
    },
    { heading: "Advanced", settings: ["advanced"] },
  ].flatMap(({ heading, settings }) => [
    { heading, key: undefined, value: "" },
    ...settings.map((item) => {
      const key = item as ProfileSetting;
      const selectionLabel = (target: NonNullable<Profile["model"]>) =>
        `${truncateToWidth(safe(`${target.provider}/${target.id}`), 48)} · ${target.effort}`;
      const routeSummary = profile.fallback?.length
        ? `Default · ${route ?? selectionLabel(profile.fallback[0])} · ${profile.fallback.length - 1} fallback${profile.fallback.length === 2 ? "" : "s"}`
        : profile.prewalk
          ? `Prewalk · ${selectionLabel(profile.prewalk)}`
          : profile.model
            ? selectionLabel(profile.model)
            : "Selected parent model";
      const value =
        key === "description"
          ? preview(profile.description)
          : key === "prompt"
            ? preview(profile.prompt) || "Empty instructions"
            : key === "route"
              ? routeSummary
              : key === "delegation"
                ? `${profile.spawn?.length ?? 0} targets · ${profile.coordination?.length ?? 0} coordination actions`
                : key === "advanced"
                  ? "Routing policy, authority, profile actions ›"
                  : `${profile[key]?.length ?? 0} ${key === "skills" ? "paths" : "allowed"} · ceiling`;
      return { heading: undefined, key, value };
    }),
  ]);
}

/** Exact selected-layer declaration, separate from the resolved workspace profile. */
export function profileRawRole(
  catalog: Pick<ProfileCatalog, "global" | "project">,
  destination: "global" | "project",
  name: string,
): Record<string, unknown> {
  const layer = catalog[destination];
  return ((bundledProfiles().some((p) => p.name === name)
    ? layer[name]
    : (layer.customProfiles as Record<string, unknown> | undefined)?.[name]) ?? {}) as Record<
    string,
    unknown
  >;
}
export const profileSettingFields = (key: ProfileSetting): string[] =>
  key === "route"
    ? ["fallback", "model", "prewalk", "models"]
    : key === "delegation"
      ? ["spawn", "coordination"]
      : [key];
