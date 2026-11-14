import fs from "node:fs/promises";
import { constants } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { CONFIG_DIR_NAME, getAgentDir, type Skill } from "@earendil-works/pi-coding-agent";
import type { DelegationCoordinator } from "./coordinator.ts";
import {
  bundledProfiles,
  resolveProfileCatalog,
  validateCustomRoleName,
  validateProfileSkills,
  type ProfileCatalog,
} from "./profiles.ts";
import { narrowLimits, validatePolicy } from "./scheduling.ts";

const bundledNames = new Set(bundledProfiles().map((profile) => profile.name));

export type ProfileDestination = "global" | "project";
type FileSnapshot = {
  path: string;
  content: string | null;
  mode?: number;
  ino?: number;
  dev?: number;
  mtimeMs?: number;
  ctimeMs?: number;
};
export type ProfileDeletionBlocker = { role: string; location: string; reason: string };
export type ProfileDiskObservation = { path: string } & (
  | { content: string | null }
  | { error: string }
);
export type ProfileDraftOptions = {
  cwd: string;
  isProjectTrusted: () => boolean;
  operatorDir?: string;
  availableSkills?: () => readonly Skill[];
  coordinator: Pick<DelegationCoordinator, "profileUsage">;
};
export class ProfileConfigError extends Error {
  readonly stage: "open" | "validate" | "conflict" | "write" | "verify";
  readonly path: string;
  readonly replacement: "not-attempted" | "completed" | "unknown";
  readonly observed?: Partial<Record<ProfileDestination, ProfileDiskObservation>>;
  readonly blockers: readonly ProfileDeletionBlocker[];
  readonly cleanupError?: string;
  constructor(
    stage: ProfileConfigError["stage"],
    path: string,
    message: string,
    replacement: ProfileConfigError["replacement"] = "not-attempted",
    observed?: ProfileConfigError["observed"],
    blockers: readonly ProfileDeletionBlocker[] = [],
    cleanupError?: string,
  ) {
    super(
      `${stage} ${path}: ${message}${cleanupError ? `; temporary-file cleanup failed: ${cleanupError}` : ""}`,
    );
    this.name = "ProfileConfigError";
    this.stage = stage;
    this.path = path;
    this.replacement = replacement;
    this.observed = observed;
    this.blockers = blockers;
    this.cleanupError = cleanupError;
  }
}

async function snapshot(path: string): Promise<FileSnapshot> {
  let before;
  try {
    before = await fs.lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { path, content: null };
    throw error;
  }
  if (!before.isFile() || before.isSymbolicLink())
    throw new Error(`Refusing non-regular or symlink config ${path}`);
  const file = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    const content = await file.readFile("utf8");
    const after = await fs.lstat(path);
    if (
      !after.isFile() ||
      info.ino !== before.ino ||
      info.dev !== before.dev ||
      info.ino !== after.ino ||
      info.dev !== after.dev ||
      info.mtimeMs !== after.mtimeMs ||
      info.ctimeMs !== after.ctimeMs
    )
      throw new Error(`Config changed while reading ${path}; reload and review`);
    return {
      path,
      content,
      mode: info.mode & 0o7777,
      ino: info.ino,
      dev: info.dev,
      mtimeMs: info.mtimeMs,
      ctimeMs: info.ctimeMs,
    };
  } finally {
    await file.close();
  }
}
function parse(file: FileSnapshot): Record<string, unknown> {
  if (file.content === null) return {};
  try {
    const value: unknown = JSON.parse(file.content);
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("expected object");
    return value as Record<string, unknown>;
  } catch (error) {
    throw new Error(`Invalid delegation config ${file.path}; repair externally: ${String(error)}`);
  }
}
function custom(layer: Record<string, unknown>): Record<string, unknown> {
  return (layer.customProfiles ?? {}) as Record<string, unknown>;
}
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Scan only supplied local layers and the live coordinator, never external workspaces or transcripts. */
export function profileDeletionBlockers(
  name: string,
  catalog: Pick<ProfileCatalog, "global" | "project" | "globalPath" | "projectPath">,
  coordinator: Pick<DelegationCoordinator, "profileUsage">,
): ProfileDeletionBlocker[] {
  const blockers: ProfileDeletionBlocker[] = [];
  const add = (location: string, reason: string) => blockers.push({ role: name, location, reason });
  for (const [layer, path] of [
    [catalog.global, catalog.globalPath],
    [catalog.project, catalog.projectPath],
  ] as const) {
    if (Array.isArray(layer.projectRoleCeilings) && layer.projectRoleCeilings.includes(name))
      add(`${path}:projectRoleCeilings`, "Operator authorization still names this ceiling");
    for (const [target, ceiling] of Object.entries(record(layer.projectSpawnTargets))) {
      if (target === name)
        add(
          `${path}:projectSpawnTargets.${target}`,
          "Incoming target registration still references this local role; remove global parent spawn refs and registration explicitly before deleting its local definition",
        );
      if (ceiling === name)
        add(
          `${path}:projectSpawnTargets.${target}`,
          "Incoming target registration still uses this ceiling",
        );
    }
    for (const [role, value] of [
      ...Object.entries(layer).filter(([key]) => bundledNames.has(key)),
      ...Object.entries(custom(layer)),
    ]) {
      const input = record(value);
      if (Array.isArray(input.spawn) && input.spawn.includes(name))
        add(`${path}:${role}.spawn`, "Spawn grant still references this role");
      if (input.ceiling === name)
        add(`${path}:${role}.ceiling`, "Local definition still uses this ceiling");
    }
  }
  if (Object.hasOwn(custom(catalog.project), name))
    add(
      `${catalog.projectPath}:customProfiles.${name}`,
      "Project entry still overrides or defines this role; reset it explicitly first",
    );
  for (const task of coordinator.profileUsage(name))
    add(`${task.id}@${task.generation}`, `Local task is nonterminal or reusable (${task.status})`);
  return blockers;
}

