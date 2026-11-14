import { isRetryableAssistantError } from "@earendil-works/pi-ai";
import { setTimeout as delay } from "node:timers/promises";
import {
  FALLBACK_RETRIES,
  availableFallback,
  terminalFallbackError,
  recoverableFallback,
} from "./model-fallback.ts";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  createAgentSession,
  createCodemodeExtension,
  createExtensionRuntime,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type AgentSessionEvent,
  type ExtensionToolContext,
  type ResourceLoader,
  type Skill,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { Validator } from "@earendil-works/pi-schema";
import { submissionParameters, saveOutcomeArtifact } from "./outcomes.ts";
import { validateModelSelection, type ModelSelection } from "./model-policy.ts";
import { parentModelRuntime, registerParentModels } from "./model-adapter.ts";
import { workspaceArguments } from "./workspace.ts";
import type { BuiltinTool } from "./profiles.ts";
import type { ChildSnapshot, StartTask } from "./delegation-types.ts";

/** Shared live execution fields; lifecycle ownership stays with the coordinator. */
export type ExecutionRecord = {
  validator?: Validator;
  input: StartTask;
  selection: { fallback?: ChildSnapshot["fallback"] } & Pick<
    ExtensionToolContext,
    "model" | "modelRegistry" | "scopedModels" | "thinkingLevel" | "cwd"
  >;
  state: ChildSnapshot;
  timer?: ReturnType<typeof setTimeout>;
  run?: Promise<void>;
  session?: AgentSession;
  /** Canonical entry tree survives runtime disposal; never substitute a result summary. */
  sessionManager?: SessionManager;
  resourcePrompt?: string;
  unsubscribe?: () => void;
  paused?: boolean;
  prompt?: (text: string) => Promise<void>;
  resumeText?: string;
  prompted?: boolean;
  cancelled: boolean;
  recoveryAbort?: AbortController;
  prepareModel?: (selected: ModelSelection) => void;
};

/** Operations bound to the exact admitted entry, never a later generation with its ID. */
export interface ExecutionOwner {
  readonly closing: boolean;
  update(patch: Partial<ChildSnapshot>, event?: AgentSessionEvent): void;
  revalidateFallback(): Promise<void>;
  revalidateModel(selected: ModelSelection, requirePrewalk: boolean): Promise<void>;
  authorizeTool(name: string, builtin: boolean): Promise<void>;
  assertTool(name: string, builtin: boolean, signal?: AbortSignal): void;
  chargeRequest(): void;
  chargeToolCall(): void;
  observeUserMessage(text: string): void;
  drainDescendants(): Promise<void>;
  dispose(): void;
}

