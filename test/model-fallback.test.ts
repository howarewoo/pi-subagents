import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  fauxProvider,
  fauxAssistantMessage,
  fauxToolCall,
  createAssistantMessageEventStream,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { fixture, eventually } from "./fixtures.ts";
import { resolveProfile } from "../src/profiles.ts";
import { narrowModelPolicy } from "../src/model-policy.ts";

const a = { provider: "fallback-a", id: "a", effort: "high" as const };
const b = { provider: "fallback-b", id: "b", effort: "low" as const };
const missing = { provider: "fallback-missing", id: "missing", effort: "off" as const };
async function configure(root: string, general: unknown, scheduling?: unknown) {
  await mkdir(join(root, "operator"), { recursive: true });
  await writeFile(
    join(root, "operator", "delegation.json"),
    JSON.stringify({ general, ...(scheduling ? { scheduling } : {}) }),
  );
}
function providers(runtime: Awaited<ReturnType<typeof fixture>>["runtime"]) {
  const primary = fauxProvider({
    provider: a.provider,
    models: [{ id: a.id, reasoning: true }],
    tokensPerSecond: 0,
  });
  const backup = fauxProvider({
    provider: b.provider,
    models: [{ id: b.id, reasoning: true }],
    tokensPerSecond: 0,
  });
  runtime.registerNativeProvider(primary.provider);
  runtime.registerNativeProvider(backup.provider);
  return { primary, backup };
}

test("profile primary is independent of physical/virtual parent; two quota retries, missing target skip, sticky resume and operator-only reset", async (t) => {
  const { root, runtime, direct, coordinator, session } = await fixture(t);
  const { primary, backup } = providers(runtime);
  primary.setResponses([
    fauxAssistantMessage("profile primary under physical parent"),
    ...Array.from({ length: 3 }, () =>
      fauxAssistantMessage("failed quota draft", {
        stopReason: "error",
        errorMessage: "insufficient_quota",
      }),
    ),
    fauxAssistantMessage("primary after manual reset"),
  ]);
  backup.setResponses([
    fauxAssistantMessage("backup selected"),
    fauxAssistantMessage("backup remains sticky"),
  ]);
  await configure(root, { tools: ["read"], models: [b, missing, a], fallback: [a, missing, b] });
  const first = await direct("physical parent independent primary");
  assert.equal((await coordinator.wait(first)).model.provider, a.provider);
  let parentRoutes = 0;
  runtime.registerVirtualModel({
    provider: "parent-router",
    id: "virtual",
    name: "Controlled virtual parent",
    thinkingLevels: ["off"],
    route() {
      parentRoutes++;
      throw new Error("do not invoke parent router");
    },
  });
  await session.setModel(runtime.getModel("parent-router", "virtual")!);
  const ref = await direct("quota recovery under virtual parent");
  let state = await coordinator.wait(ref);
  assert.equal(state.status, "settled", state.error ?? "no error");
  assert.equal(state.model.provider, b.provider);
  assert.equal(state.effort, b.effort);
  assert.equal(state.telemetry.requests, 4);
  assert.equal(state.fallback?.attempts.length, 4);
  assert.equal(
    state.fallback?.attempts.filter((attempt) => attempt.error === "insufficient_quota").length,
    3,
  );
  assert.equal(state.fallback?.skipped[0].target.provider, missing.provider);
  assert.equal(primary.state.callCount, 4);
  assert.equal(backup.state.callCount, 1);
  assert.equal(parentRoutes, 0);
  const raw = await readFile(state.transcript!, "utf8");
  assert.match(raw, /failed quota draft/);
  assert.match(raw, /subagent-fallback-recovery/);
  await coordinator.resume(ref, "continue on backup");
  state = await coordinator.wait(ref);
  assert.equal(state.model.provider, b.provider);
  assert.equal(state.telemetry.requests, 5);
  const beforeReset = {
    requests: state.telemetry.requests,
    limits: state.limits,
    calls: primary.state.callCount + backup.state.callCount,
  };
  await coordinator.resetFallback(ref);
  state = coordinator.snapshot(ref)!;
  assert.equal(state.model.provider, a.provider);
  assert.equal(state.telemetry.requests, beforeReset.requests);
  assert.deepEqual(state.limits, beforeReset.limits);
  assert.equal(primary.state.callCount + backup.state.callCount, beforeReset.calls);
  await coordinator.resume(ref, "continue after manual reset");
  state = await coordinator.wait(ref);
  assert.equal(state.status, "settled", state.error ?? "no error");
  assert.equal(state.model.provider, a.provider);
  assert.equal(state.telemetry.requests, 6);
  assert.equal(parentRoutes, 0);
});

