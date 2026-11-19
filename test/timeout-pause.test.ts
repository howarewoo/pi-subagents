import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { fixture, eventually } from "./fixtures.ts";
import { Type } from "typebox";
import { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { DEFAULT_POLICY } from "../src/scheduling.ts";

const userText = (context: Parameters<import("@earendil-works/pi-ai").FauxResponseFactory>[0]) => {
  const user = context.messages.filter((message) => message.role === "user").at(-1);
  return typeof user?.content === "string"
    ? user.content
    : (user?.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("") ?? "");
};

test(
  "deadline windows preserve the actual SDK context and cumulative counters; duplicate resumes refuse",
  { timeout: 10000 },
  async (t) => {
    let release!: () => void;
    let markEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      markEntered = resolve;
    });
    let gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const requests: unknown[] = [];
    const f = await fixture(t, {
      speed: 0,
      extra: (pi) => {
        pi.on("tool_call", async (event) => {
          if (event.toolName === "read") {
            markEntered();
            await gate;
          }
        });
      },
      response: (context) => {
        const text = userText(context);
        // Root completion previews are data, not another child assignment.
        const first = context.messages.find((message) => message.role === "user");
        if (
          JSON.stringify(first).includes("LAUNCH ") &&
          !text.startsWith("LAUNCH ") &&
          !text.startsWith("CONTROL ")
        )
          return fauxAssistantMessage("completion acknowledged");
        if (text.startsWith("LAUNCH "))
          return context.messages.at(-1)?.role === "toolResult"
            ? fauxAssistantMessage("launched")
            : fauxAssistantMessage(fauxToolCall("delegate_task", JSON.parse(text.slice(7))), {
                stopReason: "toolUse",
              });
        requests.push(structuredClone(context));
        if (text === "finish") return fauxAssistantMessage("completed with history");
        return fauxAssistantMessage(
          [
            { type: "text", text: "remember this assistant instruction" },
            fauxToolCall("read", { path: "input.txt" }),
          ],
          { stopReason: "toolUse" },
        );
      },
    });
    await writeFile(join(f.root, "input.txt"), "remember this tool result");
    // The zero-speed provider uses microtasks. Hold the admission deadline until
    // the real permission hook is entered, regardless of setup time under load.
    t.mock.timers.enable({ apis: ["setTimeout"] });
    await f.session.prompt(
      "LAUNCH " +
        JSON.stringify({
          assignment: "original assignment",
          profile: "general",
          background: true,
          limits: { deadlineMs: 100 },
        }),
    );
    await entered;
    const ref = f.events.at(-1)!.child;
    t.mock.timers.tick(100);
    t.mock.timers.reset();
    await eventually(() => f.events.some((event) => event.child.status === "pausing"));
    assert.equal(f.events.at(-1)!.child.writerLease, false);
    assert.equal(f.events.at(-1)!.child.disposed, false);
    release();
    await eventually(() => f.events.at(-1)!.child.status === "paused");
    const paused = f.events.at(-1)!.child;
    assert.equal(paused.retainedContext, true);
    assert.equal(paused.artifacts, undefined);
    assert.equal(paused.telemetry.requests, 1);
    assert.equal(paused.toolCalls, 1);
    // Use the model-only control, exercising the registry owned by the extension.
    await eventually(() => !f.session.isStreaming);
    f.model.setResponses([
      fauxAssistantMessage(
        fauxToolCall("delegate_coordinate", {
          action: "resume",
          target: { id: ref.id, generation: ref.generation },
          assignment: "finish",
        }),
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("resumed"),
      (context) => {
        requests.push(structuredClone(context));
        return fauxAssistantMessage("completed with history");
      },
    ]);
    await f.session.prompt("resume now");
    await eventually(() => f.events.at(-1)!.child.disposed);
    const final = f.events.at(-1)!.child;
    assert.equal(final.id, ref.id);
    assert.equal(final.generation, ref.generation);
    assert.equal(final.window, 2);
    assert.equal(final.status, "settled");
    assert.equal(final.toolCalls, 1);
    assert.equal(final.telemetry.requests, 2);
    const actual = JSON.stringify(requests.at(-1));
    assert.match(actual, /original assignment/);
    assert.match(actual, /remember this assistant instruction/);
    assert.match(actual, /remember this tool result|aborted/i);
    assert.match(actual, /finish/);
    assert.equal(DEFAULT_POLICY.deadlineMs, 0);
  },
);

