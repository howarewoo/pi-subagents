import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  fauxAssistantMessage,
  fauxToolCall,
  type FauxResponseFactory,
} from "@earendil-works/pi-ai";
import { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { fixture, eventually } from "./fixtures.ts";
import type { ChildRef, ChildSnapshot } from "../src/coordinator.ts";
import { resolveProfile } from "../src/profiles.ts";
import { DEFAULT_POLICY } from "../src/scheduling.ts";

const text: (context: Parameters<FauxResponseFactory>[0]) => string = (context) => {
  const message = context.messages.find((message) => message.role === "user");
  return typeof message?.content === "string"
    ? message.content
    : (message?.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("") ?? "");
};
const response: FauxResponseFactory = (context) => {
  const last = context.messages.at(-1);
  const users = context.messages.filter((message) => message.role === "user");
  const latest = users.at(-1);
  const current =
    typeof latest?.content === "string"
      ? latest.content
      : (latest?.content
          .filter((block) => block.type === "text")
          .map((block) => block.text)
          .join("") ?? "");
  if (current.startsWith("Delegation message "))
    return fauxAssistantMessage("recipient model saw " + current);
  if (last?.role === "toolResult")
    return fauxAssistantMessage("tool observed " + JSON.stringify(last));
  if (current.startsWith("LAUNCH "))
    return fauxAssistantMessage(fauxToolCall("delegate_task", JSON.parse(current.slice(7))), {
      stopReason: "toolUse",
    });
  if (current.startsWith("COORD "))
    return fauxAssistantMessage(fauxToolCall("delegate_coordinate", JSON.parse(current.slice(6))), {
      stopReason: "toolUse",
    });
  if (current.startsWith("RACE "))
    return fauxAssistantMessage(
      [
        fauxToolCall("delegate_coordinate", JSON.parse(current.slice(5))),
        fauxToolCall("delegate_coordinate", JSON.parse(current.slice(5))),
      ],
      { stopReason: "toolUse" },
    );
  if (text(context) === "nested")
    return fauxAssistantMessage(
      fauxToolCall("delegate_task", { assignment: "leaf", profile: "general" }),
      { stopReason: "toolUse" },
    );
  if (text(context) === "held")
    return fauxAssistantMessage(fauxToolCall("read", { path: "held.txt" }), {
      stopReason: "toolUse",
    });
  if (text(context) === "receive")
    return fauxAssistantMessage(
      fauxToolCall("delegate_coordinate", { action: "wait", timeoutMs: 60000 }),
      { stopReason: "toolUse" },
    );
  if (text(context) === "send-root")
    return fauxAssistantMessage(
      fauxToolCall("delegate_coordinate", { action: "message", text: "child evidence" }),
      { stopReason: "toolUse" },
    );
  if (text(context) === "spoof")
    return fauxAssistantMessage(
      fauxToolCall("delegate_coordinate", { action: "message", text: "forged", sender: "root" }),
      { stopReason: "toolUse" },
    );
  if (text(context) === "default-denied")
    return fauxAssistantMessage(fauxToolCall("delegate_coordinate", { action: "inbox" }), {
      stopReason: "toolUse",
    });
  if (text(context) === "submit")
    return fauxAssistantMessage(fauxToolCall("submit_result", { value: 7 }), {
      stopReason: "toolUse",
    });
  return fauxAssistantMessage("completed " + current);
};
type F = Awaited<ReturnType<typeof fixture>>;
async function config(f: F, value: object) {
  await mkdir(join(f.root, "operator"), { recursive: true });
  await writeFile(join(f.root, "operator", "delegation.json"), JSON.stringify(value));
}
async function control(f: F, args: object) {
  const input = args as { target?: ChildRef };
  await f.session.prompt(
    "COORD " +
      JSON.stringify({
        ...args,
        ...(input.target
          ? { target: { id: input.target.id, generation: input.target.generation } }
          : {}),
      }),
  );
  const result = f.session.messages
    .filter(
      (message) => message.role === "toolResult" && message.toolName === "delegate_coordinate",
    )
    .at(-1);
  assert.ok(result?.role === "toolResult", JSON.stringify(result));
  return result;
}
async function final(f: F, ref: ChildRef) {
  await eventually(() =>
    f.events.some(
      (event) =>
        event.child.id === ref.id &&
        event.child.generation === ref.generation &&
        event.child.disposed,
    ),
  );
  return f.events
    .filter((event) => event.child.id === ref.id && event.child.generation === ref.generation)
    .at(-1)!.child;
}

test("real SDK root/child inbox wait and authenticated sender visibility; default off and spoof rejection", async (t) => {
  const f = await fixture(t, { speed: 0, response });
  const denied = await f.launch("default-denied", "general", false);
  assert.match(
    await readFile((await final(f, denied)).transcript!, "utf8"),
    /not found|Unknown tool/i,
  );
  await config(f, { general: { coordination: ["message", "wait", "inbox"] } });
  const recipient = await f.launch("receive");
  await eventually(() =>
    f.events.some(
      (event) =>
        event.child.id === recipient.id &&
        event.event?.type === "tool_execution_start" &&
        event.event.toolName === "delegate_coordinate",
    ),
  );
  const sent = await control(f, { action: "message", target: recipient, text: "root evidence" });
  assert.equal(sent.isError, false, JSON.stringify(sent));
  const state = await final(f, recipient);
  assert.equal(state.status, "settled");
  assert.match(state.result, /root evidence/);
  assert.match(state.result, /sender.*root/);
  assert.equal(state.toolCalls, 1);
  const child = await f.launch("send-root", "general", false);
  const inbox = await control(f, { action: "inbox" });
  assert.deepEqual((inbox.details as { sender: ChildRef }[])[0].sender, {
    id: child.id,
    generation: child.generation,
  });
  assert.match(JSON.stringify(inbox.details), /child evidence/);
  assert.deepEqual((await control(f, { action: "inbox" })).details, []);
  const forged = await f.launch("spoof", "general", false);
  assert.match(
    await readFile((await final(f, forged)).transcript!, "utf8"),
    /sender|additional propert/i,
  );
  assert.deepEqual((await control(f, { action: "inbox" })).details, []);
  for (const target of [
    { id: "foreign-parent", generation: 1 },
    { ...recipient, generation: 99 },
  ]) {
    assert.equal((await control(f, { action: "message", target, text: "denied" })).isError, true);
  }
  assert.equal(
    (
      (await control(f, { action: "message", target: recipient, text: "late" })).details as {
        status: string;
      }
    ).status,
    "not-running",
  );
});

test("operator/project/request coordination grants only narrow, including descendant authority", async (t) => {
  const f = await fixture(t, { speed: 0, response });
  await mkdir(join(f.root, ".pi"));
  await writeFile(
    join(f.root, ".pi", "delegation.json"),
    JSON.stringify({ general: { coordination: ["message"] } }),
  );
  await assert.rejects(
    resolveProfile("general", f.root, true, join(f.root, "operator")),
    /mint coordination/,
  );
  await config(f, { general: { coordination: ["message", "wait"] } });
  assert.deepEqual(
    (await resolveProfile("general", f.root, true, join(f.root, "operator"))).profile.coordination,
    ["message"],
  );
  await f.session.prompt(
    'LAUNCH {"assignment":"no grants","profile":"general","coordination":["inbox"]}',
  );
  assert.equal(f.events.length, 0);
  await config(f, { general: { coordination: ["message"], spawn: ["general"] } });
  await f.session.prompt(
    'LAUNCH {"assignment":"nested","profile":"general","coordination":[],"background":false}',
  );
  const parent = f.events.filter((event) => event.child.disposed).at(-1)!.child;
  assert.equal(f.events.filter((event) => event.child.depth === 2).length, 0);
  assert.match(await readFile(parent.transcript!, "utf8"), /broaden ancestor grants/);
});

test("followup adopts a newly configured deadline over a disabled one and keeps a previous cap under a disabled policy", async (t) => {
  const f = await fixture(t, { speed: 0, response });
  const renew = async (target: ChildRef, assignment: string) => {
    const result = await control(f, { action: "followup", target, assignment });
    assert.equal(result.isError, false, JSON.stringify(result));
    return final(f, result.details as ChildSnapshot);
  };
  await f.session.prompt('LAUNCH {"assignment":"first","profile":"general","background":false}');
  const first = f.events.filter((event) => event.child.disposed).at(-1)!.child;
  assert.equal(first.limits.deadlineMs, 0);
  await config(f, { scheduling: { deadlineMs: 60000 } });
  const second = await renew(first, "capped");
  assert.equal(second.generation, 2);
  assert.equal(second.limits.deadlineMs, 60000);
  await config(f, {});
  const third = await renew(second, "still capped");
  assert.equal(third.generation, 3);
  assert.equal(third.limits.deadlineMs, 60000);
});

test("idle followup and park/revive use monotonic fresh generations, immutable artifacts and fresh submissions", async (t) => {
  const f = await fixture(t, { speed: 0, response });
  await config(f, { general: { coordination: ["inbox"] } });
  await f.session.prompt(
    'LAUNCH {"assignment":"submit","profile":"general","resultSchema":{"type":"integer"},"background":false}',
  );
  const first = f.events.filter((event) => event.child.disposed).at(-1)!.child;
  assert.equal(first.outcome?.value, 7);
  const original = await readFile(first.transcript!, "utf8");
  const artifact = await readFile(first.artifacts!.text!, "utf8");
  const nextResult = await control(f, {
    action: "followup",
    target: first,
    assignment: "missing submission",
  });
  assert.equal(nextResult.isError, false, JSON.stringify(nextResult));
  const next = nextResult.details as ChildSnapshot;
  assert.equal(next.id, first.id);
  assert.equal(next.generation, 2);
  const second = await final(f, next);
  assert.equal(second.status, "failed");
  assert.equal(second.outcome?.validation, "awaiting");
  assert.equal(second.outcome?.attempts, 0);
  assert.notEqual(second.transcript, first.transcript);
  assert.notEqual(second.artifacts?.text, first.artifacts?.text);
  assert.equal(await readFile(first.transcript!, "utf8"), original);
  assert.equal(await readFile(first.artifacts!.text!, "utf8"), artifact);
  assert.equal((await control(f, { action: "stop", target: first })).isError, true);
  assert.equal(
    (await control(f, { action: "message", target: first, text: "stale" })).isError,
    true,
  );
  assert.equal((await control(f, { action: "park", target: second })).isError, false);
  await config(f, { general: { tools: ["read"], coordination: [] } });
  const revived = await control(f, { action: "revive", target: second, assignment: "submit" });
  assert.equal(revived.isError, false);
  const third = await final(f, revived.details as ChildSnapshot);
  assert.equal(third.generation, 3);
  assert.equal(third.status, "settled");
  const transcript = await readFile(third.transcript!, "utf8");
  assert.ok(!transcript.includes('"name":"delegate_coordinate"'));
  assert.ok(!transcript.includes('"name":"grep"'));
  assert.equal(third.telemetry.requests, 2);
  const oldStatus = await control(f, { action: "status", target: first });
  assert.deepEqual((oldStatus.details as { snapshot: ChildSnapshot }).snapshot, first);
  assert.equal(
    (await control(f, { action: "revive", target: second, assignment: "stale" })).isError,
    true,
  );
});

test("renewal queues behind older admissions without changing identity listing order", async (t) => {
  const f = await fixture(t, { speed: 0, response });
  await config(f, {
    scheduling: { concurrency: 1, queue: 2 },
    general: { coordination: ["wait"] },
  });
  const first = await final(f, await f.launch("completed", "general", false));
  const blocker = await f.launch("receive");
  const waiting = (ref: ChildRef) =>
    f.events.some(
      (event) =>
        event.child.id === ref.id &&
        event.child.generation === ref.generation &&
        event.event?.type === "tool_execution_start" &&
        event.event.toolName === "delegate_coordinate",
    );
  await eventually(() => waiting(blocker));
  const older = await f.launch("receive");
  const renewed = await control(f, { action: "followup", target: first, assignment: "fresh work" });
  assert.equal(renewed.isError, false, JSON.stringify(renewed));
  const next = renewed.details as ChildSnapshot;
  assert.equal(next.generation, 2);
  assert.equal(next.status, "queued");
  await f.session.prompt('LAUNCH {"assignment":"overflow","profile":"general"}');
  const overflow = f.session.messages
    .filter((message) => message.role === "toolResult" && message.toolName === "delegate_task")
    .at(-1);
  assert.ok(overflow?.role === "toolResult" && overflow.isError);
  assert.match(JSON.stringify(overflow), /queue capacity/);
  const status = await control(f, { action: "status", target: next });
  assert.deepEqual(
    (status.details as { agents: ChildRef[] }).agents.map((agent) => agent.id),
    [first.id, blocker.id, older.id],
  );
  await control(f, { action: "stop", target: blocker });
  await eventually(() => waiting(older));
  assert.equal(
    f.events
      .filter((event) => event.child.id === next.id && event.child.generation === next.generation)
      .at(-1)!.child.status,
    "queued",
  );
  await control(f, { action: "stop", target: older });
  assert.equal((await final(f, next)).status, "settled");
});

test("native event waits timeout/cancel/shutdown and terminal outcomes without polling or leaked waiters", async (t) => {
  const f = await fixture(t, { speed: 0 });
  assert.deepEqual(await f.coordinator.coordinateWait(undefined, undefined, 1), {
    status: "timeout",
  });
  const abort = new AbortController();
  const waiting = f.coordinator.coordinateWait(undefined, undefined, 60000, abort.signal);
  abort.abort();
  assert.deepEqual(await waiting, { status: "cancelled" });
  const ref = await f.direct("done");
  const outcome = await f.coordinator.coordinateWait(undefined, ref, 60000);
  assert.equal(outcome.status, "outcome");
  const waiters = Array.from({ length: 64 }, () =>
    f.coordinator.coordinateWait(undefined, undefined, 60000),
  );
  await assert.rejects(f.coordinator.coordinateWait(undefined, undefined, 60000), /waiter limit/);
  await f.coordinator.shutdown();
  assert.ok((await Promise.all(waiters)).every((result) => result.status === "shutdown"));
});

for (const mode of ["steer", "followUp"] as const)
  test(`real SDK ${mode} receipt is queued before transcript delivery, never model acknowledgment`, async (t) => {
    let entered!: () => void, release!: () => void;
    const entry = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const f = await fixture(t, {
      speed: 0,
      response,
      extra: (pi) => {
        pi.on("tool_call", async (event) => {
          if (event.toolName === "read") {
            entered();
            await gate;
            return { block: true, reason: "controlled read barrier" };
          }
        });
      },
    });
    try {
      const child = await f.launch("held");
      await entry;
      assert.equal((await control(f, { action: "park", target: child })).isError, true);
      const pendingInbox = await control(f, {
        action: "message",
        target: child,
        text: "old-generation inbox only",
      });
      const sent = await control(f, {
        action: "message",
        target: child,
        text: "visible to recipient model",
        mode,
      });
      assert.equal(sent.isError, false, JSON.stringify(sent));
      assert.equal((sent.details as { status: string }).status, "queued");
      const id = (sent.details as { id: string }).id;
      release();
      const state = await final(f, child);
      assert.match(state.result, /visible to recipient model/);
      assert.match(await readFile(state.transcript!, "utf8"), /Delegation message/);
      const receipt = await control(f, { action: "wait", messageId: id, timeoutMs: 60000 });
      assert.equal((receipt.details as { status: string }).status, "message");
      assert.equal(
        (receipt.details as { message: { status: string } }).message.status,
        "delivered",
      );
      assert.equal(
        (await control(f, { action: "wait", messageId: "foreign", timeoutMs: 1 })).isError,
        true,
      );
      const successor = await control(f, {
        action: "followup",
        target: child,
        assignment: "fresh assignment",
      });
      const fresh = await final(f, successor.details as ChildSnapshot);
      const oldReceipt = await control(f, {
        action: "wait",
        messageId: (pendingInbox.details as { id: string }).id,
        timeoutMs: 60000,
      });
      assert.equal(
        (oldReceipt.details as { message: { status: string } }).message.status,
        "not-running",
      );
      assert.ok(!(await readFile(fresh.transcript!, "utf8")).includes("old-generation inbox only"));
      assert.equal(fresh.telemetry.requests, 1);
    } finally {
      release();
    }
  });

test("actual running identities reject self/cycle/queued waits and stop wakes a retained-permit waiter", async (t) => {
  const f = await fixture(t, { speed: 100 });
  f.coordinator.configure({ ...DEFAULT_POLICY, concurrency: 2 });
  await config(f, { general: { tools: ["read"], coordination: ["wait", "message", "inbox"] } });
  const a = await f.direct("a".repeat(2000));
  const b = await f.direct("b".repeat(2000));
  const c = await f.direct("queued");
  await assert.rejects(f.coordinator.coordinateWait(a, a, 60000), /Self wait/);
  await assert.rejects(f.coordinator.coordinateWait(a, c, 60000), /queued work/);
  // Fresh policy loads may complete in either order; exactly one opposing wait
  // must reject the cycle, and stopping the admitted sender must wake its waiter.
  const wait = (sender: ChildRef, target: ChildRef) =>
    f.coordinator.coordinateWait(sender, target, 60000).then(
      (value) => ({ sender, value, error: undefined }),
      (error: unknown) => ({ sender, value: undefined, error }),
    );
  const waiting = [wait(a, b), wait(b, a)];
  const rejected = await Promise.race(waiting);
  assert.match(String(rejected.error), /cycle/);
  const admitted = rejected.sender.id === a.id ? b : a;
  await assert.rejects(f.coordinator.message({ ...a, generation: 99 }, b, "spoof"), /stale/);
  await f.coordinator.stop(admitted);
  const results = await Promise.all(waiting);
  assert.deepEqual(results.find((result) => result.sender.id === admitted.id)!.value, {
    status: "cancelled",
  });
  assert.equal(results.filter((result) => result.error !== undefined).length, 1);
  assert.equal(f.coordinator.snapshot(rejected.sender)!.disposed, false);
  await f.coordinator.stopMany([rejected.sender, c]);
});

test("concurrent real root revive calls admit only one fresh generation and revalidate removed model auth", async (t) => {
  const f = await fixture(t, { speed: 0, response });
  const first = await final(f, await f.launch("completed", "general", false));
  await control(f, { action: "park", target: first });
  const args = {
    action: "revive",
    target: { id: first.id, generation: 1 },
    assignment: "new work",
  };
  await f.session.prompt("RACE " + JSON.stringify(args));
  const calls = f.session.messages
    .filter(
      (message) => message.role === "toolResult" && message.toolName === "delegate_coordinate",
    )
    .slice(-2);
  assert.equal(
    calls.filter((message) => message.role === "toolResult" && !message.isError).length,
    1,
  );
  assert.equal(
    calls.filter((message) => message.role === "toolResult" && message.isError).length,
    1,
  );
  const second = await final(f, { id: first.id, generation: 2 });
  assert.equal(
    f.events.filter(
      (event) =>
        event.child.id === first.id && event.child.generation === 2 && event.child.disposed,
    ).length,
    1,
  );
  await control(f, { action: "park", target: second });
  t.mock.method(ModelRegistry.prototype, "hasConfiguredAuth", () => false);
  const before = f.events.length;
  const denied = await control(f, {
    action: "revive",
    target: second,
    assignment: "auth unavailable",
  });
  assert.equal(
    denied.isError,
    true,
    "known unavailable model/auth fails synchronous policy preflight",
  );
  assert.match(JSON.stringify(denied), /unavailable|auth/i);
  assert.equal(f.events.length, before, "no successor identity/setup/dispatch on denied renewal");
});

test("bounded mailbox/input/retention with actual running SDK recipient", async (t) => {
  let entered!: () => void, release!: () => void;
  const entry = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const f = await fixture(t, {
    speed: 0,
    response,
    extra: (pi) => {
      pi.on("tool_call", async (event) => {
        if (event.toolName === "read") {
          entered();
          await gate;
          return { block: true, reason: "held" };
        }
      });
    },
  });
  await config(f, { general: { coordination: ["inbox", "wait", "message"] } });
  try {
    const child = await f.direct("held");
    await entry;
    await assert.rejects(f.coordinator.message(undefined, child, "字".repeat(1400)), /4096/);
    for (let batch = 0; batch < 8; batch++) {
      const receipts = [];
      for (let i = 0; i < 64; i++) {
        const receipt = await f.coordinator.message(
          undefined,
          child,
          `batch ${batch} message ${i}`,
        );
        assert.equal(receipt.status, "accepted");
        receipts.push(receipt);
      }
      const receiptWait = f.coordinator.coordinateWait(
        undefined,
        undefined,
        60000,
        undefined,
        receipts[0].id,
      );
      await assert.rejects(f.coordinator.message(undefined, child, "overflow"), /limit/);
      const messages = await f.coordinator.inbox(child);
      assert.equal(messages.length, 64);
      assert.ok(messages.every((message) => message.status === "delivered"));
      assert.equal(
        (await receiptWait).status,
        "message",
        "inbox consumption directly wakes receipt waiters without another SDK event",
      );
    }
    await assert.rejects(
      f.coordinator.message(undefined, child, "retention exhausted"),
      /retention/,
    );
  } finally {
    release();
  }
});

test("descendant followup/revival retains exact live parent generation, consumes spawn budget, rejects expired ownership", async (t) => {
  let entered!: () => void, release!: () => void;
  const held = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const childResponse: FauxResponseFactory = (context, ...rest) => {
    if (text(context) === "parent-hold") {
      const result = context.messages.filter((message) => message.role === "toolResult");
      if (result.length === 0)
        return fauxAssistantMessage(
          fauxToolCall("delegate_task", { assignment: "descendant", profile: "general" }),
          { stopReason: "toolUse" },
        );
      if (result.length === 1)
        return fauxAssistantMessage(fauxToolCall("read", { path: "hold-parent.txt" }), {
          stopReason: "toolUse",
        });
      return fauxAssistantMessage("parent finished");
    }
    return response(context, ...rest);
  };
  const f = await fixture(t, {
    speed: 0,
    response: childResponse,
    extra: (pi) => {
      pi.on("tool_call", async (event) => {
        if (event.toolName === "read") {
          entered();
          await gate;
          return { block: true, reason: "held ancestor" };
        }
      });
    },
  });
  await config(f, {
    scheduling: { concurrency: 2, spawns: 2 },
    general: { tools: ["read", "grep", "find", "ls"], spawn: ["general"], coordination: ["wait"] },
  });
  try {
    const parent = await f.launch("parent-hold");
    await held;
    const first = f.events
      .filter((event) => event.child.depth === 2 && event.child.disposed)
      .at(-1)!.child;
    assert.equal(first.parentId, parent.id);
    assert.equal(first.parentGeneration, 1);
    assert.equal((await control(f, { action: "park", target: first })).isError, false);
    const blocker = await f.launch("receive");
    await eventually(() =>
      f.events.some(
        (event) =>
          event.child.id === blocker.id &&
          event.event?.type === "tool_execution_start" &&
          event.event.toolName === "delegate_coordinate",
      ),
    );
    assert.equal(
      (await control(f, { action: "revive", target: first, assignment: "no capacity" })).isError,
      true,
    );
    assert.equal(
      f.events.filter((event) => event.child.id === first.id && event.child.generation === 2)
        .length,
      0,
    );
    await control(f, { action: "stop", target: blocker });
    await config(f, {
      scheduling: { concurrency: 2, spawns: 2 },
      general: { spawn: [], coordination: ["wait"] },
    });
    const revoked = await control(f, {
      action: "revive",
      target: first,
      assignment: "revoked parent role",
    });
    assert.equal(revoked.isError, true);
    assert.match(JSON.stringify(revoked), /Current ancestor spawn role denied/);
    await config(f, {
      scheduling: { concurrency: 2, spawns: 2 },
      general: { spawn: ["general"], tools: ["grep"], coordination: [] },
    });
    const renewed = await control(f, {
      action: "revive",
      target: first,
      assignment: "fresh descendant",
    });
    assert.equal(renewed.isError, false, JSON.stringify(renewed));
    const second = await final(f, renewed.details as ChildSnapshot);
    assert.equal(second.generation, 2);
    assert.equal(second.parentId, parent.id);
    assert.equal(second.parentGeneration, 1);
    assert.ok(
      !(await readFile(second.transcript!, "utf8")).includes('"name":"read"'),
      "current reduced ancestor grants are not regained",
    );
    assert.equal(
      (
        await control(f, {
          action: "followup",
          target: second,
          assignment: "spawn budget exceeded",
        })
      ).isError,
      true,
    );
    assert.equal(
      f.events.filter((event) => event.child.depth === 2 && event.child.generation === 3).length,
      0,
    );
    release();
    await final(f, parent);
    assert.equal(
      (await control(f, { action: "followup", target: second, assignment: "orphan" })).isError,
      true,
    );
    assert.equal((await control(f, { action: "park", target: second })).isError, true);
    const parentRenewal = await control(f, {
      action: "followup",
      target: parent,
      assignment: "fresh parent without spawning",
    });
    assert.equal(parentRenewal.isError, false, JSON.stringify(parentRenewal));
    const renewedParent = parentRenewal.details as ChildSnapshot;
    assert.equal(renewedParent.spawned, 2, "admission preserves cumulative spawn telemetry");
    assert.equal((await final(f, renewedParent)).spawned, 2);
  } finally {
    release();
  }
});

test("reload drains a real waiting child and clears parked presence with no old-runtime delivery", async (t) => {
  const f = await fixture(t, { speed: 0, response });
  const idle = await final(f, await f.launch("idle", "general", false));
  await control(f, { action: "park", target: idle });
  await config(f, { general: { coordination: ["wait"] } });
  const child = await f.launch("receive");
  await eventually(() =>
    f.events.some(
      (event) =>
        event.child.id === child.id &&
        event.event?.type === "tool_execution_start" &&
        event.event.toolName === "delegate_coordinate",
    ),
  );
  const customBefore = f.session.messages.filter((message) => message.role === "custom").length;
  await f.session.reload();
  const state = await final(f, child);
  assert.equal(state.status, "cancelled");
  assert.equal(state.disposed, true);
  assert.equal(
    f.session.messages.filter((message) => message.role === "custom").length,
    customBefore,
  );
  assert.equal(
    (await control(f, { action: "revive", target: idle, assignment: "old runtime" })).isError,
    true,
  );
});

test("real grandchild cannot message unrelated family, wait on ancestor, or read foreign receipts", async (t) => {
  let sibling: ChildRef;
  let receiptId: string;
  let f: F;
  const scripted: FauxResponseFactory = (context, ...rest) => {
    if (
      text(context) === "family-parent" &&
      !context.messages.some((message) => message.role === "toolResult")
    )
      return fauxAssistantMessage(
        fauxToolCall("delegate_task", { assignment: "attack-family", profile: "general" }),
        { stopReason: "toolUse" },
      );
    if (
      text(context) === "attack-family" &&
      !context.messages.some((message) => message.role === "toolResult")
    ) {
      const parent = f.events.find((event) => event.child.assignment === "family-parent")!.child;
      return fauxAssistantMessage(
        [
          fauxToolCall("delegate_coordinate", {
            action: "message",
            target: { id: sibling.id, generation: sibling.generation },
            text: "denied",
          }),
          fauxToolCall("delegate_coordinate", {
            action: "wait",
            target: { id: parent.id, generation: parent.generation },
            timeoutMs: 60000,
          }),
          fauxToolCall("delegate_coordinate", {
            action: "wait",
            messageId: receiptId,
            timeoutMs: 60000,
          }),
        ],
        { stopReason: "toolUse" },
      );
    }
    return response(context, ...rest);
  };
  f = await fixture(t, { speed: 0, response: scripted });
  await config(f, {
    scheduling: { concurrency: 3 },
    general: {
      tools: ["read", "grep", "find", "ls"],
      spawn: ["general"],
      coordination: ["message", "wait"],
    },
  });
  sibling = await f.launch("receive");
  await eventually(() =>
    f.events.some(
      (event) =>
        event.child.id === sibling.id &&
        event.event?.type === "tool_execution_start" &&
        event.event.toolName === "delegate_coordinate",
    ),
  );
  const receipt = await control(f, {
    action: "message",
    target: sibling,
    text: "only sibling and root",
  });
  receiptId = (receipt.details as { id: string }).id;
  await final(f, sibling);
  await f.launch("family-parent", "general", false);
  const grandchild = f.events
    .filter((event) => event.child.depth === 2 && event.child.disposed)
    .at(-1)!.child;
  const transcript = await readFile(grandchild.transcript!, "utf8");
  assert.match(transcript, /outside granted family/);
  assert.match(transcript, /Ancestor wait would deadlock/);
  assert.match(transcript, /foreign message receipt/);
});