export function childResources(prompt: string, skills: Skill[] = []): ResourceLoader {
  const extensions = { extensions: [], errors: [], runtime: createExtensionRuntime() };
  return {
    getExtensions: () => extensions,
    getSkills: () => ({ skills, diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () =>
      prompt +
      "\nYou are a delegated child. Complete only this assignment; use only explicitly granted tools and spawn roles.",
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [],
    getAppendSystemPromptSources: () => [],
    extendResources: () => {},
    reload: async () => {},
  };
}

export async function createChildExecution(
  root: string,
  entry: ExecutionRecord,
  owner: ExecutionOwner,
): Promise<void> {
  const { input, selection } = entry;
  try {
    await mkdir(root, { recursive: true });
    const taskDir = join(
      root,
      entry.state.generation === 1
        ? entry.state.id
        : `${entry.state.id}-g${entry.state.generation}`,
    );
    const restoring = !!entry.sessionManager;
    if (!restoring) await mkdir(taskDir, { mode: 0o700 }); // exclusive initial ownership
    const agentDir = join(taskDir, "agent");
    if (!restoring) await mkdir(agentDir, { mode: 0o700 });
    const transcriptDir = join(taskDir, "transcripts");
    if (!restoring) await mkdir(transcriptDir, { mode: 0o700 });
    // Each completed window publishes exclusively, leaving all earlier artifacts intact.
    const outcomeDir = restoring ? join(taskDir, `window-${entry.state.window}`) : taskDir;
    if (restoring) await mkdir(outcomeDir, { mode: 0o700 });
    const target =
      entry.state.prewalk?.status === "armed"
        ? validateModelSelection(input.context, entry.state.prewalk.target)
        : undefined;
    let policyError: string | undefined;
    let completedMutation = false;
    let pendingAttempt: number | undefined;
    let recoveryPrepared = false;
    entry.recoveryAbort = new AbortController();
    const settings = SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: {
        enabled: !!entry.state.fallback,
        maxRetries: FALLBACK_RETRIES,
        provider: { maxRetries: 0 },
      },
    });
    const waitForRetry = async (failures: number) => {
      await delay(Math.min(60000, 2000 * 2 ** Math.max(0, failures - 1)), undefined, {
        signal: entry.recoveryAbort!.signal,
      });
      // Native retries retain ownership of the remaining allowance after a quota
      // continuation, including a subsequent transient failure in that same episode.
      settings.applyOverrides({ retry: { maxRetries: Math.max(0, FALLBACK_RETRIES - failures) } });
    };
    const stopped = () =>
      entry.cancelled || entry.paused || owner.closing || entry.recoveryAbort!.signal.aborted;
    const selectFallback = async (start: number) => {
      await owner.revalidateFallback();
      if (stopped()) throw new Error("Delegation cancelled");
      const priorIndex = entry.state.fallback!.index;
      const fallback = availableFallback(input.context, entry.state.fallback!, start);
      owner.update({ fallback });
      if (fallback.exhausted) return;
      if (fallback.index !== priorIndex)
        settings.applyOverrides({
          retry: { maxRetries: entry.session!.retryAttempt + FALLBACK_RETRIES },
        });
      const next = fallback.chain[fallback.index];
      await owner.revalidateModel(next, false);
      if (stopped()) throw new Error("Delegation cancelled");
      const model = validateModelSelection(input.context, next);
      entry.prepareModel?.(next);
      if (entry.session!.model !== model) await entry.session!.setModel(model);
      if (stopped()) throw new Error("Delegation cancelled");
      if (entry.session!.thinkingLevel !== next.effort)
        entry.session!.setThinkingLevel(next.effort);
      if (entry.session!.thinkingLevel !== next.effort)
        throw new Error("SDK coerced fallback effort");
      selection.model = model;
      selection.thinkingLevel = next.effort;
      owner.update({ model: { provider: next.provider, id: next.id }, effort: next.effort });
    };
    const inheritCodemode = !!input.codemodeEnabled?.();
    if (!inheritCodemode) input.codemodeEnabled = () => false;
    const effective = (): ModelSelection => ({
      ...entry.state.model,
      effort: entry.state.effort as ModelSelection["effort"],
    });
    const onRequest = async () => {
      if (policyError) throw new Error(policyError);
      if (entry.state.fallback) await owner.revalidateFallback();
      await owner.revalidateModel(effective(), entry.state.prewalk?.status === "armed");
      owner.chargeRequest();
      if (entry.state.fallback) {
        pendingAttempt = entry.state.fallback.attempts.length;
        owner.update({
          fallback: {
            ...entry.state.fallback,
            attempts: [
              ...entry.state.fallback.attempts,
              { target: effective(), usageKnown: false },
            ],
          },
        });
      }
    };
    const physicalTargets = () => [
      selection.model!,
      ...(target ? [target] : []),
      ...(entry.state.fallback?.chain.flatMap((item) => {
        const model = input.context.modelRegistry.find(item.provider, item.id);
        return model && model.api !== "pi-virtual" ? [model] : [];
      }) ?? []),
    ];
    const admittedModels = physicalTargets();
    const routed = new Set(admittedModels.map((model) => `${model.provider}/${model.id}`));
    const runtime = await parentModelRuntime(selection, agentDir, onRequest, admittedModels);
    entry.prepareModel = (next) => {
      if (routed.has(`${next.provider}/${next.id}`)) return;
      const models = [...physicalTargets(), validateModelSelection(input.context, next)];
      registerParentModels(runtime, input.context.modelRegistry, models, onRequest);
      for (const model of models) routed.add(`${model.provider}/${model.id}`);
    };
    const resources = childResources(
      (entry.resourcePrompt ??=
        input.profile.prompt +
        (target
          ? "\nPrewalk: investigate and plan using only granted context/tools. After the first completed edit or write the same conversation switches once to the explicitly granted implementation target; all normal budgets still apply."
          : "") +
        `\nYour delegation identity is ${entry.state.id} generation ${entry.state.generation}; parent ${entry.state.parentId}. Coordination, if granted, is limited to family identities explicitly supplied to you.` +
        (entry.validator
          ? "\nThis assignment requires a structured result. Call submit_result with the actual value; final prose is not a submission."
          : "")),
      input.skills,
    );
    const loader = new DefaultResourceLoader({
      cwd: selection.cwd,
      agentDir,
      settingsManager: settings,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      extensionFactories: [
        ...(inheritCodemode ? [createCodemodeExtension({ models: false })] : []),
        (pi) => {
          pi.on("tool_call", (event, ctx) => {
            if (event.toolName !== "codemode") return;
            if (entry.cancelled || entry.paused || owner.closing)
              throw new Error("Delegation cancelled");
            ctx.signal?.throwIfAborted();
            owner.chargeToolCall();
            if (!input.codemodeEnabled?.())
              return { block: true, reason: "Parent codemode is no longer enabled" };
          });
          pi.on("turn_start", async () => {
            try {
              if (entry.state.fallback) {
                const prior = entry
                  .session!.sessionManager.getBranch()
                  .findLast((item) => item.type === "message" && item.message.role === "assistant");
                const eligible =
                  prior?.type === "message" &&
                  prior.message.role === "assistant" &&
                  recoverableFallback(prior.message);
                const prepared = recoveryPrepared;
                recoveryPrepared = false;
                if (
                  !prepared &&
                  prior?.type === "message" &&
                  prior.message.role === "assistant" &&
                  prior.message.stopReason === "error" &&
                  !eligible
                )
                  throw new Error("Terminal child model failure; explicit operator reset required");
                if (eligible && entry.state.fallback.failures > FALLBACK_RETRIES) {
                  // Steering/follow-up work can start before the final settle boundary.
                  // It must not obtain a fourth physical attempt on the exhausted target.
                  await selectFallback(entry.state.fallback.index + 1);
                } else {
                  if (
                    !prepared &&
                    eligible &&
                    prior.message.role === "assistant" &&
                    !isRetryableAssistantError(prior.message)
                  ) {
                    await waitForRetry(entry.state.fallback.failures);
                  }
                  await selectFallback(entry.state.fallback.index);
                }
                if (entry.state.fallback.exhausted)
                  throw new Error("Fallback exhausted; operator reset required");
                // Pi otherwise replaces unsupported images with placeholders. Never silently
                // alter the request to fit a backup's capabilities.
                const images = entry
                  .session!.sessionManager.buildSessionProjection()
                  .messages.some(
                    (message) =>
                      "content" in message &&
                      Array.isArray(message.content) &&
                      message.content.some((block) => block.type === "image"),
                  );
                while (images && !selection.model!.input.includes("image")) {
                  const fallback = entry.state.fallback!;
                  owner.update({
                    fallback: {
                      ...fallback,
                      skipped: [
                        ...fallback.skipped,
                        {
                          target: fallback.chain[fallback.index],
                          reason: "request requires image support",
                        },
                      ],
                    },
                  });
                  await selectFallback(fallback.index + 1);
                  if (entry.state.fallback!.exhausted)
                    throw new Error(
                      "No fallback target accepts request capabilities; operator reset required",
                    );
                }
              }
              await owner.revalidateModel(effective(), entry.state.prewalk?.status === "armed");
              policyError = undefined;
            } catch (error) {
              policyError = String(error);
            }
          });
          pi.on("message_end", (event) => {
            const fallback = entry.state.fallback;
            if (!fallback || pendingAttempt === undefined || event.message.role !== "assistant")
              return;
            const message = event.message;
            const attempts = [...fallback.attempts];
            const last = attempts[pendingAttempt];
            if (last)
              attempts[pendingAttempt] = {
                ...last,
                error: message.stopReason === "error" ? message.errorMessage : undefined,
                usageKnown:
                  (message.stopReason !== "error" && message.stopReason !== "aborted") ||
                  message.usage.totalTokens > 0,
              };
            pendingAttempt = undefined;
            const failures =
              message.stopReason === "error"
                ? fallback.failures + 1
                : message.stopReason === "aborted"
                  ? fallback.failures
                  : 0;
            if (message.stopReason === "error" && terminalFallbackError(message.errorMessage ?? ""))
              settings.applyOverrides({ retry: { maxRetries: 0 } });
            owner.update({ fallback: { ...fallback, failures, attempts } });
            if (message.stopReason !== "error")
              settings.applyOverrides({ retry: { maxRetries: FALLBACK_RETRIES } });
          });
          pi.on("agent_before_settle", async (event, ctx) => {
            const fallback = entry.state.fallback;
            if (!fallback || fallback.exhausted || policyError || stopped()) return;
            const failed = ctx.sessionManager
              .getBranch()
              .findLast((item) => item.type === "message" && item.message.role === "assistant");
            if (
              failed?.type !== "message" ||
              failed.message.role !== "assistant" ||
              failed.message.stopReason !== "error"
            )
              return;
            const message = failed.message;
            if (!recoverableFallback(message)) return;
            try {
              await owner.revalidateFallback();
              if (stopped()) return;
              if (fallback.failures > FALLBACK_RETRIES) {
                await selectFallback(fallback.index + 1);
                settings.applyOverrides({ retry: { maxRetries: FALLBACK_RETRIES } });
              } else {
                await waitForRetry(fallback.failures);
              }
              if (stopped() || entry.state.fallback!.exhausted) return;
              recoveryPrepared = true;
              return {
                entries: [
                  ...event.entries,
                  { type: "context_edit", targetId: failed.id, replacement: null },
                  {
                    type: "custom",
                    customType: "subagent-fallback-recovery",
                    data: entry.state.fallback,
                  },
                ],
                continue: true,
              };
            } catch (error) {
              if (stopped())
                return {
                  entries: [
                    ...event.entries,
                    { type: "context_edit", targetId: failed.id, replacement: null },
                  ],
                  continue: false,
                };
              policyError = String(error);
              owner.update({ error: policyError });
            }
          });
          pi.on("turn_end", async (event) => {
            if (
              entry.state.fallback &&
              event.message.role === "assistant" &&
              recoverableFallback(event.message)
            )
              return {
                entries: [
                  ...event.entries,
                  { type: "context_edit", targetId: event.messageEntryId, replacement: null },
                ],
              };
            if (
              !entry.cancelled &&
              !entry.paused &&
              !owner.closing &&
              entry.state.prewalk?.status === "armed" &&
              (completedMutation ||
                event.toolResults.some(
                  (result) =>
                    !result.isError &&
                    (result.toolName === "edit" || result.toolName === "write") &&
                    input.profile.tools.includes(result.toolName),
                ))
            ) {
              try {
                const next = entry.state.prewalk.target;
                await owner.revalidateModel(next, true);
                if (entry.cancelled || entry.paused || owner.closing) return;
                await entry.session!.setModel(target!);
                entry.session!.setThinkingLevel(next.effort);
                if (entry.session!.thinkingLevel !== next.effort)
                  throw new Error("SDK coerced prewalk effort");
                owner.update({
                  model: { provider: next.provider, id: next.id },
                  effort: next.effort,
                  prewalk: { target: next, status: "handed-off" },
                });
              } catch (error) {
                policyError = String(error);
              }
            }
          });
        },
      ],
    });
    await loader.reload();
    resources.getExtensions = () => loader.getExtensions();
    const tools: ToolDefinition[] = [
      ...input.profile.tools,
      ...(input.profile.leafTools ?? []),
    ].map((name) => {
      const tool = input.context.tools.find((tool) => tool.name === name);
      if (!tool) throw new Error(`Admitted parent tool is no longer callable: ${name}`);
      return {
        name,
        label: name,
        description: tool.description,
        parameters: tool.parameters,
        execute: async (_id, args, signal, onUpdate) => {
          if (entry.cancelled || entry.paused || owner.closing)
            throw new Error("Delegation cancelled");
          if (!input.context.tools.some((tool) => tool.name === name))
            throw new Error(`Admitted parent tool is no longer callable: ${name}`);
          const builtin = input.profile.tools.includes(name as BuiltinTool);
          await owner.authorizeTool(name, builtin);
          owner.assertTool(name, builtin, signal);
          // The public parent dispatcher preserves validation and permission hooks. Do not
          // call a raw create*Tool.execute here: that would bypass operator policy.
          const outcome = await input.context.executeTool(
            name,
            builtin
              ? workspaceArguments(name as BuiltinTool, args, selection.cwd, input.context.cwd)
              : args,
            { signal, onUpdate },
          );
          // SDK turn results contain only the outer codemode call, not its nested edits.
          if (!outcome.isError && builtin && (name === "edit" || name === "write"))
            completedMutation = true;
          return { ...outcome.result, isError: outcome.isError };
        },
      };
    });
    if (entry.validator) {
      const submission: ToolDefinition<typeof submissionParameters> = {
        name: "submit_result",
        label: "Submit result",
        exposure: "model-only",
        description: `Submit the assignment's required structured JSON value exactly once. Invalid values return errors and can be corrected within normal limits. Submission is provisional until prompt/tools/descendants drain; it never overrides cancellation or failure. Required schema: ${JSON.stringify(input.resultSchema)}`,
        parameters: submissionParameters,
        execute: async (_id, args, signal) => {
          signal?.throwIfAborted();
          if (
            entry.cancelled ||
            owner.closing ||
            entry.state.disposed ||
            entry.state.status !== "running"
          )
            throw new Error("Submission identity is no longer running");
          const outcome = entry.state.outcome!;
          if (outcome.validation === "submitted")
            throw new Error("A result was already submitted; duplicate submission rejected");
          const checked = entry.validator!.validate(args.value);
          if (!checked.ok) {
            const errors = checked.errors
              .map((error) => `${error.path || "/"}: ${error.message}`)
              .slice(0, 32);
            owner.update({
              outcome: {
                validation: "invalid",
                attempts: outcome.attempts + 1,
                errors,
                finalized: false,
              },
            });
            throw new Error(
              "Invalid structured result; correct and resubmit: " + errors.join("; "),
            );
          }
          owner.update({
            outcome: {
              validation: "submitted",
              attempts: outcome.attempts + 1,
              errors: [],
              value: structuredClone(args.value),
              finalized: false,
            },
          });
          return {
            content: [
              {
                type: "text",
                text: "Structured value submitted; final outcome awaits prompt/tool/descendant drain.",
              },
            ],
            details: {},
          };
        },
      };
      tools.push(submission);
    }
    if (input.profile.coordination?.length && input.coordinationTools)
      tools.push(
        ...input.coordinationTools({ id: entry.state.id, generation: entry.state.generation }),
      );
    if (input.profile.spawn?.length && input.nestedTool) tools.push(input.nestedTool(entry.state));
    for (const tool of tools) {
      const execute = tool.execute;
      tool.execute = async (...args) => {
        if (entry.cancelled || entry.paused || owner.closing)
          throw new Error("Delegation cancelled");
        owner.chargeToolCall();
        return execute(...args);
      };
    }
    const { session, modelFallbackMessage } = await createAgentSession({
      cwd: selection.cwd,
      agentDir,
      modelRuntime: runtime,
      model: selection.model,
      thinkingLevel: selection.thinkingLevel,
      scopedModels: [
        { model: selection.model!, thinkingLevel: selection.thinkingLevel },
        ...(target ? [{ model: target, thinkingLevel: input.profile.prewalk!.effort }] : []),
        ...(entry.state.fallback?.chain.flatMap((item) => {
          const model = input.context.modelRegistry.find(item.provider, item.id);
          return model && model.api !== "pi-virtual" ? [{ model, thinkingLevel: item.effort }] : [];
        }) ?? []),
      ],
      resourceLoader: resources,
      tools: [...tools.map((tool) => tool.name), ...(inheritCodemode ? ["codemode"] : [])],
      customTools: tools,
      settingsManager: settings,
      sessionManager: entry.sessionManager ?? SessionManager.create(selection.cwd, transcriptDir),
    });
    entry.session = session;
    entry.sessionManager = session.sessionManager;
    if (session.thinkingLevel !== selection.thinkingLevel)
      throw new Error("SDK did not preserve selected effort");
    if (
      modelFallbackMessage ||
      session.model?.id !== selection.model?.id ||
      session.model?.provider !== selection.model?.provider
    )
      throw new Error("SDK did not preserve selected model");
    let markStarted = () => {};
    entry.unsubscribe = session.subscribe((event) => {
      const patch: { -readonly [K in keyof ChildSnapshot]?: ChildSnapshot[K] } = {};
      if (event.type === "agent_start") {
        patch.status = entry.cancelled ? "draining" : entry.paused ? "pausing" : "running";
        markStarted();
      }
      if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
        patch.progress = (entry.state.progress + event.assistantMessageEvent.delta).slice(-4096);
        patch.activity = patch.progress;
      }
      if (event.type === "message_end" && event.message.role === "user") {
        const text =
          typeof event.message.content === "string"
            ? event.message.content
            : event.message.content
                .filter((block) => block.type === "text")
                .map((block) => block.text)
                .join("");
        owner.observeUserMessage(text);
      }
      if (event.type === "tool_execution_start") patch.activity = `Tool: ${event.toolName}`;
      if (event.type === "message_end" && event.message.role === "assistant") {
        const stats = session.getSessionStats();
        patch.telemetry = {
          ...entry.state.telemetry,
          tokens: stats.tokens,
          cost: stats.cost,
          ...(entry.state.fallback
            ? {
                costIncomplete: entry.state.fallback.attempts.some(
                  (attempt) => !attempt.usageKnown,
                ),
              }
            : {}),
          context: session.getContextUsage() ?? null,
        };
      }
      owner.update(patch, event);
    });
    owner.update({ transcript: session.sessionFile });
    if (owner.closing || entry.cancelled) {
      owner.update({ status: "cancelled" });
      owner.dispose();
      return;
    }
    entry.prompt = (text) => {
      recoveryPrepared = true; // Explicit windows do not restart an interrupted automatic delay.
      if (entry.recoveryAbort?.signal.aborted) entry.recoveryAbort = new AbortController();
      if (entry.state.fallback)
        settings.applyOverrides({
          retry: { maxRetries: Math.max(0, FALLBACK_RETRIES - entry.state.fallback.failures) },
        });
      if (!entry.prompted) {
        text = entry.resumeText ? input.assignment + "\n\n" + entry.resumeText : input.assignment;
        entry.prompted = true;
      }
      const started = new Promise<void>((resolve) => {
        markStarted = resolve;
      });
      entry.run = session
        .prompt(text, { expandPromptTemplates: false })
        .then(async () => {
          if (entry.paused && !entry.cancelled && !owner.closing) return;
          await owner.drainDescendants();
          if (entry.paused && !entry.cancelled && !owner.closing) return;
          clearTimeout(entry.timer); // Work has drained; artifact publication is finalization.
          const last = session.messages.filter((message) => message.role === "assistant").at(-1);
          const failed = !last || last.stopReason === "error";
          const stats = session.getSessionStats();
          owner.update({ status: "draining", activity: "Finalizing outcome artifacts" });
          const result = session.getLastAssistantText() ?? "";
          const artifacts: NonNullable<ChildSnapshot["artifacts"]> = {};
          try {
            artifacts.text = await saveOutcomeArtifact(
              outcomeDir,
              "result.txt",
              last?.content
                .filter((block) => block.type === "text")
                .map((block) => block.text)
                .join("") ?? "",
            );
            if (entry.state.outcome?.validation === "submitted")
              artifacts.structured = await saveOutcomeArtifact(
                outcomeDir,
                "structured.json",
                JSON.stringify(entry.state.outcome.value),
              );
          } catch (error) {
            artifacts.error = `Outcome artifact persistence failed: ${String(error)}`;
          }
          const missing = entry.validator && entry.state.outcome?.validation !== "submitted";
          owner.update({
            artifacts,
            outcome: entry.state.outcome ? { ...entry.state.outcome, finalized: true } : undefined,
            status:
              entry.cancelled || last?.stopReason === "aborted"
                ? "cancelled"
                : failed || missing || artifacts.error
                  ? "failed"
                  : "settled",
            result,
            error: entry.state.limitReason
              ? entry.state.error
              : failed
                ? entry.state.fallback?.exhausted
                  ? `${last?.errorMessage ?? "Provider failure"}; fallback exhausted; operator reset required`
                  : (policyError ?? last?.errorMessage ?? "No final assistant outcome")
                : missing
                  ? "Required structured result was not submitted successfully"
                  : artifacts.error,
            activity: "Prompt completed",
            telemetry: {
              requests: entry.state.telemetry.requests,
              tokens: stats.assistantMessages ? stats.tokens : null,
              cost: stats.assistantMessages ? stats.cost : null,
              ...(entry.state.fallback
                ? {
                    costIncomplete: entry.state.fallback.attempts.some(
                      (attempt) => !attempt.usageKnown,
                    ),
                  }
                : {}),
              context: session.getContextUsage() ?? null,
            },
          });
        })
        .catch(async (error) => {
          if (entry.paused && !entry.cancelled && !owner.closing) return;
          await owner.drainDescendants();
          owner.update({
            status: entry.cancelled ? "cancelled" : "failed",
            error: entry.state.limitReason ? entry.state.error : String(error),
          });
        })
        .finally(() => {
          if (!entry.paused || entry.cancelled || owner.closing) owner.dispose();
        });
      // Prompt preparation precedes abort-signal ownership in every execution window.
      return Promise.race([started, entry.run]);
    };
    if (entry.paused) return;
    await entry.prompt(entry.resumeText ?? input.assignment);
  } catch (error) {
    owner.update({
      status: entry.cancelled || owner.closing ? "cancelled" : "failed",
      error: String(error),
    });
    owner.dispose();
    throw error;
  }
}
