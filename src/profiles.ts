import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import {
  CONFIG_DIR_NAME,
  getAgentDir,
  loadSkills,
  type Skill,
} from "@earendil-works/pi-coding-agent";

import { narrowModelPolicy, allowsModel, sameSelection, type ModelPolicy } from "./model-policy.ts";

export const READ_TOOLS = ["read", "grep", "find", "ls"] as const;
export const WRITE_TOOLS = [...READ_TOOLS, "write", "edit", "bash"] as const;
export type BuiltinTool = (typeof WRITE_TOOLS)[number];
export const COORDINATION_ACTIONS = ["message", "inbox", "wait"] as const;
export type CoordinationAction = (typeof COORDINATION_ACTIONS)[number];
/** Tool arrays are ceilings; admission intersects callable parent builtins before ancestry checks. */
export type Profile = Readonly<
  ModelPolicy & {
    name: string;
    description: string;
    prompt: string;
    tools: readonly BuiltinTool[];
    skills: readonly string[];
    /** Operator-reviewed leaf tools; never a tool-to-tool forwarding grant. */
    leafTools?: readonly string[];
    spawn?: readonly string[];
    coordination?: readonly CoordinationAction[];
  }
>;
const bundled: Record<string, Profile> = {
  general: {
    name: "general",
    description: "General delegation with restricted parent capabilities",
    prompt: "Complete the assigned analysis and report the evidence and limitations.",
    tools: WRITE_TOOLS,
    skills: [],
    spawn: ["scout", "review"],
  },
  scout: {
    name: "scout",
    description: "Explore and locate evidence",
    prompt:
      "Explore the assignment using read-only tools. Report precise source locations and findings.",
    tools: READ_TOOLS,
    skills: [],
    spawn: ["scout", "review"],
  },
  review: {
    name: "review",
    description: "Review without modifying files",
    prompt:
      "Review the assigned work. Report actionable findings with source locations; do not edit files.",
    tools: READ_TOOLS,
    skills: [],
    spawn: ["scout", "review"],
  },
  implementation: {
    name: "implementation",
    description:
      "Implement changes in the supplied workspace (shared writes; caller coordinates collisions)",
    prompt:
      "Implement the assigned bounded change, verify it and report changed files and remaining risks. Work in your supplied cwd; root permissions still apply. Other children and parent tools may write concurrently; coordinate shared operations.",
    tools: WRITE_TOOLS,
    skills: [],
    spawn: ["scout", "review"],
  },
};

async function config(path: string): Promise<Record<string, unknown>> {
  try {
    const value: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("expected object");
    return value as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new Error(`Invalid delegation config ${path}: ${String(error)}`);
  }
}
function strings(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string"))
    throw new Error(`${field} must be a string array`);
  return value;
}
function specialize(base: Profile, value: unknown, operator: boolean): Profile {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`Invalid profile ${base.name}`);
  const input = value as Record<string, unknown>;
  for (const key of Object.keys(input))
    if (
      ![
        "description",
        "prompt",
        "tools",
        "skills",
        "leafTools",
        "spawn",
        "coordination",
        "models",
        "model",
        "prewalk",
        "fallback",
      ].includes(key)
    )
      throw new Error(`Unsupported profile field: ${key}`);
  const tools = input.tools === undefined ? [...base.tools] : strings(input.tools, "tools");
  if (tools.some((tool) => !base.tools.includes(tool as BuiltinTool)))
    throw new Error(`Profile ${base.name} cannot broaden tool grants`);
  const skills = input.skills === undefined ? [...base.skills] : strings(input.skills, "skills");
  if (skills.some((path) => !isAbsolute(path) || (!operator && !base.skills.includes(path))))
    throw new Error(
      `Profile ${base.name} cannot mint skill grants; operator paths must be absolute`,
    );
  const leafTools =
    input.leafTools === undefined
      ? [...(base.leafTools ?? [])]
      : strings(input.leafTools, "leafTools");
  if (
    leafTools.some(
      (name) => !name || base.name !== "general" || (!operator && !base.leafTools?.includes(name)),
    )
  )
    throw new Error("Cannot mint leaf tool grants");
  for (const field of ["description", "prompt"] as const)
    if (input[field] !== undefined && typeof input[field] !== "string")
      throw new Error(`${field} must be text`);
  const spawn = input.spawn === undefined ? [...(base.spawn ?? [])] : strings(input.spawn, "spawn");
  if (
    spawn.some(
      (name) => !Object.hasOwn(bundled, name) || (!operator && !base.spawn?.includes(name)),
    )
  )
    throw new Error("Cannot mint spawn grants");
  const coordination =
    input.coordination === undefined
      ? [...(base.coordination ?? [])]
      : strings(input.coordination, "coordination");
  if (
    coordination.some(
      (action) =>
        !COORDINATION_ACTIONS.includes(action as CoordinationAction) ||
        (!operator && !base.coordination?.includes(action as CoordinationAction)),
    )
  )
    throw new Error("Cannot mint coordination grants");
  return {
    ...base,
    ...narrowModelPolicy(base, input, operator),
    coordination: coordination as CoordinationAction[],
    spawn,
    description: (input.description as string) ?? base.description,
    prompt: (input.prompt as string) ?? base.prompt,
    tools: tools as BuiltinTool[],
    skills,
    leafTools,
  };
}

