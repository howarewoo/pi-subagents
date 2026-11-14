import { requireSupportedHost } from "./supported-host.ts";
import { createProfileViewer, resolvedProfiles, profileToolPolicy } from "./profile-viewer.ts";
import { Text, truncateToWidth } from "@earendil-works/pi-tui";
import { EFFORTS, sameSelection } from "./model-policy.ts";
import { clippedText } from "./outcomes.ts";
import { readTaskInput } from "./task-input.ts";
import { resolveWorkspace } from "./workspace.ts";
import { join } from "node:path";
import { parameters, coordinationParameters, compatibleParameters } from "./tool-schemas.ts";
import {
  truncateHead,
  type ExtensionToolContext,
  type ToolDefinition,
  type ToolRenderers,
  type ExtensionAPI,
  type BuildSystemPromptOptions,
} from "@earendil-works/pi-coding-agent";
import { resolveScheduling } from "./scheduling.ts";
import {
  DelegationCoordinator,
  type ChildRef,
  type ChildSnapshot,
  type StartTask,
} from "./coordinator.ts";
import { resolveProfile, bundledProfiles, intersectProfileGrants } from "./profiles.ts";
import { createHub } from "./hub.ts";
import { createChildWidget } from "./subagent-widget.ts";
import { taskCard } from "./task-presentation.ts";
import { safe } from "./thread.ts";

const FOREGROUND_UPDATE_MS = 50;