test("explicit tasks are pinned unless opted in; opt-in starts at exact chain membership and task grants only narrow", async (t) => {
  const { root, runtime, direct, coordinator } = await fixture(t);
  const { primary, backup } = providers(runtime);
  await configure(root, { tools: ["read"], models: [a, b], fallback: [a, b] });
  primary.setResponses([
    fauxAssistantMessage("insufficient quota", {
      stopReason: "error",
      errorMessage: "insufficient_quota",
    }),
  ]);
  backup.setResponses([fauxAssistantMessage("suffix"), fauxAssistantMessage("narrowed")]);
  const pinned = await direct("stay pinned", "general", { model: a });
  const state = await coordinator.wait(pinned);
  assert.equal(state.status, "failed");
  assert.equal(state.fallback, undefined);
  assert.equal(primary.state.callCount, 1);
  assert.equal(backup.state.callCount, 0);
  const opted = await direct("explicit suffix", "general", { model: b, fallback: true });
  assert.equal((await coordinator.wait(opted)).model.provider, b.provider);
  const { profile } = await resolveProfile("general", root, false, join(root, "operator"));
  const narrowed = await direct("task-narrowed chain", "general", {
    profile: { ...profile, models: [b] },
  });
  assert.equal((await coordinator.wait(narrowed)).model.provider, b.provider);
  await assert.rejects(
    direct("absent membership", "general", { model: missing, fallback: true }),
    /must belong/,
  );
});

test("invalid chain permissions/prewalk and project reordering reject before admission", async (t) => {
  const { root, runtime, direct, events } = await fixture(t);
  providers(runtime);
  for (const policy of [
    { models: [a], fallback: [a, b] },
    { models: [a, b], fallback: [a, b], prewalk: b },
    { models: [a], fallback: [a, a] },
  ]) {
    const before = events.length;
    await configure(root, policy);
    await assert.rejects(direct("invalid chain"));
    assert.equal(events.length, before);
  }
  const base = { models: [a, b], fallback: [a, b] };
  assert.throws(() => narrowModelPolicy(base, { fallback: [b, a] }, false), /reorder/);
  assert.throws(() => narrowModelPolicy(base, { fallback: [missing] }, false), /reorder/);
  assert.deepEqual(narrowModelPolicy(base, { fallback: [b] }, false).fallback, [b]);
  assert.equal(narrowModelPolicy(base, { fallback: false }, false).fallback, undefined);
});

test("deadline cancels quota backoff; retained resume keeps target and cumulative request budget", async (t) => {
  const { root, runtime, direct, coordinator } = await fixture(t);
  const { primary, backup } = providers(runtime);
  primary.setResponses([
    fauxAssistantMessage("quota", { stopReason: "error", errorMessage: "insufficient_quota" }),
    fauxAssistantMessage("resumed same target"),
  ]);
  backup.setResponses([fauxAssistantMessage("must not dispatch")]);
  await configure(root, { tools: ["read"], models: [a, b], fallback: [a, b] });
  const ref = await direct("pause during quota backoff", "general", {
    limits: { deadlineMs: 100, requests: 2 },
  });
  let state = await coordinator.wait(ref);
  assert.equal(state.status, "paused");
  assert.equal(state.telemetry.requests, 1);
  assert.equal(state.fallback?.failures, 1);
  assert.equal(backup.state.callCount, 0);
  await coordinator.resetFallback(ref);
  assert.equal(coordinator.snapshot(ref)!.telemetry.requests, 1);
  await coordinator.resume(ref, "resume explicitly");
  state = await coordinator.wait(ref);
  assert.equal(state.status, "settled", state.error ?? "no error");
  assert.equal(state.telemetry.requests, 2);
  assert.equal(state.model.provider, a.provider);
  assert.equal(backup.state.callCount, 0);
  await assert.rejects(coordinator.resume(ref, "no replenished budget"), /budget exhausted/);
});

test("exhaustion never wraps; operator reset retains failed-window evidence and cumulative limits", async (t) => {
  const { root, runtime, direct, coordinator } = await fixture(t);
  const { primary } = providers(runtime);
  primary.setResponses([
    ...Array.from({ length: 3 }, () =>
      fauxAssistantMessage("503 failed", {
        stopReason: "error",
        errorMessage: "503 Service Unavailable",
      }),
    ),
    fauxAssistantMessage("after reset"),
  ]);
  await configure(root, { tools: ["read"], models: [a], fallback: [a] });
  const ref = await direct("exhaust finite chain", "general", { limits: { requests: 4 } });
  let state = await coordinator.wait(ref);
  assert.equal(state.status, "failed");
  assert.equal(state.fallback?.exhausted, true);
  assert.equal(state.telemetry.requests, 3);
  assert.equal(primary.state.callCount, 3);
  await assert.rejects(coordinator.resume(ref, "no automatic wrap"));
  assert.equal(primary.state.callCount, 3);
  await coordinator.resetFallback(ref);
  assert.equal(primary.state.callCount, 3);
  await coordinator.resume(ref, "explicitly continue after reset");
  state = await coordinator.wait(ref);
  assert.equal(state.status, "settled", state.error ?? "no error");
  assert.equal(state.completedWindows?.[0].status, "failed");
  assert.equal(state.telemetry.requests, 4);
  assert.equal(state.fallback?.attempts.length, 4);
});

