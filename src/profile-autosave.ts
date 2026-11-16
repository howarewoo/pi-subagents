import {
  bundledProfiles,
  resolveProfileCatalog,
  type ProfileCatalog,
  type Profile,
} from "./profiles.ts";
import { sameSelection, type ModelSelection } from "./model-policy.ts";
import {
  ProfileConfigDraft,
  ProfileConfigError,
  type ProfileDestination,
  type ProfileDraftOptions,
} from "./profile-config.ts";

export type OrdinaryProfileField =
  | "description"
  | "prompt"
  | "tools"
  | "skills"
  | "spawn"
  | "coordination"
  | "leafTools";
type Identity = { destination: ProfileDestination; profile: string };
/** Committed item actions, never a captured raw layer or a numeric row index. */
export type ProfileIntent = Identity &
  (
    | { field: OrdinaryProfileField; action: "set"; value: unknown }
    | { field: OrdinaryProfileField | "fallback" | "models" | "model" | "prewalk"; action: "reset" }
    | {
        field: "tools" | "skills" | "spawn" | "coordination" | "leafTools";
        action: "include" | "exclude" | "toggle";
        item: string;
      }
    | { field: "models"; action: "grant" | "revoke"; target: ModelSelection }
    | {
        field: "model" | "prewalk";
        action: "select" | "switch-from-fallback";
        target: ModelSelection;
      }
    | {
        field: "fallback";
        action: "replace-target";
        target: ModelSelection;
        replacement: ModelSelection;
      }
    | { field: "fallback"; action: "disable" }
    | { field: Exclude<OrdinaryProfileField, "description" | "prompt"> | "models"; action: "clear" }
    | {
        field: "fallback";
        action: "add" | "switch-from-prewalk" | "remove";
        target: ModelSelection;
      }
    | {
        field: "fallback";
        action: "move";
        target: ModelSelection;
        direction: "earlier" | "later";
      }
  );
export type AutosaveFailure = {
  intent: ProfileIntent;
  error: ProfileConfigError;
  recovery: "retry-revert" | "reload";
};
export type ProfileAutosaveOptions = ProfileDraftOptions & {
  /** Recheck only newly selected exact targets. Throw an eligibility reason; no provider calls. */
  checkSelection: (target: ModelSelection) => void | Promise<void>;
};
const bundled = new Set(bundledProfiles().map((profile) => profile.name));

