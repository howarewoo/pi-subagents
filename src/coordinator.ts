import {
  taskFallback,
  initialFallback,
  authorizeFallback,
  availableFallback,
} from "./model-fallback.ts";
import { requireSupportedHost } from "./supported-host.ts";
import { leafDenial, toolProvenance, type CapabilityDenial } from "./capabilities.ts";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import {
  SessionManager,
  type AgentSession,
  type AgentSessionEvent,
} from "@earendil-works/pi-coding-agent";
import { resultValidator } from "./outcomes.ts";
import {
  allowsModel,
  sameSelection,
  validateModelSelection,
  type ModelSelection,
} from "./model-policy.ts";
import { resolveWorkspace } from "./workspace.ts";
import {
  DEFAULT_POLICY,
  resolveScheduling,
  narrowLimits,
  validatePolicy,
  type ExecutionLimits,
  type SchedulingPolicy,
} from "./scheduling.ts";
import {
  resolveProfile,
  intersectProfileGrants,
  type Profile,
  type BuiltinTool,
  type CoordinationAction,
} from "./profiles.ts";

const MAX_MESSAGE_BYTES = 4096;
const MAX_MAILBOX_MESSAGES = 64;
const MAX_RETAINED_MESSAGES = 512;
const MAX_WAITERS = 64;
const MAX_WAIT_MS = 60000;
const MAX_GENERATIONS = 64;

export type {
  DelegationMessage,
  CoordinationWait,
  ChildRef,
  ChildSnapshot,
  RegistryEvent,
  StartTask,
} from "./delegation-types.ts";
import type {
  DelegationMessage,
  CoordinationWait,
  ChildRef,
  ChildSnapshot,
  RegistryEvent,
  StartTask,
} from "./delegation-types.ts";
import { createChildExecution, type ExecutionRecord } from "./child-execution.ts";
export { childResources } from "./child-execution.ts";

type Entry = ExecutionRecord & {
  done: Promise<void>;
  finish: () => void;
  spawned: number;
  finalizedMessages?: AgentSession["messages"];
  setup?: Promise<void>;
  resuming?: boolean;
  pauseDrain?: Promise<void>;
  callerId: string;
  fallbackReset?: boolean;
  resettingFallback?: boolean;
};

function broadenedGrant(profile: Profile, grant: Profile) {
  return (["tools", "skills", "leafTools", "spawn", "coordination"] as const).find((key) =>
    (profile[key] ?? []).some(
      (value) => !(grant[key] as readonly string[] | undefined)?.includes(value),
    ),
  );
}

function admittedModel(entry: Entry, selection: ModelSelection): boolean {
  return entry.input.profile.models === undefined
    ? sameSelection(selection, {
        ...entry.state.model,
        effort: entry.state.effort as ModelSelection["effort"],
      })
    : allowsModel(entry.input.profile, selection);
}

