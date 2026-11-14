import test from "node:test";
import assert from "node:assert/strict";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type FauxResponseFactory,
} from "@earendil-works/pi-ai";
import { join } from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { Type } from "typebox";
import { fixture } from "./fixtures.ts";

// Feasibility checkpoint: real SDK boundary dispatch, not a replacement agent loop.
for (const failure of ["insufficient_quota", "503 Service Unavailable"]) {
  test(`SDK 1.5.2 boundary recovers ${failure} without changing raw errors`, async (t) => {
    const { root, runtime, model } = await fixture(t);
    const requests: string[] = [];
    let failuresSeen = 0;
    let toolExecutions = 0;
    const backup = fauxProvider({ provider: "gate-backup", tokensPerSecond: 0 });
    const final = fauxProvider({ provider: "gate-final", tokensPerSecond: 0 });
    backup.setResponses(
      Array.from({ length: 3 }, () => (context) => {
        requests.push(JSON.stringify(context.messages));
        return fauxAssistantMessage("failed streamed draft", {
          stopReason: "error",
          errorMessage: failure,
        });
      }),
    );
    final.setResponses([
      (context) => {
        requests.push(JSON.stringify(context.messages));
        return fauxAssistantMessage("recovered");
      },
    ]);
    runtime.registerNativeProvider(backup.provider);
    runtime.registerNativeProvider(final.provider);
    const extension: ExtensionFactory = (pi) => {
      pi.on("message_end", (event) => {
        if (event.message.role === "assistant" && event.message.stopReason === "error")
          failuresSeen++;
      });
      pi.on("agent_before_settle", async (event, ctx) => {
        const failed = ctx.sessionManager
          .getBranch()
          .findLast((entry) => entry.type === "message" && entry.message.role === "assistant");
        if (
          failed?.type !== "message" ||
          failed.message.role !== "assistant" ||
          failed.message.stopReason !== "error"
        )
          return;
        if (failuresSeen >= 6) assert.equal(await pi.setModel(final.getModel()), true);
        else if (failuresSeen >= 3) assert.equal(await pi.setModel(backup.getModel()), true);
        return {
          entries: [
            ...event.entries,
            { type: "context_edit", targetId: failed.id, replacement: null },
          ],
          continue: true,
        };
      });
    };
    const loader = new DefaultResourceLoader({
      cwd: root,
      agentDir: join(root, "gate"),
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      extensionFactories: [extension],
    });
    await loader.reload();
    const failures = 3;
    model.setResponses([
      fauxAssistantMessage(fauxToolCall("gate_tool", {}), { stopReason: "toolUse" }),
      ...Array.from(
        { length: failures },
        () =>
          ((context) => {
            requests.push(JSON.stringify(context.messages));
            return fauxAssistantMessage(
              [{ type: "text", text: "failed streamed draft" }, fauxToolCall("gate_tool", {})],
              {
                stopReason: "error",
                errorMessage: failure,
              },
            );
          }) satisfies FauxResponseFactory,
      ),
    ]);
    const { session } = await createAgentSession({
      cwd: root,
      agentDir: join(root, "gate"),
      modelRuntime: runtime,
      model: model.getModel(),
      resourceLoader: loader,
      tools: ["gate_tool"],
      customTools: [
        {
          name: "gate_tool",
          label: "gate",
          description: "Controlled completed tool",
          parameters: Type.Object({}),
          execute: async () => {
            toolExecutions++;
            return { content: [{ type: "text", text: "completed tool evidence" }], details: {} };
          },
        },
      ],
      sessionManager: SessionManager.inMemory(root),
      settingsManager: SettingsManager.inMemory({
        compaction: { enabled: false },
        retry: { enabled: true, maxRetries: 2, baseDelayMs: 1, provider: { maxRetries: 0 } },
      }),
    });
    t.after(() => session.dispose());
    await session.prompt("original task");
    assert.equal(requests.length, failures * 2 + 1);
    assert.equal(model.state.callCount, 4, "one successful tool turn plus three failed attempts");
    assert.equal(
      toolExecutions,
      1,
      "failed streamed tool drafts never execute; completed tools do not replay",
    );
    assert.ok(requests.every((request) => request.includes("completed tool evidence")));
    assert.equal(backup.state.callCount, 3);
    assert.equal(final.state.callCount, 1);
    assert.equal(session.getLastAssistantText(), "recovered");
    assert.ok(requests.every((request) => !request.includes("failed streamed draft")));
    const raw = session.sessionManager
      .getBranch()
      .filter(
        (entry) =>
          entry.type === "message" &&
          entry.message.role === "assistant" &&
          entry.message.stopReason === "error",
      );
    assert.equal(raw.length, failures * 2);
    assert.ok(
      raw.every(
        (entry) =>
          entry.type === "message" &&
          entry.message.role === "assistant" &&
          entry.message.errorMessage === failure,
      ),
    );
  });
}

test("SDK physical child selection bypasses a virtual parent's router", async (t) => {
  const { root, model, session, runtime, direct, coordinator } = await fixture(t);
  // Capture the public parent tool context before selecting the virtual parent.
  const initial = await direct("capture physical context");
  await coordinator.wait(initial);
  let routes = 0;
  runtime.registerVirtualModel({
    provider: "gate-router",
    name: "Controlled virtual parent",
    id: "virtual",
    thinkingLevels: ["off"],
    route() {
      routes++;
      throw new Error("parent router must not execute");
    },
  });
  const virtual = runtime.getModel("gate-router", "virtual")!;
  await session.setModel(virtual);
  const physical = model.getModel();
  const selection = { provider: physical.provider, id: physical.id, effort: "off" as const };
  await mkdir(join(root, "operator"), { recursive: true });
  await writeFile(
    join(root, "operator", "delegation.json"),
    JSON.stringify({ general: { models: [selection], model: selection } }),
  );
  const { resolveProfile } = await import("../src/profiles.ts");
  const { profile } = await resolveProfile("general", root, false, join(root, "operator"));
  const ref = await direct("physical profile under virtual parent", "general", {
    profile: { ...profile, models: [selection], model: selection },
  });
  const result = await coordinator.wait(ref);
  assert.equal(result.status, "settled", result.error ?? "no error");
  assert.deepEqual(result.model, { provider: physical.provider, id: physical.id });
  assert.equal(routes, 0);
  assert.equal(result.telemetry.requests, 1);
});