test("terminal authentication errors do not recover even when transient wording is present", async (t) => {
  const { root, runtime, direct, coordinator } = await fixture(t);
  const { primary, backup } = providers(runtime);
  primary.setResponses([
    fauxAssistantMessage("denied", {
      stopReason: "error",
      errorMessage: "401 unauthorized: upstream network error",
    }),
  ]);
  backup.setResponses([fauxAssistantMessage("must not dispatch")]);
  await configure(root, { tools: ["read"], models: [a, b], fallback: [a, b] });
  const ref = await direct("do not retry auth");
  const state = await coordinator.wait(ref);
  assert.equal(state.status, "failed");
  assert.equal(primary.state.callCount, 1);
  assert.equal(backup.state.callCount, 0);
  assert.equal(state.telemetry.requests, 1);
});

test("every retry charges the cumulative request budget before physical dispatch", async (t) => {
  const { root, runtime, direct, coordinator } = await fixture(t);
  const { primary, backup } = providers(runtime);
  primary.setResponses([
    fauxAssistantMessage("quota", { stopReason: "error", errorMessage: "insufficient_quota" }),
  ]);
  backup.setResponses([fauxAssistantMessage("must not dispatch")]);
  await configure(root, { tools: ["read"], models: [a, b], fallback: [a, b] });
  const ref = await direct("stop before a second provider attempt", "general", {
    limits: { requests: 1 },
  });
  const state = await coordinator.wait(ref);
  assert.equal(state.telemetry.requests, 1);
  assert.equal(state.fallback?.attempts.length, 1);
  assert.equal(primary.state.callCount, 1);
  assert.equal(backup.state.callCount, 0);
  assert.equal(state.limitReason, "requests");
});

test("paused quota recovery retains route, failure counter and budgets across explicit resume windows", async (t) => {
  const { root, runtime, direct, coordinator } = await fixture(t);
  const { primary, backup } = providers(runtime);
  primary.setResponses(
    Array.from({ length: 3 }, () =>
      fauxAssistantMessage("draft", { stopReason: "error", errorMessage: "insufficient_quota" }),
    ),
  );
  backup.setResponses([fauxAssistantMessage("backup after retained attempts")]);
  await configure(root, { tools: ["read"], models: [a, b], fallback: [a, b] });
  const ref = await direct("retain failed episode across deadlines", "general", {
    limits: { deadlineMs: 100, requests: 4 },
  });
  for (const failures of [1, 2]) {
    const paused = await coordinator.wait(ref);
    assert.equal(paused.status, "paused");
    assert.equal(paused.fallback?.failures, failures);
    assert.equal(paused.telemetry.requests, failures);
    assert.equal(paused.model.provider, a.provider);
    await coordinator.resume(ref, "continue retained recovery");
  }
  const state = await coordinator.wait(ref);
  assert.equal(state.status, "settled", state.error ?? "no error");
  assert.equal(state.telemetry.requests, 4);
  assert.equal(state.model.provider, b.provider);
  assert.equal(primary.state.callCount, 3);
  assert.equal(backup.state.callCount, 1);
});

test("unauthorized scoped backups and known virtual targets hard-stop before admission rather than being skipped", async (t) => {
  const fx = await fixture(t);
  const { root, runtime, direct, coordinator, events } = fx;
  const { primary, backup } = providers(runtime);
  const capture = await direct("capture parent context");
  await coordinator.wait(capture);
  await configure(root, { tools: ["read"], models: [a, b], fallback: [a, b] });
  const before = events.length;
  await assert.rejects(
    direct("unauthorized backup", "general", {
      context: new Proxy(fx.context, {
        get(target, property) {
          return property === "scopedModels"
            ? [{ model: primary.getModel(), thinkingLevel: a.effort }]
            : Reflect.get(target, property);
        },
      }),
    }),
    /outside parent scoped/,
  );
  assert.equal(events.length, before);
  const virtual = { provider: "chain-virtual", id: "virtual", effort: "off" as const };
  runtime.registerVirtualModel({
    provider: virtual.provider,
    id: virtual.id,
    name: "Unsupported virtual target",
    thinkingLevels: ["off"],
    route() {
      throw new Error("must not invoke");
    },
  });
  await configure(root, { tools: ["read"], models: [a, virtual], fallback: [a, virtual] });
  await assert.rejects(direct("known virtual backup"), /must be physical/);
  assert.equal(events.length, before);
  assert.equal(primary.state.callCount, 0);
  assert.equal(backup.state.callCount, 0);
});