test(
  "default policy never pauses for elapsed time; tasks may set a cap but cannot broaden an operator cap",
  { timeout: 10000 },
  async (t) => {
    let release!: () => void;
    let markEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      markEntered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const f = await fixture(t, {
      speed: 0,
      extra: (pi) => {
        pi.on("tool_call", async (event) => {
          if (event.toolName === "read") {
            markEntered();
            await gate;
          }
        });
      },
      response: (context) =>
        userText(context) === "long" && context.messages.at(-1)?.role !== "toolResult"
          ? fauxAssistantMessage(fauxToolCall("read", { path: "input.txt" }), {
              stopReason: "toolUse",
            })
          : fauxAssistantMessage("done"),
    });
    await writeFile(join(f.root, "input.txt"), "data");
    // Capture the fixture context with real timers, then mock admission/elapsed time.
    await f.coordinator.wait(await f.direct("warm up"));
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const ref = await f.direct("long");
    assert.equal(f.coordinator.snapshot(ref)!.limits.deadlineMs, 0);
    await entered;
    t.mock.timers.tick(25 * 60 * 60 * 1000);
    t.mock.timers.reset();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(f.coordinator.snapshot(ref)!.status, "running");
    release();
    const done = await f.coordinator.wait(ref);
    assert.equal(done.status, "settled");
    assert.equal(done.pauseReason, undefined);
    assert.equal(
      f.events.some((event) => event.child.id === ref.id && event.child.status === "pausing"),
      false,
    );
    // A positive task cap narrows a disabled deadline; it cannot exceed an operator cap.
    const capped = await f.direct("warm up", "general", { limits: { deadlineMs: 5000 } });
    assert.equal(f.coordinator.snapshot(capped)!.limits.deadlineMs, 5000);
    await f.coordinator.wait(capped);
    f.coordinator.configure({ ...DEFAULT_POLICY, deadlineMs: 1000 });
    await assert.rejects(
      f.direct("broaden", "general", { limits: { deadlineMs: 2000 } }),
      /broadened limit: deadlineMs/,
    );
    await assert.rejects(
      f.direct("disable", "general", { limits: { deadlineMs: 0 } }),
      /broadened limit: deadlineMs/,
    );
  },
);

test(
  "paused registry revalidates policy without losing context and stop wins a pending resume",
  { timeout: 10000 },
  async (t) => {
    const f = await fixture(t, { speed: 100 });
    await mkdir(join(f.root, "operator"), { recursive: true });
    await writeFile(
      join(f.root, "operator", "delegation.json"),
      JSON.stringify({ scheduling: { deadlineMs: 50 } }),
    );
    f.coordinator.configure({ ...DEFAULT_POLICY, deadlineMs: 50 });
    const ref = await f.direct("long response ".repeat(100));
    const paused = await f.coordinator.wait(ref);
    assert.equal(paused.status, "paused");
    const messages = f.coordinator.messages(ref);
    await writeFile(
      join(f.root, "operator", "delegation.json"),
      JSON.stringify({ general: { tools: ["read"] } }),
    );
    await assert.rejects(f.coordinator.resume(ref, "continue"), /grant revoked/);
    assert.deepEqual(f.coordinator.messages(ref), messages);
    assert.equal(f.coordinator.snapshot(ref)!.status, "paused");
    await writeFile(join(f.root, "operator", "delegation.json"), "{}");
    const resume = f.coordinator.resume(ref, "continue");
    await assert.rejects(f.coordinator.resume(ref, "duplicate"), /duplicate/);
    await f.coordinator.stop(ref);
    await assert.rejects(resume, /cancel|active|no longer/i);
    assert.equal(f.coordinator.snapshot(ref)!.disposed, true);
    assert.equal(f.coordinator.snapshot(ref)!.status, "cancelled");
  },
);