test("SDK cancellation during native retry backoff never dispatches another attempt", async (t) => {
  const { root, runtime, model } = await fixture(t);
  model.setResponses([
    fauxAssistantMessage("failed", {
      stopReason: "error",
      errorMessage: "503 Service Unavailable",
    }),
    fauxAssistantMessage("must not dispatch"),
  ]);
  const { session } = await createAgentSession({
    cwd: root,
    agentDir: join(root, "gate-cancel"),
    modelRuntime: runtime,
    model: model.getModel(),
    resourceLoader: (await import("../src/child-execution.ts")).childResources("controlled gate"),
    tools: [],
    sessionManager: SessionManager.inMemory(root),
    settingsManager: SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: true, maxRetries: 2, baseDelayMs: 10000, provider: { maxRetries: 0 } },
    }),
  });
  t.after(() => session.dispose());
  let backoff!: () => void;
  const started = new Promise<void>((resolve) => {
    backoff = resolve;
  });
  session.subscribe((event) => {
    if (event.type === "auto_retry_start") backoff();
  });
  const run = session.prompt("cancel retry");
  await started;
  await session.abort();
  await run;
  assert.equal(model.state.callCount, 1);
  assert.equal(session.isIdle, true);
});

test("SDK quota boundary backoff needs an owner cancellation signal; abort suppresses continuation", async (t) => {
  const { setTimeout: delay } = await import("node:timers/promises");
  const { root, runtime, model } = await fixture(t);
  model.setResponses([
    fauxAssistantMessage("failed quota draft", {
      stopReason: "error",
      errorMessage: "insufficient_quota",
    }),
    fauxAssistantMessage("must not dispatch"),
  ]);
  const owner = new AbortController();
  let entered!: () => void;
  const boundary = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let boundaries = 0;
  const loader = new DefaultResourceLoader({
    cwd: root,
    agentDir: join(root, "gate-quota-cancel"),
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: [
      (pi) => {
        pi.on("agent_before_settle", async (event, ctx) => {
          boundaries++;
          assert.equal(pi.getSettings().retry?.provider?.maxRetries, 0);
          // The SDK's low-level agent has ended: its signal does not cover this boundary.
          assert.equal(ctx.signal, undefined);
          entered();
          try {
            await delay(10000, undefined, { signal: owner.signal });
          } catch {
            return;
          }
          const failed = ctx.sessionManager
            .getBranch()
            .findLast((entry) => entry.type === "message" && entry.message.role === "assistant");
          assert.ok(failed);
          return {
            entries: [
              ...event.entries,
              { type: "context_edit", targetId: failed.id, replacement: null },
            ],
            continue: true,
          };
        });
      },
    ],
  });
  await loader.reload();
  const { session } = await createAgentSession({
    cwd: root,
    agentDir: join(root, "gate-quota-cancel"),
    modelRuntime: runtime,
    model: model.getModel(),
    resourceLoader: loader,
    tools: [],
    sessionManager: SessionManager.inMemory(root),
    settingsManager: SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: true, maxRetries: 2, provider: { maxRetries: 0 } },
    }),
  });
  t.after(() => session.dispose());
  const run = session.prompt("cancel quota backoff");
  await boundary;
  owner.abort();
  await session.abort();
  await run;
  assert.equal(model.state.callCount, 1);
  assert.equal(boundaries, 1);
  assert.equal(session.isIdle, true);
});

test("SDK resets two native retries after a successful tool response", async (t) => {
  const { root, runtime, model } = await fixture(t);
  const failure = () =>
    fauxAssistantMessage("failed", {
      stopReason: "error",
      errorMessage: "503 Service Unavailable",
    });
  model.setResponses([
    failure(),
    failure(),
    fauxAssistantMessage(fauxToolCall("gate_tool", {}), { stopReason: "toolUse" }),
    failure(),
    failure(),
    fauxAssistantMessage("done"),
  ]);
  let tools = 0;
  const { session } = await createAgentSession({
    cwd: root,
    agentDir: join(root, "gate-counter"),
    modelRuntime: runtime,
    model: model.getModel(),
    resourceLoader: (await import("../src/child-execution.ts")).childResources("controlled gate"),
    tools: ["gate_tool"],
    customTools: [
      {
        name: "gate_tool",
        label: "gate",
        description: "controlled",
        parameters: Type.Object({}),
        execute: async () => {
          tools++;
          return { content: [{ type: "text", text: "completed" }], details: {} };
        },
      },
    ],
    sessionManager: SessionManager.inMemory(root),
    settingsManager: SettingsManager.inMemory({
      compaction: { enabled: false },
      retry: { enabled: true, maxRetries: 2, baseDelayMs: 1, provider: { maxRetries: 0 } },
    }),
  });
  t.after(() => session.dispose());
  await session.prompt("complete two request episodes");
  assert.equal(model.state.callCount, 6);
  assert.equal(tools, 1);
  assert.equal(session.getLastAssistantText(), "done");
  assert.equal(session.retryAttempt, 0);
});
