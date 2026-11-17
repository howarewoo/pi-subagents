import { DEFAULT_POLICY } from "../src/scheduling.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createFleetProvider } from "../examples/controlled-fleet.ts";
import { createChildWidget, transcriptLines, taskCard } from "../src/hub.ts";
import { fixture, eventually } from "./fixtures.ts";

test(
  "real SDK concurrent readers/writer/failure feed fleet, cards and full transcripts",
  { timeout: 20000 },
  async (t) => {
    // Reuse the exact opt-in interactive scenario's controlled response factory.
    const controlled = createFleetProvider(10000);
    const f = await fixture(t, {
      speed: 0,
      tokenSize: { min: 1024, max: 1024 },
      response: controlled.respond,
    });
    await writeFile(join(f.root, "input.txt"), "Real tool payload\n" + "full input\n".repeat(100));
    // Launch via actual parent task tool: all children share its authoritative extension registry.
    await f.session.prompt("fleet example");
    await eventually(() => new Set(f.events.map((event) => event.child.id)).size === 4);
    await eventually(() => f.events.filter((event) => event.child.disposed).length >= 4, 12000);
    const latest = new Map(f.events.map((event) => [event.child.id, event.child]));
    const children = [...latest.values()];
    assert.equal(children.length, 4);
    assert.equal(children.filter((child) => child.status === "settled").length, 3);
    assert.equal(children.filter((child) => child.status === "failed").length, 1);
    assert.ok(children.every((child) => child.createdAt <= child.endedAt!));
    assert.ok(children.every((child) => !child.writerLease && child.disposed));
    // Write capability never becomes exclusive ownership.
    assert.ok(f.events.every((event) => !event.child.writerLease));
    assert.ok(
      f.events.some((event) => event.child.profile === "scout" && event.child.status === "running"),
    );
    assert.ok(
      f.events.some(
        (event) => event.child.profile === "review" && event.child.status === "running",
      ),
    );
    assert.ok(f.events.some((event) => event.event?.type === "tool_execution_end"));
    const widget = createChildWidget(() => children, { fg: (_color, text) => text });
    assert.match(widget.render(160).join("\n"), /3 settled.*1 failed/);
    const toolResults = f.session.messages.filter(
      (message) => message.role === "toolResult" && message.toolName === "delegate_task",
    );
    assert.equal(toolResults.length, 4);
    assert.ok(
      toolResults.every((message) => message.role === "toolResult" && !message.usage),
      "child usage never billed twice as parent tool usage",
    );
    for (const child of children) {
      const card = taskCard(child, true).join("\n");
      assert.ok(card.includes(child.id));
      assert.ok(card.includes(child.status));
      assert.ok(card.includes(child.model.id));
      const { SessionManager } = await import("@earendil-works/pi-coding-agent");
      const messages = SessionManager.open(child.transcript!).buildSessionContext().messages;
      const lines = transcriptLines(messages).join("\n");
      if (child.status === "settled") {
        assert.match(lines, /toolResult/);
        assert.match(lines, /line 599/);
      } else assert.match(lines, /Controlled child failure/);
    }
  },
);

import { stripVTControlCharacters } from "node:util";
import { readFile } from "node:fs/promises";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { initTheme } from "@earendil-works/pi-coding-agent";
initTheme("dark", false);
import { createHub } from "../src/hub.ts";
import type { StartTask } from "../src/coordinator.ts";
import { ProcessTerminal, TuiMainScreen, oklchColor } from "@earendil-works/pi-tui";
const dependencies = { tui: new TuiMainScreen(new ProcessTerminal()), cwd: process.cwd() };
dependencies.tui.requestRender = () => {}; // Rendering only; this public TUI is not started.
const keys = {
  matches: (data: string, action: string) =>
    data ===
    (
      {
        "tui.select.cancel": "\x1b",
        "tui.select.confirm": "\r",
        "tui.select.up": "\x1b[A",
        "tui.select.down": "\x1b[B",
        "tui.select.pageUp": "\x1b[5~",
        "tui.select.pageDown": "\x1b[6~",
      } as Record<string, string>
    )[action],
  getKeys: () => ["escape" as const],
};
const assignmentText = (
  context: Parameters<import("@earendil-works/pi-ai").FauxResponseFactory>[0],
) => {
  const user = context.messages.find((message) => message.role === "user");
  return typeof user?.content === "string"
    ? user.content
    : (user?.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("") ?? "");
};
const palette = {
  fg: (_color: string, text: string) => text,
  style: (text: string) => text,
  colors: { customMessageBg: oklchColor(0.3, 0.1, 330) },
};

