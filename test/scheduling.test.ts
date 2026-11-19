import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { fixture, eventually } from "./fixtures.ts";
import {
  DEFAULT_POLICY,
  narrowLimits,
  resolveScheduling,
  tighterLimit,
  validatePolicy,
} from "../src/scheduling.ts";
import type { ChildSnapshot } from "../src/coordinator.ts";

type Fixture = Awaited<ReturnType<typeof fixture>>;
async function configure(f: Fixture, config: object) {
  await mkdir(join(f.root, "operator"), { recursive: true });
  await writeFile(join(f.root, "operator", "delegation.json"), JSON.stringify(config));
}
async function batch(f: Fixture, tasks: object[], background = false): Promise<ChildSnapshot[]> {
  await f.session.prompt("LAUNCH " + JSON.stringify({ tasks, background }));
  const message = f.session.messages
    .filter((message) => message.role === "toolResult" && message.toolName === "delegate_task")
    .at(-1);
  assert.ok(
    message?.role === "toolResult" && message.details && "children" in (message.details as object),
    JSON.stringify(message),
  );
  return (message.details as { children: ChildSnapshot[] }).children;
}
const task = (assignment: string, profile = "general") => ({ assignment, profile });
const userText = (context: Parameters<import("@earendil-works/pi-ai").FauxResponseFactory>[0]) => {
  const user = context.messages.find((message) => message.role === "user");
  return typeof user?.content === "string"
    ? user.content
    : (user?.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("") ?? "");
};

test("unconfigured tasks receive shipped budgets; explicit boundary and lower budgets are admitted", async (t) => {
  assert.equal(DEFAULT_POLICY.requests, 200);
  assert.equal(DEFAULT_POLICY.tools, 500);
  const f = await fixture(t);
  const results = await batch(f, [
    task("defaults"),
    { ...task("boundary"), limits: { requests: 200, tools: 500 } },
    { ...task("lower"), limits: { requests: 100, tools: 100 } },
  ]);
  assert.deepEqual(
    results.map(({ status, limits }) => ({
      status,
      requests: limits.requests,
      tools: limits.tools,
    })),
    [
      { status: "settled", requests: 200, tools: 500 },
      { status: "settled", requests: 200, tools: 500 },
      { status: "settled", requests: 100, tools: 100 },
    ],
  );
});

test("explicit operator budgets override defaults within unchanged ceilings; trusted projects only narrow", async (t) => {
  const f = await fixture(t);
  const operatorDir = join(f.root, "operator");
  await mkdir(join(f.root, ".pi"), { recursive: true });
  for (const budgets of [
    { requests: 100, tools: 100 },
    { requests: 1000, tools: 1000 },
  ]) {
    await configure(f, { scheduling: budgets });
    const operator = await resolveScheduling(f.root, false, operatorDir);
    assert.equal(operator.requests, budgets.requests);
    assert.equal(operator.tools, budgets.tools);
    await writeFile(
      join(f.root, ".pi", "delegation.json"),
      JSON.stringify({ scheduling: { requests: 50, tools: 50 } }),
    );
    const project = await resolveScheduling(f.root, true, operatorDir);
    assert.equal(project.requests, 50);
    assert.equal(project.tools, 50);
    for (const key of ["requests", "tools"] as const) {
      await writeFile(
        join(f.root, ".pi", "delegation.json"),
        JSON.stringify({ scheduling: { [key]: budgets[key] + 1 } }),
      );
      await assert.rejects(resolveScheduling(f.root, true, operatorDir), /broadened/);
    }
  }
});