// Editor saves are infrequent. One short-lived promise tail also coordinates edits to shared
// authority across workspaces; it is not a filesystem lock or external-writer compare-and-swap.
let saves: Promise<void> = Promise.resolve();

/** In-memory raw-layer draft. No opening, mutation, reset, deletion or preview writes to disk. */
export class ProfileConfigDraft {
  value: Record<string, unknown>;
  readonly destination: ProfileDestination;
  private readonly options: ProfileDraftOptions;
  private readonly trusted: boolean;
  private files: { global: FileSnapshot; project: FileSnapshot };
  private baseline: ProfileCatalog;
  private constructor(
    destination: ProfileDestination,
    options: ProfileDraftOptions,
    trusted: boolean,
    files: { global: FileSnapshot; project: FileSnapshot },
    baseline: ProfileCatalog,
  ) {
    this.destination = destination;
    this.options = options;
    this.trusted = trusted;
    this.files = files;
    this.baseline = baseline;
    this.value = structuredClone(baseline[destination]);
  }
  get path(): string {
    return this.files[this.destination].path;
  }
  get original(): Record<string, unknown> {
    return structuredClone(this.baseline[this.destination]);
  }
  get catalog(): ProfileCatalog {
    return structuredClone(this.baseline);
  }
  get dirty(): boolean {
    return !isDeepStrictEqual(this.value, this.baseline[this.destination]);
  }

