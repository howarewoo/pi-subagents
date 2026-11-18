import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile, readdir, symlink } from "node:fs/promises";
import { join } from "node:path";
import {
  fauxAssistantMessage,
  fauxToolCall,
  type FauxResponseFactory,
} from "@earendil-works/pi-ai";
import { fixture, eventually } from "./fixtures.ts";
import type { ChildSnapshot } from "../src/coordinator.ts";
import { saveOutcomeArtifact } from "../src/outcomes.ts";

const schema = {
  type: "object",
  properties: { answer: { type: "integer" } },
  required: ["answer"],
  additionalProperties: false,
};
const task = (assignment: string, extra: object = {}) => ({
  assignment,
  profile: "general",
  resultSchema: schema,
  ...extra,
});
const textOf = (context: Parameters<FauxResponseFactory>[0]) => {
  const user = context.messages.find((message) => message.role === "user");
  return typeof user?.content === "string"
    ? user.content
    : (user?.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("") ?? "");
};
function response(child: FauxResponseFactory): FauxResponseFactory {
  return (context, options, state, selected) => {
    const text = textOf(context);
    if (text.startsWith("LAUNCH "))
      return context.messages.at(-1) !== context.messages.find((message) => message.role === "user")
        ? fauxAssistantMessage("parent done")
        : fauxAssistantMessage(fauxToolCall("delegate_task", JSON.parse(text.slice(7))), {
            stopReason: "toolUse",
          });
    return child(context, options, state, selected);
  };
}
async function launch(
  f: Awaited<ReturnType<typeof fixture>>,
  input: object,
): Promise<ChildSnapshot> {
  await f.session.prompt("LAUNCH " + JSON.stringify(input));
  const result = f.session.messages
    .filter((message) => message.role === "toolResult" && message.toolName === "delegate_task")
    .at(-1);
  assert.ok(result?.role === "toolResult", JSON.stringify(result));
  return result.details as ChildSnapshot;
}

test("tool wrap-up protects a structured submission from a batch of non-report tools", async (t) => {
  let reads = 0;
  let reportRequests = 0;
  const f = await fixture(t, {
    speed: 0,
    extra: (pi) => {
      pi.on("tool_call", ({ toolName }) => {
        if (toolName === "read") reads++;
      });
    },
    response: response((context) => {
      const guidance = context.messages
        .filter((message) => message.role === "system")
        .map((message) => message.content)
        .join("\n");
      const read = () => fauxToolCall("read", { path: "missing.txt" });
      if (!context.messages.some((message) => message.role === "toolResult"))
        return fauxAssistantMessage([read(), read(), read()], { stopReason: "toolUse" });
      assert.match(guidance, /Delegation wrap-up.*submit_result/s);
      if (++reportRequests === 1) return fauxAssistantMessage(read(), { stopReason: "toolUse" });
      return fauxAssistantMessage(
        [read(), fauxToolCall("submit_result", { value: { answer: 42 } })],
        { stopReason: "toolUse" },
      );
    }),
  });
  const result = await launch(
    f,
    task("report from evidence", { limits: { requests: 4, tools: 3 } }),
  );
  assert.equal(result.status, "settled", result.error ?? result.result);
  assert.equal(result.toolCalls, 3);
  assert.equal(result.telemetry.requests, 3);
  assert.equal(reportRequests, 2);
  assert.equal(reads, 2);
  assert.equal(result.outcome?.finalized, true);
  assert.deepEqual(JSON.parse(await readFile(result.artifacts!.structured!, "utf8")), {
    answer: 42,
  });
});