test(
  "repeat pause/resume windows retain requests/tools and waiters bind to each window",
  { timeout: 10000 },
  async (t) => {
    let release!: () => void;
    let gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered = 0;
    const contexts: unknown[] = [];
    const f = await fixture(t, {
      speed: 0,
      extra: (pi) => {
        pi.on("tool_call", async (event) => {
          if (event.toolName === "read") {
            entered++;
            await gate;
          }
        });
      },
      response: (context) => {
        if (
          context.messages.at(-1)?.role === "toolResult" &&
          userText(context) === "capture fixture context"
        )
          return fauxAssistantMessage("captured");
        contexts.push(structuredClone(context));
        return userText(context) === "finish"
          ? fauxAssistantMessage("done")
          : fauxAssistantMessage(fauxToolCall("read", { path: "input.txt" }), {
              stopReason: "toolUse",
            });
      },
    });
    await writeFile(join(f.root, "input.txt"), "data");
    f.coordinator.configure({ ...DEFAULT_POLICY, deadlineMs: 60 });
    const ref = await f.direct("original");
    for (let cycle = 1; cycle <= 2; cycle++) {
      const waiter = f.coordinator.wait(ref);
      await eventually(() => entered === cycle);
      await eventually(() => f.coordinator.snapshot(ref)!.status === "pausing");
      release();
      const paused = await waiter;
      assert.equal(paused.status, "paused");
      assert.equal(paused.telemetry.requests, cycle);
      assert.equal(paused.toolCalls, cycle);
      assert.equal(paused.window, cycle);
      gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      await f.coordinator.resume(ref, cycle === 2 ? "finish" : "again");
    }
    const final = await f.coordinator.wait(ref);
    assert.equal(final.status, "settled");
    assert.equal(final.window, 3);
    assert.equal(final.telemetry.requests, 3);
    assert.equal(final.toolCalls, 2);
    assert.match(JSON.stringify(contexts.at(-1)), /original/);
    assert.match(JSON.stringify(contexts.at(-1)), /again/);
    assert.equal(f.events.filter((event) => event.child.status === "paused").length, 2);
  },
);

test(
  "parent deadline preserves active subtree; children require explicit resume after the exact parent",
  { timeout: 10000 },
  async (t) => {
    let releaseChild!: () => void;
    let releaseParent!: () => void;
    const childGate = new Promise<void>((resolve) => {
      releaseChild = resolve;
    });
    const parentGate = new Promise<void>((resolve) => {
      releaseParent = resolve;
    });
    const contexts: unknown[] = [];
    let parentHolding = false;
    const f = await fixture(t, {
      speed: 0,
      extra: (pi) => {
        pi.on("tool_call", async (event) => {
          if (event.toolName === "read") {
            if (event.input.path === "hold.txt") {
              parentHolding = true;
              await parentGate;
            } else await childGate;
          }
        });
      },
      response: (context) => {
        const text = userText(context);
        // Root completion previews are data, not another child assignment.
        const first = context.messages.find((message) => message.role === "user");
        if (
          JSON.stringify(first).includes("LAUNCH ") &&
          !text.startsWith("LAUNCH ") &&
          !text.startsWith("CONTROL ")
        )
          return fauxAssistantMessage("completion acknowledged");
        if (text.startsWith("LAUNCH ") || text.startsWith("CONTROL "))
          return context.messages.at(-1)?.role === "toolResult"
            ? fauxAssistantMessage("ack")
            : fauxAssistantMessage(
                fauxToolCall(
                  text.startsWith("LAUNCH ") ? "delegate_task" : "delegate_coordinate",
                  JSON.parse(text.slice(text.startsWith("LAUNCH ") ? 7 : 8)),
                ),
                { stopReason: "toolUse" },
              );
        contexts.push(structuredClone(context));
        if (text === "parent")
          return fauxAssistantMessage(
            fauxToolCall("delegate_task", { assignment: "child", profile: "general" }),
            { stopReason: "toolUse" },
          );
        if (text === "hold parent")
          return fauxAssistantMessage(fauxToolCall("read", { path: "hold.txt" }), {
            stopReason: "toolUse",
          });
        if (text === "finish child") return fauxAssistantMessage("child completed");
        return fauxAssistantMessage(fauxToolCall("read", { path: "input.txt" }), {
          stopReason: "toolUse",
        });
      },
    });
    await mkdir(join(f.root, "operator"), { recursive: true });
    await writeFile(
      join(f.root, "operator", "delegation.json"),
      JSON.stringify({ general: { tools: ["read"], spawn: ["general"] } }),
    );
    await writeFile(join(f.root, "input.txt"), "data");
    await writeFile(join(f.root, "hold.txt"), "data");
    await f.session.prompt(
      "LAUNCH " +
        JSON.stringify({
          assignment: "parent",
          profile: "general",
          background: true,
          limits: { deadlineMs: 250 },
        }),
    );
    await eventually(() =>
      f.events.some(
        (event) => event.child.depth === 2 && event.event?.type === "tool_execution_start",
      ),
    );
    await eventually(() =>
      f.events.some((event) => event.child.depth === 1 && event.child.status === "pausing"),
    );
    releaseChild();
    await eventually(() =>
      [1, 2].every((depth) =>
        f.events.some((event) => event.child.depth === depth && event.child.status === "paused"),
      ),
    );
    const parent = f.events.filter((event) => event.child.depth === 1).at(-1)!.child;
    const child = f.events.filter((event) => event.child.depth === 2).at(-1)!.child;
    const control = async (target: typeof parent, assignment: string) => {
      await eventually(() => !f.session.isStreaming);
      await f.session.prompt(
        "CONTROL " +
          JSON.stringify({
            action: "resume",
            target: { id: target.id, generation: target.generation },
            assignment,
          }),
      );
      return f.session.messages
        .filter(
          (message) => message.role === "toolResult" && message.toolName === "delegate_coordinate",
        )
        .at(-1)!;
    };
    const denied = await control(child, "finish child");
    assert.ok(denied.role === "toolResult" && denied.isError);
    try {
      await control(parent, "hold parent");
      await eventually(() => parentHolding);
      assert.equal(
        f.events.filter((event) => event.child.id === child.id).at(-1)!.child.status,
        "paused",
      );
      await control(child, "finish child");
      await eventually(() =>
        f.events.some((event) => event.child.id === child.id && event.child.status === "settled"),
      );
      const final = f.events.filter((event) => event.child.id === child.id).at(-1)!.child;
      assert.equal(final.generation, child.generation);
      assert.equal(final.parentGeneration, parent.generation);
      assert.match(JSON.stringify(contexts.at(-1)), /"child"/);
      assert.match(JSON.stringify(contexts.at(-1)), /finish child/);
    } finally {
      releaseParent();
    }
  },
);