test("mixed quota then transient failures share exactly three physical attempts before fallback", async (t) => {
  const { root, runtime, direct, coordinator } = await fixture(t);
  const { primary, backup } = providers(runtime);
  primary.setResponses([
    fauxAssistantMessage("quota", { stopReason: "error", errorMessage: "insufficient_quota" }),
    fauxAssistantMessage("transient one", {
      stopReason: "error",
      errorMessage: "503 Service Unavailable",
    }),
    fauxAssistantMessage("transient two", {
      stopReason: "error",
      errorMessage: "503 Service Unavailable",
    }),
    fauxAssistantMessage("forbidden fourth A attempt", {
      stopReason: "error",
      errorMessage: "503 Service Unavailable",
    }),
  ]);
  backup.setResponses([fauxAssistantMessage("B succeeds")]);
  await configure(root, { tools: ["read"], models: [a, b], fallback: [a, b] });
  const ref = await direct("mixed quota then transient");
  const state = await coordinator.wait(ref);
  assert.equal(state.status, "settled", state.error ?? "no error");
  assert.equal(primary.state.callCount, 3, "A must not receive a fourth physical attempt");
  assert.equal(backup.state.callCount, 1);
  assert.deepEqual(
    state.fallback?.attempts.map((attempt) => attempt.target.provider),
    [a.provider, a.provider, a.provider, b.provider],
  );
  assert.equal(state.telemetry.requests, 4);
});

for (const mode of ["steer", "followUp"] as const) {
  test(`queued ${mode} cannot bypass quota backoff or obtain a fourth primary attempt`, async (t) => {
    const { root, runtime, direct, coordinator } = await fixture(t);
    const { primary, backup } = providers(runtime);
    let release!: () => void;
    const ready = new Promise<void>((resolve) => {
      release = resolve;
    });
    t.after(() => release());
    let ref!: Awaited<ReturnType<typeof direct>>;
    let failures = 0;
    const contexts: string[] = [];
    primary.setResponses(
      Array.from({ length: 3 }, () => async (context) => {
        await ready;
        contexts.push(JSON.stringify(context.messages));
        const receipt = await coordinator.message(undefined, ref, `queued ${++failures}`, mode);
        assert.equal(receipt.status, "queued");
        return fauxAssistantMessage("failed queued draft", {
          stopReason: "error",
          errorMessage: "insufficient_quota",
        });
      }),
    );
    backup.setResponses(
      Array.from({ length: 4 }, () => (context) => {
        contexts.push(JSON.stringify(context.messages));
        return fauxAssistantMessage("backup handles queued work");
      }),
    );
    await configure(root, { tools: ["read"], models: [a, b], fallback: [a, b] });
    ref = await direct("queued work retains the failure episode");
    release();
    const state = await coordinator.wait(ref);
    assert.equal(state.status, "settled", state.error ?? "no error");
    assert.equal(primary.state.callCount, 3);
    const backupRequests = mode === "followUp" ? 4 : 1;
    assert.equal(backup.state.callCount, backupRequests);
    assert.equal(state.telemetry.requests, 3 + backupRequests);
    assert.equal(
      contexts.some((context) => context.includes("failed queued draft")),
      false,
    );
    assert.match(contexts.at(-1)!, /queued 3/);
  });
}