test("real SDK submit_result strictly rejects invalid value, accepts correction once and persists exact structured/plain artifacts", async (t) => {
  const fullText = "large final 🦉\n".repeat(3500);
  const f = await fixture(t, {
    speed: 10000000,
    tokenSize: { min: 1024, max: 1024 },
    response: response((context) => {
      const attempts = context.messages.filter((message) => message.role === "toolResult").length;
      if (attempts === 0)
        return fauxAssistantMessage(fauxToolCall("submit_result", { value: { answer: "42" } }), {
          stopReason: "toolUse",
        });
      if (attempts === 1 || attempts === 2)
        return fauxAssistantMessage(
          fauxToolCall("submit_result", { value: { answer: attempts === 1 ? 42 : 99 } }),
          { stopReason: "toolUse" },
        );
      return fauxAssistantMessage(fullText);
    }),
  });
  const state = await launch(f, task("correct me"));
  assert.equal(state.status, "settled");
  assert.deepEqual(state.outcome, {
    validation: "submitted",
    attempts: 2,
    errors: [],
    value: { answer: 42 },
    finalized: true,
  });
  assert.equal(state.toolCalls, 3);
  assert.equal(state.telemetry.requests, 4);
  assert.equal(state.result, fullText.trim());
  assert.equal(await readFile(state.artifacts!.text!, "utf8"), fullText);
  assert.deepEqual(JSON.parse(await readFile(state.artifacts!.structured!, "utf8")), {
    answer: 42,
  });
  const transcript = await readFile(state.transcript!, "utf8");
  assert.match(transcript, /correct and resubmit/);
  assert.match(transcript, /duplicate submission rejected/);
  const result = f.session.messages.find(
    (message) => message.role === "toolResult" && message.toolName === "delegate_task",
  );
  assert.ok(result?.role === "toolResult");
  assert.match(JSON.stringify(result.content), /Preview truncated/);
  assert.match(JSON.stringify(result.content), /result.txt/);
  assert.ok(JSON.stringify(result.content).length < 15000);
  assert.equal(result.usage, undefined);
  assert.ok(
    f.events.some(
      (event) =>
        event.child.outcome?.validation === "submitted" &&
        !event.child.outcome.finalized &&
        !event.child.disposed,
    ),
  );
});

test("missing/invalid submission fails; accepted submission cannot override provider errors or request/tool limits", async (t) => {
  for (const mode of ["missing", "invalid", "provider", "requests", "tools"])
    await t.test(mode, async (t) => {
      const f = await fixture(t, {
        response: response((context) => {
          const attempted = context.messages.some((message) => message.role === "toolResult");
          if (mode === "missing") return fauxAssistantMessage('{"answer":42}');
          if (attempted)
            return mode === "provider"
              ? fauxAssistantMessage("", {
                  stopReason: "error",
                  errorMessage: "provider failed after submission",
                })
              : fauxAssistantMessage("final");
          const submission = fauxToolCall("submit_result", {
            value: { answer: mode === "invalid" ? "wrong" : 42 },
          });
          // A lone valid report now ends wrap-up without further model work. Add a
          // sibling to exercise an actual attempted overrun after acceptance.
          const calls = [submission];
          if (mode === "requests") calls.push(fauxToolCall("submit_result", {}));
          if (mode === "tools")
            calls.push(fauxToolCall("submit_result", { value: { answer: 99 } }));
          return fauxAssistantMessage(calls, { stopReason: "toolUse" });
        }),
      });
      const state = await launch(
        f,
        task(mode, mode === "requests" || mode === "tools" ? { limits: { [mode]: 1 } } : {}),
      );
      assert.equal(state.status, mode === "requests" || mode === "tools" ? "cancelled" : "failed");
      assert.equal(state.disposed, true);
      if (mode === "missing" || mode === "invalid") assert.match(state.error!, /not submitted/);
      if (mode === "provider") assert.match(state.error!, /provider failed after submission/);
      if (mode === "requests" || mode === "tools") {
        assert.equal(state.limitReason, mode);
        assert.equal(state.outcome?.validation, "submitted");
      }
      assert.equal(state.outcome?.finalized, true);
    });
});

test("later unsupported/malformed/unsafe schema rejects entire batch before identities or disk setup", async (t) => {
  const f = await fixture(t);
  for (const resultSchema of [
    { $ref: "https://invalid.test/schema" },
    { pattern: "(a+)+$" },
    { type: "integer", minimum: "bad" },
    { type: "function" },
    { properties: [] },
    { anyOf: [] },
    { required: [1] },
    null,
  ]) {
    await launch(f, { tasks: [task("no launch"), task("invalid later", { resultSchema })] });
    assert.equal(f.events.length, 0);
  }
  await assert.rejects(readdir(join(f.root, "parent", "delegation")), /ENOENT/);
});