test(
  "queue pauses without a session; continuation starts original assignment and shutdown disposes retained work",
  { timeout: 10000 },
  async (t) => {
    let release!: () => void;
    let markEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      markEntered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const contexts: unknown[] = [];
    const f = await fixture(t, {
      speed: 0,
      extra: (pi) => {
        pi.on("tool_call", async (event) => {
          if (event.toolName === "read") {
            markEntered();
            await gate;
          }
        });
      },
      response: (context) => {
        contexts.push(structuredClone(context));
        return userText(context) === "active"
          ? fauxAssistantMessage(fauxToolCall("read", { path: "input.txt" }), {
              stopReason: "toolUse",
            })
          : fauxAssistantMessage("done");
      },
    });
    await writeFile(join(f.root, "input.txt"), "data");
    // Control only the deadline clock: SDK setup and zero-speed responses may take
    // arbitrarily long in real time, but must not consume a test execution window.
    t.mock.timers.enable({ apis: ["setTimeout"] });
    f.coordinator.configure({ ...DEFAULT_POLICY, concurrency: 1, deadlineMs: 1000 });
    const active = await f.direct("active");
    await entered;
    f.coordinator.configure({ ...DEFAULT_POLICY, concurrency: 1, deadlineMs: 60 });
    const queued = await f.direct("original queued assignment");
    assert.equal(f.coordinator.snapshot(queued)!.status, "queued");
    t.mock.timers.tick(60);
    const result = await f.coordinator.wait(queued);
    assert.equal(result.status, "paused");
    assert.equal(result.retainedContext, false);
    assert.equal(result.transcript, undefined);
    assert.equal(result.pauseReason, "deadline");
    assert.equal(result.telemetry.requests, null);
    await mkdir(join(f.root, "operator"), { recursive: true });
    await writeFile(
      join(f.root, "operator", "delegation.json"),
      JSON.stringify({ scheduling: { concurrency: 1, deadlineMs: 60 } }),
    );
    await f.coordinator.resume(queued, "continuation instructions");
    assert.equal(f.coordinator.snapshot(queued)!.status, "queued");
    // The continuation can itself expire before first dispatch; accepted text must survive.
    t.mock.timers.tick(60);
    const pausedAgain = await f.coordinator.wait(queued);
    assert.equal(pausedAgain.status, "paused");
    assert.equal(pausedAgain.retainedContext, false);
    assert.equal(pausedAgain.transcript, undefined);
    assert.equal(pausedAgain.telemetry.requests, null);
    // Retain a real SDK session for shutdown, rather than asserting cleanup of
    // only the queued entry that will already be disposed on successful completion.
    t.mock.timers.tick(880);
    assert.equal(f.coordinator.snapshot(active)!.status, "pausing");
    release();
    const retained = await f.coordinator.wait(active);
    assert.equal(retained.status, "paused");
    assert.equal(retained.retainedContext, true);
    assert.equal(retained.disposed, false);
    await f.coordinator.resume(queued, "second continuation instructions");
    // Do not advance the deadline during first dispatch and SDK startup.
    const final = await f.coordinator.wait(queued);
    assert.equal(final.status, "settled");
    assert.equal(final.telemetry.requests, 1);
    assert.match(JSON.stringify(contexts.at(-1)), /original queued assignment/);
    assert.match(JSON.stringify(contexts.at(-1)), /continuation instructions/);
    assert.match(JSON.stringify(contexts.at(-1)), /second continuation instructions/);
    await f.coordinator.shutdown();
    assert.equal(f.coordinator.snapshot(queued)!.disposed, true);
    assert.equal(f.coordinator.snapshot(active)!.disposed, true);
    assert.equal(f.coordinator.snapshot(active)!.status, "cancelled");
    t.mock.timers.reset();
  },
);