test("deadline 0 is disabled by default; operators may set 0 or a cap up to 24h; projects and tasks only narrow", async (t) => {
  assert.equal(DEFAULT_POLICY.deadlineMs, 0);
  for (const deadlineMs of [0, 1, 1800000, 3600000, 86400000])
    assert.equal(validatePolicy({ deadlineMs }).deadlineMs, deadlineMs);
  for (const deadlineMs of [-1, 86400001, 1.5]) assert.throws(() => validatePolicy({ deadlineMs }));
  const capped = { ...DEFAULT_POLICY, deadlineMs: 60000 };
  assert.equal(narrowLimits(capped, { deadlineMs: 30000 }).deadlineMs, 30000);
  assert.throws(() => narrowLimits(capped, { deadlineMs: 0 }), /broadened/);
  assert.throws(() => narrowLimits(capped, { deadlineMs: 60001 }), /broadened/);
  assert.equal(narrowLimits(DEFAULT_POLICY, { deadlineMs: 0 }).deadlineMs, 0);
  assert.equal(narrowLimits(DEFAULT_POLICY, { deadlineMs: 86400000 }).deadlineMs, 86400000);
  assert.throws(() => narrowLimits(DEFAULT_POLICY, { deadlineMs: 86400001 }), /broadened/);
  assert.equal(tighterLimit("deadlineMs", 0, 500), 500);
  assert.equal(tighterLimit("deadlineMs", 700, 0), 700);
  assert.equal(tighterLimit("deadlineMs", 0, 0), 0);
  assert.equal(tighterLimit("deadlineMs", 700, 500), 500);
  assert.equal(tighterLimit("requests", 0, 5), 0);

  const f = await fixture(t);
  const operatorDir = join(f.root, "operator");
  await mkdir(join(f.root, ".pi"), { recursive: true });
  const project = (scheduling: object) =>
    writeFile(join(f.root, ".pi", "delegation.json"), JSON.stringify({ scheduling }));
  await configure(f, { scheduling: { deadlineMs: 60000 } });
  await project({ deadlineMs: 0 });
  await assert.rejects(resolveScheduling(f.root, true, operatorDir), /broadened/);
  await project({ deadlineMs: 30000 });
  assert.equal((await resolveScheduling(f.root, true, operatorDir)).deadlineMs, 30000);
  await configure(f, { scheduling: {} });
  assert.equal((await resolveScheduling(f.root, true, operatorDir)).deadlineMs, 30000);
  await project({ deadlineMs: 0 });
  assert.equal((await resolveScheduling(f.root, true, operatorDir)).deadlineMs, 0);
});

test("resume opens a fresh request/tool window and re-arms wrap-up; cumulative counters stay visible", async (t) => {
  for (const limits of [
    { requests: 10, tools: 30 },
    { requests: 10, tools: 3 },
  ])
    await t.test(JSON.stringify(limits), async (t) => {
      let calls = 0;
      const notices: number[] = [];
      const wrapUps: number[] = [];
      const f = await fixture(t, {
        speed: 0,
        response: (context) => {
          if (userText(context) !== "long assignment") return fauxAssistantMessage("captured");
          calls++;
          const guidance = context.messages
            .filter((message) => message.role === "system")
            .map((message) => message.content)
            .join("\n");
          if (guidance.includes("Approaching a delegation budget")) notices.push(calls);
          if (guidance.includes("Delegation wrap-up")) {
            wrapUps.push(calls);
            return fauxAssistantMessage("Partial report");
          }
          return fauxAssistantMessage(fauxToolCall("read", { path: "missing.txt" }), {
            stopReason: "toolUse",
          });
        },
      });
      const ref = await f.direct("long assignment", "scout", { limits });
      const first = await f.coordinator.wait(ref);
      assert.equal(first.status, "settled", JSON.stringify(first));
      await f.coordinator.resume(ref, "continue");
      const second = await f.coordinator.wait(ref);
      assert.equal(second.status, "settled", JSON.stringify(second));
      assert.equal(second.result, "Partial report");
      assert.equal(second.window, 2);
      assert.deepEqual(second.windowStart, {
        requests: first.telemetry.requests,
        toolCalls: first.toolCalls,
      });
      // Cumulative counters exceed one window's caps: each window was charged separately.
      assert.equal(second.telemetry.requests, 2 * first.telemetry.requests!);
      assert.equal(second.toolCalls, 2 * first.toolCalls);
      assert.ok(second.toolCalls > limits.tools || second.telemetry.requests! > limits.requests);
      assert.equal(wrapUps.length, 2);
      assert.equal(wrapUps[1], wrapUps[0] + first.telemetry.requests!);
      if (limits.tools === 30) assert.deepEqual(notices, [notices[0], notices[0] + 10]);
    });
});