function projectIntent(
  catalog: ProfileCatalog,
  intent: ProfileIntent,
  options: ProfileDraftOptions,
  strict = false,
): ProfileCatalog {
  const next = structuredClone(catalog);
  // Global actions use operator values, never this workspace's narrowed effective chain/grants.
  let profiles = next.profiles;
  if (intent.destination === "global") {
    try {
      profiles = resolveProfileCatalog(next.global, {}, options.availableSkills?.() ?? []).profiles;
    } catch (error) {
      if (strict) throw error;
    }
  }
  const profile = profiles.find((item) => item.name === intent.profile);
  if (!profile) throw new Error(`Unknown profile ${intent.profile}`);
  const layer = next[intent.destination];
  const custom = (layer.customProfiles ?? {}) as Record<string, Record<string, unknown>>;
  if (
    intent.destination === "global" &&
    !bundled.has(intent.profile) &&
    !Object.hasOwn(custom, intent.profile)
  )
    throw new Error("Project-local profiles require an explicit Project destination");
  const roles = bundled.has(intent.profile)
    ? layer
    : ((layer.customProfiles ??= {}) as Record<string, unknown>);
  const raw = (roles[intent.profile] ??= {}) as Record<string, unknown>;
  if (intent.action === "set") raw[intent.field] = structuredClone(intent.value);
  else if (intent.action === "reset") delete raw[intent.field];
  else if (intent.action === "disable") raw.fallback = false;
  else if (intent.action === "clear") raw[intent.field] = [];
  else if (
    intent.action === "include" ||
    intent.action === "exclude" ||
    intent.action === "toggle"
  ) {
    const values: string[] = [...(profile[intent.field] ?? [])];
    if (
      intent.action === "include" ||
      (intent.action === "toggle" && !values.includes(intent.item))
    ) {
      if (values.includes(intent.item)) throw new Error("Item already included");
      values.push(intent.item);
    } else {
      if (!values.includes(intent.item)) throw new Error("Item already absent");
      values.splice(values.indexOf(intent.item), 1);
    }
    raw[intent.field] = values;
  } else if (intent.action === "grant" || intent.action === "revoke") {
    const grants = [...(profile.models ?? [])];
    const index = grants.findIndex((item) => sameSelection(item, intent.target));
    if (intent.action === "grant") {
      if (index !== -1) throw new Error("Exact grant already present");
      grants.push(intent.target);
    } else {
      if (index === -1) throw new Error("Exact grant already absent");
      const reason = profileGrantRemovalReason(profile, intent.target);
      if (reason) throw new Error(reason);
      grants.splice(index, 1);
    }
    raw.models = grants;
  } else if (intent.action === "select" || intent.action === "switch-from-fallback") {
    if (intent.action === "switch-from-fallback") {
      if (intent.field !== "prewalk" || intent.destination !== "global")
        throw new Error("Switch to prewalk requires Global destination");
      raw.fallback = false;
    } else if (intent.field === "prewalk" && profile.fallback)
      throw new Error("Use explicit Disable fallback and select prewalk");
    raw[intent.field] = intent.target;
  } else if (intent.field === "fallback" && "target" in intent) {
    const chain = [...(profile.fallback ?? [])];
    const index = chain.findIndex((item) => sameSelection(item, intent.target));
    if (intent.action === "add" || intent.action === "switch-from-prewalk") {
      if (intent.destination !== "global") throw new Error("Add requires Global destination");
      if (index !== -1) throw new Error("Exact target is already in the chain");
      if (profile.prewalk && intent.action !== "switch-from-prewalk")
        throw new Error("Use the explicit Switch from prewalk and add action");
      if (intent.action === "switch-from-prewalk") {
        if (!profile.prewalk) throw new Error("There is no prewalk to switch from");
        delete raw.prewalk;
      }
      const grants = [...(profile.models ?? [])];
      if (!grants.some((item) => sameSelection(item, intent.target))) grants.push(intent.target);
      raw.models = grants;
      chain.push(intent.target);
    } else {
      if (index === -1) throw new Error("Exact target is no longer in the chain");
      if (intent.action === "remove") chain.splice(index, 1);
      else if (intent.action === "replace-target") {
        if (intent.destination !== "global")
          throw new Error("Effort changes require Global destination");
        if (chain.some((item) => sameSelection(item, intent.replacement)))
          throw new Error("Exact target is already in the chain");
        const grants = [...(profile.models ?? [])];
        if (!grants.some((item) => sameSelection(item, intent.replacement)))
          grants.push(intent.replacement);
        raw.models = grants;
        chain[index] = intent.replacement;
      } else if (intent.action === "move") {
        if (intent.destination !== "global") throw new Error("Reorder requires Global destination");
        const to = index + (intent.direction === "earlier" ? -1 : 1);
        if (to < 0 || to >= chain.length) throw new Error("Target is already at the boundary");
        [chain[index], chain[to]] = [chain[to]!, chain[index]!];
      }
    }
    raw.fallback = chain.length ? chain : false;
  }
  if (Array.isArray(raw.models) && raw.models.length > 64)
    throw new Error("Maximum 64 exact grants");
  if (Array.isArray(raw.fallback) && raw.fallback.length > 64)
    throw new Error("Maximum 64 chain targets");
  try {
    return {
      ...next,
      ...resolveProfileCatalog(next.global, next.project, options.availableSkills?.() ?? []),
    };
  } catch (error) {
    if (strict) throw error;
    // Retain invalid attempted raw input for Not saved recovery, not as verified effective policy.
    return next;
  }
}

export function profileGrantRemovalReason(
  profile: Profile,
  target: ModelSelection,
): string | undefined {
  if (
    [profile.model, profile.prewalk, ...(profile.fallback ?? [])].some(
      (item) => item && sameSelection(item, target),
    )
  )
    return "Required by a current chain/default/prewalk target; adjust routing first";
}

/** One destination, one retained engine baseline, one independently verified save per intent.
 */
export class ProfileAutosaveController {
  private draft: ProfileConfigDraft | undefined;
  private verifiedCatalog: ProfileCatalog;
  private intents: ProfileIntent[] = [];
  private running: Promise<void> | undefined;
  private reloading: Promise<number> | undefined;
  private navigation: (() => void) | undefined;
  private paused: AutosaveFailure | undefined;
  private reopenError: unknown;
  private drained = false;
  readonly destination: ProfileDestination;
  private readonly listeners = new Set<() => void>();
  private trusted: boolean;
  private readonly options: ProfileAutosaveOptions;