/** Operator config can grant exact skill paths; trusted project config can only narrow those grants. */
export async function resolveProfile(
  name: string,
  cwd: string,
  trusted: boolean,
  operatorDir = getAgentDir(),
  availableSkills: readonly Skill[] = [],
): Promise<{ profile: Profile; skills: Skill[] }> {
  let profile = bundled[name];
  if (!Object.hasOwn(bundled, name)) throw new Error(`Unknown delegation profile: ${name}`);
  if (name === "general")
    profile = { ...profile, skills: availableSkills.map((skill) => skill.filePath) };
  const user = await config(join(operatorDir, "delegation.json"));
  for (const key of Object.keys(user))
    if (key !== "scheduling" && !Object.hasOwn(bundled, key))
      throw new Error(`Unknown operator profile: ${key}`);
  if (user[name] !== undefined) profile = specialize(profile, user[name], true);
  if (trusted) {
    const project = await config(join(cwd, CONFIG_DIR_NAME, "delegation.json"));
    for (const key of Object.keys(project))
      if (key !== "scheduling" && !Object.hasOwn(bundled, key))
        throw new Error(`Unknown project profile: ${key}`);
    if (project[name] !== undefined) profile = specialize(profile, project[name], false);
  }
  for (const path of profile.skills) await readFile(path, "utf8");
  const loaded = loadSkills({
    cwd,
    agentDir: operatorDir,
    skillPaths: [...profile.skills],
    includeDefaults: false,
  });
  if (loaded.diagnostics.length || loaded.skills.length !== profile.skills.length)
    throw new Error(
      "Granted skills must be valid, distinct skill files (not discovery directories)",
    );
  return { profile, skills: loaded.skills };
}
export function bundledProfiles(): Profile[] {
  return structuredClone(Object.values(bundled));
}

/** Keep current definitions/prompts but intersect executable grants with an admitted ceiling. */
export function intersectProfileGrants(profile: Profile, maximum: Profile): Profile {
  return {
    ...profile,
    models:
      maximum.models === undefined
        ? undefined
        : (profile.models ?? []).filter((selection) => allowsModel(maximum, selection)),
    prewalk:
      profile.prewalk && maximum.prewalk && sameSelection(profile.prewalk, maximum.prewalk)
        ? profile.prewalk
        : undefined,
    tools: profile.tools.filter((tool) => maximum.tools.includes(tool)),
    leafTools: profile.leafTools?.filter((name) => maximum.leafTools?.includes(name)),
    skills: profile.skills.filter((skill) => maximum.skills.includes(skill)),
    spawn: profile.spawn?.filter((role) => maximum.spawn?.includes(role)),
    coordination: profile.coordination?.filter((action) => maximum.coordination?.includes(action)),
  };
}