test("image tool results skip an incompatible target without placeholder conversion or tool replay", async (t) => {
  const png =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";
  let tools = 0;
  const { root, runtime, direct, coordinator } = await fixture(t, {
    tools: ["read", "capture_context", "delegate_task", "delegate_coordinate", "image_probe"],
    extra: (pi) => {
      pi.registerTool({
        name: "image_probe",
        label: "image",
        description: "Controlled reviewed leaf image result",
        parameters: Type.Object({}),
        execute: async () => {
          tools++;
          return { content: [{ type: "image", data: png, mimeType: "image/png" }], details: {} };
        },
      });
    },
  });
  const primary = fauxProvider({
    provider: a.provider,
    models: [{ id: a.id, reasoning: true, input: ["text"] }],
    tokensPerSecond: 0,
  });
  const backup = fauxProvider({
    provider: b.provider,
    models: [{ id: b.id, reasoning: true, input: ["text", "image"] }],
    tokensPerSecond: 0,
  });
  runtime.registerNativeProvider(primary.provider);
  runtime.registerNativeProvider(backup.provider);
  primary.setResponses([
    fauxAssistantMessage(fauxToolCall("image_probe", {}), { stopReason: "toolUse" }),
  ]);
  let receivedImage = false;
  backup.setResponses([
    (context) => {
      receivedImage = context.messages.some(
        (message) =>
          Array.isArray(message.content) && message.content.some((block) => block.type === "image"),
      );
      return fauxAssistantMessage("image accepted");
    },
  ]);
  await configure(root, {
    tools: ["read"],
    leafTools: ["image_probe"],
    models: [a, b],
    fallback: [a, b],
  });
  const ref = await direct("inspect image tool output");
  const state = await coordinator.wait(ref);
  assert.equal(state.status, "settled", state.error ?? "no error");
  assert.equal(primary.state.callCount, 1);
  assert.equal(backup.state.callCount, 1);
  assert.equal(tools, 1);
  assert.equal(receivedImage, true);
  assert.equal(state.telemetry.requests, 2);
  assert.match(state.fallback!.skipped[0].reason, /image support/);
});

test("live scope revocation during backoff hard-stops rather than skipping an unauthorized backup", async (t) => {
  const { root, runtime, direct, coordinator, session } = await fixture(t);
  const { primary, backup } = providers(runtime);
  primary.setResponses([
    fauxAssistantMessage("quota", { stopReason: "error", errorMessage: "insufficient_quota" }),
  ]);
  backup.setResponses([fauxAssistantMessage("must not dispatch")]);
  await configure(root, { tools: ["read"], models: [a, b], fallback: [a, b] });
  const ref = await direct("revoke backup authorization");
  await eventually(() => coordinator.snapshot(ref)?.fallback?.failures === 1);
  session.setScopedModels([{ model: primary.getModel(), thinkingLevel: a.effort }]);
  const state = await coordinator.wait(ref);
  assert.equal(state.status, "failed");
  assert.match(state.error!, /outside parent scoped/);
  assert.equal(primary.state.callCount, 1);
  assert.equal(backup.state.callCount, 0);
  assert.equal(state.telemetry.requests, 1);
});

test("changed chain requires explicit reset and cannot silently remap a retained route", async (t) => {
  const { root, runtime, direct, coordinator } = await fixture(t);
  const { primary, backup } = providers(runtime);
  primary.setResponses([fauxAssistantMessage("primary")]);
  backup.setResponses([fauxAssistantMessage("new operator primary after reset")]);
  await configure(root, { tools: ["read"], models: [a, b], fallback: [a, b] });
  const ref = await direct("retain chain identity");
  const original = await coordinator.wait(ref);
  await configure(root, { tools: ["read"], models: [a, b], fallback: [b, a] });
  await assert.rejects(coordinator.resume(ref, "do not silently remap"), /configuration changed/);
  assert.deepEqual(coordinator.snapshot(ref), original);
  await coordinator.resetFallback(ref);
  assert.equal(primary.state.callCount + backup.state.callCount, 1);
  assert.equal(coordinator.snapshot(ref)!.model.provider, b.provider);
  await coordinator.resume(ref, "continue after reviewed reset");
  const state = await coordinator.wait(ref);
  assert.equal(state.status, "settled", state.error ?? "no error");
  assert.equal(state.telemetry.requests, 2);
  assert.equal(state.model.provider, b.provider);
});

test("unmeasured failed usage is marked as incomplete cost rather than measured zero", async (t) => {
  const { root, runtime, direct, coordinator } = await fixture(t);
  const { primary } = providers(runtime);
  runtime.registerNativeProvider({
    ...primary.provider,
    streamSimple: (selected) => {
      const stream = createAssistantMessageEventStream();
      const message = {
        ...fauxAssistantMessage("", { stopReason: "error", errorMessage: "401 unauthorized" }),
        api: selected.api,
        provider: selected.provider,
        model: selected.id,
      };
      stream.push({ type: "error", reason: "error", error: message });
      stream.end();
      return stream;
    },
  });
  await configure(root, { tools: ["read"], models: [a], fallback: [a] });
  const ref = await direct("failed dispatch with unknown usage");
  const state = await coordinator.wait(ref);
  assert.equal(state.status, "failed");
  assert.equal(state.telemetry.requests, 1);
  assert.equal(state.fallback!.attempts[0].usageKnown, false);
  assert.equal(state.telemetry.costIncomplete, true);
});