test(
  "structured submission remains provisional through pause and finalizes only on actual completion",
  { timeout: 10000 },
  async (t) => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const f = await fixture(t, {
      speed: 0,
      extra: (pi) => {
        pi.on("tool_call", async (event) => {
          if (event.toolName === "read") await gate;
        });
      },
      response: (context) => {
        const text = userText(context);
        // Root completion previews are data, not another child assignment.
        const first = context.messages.find((message) => message.role === "user");
        if (
          JSON.stringify(first).includes("LAUNCH ") &&
          !text.startsWith("LAUNCH ") &&
          !text.startsWith("CONTROL ")
        )
          return fauxAssistantMessage("completion acknowledged");
        if (text.startsWith("LAUNCH ") || text.startsWith("CONTROL "))
          return context.messages.at(-1)?.role === "toolResult"
            ? fauxAssistantMessage("ack")
            : fauxAssistantMessage(
                fauxToolCall(
                  text.startsWith("LAUNCH ") ? "delegate_task" : "delegate_coordinate",
                  JSON.parse(text.slice(text.startsWith("LAUNCH ") ? 7 : 8)),
                ),
                { stopReason: "toolUse" },
              );
        if (text === "finish") return fauxAssistantMessage("done");
        return fauxAssistantMessage(
          fauxToolCall(
            context.messages.some(
              (message) => message.role === "toolResult" && message.toolName === "submit_result",
            )
              ? "read"
              : "submit_result",
            context.messages.some(
              (message) => message.role === "toolResult" && message.toolName === "submit_result",
            )
              ? { path: "input.txt" }
              : { value: { value: 42 } },
          ),
          { stopReason: "toolUse" },
        );
      },
    });
    await writeFile(join(f.root, "input.txt"), "data");
    await f.session.prompt(
      "LAUNCH " +
        JSON.stringify({
          assignment: "submit then wait",
          profile: "general",
          background: true,
          limits: { deadlineMs: 120 },
          resultSchema: {
            type: "object",
            properties: { value: { type: "integer" } },
            required: ["value"],
            additionalProperties: false,
          },
        }),
    );
    await eventually(() => f.events.at(-1)!.child.status === "pausing");
    release();
    await eventually(() => f.events.at(-1)!.child.status === "paused");
    const paused = f.events.at(-1)!.child;
    assert.deepEqual(paused.outcome, {
      validation: "submitted",
      attempts: 1,
      errors: [],
      value: { value: 42 },
      finalized: false,
    });
    assert.equal(paused.artifacts, undefined);
    await eventually(() => !f.session.isStreaming);
    await f.session.prompt(
      "CONTROL " +
        JSON.stringify({
          action: "resume",
          target: { id: paused.id, generation: paused.generation },
          assignment: "finish",
        }),
    );
    await eventually(() => f.events.at(-1)!.child.disposed);
    const final = f.events.at(-1)!.child;
    assert.equal(final.status, "settled");
    assert.deepEqual(final.outcome, { ...paused.outcome, finalized: true });
    assert.ok(final.artifacts?.structured);
  },
);