test("ordered root batch and nested schema submissions use independent registry outcomes and direct usage", async (t) => {
  const f = await fixture(t, {
    response: response((context) => {
      const text = textOf(context);
      const tools = context.messages.filter((message) => message.role === "toolResult");
      if (text === "nested" && !tools.length)
        return fauxAssistantMessage(fauxToolCall("delegate_task", task("leaf")), {
          stopReason: "toolUse",
        });
      if (tools.at(-1)?.role === "toolResult" && tools.at(-1)?.toolName === "submit_result")
        return fauxAssistantMessage("done " + text);
      return fauxAssistantMessage(
        fauxToolCall("submit_result", { value: { answer: text === "leaf" ? 2 : 1 } }),
        { stopReason: "toolUse" },
      );
    }),
  });
  await mkdir(join(f.root, "operator"), { recursive: true });
  await writeFile(
    join(f.root, "operator", "delegation.json"),
    JSON.stringify({
      general: { tools: ["read", "grep", "find", "ls"], spawn: ["general"] },
      scheduling: { concurrency: 3 },
    }),
  );
  await launch(f, { tasks: [task("nested"), task("sibling")] });
  const final = f.events.filter((event) => event.child.disposed).map((event) => event.child);
  assert.equal(final.length, 3);
  assert.ok(
    final.every((state) => state.status === "settled" && state.outcome?.validation === "submitted"),
  );
  assert.deepEqual(final.find((state) => state.depth === 2)?.outcome?.value, { answer: 2 });
  assert.equal(final.find((state) => state.assignment === "nested")?.telemetry.requests, 3);
  const result = f.session.messages.find(
    (message) => message.role === "toolResult" && message.toolName === "delegate_task",
  );
  assert.ok(result?.role === "toolResult");
  assert.deepEqual(
    (result.details as { children: ChildSnapshot[] }).children.map((state) => state.assignment),
    ["nested", "sibling"],
  );
});

test("submission while real parent permission work drains stays provisional; cancellation never forges success", async (t) => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let readStarted = false;
  const f = await fixture(t, {
    extra: (pi) => {
      pi.on("tool_call", async (event) => {
        if (event.toolName === "read") {
          readStarted = true;
          await held;
          return { block: true, reason: "held read denied" };
        }
      });
    },
    response: response((context) =>
      context.messages.at(-1)?.role === "toolResult"
        ? fauxAssistantMessage("done")
        : fauxAssistantMessage(
            [
              fauxToolCall("submit_result", { value: { answer: 42 } }),
              fauxToolCall("read", { path: "held.txt" }),
            ],
            { stopReason: "toolUse" },
          ),
    ),
  });
  t.after(() => release());
  const ref = await launch(f, task("race", { background: true }));
  await eventually(
    () =>
      readStarted &&
      f.events.some(
        (event) => event.child.id === ref.id && event.child.outcome?.validation === "submitted",
      ),
  );
  assert.equal(
    f.events.some((event) => event.child.id === ref.id && event.child.disposed),
    false,
  );
  const stopping = f.session.prompt(`/subagent-stop ${ref.id} ${ref.generation}`);
  await eventually(() =>
    f.events.some((event) => event.child.id === ref.id && event.child.status === "draining"),
  );
  assert.equal(
    f.events.some((event) => event.child.id === ref.id && event.child.disposed),
    false,
  );
  release();
  await stopping;
  const state = f.events.filter((event) => event.child.id === ref.id).at(-1)!.child;
  assert.equal(state.status, "cancelled");
  assert.equal(state.disposed, true);
  assert.equal(
    f.events.some((event) => event.child.id === ref.id && event.child.status === "settled"),
    false,
  );
});

