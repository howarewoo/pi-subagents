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
    /** Internal local authority identity; never accepted as a JSON profile field. */
    projectCeiling?: string;
    /** Current exact incoming registration, not a parent spawn grant. */
    projectSpawnAuthorized?: boolean;
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
function specialize(
  base: Profile,
  value: unknown,
  operator: boolean,
  roles: ReadonlySet<string>,
): Profile {
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
  if (spawn.some((name) => !roles.has(name) || (!operator && !base.spawn?.includes(name))))
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

export const ROLE_NAME_PATTERN = "^[a-z][a-z0-9-]{0,63}$";
export function validateCustomRoleName(name: string): void {
  if (
    !new RegExp(ROLE_NAME_PATTERN).test(name) ||
    [
      "worker",
      "scheduling",
      "customProfiles",
      "projectRoleCeilings",
      "projectSpawnTargets",
      "constructor",
      "prototype",
      "__proto__",
    ].includes(name) ||
    Object.hasOwn(bundled, name)
  )
    throw new Error(`Invalid or reserved custom profile name: ${name}`);
}
function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}
function customRecords(layer: Record<string, unknown>, operator: boolean) {
  for (const key of Object.keys(layer))
    if (
      !Object.hasOwn(bundled, key) &&
      ![
        "scheduling",
        "customProfiles",
        ...(operator ? ["projectRoleCeilings", "projectSpawnTargets"] : []),
      ].includes(key)
    )
      throw new Error(`Unknown ${operator ? "operator" : "project"} profile: ${key}`);
  const entries =
    layer.customProfiles === undefined ? {} : record(layer.customProfiles, "customProfiles");
  for (const name of Object.keys(entries)) validateCustomRoleName(name);
  return entries;
}
function definition(name: string, value: unknown, roles: ReadonlySet<string>): Profile {
  const input = record(value, `Custom profile ${name}`);
  for (const field of ["description", "prompt", "tools", "skills", "spawn", "coordination"])
    if (!Object.hasOwn(input, field))
      throw new Error(`Custom profile ${name} requires explicit ${field}`);
  return specialize(
    {
      name,
      description: "",
      prompt: "",
      tools: WRITE_TOOLS,
      skills: [],
      spawn: [],
      coordination: [],
    },
    input,
    true,
    roles,
  );
}
/** Check independent content against authority, without inheriting its instructions or routing. */
function boundLocal(profile: Profile, ceiling: Profile, roles: ReadonlySet<string>): Profile {
  specialize(
    { ...ceiling, model: undefined, prewalk: profile.prewalk ? ceiling.prewalk : undefined },
    {
      tools: profile.tools,
      skills: profile.skills,
      spawn: profile.spawn,
      coordination: profile.coordination,
      ...(profile.models === undefined ? {} : { models: profile.models }),
      ...(profile.model ? { model: profile.model } : {}),
      ...(profile.prewalk ? { prewalk: profile.prewalk } : {}),
      fallback: profile.fallback ?? false,
    },
    false,
    roles,
  );
  return { ...profile, inheritedModelCeiling: ceiling.models };
}
export type ProfileProvenance = {
  source: "bundled" | "global" | "project";
  globalOverride: boolean;
  projectOverride: boolean;
  ceiling?: string;
};
export type ProfileCatalog = {
  profiles: Profile[];
  provenance: Record<string, ProfileProvenance>;
  global: Record<string, unknown>;
  project: Record<string, unknown>;
  globalPath: string;
  projectPath: string;
  projectRoleCeilings: string[];
  projectSpawnTargets: Record<string, string>;
};
/** Pure shared preview/admission policy. Raw layers remain separate from effective values. */
export function resolveProfileCatalog(
  global: Record<string, unknown>,
  project: Record<string, unknown>,
  availableSkills: readonly Skill[] = [],
): Pick<ProfileCatalog, "profiles" | "provenance" | "projectRoleCeilings" | "projectSpawnTargets"> {
  const globals = customRecords(global, true);
  const locals = customRecords(project, false);
  const globalNames = new Set([...Object.keys(bundled), ...Object.keys(globals)]);
  const ceilings =
    global.projectRoleCeilings === undefined
      ? []
      : strings(global.projectRoleCeilings, "projectRoleCeilings");
  if (ceilings.some((name) => !globalNames.has(name)))
    throw new Error("projectRoleCeilings must name global roles");
  const registrations =
    global.projectSpawnTargets === undefined
      ? {}
      : record(global.projectSpawnTargets, "projectSpawnTargets");
  const targets: Record<string, string> = {};
  for (const [name, ceiling] of Object.entries(registrations)) {
    validateCustomRoleName(name);
    if (globalNames.has(name))
      throw new Error(`Registered project target collides with global role: ${name}`);
    if (typeof ceiling !== "string" || !ceilings.includes(ceiling))
      throw new Error(`Registered project target ${name} requires an allowlisted global ceiling`);
    targets[name] = ceiling;
  }
  const spawnNames = new Set([...globalNames, ...Object.keys(targets)]);
  const roles = new Set([...spawnNames, ...Object.keys(locals)]);
  const authorized = new Map<string, Profile>();
  const effective = new Map<string, Profile>();
  const provenance: Record<string, ProfileProvenance> = Object.create(null);
  // Registrations permit references across trusted projects, never placeholder profiles.
  for (const name of globalNames) {
    let profile = Object.hasOwn(bundled, name)
      ? bundled[name]
      : definition(name, globals[name], spawnNames);
    if (name === "general")
      profile = { ...profile, skills: availableSkills.map((skill) => skill.filePath) };
    if (Object.hasOwn(bundled, name) && global[name] !== undefined)
      profile = specialize(profile, global[name], true, spawnNames);
    authorized.set(name, profile);
    const override = Object.hasOwn(bundled, name) ? project[name] : locals[name];
    if (override !== undefined) profile = specialize(profile, override, false, roles);
    effective.set(name, profile);
    provenance[name] = {
      source: Object.hasOwn(bundled, name) ? "bundled" : "global",
      globalOverride: global[name] !== undefined,
      projectOverride: override !== undefined,
    };
  }
  for (const [name, value] of Object.entries(locals)) {
    if (globalNames.has(name)) continue;
    const input = record(value, `Custom profile ${name}`);
    const { ceiling, ...settings } = input;
    if (typeof ceiling !== "string" || !ceilings.includes(ceiling))
      throw new Error(`Project profile ${name} requires an authorized ceiling`);
    if (Object.hasOwn(targets, name) && targets[name] !== ceiling)
      throw new Error(`Project target ${name} must use its registered ceiling ${targets[name]}`);
    let profile = definition(name, settings, roles);
    try {
      profile = boundLocal(profile, authorized.get(ceiling)!, roles);
      profile = boundLocal(profile, effective.get(ceiling)!, roles);
    } catch (error) {
      throw new Error(`Project profile ${name} exceeds ceiling ${ceiling}: ${String(error)}`);
    }
    profile = {
      ...profile,
      projectCeiling: ceiling,
      projectSpawnAuthorized: targets[name] === ceiling,
    };
    effective.set(name, profile);
    provenance[name] = {
      source: "project",
      globalOverride: false,
      projectOverride: false,
      ceiling,
    };
  }
  return {
    profiles: [...effective.values()],
    provenance,
    projectRoleCeilings: ceilings,
    projectSpawnTargets: targets,
  };
}
export async function loadProfileCatalog(
  cwd: string,
  trusted: boolean,
  operatorDir = getAgentDir(),
  availableSkills: readonly Skill[] = [],
): Promise<ProfileCatalog> {
  const globalPath = join(operatorDir, "delegation.json");
  const projectPath = join(cwd, CONFIG_DIR_NAME, "delegation.json");
  const global = await config(globalPath);
  const project = trusted ? await config(projectPath) : {};
  return {
    ...resolveProfileCatalog(global, project, availableSkills),
    global,
    project,
    globalPath,
    projectPath,
  };
}
async function profileSkills(profile: Profile, cwd: string, operatorDir: string): Promise<Skill[]> {
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
  return loaded.skills;
}
/** Operator config grants; trusted projects only narrow or define explicitly bounded local roles. */
export async function resolveProfile(
  name: string,
  cwd: string,
  trusted: boolean,
  operatorDir = getAgentDir(),
  availableSkills: readonly Skill[] = [],
): Promise<{ profile: Profile; skills: Skill[] }> {
  const catalog = await loadProfileCatalog(cwd, trusted, operatorDir, availableSkills);
  const profile = catalog.profiles.find((profile) => profile.name === name);
  if (!profile) throw new Error(`Unknown delegation profile: ${name}`);
  return { profile, skills: await profileSkills(profile, cwd, operatorDir) };
}
export async function resolvedCatalogProfiles(
  cwd: string,
  trusted: boolean,
  operatorDir = getAgentDir(),
  availableSkills: readonly Skill[] = [],
): Promise<Profile[]> {
  const { profiles } = await loadProfileCatalog(cwd, trusted, operatorDir, availableSkills);
  await validateProfileSkills(profiles, cwd, operatorDir);
  return profiles;
}
/** Validate a candidate snapshot with the same exact-file skill loader used at admission. */
export async function validateProfileSkills(
  profiles: readonly Profile[],
  cwd: string,
  operatorDir = getAgentDir(),
): Promise<void> {
  for (const profile of profiles) await profileSkills(profile, cwd, operatorDir);
}
export function bundledProfiles(): Profile[] {
  return structuredClone(Object.values(bundled));
}

/** Keep current definitions/prompts but intersect executable grants with an admitted ceiling. */
export function intersectProfileGrants(profile: Profile, maximum: Profile): Profile {
  return {
    ...profile,
    inheritedModelCeiling:
      maximum.inheritedModelCeiling === undefined
        ? profile.inheritedModelCeiling
        : profile.inheritedModelCeiling === undefined
          ? maximum.inheritedModelCeiling
          : profile.inheritedModelCeiling.filter((selection) =>
              maximum.inheritedModelCeiling!.some((item) => sameSelection(item, selection)),
            ),
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