test("paused continuation respects capacity-bound FIFO and rejects queue overflow atomically", async (t) => {
  let release!: () => void;
  let entered = false;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const f = await fixture(t, {
    speed: 0,
    extra: (pi) => {
      pi.on("tool_call", async (event) => {
        if (event.toolName === "read") {
          entered = true;
          await gate;
        }
      });
    },
    response: (context) =>
      userText(context) === "hold"
        ? fauxAssistantMessage(fauxToolCall("read", { path: "input.txt" }), {
            stopReason: "toolUse",
          })
        : fauxAssistantMessage("done"),
  });
  await writeFile(join(f.root, "input.txt"), "data");
  f.coordinator.configure({ ...DEFAULT_POLICY, concurrency: 1 });
  const active = await f.direct("hold", "implementation");
  await eventually(() => entered);
  f.coordinator.configure({ ...DEFAULT_POLICY, concurrency: 1, deadlineMs: 40 });
  const paused = await f.direct("reader", "scout");
  assert.equal((await f.coordinator.wait(paused)).status, "paused");
  await mkdir(join(f.root, "operator"), { recursive: true });
  await writeFile(
    join(f.root, "operator", "delegation.json"),
    JSON.stringify({ scheduling: { concurrency: 1, queue: 1 } }),
  );
  f.coordinator.configure({ ...DEFAULT_POLICY, concurrency: 1, queue: 1 });
  const older = await f.direct("older writer", "implementation");
  const before = f.coordinator.snapshot(paused);
  await assert.rejects(f.coordinator.resume(paused, "must not jump"), /queue capacity/);
  assert.deepEqual(f.coordinator.snapshot(paused), before);
  assert.equal(f.coordinator.snapshot(older)!.status, "queued");
  const stopping = f.coordinator.stop(active);
  release();
  await stopping;
  assert.equal((await f.coordinator.wait(older)).status, "settled");
});

test("retained sessions reject revoked leaf/auth grants before resuming and execute only after restoration", async (t) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let effects = 0;
  const f = await fixture(t, {
    tools: "default",
    speed: 0,
    extra: (pi) => {
      pi.registerTool({
        name: "leaf",
        label: "leaf",
        description: "reviewed leaf",
        parameters: Type.Object({}),
        execute: async () => {
          effects++;
          return { content: [], details: {} };
        },
      });
      pi.on("tool_call", async (event) => {
        if (event.toolName === "read") await gate;
      });
    },
    response: (context) => {
      const text = userText(context);
      if (text === "capture fixture context") return fauxAssistantMessage("captured");
      if (text === "effect")
        return context.messages.at(-1)?.role === "toolResult"
          ? fauxAssistantMessage("effect done")
          : fauxAssistantMessage(fauxToolCall("leaf", {}), { stopReason: "toolUse" });
      return fauxAssistantMessage(fauxToolCall("read", { path: "input.txt" }), {
        stopReason: "toolUse",
      });
    },
  });
  f.session.setActiveToolsByName([...f.session.getActiveToolNames(), "leaf"]);
  await mkdir(join(f.root, "operator"), { recursive: true });
  const config = join(f.root, "operator", "delegation.json");
  const model = f.model.getModel();
  const models = [{ provider: model.provider, id: model.id, effort: "off" }];
  await writeFile(config, JSON.stringify({ general: { leafTools: ["leaf"], models } }));
  await writeFile(join(f.root, "input.txt"), "data");
  f.coordinator.configure({ ...DEFAULT_POLICY, deadlineMs: 60 });
  const ref = await f.direct("original");
  await eventually(() => f.coordinator.snapshot(ref)!.status === "pausing");
  release();
  const paused = await f.coordinator.wait(ref);
  await writeFile(config, JSON.stringify({ general: { leafTools: [], models } }));
  await assert.rejects(f.coordinator.resume(ref, "effect"), /leafTools grant revoked/);
  assert.equal(effects, 0);
  assert.deepEqual(f.coordinator.snapshot(ref), paused);
  await writeFile(config, JSON.stringify({ general: { leafTools: ["leaf"] } }));
  await assert.rejects(f.coordinator.resume(ref, "effect"), /model policy revoked/);
  assert.equal(effects, 0);
  assert.deepEqual(f.coordinator.snapshot(ref), paused);
  await writeFile(config, JSON.stringify({ general: { leafTools: ["leaf"], models } }));
  let denyAuth = true;
  const auth = ModelRegistry.prototype.getApiKeyAndHeaders;
  t.mock.method(
    ModelRegistry.prototype,
    "getApiKeyAndHeaders",
    async function (this: ModelRegistry, ...args: Parameters<typeof auth>) {
      return denyAuth
        ? { ok: false as const, error: "fixture credentials revoked" }
        : auth.apply(this, args);
    },
  );
  await assert.rejects(f.coordinator.resume(ref, "effect"), /credentials revoked/);
  assert.equal(effects, 0);
  assert.deepEqual(f.coordinator.snapshot(ref), paused);
  denyAuth = false;
  await f.coordinator.resume(ref, "effect");
  assert.equal((await f.coordinator.wait(ref)).status, "settled");
  assert.equal(effects, 1);
});