export default function delegation(pi: ExtensionAPI) {
  let coordinator: DelegationCoordinator;
  let closing = false;
  let parentPromptOptions: BuildSystemPromptOptions | undefined;
  const availableSkills = () => parentPromptOptions?.skills ?? [];
  pi.on("before_agent_start", (event) => {
    parentPromptOptions = event.systemPromptOptions;
  });
  let renderWidget: (() => void) | undefined;
  let unsubscribeWidget: (() => void) | undefined;
  const ref = (args: string): ChildRef => {
    const [id, generation] = args.trim().split(/\s+/);
    if (!id || !Number.isSafeInteger(Number(generation)))
      throw new Error("Expected <task-id> <generation>");
    return { id, generation: Number(generation) };
  };
  const taskSnapshots = (value: unknown) =>
    (Array.isArray(value) ? value : [value]).filter(
      (item): item is ChildSnapshot =>
        !!item &&
        typeof item === "object" &&
        "id" in item &&
        "generation" in item &&
        "status" in item,
    );
  const preview = (value: unknown, transcript?: string) => {
    const snapshots = taskSnapshots(value);
    const references = snapshots.map((state) => ({
      id: state.id,
      generation: state.generation,
      status: state.status,
      transcript: state.transcript,
      artifacts: state.artifacts,
    }));
    const text = JSON.stringify(
      value,
      (key, item) => {
        if (
          ["result", "assignment", "activity", "progress", "error"].includes(key) &&
          typeof item === "string"
        )
          return clippedText(item);
        if (key === "value") return clippedText(JSON.stringify(item));
        return item;
      },
      2,
    );
    const clipped = truncateHead(
      (references.length
        ? `References: ${JSON.stringify(references)}\n`
        : transcript
          ? `Transcript: ${transcript}\n`
          : "") + text,
    );
    return `${clipped.content}${clipped.truncated ? "\n[Preview truncated; inspect full artifact/transcript references or subagent-status for one identity]" : ""}`;
  };
  const compatible = (state: ChildSnapshot) => ({
    ...state,
    taskId: state.id,
    id: `${state.id}@${state.generation}`,
  });
  pi.registerMessageRenderer("delegation", (message, options, theme) => {
    const notice = (message.details as { taskNotice?: unknown } | undefined)?.taskNotice;
    if (!notice || typeof notice !== "object") return undefined;
    const { collapsed, expanded } = notice as { collapsed?: unknown; expanded?: unknown };
    if (
      !Array.isArray(collapsed) ||
      !Array.isArray(expanded) ||
      !collapsed.length ||
      ![...collapsed, ...expanded].every((line) => typeof line === "string")
    )
      return undefined;
    const lines = options.expanded
      ? expanded
      : [...collapsed, options.keyHint("app.tools.expand", "to expand")];
    return new Text(
      lines.map((line) => theme.fg("text", safe(line))).join("\n"),
      options.outputPad,
      0,
    );
  });
  const show = (value: unknown, transcript?: string, wake = false) => {
    const snapshots = taskSnapshots(value);
    pi.sendMessage(
      {
        customType: "delegation",
        content: preview(value, transcript),
        display: true,
        ...(snapshots.length
          ? {
              details: {
                taskNotice: {
                  collapsed: snapshots.flatMap((child) => taskCard(child)),
                  expanded: snapshots.flatMap((child) => taskCard(child, true)),
                },
              },
            }
          : {}),
      },
      wake ? { triggerTurn: true, deliverAs: "followUp" } : undefined,
    );
  };
  pi.on("session_start", (_event, ctx) => {
    coordinator = new DelegationCoordinator(
      join(ctx.sessionManager.getSessionDir(), "delegation", ctx.sessionManager.getSessionId()),
      ctx.sessionManager.getSessionId(),
    );
    unsubscribeWidget = coordinator.subscribe((event) => {
      renderWidget?.();
      pi.events.emit("delegation:registry", event);
    });
    if (ctx.mode !== "tui") return;
    ctx.ui.setWidget(
      "delegation",
      (tui, theme) => {
        renderWidget = () => tui.requestRender();
        return createChildWidget(
          () => coordinator.sessions(),
          theme,
          () => tui.terminal.rows,
        );
      },
      { placement: "aboveEditor" },
    );
  });
  pi.on("session_shutdown", async (_event, ctx) => {
    closing = true;
    renderWidget = undefined;
    if (ctx.mode === "tui") ctx.ui.setWidget("delegation", undefined);
    await coordinator?.shutdown();
    unsubscribeWidget?.();
  });
  const assertTools = (names: readonly string[]) => {
    for (const name of names) {
      const tool = pi.getAllTools().find((tool) => tool.name === name);
      if (!tool || tool.sourceInfo.path !== `builtin:${name}`)
        throw new Error(`Delegation requires an unmodified built-in parent tool: ${name}`);
    }
  };
  const codemodeEnabled = () =>
    pi.getActiveTools().includes("codemode") &&
    pi
      .getAllTools()
      .some(
        (tool) => tool.name === "codemode" && tool.exposure === "model-only" && !!tool.reachesTools,
      );
  const taskTool = (
    parent?: ChildRef,
    rootContext?: ExtensionToolContext,
    rootCallerId?: string,
    compatibility = false,
  ): ToolDefinition<typeof parameters> => ({
    name: "delegate_task",
    label: "Delegate task",
    exposure: "model-only",
    promptSnippet: "Delegate coding, review or research to native subagents in supplied workspaces",
    promptGuidelines: [
      "Use delegate_task for authorized native delegation with explicit profiles. When subagent is available, prefer subagent for orchestration task owners. Native background and subagent async calls both wake this session after drain; continue independent work or yield, never poll. Supply the existing task workspace cwd; do not substitute inline implementation when a workflow requires a worker.",
    ],
    description:
      "Delegate one assignment or a fully preflighted ordered tasks batch on the selected parent model by default. Optional exact model {provider,id,effort} requires an operator profile models grant and stays exact, suppressing inherited role prewalk; models may only narrow that grant list. No aliases/coercion. Operator profile fallback chains start at their own primary regardless of the parent model. An explicit task model stays pinned unless fallback:true opts into the profile chain; fallback:false disables it. Fallback cannot combine with prewalk. Configured role-default prewalk switches once after first edit/write, not a repository scan. Coding workers are supported through implementation; advisor/probes/speculation/history/executable resource inheritance remain unavailable. Optional cwd selects an existing workspace: root hooks see explicitly resolved builtin paths and a cwd-prefixed shell command; this is not sandboxing or transparent hook-cwd rebinding. Role tools are ceilings intersected with callable parent builtins; inactive tools stay inactive. Snapshots report effective tools. Bounded FIFO capacity; writers and parent tools may run together. Caller coordinates shared writes, including manual !/!! and external edits; no isolation or conflict prevention. Foreground waits without an extra completion notice; background delivers one ordered batch outcome after actual drain and wakes the parent (or queues a follow-up if busy), potentially adding model turns/costs. Nested foreground only, explicit spawn grants and available capacity required. Limits may only narrow operator policy. Supply exactly one inline assignment or taskFile (explicit non-hidden workspace-relative UTF-8 file, at most 50000 bytes, checked through parent read hooks). Optional resultSchema requires child submit_result; prose is never validated output. Previews are bounded; full result artifacts and transcripts retained after drain.",
    parameters,
    renderCall(args, theme) {
      return {
        render: (width) =>
          [
            theme.fg(
              "toolTitle",
              `Delegate · ${"tasks" in args ? `batch ${args.tasks?.length ?? 0}` : safe(args.profile ?? "profile pending")} · ${args.background ? "background" : "foreground"}`,
            ),
            safe(
              "tasks" in args
                ? "Ordered batch · expand results for each identity"
                : (args.assignment ?? args.taskFile ?? "Receiving assignment…"),
            ).replaceAll("\n", " "),
          ].map((line) => truncateToWidth(line, Math.max(0, width))),
        invalidate() {},
      };
    },
    renderResult(result, options, theme, context) {
      const stored = result.details as ChildSnapshot | { children: ChildSnapshot[] } | undefined;
      const children =
        stored && "children" in stored ? stored.children : stored && "id" in stored ? [stored] : [];
      return {
        render(width) {
          const lines = children.length
            ? children.flatMap((snapshot) => {
                let child = snapshot;
                try {
                  child = coordinator?.snapshot(snapshot) ?? snapshot;
                } catch {
                  /* delivered snapshots survive runtime replacement */
                }
                return taskCard(child, options.expanded);
              })
            : [
                safe(
                  result.content
                    .filter((block) => block.type === "text")
                    .map((block) => block.text)
                    .join("\n"),
                ),
              ];
          if (children.length && !options.expanded)
            lines.push(context.keyHint("app.tools.expand", "to expand"));
          return new Text(lines.map((line) => theme.fg("text", line)).join("\n"), 0, 0).render(
            width,
          );
        },
        invalidate() {},
      };
    },
    async execute(callerId, args, signal, onUpdate, localContext) {
      requireSupportedHost();
      const ctx = rootContext ?? localContext;
      const owner = coordinator;
      if (parent && args.background)
        throw new Error("Nested background delegation is unsupported; use foreground");
      const policy = await resolveScheduling(ctx.cwd, ctx.isProjectTrusted());
      owner.configure(policy);
      const items = "tasks" in args ? args.tasks : [args];
      const inputs: StartTask[] = [];
      for (const task of items) {
        if ((task.assignment === undefined) === (task.taskFile === undefined))
          throw new Error("Supply exactly one of assignment or taskFile");
        const cwd = resolveWorkspace(
          task.cwd ?? (parent ? owner.snapshot(parent)?.cwd : undefined),
          ctx.cwd,
        );
        let { profile, skills } = await resolveProfile(
          task.profile,
          ctx.cwd,
          ctx.isProjectTrusted(),
          undefined,
          availableSkills(),
        );
        if (task.spawn) {
          if (task.spawn.some((role) => !profile.spawn?.includes(role)))
            throw new Error("Request cannot mint spawn grants");
          profile = { ...profile, spawn: task.spawn };
        }
        if (task.coordination) {
          if (task.coordination.some((action) => !profile.coordination?.includes(action)))
            throw new Error("Request cannot mint coordination grants");
          profile = { ...profile, coordination: task.coordination };
        }
        if (task.models) {
          if (
            task.models.some(
              (selection) => !profile.models?.some((grant) => sameSelection(grant, selection)),
            )
          )
            throw new Error("Request cannot mint model grants");
          profile = { ...profile, models: task.models };
        }
        signal?.throwIfAborted();
        let text = task.assignment;
        if (task.taskFile !== undefined) {
          assertTools(["read"]);
          text = await readTaskInput(
            task.taskFile,
            ctx,
            signal,
            parent
              ? async () => {
                  await owner.authorizeSpawn(parent, profile, task.model, {
                    context: ctx,
                    toolMetadata: () => pi.getAllTools(),
                    cwd,
                  });
                  await owner.taskInputRead(parent, signal);
                }
              : undefined,
            cwd,
          );
        }
        inputs.push({
          cwd,
          model: task.model,
          fallback: task.fallback,
          assignment: text!,
          resultSchema: task.resultSchema,
          profile,
          skills,
          context: ctx,
          assertTools,
          toolMetadata: () => pi.getAllTools(),
          codemodeEnabled,
          availableSkills,
          callerId: rootCallerId ?? callerId,
          parent,
          limits: task.limits,
          coordinationTools: (actor) => [coordinationTool(owner, actor)],
          nestedTool: (ref: ChildRef) => taskTool(ref, ctx, rootCallerId ?? callerId),
        });
      }
      signal?.throwIfAborted();
      const children = await owner.admit(inputs, undefined, signal);
      const stop = () =>
        parent && ["pausing", "paused"].includes(owner.snapshot(parent)!.status)
          ? Promise.resolve()
          : owner.stopMany(children);
      const abort = () => {
        void stop();
      };
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) await stop();
      const states = () => children.map((child) => owner.snapshot(child)!);
      const result = (snapshots: ChildSnapshot[]) => {
        if (compatibility) snapshots = snapshots.map(compatible);
        const value = "tasks" in args ? snapshots : snapshots[0];
        return {
          content: [
            {
              type: "text" as const,
              text: preview(value, snapshots.length === 1 ? snapshots[0].transcript : undefined),
            },
          ],
          details: "tasks" in args ? { children: snapshots } : snapshots[0],
          isError: snapshots.some(
            (state) => state.status === "failed" || state.status === "cancelled",
          ),
        };
      };
      const completed = Promise.all(children.map((child) => owner.wait(child)));
      if (args.background) {
        signal?.removeEventListener("abort", abort);
        void completed.then((snapshots) => {
          if (compatibility) snapshots = snapshots.map(compatible);
          if (!closing && coordinator === owner)
            show(
              "tasks" in args ? snapshots : snapshots[0],
              snapshots.length === 1 ? snapshots[0].transcript : undefined,
              true,
            );
        });
        return result(states());
      }
      // Only presentation deltas are coalesced; registry events and waits remain untouched.
      const statuses = new Map(onUpdate ? states().map((child) => [child.id, child.status]) : []);
      let updateTimer: ReturnType<typeof setTimeout> | undefined;
      const clearUpdate = () => {
        clearTimeout(updateTimer);
        updateTimer = undefined;
      };
      const flushUpdate = () => {
        clearUpdate();
        onUpdate?.(result(states()));
      };
      signal?.addEventListener("abort", clearUpdate, { once: true });
      const unsubscribe = onUpdate
        ? owner.subscribe((event) => {
            if (!statuses.has(event.child.id)) return;
            const transitioned = statuses.get(event.child.id) !== event.child.status;
            statuses.set(event.child.id, event.child.status);
            const delta =
              event.event?.type === "message_update" ||
              event.event?.type === "tool_execution_update";
            if (!delta || transitioned) flushUpdate();
            else if (updateTimer === undefined && !signal?.aborted)
              updateTimer = setTimeout(() => {
                try {
                  flushUpdate();
                } catch {
                  /* presentation observers remain isolated, including deferred updates */
                }
              }, FOREGROUND_UPDATE_MS);
          })
        : undefined;
      try {
        return result(await completed);
      } finally {
        unsubscribe?.();
        clearUpdate();
        signal?.removeEventListener("abort", clearUpdate);
        signal?.removeEventListener("abort", abort);
      }
    },
  });
  const coordinationTool = (
    owner?: DelegationCoordinator,
    actor?: ChildRef,
    compatibility = false,
  ): ToolDefinition<typeof coordinationParameters> => ({
    name: "delegate_coordinate",
    label: "Coordinate delegation",
    exposure: "model-only",
    description:
      "Live-parent identity-pinned coordination. message targets a running family agent (omit target for root inbox, direct children only); inbox reads own bounded mailbox; wait targets an outcome or own inbox with required 1–60000ms timeout, retaining capacity. No transcript access. Child actions require explicit operator grants. Root additionally has status/stop/park, paused/completed resume (assignment is the appended continuation), and idle followup/parked revive. Resume retains identity and full context, resets only the deadline window, and requires explicit child resumes after parent resume. Followup/revive create a fresh generation/session with current model/auth and narrowed current grants, no old tool replay or historical recovery. Successful root resume/followup/revive each send one outcome after actual drain and wake the parent (or queue a follow-up if busy), potentially adding model turns/costs. Rejections send none; no automatic resume or guaranteed task continuation. Message accepted/queued is NOT model acknowledgment; delivered means transcript/inbox visibility only. 4096-byte messages, 64 mailbox/waiters, 512 messages and 64 generations per live parent.",
    parameters: coordinationParameters,
    async execute(callerId, args, signal, _update, ctx) {
      if (["resume", "followup", "revive"].includes(args.action)) requireSupportedHost();
      const registry = owner ?? coordinator;
      signal?.throwIfAborted();
      let value: unknown;
      if (args.action === "message")
        value = await registry.message(actor, args.target, args.text, args.mode, signal);
      else if (args.action === "inbox") value = await registry.inbox(actor, signal);
      else if (args.action === "wait")
        value = await registry.coordinateWait(
          actor,
          args.target,
          args.timeoutMs,
          signal,
          args.messageId,
        );
      else {
        if (actor) throw new Error("Root-only coordination action");
        if (args.action === "stop") {
          await registry.stop(args.target);
          value = registry.snapshot(args.target);
        } else if (args.action === "park") {
          registry.park(args.target);
          value = registry.agents();
        } else if (args.action === "status")
          value = {
            snapshot: registry.snapshot(args.target),
            generations: registry.generations(args.target.id),
            agents: registry.agents(),
          };
        else if (args.action === "resume") {
          const next = await registry.resume(args.target, args.assignment);
          value = registry.snapshot(next);
          // Each continuation owns exactly one notification for its new window.
          void registry.wait(next).then((state) => {
            if (!closing && coordinator === registry)
              show(compatibility ? compatible(state) : state, state.transcript, true);
          });
        } else if (args.action === "followup" || args.action === "revive") {
          const presence = registry
            .agents()
            .find(
              (state) => state.id === args.target.id && state.generation === args.target.generation,
            )?.presence;
          if (presence !== (args.action === "revive" ? "parked" : "idle"))
            throw new Error("Followup requires idle; revive requires parked current identity");
          const state = registry.snapshot(args.target)!;
          const parent = registry.renewalParent(args.target);
          registry.configure(await resolveScheduling(ctx.cwd, ctx.isProjectTrusted()));
          let { profile, skills } = await resolveProfile(
            state.profile,
            ctx.cwd,
            ctx.isProjectTrusted(),
            undefined,
            availableSkills(),
          );
          let ancestor = parent;
          let descendantRole = state.profile;
          while (ancestor) {
            const original = registry.snapshot(ancestor)!;
            const current = (
              await resolveProfile(
                original.profile,
                ctx.cwd,
                ctx.isProjectTrusted(),
                undefined,
                availableSkills(),
              )
            ).profile;
            if (!current.spawn?.includes(descendantRole))
              throw new Error("Current ancestor spawn role denied");
            profile = intersectProfileGrants(profile, current);
            descendantRole = original.profile;
            ancestor =
              original.parentGeneration === undefined
                ? undefined
                : { id: original.parentId, generation: original.parentGeneration };
          }
          signal?.throwIfAborted();
          const next = await registry.renew(
            args.target,
            {
              cwd: state.cwd,
              assignment: args.assignment,
              resultSchema: args.resultSchema,
              profile,
              skills,
              context: ctx,
              assertTools,
              toolMetadata: () => pi.getAllTools(),
              codemodeEnabled,
              availableSkills,
              callerId,
              parent,
              coordinationTools: (ref) => [coordinationTool(registry, ref)],
              nestedTool: (ref) => taskTool(ref, ctx, callerId),
            },
            signal,
          );
          value = registry.snapshot(next);
          void registry.wait(next).then((state) => {
            if (!closing && coordinator === registry) show(state, state.transcript, true);
          });
        }
      }
      return { content: [{ type: "text", text: preview(value) }], details: value };
    },
  });
  pi.registerTool(coordinationTool());
  const taskDefinition = taskTool();
  pi.registerTool(taskDefinition);
  const compatibleTaskDefinition = taskTool(undefined, undefined, undefined, true);
  pi.registerTool({
    name: "subagent",
    label: "Subagent",
    exposure: "model-only",
    promptSnippet:
      "Native coding workers: launch, coordinate and resume work in existing task workspaces",
    promptGuidelines: [
      "Use subagent for native worker delegation requested by the user or an active workflow; no extension-specific user instruction or enable call is needed. Use agent worker for implementation, scout for research, review for review, or general for restricted inherited capabilities.",
      "Pass subagent the approved task handoff and existing workspace cwd. Preserve selected model routing; no model override is needed to inherit the parent. Pass accessible skill/reference paths in the task; general inherits available skills and callable builtins, plus operator-reviewed leaf tools only; parent instructions/history and project trust are not inherited.",
      "subagent launches are async by default and wake this session after actual drain. Continue independent work or yield; do not poll or sleep. Use the exact returned id (UUID@generation) for status, steer, stop or resume. Resume continues a drained paused or completed conversation with its same identity/generation, full SDK context and cumulative budgets; unavailable context and stopped/failed identities reject. Use explicit delegate_coordinate followup/revive for fresh completed work.",
    ],
    description:
      "Native delegation for orchestration and coding task owners. Launch {agent,task,cwd?,model?,async?} or an ordered {tasks:[...],async?,cwd?} batch. worker maps explicitly to the implementation profile; unknown/custom agent names reject. Model strings require exact provider/id[:effort] and operator grants. Actions: agents, list, status/stop with exact returned id, steer/resume with id and message. Resume requires a drained paused or completed session and restores its full conversation with the same identity/generation and session count; unavailable context and stopped/failed identities reject. Uses the same registry, parent permissions, limits and FIFO capacity as delegate_task. Writers and parent tools may run together; caller coordinates shared writes, with no isolation or collision prevention. Existing workspaces only: file paths and shell cwd are explicitly adapted through root builtin hooks. No automatic worktree creation/commits/apply/deletion, detached survival, script workflows or blanket competing API parity. Do not load another provider of the subagent tool alongside this extension.",
    parameters: compatibleParameters,
    async execute(callerId, args, signal, onUpdate, ctx) {
      if (!("action" in args) || args.action === "resume" || args.action === "steer")
        requireSupportedHost();
      const owner = coordinator;
      if (!("action" in args)) {
        const items = "tasks" in args ? args.tasks : [args];
        const tasks = items.map((task) => {
          let model = typeof task.model === "object" ? task.model : undefined;
          if (typeof task.model === "string") {
            const slash = task.model.indexOf("/");
            if (slash < 1 || slash === task.model.length - 1)
              throw new Error("Model strings require exact provider/id[:effort]");
            let id = task.model.slice(slash + 1);
            const colon = id.lastIndexOf(":");
            const effort =
              colon >= 0 ? EFFORTS.find((level) => level === id.slice(colon + 1)) : undefined;
            if (effort) id = id.slice(0, colon);
            model = {
              provider: task.model.slice(0, slash),
              id,
              effort: effort ?? ctx.thinkingLevel ?? "off",
            };
          }
          return {
            assignment: task.task,
            profile: task.agent === "worker" ? ("implementation" as const) : task.agent,
            cwd: task.cwd ?? args.cwd,
            model,
            limits: task.limits,
          };
        });
        // Internal reuse: the outer subagent call has its own public validation/hooks;
        // every executed builtin still traverses the original root dispatcher.
        return compatibleTaskDefinition.execute(
          callerId,
          "tasks" in args
            ? { tasks, background: args.async ?? true }
            : { ...tasks[0], background: args.async ?? true },
          signal,
          onUpdate,
          ctx,
        );
      }
      const result = (value: unknown) => ({
        content: [{ type: "text" as const, text: preview(value) }],
        details: value,
      });
      if (!("id" in args))
        return result(
          args.action === "agents"
            ? { agents: [...bundledProfiles(), { name: "worker", profile: "implementation" }] }
            : owner.list().map(compatible),
        );
      const match = /^([0-9a-f-]{36})@([1-9][0-9]*)$/.exec(args.id);
      if (!match || !Number.isSafeInteger(Number(match[2])))
        throw new Error("Use the exact subagent id returned by launch: UUID@generation");
      const target = { id: match[1], generation: Number(match[2]) };
      if (args.action === "status")
        return result({
          snapshot: compatible(owner.snapshot(target)!),
          generations: owner.generations(target.id).map(compatible),
        });
      signal?.throwIfAborted();
      if (args.action === "stop") await owner.stop(target);
      else if (args.action === "steer") await owner.steer(target, args.message);
      else if ("message" in args) {
        const response = await coordinationTool(undefined, undefined, true).execute(
          callerId,
          {
            action: "resume",
            target,
            assignment: args.message,
          },
          signal,
          undefined,
          ctx,
        );
        const next = response.details as ChildSnapshot;
        return result(compatible(next));
      }
      return result(compatible(owner.snapshot(target)!));
    },
  });
  pi.registerCommand("subagent-profiles", {
    description: "Subagent Profiles: inspect resolved workspace profiles (read-only)",
    handler: async (_args, ctx) => {
      const profiles = await resolvedProfiles(
        ctx.cwd,
        ctx.isProjectTrusted(),
        undefined,
        ctx.getSystemPromptOptions().skills ?? [],
      );
      if (ctx.mode !== "tui") {
        show({ toolPolicy: profileToolPolicy, profiles });
        return;
      }
      await ctx.ui.custom<void>(
        (tui, theme, keys, done) =>
          createProfileViewer(
            profiles,
            theme,
            keys,
            () => tui.requestRender(),
            () => done(),
            () => Math.max(1, Math.floor(tui.terminal.rows * 0.9)),
          ),
        { overlay: true, overlayOptions: { width: "90%", maxHeight: "90%", anchor: "center" } },
      );
    },
  });
  pi.registerCommand("subagent-status", {
    description: "List delegation identities, states and final results",
    handler: async (args) =>
      show(args.trim() ? coordinator.snapshot(ref(args)) : coordinator.list()),
  });
  pi.registerCommand("subagent-fallback-reset", {
    description:
      "Reset <task-id> <generation> fallback routing on an idle retained child; budgets and deadline unchanged",
    handler: async (args) => {
      await coordinator.resetFallback(ref(args));
    },
  });
  pi.registerCommand("subagent-stop", {
    description: "Stop <task-id> <generation> and drain it",
    handler: async (args) => {
      await coordinator.stop(ref(args));
    },
  });
  pi.registerCommand("subagent-steer", {
    description: "Steer <task-id> <generation> <text>",
    handler: async (args) => {
      const [id, generation, ...text] = args.trim().split(/\s+/);
      await coordinator.steer(ref(`${id} ${generation}`), text.join(" "));
    },
  });
  pi.registerCommand("subagent-hub", {
    description:
      "Subagent Hub: subagent roster, generation history, transcripts and pinned controls (TUI only)",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") return;
      await ctx.ui.custom<void>(
        (tui, theme, keys, done) =>
          createHub(
            coordinator,
            theme,
            keys,
            () => tui.requestRender(),
            () => done(),
            {
              tui,
              cwd: ctx.cwd,
              toolRenderers: {
                delegate_task: {
                  renderShell: taskDefinition.renderShell,
                  renderCall: taskDefinition.renderCall,
                  renderResult: taskDefinition.renderResult,
                } as ToolRenderers,
              },
            },
            () => Math.max(1, Math.floor(tui.terminal.rows * 0.9)),
          ),
        { overlay: true, overlayOptions: { width: "90%", maxHeight: "90%", anchor: "center" } },
      );
    },
  });
}