test("request wrap-up reports through the last allowed request without starting an extra turn", async (t) => {
  let calls = 0;
  let notices = 0;
  const f = await fixture(t, {
    speed: 0,
    response: (context) => {
      if (userText(context) !== "long assignment") return fauxAssistantMessage("quick report");
      calls++;
      const guidance = context.messages
        .filter((message) => message.role === "system")
        .map((message) => message.content)
        .join("\n");
      if (guidance.includes("Approaching a delegation budget")) {
        notices++;
        assert.match(guidance, /2 model requests.*22 tool calls/);
      }
      if (guidance.includes("Delegation wrap-up")) {
        assert.equal(calls, 10);
        return fauxAssistantMessage("Partial report from the tools already run");
      }
      return fauxAssistantMessage(fauxToolCall("read", { path: "missing.txt" }), {
        stopReason: "toolUse",
      });
    },
  });
  const ref = await f.direct("long assignment", "scout", { limits: { requests: 10, tools: 30 } });
  const result = await f.coordinator.wait(ref);
  assert.equal(result.status, "settled");
  assert.equal(result.result, "Partial report from the tools already run");
  assert.equal(result.telemetry.requests, 10);
  assert.equal(result.toolCalls, 9);
  assert.equal(calls, 10);
  assert.equal(notices, 1);

  const quick = await f.direct("quick assignment", "scout", { limits: { requests: 10 } });
  const quickResult = await f.coordinator.wait(quick);
  assert.equal(quickResult.result, "quick report");
  assert.equal(quickResult.telemetry.requests, 1);
});

test("a child that ignores tool wrap-up cannot keep spending its unused request balance", async (t) => {
  const f = await fixture(t, {
    speed: 0,
    response: () =>
      fauxAssistantMessage(fauxToolCall("read", { path: "missing.txt" }), {
        stopReason: "toolUse",
      }),
  });
  const ref = await f.direct("keep calling tools", "scout", { limits: { requests: 10, tools: 3 } });
  const result = await f.coordinator.wait(ref);
  assert.equal(result.status, "cancelled");
  assert.equal(result.limitReason, "tools");
  assert.match(result.error!, /reserved reporting requests exhausted/);
  assert.equal(result.telemetry.requests, 3);
  assert.equal(result.toolCalls, 2);
});

test("whole batch preflight launches nothing for an invalid later assignment, grant or limit", async (t) => {
  const f = await fixture(t);
  for (const invalid of [
    task("  "),
    task("invalid", "unknown"),
    { ...task("request limit"), limits: { requests: DEFAULT_POLICY.requests + 1 } },
    { ...task("tool limit"), limits: { tools: DEFAULT_POLICY.tools + 1 } },
    { ...task("spawn"), spawn: ["general"] },
  ]) {
    await f.session.prompt(
      "LAUNCH " + JSON.stringify({ tasks: [task("must not start", "implementation"), invalid] }),
    );
    const message = f.session.messages
      .filter((message) => message.role === "toolResult" && message.toolName === "delegate_task")
      .at(-1);
    assert.ok(message?.role === "toolResult" && message.isError);
    assert.equal(f.events.length, 0);
  }
  await assert.rejects(readdir(join(f.root, "parent", "delegation")), /ENOENT/);
});