test("setup-paused SDK receives the original assignment on its first resumed prompt", async (t) => {
  const contexts: unknown[] = [];
  const f = await fixture(t, {
    speed: 0,
    response: (context) => {
      contexts.push(structuredClone(context));
      return fauxAssistantMessage("done");
    },
  });
  const warm = await f.direct("warm context");
  await f.coordinator.wait(warm);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let block = true;
  const auth = ModelRegistry.prototype.getApiKeyAndHeaders;
  t.mock.method(
    ModelRegistry.prototype,
    "getApiKeyAndHeaders",
    async function (this: ModelRegistry, ...args: Parameters<typeof auth>) {
      if (block) await gate;
      return auth.apply(this, args);
    },
  );
  f.coordinator.configure({ ...DEFAULT_POLICY, deadlineMs: 50 });
  const starting = f.direct("setup original assignment");
  await eventually(() =>
    f.events.some(
      (event) =>
        event.child.assignment === "setup original assignment" && event.child.status === "pausing",
    ),
  );
  block = false;
  release();
  const ref = await starting;
  assert.equal((await f.coordinator.wait(ref)).retainedContext, true);
  await f.coordinator.resume(ref, "setup continuation");
  assert.equal((await f.coordinator.wait(ref)).status, "settled");
  assert.match(JSON.stringify(contexts.at(-1)), /setup original assignment/);
  assert.match(JSON.stringify(contexts.at(-1)), /setup continuation/);
});