// Compare semantic footer text independently of wrapping at the physical row boundary.
function footerText(frame: string) {
  const lines = frame.split("\n");
  return lines
    .slice(lines.findIndex((line) => line.startsWith("├")) + 1, -1)
    .map((line) => line.slice(1, -1).trim())
    .join(" ");
}

// Capture the same real public parent dispatcher that direct fixture admission already uses.
async function captureAdmission(
  t: import("node:test").TestContext,
  f: Awaited<ReturnType<typeof fixture>>,
) {
  let input!: StartTask;
  const start = f.coordinator.start.bind(f.coordinator);
  t.mock.method(f.coordinator, "start", (value: StartTask) => {
    input = value;
    return start(value);
  });
  return () => input;
}

test(
  "real SDK Hub stop keeps capacity occupied while draining and queue transcript empty until hook release",
  { timeout: 10000 },
  async (t) => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered = false;
    const f = await fixture(t, {
      speed: 0,
      extra: (pi) => {
        pi.on("tool_call", async (event) => {
          if (event.toolName === "write" && event.input.path === "writer.txt") {
            entered = true;
            await gate;
          }
        });
      },
      response: (context) =>
        assignmentText(context) === "warmup" || context.messages.at(-1)?.role === "toolResult"
          ? fauxAssistantMessage("done")
          : fauxAssistantMessage(
              fauxToolCall("write", { path: assignmentText(context) + ".txt", content: "owned" }),
              { stopReason: "toolUse" },
            ),
    });
    f.coordinator.configure({ ...DEFAULT_POLICY, concurrency: 1 });
    const admission = await captureAdmission(t, f);
    let hub: ReturnType<typeof createHub> | undefined;
    try {
      const warmup = await f.direct("warmup", "implementation");
      await f.coordinator.wait(warmup);
      const [first, second] = await f.coordinator.admit([
        { ...admission(), assignment: "writer" },
        { ...admission(), assignment: "queued writer" },
      ]);
      hub = createHub(
        f.coordinator,
        palette,
        keys,
        () => {},
        () => {},
        dependencies,
        () => 28,
      );
      const render = () => stripVTControlCharacters(hub!.render(160).join("\n"));
      await eventually(() => entered);
      hub.handleInput!("/");
      hub.handleInput!(first.id);
      hub.handleInput!("\r");
      assert.match(render(), /> [├└] ● writer/);
      assert.equal(f.coordinator.snapshot(first)!.writerLease, false);
      assert.equal(f.coordinator.snapshot(second)!.status, "queued");
      assert.deepEqual(f.coordinator.messages(second), []);
      assert.equal(f.coordinator.snapshot(second)!.transcript, undefined);
      render();
      hub.handleInput!("x");
      assert.match(render(), new RegExp(`Target: ${first.id} #${first.generation}`));
      hub.handleInput!("y");
      await eventually(() => f.coordinator.snapshot(first)!.status === "draining");
      assert.equal(f.coordinator.snapshot(first)!.disposed, false);
      assert.equal(f.coordinator.snapshot(first)!.endedAt, null);
      assert.equal(f.coordinator.snapshot(first)!.writerLease, false);
      assert.equal(f.coordinator.snapshot(second)!.status, "queued");
      assert.match(render(), /draining/);
      assert.ok(
        footerText(render()).includes(
          `Stop ${first.id} #${first.generation} · writer · implementation: stopping and draining…`,
        ),
        "pending stop feedback identifies the original target while capacity remains occupied",
      );
      assert.doesNotMatch(render(), /stopped and drained/i);
      release();
      const final = await f.coordinator.wait(first);
      await f.coordinator.wait(second);
      assert.equal(final.status, "cancelled");
      assert.equal(final.writerLease, false);
      assert.ok(final.endedAt! >= final.createdAt);
      assert.ok(
        footerText(render()).includes(
          `Stop ${first.id} #${first.generation} · writer · implementation: stopped and drained`,
        ),
        "success identifies the same target only after its real SDK drain completes",
      );
      assert.match(transcriptLines(f.coordinator.messages(first), true).join("\n"), /Tool write/);
    } finally {
      release();
      hub?.dispose();
    }
  },
);