test("SDK batch queues FIFO at bounded concurrency, cancels before setup, preserves ordered mixed outcomes and delivers once", async (t) => {
  const f = await fixture(t, {
    speed: 500,
    response: (context) => {
      const text = userText(context);
      if (text.startsWith("LAUNCH "))
        return context.messages.at(-1)?.role === "toolResult"
          ? fauxAssistantMessage("parent done")
          : fauxAssistantMessage(fauxToolCall("delegate_task", JSON.parse(text.slice(7))), {
              stopReason: "toolUse",
            });
      return text === "fail"
        ? fauxAssistantMessage("", { stopReason: "error", errorMessage: "selected failure" })
        : fauxAssistantMessage(text);
    },
  });
  await configure(f, { scheduling: { concurrency: 1 } });
  const accepted = await batch(
    f,
    [task("long ".repeat(100)), task("cancel before setup"), task("fail"), task("last")],
    true,
  );
  assert.deepEqual(
    accepted.map((state) => state.status),
    ["setup", "queued", "queued", "queued"],
  );
  await f.session.prompt(`/subagent-stop ${accepted[1].id} 1`);
  await f.session.prompt(`/subagent-stop ${accepted[0].id} 1`);
  await eventually(() =>
    f.events.some((event) => event.child.id === accepted[3].id && event.child.disposed),
  );
  const final = accepted.map(
    (ref) => f.events.filter((event) => event.child.id === ref.id).at(-1)!.child,
  );
  assert.deepEqual(
    final.map((state) => state.status),
    ["cancelled", "cancelled", "failed", "settled"],
  );
  assert.equal(final[1].transcript, undefined);
  const live = new Set<string>();
  for (const event of f.events) {
    if (["setup", "running", "draining"].includes(event.child.status) && !event.child.disposed)
      live.add(event.child.id);
    if (event.child.disposed) live.delete(event.child.id);
    assert.ok(live.size <= 1, "setup/running/draining share the capacity bound");
  }
  await eventually(() =>
    f.session.messages.some(
      (message) => message.role === "custom" && JSON.stringify(message).includes(accepted[3].id),
    ),
  );
  const delivered = f.session.messages.filter(
    (message) => message.role === "custom" && JSON.stringify(message).includes(accepted[3].id),
  );
  assert.equal(delivered.length, 1);
  const text = JSON.stringify(delivered[0]);
  for (let i = 1; i < accepted.length; i++)
    assert.ok(text.indexOf(accepted[i - 1].id) < text.indexOf(accepted[i].id));
  for (const ref of accepted)
    assert.equal(
      f.events.filter((event) => event.child.id === ref.id && event.child.disposed).length,
      1,
    );
});

test("multiple batch writers overlap, retain real parent permission hooks and produce separate transcripts", async (t) => {
  let writes = 0;
  const f = await fixture(t, {
    extra: (pi) => {
      pi.on("tool_call", (event) => {
        if (event.toolName === "write") {
          writes++;
          return { block: true, reason: "parent denies" };
        }
      });
    },
    response: (context) => {
      const text = userText(context);
      if (context.messages.at(-1)?.role === "toolResult") return fauxAssistantMessage("done");
      return fauxAssistantMessage(
        fauxToolCall(
          text.startsWith("LAUNCH ") ? "delegate_task" : "write",
          text.startsWith("LAUNCH ")
            ? JSON.parse(text.slice(7))
            : { path: text + ".txt", content: "denied" },
        ),
        { stopReason: "toolUse" },
      );
    },
  });
  const result = await batch(f, [
    task("first", "implementation"),
    task("second", "implementation"),
  ]);
  assert.deepEqual(
    result.map((state) => state.status),
    ["settled", "settled"],
  );
  assert.equal(writes, 2);
  for (const state of result) {
    assert.match(await readFile(state.transcript!, "utf8"), /parent denies/);
    assert.equal(state.writerLease, false);
    await assert.rejects(readFile(join(f.root, state.assignment + ".txt")), /ENOENT/);
  }
  assert.notEqual(result[0].transcript, result[1].transcript);
  const secondSetup = f.events.findIndex(
    (event) => event.child.id === result[1].id && event.child.status === "setup",
  );
  const firstDisposed = f.events.findIndex(
    (event) => event.child.id === result[0].id && event.child.disposed,
  );
  assert.ok(secondSetup < firstDisposed);
});

test("default SDK child-local model-only tool spawns a scout grandchild, uses root permission hooks and direct usage once", async (t) => {
  let reads = 0;
  const f = await fixture(t, {
    extra: (pi) => {
      pi.on("tool_call", (event) => {
        if (event.toolName === "read") {
          reads++;
          return { block: true, reason: "grandchild read denied by parent" };
        }
      });
    },
    response: (context) => {
      const text = userText(context);
      if (context.messages.at(-1)?.role === "toolResult")
        return fauxAssistantMessage("done: " + text);
      const call = text.startsWith("LAUNCH ")
        ? JSON.parse(text.slice(7))
        : text === "child"
          ? task("grandchild", "scout")
          : undefined;
      return fauxAssistantMessage(
        fauxToolCall(call ? "delegate_task" : "read", call ?? { path: "never-read.txt" }),
        { stopReason: "toolUse" },
      );
    },
  });
  await configure(f, { general: { tools: ["read", "grep", "find", "ls"] } });
  const child = await f.launch("child", "general", false);
  const finals = f.events.filter((event) => event.child.disposed).map((event) => event.child);
  assert.equal(finals.length, 2);
  const grandchild = finals.find((state) => state.depth === 2)!;
  assert.equal(grandchild.parentId, child.id);
  assert.equal(grandchild.status, "settled");
  assert.equal(reads, 1);
  assert.match(await readFile(grandchild.transcript!, "utf8"), /grandchild read denied by parent/);
  assert.ok(finals.every((state) => state.telemetry.requests === 2));
  const parentResult = f.session.messages.find(
    (message) => message.role === "toolResult" && message.toolName === "delegate_task",
  );
  assert.ok(
    parentResult?.role === "toolResult" && !parentResult.usage,
    "registry child usage is not also charged to parent tool usage",
  );
});