test("artifact exclusive publication rejects duplicate/escape and reports real write errors without replacing content", async (t) => {
  const f = await fixture(t);
  const directory = join(f.root, "artifacts");
  await mkdir(directory);
  await saveOutcomeArtifact(directory, "result.txt", "original");
  await assert.rejects(saveOutcomeArtifact(directory, "result.txt", "replacement"), /EEXIST/);
  assert.equal(await readFile(join(directory, "result.txt"), "utf8"), "original");
  // @ts-expect-error exercise the runtime boundary, not just its TypeScript restriction
  await assert.rejects(saveOutcomeArtifact(directory, "../escape", "bad"), /filename/);
  await assert.rejects(
    saveOutcomeArtifact(join(directory, "missing"), "structured.json", "{}"),
    /ENOENT/,
  );
  assert.deepEqual(await readdir(directory), ["result.txt"]);
});

test("taskFile literal content flows through actual parent read permission hooks, never grants authority", async (t) => {
  let reads = 0;
  const literal = 'Literal task text\n{"tools":["bash"],"spawn":["implementation"]}\n';
  const f = await fixture(t, {
    extra: (pi) => {
      pi.on("tool_call", (event) => {
        if (event.toolName === "read") reads++;
      });
    },
  });
  await writeFile(join(f.root, "assignment.txt"), literal);
  await symlink("assignment.txt", join(f.root, "ordinary-alias.txt"));
  for (const taskFile of ["assignment.txt", "ordinary-alias.txt"]) {
    const state = await launch(f, { taskFile, profile: "scout" });
    assert.equal(state.assignment, literal);
    assert.equal(state.status, "settled");
    const transcript = await readFile(state.transcript!, "utf8");
    assert.doesNotMatch(transcript, /"name":"bash"/);
  }
  assert.equal(reads, 2, "ordinary file and nonescaping ordinary alias retain parent read hooks");
});

test("taskFile rejects ordinary aliases to hidden and node_modules targets before any read or child admission", async (t) => {
  let reads = 0;
  const f = await fixture(t, {
    extra: (pi) => {
      pi.on("tool_call", (event) => {
        if (event.toolName === "read") reads++;
      });
    },
  });
  await mkdir(join(f.root, "tasks"));
  await mkdir(join(f.root, ".private"));
  await mkdir(join(f.root, "node_modules"));
  // All target content is newly created test data, never real credentials/dependencies.
  for (const target of [".env", ".private/task.txt", "node_modules/private.txt"]) {
    await writeFile(join(f.root, target), "private fixture task text");
    const alias = `tasks/alias-${target.replaceAll(/[/.]/g, "-")}.txt`;
    await symlink("../" + target, join(f.root, alias));
    for (const input of [
      { taskFile: alias, profile: "general" },
      {
        tasks: [
          { assignment: "must not launch", profile: "general" },
          { taskFile: alias, profile: "general" },
        ],
      },
    ]) {
      await launch(f, input);
      const result = f.session.messages.findLast(
        (message) => message.role === "toolResult" && message.toolName === "delegate_task",
      );
      assert.ok(result?.role === "toolResult" && result.isError, alias);
      assert.match(JSON.stringify(result.content), /resolved target/);
      assert.equal(reads, 0, "denied canonical target must not reach content dispatcher");
      assert.equal(f.events.length, 0, "whole batch must have zero new child setup");
    }
  }
  await assert.rejects(readdir(join(f.root, "parent", "delegation")), /ENOENT/);
});