test("operator reset is serialized and stop wins pending public auth revalidation", async (t) => {
  const { root, runtime, direct, coordinator } = await fixture(t);
  const { primary } = providers(runtime);
  primary.setResponses([fauxAssistantMessage("idle retained child")]);
  await configure(root, { tools: ["read"], models: [a], fallback: [a] });
  const ref = await direct("reset cancellation");
  const original = await coordinator.wait(ref);
  let entered!: () => void;
  let release!: () => void;
  const authEntered = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const authReady = new Promise<void>((resolve) => {
    release = resolve;
  });
  t.mock.method(ModelRegistry.prototype, "getApiKeyAndHeaders", async () => {
    entered();
    await authReady;
    return { ok: true as const };
  });
  const reset = coordinator.resetFallback(ref);
  await authEntered;
  try {
    await assert.rejects(coordinator.resetFallback(ref), /idle retained/);
    await assert.rejects(coordinator.resume(ref, "no concurrent resume"), /duplicate resume/);
    await coordinator.stop(ref);
  } finally {
    release();
  }
  await assert.rejects(reset, /reset cancelled/);
  assert.deepEqual(coordinator.snapshot(ref), original);
  assert.equal(primary.state.callCount, 1);
});

test("fresh followup generation validates a new profile primary rather than inheriting the retained backup", async (t) => {
  const f = await fixture(t, {
    response: (context) => {
      const user = context.messages.findLast((message) => message.role === "user");
      const text =
        typeof user?.content === "string"
          ? user.content
          : (user?.content
              .filter((block) => block.type === "text")
              .map((block) => block.text)
              .join("") ?? "");
      if (
        context.messages.at(-1)?.role !== "toolResult" &&
        (text.startsWith("LAUNCH ") || text.startsWith("COORD "))
      ) {
        const launch = text.startsWith("LAUNCH ");
        return fauxAssistantMessage(
          fauxToolCall(
            launch ? "delegate_task" : "delegate_coordinate",
            JSON.parse(text.slice(launch ? 7 : 6)),
          ),
          { stopReason: "toolUse" },
        );
      }
      return fauxAssistantMessage("parent observed outcome");
    },
  });
  const { primary, backup } = providers(f.runtime);
  f.runtime.registerNativeProvider({
    ...primary.provider,
    auth: {
      apiKey: {
        name: "controlled primary",
        resolve: async ({ credential }) =>
          credential?.type === "api_key" ? { auth: { apiKey: credential.key } } : undefined,
      },
    },
  });
  primary.setResponses([fauxAssistantMessage("fresh generation primary")]);
  backup.setResponses([fauxAssistantMessage("initial available backup")]);
  await configure(f.root, { tools: ["read"], models: [a, b], fallback: [a, b] });
  const ref = await f.launch("primary unavailable", "general", false);
  const first = f.events.filter((event) => event.child.id === ref.id).at(-1)!.child;
  assert.equal(first.model.provider, b.provider);
  assert.equal(first.telemetry.requests, 1);
  await f.runtime.setRuntimeApiKey(a.provider, "controlled-ephemeral-primary-key");
  await f.session.prompt(
    "COORD " +
      JSON.stringify({
        action: "followup",
        target: { id: ref.id, generation: ref.generation },
        assignment: "new generation starts at its own primary",
      }),
  );
  const control = f.session.messages.findLast(
    (message) => message.role === "toolResult" && message.toolName === "delegate_coordinate",
  );
  assert.ok(control?.role === "toolResult" && !control.isError, JSON.stringify(control));
  await eventually(() =>
    f.events.some(
      (event) =>
        event.child.id === ref.id &&
        event.child.generation === 2 &&
        event.child.status === "settled",
    ),
  );
  const next = f.events
    .filter((event) => event.child.id === ref.id && event.child.generation === 2)
    .at(-1)!.child;
  assert.equal(next.model.provider, a.provider);
  assert.equal(next.telemetry.requests, 1);
  assert.equal(next.fallback!.attempts.length, 1);
  assert.equal(next.fallback!.skipped.length, 0);
  assert.equal(primary.state.callCount, 1);
  assert.equal(backup.state.callCount, 1);
});