  private constructor(draft: ProfileConfigDraft, options: ProfileAutosaveOptions) {
    this.draft = draft;
    this.destination = draft.destination;
    this.trusted = options.isProjectTrusted();
    this.verifiedCatalog = draft.catalog;
    this.options = options;
  }
  static async open(destination: ProfileDestination, options: ProfileAutosaveOptions) {
    return new ProfileAutosaveController(
      await ProfileConfigDraft.open(destination, options),
      options,
    );
  }
  get path(): string {
    return this.destination === "global"
      ? this.verifiedCatalog.globalPath
      : this.verifiedCatalog.projectPath;
  }
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  private notify(): void {
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        /* A rendering failure must not reclassify an independently verified replacement. */
      }
    }
  }
  get verified(): ProfileCatalog {
    return structuredClone(this.verifiedCatalog);
  }
  get projected(): ProfileCatalog {
    return this.intents.reduce(
      (catalog, intent) => projectIntent(catalog, intent, this.options),
      this.verified,
    );
  }
  get pending(): readonly ProfileIntent[] {
    return structuredClone(this.intents);
  }
  get failure(): AutosaveFailure | undefined {
    return this.paused && { ...this.paused, intent: structuredClone(this.paused.intent) };
  }
  get reloadError(): unknown {
    return this.reopenError;
  }
  get status(): "saved" | "saving" | "finishing" | "not-saved" | "reload-required" | "read-only" {
    if (this.reopenError || !this.draft || (this.drained && !this.intents.length))
      return "read-only";
    if (this.paused) return this.paused.recovery === "reload" ? "reload-required" : "not-saved";
    if (this.navigation) return "finishing";
    return this.intents.length ? "saving" : "saved";
  }
  enqueue(intent: ProfileIntent): void {
    if (!this.draft || this.paused || this.drained) throw new Error("Mutations are paused");
    if (intent.destination !== this.destination) throw new Error("Wrong editing destination");
    const owned = structuredClone(intent);
    projectIntent(this.projected, owned, this.options); // Reject duplicates/boundaries against projection.
    this.intents.push(owned);
    this.start();
    this.notify();
  }
  /** Await currently accepted work, including a paused failure (which is exposed in state). */
  async settled(): Promise<void> {
    await this.running;
  }
  private start(): void {
    if (this.running || this.paused || !this.intents.length) return;
    this.running = this.run().finally(() => {
      this.running = undefined;
      this.notify();
    });
  }
  private async run(): Promise<void> {
    while (this.intents.length && !this.paused) {
      const intent = this.intents[0]!;
      const draft = this.draft!;
      try {
        // Validate baseline/trust before even consulting metadata. Never reopen over external edits.
        await draft.validate(draft.original);
        if (intent.action === "replace-target")
          await this.options.checkSelection(intent.replacement);
        else if (
          ["add", "switch-from-prewalk", "grant", "select", "switch-from-fallback"].includes(
            intent.action,
          ) &&
          "target" in intent
        )
          await this.options.checkSelection(intent.target);
        const candidate = projectIntent(this.verifiedCatalog, intent, this.options, true);
        draft.value = structuredClone(candidate[this.destination]);
        const saved = await draft.save();
        this.verifiedCatalog = saved.catalog;
        this.intents.shift();
        this.notify();
      } catch (error) {
        let detail =
          error instanceof ProfileConfigError
            ? error
            : new ProfileConfigError("validate", draft.path, String(error));
        if (detail.replacement === "not-attempted" && detail.stage !== "conflict") {
          // Retry/Revert is safe only while the retained baselines are still unchanged,
          // including when metadata rejected a selection before save() was reached.
          try {
            await draft.validate(draft.original);
          } catch (boundary) {
            if (boundary instanceof ProfileConfigError && boundary.stage === "conflict")
              detail = boundary;
          }
        }
        const trustChanged = this.options.isProjectTrusted() !== this.trusted;
        this.paused = {
          intent,
          error: detail,
          recovery:
            trustChanged || detail.stage === "conflict" || detail.replacement !== "not-attempted"
              ? "reload"
              : "retry-revert",
        };
        this.navigation = undefined; // Retry must never resurrect a cancelled close/transition.
        this.drained = false;
        this.notify();
      }
    }
    if (!this.paused && this.navigation) {
      const navigate = this.navigation;
      this.navigation = undefined;
      navigate();
    }
  }
  retry(): void {
    if (this.paused?.recovery !== "retry-revert") throw new Error("Explicit Reload required");
    this.paused = undefined;
    this.start();
    this.notify();
  }
  revert(): number {
    if (this.paused?.recovery !== "retry-revert") throw new Error("Explicit Reload required");
    const count = this.intents.length;
    this.intents = [];
    this.paused = undefined;
    this.draft!.value = this.draft!.original;
    this.notify();
    return count;
  }
  /** Abandon first, even if reopening fails. No replay, merge, force-write or rollback. */
  reload(): Promise<number> {
    // A repeated recovery request joins the same reopen; a late snapshot must never
    // replace a baseline that has already resumed verified item saves.
    this.reloading ??= this.reopen().finally(() => {
      this.reloading = undefined;
    });
    return this.reloading;
  }
  private async reopen(): Promise<number> {
    if (this.running) throw new Error("Wait for the current save to settle");
    const count = this.intents.length;
    this.intents = [];
    this.paused = undefined;
    this.navigation = undefined;
    this.draft = undefined;
    try {
      this.draft = await ProfileConfigDraft.open(this.destination, this.options);
      this.verifiedCatalog = this.draft.catalog;
      this.trusted = this.options.isProjectTrusted();
      this.reopenError = undefined;
      this.drained = false;
    } catch (error) {
      this.reopenError = error;
    }
    this.notify();
    return count;
  }
  /** Caller commits eligible text first. Structural flows must reload before accepting new intents. */
  drain(navigate: () => void): void {
    if (this.paused) throw new Error("Resolve the save failure before leaving");
    if (this.navigation) throw new Error("Already finishing saves");
    this.drained = true;
    if (!this.intents.length) navigate();
    else this.navigation = navigate;
    this.notify();
  }
}