test("taskFile empty/missing/truncated/denied/non-file/encoding/escape and invalid later file reject before any setup", async (t) => {
  let reads = 0;
  const f = await fixture(t, {
    extra: (pi) => {
      pi.on("tool_call", (event) => {
        if (event.toolName === "read") {
          reads++;
          if (String(event.input.path).endsWith("denied.txt"))
            return { block: true, reason: "explicit file permission denial" };
        }
      });
    },
  });
  await writeFile(join(f.root, "valid.txt"), "valid task");
  await writeFile(join(f.root, "empty.txt"), "  \n");
  await writeFile(join(f.root, "denied.txt"), "cannot read");
  await writeFile(join(f.root, "truncated.txt"), "line\n".repeat(2100));
  await writeFile(join(f.root, "encoding.txt"), Buffer.from([0xff, 0xfe, 0]));
  await mkdir(join(f.root, "directory"));
  await symlink("/tmp", join(f.root, "escape"));
  await symlink("/etc/passwd", join(f.root, "escape-file"));
  for (const taskFile of [
    "empty.txt",
    "missing.txt",
    "truncated.txt",
    "denied.txt",
    "directory",
    "encoding.txt",
    "../outside.txt",
    "/etc/passwd",
    "escape/anything",
    "escape-file",
    ".env",
  ]) {
    await launch(f, {
      tasks: [
        { taskFile: "valid.txt", profile: "general" },
        { taskFile, profile: "general" },
      ],
    });
    assert.equal(f.events.length, 0, taskFile);
    const last = f.session.messages
      .filter((message) => message.role === "toolResult" && message.toolName === "delegate_task")
      .at(-1);
    assert.ok(last?.role === "toolResult" && last.isError, taskFile);
  }
  assert.ok(reads >= 10, "actual parent dispatcher reads occurred in preflight");
  await assert.rejects(readdir(join(f.root, "parent", "delegation")), /ENOENT/);
});

test("large structured value has bounded preview and exact JSON artifact, without requiring schema for plain tasks", async (t) => {
  const value = { text: "structured 🦉 ".repeat(5000) };
  const f = await fixture(t, {
    tokenSize: { min: 1024, max: 1024 },
    response: response((context) =>
      context.messages.at(-1)?.role === "toolResult"
        ? fauxAssistantMessage("complete")
        : fauxAssistantMessage(fauxToolCall("submit_result", { value }), { stopReason: "toolUse" }),
    ),
  });
  const state = await launch(
    f,
    task("large structured", {
      resultSchema: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
      },
    }),
  );
  assert.equal(state.status, "settled");
  assert.deepEqual(state.outcome?.value, value);
  assert.equal(await readFile(state.artifacts!.structured!, "utf8"), JSON.stringify(value));
  const message = f.session.messages.find(
    (message) => message.role === "toolResult" && message.toolName === "delegate_task",
  );
  assert.ok(message?.role === "toolResult");
  assert.match(JSON.stringify(message.content), /Preview truncated/);
  assert.match(JSON.stringify(message.content), /structured.json/);
  assert.ok(JSON.stringify(message.content).length < 12000);
});

test("actual runtime artifact collision fails honestly, retaining ordinary text and original file", async (t) => {
  const f = await fixture(t, {
    response: response((context) => {
      if (context.messages.at(-1)?.role === "toolResult")
        return fauxAssistantMessage("final text survives persistence failure");
      const state = f.events.filter((event) => event.child.transcript).at(-1)!.child;
      const directory = join(state.transcript!, "..", "..");
      return fauxAssistantMessage(
        fauxToolCall("write", { path: join(directory, "result.txt"), content: "existing record" }),
        { stopReason: "toolUse" },
      );
    }),
  });
  const state = await launch(f, { assignment: "collision", profile: "implementation" });
  assert.equal(state.status, "failed");
  assert.equal(state.result, "final text survives persistence failure");
  assert.match(state.error!, /artifact persistence failed.*EEXIST/);
  assert.equal(state.artifacts?.text, undefined);
  assert.equal(
    await readFile(join(state.transcript!, "..", "..", "result.txt"), "utf8"),
    "existing record",
  );
});

test("nested taskFile respects ancestor read grant and tool budget rather than regaining root authority", async (t) => {
  const f = await fixture(t, {
    response: response((context) =>
      context.messages.at(-1)?.role === "toolResult"
        ? fauxAssistantMessage("done")
        : fauxAssistantMessage(
            fauxToolCall("delegate_task", { taskFile: "leaf.txt", profile: "general" }),
            { stopReason: "toolUse" },
          ),
    ),
  });
  await writeFile(join(f.root, "leaf.txt"), "leaf literal");
  await mkdir(join(f.root, "operator"), { recursive: true });
  await writeFile(
    join(f.root, "operator", "delegation.json"),
    JSON.stringify({ general: { spawn: ["general"], tools: ["grep", "find", "ls"] } }),
  );
  const state = await launch(f, { assignment: "nested denied", profile: "general" });
  assert.equal(f.events.filter((event) => event.child.disposed).length, 1);
  assert.match(await readFile(state.transcript!, "utf8"), /no active read grant/);
});

