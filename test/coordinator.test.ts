import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  AgentSession,
  createAgentSession,
  initTheme,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import {
  fauxProvider,
  getCurrentTools,
  InMemoryCredentialStore,
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { childResources } from "../src/coordinator.ts";
import { createHub } from "../src/hub.ts";
import { ProcessTerminal, TuiMainScreen, oklchColor, visibleWidth } from "@earendil-works/pi-tui";
import { fixture, eventually } from "./fixtures.ts";

test(
  "SDK selected parent provider streams, steers, settles and reopens transcript with explicit resources",
  { timeout: 15000 },
  async (t) => {
    const { root, coordinator, direct, model } = await fixture(t, { speed: 500 });
    await mkdir(join(root, ".pi", "extensions"), { recursive: true });
    await writeFile(
      join(root, ".pi", "extensions", "hostile.ts"),
      'throw new Error("ambient executed")',
    );
    await writeFile(join(root, "AGENTS.md"), "AMBIENT_CONTEXT_MUST_NOT_APPEAR");
    const ref = await direct("first assignment");
    await eventually(() => !!coordinator.snapshot(ref)?.progress);
    assert.equal(await coordinator.steer(ref, "queued steering"), "queued");
    const state = await coordinator.wait(ref);
    assert.equal(state.status, "settled");
    assert.equal(state.disposed, true);
    assert.match(state.result, /queued steering/);
    assert.equal(state.model.provider, model.getModel().provider);
    assert.equal(state.telemetry.requests, 2);
    assert.ok(state.telemetry.tokens);
    const reopened = coordinator.reopenTranscript(ref);
    assert.deepEqual(
      getCurrentTools(reopened.messages)
        .map((tool) => tool.name)
        .sort(),
      ["bash", "edit", "find", "grep", "ls", "read", "write"],
    );
    assert.ok(!JSON.stringify(reopened).includes("AMBIENT_CONTEXT_MUST_NOT_APPEAR"));
    assert.match(await readFile(state.transcript!, "utf8"), /queued steering/);
    const resources = childResources("test");
    assert.deepEqual(resources.getExtensions().extensions, []);
    assert.deepEqual(resources.getSkills().skills, []);
    assert.deepEqual(resources.getAgentsFiles().agentsFiles, []);
    assert.deepEqual(resources.getPrompts().prompts, []);
    const runtime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsPath: null,
      modelsStorePath: join(root, "reopen-cache.json"),
      refreshOnCreate: false,
    });
    const controlled = fauxProvider();
    runtime.registerNativeProvider(controlled.provider);
    const { session } = await createAgentSession({
      cwd: root,
      agentDir: join(root, "reopen-agent"),
      modelRuntime: runtime,
      model: controlled.getModel(),
      resourceLoader: resources,
      tools: [],
      settingsManager: SettingsManager.inMemory(),
      sessionManager: SessionManager.open(state.transcript!),
    });
    try {
      assert.match(session.getLastAssistantText()!, /queued steering/);
      assert.ok(!session.systemPrompt.includes("AMBIENT_CONTEXT"));
    } finally {
      session.dispose();
    }
  },
);

test(
  "shutdown aborts acknowledged pre-delta startup, disposes once, remains idempotent and rejects later starts",
  { timeout: 15000 },
  async (t) => {
    const { coordinator, direct } = await fixture(t, { speed: 10 });
    const disposed: (string | undefined)[] = [];
    const original = AgentSession.prototype.dispose;
    t.mock.method(AgentSession.prototype, "dispose", function (this: AgentSession) {
      disposed.push(this.sessionFile);
      return original.call(this);
    });
    const ref = await direct("long assignment");
    await coordinator.shutdown();
    const state = coordinator.snapshot(ref)!;
    assert.equal(state.status, "cancelled");
    assert.equal(state.disposed, true);
    assert.equal(disposed.filter((path) => path === state.transcript).length, 1);
    const disk = await readFile(state.transcript!, "utf8");
    assert.match(disk, /"stopReason":"aborted"/);
    assert.ok(!disk.includes('"stopReason":"stop"'));
    assert.equal(state.progress, "");
    await coordinator.shutdown();
    await assert.rejects(direct("late"), /shut down/);
  },
);

test("live telemetry includes each assistant message as it ends, matching the final totals", async (t) => {
  const { coordinator, direct, events } = await fixture(t, {
    response: (context) =>
      context.messages.at(-1)?.role === "toolResult"
        ? fauxAssistantMessage("listed")
        : fauxAssistantMessage(fauxToolCall("ls", { path: "." }), { stopReason: "toolUse" }),
  });
  const ref = await direct("list files");
  const final = await coordinator.wait(ref);
  const ends = events.filter(
    (event) =>
      event.child.id === ref.id &&
      event.event?.type === "message_end" &&
      event.event.message.role === "assistant",
  );
  assert.equal(ends.length, 2);
  let output = 0;
  for (const { child, event } of ends) {
    // SDK public listeners run before message_end persistence; this message must still count.
    output += (event as { message: { usage: { output: number } } }).message.usage.output;
    assert.ok(output > 0);
    assert.equal(child.telemetry.tokens?.output, output);
  }
  assert.deepEqual(ends.at(-1)!.child.telemetry.tokens, final.telemetry.tokens);
  assert.equal(ends.at(-1)!.child.telemetry.cost, final.telemetry.cost);
});