test("native task schema carries fallback opt-in/narrowing without exposing chain or reset authority", async (t) => {
  const f = await fixture(t);
  const { primary, backup } = providers(f.runtime);
  backup.setResponses([
    fauxAssistantMessage("explicit suffix"),
    fauxAssistantMessage("task-narrowed primary"),
  ]);
  await configure(f.root, { tools: ["read"], models: [a, b], fallback: [a, b] });
  for (const fields of [{ model: b, fallback: true }, { models: [b] }]) {
    await f.session.prompt(
      "LAUNCH " +
        JSON.stringify({
          assignment: "native chain task",
          profile: "general",
          background: false,
          ...fields,
        }),
    );
    const result = f.session.messages.findLast(
      (message) => message.role === "toolResult" && message.toolName === "delegate_task",
    );
    assert.ok(result?.role === "toolResult" && !result.isError);
    assert.equal(f.events.at(-1)!.child.model.provider, b.provider);
  }
  const before = f.events.length;
  await f.session.prompt(
    "LAUNCH " +
      JSON.stringify({ assignment: "cannot supply a chain", profile: "general", fallback: [b, a] }),
  );
  const denied = f.session.messages.findLast(
    (message) => message.role === "toolResult" && message.toolName === "delegate_task",
  );
  assert.ok(denied?.role === "toolResult" && denied.isError);
  assert.equal(f.events.length, before);
  assert.equal(primary.state.callCount, 0);
  assert.equal(backup.state.callCount, 2);
});

for (const action of ["stop", "shutdown"] as const) {
  test(`${action} aborts quota backoff without another physical attempt or reset authority`, async (t) => {
    const { root, runtime, direct, coordinator } = await fixture(t);
    const { primary, backup } = providers(runtime);
    primary.setResponses([
      fauxAssistantMessage("quota", { stopReason: "error", errorMessage: "insufficient_quota" }),
    ]);
    backup.setResponses([fauxAssistantMessage("must not dispatch")]);
    await configure(root, { tools: ["read"], models: [a, b], fallback: [a, b] });
    const ref = await direct("cancel owned backoff");
    await eventually(() => coordinator.snapshot(ref)?.fallback?.failures === 1);
    if (action === "stop") await coordinator.stop(ref);
    else await coordinator.shutdown();
    const state = await coordinator.wait(ref);
    assert.equal(state.status, "cancelled");
    assert.equal(primary.state.callCount, 1);
    assert.equal(backup.state.callCount, 0);
    assert.equal(state.telemetry.requests, 1);
    await assert.rejects(coordinator.resetFallback(ref), /idle retained/);
  });
}

test("queued follow-up does not turn a terminal authentication failure into an automatic provider retry", async (t) => {
  const { root, runtime, direct, coordinator } = await fixture(t);
  const { primary, backup } = providers(runtime);
  let release!: () => void;
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  t.after(() => release());
  let ref!: Awaited<ReturnType<typeof direct>>;
  primary.setResponses([
    async () => {
      await ready;
      await coordinator.message(undefined, ref, "queued before authentication error", "followUp");
      return fauxAssistantMessage("auth denied", {
        stopReason: "error",
        errorMessage: "401 unauthorized",
      });
    },
  ]);
  await configure(root, { tools: ["read"], models: [a, b], fallback: [a, b] });
  ref = await direct("terminal error with pending work");
  release();
  const state = await coordinator.wait(ref);
  assert.equal(state.status, "failed");
  assert.equal(primary.state.callCount, 1);
  assert.equal(backup.state.callCount, 0);
  assert.equal(state.telemetry.requests, 1);
  assert.match(await readFile(state.transcript!, "utf8"), /401 unauthorized/);
});

test("paused operator reset admits a newly available authorized physical provider without inheriting parent routing", async (t) => {
  const { root, runtime, direct, coordinator } = await fixture(t);
  const { primary } = providers(runtime);
  primary.setResponses([
    fauxAssistantMessage("quota", { stopReason: "error", errorMessage: "insufficient_quota" }),
  ]);
  await configure(root, { tools: ["read"], models: [missing, a], fallback: [missing, a] });
  const ref = await direct("missing primary appears while paused", "general", {
    limits: { deadlineMs: 100, requests: 2 },
  });
  const paused = await coordinator.wait(ref);
  assert.equal(paused.status, "paused");
  assert.equal(paused.model.provider, a.provider);
  const late = fauxProvider({
    provider: missing.provider,
    models: [{ id: missing.id }],
    tokensPerSecond: 0,
  });
  late.setResponses([fauxAssistantMessage("newly available authorized primary")]);
  runtime.registerNativeProvider(late.provider);
  await coordinator.resetFallback(ref);
  assert.equal(late.state.callCount, 0);
  assert.equal(coordinator.snapshot(ref)!.model.provider, missing.provider);
  assert.equal(coordinator.snapshot(ref)!.telemetry.requests, 1);
  await coordinator.resume(ref, "resume on newly available primary");
  const state = await coordinator.wait(ref);
  assert.equal(state.status, "settled", state.error ?? "no error");
  assert.equal(late.state.callCount, 1);
  assert.equal(primary.state.callCount, 1);
  assert.equal(state.telemetry.requests, 2);
  assert.equal(state.effort, "off");
});