test("real SDK selected generation retains full outcomes/transcript/artifacts across renewal; Hub cannot allocate a generation", async (t) => {
  const f = await fixture(t, {
    speed: 0,
    response: (context) => {
      const assignment = assignmentText(context);
      return context.messages.at(-1)?.role === "toolResult"
        ? fauxAssistantMessage("final " + assignment)
        : fauxAssistantMessage(
            fauxToolCall("submit_result", { value: { text: "structured " + assignment } }),
            { stopReason: "toolUse" },
          );
    },
  });
  const admission = await captureAdmission(t, f);
  const warmup = await f.direct("warmup", "scout");
  await f.coordinator.wait(warmup);
  const [ref] = await f.coordinator.admit([
    {
      ...admission(),
      assignment: "original",
      resultSchema: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
        additionalProperties: false,
      },
    },
  ]);
  const first = await f.coordinator.wait(ref);
  const messages = f.coordinator.messages(ref);
  const originalTranscript = await readFile(first.transcript!, "utf8");
  const originalArtifact = await readFile(first.artifacts!.structured!, "utf8");
  const hub = createHub(
    f.coordinator,
    palette,
    keys,
    () => {},
    () => {},
    dependencies,
    () => 30,
  );
  const render = () => stripVTControlCharacters(hub.render(180).join("\n"));
  try {
    render();
    hub.handleInput!("\x1b[B");
    render(); // pin original, not the warmup
    const next = await f.coordinator.renew(ref, { ...admission(), assignment: "successor" });
    await f.coordinator.wait(next);
    assert.equal(f.coordinator.list().length, 2, "latest identities remain unchanged");
    const sessions = f.coordinator.sessions();
    assert.equal(sessions.length, 3, "renewal retains an individually counted session");
    assert.deepEqual(
      f.coordinator.generations(ref.id).map((child) => child.generation),
      [ref.generation, next.generation],
    );
    Reflect.set(sessions[0], "assignment", "mutated observer snapshot");
    assert.notEqual(f.coordinator.sessions()[0].assignment, sessions[0].assignment);
    const widget = createChildWidget(() => f.coordinator.sessions(), palette);
    assert.deepEqual(widget.render(180), ["● Subagents 3 · 3 settled · /subagent-hub"]);
    assert.match(render(), /SUBAGENTS · 3 generations/);
    assert.match(render(), /> [├└] ● original/);
    assert.doesNotMatch(render(), /#1/, "generation badge is not shown in the roster");
    hub.handleInput!("\x1b[F");
    assert.match(render(), /structured original/);
    assert.match(render(), /final original/);
    assert.doesNotMatch(render(), /final successor/);
    hub.handleInput!("\t");
    const detailsStart = render();
    hub.handleInput!("\x1b[F");
    const details = detailsStart + render();
    assert.match(details, /structured.json/);
    assert.match(details, /Effective builtin tools: read/);
    assert.match(details, /Direct requests/);
    assert.deepEqual(f.coordinator.messages(ref), messages);
    const detached = f.coordinator.messages(ref);
    detached.length = 0;
    assert.deepEqual(f.coordinator.messages(ref), messages, "readonly projection must be detached");
    assert.equal(await readFile(first.transcript!, "utf8"), originalTranscript);
    assert.equal(await readFile(first.artifacts!.structured!, "utf8"), originalArtifact);
    const before = f.model.state.callCount;
    const generations = f.coordinator.generations(ref.id);
    hub.handleInput!("f");
    hub.handleInput!("r");
    assert.deepEqual(f.coordinator.generations(ref.id), generations);
    assert.equal(f.model.state.callCount, before, "unsupported UI renewal must never dispatch");
    assert.match(render(), /no generation started/);
    assert.equal(first.outcome?.finalized, true);
    assert.equal(first.outcome?.validation, "submitted");
  } finally {
    hub.dispose();
  }
});