test("nested capacity, depth, role, ancestor grants, spawn count reject visibly before descendant setup", async (t) => {
  for (const scenario of [
    "capacity",
    "depth",
    "role",
    "grants",
    "spawn",
    "request-depth",
    "request-spawn",
  ]) {
    await t.test(scenario, async (t) => {
      const target = scenario === "role" || scenario === "grants" ? "implementation" : "general";
      const f = await fixture(t, {
        response: (context) => {
          const text = userText(context);
          if (context.messages.at(-1)?.role === "toolResult") return fauxAssistantMessage("done");
          return fauxAssistantMessage(
            fauxToolCall(
              "delegate_task",
              text.startsWith("LAUNCH ")
                ? JSON.parse(text.slice(7))
                : task("forbidden descendant", target),
            ),
            { stopReason: "toolUse" },
          );
        },
      });
      const profile = "general";
      await configure(f, {
        [profile]: { spawn: scenario === "role" ? ["general"] : [target] },
        scheduling: {
          concurrency: scenario === "capacity" ? 1 : 2,
          depth: scenario === "depth" ? 1 : 2,
          spawns: scenario === "spawn" ? 0 : 8,
        },
      });
      const [child] = await batch(f, [
        {
          ...task("child", profile),
          ...(scenario === "request-depth"
            ? { limits: { depth: 1 } }
            : scenario === "request-spawn"
              ? { limits: { spawns: 0 } }
              : {}),
        },
      ]);
      const finals = f.events.filter((event) => event.child.disposed);
      assert.equal(finals.length, 1);
      assert.equal(finals[0].child.id, child.id);
      const disk = await readFile(finals[0].child.transcript!, "utf8");
      assert.match(
        disk,
        /Nested capacity unavailable|depth limit|spawn role denied|broaden ancestor grants|spawn limit/,
      );
      assert.equal(
        f.events.some((event) => event.child.depth > 1),
        false,
      );
    });
  }
});

test("execution deadlines pause; direct request and executable-tool limits cancel and dispose once", async (t) => {
  for (const limit of ["deadlineMs", "requests", "tools"] as const)
    await t.test(limit, async (t) => {
      const f = await fixture(t, {
        speed: limit === "deadlineMs" ? 50 : 10000,
        response: (context) => {
          const text = userText(context);
          if (text.startsWith("LAUNCH "))
            return context.messages.at(-1)?.role === "toolResult"
              ? fauxAssistantMessage("parent done")
              : fauxAssistantMessage(fauxToolCall("delegate_task", JSON.parse(text.slice(7))), {
                  stopReason: "toolUse",
                });
          return limit === "deadlineMs"
            ? fauxAssistantMessage("long response ".repeat(100))
            : fauxAssistantMessage(fauxToolCall("read", { path: "missing.txt" }), {
                stopReason: "toolUse",
              });
        },
      });
      const [result] = await batch(f, [
        { ...task("limited"), limits: { [limit]: limit === "deadlineMs" ? 50 : 1 } },
      ]);
      assert.equal(result.status, limit === "deadlineMs" ? "paused" : "cancelled");
      assert.equal(result.disposed, limit !== "deadlineMs");
      assert.equal(result.limitReason, limit === "deadlineMs" ? undefined : limit);
      if (limit === "deadlineMs") assert.equal(result.pauseReason, "deadline");
      assert.equal(
        f.events.filter((event) => event.child.id === result.id && event.child.disposed).length,
        limit === "deadlineMs" ? 0 : 1,
      );
      if (limit === "requests") assert.equal(result.telemetry.requests, 1);
      if (limit === "tools") assert.equal(result.toolCalls, 1);
    });
});