test("submitted parent waits for nested descendant drain and subtree shutdown cannot turn it into success", async (t) => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let reading = false;
  const f = await fixture(t, {
    extra: (pi) => {
      pi.on("tool_call", async (event) => {
        if (event.toolName === "read") {
          reading = true;
          await held;
          return { block: true, reason: "descendant denied after drain" };
        }
      });
    },
    response: response((context) => {
      if (context.messages.at(-1)?.role === "toolResult") return fauxAssistantMessage("done");
      return textOf(context) === "parent"
        ? fauxAssistantMessage(
            [
              fauxToolCall("submit_result", { value: { answer: 1 } }),
              fauxToolCall("delegate_task", task("descendant")),
            ],
            { stopReason: "toolUse" },
          )
        : fauxAssistantMessage(fauxToolCall("read", { path: "held.txt" }), {
            stopReason: "toolUse",
          });
    }),
  });
  t.after(() => release());
  await mkdir(join(f.root, "operator"), { recursive: true });
  await writeFile(
    join(f.root, "operator", "delegation.json"),
    JSON.stringify({ general: { tools: ["read", "grep", "find", "ls"], spawn: ["general"] } }),
  );
  const ref = await launch(f, task("parent", { background: true }));
  await eventually(
    () =>
      reading &&
      f.events.some(
        (event) => event.child.id === ref.id && event.child.outcome?.validation === "submitted",
      ),
  );
  const stopping = f.session.prompt(`/subagent-stop ${ref.id} 1`);
  await eventually(() =>
    f.events.some((event) => event.child.depth === 2 && event.child.status === "draining"),
  );
  assert.equal(
    f.events.some((event) => event.child.disposed),
    false,
  );
  release();
  await stopping;
  const finals = f.events.filter((event) => event.child.disposed).map((event) => event.child);
  assert.deepEqual(
    finals.map((state) => state.status),
    ["cancelled", "cancelled"],
  );
  assert.equal(finals[0].depth, 2);
  assert.equal(finals[1].id, ref.id);
  await eventually(() => !f.session.isStreaming);
  const before = f.events.length;
  f.model.setResponses([
    fauxAssistantMessage(fauxToolCall("submit_result", { value: { answer: 99 } }), {
      stopReason: "toolUse",
    }),
    fauxAssistantMessage("done"),
  ]);
  await f.session.prompt("Attempt replay outside the disposed child generation");
  const replay = f.session.messages.findLast(
    (message) => message.role === "toolResult" && message.toolName === "submit_result",
  );
  assert.ok(replay?.role === "toolResult" && replay.isError);
  assert.equal(
    f.events.length,
    before,
    "child-local submission capability is not registered on parent and cannot revive a generation",
  );
});

test("SDK abort during streamed submission prevents late acceptance", async (t) => {
  const f = await fixture(t, {
    speed: 500,
    response: response(() =>
      fauxAssistantMessage(
        fauxToolCall("submit_result", { value: { answer: 42, padding: "x".repeat(10000) } }),
        { stopReason: "toolUse" },
      ),
    ),
  });
  const ref = await launch(f, task("abort submission stream", { background: true }));
  await eventually(() =>
    f.events.some((event) => event.child.id === ref.id && event.event?.type === "message_update"),
  );
  await f.session.prompt(`/subagent-stop ${ref.id} ${ref.generation}`);
  const final = f.events.filter((event) => event.child.id === ref.id).at(-1)!.child;
  assert.equal(final.status, "cancelled");
  assert.equal(final.outcome?.attempts, 0);
  assert.equal(final.outcome?.validation, "awaiting");
  assert.equal(final.artifacts?.structured, undefined);
  assert.equal(final.outcome?.finalized, true);
  assert.equal(
    f.events.some(
      (event) => event.child.id === ref.id && event.child.outcome?.validation === "submitted",
    ),
    false,
  );
});