test("failed resume admission does not commit an availability-based route change or replenish budgets", async (t) => {
  const { root, runtime, direct, coordinator } = await fixture(t);
  const { primary, backup } = providers(runtime);
  primary.setResponses([fauxAssistantMessage("complete at budget")]);
  await configure(root, { tools: ["read"], models: [a, b], fallback: [a, b] });
  const ref = await direct("retain route until resume commits", "general", {
    limits: { requests: 1 },
  });
  const original = await coordinator.wait(ref);
  runtime.unregisterProvider(a.provider);
  await assert.rejects(
    coordinator.resume(ref, "no budget for newly available suffix"),
    /budget exhausted/,
  );
  assert.deepEqual(coordinator.snapshot(ref), original);
  assert.equal(backup.state.callCount, 0);
});

test("cancellation during image-capability advancement drains without a retry loop or backup dispatch", async (t) => {
  const f = await fixture(t, {
    tools: ["read", "capture_context", "delegate_task", "delegate_coordinate", "image_probe"],
    extra: (pi) =>
      pi.registerTool({
        name: "image_probe",
        label: "image",
        description: "Controlled leaf",
        parameters: Type.Object({}),
        execute: async () => ({
          content: [
            {
              type: "image",
              data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
              mimeType: "image/png",
            },
          ],
          details: {},
        }),
      }),
  });
  const primary = fauxProvider({
    provider: a.provider,
    models: [{ id: a.id, reasoning: true, input: ["text"] }],
    tokensPerSecond: 0,
  });
  const backup = fauxProvider({
    provider: b.provider,
    models: [{ id: b.id, reasoning: true, input: ["text", "image"] }],
    tokensPerSecond: 0,
  });
  f.runtime.registerNativeProvider(primary.provider);
  f.runtime.registerNativeProvider(backup.provider);
  primary.setResponses([
    fauxAssistantMessage(fauxToolCall("image_probe", {}), { stopReason: "toolUse" }),
  ]);
  await configure(f.root, {
    tools: ["read"],
    leafTools: ["image_probe"],
    models: [a, b],
    fallback: [a, b],
  });
  let ref: Awaited<ReturnType<typeof f.direct>> | undefined;
  let stopping: Promise<void> | undefined;
  const find = ModelRegistry.prototype.find;
  t.mock.method(
    ModelRegistry.prototype,
    "find",
    function (this: ModelRegistry, provider: string, id: string) {
      if (
        ref &&
        !stopping &&
        provider === b.provider &&
        f.coordinator
          .snapshot(ref)
          ?.fallback?.skipped.some((skip) => skip.reason.includes("image support"))
      )
        stopping = f.coordinator.stop(ref);
      return find.call(this, provider, id);
    },
  );
  ref = await f.direct("cancel capability skip");
  const state = await f.coordinator.wait(ref);
  await stopping;
  assert.ok(stopping, "stop occurred during capability advancement");
  assert.equal(state.status, "cancelled");
  assert.equal(primary.state.callCount, 1);
  assert.equal(backup.state.callCount, 0);
  assert.equal(state.telemetry.requests, 1);
});

test("an unavailable active model does not spend the next target's two native retries", async (t) => {
  const { root, runtime, direct, coordinator } = await fixture(t);
  const { primary, backup } = providers(runtime);
  const final = fauxProvider({
    provider: missing.provider,
    models: [{ id: missing.id }],
    tokensPerSecond: 0,
  });
  runtime.registerNativeProvider(final.provider);
  primary.setResponses([
    fauxAssistantMessage("transient", {
      stopReason: "error",
      errorMessage: "503 Service Unavailable",
    }),
  ]);
  backup.setResponses(
    Array.from({ length: 3 }, () =>
      fauxAssistantMessage("backup transient", {
        stopReason: "error",
        errorMessage: "503 Service Unavailable",
      }),
    ),
  );
  final.setResponses([fauxAssistantMessage("final target")]);
  await configure(root, { tools: ["read"], models: [a, b, missing], fallback: [a, b, missing] });
  const ref = await direct("skip unavailable active target", "general", {
    limits: { requests: 5 },
  });
  await eventually(() => coordinator.snapshot(ref)?.fallback?.failures === 1);
  runtime.unregisterProvider(a.provider);
  const state = await coordinator.wait(ref);
  assert.equal(state.status, "settled", state.error ?? "no error");
  assert.equal(primary.state.callCount, 1);
  assert.equal(backup.state.callCount, 3);
  assert.equal(final.state.callCount, 1);
  assert.equal(state.telemetry.requests, 5);
  assert.deepEqual(
    state.fallback!.attempts.map((attempt) => attempt.target.provider),
    [a.provider, b.provider, b.provider, b.provider, missing.provider],
  );
});