test("operator policy is finite and project can only narrow; queue and batch bounds are atomic", async (t) => {
  for (const value of [
    { concurrency: 0 },
    { concurrency: 17 },
    { depth: -1 },
    { requests: 0 },
    { requests: 1001 },
    { tools: 1001 },
    { deadlineMs: Infinity },
    { tools: 1.2 },
    { unknown: 1 },
  ])
    assert.throws(() => validatePolicy(value));
  const f = await fixture(t);
  await configure(f, { scheduling: { concurrency: 1, queue: 0, batch: 2 } });
  await mkdir(join(f.root, ".pi"), { recursive: true });
  await writeFile(
    join(f.root, ".pi", "delegation.json"),
    JSON.stringify({ scheduling: { concurrency: 2 } }),
  );
  await assert.rejects(resolveScheduling(f.root, true, join(f.root, "operator")), /broadened/);
  assert.equal((await resolveScheduling(f.root, false, join(f.root, "operator"))).concurrency, 1);
  await f.session.prompt("LAUNCH " + JSON.stringify({ tasks: [task("one"), task("two")] }));
  assert.equal(f.events.length, 0);
  assert.deepEqual(DEFAULT_POLICY.concurrency, 16);
});

test("bundled nested targets obey default depth and request revocation without regaining ancestor grants", async (t) => {
  for (const scenario of ["depth", "revoke", "subset"])
    await t.test(scenario, async (t) => {
      const f = await fixture(t, {
        speed: 0,
        response: (context) => {
          const text = userText(context);
          if (context.messages.at(-1)?.role === "toolResult") return fauxAssistantMessage("done");
          return fauxAssistantMessage(
            fauxToolCall(
              "delegate_task",
              text.startsWith("LAUNCH ")
                ? JSON.parse(text.slice(7))
                : task(text === "child" ? "grandchild" : "great-grandchild", "scout"),
            ),
            { stopReason: "toolUse" },
          );
        },
      });
      const [child] = await batch(f, [
        {
          ...task("child"),
          ...(scenario === "depth" ? {} : { spawn: scenario === "revoke" ? [] : ["scout"] }),
        },
      ]);
      const finals = f.events.filter((event) => event.child.disposed).map((event) => event.child);
      assert.equal(finals.length, scenario === "depth" ? 2 : 1);
      assert.ok(finals.every((state) => state.depth <= 2));
      const denied =
        scenario === "depth"
          ? finals.find((state) => state.depth === 2)!
          : finals.find((state) => state.id === child.id)!;
      assert.match(
        await readFile(denied.transcript!, "utf8"),
        scenario === "depth"
          ? /depth limit/
          : scenario === "revoke"
            ? /not found|Unknown tool|not available/i
            : /broaden ancestor grants/,
      );
    });
});

test("explicitly authorized writer-under-writer nesting uses immediate capacity and preserves separate effects", async (t) => {
  const f = await fixture(t, {
    speed: 0,
    response: (context) => {
      const text = userText(context);
      if (context.messages.at(-1)?.role === "toolResult") return fauxAssistantMessage("done");
      if (text.startsWith("LAUNCH "))
        return fauxAssistantMessage(fauxToolCall("delegate_task", JSON.parse(text.slice(7))), {
          stopReason: "toolUse",
        });
      return fauxAssistantMessage(
        fauxToolCall(
          text === "parent writer" ? "delegate_task" : "write",
          text === "parent writer"
            ? { assignment: "nested writer", profile: "implementation", spawn: [] }
            : { path: "nested.txt", content: "nested effect" },
        ),
        { stopReason: "toolUse" },
      );
    },
  });
  await configure(f, {
    implementation: { spawn: ["implementation"] },
    scheduling: { concurrency: 2 },
  });
  const parent = await f.launch("parent writer", "implementation", false);
  const finals = f.events.filter((event) => event.child.disposed).map((event) => event.child);
  assert.equal(finals.length, 2);
  assert.deepEqual(
    finals.map((state) => state.depth),
    [2, 1],
  );
  assert.equal(finals[0].parentId, parent.id);
  assert.ok(finals.every((state) => state.status === "settled" && !state.writerLease));
  assert.equal(await readFile(join(f.root, "nested.txt"), "utf8"), "nested effect");
  assert.notEqual(finals[0].transcript, finals[1].transcript);
});
