import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ExtensionFactory,
  type ExtensionAPI,
  type ExtensionToolContext,
} from "@earendil-works/pi-coding-agent";
import {
  fauxProvider,
  fauxAssistantMessage,
  fauxToolCall,
  InMemoryCredentialStore,
  type FauxResponseFactory,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import type { TestContext } from "node:test";
import extension from "../src/pi-extended-subagents.ts";
import { DelegationCoordinator, type RegistryEvent, type StartTask } from "../src/coordinator.ts";
import { resolveProfile } from "../src/profiles.ts";

export async function fixture(
  t: TestContext,
  options: {
    tools?: string[] | "default";
    speed?: number;
    tokenSize?: { min: number; max: number };
    extra?: ExtensionFactory;
    response?: FauxResponseFactory;
    contextWindow?: number;
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "delegation-test-"));
  const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(root, "operator");
  const model = fauxProvider({
    provider: "delegation-controlled",
    tokensPerSecond: options.speed ?? 10000,
    tokenSize: options.tokenSize ?? { min: 1, max: 1 },
    ...(options.contextWindow
      ? { models: [{ id: "controlled", contextWindow: options.contextWindow }] }
      : {}),
  });
  const respond: FauxResponseFactory = (context, opts, state, selected) => {
    model.appendResponses([respond]);
    if (options.response) return options.response(context, opts, state, selected);
    const last = context.messages.at(-1);
    if (last?.role === "toolResult") return fauxAssistantMessage("Parent acknowledged");
    const user = context.messages.filter((message) => message.role === "user").at(-1);
    const text =
      typeof user?.content === "string"
        ? user.content
        : (user?.content
            .filter((block) => block.type === "text")
            .map((block) => block.text)
            .join("") ?? "");
    if (text.startsWith("LAUNCH "))
      return fauxAssistantMessage(fauxToolCall("delegate_task", JSON.parse(text.slice(7))), {
        stopReason: "toolUse",
      });
    return fauxAssistantMessage(`Controlled response: ${text}`);
  };
  model.setResponses([respond]);
  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    modelsStorePath: join(root, "cache.json"),
    refreshOnCreate: false,
  });
  runtime.registerNativeProvider(model.provider);
  const settings = SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: false },
  });
  const events: RegistryEvent[] = [];
  let context: ExtensionToolContext | undefined;
  let contextCallerId = "";
  let toolMetadata!: ExtensionAPI["getAllTools"];
  let codemodeEnabled!: () => boolean;
  let assertTools!: (names: readonly string[]) => void;
  const coordinator = new DelegationCoordinator(join(root, "direct"), "test-parent");
  coordinator.subscribe((event) => events.push(event));
  const observer: ExtensionFactory = (pi) => {
    toolMetadata = () => pi.getAllTools();
    codemodeEnabled = () =>
      pi.getActiveTools().includes("codemode") &&
      pi
        .getAllTools()
        .some(
          (tool) =>
            tool.name === "codemode" && tool.exposure === "model-only" && !!tool.reachesTools,
        );
    assertTools = (names) => {
      for (const name of names)
        if (
          pi.getAllTools().find((tool) => tool.name === name)?.sourceInfo.path !== `builtin:${name}`
        )
          throw new Error(`Delegation requires an unmodified built-in parent tool: ${name}`);
    };
    pi.events.on("delegation:registry", (data) => events.push(data as RegistryEvent));
    pi.registerTool({
      name: "capture_context",
      label: "capture",
      parameters: Type.Object({}),
      description: "Test fixture",
      execute: async (id, _args, _signal, _update, ctx) => {
        context = ctx;
        contextCallerId = id;
        return { content: [], details: {} };
      },
    });
  };
  const loader = new DefaultResourceLoader({
    cwd: root,
    agentDir: join(root, "agent"),
    settingsManager: settings,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: [extension, observer, ...(options.extra ? [options.extra] : [])],
  });
  await loader.reload();
  const { session } = await createAgentSession({
    cwd: root,
    agentDir: join(root, "agent"),
    modelRuntime: runtime,
    model: model.getModel(),
    resourceLoader: loader,
    tools:
      options.tools === "default"
        ? undefined
        : (options.tools ?? [
            "read",
            "grep",
            "find",
            "ls",
            "edit",
            "write",
            "bash",
            "capture_context",
            "delegate_task",
            "delegate_coordinate",
          ]),
    settingsManager: settings,
    sessionManager: SessionManager.create(root, join(root, "parent")),
  });
  t.after(async () => {
    try {
      await coordinator.shutdown();
      await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    } finally {
      session.dispose();
      if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
      await rm(root, { recursive: true, force: true });
    }
  });
  await session.bindExtensions({ mode: "rpc", onError: () => {} });
  async function launch(assignment: string, profile = "general", background = true) {
    await session.prompt("LAUNCH " + JSON.stringify({ assignment, profile, background }));
    const result = session.messages
      .filter((message) => message.role === "toolResult" && message.toolName === "delegate_task")
      .at(-1);
    if (!result || result.role !== "toolResult" || result.isError)
      throw new Error(JSON.stringify(result));
    return result.details as { id: string; generation: number };
  }
  async function direct(
    assignment: string,
    profileName = "general",
    overrides: Partial<StartTask> = {},
  ) {
    // Obtain a real public tool context through an actual model-issued parent tool.
    if (!context) {
      model.setResponses([
        fauxAssistantMessage(fauxToolCall("capture_context", {}), { stopReason: "toolUse" }),
        fauxAssistantMessage("captured"),
        respond,
      ]);
      await session.prompt("capture fixture context");
    }
    const { profile, skills } = await resolveProfile(
      profileName,
      root,
      false,
      join(root, "operator"),
    );
    return coordinator.start({
      assignment,
      profile,
      skills,
      context: context!,
      assertTools,
      toolMetadata,
      codemodeEnabled,
      callerId: contextCallerId,
      ...overrides,
    });
  }
  return {
    root,
    model,
    runtime,
    session,
    coordinator,
    events,
    launch,
    direct,
    get context() {
      return context!;
    },
  };
}
export async function eventually(predicate: () => boolean, timeout = 5000): Promise<void> {
  const end = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() > end) throw new Error("Expected state did not arrive");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