test("shutdown racing child construction drains setup without model execution", async (t) => {
  const { coordinator, direct } = await fixture(t);
  // direct() first obtains context; shutdown at the observable setup boundary.
  coordinator.subscribe((event) => {
    if (event.child.status === "setup") void coordinator.shutdown();
  });
  const ref = await direct("never run");
  await coordinator.shutdown();
  assert.equal(coordinator.snapshot(ref)!.status, "cancelled");
  assert.equal(coordinator.snapshot(ref)!.progress, "");
  assert.equal(coordinator.snapshot(ref)!.disposed, true);
});

test("view is width-safe, follows stream and closing never owns execution", async (t) => {
  const { coordinator, direct } = await fixture(t, { speed: 500 });
  initTheme("dark", false);
  let renders = 0;
  let closed = false;
  const tui = new TuiMainScreen(new ProcessTerminal());
  t.mock.method(tui, "requestRender", () => {});
  const hub = createHub(
    coordinator,
    {
      fg: (_color, text) => text,
      style: (text) => text,
      colors: { customMessageBg: oklchColor(0.3, 0, 0) },
    },
    {
      matches: (data, action) => data === "escape" && action === "tui.select.cancel",
      getKeys: () => ["escape"],
    },
    () => {
      renders++;
    },
    () => {
      closed = true;
    },
    { tui, cwd: process.cwd() },
  );
  const ref = await direct("中文 👩‍💻 \u001b]52;c;bad\u0007");
  await eventually(() => !!coordinator.snapshot(ref)?.progress);
  for (const width of [0, 1, 2, 8, 40, 80])
    assert.ok(hub.render(width).every((line) => visibleWidth(line) <= width));
  hub.handleInput?.("escape");
  assert.equal(closed, true);
  hub.dispose();
  assert.equal(coordinator.snapshot(ref)!.status, "running");
  const before = renders;
  await coordinator.wait(ref);
  assert.equal(renders, before);
});

test("real model task invocation returns foreground once and background identity plus one final delivery", async (t) => {
  const { launch, events, session } = await fixture(t);
  const foreground = await launch("foreground", "general", false);
  assert.equal(
    events.filter((event) => event.child.id === foreground.id && event.child.disposed).length,
    1,
  );
  const result = session.messages.find(
    (message) => message.role === "toolResult" && message.toolName === "delegate_task",
  );
  assert.match(JSON.stringify(result), /Controlled response: foreground/);
  const background = await launch("background");
  await eventually(() =>
    events.some((event) => event.child.id === background.id && event.child.disposed),
  );
  await eventually(() =>
    session.messages.some(
      (message) => message.role === "custom" && JSON.stringify(message).includes(background.id),
    ),
  );
  assert.equal(
    session.messages.filter(
      (message) => message.role === "custom" && JSON.stringify(message).includes(background.id),
    ).length,
    1,
  );
});

test("real parent reload drains background children and RPC hub prints the roster instead of opening terminal UI", async (t) => {
  const { launch, session, events } = await fixture(t, { speed: 400 });
  await session.prompt("/subagent-hub");
  const roster = session.messages.at(-1);
  assert.ok(roster?.role === "custom" && roster.customType === "delegation");
  assert.match(String(roster.content), /^\[\]$/m, "empty registry still reports an empty roster");
  const ref = await launch("long child ".repeat(60));
  await session.reload();
  const state = events.filter((event) => event.child.id === ref.id).at(-1)!.child;
  assert.equal(state.status, "cancelled");
  assert.equal(state.disposed, true);
  assert.match(await readFile(state.transcript!, "utf8"), /"stopReason":"aborted"/);
});

test("actual parent dispatched read/grep and writer edit/write retain hooks, real storage and tool events", async (t) => {
  const { root, launch, events } = await fixture(t, {
    response: (context) => {
      const last = context.messages.at(-1);
      const user = context.messages.find((message) => message.role === "user");
      const text =
        typeof user?.content === "string"
          ? user.content
          : (user?.content
              .filter((block) => block.type === "text")
              .map((block) => block.text)
              .join("") ?? "");
      if (text.startsWith("LAUNCH ")) {
        if (last?.role === "toolResult") return fauxAssistantMessage("parent done");
        return fauxAssistantMessage(fauxToolCall("delegate_task", JSON.parse(text.slice(7))), {
          stopReason: "toolUse",
        });
      }
      const results = context.messages.filter((message) => message.role === "toolResult");
      const calls = [
        fauxToolCall("write", { path: "scratch.txt", content: "before" }),
        fauxToolCall("edit", {
          path: "scratch.txt",
          edits: [{ oldText: "before", newText: "after" }],
        }),
        fauxToolCall("read", { path: "scratch.txt" }),
        fauxToolCall("grep", { pattern: "after", path: "." }),
      ];
      return results.length < calls.length
        ? fauxAssistantMessage(calls[results.length], { stopReason: "toolUse" })
        : fauxAssistantMessage("child tools done");
    },
  });
  execFileSync("git", ["init", "--quiet", root], {
    env: {
      PATH: process.env.PATH,
      HOME: join(root, "empty-home"),
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
    },
  });
  const ref = await launch("use tools", "implementation", false);
  assert.equal(await readFile(join(root, "scratch.txt"), "utf8"), "after");
  const finished = events.filter(
    (event) => event.child.id === ref.id && event.event?.type === "tool_execution_end",
  );
  assert.equal(finished.length, 4);
  assert.ok(
    finished.every((event) => event.event?.type === "tool_execution_end" && !event.event.isError),
  );
  const disk = await readFile(
    events.find((event) => event.child.id === ref.id && event.child.transcript)!.child.transcript!,
    "utf8",
  );
  assert.match(disk, /after/);
});