/** Authoritative parent-lifetime registry. IDs are never reused; controls require their generation. */
export class DelegationCoordinator {
  private entries = new Map<string, Entry>();
  private queue = new Set<Entry>();
  private history = new Map<string, { state: ChildSnapshot; messages: AgentSession["messages"] }>();
  private presence = new Map<
    string,
    "active" | "pausing" | "paused" | "idle" | "parked" | "stopped"
  >();
  private coordinationListeners = new Set<() => void>();
  private coordinationMessages: DelegationMessage[] = [];
  private mailboxes = new Map<string, DelegationMessage[]>();
  private waits = new Map<string, Set<string>>();
  private waiterCount = 0;
  private notifyCoordination(): void {
    for (const listener of this.coordinationListeners) listener();
  }
  agents() {
    return this.list().map((state) => ({
      id: state.id,
      generation: state.generation,
      presence: this.presence.get(state.id),
    }));
  }
  /** Full parent-lifetime session roster, including retained historical generations. */
  sessions(): ChildSnapshot[] {
    return [...this.history.values()]
      .map((record) => structuredClone(record.state))
      .concat(this.list());
  }
  generations(id: string): ChildSnapshot[] {
    return this.sessions().filter((state) => state.id === id);
  }
  private listeners = new Set<(event: RegistryEvent) => void>();
  private closing = false;
  private shutdownPromise?: Promise<void>;
  readonly root: string;
  readonly parentId: string;
  constructor(root: string, parentId: string) {
    this.root = root;
    this.parentId = parentId;
  }
  private policy: SchedulingPolicy = { ...DEFAULT_POLICY };
  configure(policy: SchedulingPolicy): void {
    this.policy = validatePolicy(policy);
    this.pump();
  }
  list(): ChildSnapshot[] {
    return [...this.entries.values()].map((entry) => structuredClone(entry.state));
  }
  snapshot(ref?: ChildRef): ChildSnapshot | undefined {
    if (ref) {
      const historical = this.history.get(this.key(ref));
      if (historical) return structuredClone(historical.state);
    }
    const entry = ref ? this.entry(ref) : [...this.entries.values()].at(-1);
    return entry && structuredClone(entry.state);
  }
  private entry(ref: ChildRef): Entry {
    const entry = this.entries.get(ref.id);
    if (!entry || entry.state.generation !== ref.generation)
      throw new Error("Unknown or stale delegation identity");
    return entry;
  }
  subscribe(listener: (event: RegistryEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  private update(entry: Entry, patch: Partial<ChildSnapshot>, event?: AgentSessionEvent): void {
    entry.state = { ...entry.state, ...patch };
    this.notifyCoordination();
    for (const listener of this.listeners) {
      // Observers must never own execution or turn a successful run into failure.
      try {
        listener({ type: event ? "sdk" : "changed", child: structuredClone(entry.state), event });
      } catch {
        /* observer isolated */
      }
    }
  }
  private active(): Entry[] {
    return [...this.entries.values()].filter(
      (entry) =>
        !entry.state.disposed && entry.state.status !== "queued" && entry.state.status !== "paused",
    );
  }
  private validate(input: StartTask): ExecutionRecord["selection"] {
    if (this.closing) throw new Error("Parent shut down");
    if (!input.assignment.trim()) throw new Error("A nonempty assignment is required");
    const selection: ExecutionRecord["selection"] = {
      model: input.context.model,
      modelRegistry: input.context.modelRegistry,
      scopedModels: input.context.scopedModels,
      thinkingLevel: input.context.thinkingLevel,
      cwd: input.cwd ?? input.context.cwd,
    };
    if (!selection.model) throw new Error("A selected parent model is required");
    const chain = taskFallback(input);
    if (chain) selection.fallback = initialFallback(selection, chain);
    const requested = selection.fallback
      ? selection.fallback.chain[selection.fallback.index]
      : (input.model ?? input.profile.model);
    const parentState = input.parent ? this.entry(input.parent).state : undefined;
    const effective: ModelSelection = requested ?? {
      ...(parentState?.model ?? { provider: selection.model.provider, id: selection.model.id }),
      effort:
        (parentState?.effort as ModelSelection["effort"] | undefined) ??
        selection.thinkingLevel ??
        "off",
    };
    if (
      (requested && !input.profile.models?.some((item) => sameSelection(item, requested))) ||
      !allowsModel(input.profile, effective)
    )
      throw new Error("Model selection denied by effective profile grants");
    selection.model = validateModelSelection(selection, effective);
    selection.thinkingLevel = effective.effort;
    if (input.profile.prewalk && !input.model) {
      if (!input.profile.models?.some((item) => sameSelection(item, input.profile.prewalk!)))
        throw new Error("Prewalk target requires an exact model grant");
      validateModelSelection(selection, input.profile.prewalk);
    }
    this.validateAdmission(input, effective, input.model);
    return selection;
  }
  /** Shared lineage checks; resume supplies its retained selection, not admission defaults. */
  private validateAdmission(
    input: StartTask,
    effective: ModelSelection,
    explicit?: ModelSelection,
  ): void {
    if (input.parent) {
      const parent = this.entry(input.parent);
      if (parent.cancelled || parent.paused || parent.state.disposed)
        throw new Error("Delegating parent is no longer active");
      this.assertDescendantModels(parent, input.profile, effective, explicit);
      if (!parent.input.profile.spawn?.includes(input.profile.name))
        throw new Error("Ancestor spawn role denied");
      if (parent.state.depth >= Math.min(this.policy.depth, parent.state.limits.depth))
        throw new Error("Delegation depth limit");
      if (broadenedGrant(input.profile, parent.input.profile))
        throw new Error("Descendant cannot broaden ancestor grants");
    }
  }
  private assertDescendantModels(
    parent: Entry,
    profile: Profile,
    effective: ModelSelection,
    explicit?: ModelSelection,
  ): void {
    if (
      !admittedModel(parent, effective) ||
      profile.models?.some((model) => !admittedModel(parent, model)) ||
      (profile.prewalk && !explicit && !admittedModel(parent, profile.prewalk))
    )
      throw new Error("Descendant cannot broaden ancestor model grants");
  }
  private assertActive(entry: Entry): void {
    let current: Entry | undefined = entry;
    while (current) {
      if (
        this.entry(current.state) !== current ||
        current.cancelled ||
        current.paused ||
        current.state.disposed ||
        this.closing
      )
        throw new Error("Delegating parent is no longer active");
      current = current.input.parent ? this.entry(current.input.parent) : undefined;
    }
  }
  /** Each action is bounded by its admission and fresh policy for the whole lineage. */
  private async authorize(
    ref: ChildRef,
    allows: (profile: Profile, index: number) => boolean,
    denial: string,
  ): Promise<void> {
    const lineage: Entry[] = [];
    let current: Entry | undefined = this.entry(ref);
    while (current) {
      this.assertActive(current);
      if (!allows(current.input.profile, lineage.length)) throw new Error(denial);
      lineage.push(current);
      current = current.input.parent ? this.entry(current.input.parent) : undefined;
    }
    for (const [index, entry] of lineage.entries()) {
      const { profile } = await resolveProfile(
        entry.input.profile.name,
        entry.input.context.cwd,
        entry.input.context.isProjectTrusted(),
        undefined,
        entry.input.availableSkills?.() ?? entry.input.skills,
      );
      if (!allows(profile, index)) throw new Error(denial);
    }
    // Policy loading yields: cancellation, pause, shutdown and generation changes win.
    this.assertActive(lineage[0]);
  }
  private effectiveCapabilities(
    profile: Profile,
    source: Pick<StartTask, "context" | "toolMetadata">,
    cwd: string,
  ) {
    const callable = new Set(source.context.tools.map((tool) => tool.name));
    const capabilityDenials: CapabilityDenial[] = [];
    const leafTools: string[] = [];
    const leafProvenance: Record<string, string> = {};
    if (profile.name === "general") {
      const metadata = source.toolMetadata?.() ?? [];
      const sameWorkspace = cwd === resolveWorkspace(undefined, source.context.cwd);
      for (const tool of metadata) {
        if (profile.tools.includes(tool.name as BuiltinTool)) continue;
        const reason = !callable.has(tool.name)
          ? "tool is not live callable"
          : leafDenial(tool, profile.leafTools ?? [], sameWorkspace);
        if (reason) capabilityDenials.push({ name: tool.name, reason });
        else {
          leafTools.push(tool.name);
          leafProvenance[tool.name] = toolProvenance(tool);
        }
      }
      for (const name of profile.leafTools ?? [])
        if (!metadata.some((tool) => tool.name === name))
          capabilityDenials.push({ name, reason: "tool metadata unavailable" });
    }
    return {
      profile: { ...profile, leafTools, tools: profile.tools.filter((name) => callable.has(name)) },
      capabilityDenials,
      leafProvenance,
    };
  }
  async authorizeSpawn(
    ref: ChildRef,
    profile: Profile,
    model?: ModelSelection,
    source?: Pick<StartTask, "context" | "toolMetadata" | "cwd">,
  ): Promise<void> {
    const parent = this.entry(ref);
    this.assertDescendantModels(
      parent,
      profile,
      model ??
        profile.model ?? {
          ...parent.state.model,
          effort: parent.state.effort as ModelSelection["effort"],
        },
      model,
    );
    // Compare effective capabilities, not unavailable configured ceilings.
    profile = this.effectiveCapabilities(
      profile,
      source ?? parent.input,
      resolveWorkspace(source?.cwd ?? parent.selection.cwd, (source ?? parent.input).context.cwd),
    ).profile;
    const roles = [profile.name];
    let current: Entry | undefined = this.entry(ref);
    while (current) {
      roles.push(current.input.profile.name);
      current = current.input.parent ? this.entry(current.input.parent) : undefined;
    }
    await this.authorize(
      ref,
      (grant, index) => !!grant.spawn?.includes(roles[index]) && !broadenedGrant(profile, grant),
      "Current or admitted ancestor spawn grant denied; descendant cannot broaden ancestor grants",
    );
  }
  async admit(
    inputs: StartTask[],
    replacement?: ChildRef,
    signal?: AbortSignal,
  ): Promise<ChildRef[]> {
    requireSupportedHost();
    for (const input of inputs)
      if (input.parent) await this.authorizeSpawn(input.parent, input.profile, input.model, input);
    signal?.throwIfAborted();
    for (const input of inputs) if (input.parent) this.assertActive(this.entry(input.parent));
    return this.admitAuthorized(inputs, replacement);
  }
  /** Whole-batch synchronous validation precedes registry insertion, disk setup or dispatch. */
  private admitAuthorized(inputs: StartTask[], replacement?: ChildRef): ChildRef[] {
    const previous = replacement ? this.entry(replacement) : undefined;
    inputs = inputs.map((input) => {
      const cwd = resolveWorkspace(
        input.cwd ??
          previous?.selection.cwd ??
          (input.parent ? this.entry(input.parent).selection.cwd : undefined),
        input.context.cwd,
      );
      if (previous && cwd !== previous.selection.cwd)
        throw new Error("Follow-up must retain its original workspace");
      if (typeof input.assertTools !== "function")
        throw new Error("Delegation requires a parent builtin provenance validator");
      const { profile, capabilityDenials, leafProvenance } = this.effectiveCapabilities(
        input.profile,
        input,
        cwd,
      );
      if (!profile.tools.length)
        throw new Error(
          `Profile ${profile.name} has no callable parent builtin tools; enable an allowed parent tool or choose a usable profile`,
        );
      input.assertTools(profile.tools);
      // Capture the admitted ceiling, but keep root/ancestor revocation live. A nested
      // task uses the root dispatcher context, not its immediate parent's SDK context.
      const inheritedCodemode = input.parent
        ? this.entry(input.parent).input.codemodeEnabled
        : undefined;
      const enabled =
        !!input.codemodeEnabled?.() &&
        (!input.parent || !!inheritedCodemode?.()) &&
        (!previous || !!previous.input.codemodeEnabled?.());
      const codemodeEnabled = () =>
        enabled && !!input.codemodeEnabled?.() && (!input.parent || !!inheritedCodemode?.());
      return { ...input, profile, cwd, capabilityDenials, leafProvenance, codemodeEnabled };
    });
    if (previous) {
      if (
        inputs.length !== 1 ||
        !previous.state.disposed ||
        !["idle", "parked"].includes(this.presence.get(previous.state.id) ?? "")
      )
        throw new Error("Assignment is not idle or parked");
      if (this.key(previous.input.parent) !== this.key(inputs[0].parent))
        throw new Error("Follow-up must retain its exact original parent generation");
      if (previous.state.generation >= MAX_GENERATIONS)
        throw new Error("Generation retention limit");
      const profile = inputs[0].profile;
      if (
        (previous.input.profile.models !== undefined && profile.models === undefined) ||
        profile.models?.some(
          (model) => !previous.input.profile.models?.some((grant) => sameSelection(model, grant)),
        )
      )
        throw new Error("Follow-up cannot broaden previous model grants");
      if (
        profile.name !== previous.input.profile.name ||
        broadenedGrant(profile, previous.input.profile)
      )
        throw new Error("Follow-up cannot broaden previous grants");
    }
    if (!inputs.length || inputs.length > this.policy.batch) throw new Error("Batch size limit");
    const selections = inputs.map((input) => this.validate(input));
    const validators = inputs.map((input) =>
      input.resultSchema === undefined ? undefined : resultValidator(input.resultSchema),
    );
    const limits = inputs.map((input) => {
      const maximum: ExecutionLimits = {
        deadlineMs: this.policy.deadlineMs,
        requests: this.policy.requests,
        tools: this.policy.tools,
        depth: this.policy.depth,
        spawns: this.policy.spawns,
      };
      if (input.parent) {
        const inherited = this.entry(input.parent).state.limits;
        for (const key of Object.keys(maximum) as (keyof ExecutionLimits)[])
          maximum[key] = Math.min(maximum[key], inherited[key]);
      }
      return narrowLimits(maximum, input.limits ?? {});
    });
    const queued = this.queue.size;
    this.assertQueueCapacity(inputs);
    const parents = new Map<Entry, number>();
    for (const input of inputs)
      if (input.parent) {
        const parent = this.entry(input.parent);
        parents.set(parent, (parents.get(parent) ?? 0) + 1);
      }
    for (const [parent, count] of parents) {
      if (parent.spawned + count > Math.min(this.policy.spawns, parent.state.limits.spawns))
        throw new Error("Delegation spawn limit");
      // Waiting sessions retain their permits: no lending or hidden overcommit. Refuse
      // nested waits that cannot start immediately instead of queuing a deadlock.
      if (queued || this.active().length + inputs.length > this.policy.concurrency)
        throw new Error("Nested capacity unavailable; no permit lending");
    }
    const entries = inputs.map((input, index) => {
      const selection = selections[index];
      let finish!: () => void;
      const done = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const entry: Entry = {
        validator: validators[index],
        input,
        selection,
        done,
        finish,
        spawned: previous?.spawned ?? 0,
        cancelled: false,
        callerId: input.callerId,
        state: {
          id: previous?.state.id ?? randomUUID(),
          generation: (previous?.state.generation ?? 0) + 1,
          parentGeneration: input.parent?.generation,
          parentId: input.parent?.id ?? this.parentId,
          depth: input.parent ? this.entry(input.parent).state.depth + 1 : 1,
          createdAt: Date.now(),
          endedAt: null,
          status: "queued",
          writerLease: false,
          limits: limits[index],
          toolCalls: 0,
          spawned: previous?.spawned ?? 0,
          window: 1,
          retainedContext: false,
          profile: input.profile.name,
          tools: [...input.profile.tools],
          leafTools: [...(input.profile.leafTools ?? [])],
          skills: [...input.profile.skills],
          capabilityDenials: input.capabilityDenials,
          cwd: selection.cwd,
          outcome: validators[index]
            ? { validation: "awaiting", attempts: 0, errors: [], finalized: false }
            : undefined,
          assignment: input.assignment,
          activity: "Queued for capacity",
          progress: "",
          result: "",
          disposed: false,
          model: { provider: selection.model!.provider, id: selection.model!.id },
          effort: selection.thinkingLevel ?? null,
          fallback: selection.fallback,
          prewalk: input.profile.prewalk
            ? {
                target: input.profile.prewalk,
                status: input.model
                  ? "suppressed-exact"
                  : sameSelection(input.profile.prewalk, {
                        provider: selection.model!.provider,
                        id: selection.model!.id,
                        effort: selection.thinkingLevel!,
                      })
                    ? "no-op"
                    : "armed",
              }
            : undefined,
          telemetry: { requests: null, tokens: null, cost: null, context: null },
        },
      };
      return entry;
    });
    for (const [parent, count] of parents) {
      parent.spawned += count;
      this.update(parent, { spawned: parent.spawned });
    }
    if (previous)
      this.history.set(this.key(previous.state), {
        state: structuredClone(previous.state),
        messages: previous.finalizedMessages ?? [],
      });
    for (const entry of entries) {
      this.entries.set(entry.state.id, entry);
      this.queue.add(entry);
      this.presence.set(entry.state.id, "active");
    }
    for (const entry of entries) {
      entry.timer = setTimeout(() => {
        this.limit(entry, "deadline");
      }, entry.state.limits.deadlineMs);
    }
    for (const entry of entries) if (!entry.state.disposed) this.update(entry, {});
    this.pump();
    return entries.map((entry) => ({ id: entry.state.id, generation: entry.state.generation }));
  }
  async start(input: StartTask): Promise<ChildRef> {
    const [ref] = await this.admit([input]);
    await this.entry(ref).setup;
    return ref;
  }
  renewalParent(ref: ChildRef): ChildRef | undefined {
    const parent = this.entry(ref).input.parent;
    if (parent) {
      const entry = this.entry(parent);
      if (entry.cancelled || entry.state.disposed || entry.state.status !== "running")
        throw new Error("Original parent generation is no longer active");
    }
    return parent && { id: parent.id, generation: parent.generation };
  }
  async renew(ref: ChildRef, input: StartTask, signal?: AbortSignal): Promise<ChildRef> {
    requireSupportedHost();
    const previous = this.entry(ref);
    if (previous.resettingFallback) throw new Error("Fallback reset is in progress");
    this.renewalParent(ref);
    const profile = intersectProfileGrants(input.profile, previous.input.profile);
    const retained =
      previous.state.prewalk && ["handed-off", "no-op"].includes(previous.state.prewalk.status)
        ? previous.state.prewalk.target
        : previous.input.model;
    const next = (
      await this.admit(
        [
          {
            ...input,
            model: retained ?? input.model,
            fallback: previous.input.fallback ?? input.fallback,
            profile,
            skills: input.skills.filter((skill) => profile.skills.includes(skill.filePath)),
            resultSchema:
              input.resultSchema === undefined ? previous.input.resultSchema : input.resultSchema,
            limits: narrowLimits(previous.state.limits, input.limits ?? {}),
          },
        ],
        ref,
        signal,
      )
    )[0];
    if (previous.state.prewalk && previous.state.prewalk.status !== "armed")
      this.update(this.entry(next), { prewalk: previous.state.prewalk });
    return next;
  }
  private assertQueueCapacity(inputs: StartTask[]): void {
    const slots = Math.max(0, this.policy.concurrency - this.active().length);
    if (Math.max(0, this.queue.size + inputs.length - slots) > this.policy.queue)
      throw new Error("Delegation queue capacity limit");
  }
  private pump(): void {
    if (this.closing) return;
    for (const entry of this.queue) {
      if (entry.cancelled || entry.state.disposed || entry.state.status !== "queued") continue;
      if (this.active().length >= this.policy.concurrency) break;
      this.queue.delete(entry);
      entry.state = {
        ...entry.state,
        status: "setup",
        activity: "Preparing SDK child",
      };
      entry.setup = entry.session
        ? Promise.resolve().then(() => {
            if (!entry.paused && !entry.cancelled) return entry.prompt!(entry.resumeText!);
          })
        : this.create(entry);
      this.update(entry, {});
      void entry.setup.catch(() => {});
    }
  }
  /** Mark the entire active subtree before aborting any SDK or releasing any permit. */
  private pause(ref: ChildRef): Promise<void> {
    const root = this.entry(ref);
    if (root.pauseDrain) return root.pauseDrain;
    const entries: Entry[] = [];
    const collect = (entry: Entry) => {
      if (entry.cancelled || entry.state.disposed || entry.paused) return;
      entries.push(entry);
      for (const child of this.children(entry)) collect(child);
    };
    collect(root);
    for (const entry of entries) {
      entry.paused = true;
      entry.recoveryAbort?.abort();
      this.presence.set(entry.state.id, "pausing");
      clearTimeout(entry.timer);
      this.queue.delete(entry);
    }
    for (const entry of entries)
      this.update(entry, {
        status: "pausing",
        pauseReason: entry === root ? "deadline" : "ancestor deadline",
        activity: "Deadline reached; aborting and draining before pause",
      });
    const drain = async (entry: Entry) => {
      await entry.setup?.catch(() => {});
      await entry.session?.abort();
      await entry.run;
    };
    // Start aborts concurrently: an ancestor may be awaiting its descendant's outcome.
    const drains = new Map(entries.map((entry) => [entry, drain(entry)]));
    const completions = new Map<Entry, Promise<void>>();
    const complete = (entry: Entry): Promise<void> => {
      const existing = completions.get(entry);
      if (existing) return existing;
      const completion = Promise.all([
        drains.get(entry),
        // Independently pausing children already own their abort and subtree drain.
        ...this.children(entry).map((child) =>
          drains.has(child) ? complete(child) : child.pauseDrain,
        ),
      ]).then(() => {
        if (entry.cancelled || this.closing || entry.state.disposed) return;
        this.presence.set(entry.state.id, "paused");
        this.update(entry, {
          status: "paused",
          writerLease: false,
          retainedContext: !!entry.session,
          activity: "Paused; explicitly resume to continue retained conversation",
        });
        entry.finish();
        this.pump();
      });
      completions.set(entry, completion);
      entry.pauseDrain = completion;
      return completion;
    };
    const paused = Promise.all(entries.map(complete)).then(() => {});
    return paused;
  }
  /** Root operator command only: no requests, budget replenishment, or deadline renewal. */
  async resetFallback(ref: ChildRef): Promise<void> {
    const entry = this.entry(ref);
    if (
      !entry.state.fallback ||
      !entry.sessionManager ||
      entry.resuming ||
      entry.resettingFallback ||
      entry.cancelled ||
      this.closing ||
      !(
        entry.state.status === "paused" ||
        (entry.state.disposed && ["settled", "failed"].includes(entry.state.status))
      )
    )
      throw new Error("Fallback reset requires an idle retained child");
    const assertResettable = () => {
      if (
        this.entries.get(ref.id) !== entry ||
        entry.cancelled ||
        this.closing ||
        entry.resuming ||
        this.presence.get(ref.id) === "stopped"
      )
        throw new Error("Fallback reset cancelled by stop, shutdown or identity replacement");
    };
    entry.resettingFallback = true;
    try {
      const { profile } = await resolveProfile(
        entry.input.profile.name,
        entry.input.context.cwd,
        entry.input.context.isProjectTrusted(),
        undefined,
        entry.input.availableSkills?.() ?? entry.input.skills,
      );
      assertResettable();
      const narrowed = intersectProfileGrants(profile, entry.input.profile);
      const chain = taskFallback({ ...entry.input, profile: narrowed });
      if (!chain) throw new Error("Fallback policy is no longer enabled");
      let current: Entry | undefined = entry;
      while (current) {
        const live = (
          await resolveProfile(
            current.input.profile.name,
            entry.input.context.cwd,
            entry.input.context.isProjectTrusted(),
            undefined,
            current.input.availableSkills?.() ?? current.input.skills,
          )
        ).profile;
        assertResettable();
        for (const target of chain)
          if (!admittedModel(current, target) || !allowsModel(live, target))
            throw new Error("Fallback reset cannot broaden admitted model grants");
        current = current.input.parent ? this.entry(current.input.parent) : undefined;
      }
      const fallback = {
        ...initialFallback(entry.input.context, chain),
        attempts: entry.state.fallback.attempts,
      };
      const selected = fallback.chain[fallback.index];
      const model = validateModelSelection(entry.input.context, selected);
      const auth = await entry.input.context.modelRegistry.getApiKeyAndHeaders(model);
      assertResettable();
      if (!auth.ok) throw new Error(auth.error);
      const session = entry.session;
      if (session) {
        entry.prepareModel?.(selected);
        await session.setModel(model);
        assertResettable();
        session.setThinkingLevel(selected.effort);
        if (session.thinkingLevel !== selected.effort) throw new Error("SDK coerced reset effort");
      } else {
        entry.sessionManager.appendModelChange(selected.provider, selected.id);
        entry.sessionManager.appendThinkingLevelChange(selected.effort);
      }
      entry.input.profile = { ...entry.input.profile, fallback: narrowed.fallback };
      entry.selection.model = model;
      entry.selection.thinkingLevel = selected.effort;
      entry.fallbackReset = true;
      const failed = entry.sessionManager
        .getBranch()
        .findLast((item) => item.type === "message" && item.message.role === "assistant");
      if (
        failed?.type === "message" &&
        failed.message.role === "assistant" &&
        failed.message.stopReason === "error"
      )
        entry.sessionManager.appendContextEdit(failed.id, null);
      entry.sessionManager.appendCustomEntry("subagent-fallback-reset", fallback);
      if (entry.state.disposed)
        entry.finalizedMessages = structuredClone(
          entry.sessionManager.buildSessionContext().messages,
        );
      this.update(entry, {
        fallback,
        model: { provider: selected.provider, id: selected.id },
        effort: selected.effort,
        retainedContext: true,
      });
    } finally {
      entry.resettingFallback = false;
    }
  }
  /** Continue a drained window without replacing the identity or SDK conversation. */
  async resume(ref: ChildRef, text: string): Promise<ChildRef> {
    requireSupportedHost();
    const entry = this.entry(ref);
    const completed =
      (entry.state.status === "settled" ||
        (entry.fallbackReset && entry.state.status === "failed")) &&
      entry.state.disposed;
    const eligible = entry.state.status === "paused" || completed;
    if (
      entry.resuming ||
      entry.resettingFallback ||
      !eligible ||
      entry.cancelled ||
      this.closing ||
      this.presence.get(ref.id) === "stopped"
    )
      throw new Error(
        "Resume requires a drained paused or completed conversation; stopped/failed identities and duplicate resume rejected",
      );
    if ((entry.state.window ?? 1) >= MAX_GENERATIONS)
      throw new Error("Resume window limit (64) reached");
    const assertResumable = () => {
      if (
        this.entries.get(ref.id) !== entry ||
        entry.state.generation !== ref.generation ||
        entry.cancelled ||
        this.closing ||
        this.presence.get(ref.id) === "stopped" ||
        (completed
          ? !(
              entry.state.status === "settled" ||
              (entry.fallbackReset && entry.state.status === "failed")
            )
          : entry.state.status !== "paused")
      )
        throw new Error("Resume cancelled by stop, shutdown or identity replacement");
      this.renewalParent(ref);
    };
    // Reserve before disk/policy/auth waits; every failure releases the reservation.
    entry.resuming = true;
    try {
      if (
        completed &&
        (!entry.sessionManager ||
          !entry.finalizedMessages?.length ||
          JSON.stringify(entry.sessionManager.buildSessionContext().messages) !==
            JSON.stringify(entry.finalizedMessages))
      )
        throw new Error("Resume unavailable: canonical conversation state was not retained");
      if (completed) {
        // SessionManager.open() can silently initialize missing/empty files. Never use that
        // fallback here: the retained tree AND its original persisted transcript must agree.
        try {
          const transcript = await fs.readFile(entry.state.transcript!, "utf8");
          assertResumable();
          const persisted = transcript
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line));
          const manager = entry.sessionManager!;
          if (
            JSON.stringify(persisted) !==
            JSON.stringify([manager.getHeader(), ...manager.getEntries()])
          )
            throw new Error("transcript differs from retained canonical entries");
        } catch (error) {
          throw new Error(
            `Resume unavailable: original transcript cannot be restored: ${String(error)}`,
          );
        }
      } else if (entry.prompted && !entry.session) {
        throw new Error("Resume unavailable: paused SDK conversation was not retained");
      }
      if (!text.trim()) throw new Error("Nonempty continuation text is required");
      const parent = this.renewalParent(ref);
      const input = entry.input;
      const policy = await resolveScheduling(input.context.cwd, input.context.isProjectTrusted());
      assertResumable();
      const limits = { ...entry.state.limits };
      for (const key of Object.keys(limits) as (keyof ExecutionLimits)[])
        limits[key] = Math.min(
          limits[key],
          policy[key],
          parent ? this.entry(parent).state.limits[key] : Infinity,
        );
      let current: Entry | undefined = entry;
      let descendant: Entry | undefined;
      let fallback = entry.state.fallback;
      if (fallback) {
        await this.revalidateExecutionFallback(entry);
        assertResumable();
        fallback = availableFallback(input.context, fallback, fallback.index);
        if (fallback.exhausted) throw new Error("Fallback exhausted; operator reset required");
      }
      const selected: ModelSelection = fallback
        ? fallback.chain[fallback.index]
        : {
            ...entry.state.model,
            effort: entry.state.effort as ModelSelection["effort"],
          };
      while (current) {
        const { profile } = await resolveProfile(
          current.input.profile.name,
          input.context.cwd,
          input.context.isProjectTrusted(),
          undefined,
          current.input.availableSkills?.() ?? current.input.skills,
        );
        assertResumable();
        if (
          (current.input.profile.models !== undefined && profile.models === undefined) ||
          !allowsModel(profile, selected) ||
          !admittedModel(current, selected)
        )
          throw new Error("Resume denied: current or admitted model policy revoked");
        if (descendant && !profile.spawn?.includes(descendant.input.profile.name))
          throw new Error("Resume denied: ancestor spawn role revoked");
        // Reject revoked grants instead of rebuilding an SDK tool/resource graph. This never
        // broadens the original admission and leaves the paused conversation recoverable.
        const revoked = broadenedGrant(input.profile, profile);
        if (revoked) throw new Error(`Resume denied: current ${revoked} grant revoked`);
        if (
          current === entry &&
          entry.state.prewalk?.status === "armed" &&
          (!profile.prewalk || !sameSelection(profile.prewalk, entry.state.prewalk.target))
        )
          throw new Error("Resume denied: prewalk grant revoked");
        descendant = current;
        current = current.input.parent ? this.entry(current.input.parent) : undefined;
      }
      validateModelSelection(input.context, selected);
      const auth = await input.context.modelRegistry.getApiKeyAndHeaders(
        validateModelSelection(input.context, selected),
      );
      assertResumable();
      if (!auth.ok) throw new Error(auth.error);
      if (entry.state.prewalk?.status === "armed") {
        const target = validateModelSelection(input.context, entry.state.prewalk.target);
        const targetAuth = await input.context.modelRegistry.getApiKeyAndHeaders(target);
        assertResumable();
        if (!targetAuth.ok) throw new Error(targetAuth.error);
      }
      input.assertTools(input.profile.tools);
      for (const name of [...input.profile.tools, ...(input.profile.leafTools ?? [])]) {
        if (!input.context.tools.some((tool) => tool.name === name))
          throw new Error(`Resume denied: admitted tool no longer callable: ${name}`);
        if (input.profile.leafTools?.includes(name)) {
          const metadata = input.toolMetadata?.().find((tool) => tool.name === name);
          if (
            !metadata ||
            leafDenial(
              metadata,
              input.profile.leafTools,
              entry.selection.cwd === resolveWorkspace(undefined, input.context.cwd),
            ) ||
            toolProvenance(metadata) !== input.leafProvenance?.[name]
          )
            throw new Error(`Resume denied: leaf capability revoked or reclassified: ${name}`);
        }
      }
      if (
        (entry.state.telemetry.requests ?? 0) >= limits.requests ||
        entry.state.toolCalls >= limits.tools ||
        entry.spawned > limits.spawns
      )
        throw new Error("Resume denied: cumulative execution budget exhausted");
      if (entry.state.depth > limits.depth)
        throw new Error("Resume denied: delegation depth limit");
      // Reuse the original admission's lineage and nested no-lending checks, without
      // admitting another task or charging another spawn.
      this.validateAdmission(
        input,
        selected,
        entry.state.prewalk?.status === "armed" ? undefined : selected,
      );
      const available = this.active().length < policy.concurrency;
      if (parent && (this.queue.size || !available))
        throw new Error("Nested capacity unavailable; no permit lending");
      const previousPolicy = this.policy;
      this.policy = policy;
      try {
        this.assertQueueCapacity([input]);
      } finally {
        this.policy = previousPolicy;
      }
      assertResumable();
      if (completed) {
        const { window, status, result, outcome, artifacts, error, endedAt } = entry.state;
        entry.state = {
          ...entry.state,
          completedWindows: [
            ...(entry.state.completedWindows ?? []),
            structuredClone({ window, status, result, outcome, artifacts, error, endedAt }),
          ],
          disposed: false,
          endedAt: null,
          outcome: entry.validator
            ? { validation: "awaiting", attempts: 0, errors: [], finalized: false }
            : undefined,
          artifacts: undefined,
          result: "",
          progress: "",
        };
        entry.selection.model = validateModelSelection(input.context, selected);
        entry.selection.thinkingLevel = selected.effort;
      }
      if (fallback) {
        entry.state = {
          ...entry.state,
          fallback,
          model: { provider: selected.provider, id: selected.id },
          effort: selected.effort,
        };
        entry.selection.model = validateModelSelection(input.context, selected);
        entry.selection.thinkingLevel = selected.effort;
      }
      this.policy = policy;
      entry.done = new Promise<void>((resolve) => {
        entry.finish = resolve;
      });
      entry.paused = false;
      entry.fallbackReset = false;
      this.presence.set(entry.state.id, "active");
      entry.pauseDrain = undefined;
      entry.resumeText =
        !entry.prompted && entry.resumeText ? entry.resumeText + "\n\n" + text : text;
      entry.run = undefined;
      this.queue.add(entry);
      this.update(entry, {
        status: "queued",
        pauseReason: undefined,
        error: undefined,
        limits,
        window: (entry.state.window ?? 1) + 1,
        activity: "Continuation queued for admission",
      });
      const window = entry.state.window;
      entry.timer = setTimeout(() => {
        if (entry.state.window === window) this.limit(entry, "deadline");
      }, limits.deadlineMs);
      this.pump();
      return { id: ref.id, generation: ref.generation };
    } finally {
      entry.resuming = false;
    }
  }
  private limit(entry: Entry, reason: string): void {
    if (
      entry.cancelled ||
      entry.state.disposed ||
      entry.state.limitReason ||
      ["settled", "failed", "cancelled"].includes(entry.state.status)
    )
      return;
    if (reason === "deadline") {
      void this.pause(entry.state);
      return;
    }
    this.update(entry, { limitReason: reason, error: `Execution limit: ${reason}` });
    void this.stop(entry.state);
  }
  private chargeToolCall(entry: Entry): void {
    if (entry.state.toolCalls >= entry.state.limits.tools) {
      this.limit(entry, "tools");
      throw new Error("Tool call limit");
    }
    this.update(entry, { toolCalls: entry.state.toolCalls + 1 });
  }
  private async revalidateExecutionFallback(entry: Entry): Promise<void> {
    const state = entry.state.fallback;
    if (!state) return;
    if (state.exhausted) throw new Error("Fallback exhausted; operator reset required");
    authorizeFallback(entry.input.context, state.chain);
    let current: Entry | undefined = entry;
    while (current) {
      const { profile } = await resolveProfile(
        current.input.profile.name,
        entry.input.context.cwd,
        entry.input.context.isProjectTrusted(),
        undefined,
        current.input.availableSkills?.() ?? current.input.skills,
      );
      if (
        current === entry &&
        JSON.stringify(profile.fallback) !== JSON.stringify(entry.input.profile.fallback)
      )
        throw new Error("Fallback configuration changed; operator reset required");
      for (const target of state.chain)
        if (!admittedModel(current, target) || !allowsModel(profile, target))
          throw new Error("Fallback model authorization revoked");
      current = current.input.parent ? this.entry(current.input.parent) : undefined;
    }
  }
  private async revalidateExecutionModel(
    entry: Entry,
    selected: ModelSelection,
    requirePrewalk: boolean,
  ): Promise<void> {
    const { input } = entry;
    let current: Entry | undefined = entry;
    while (current) {
      const policy = (
        await resolveProfile(
          current.input.profile.name,
          input.context.cwd,
          input.context.isProjectTrusted(),
          undefined,
          current.input.availableSkills?.() ?? current.input.skills,
        )
      ).profile;
      if (
        (current.input.profile.models !== undefined && policy.models === undefined) ||
        !allowsModel(policy, selected) ||
        !admittedModel(current, selected)
      )
        throw new Error("Current or admitted model policy denied selection");
      if (
        current === entry &&
        requirePrewalk &&
        (!policy.prewalk || !sameSelection(policy.prewalk, entry.state.prewalk!.target))
      )
        throw new Error("Current prewalk grant revoked");
      current = current.input.parent ? this.entry(current.input.parent) : undefined;
    }
    validateModelSelection(input.context, selected);
  }
  private assertExecutionTool(
    entry: Entry,
    name: string,
    builtin: boolean,
    signal?: AbortSignal,
  ): void {
    const { input, selection } = entry;
    this.assertActive(entry);
    signal?.throwIfAborted();
    if (builtin) input.assertTools([name]);
    else {
      const metadata = input.toolMetadata?.().find((tool) => tool.name === name);
      if (
        !metadata ||
        leafDenial(
          metadata,
          input.profile.leafTools ?? [],
          selection.cwd === resolveWorkspace(undefined, input.context.cwd),
        ) ||
        toolProvenance(metadata) !== input.leafProvenance?.[name]
      )
        throw new Error(`Leaf capability revoked or reclassified: ${name}`);
    }
    if (!input.context.tools.some((tool) => tool.name === name))
      throw new Error(`Admitted parent tool is no longer callable: ${name}`);
  }
  private chargeExecutionRequest(entry: Entry): void {
    const { input } = entry;
    validateModelSelection(input.context, {
      ...entry.state.model,
      effort: entry.state.effort as ModelSelection["effort"],
    });
    if (entry.cancelled || entry.paused || this.closing) throw new Error("Delegation cancelled");
    if ((entry.state.telemetry.requests ?? 0) >= entry.state.limits.requests) {
      this.limit(entry, "requests");
      throw new Error("Direct request limit");
    }
    this.update(entry, {
      telemetry: {
        ...entry.state.telemetry,
        requests: (entry.state.telemetry.requests ?? 0) + 1,
      },
    });
  }
  private observeExecutionMessage(entry: Entry, text: string): void {
    for (const message of this.coordinationMessages)
      if (
        message.recipient !== "root" &&
        this.key(message.recipient) === this.key(entry.state) &&
        text ===
          `Delegation message ${message.id} from ${message.sender === "root" ? "root" : this.key(message.sender)}: ${message.text}`
      )
        message.status = "delivered";
    this.notifyCoordination();
  }
  private create(entry: Entry): Promise<void> {
    const isClosing = () => this.closing;
    return createChildExecution(this.root, entry, {
      get closing() {
        return isClosing();
      },
      update: (patch, event) => this.update(entry, patch, event),
      revalidateFallback: () => this.revalidateExecutionFallback(entry),
      revalidateModel: (selected, requirePrewalk) =>
        this.revalidateExecutionModel(entry, selected, requirePrewalk),
      authorizeTool: (name, builtin) =>
        this.authorize(
          entry.state,
          (profile) =>
            builtin
              ? profile.tools.includes(name as BuiltinTool)
              : !!profile.leafTools?.includes(name),
          `Current capability grant revoked: ${name}`,
        ),
      assertTool: (name, builtin, signal) => this.assertExecutionTool(entry, name, builtin, signal),
      chargeRequest: () => this.chargeExecutionRequest(entry),
      chargeToolCall: () => this.chargeToolCall(entry),
      observeUserMessage: (text) => this.observeExecutionMessage(entry, text),
      drainDescendants: () => this.stopMany(this.children(entry).map((child) => child.state)),
      dispose: () => this.dispose(entry),
    });
  }
  private closeDescendantPresence(entry: Entry, completed = false): void {
    for (const child of this.entries.values())
      if (
        child.state.parentId === entry.state.id &&
        child.state.parentGeneration === entry.state.generation
      ) {
        // Ancestor completion closes live/paused descendants, but does not retire a
        // successful retained conversation. Explicit stop remains sticky.
        if (!(completed && child.state.disposed && child.state.status === "settled"))
          this.presence.set(child.state.id, "stopped");
        this.closeDescendantPresence(child, completed);
      }
  }
  private dispose(entry: Entry): void {
    if (entry.state.disposed) return;
    this.queue.delete(entry);
    clearTimeout(entry.timer);
    if (entry.session) entry.finalizedMessages = structuredClone(entry.session.messages);
    entry.recoveryAbort?.abort();
    entry.unsubscribe?.();
    entry.session?.dispose();
    // Retain the authoritative SessionManager and immutable evidence, not the SDK runtime graph.
    entry.unsubscribe = undefined;
    entry.session = undefined;
    entry.prepareModel = undefined;
    entry.prompt = undefined;
    entry.resumeText = undefined;
    entry.setup = undefined;
    entry.run = undefined;
    entry.pauseDrain = undefined;
    this.closeDescendantPresence(
      entry,
      entry.state.status === "settled" && !entry.cancelled && !this.closing,
    );
    this.presence.set(entry.state.id, entry.cancelled || this.closing ? "stopped" : "idle");
    this.update(entry, {
      disposed: true,
      retainedContext:
        !!entry.sessionManager &&
        (entry.state.status === "settled" ||
          (!!entry.state.fallback && entry.state.status === "failed" && !entry.cancelled)),
      endedAt: Date.now(),
      writerLease: false,
      outcome: entry.state.outcome ? { ...entry.state.outcome, finalized: true } : undefined,
    });
    entry.finish();
    this.pump();
  }
  private key(ref?: ChildRef): string {
    return ref ? `${ref.id}/${ref.generation}` : "root";
  }
  private async actor(
    ref: ChildRef | undefined,
    action: CoordinationAction,
  ): Promise<Entry | undefined> {
    if (this.closing) throw new Error("Parent shut down");
    if (!ref) return;
    const actor = this.entry(ref);
    if (actor.cancelled || actor.state.disposed || actor.state.status !== "running")
      throw new Error("Sender is no longer running");
    if (!actor.input.profile.coordination?.includes(action))
      throw new Error(`Coordination action denied: ${action}`);
    await this.authorize(
      ref,
      (profile) => !!profile.coordination?.includes(action),
      `Coordination action denied: ${action}`,
    );
    if (actor.state.status !== "running") throw new Error("Sender is no longer running");
    return actor;
  }
  private target(actor: Entry | undefined, ref: ChildRef): Entry {
    const target = this.entry(ref);
    // A selected action grants family addressing, never transcript/resource access.
    if (
      actor &&
      target !== actor &&
      !(
        target.state.parentId === actor.state.id &&
        target.state.parentGeneration === actor.state.generation
      ) &&
      !(
        actor.state.parentId === target.state.id &&
        actor.state.parentGeneration === target.state.generation
      ) &&
      !(
        actor.state.parentId === target.state.parentId &&
        actor.state.parentGeneration === target.state.parentGeneration
      )
    )
      throw new Error("Coordination target outside granted family");
    return target;
  }
  async inbox(actor?: ChildRef, signal?: AbortSignal): Promise<DelegationMessage[]> {
    const sender = await this.actor(actor, "inbox");
    if (sender) this.assertActive(sender);
    if (this.closing) throw new Error("Parent shut down");
    signal?.throwIfAborted();
    return this.takeInbox(actor);
  }
  async message(
    actor: ChildRef | undefined,
    target: ChildRef | undefined,
    text: string,
    mode: "inbox" | "steer" | "followUp" = "inbox",
    signal?: AbortSignal,
  ): Promise<DelegationMessage> {
    if (mode !== "inbox") requireSupportedHost();
    const sender = await this.actor(actor, "message");
    if (sender) this.assertActive(sender);
    if (this.closing) throw new Error("Parent shut down");
    signal?.throwIfAborted();
    if (typeof text !== "string" || !text.trim() || Buffer.byteLength(text) > MAX_MESSAGE_BYTES)
      throw new Error("Message requires 1–4096 UTF-8 bytes");
    if (!target && !sender) throw new Error("Root cannot message itself");
    const recipient = target ? this.target(sender, target) : undefined;
    if (!target && sender?.state.parentId !== this.parentId)
      throw new Error("Only direct children may message root");
    if (target && actor && this.key(target) === this.key(actor))
      throw new Error("Self messaging denied");
    const record: DelegationMessage = {
      id: randomUUID(),
      sender: actor ? { ...actor } : "root",
      recipient: target ? { ...target } : "root",
      text,
      mode,
      status: "accepted",
    };
    if (
      recipient &&
      (recipient.cancelled || recipient.state.disposed || recipient.state.status !== "running")
    )
      return { ...record, status: "not-running" };
    if (!target && mode !== "inbox") throw new Error("Root accepts inbox messages only");
    const key = this.key(target);
    const mailbox = this.mailboxes.get(key) ?? [];
    if (
      mailbox.length >= MAX_MAILBOX_MESSAGES ||
      this.coordinationMessages.length >= MAX_RETAINED_MESSAGES
    )
      throw new Error("Parent message retention/mailbox limit");
    this.coordinationMessages.push(record);
    mailbox.push(record);
    this.mailboxes.set(key, mailbox);
    this.notifyCoordination();
    if (mode !== "inbox") {
      try {
        const content = `Delegation message ${record.id} from ${this.key(actor)}: ${text}`;
        const disposition = await recipient!.session![mode](content);
        // The captured recipient/session is never looked up again by ID.
        if (record.status !== "delivered")
          record.status = disposition === "queued" ? "queued" : "handled";
      } catch (error) {
        record.status = "error";
        record.error = String(error);
      }
      this.notifyCoordination();
    }
    return structuredClone(record);
  }
  park(ref: ChildRef): void {
    if (this.closing) throw new Error("Parent shut down");
    const entry = this.entry(ref);
    this.renewalParent(ref);
    if (!entry.state.disposed || this.presence.get(ref.id) !== "idle")
      throw new Error("Park requires a disposed idle assignment; stop active work explicitly");
    this.presence.set(ref.id, "parked");
    this.update(entry, {});
  }
  async coordinateWait(
    actor: ChildRef | undefined,
    target: ChildRef | undefined,
    timeoutMs: number,
    signal?: AbortSignal,
    messageId?: string,
  ): Promise<CoordinationWait> {
    const sender = await this.actor(actor, "wait");
    if (sender) this.assertActive(sender);
    if (signal?.aborted) return { status: "cancelled" };
    if (this.closing) return { status: "shutdown" };
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_WAIT_MS)
      throw new Error("Wait timeout must be 1–60000ms");
    if (this.waiterCount >= MAX_WAITERS) throw new Error("Parent waiter limit");
    if (target && messageId) throw new Error("Wait selects either an outcome or message receipt");
    const receipt = messageId
      ? this.coordinationMessages.find((message) => message.id === messageId)
      : undefined;
    if (
      messageId &&
      (!receipt ||
        (this.key(receipt.sender === "root" ? undefined : receipt.sender) !== this.key(actor) &&
          this.key(receipt.recipient === "root" ? undefined : receipt.recipient) !==
            this.key(actor)))
    )
      throw new Error("Unknown or foreign message receipt");
    const destination = target ? this.target(sender, target) : undefined;
    const pendingReceipt =
      receipt && !["delivered", "handled", "error", "not-running"].includes(receipt.status);
    if (sender && pendingReceipt && receipt.recipient === "root")
      throw new Error("Waiting for a pending root receipt with a retained permit is unsupported");
    const recipientRef = receipt?.recipient === "root" ? undefined : receipt?.recipient;
    const receiptEntry = recipientRef ? this.entries.get(recipientRef.id) : undefined;
    const dependency =
      destination ??
      (pendingReceipt && receiptEntry?.state.generation === recipientRef?.generation
        ? receiptEntry
        : undefined);
    const sourceKey = this.key(actor),
      targetKey = dependency ? this.key(dependency.state) : this.key(target);
    if (sender && dependency) {
      if (sender === dependency) throw new Error("Self wait denied");
      let ancestor: Entry | undefined = sender;
      while (ancestor) {
        if (ancestor === dependency) throw new Error("Ancestor wait would deadlock");
        ancestor = this.entries.get(ancestor.state.parentId);
      }
      if (dependency.state.status === "queued")
        throw new Error("Wait on queued work with retained permit is unsupported");
      const reaches = (key: string, seen = new Set<string>()): boolean => {
        if (key === sourceKey) return true;
        if (seen.has(key)) return false;
        seen.add(key);
        const children = [...this.entries.values()]
          .filter(
            (entry) =>
              !entry.state.disposed &&
              entry.state.parentGeneration !== undefined &&
              `${entry.state.parentId}/${entry.state.parentGeneration}` === key,
          )
          .map((entry) => this.key(entry.state));
        return [...(this.waits.get(key) ?? []), ...children].some((next) => reaches(next, seen));
      };
      if (reaches(targetKey)) throw new Error("Coordination wait cycle");
    }
    const edges = this.waits.get(sourceKey) ?? new Set<string>();
    if (dependency && edges.has(targetKey)) throw new Error("Duplicate active wait");
    if (dependency) {
      edges.add(targetKey);
      this.waits.set(sourceKey, edges);
    }
    this.waiterCount++;
    return new Promise<CoordinationWait>((resolve) => {
      let finished = false;
      const finish = (value: CoordinationWait) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        this.coordinationListeners.delete(check);
        signal?.removeEventListener("abort", abort);
        if (dependency) {
          edges.delete(targetKey);
          if (!edges.size) this.waits.delete(sourceKey);
        }
        this.waiterCount--;
        resolve(value);
      };
      const check = () => {
        if (this.closing) return finish({ status: "shutdown" });
        if (
          sender &&
          (sender.cancelled ||
            sender.paused ||
            sender.state.disposed ||
            this.entries.get(sender.state.id) !== sender)
        )
          return finish({ status: "cancelled" });
        if (receipt) {
          if (["delivered", "handled", "error", "not-running"].includes(receipt.status))
            return finish({ status: "message", message: structuredClone(receipt) });
          if (receipt.recipient !== "root") {
            const recipient = this.entries.get(receipt.recipient.id);
            if (
              !recipient ||
              recipient.state.generation !== receipt.recipient.generation ||
              recipient.state.disposed ||
              recipient.cancelled
            )
              return finish({
                status: "message",
                message: { ...structuredClone(receipt), status: "not-running" },
              });
          }
        } else if (destination) {
          if (destination.state.disposed || destination.state.status === "paused")
            return finish({
              status: "outcome",
              outcome: {
                id: destination.state.id,
                generation: destination.state.generation,
                status: destination.state.status,
                limitReason: destination.state.limitReason,
                ...(destination.state.pauseReason
                  ? { pauseReason: destination.state.pauseReason }
                  : {}),
              },
            });
        } else if ((this.mailboxes.get(sourceKey)?.length ?? 0) > 0)
          return finish({ status: "messages", messages: this.takeInbox(actor) });
      };
      const abort = () => finish({ status: "cancelled" });
      const timer = setTimeout(() => finish({ status: "timeout" }), timeoutMs);
      this.coordinationListeners.add(check);
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      else check();
    });
  }
  private takeInbox(actor?: ChildRef): DelegationMessage[] {
    const key = this.key(actor),
      messages = this.mailboxes.get(key) ?? [];
    this.mailboxes.delete(key);
    for (const message of messages) if (message.mode === "inbox") message.status = "delivered";
    this.notifyCoordination();
    return structuredClone(messages);
  }
  async taskInputRead(ref: ChildRef, signal?: AbortSignal): Promise<void> {
    await this.authorize(
      ref,
      (profile) => profile.tools.includes("read"),
      "Delegating parent has no active read grant",
    );
    const entry = this.entry(ref);
    this.assertActive(entry);
    signal?.throwIfAborted();
    this.chargeToolCall(entry);
  }
  async steer(ref: ChildRef, text: string): Promise<"queued" | "handled"> {
    requireSupportedHost();
    const entry = this.entry(ref);
    if (!text.trim()) throw new Error("Nonempty steering text is required");
    if (entry.state.status !== "running" || entry.cancelled) throw new Error("No running child");
    return entry.session!.steer(text);
  }
  private children(entry: Entry): Entry[] {
    return [...this.entries.values()].filter(
      (child) =>
        child.state.parentId === entry.state.id &&
        child.state.parentGeneration === entry.state.generation &&
        !child.state.disposed,
    );
  }
  async stopMany(refs: readonly ChildRef[]): Promise<void> {
    const entries = refs.map((ref) => this.entry(ref));
    // Mark the whole cancellation set before any disposal can dequeue a sibling.
    for (const entry of entries) if (!entry.state.disposed) entry.cancelled = true;
    await Promise.all(entries.map((entry) => this.stop(entry.state)));
  }
  async stop(ref: ChildRef): Promise<void> {
    const entry = this.entry(ref);
    this.presence.set(entry.state.id, "stopped");
    this.closeDescendantPresence(entry);
    this.notifyCoordination();
    if (entry.state.disposed) return;
    entry.cancelled = true;
    entry.recoveryAbort?.abort();
    if (entry.state.status === "queued") {
      this.update(entry, { status: "cancelled", activity: "Cancelled before setup" });
      this.dispose(entry);
      return;
    }
    this.update(entry, { status: "draining", activity: "Cancelling and draining" });
    // Start subtree cancellation without waiting for tools queued behind this session.
    const descendants = this.stopMany(this.children(entry).map((child) => child.state));
    await entry.setup?.catch(() => {});
    await Promise.all([descendants, entry.state.disposed ? undefined : entry.session?.abort()]);
    if (entry.state.disposed) return;
    await entry.run;
    if (!entry.state.disposed) this.update(entry, { status: "cancelled" });
    this.dispose(entry);
  }
  async wait(ref: ChildRef): Promise<ChildSnapshot> {
    const entry = this.entry(ref);
    await entry.done;
    return structuredClone(entry.state);
  }
  /** Detached public SDK transcript for one admitted generation; no replay or arbitrary file access. */
  messages(ref: ChildRef): AgentSession["messages"] {
    const historical = this.history.get(this.key(ref));
    if (historical) return structuredClone(historical.messages);
    const entry = this.entry(ref);
    return structuredClone(entry.session?.messages ?? entry.finalizedMessages ?? []);
  }
  reopenTranscript(ref: ChildRef) {
    const path = this.snapshot(ref)?.transcript;
    if (!path) throw new Error("No transcript yet");
    return SessionManager.open(path).buildSessionContext();
  }
  shutdown(): Promise<void> {
    this.closing = true;
    this.notifyCoordination();
    this.shutdownPromise ??= (async () => {
      await Promise.all(this.list().map((ref) => this.stop(ref)));
      this.listeners.clear();
    })();
    return this.shutdownPromise;
  }
}