test(
  "real SDK filtered/draining target cannot redirect pending Hub message to another running UUID",
  { timeout: 10000 },
  async (t) => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered = 0;
    const f = await fixture(t, {
      speed: 0,
      extra: (pi) => {
        pi.on("tool_call", async (event) => {
          if (event.toolName === "read" && String(event.input.path).endsWith(".held")) {
            entered++;
            await gate;
          }
        });
      },
      response: (context) =>
        assignmentText(context) === "warmup" || context.messages.at(-1)?.role === "toolResult"
          ? fauxAssistantMessage("done")
          : fauxAssistantMessage(
              fauxToolCall("read", { path: assignmentText(context) + ".held" }),
              { stopReason: "toolUse" },
            ),
    });
    const admission = await captureAdmission(t, f);
    let hub: ReturnType<typeof createHub> | undefined;
    let stopping: Promise<void> | undefined;
    try {
      const warmup = await f.direct("warmup", "scout");
      await f.coordinator.wait(warmup);
      const [first, second] = await f.coordinator.admit([
        { ...admission(), assignment: "first" },
        { ...admission(), assignment: "second" },
      ]);
      await eventually(() => entered === 2);
      hub = createHub(
        f.coordinator,
        palette,
        keys,
        () => {},
        () => {},
        dependencies,
        () => 30,
      );
      const render = () => stripVTControlCharacters(hub!.render(160).join("\n"));
      hub.handleInput!("/");
      hub.handleInput!("running");
      hub.handleInput!("\r");
      assert.match(render(), /> [├└] ● first/);
      hub.handleInput!("m");
      hub.handleInput!("never redirect me");
      stopping = f.coordinator.stop(first);
      await eventually(() => f.coordinator.snapshot(first)!.status === "draining");
      assert.match(render(), /> [├└] ● second/);
      assert.match(render(), new RegExp(`Target: ${first.id} #1`));
      const calls = f.model.state.callCount;
      hub.handleInput!("\r");
      const refusal = footerText(render());
      assert.ok(
        refusal.includes(
          `Inbox ${first.id} #${first.generation} · first · scout failed: Error: Target ${first.id} #${first.generation} is no longer running; no action sent`,
        ),
        "wrapped refusal retains both the original target and the no-action outcome",
      );
      assert.ok(
        !refusal.includes(`Inbox ${second.id} #${second.generation}`),
        "feedback must not describe the newly selected running task as its target",
      );
      assert.equal(f.model.state.callCount, calls);
      assert.equal(f.coordinator.snapshot(second)!.status, "running");
      await assert.rejects(
        () => f.coordinator.inbox(second),
        /denied/,
        "child inbox is default-off; operator cannot impersonate it",
      );
      release();
      await stopping;
      await f.coordinator.wait(second);
      assert.doesNotMatch(
        transcriptLines(f.coordinator.messages(second)).join("\n"),
        /never redirect me/,
      );
    } finally {
      release();
      await stopping;
      hub?.dispose();
    }
  },
);