test(
  "ancestor deadline waits for an independently pausing child's existing SDK drain",
  { timeout: 10000 },
  async (t) => {
    let releaseChild!: () => void;
    let releaseParent!: () => void;
    let childGate = new Promise<void>((resolve) => {
      releaseChild = resolve;
    });
    let parentGate = new Promise<void>((resolve) => {
      releaseParent = resolve;
    });
    let parentHolding = false;
    let childEntered = 0;
    const contexts: unknown[] = [];
    const f = await fixture(t, {
      speed: 0,
      extra: (pi) => {
        pi.on("tool_call", async (event) => {
          if (event.toolName !== "read") return;
          if (event.input.path === "parent.txt") {
            parentHolding = true;
            await parentGate;
          } else {
            childEntered++;
            await childGate;
          }
        });
      },
      response: (context) => {
        const text = userText(context);
        contexts.push(structuredClone(context));
        if (text.startsWith("LAUNCH ") || text.startsWith("CONTROL "))
          return context.messages.at(-1)?.role === "toolResult"
            ? fauxAssistantMessage("ack")
            : fauxAssistantMessage(
                fauxToolCall(
                  text.startsWith("LAUNCH ") ? "delegate_task" : "delegate_coordinate",
                  JSON.parse(text.slice(text.startsWith("LAUNCH ") ? 7 : 8)),
                ),
                { stopReason: "toolUse" },
              );
        if (text === "hold parent again")
          return fauxAssistantMessage(fauxToolCall("read", { path: "parent.txt" }), {
            stopReason: "toolUse",
          });
        if (text === "parent")
          return fauxAssistantMessage(
            fauxToolCall(
              context.messages.at(-1)?.role === "toolResult" ? "read" : "delegate_task",
              context.messages.at(-1)?.role === "toolResult"
                ? { path: "parent.txt" }
                : { assignment: "child", profile: "scout", limits: { deadlineMs: 100 } },
            ),
            { stopReason: "toolUse" },
          );
        if (text === "finish child") return fauxAssistantMessage("child completed");
        if (text !== "child" && text !== "continue child") return fauxAssistantMessage("ack");
        return fauxAssistantMessage(fauxToolCall("read", { path: "child.txt" }), {
          stopReason: "toolUse",
        });
      },
    });
    await mkdir(join(f.root, "operator"), { recursive: true });
    await writeFile(
      join(f.root, "operator", "delegation.json"),
      JSON.stringify({ scheduling: { deadlineMs: 1000 } }),
    );
    await writeFile(join(f.root, "parent.txt"), "parent data");
    await writeFile(join(f.root, "child.txt"), "child data");
    const latest = (ref: { id: string }) =>
      f.events.filter((event) => event.child.id === ref.id).at(-1)!.child;
    const control = (args: object) => f.session.prompt("CONTROL " + JSON.stringify(args));
    const resume = (target: { id: string; generation: number }, assignment: string) =>
      control({
        action: "resume",
        target: { id: target.id, generation: target.generation },
        assignment,
      });
    try {
      const parent = await f.launch("parent");
      await eventually(() =>
        f.events.some((event) => event.child.depth === 2 && event.child.status === "pausing"),
      );
      const child = f.events.find((event) => event.child.depth === 2)!.child;
      releaseChild();
      await eventually(() => latest(child).status === "paused");
      await eventually(() => parentHolding);
      childGate = new Promise<void>((resolve) => {
        releaseChild = resolve;
      });
      // Root-side resume lets the child run independently of the parent's completed nested wait.
      await resume(child, "continue child");
      await eventually(() => childEntered === 2 && latest(child).status === "pausing");
      let parentReturned = false;
      const parentWait = control({
        action: "wait",
        target: { id: parent.id, generation: parent.generation },
        timeoutMs: 5000,
      }).then(() => {
        parentReturned = true;
      });
      await eventually(() => latest(parent).status === "pausing");
      releaseParent();
      await eventually(() =>
        f.events.some((event) => event.child.id === parent.id && event.event?.type === "agent_end"),
      );
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(parentReturned, false, "parent wait must remain pending until the child drains");
      assert.equal(latest(parent).status, "pausing");
      assert.equal(latest(parent).writerLease, false);
      assert.equal(latest(parent).disposed, false);
      assert.equal(latest(child).pauseReason, "deadline");
      assert.equal(latest(child).window, 2);
      releaseChild();
      await parentWait;
      assert.equal(latest(parent).status, "paused");
      assert.equal(latest(parent).writerLease, false);
      assert.equal(latest(child).status, "paused");
      assert.equal(latest(child).retainedContext, true);
      // Resuming the ancestor must not implicitly resume or replace the paused child.
      parentGate = new Promise<void>((resolve) => {
        releaseParent = resolve;
      });
      await resume(parent, "hold parent again");
      assert.equal(latest(child).status, "paused");
      await resume(child, "finish child");
      await eventually(() => latest(child).status === "settled");
      assert.match(JSON.stringify(contexts.at(-1)), /continue child/);
      assert.match(JSON.stringify(contexts.at(-1)), /finish child/);
    } finally {
      releaseParent();
      releaseChild();
    }
  },
);

test("resume reports the first revoked non-model grant and retains the paused conversation", async (t) => {
  const f = await fixture(t, { speed: 100 });
  const skill = join(f.root, "SKILL.md");
  await writeFile(
    skill,
    "---\nname: resume-skill\ndescription: Resume test skill\n---\nInstructions.",
  );
  await mkdir(join(f.root, "operator"), { recursive: true });
  const config = join(f.root, "operator", "delegation.json");
  const grants = {
    tools: ["read", "ls"],
    skills: [skill],
    spawn: ["review"],
    coordination: ["message"],
  };
  await writeFile(config, JSON.stringify({ general: grants }));
  f.coordinator.configure({ ...DEFAULT_POLICY, deadlineMs: 50 });
  const ref = await f.direct("long response ".repeat(100));
  const paused = await f.coordinator.wait(ref);
  assert.equal(paused.status, "paused");
  const messages = f.coordinator.messages(ref);
  for (const [key, value] of [
    ["tools", ["read"]],
    ["skills", []],
    ["spawn", []],
    ["coordination", []],
    ["coordination", undefined],
  ] as const) {
    await writeFile(config, JSON.stringify({ general: { ...grants, [key]: value } }));
    await assert.rejects(f.coordinator.resume(ref, "continue"), {
      message: `Resume denied: current ${key} grant revoked`,
    });
    assert.deepEqual(f.coordinator.snapshot(ref), paused);
    assert.deepEqual(f.coordinator.messages(ref), messages);
  }
  await writeFile(
    config,
    JSON.stringify({ general: { tools: ["read"], skills: [], spawn: [], coordination: [] } }),
  );
  await assert.rejects(f.coordinator.resume(ref, "continue"), {
    message: "Resume denied: current tools grant revoked",
  });
});