  static async open(
    destination: ProfileDestination,
    options: ProfileDraftOptions,
  ): Promise<ProfileConfigDraft> {
    const trusted = options.isProjectTrusted();
    const globalPath = join(resolve(options.operatorDir ?? getAgentDir()), "delegation.json");
    const projectPath = join(resolve(options.cwd), CONFIG_DIR_NAME, "delegation.json");
    const path = destination === "global" ? globalPath : projectPath;
    try {
      if (destination === "project" && !trusted)
        throw new Error("Project editing requires existing host workspace trust");
      const files = {
        global: await snapshot(globalPath),
        project: trusted ? await snapshot(projectPath) : { path: projectPath, content: null },
      };
      const draft = new ProfileConfigDraft(destination, options, trusted, files, {
        global: parse(files.global),
        project: parse(files.project),
        globalPath,
        projectPath,
        profiles: [],
        provenance: {},
        projectRoleCeilings: [],
        projectSpawnTargets: {},
      });
      draft.baseline = await draft.validate();
      return draft;
    } catch (error) {
      throw new ProfileConfigError(
        "open",
        path,
        `${String(error)}. Unsupported or invalid input is not overwritten; repair the named file externally and reopen.`,
      );
    }
  }
  private assertTrust(): void {
    if (this.options.isProjectTrusted() !== this.trusted)
      throw new ProfileConfigError(
        "conflict",
        this.path,
        "Workspace trust changed; reopen and review the relevant layers",
      );
  }
  private layers(value = this.value): ProfileCatalog {
    return { ...this.baseline, [this.destination]: structuredClone(value) };
  }
  /** Stages definition removal only. A project override is reset separately, never deleted as a role. */
  deleteCustomRole(name: string): void {
    validateCustomRoleName(name);
    const entry = custom(this.value)[name];
    if (!entry || (this.destination === "project" && !Object.hasOwn(record(entry), "ceiling")))
      throw new Error("Not a custom definition in this destination; reset an override separately");
    delete custom(this.value)[name];
  }
  resetOverride(name: string): void {
    if (bundledNames.has(name)) delete this.value[name];
    else if (
      this.destination === "project" &&
      Object.hasOwn(custom(this.baseline.global), name) &&
      !Object.hasOwn(record(custom(this.value)[name]), "ceiling")
    )
      delete custom(this.value)[name];
    else throw new Error("Reset removes an override, not an independent custom definition");
  }
  deletionBlockers(value = this.value): ProfileDeletionBlocker[] {
    const layers = this.layers(value);
    const old = custom(this.baseline[this.destination]);
    return Object.keys(old)
      .filter(
        (name) =>
          !Object.hasOwn(custom(value), name) &&
          (this.destination === "global" || Object.hasOwn(record(old[name]), "ceiling")),
      )
      .flatMap((name) => profileDeletionBlockers(name, layers, this.options.coordinator));
  }
  /** Full candidate validation, including global grants hidden by project narrowing and exact skills. */
  async validate(value = this.value): Promise<ProfileCatalog> {
    await this.assertUnchanged();
    const catalog = await this.resolveCandidate(value);
    await this.assertUnchanged();
    return catalog;
  }
  private async resolveCandidate(value: Record<string, unknown>): Promise<ProfileCatalog> {
    this.assertTrust();
    const layers = this.layers(value);
    const blockers = this.deletionBlockers(value);
    if (blockers.length)
      throw new ProfileConfigError(
        "validate",
        this.path,
        "Custom deletion is blocked; explicitly remove references or stop/drain reusable tasks first",
        "not-attempted",
        undefined,
        blockers,
      );
    try {
      if (!isDeepStrictEqual(value.scheduling, this.baseline[this.destination].scheduling))
        throw new Error("Scheduling is not editable here and must be preserved");
      const skills = this.options.availableSkills?.() ?? [];
      const global = resolveProfileCatalog(layers.global, {}, skills);
      const scheduling = validatePolicy(layers.global.scheduling ?? {});
      narrowLimits(scheduling, layers.project.scheduling ?? {});
      await validateProfileSkills(global.profiles, this.options.cwd, dirname(layers.globalPath));
      const effective = resolveProfileCatalog(layers.global, layers.project, skills);
      await validateProfileSkills(effective.profiles, this.options.cwd, dirname(layers.globalPath));
      return { ...layers, ...effective };
    } catch (error) {
      throw new ProfileConfigError(
        "validate",
        this.path,
        `${String(error)}. Check ${layers.globalPath}${this.trusted ? ` and ${layers.projectPath}` : ""}; repair the affected layer explicitly. No cross-file repair is performed.`,
      );
    }
  }
  private async assertUnchanged(): Promise<void> {
    this.assertTrust();
    for (const destination of this.trusted
      ? (["global", "project"] as const)
      : (["global"] as const)) {
      const path = this.files[destination].path;
      let current;
      try {
        current = await snapshot(path);
      } catch (error) {
        throw new ProfileConfigError(
          "conflict",
          path,
          `Cannot verify the draft baseline; reload and review: ${String(error)}`,
        );
      }
      if (!isDeepStrictEqual(current, this.files[destination]))
        throw new ProfileConfigError(
          "conflict",
          current.path,
          "Config changed since this draft opened; draft retained. Reopen and review, never force-overwrite",
        );
    }
  }
  save(): Promise<{ path: string; catalog: ProfileCatalog }> {
    // Capture the submitted draft, not subsequent UI mutations while this save waits its turn.
    const value = structuredClone(this.value);
    const operation = saves.then(() => this.replace(value));
    saves = operation.then(
      () => {},
      () => {},
    );
    return operation;
  }
  private async replace(
    value: Record<string, unknown>,
  ): Promise<{ path: string; catalog: ProfileCatalog }> {
    let stage: ProfileConfigError["stage"] = "validate";
    let replacement: ProfileConfigError["replacement"] = "not-attempted";
    let temp: string | undefined;
    try {
      const content = JSON.stringify(value, null, 2) + "\n";
      const candidate = JSON.parse(content) as Record<string, unknown>;
      await this.validate(candidate);
      stage = "write";
      await fs.mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
      const tempPath = join(dirname(this.path), `.delegation-${randomUUID()}.tmp`);
      const file = await fs.open(
        tempPath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      temp = tempPath;
      try {
        await file.writeFile(content, "utf8");
        await file.chmod(this.files[this.destination].mode ?? 0o600);
        await file.sync();
      } finally {
        await file.close();
      }
      stage = "conflict";
      await this.assertUnchanged();
      const blockers = this.deletionBlockers(candidate);
      if (blockers.length)
        throw new ProfileConfigError(
          "validate",
          this.path,
          "A local role reference appeared during save",
          "not-attempted",
          undefined,
          blockers,
        );
      stage = "write";
      replacement = "unknown";
      // Residual race: another process can write after our final check and before this rename.
      await fs.rename(temp, this.path);
      replacement = "completed";
      temp = undefined;
      stage = "verify";
      const files = {
        global: await snapshot(this.files.global.path),
        project: this.trusted ? await snapshot(this.files.project.path) : this.files.project,
      };
      if (files[this.destination].content !== content)
        throw new Error(
          "Saved file differs from the submitted content; actual disk state retained, no rollback",
        );
      const other = this.destination === "global" ? "project" : "global";
      if (!isDeepStrictEqual(files[other], this.files[other]))
        throw new Error(
          `Non-target layer ${files[other].path} changed during replacement; no rollback`,
        );
      const catalog = await this.resolveCandidate(parse(files[this.destination]));
      this.assertTrust();
      // Skill validation awaits filesystem work; confirm the verified snapshot still matches disk.
      for (const destination of this.trusted
        ? (["global", "project"] as const)
        : (["global"] as const))
        if (!isDeepStrictEqual(await snapshot(files[destination].path), files[destination]))
          throw new Error(
            `Config changed during readback: ${files[destination].path}; no rollback`,
          );
      this.files = files;
      this.baseline = catalog;
      // Never discard additional in-memory edits made after save() was called.
      if (isDeepStrictEqual(this.value, value))
        this.value = structuredClone(catalog[this.destination]);
      return { path: this.path, catalog: structuredClone(catalog) };
    } catch (error) {
      let cleanupError: string | undefined;
      if (temp) {
        try {
          await fs.unlink(temp);
        } catch (cleanup) {
          if ((cleanup as NodeJS.ErrnoException).code !== "ENOENT")
            cleanupError = `${temp}: ${String(cleanup)}`;
        }
      }
      const observed: NonNullable<ProfileConfigError["observed"]> = {};
      for (const destination of this.trusted
        ? (["global", "project"] as const)
        : (["global"] as const)) {
        const path = this.files[destination].path;
        try {
          observed[destination] = { path, content: (await snapshot(path)).content };
        } catch (read) {
          observed[destination] = { path, error: String(read) };
        }
      }
      throw new ProfileConfigError(
        replacement === "completed"
          ? "verify"
          : error instanceof ProfileConfigError
            ? error.stage
            : stage,
        this.path,
        String(error),
        replacement,
        observed,
        error instanceof ProfileConfigError ? error.blockers : [],
        cleanupError,
      );
    }
  }
}
