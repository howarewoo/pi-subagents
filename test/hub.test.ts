import { stripVTControlCharacters as stripAnsi } from "node:util";
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createChildWidget, createHub, taskCard, transcriptLines, safe } from "../src/hub.ts";
import { DelegationCoordinator, type ChildRef, type ChildSnapshot } from "../src/coordinator.ts";
import {
  Text,
  ProcessTerminal,
  TuiMainScreen,
  backgroundAnsi,
  oklchColor,
  styleText,
  visibleWidth,
  truncateToWidth,
  getKeybindings,
  setKeybindings,
  KeybindingsManager,
  TUI_KEYBINDINGS,
} from "@earendil-works/pi-tui";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import {
  initTheme,
  AssistantMessageComponent,
  ToolExecutionComponent,
  type ThemeStyle,
} from "@earendil-works/pi-coding-agent";
import { fixture } from "./fixtures.ts";
import { statusLine, taskTree } from "../src/task-presentation.ts";

initTheme("dark", false);
const dependencies = { tui: new TuiMainScreen(new ProcessTerminal()), cwd: process.cwd() };
dependencies.tui.requestRender = () => {}; // Unstarted real TUI: no terminal writes in component tests.
const keys = {
  matches: (data: string, action: string) => data === "escape" && action === "tui.select.cancel",
  getKeys: () => ["escape" as const],
};
const theme = {
  fg: (_color: string, text: string) => text,
  colors: { customMessageBg: oklchColor(0.3, 0.1, 330) },
  style: (text: string, { bg }: ThemeStyle) => {
    assert.ok(bg && typeof bg !== "string", "panel must supply a concrete neutral color");
    return styleText(text, { bg }, "truecolor");
  },
};

test("hub frames, pads and paints every cell, adapts to tiny geometry and invalidates theme output", () => {
  const coordinator = new DelegationCoordinator("unused-render-only", "parent");
  let rows = 24;
  const borderCalls: string[] = [];
  const palette = {
    ...theme,
    colors: { ...theme.colors },
    fg: (color: string, text: string) => {
      if (color === "border") borderCalls.push(text);
      return text;
    },
  };
  const darkBg = backgroundAnsi(oklchColor(0.3, 0, 0), "truecolor");
  const hub = createHub(
    coordinator,
    palette,
    keys,
    () => {},
    () => {},
    dependencies,
    () => rows,
  );
  try {
    for (const width of [0, 1, 2, 3, 4, 8, 20, 40, 80]) {
      for (rows of [1, 2, 3, 4, 5, 6, 7, 8, 9, 24]) {
        const rendered = hub.render(width);
        assert.ok(rendered.length <= rows);
        assert.ok(rendered.every((line) => visibleWidth(line) === width));
        assert.ok(rendered.every((line) => line.startsWith(darkBg) && line.endsWith("\x1b[49m")));
        if (width >= 4 && rows >= 3) {
          assert.match(rendered[0], /╭.*╮/);
          assert.match(rendered.at(-1)!, /╰.*╯/);
          assert.ok(
            rendered
              .slice(1, -1)
              .every(
                (line) =>
                  stripAnsi(line) === "├" + "─".repeat(width - 2) + "┤" ||
                  (line.includes("│ ") && line.includes(" │")),
              ),
          );
          const separators = rendered.filter((line) => stripAnsi(line).startsWith("├"));
          assert.equal(
            separators.length,
            rows >= 8 ? 1 : 0,
            "only visible footers get a separator",
          );
          if (separators.length) {
            const separatorIndex = rendered.indexOf(separators[0]);
            // Whole named/configured hints may wrap onto more footer rows.
            assert.ok(separatorIndex >= 2 && separatorIndex <= rendered.length - 4);
            assert.equal(stripAnsi(separators[0]), "├" + "─".repeat(width - 2) + "┤");
          }
        }
      }
    }
    rows = 24;
    assert.match(hub.render(80).join("\n"), /Subagent Hub/);
    assert.match(hub.render(80).join("\n"), /escape: close/);
    assert.ok(borderCalls.includes("├" + "─".repeat(78) + "┤"), "separator uses the border color");
    palette.colors.customMessageBg = oklchColor(0.9, 0.1, 330);
    hub.invalidate();
    const lightBg = backgroundAnsi(oklchColor(0.9, 0, 0), "truecolor");
    assert.ok(hub.render(80).every((line) => line.startsWith(lightBg)));
  } finally {
    hub.dispose();
  }
});

test("widget counts each child state, sanitizes terminal content and shows only active details", () => {
  let child: ChildSnapshot | undefined;
  const widget = createChildWidget(() => (child ? [child] : []), theme);
  for (const width of [0, 1, 8, 20, 80, 140])
    assert.deepEqual(widget.render(width), [], "no pinned line before the first subagent");
  for (const status of [
    "queued",
    "setup",
    "running",
    "draining",
    "pausing",
    "paused",
    "settled",
    "cancelled",
    "failed",
  ] as const) {
    child = {
      depth: 1,
      limits: { deadlineMs: 600000, requests: 100, tools: 100, depth: 2, spawns: 8 },
      toolCalls: 0,
      tools: ["read"],
      createdAt: 1,
      endedAt: null,
      writerLease: false,
      id: "test",
      generation: 1,
      parentId: "parent",
      profile: "general",
      assignment: "test",
      activity: "",
      model: { provider: "test", id: "test" },
      effort: "off",
      telemetry: { requests: null, tokens: null, cost: null, context: null },
      status,
      progress: "old activity ".repeat(20) + "中文 👩‍💻 latest\u001b\u0007",
      result: "final result",
      disposed: ["settled", "failed", "cancelled"].includes(status),
    };
    const output = widget.render(80).join("\n");
    assert.ok(output.includes(status));
    assert.ok(widget.render(20)[0].startsWith("● Subagents"));
    assert.ok(!/[\x00-\x1f\x7f-\x9f]/.test(stripAnsi(output).replaceAll("\n", "")));
    if (["setup", "running", "draining", "pausing"].includes(status)) {
      assert.ok(output.includes("test"));
      assert.match(output, /中文 👩‍💻 latest/);
    } else {
      assert.equal(widget.render(80).length, 1);
      assert.doesNotMatch(output, /final result|latest|general/);
    }
    for (const width of [0, 1, 2, 8, 20, 40])
      assert.ok(widget.render(width).every((line) => visibleWidth(line) <= width));
  }
  child = {
    ...child!,
    status: "running",
    profile: "implementation",
    writerLease: true,
    disposed: false,
  };
  assert.doesNotMatch(widget.render(100).join("\n"), /writer|unsafe|no conflicting|!\/!!/i);
  child = { ...child!, status: "failed", error: "Cannot start\u001b\u0007" };
  assert.doesNotMatch(widget.render(140).join("\n"), /Cannot start|implementation/);
  child = undefined;
  assert.deepEqual(widget.render(100), [], "an empty replacement registry hides the widget again");
});

function snapshot(id: string, patch: Partial<ChildSnapshot> = {}): ChildSnapshot {
  return {
    id,
    depth: 1,
    limits: { deadlineMs: 600000, requests: 100, tools: 100, depth: 2, spawns: 8 },
    toolCalls: 0,
    tools: ["read"],
    generation: 1,
    parentId: "root",
    status: "running",
    profile: "scout",
    assignment: "inspect " + id,
    activity: "Tool: read",
    progress: "streaming",
    result: "",
    model: { provider: "controlled", id: "model" },
    effort: null,
    telemetry: { requests: null, tokens: null, cost: null, context: null },
    disposed: false,
    createdAt: 1000,
    endedAt: null,
    writerLease: false,
    ...patch,
  };
}
test("widget removes details on completion while retaining full fleet counts", () => {
  let children = [snapshot("transition", { activity: "Live preview" })];
  const widget = createChildWidget(() => children, theme);
  assert.match(widget.render(180).join("\n"), /inspect transition.*\n.*Live preview/);
  children = [{ ...children[0], status: "settled", disposed: true, result: "Final preview" }];
  assert.deepEqual(widget.render(180), ["● Subagents 1 · 1 settled · /subagent-hub"]);
  assert.deepEqual(widget.render(55), ["● Subagents 1 · 1 settled · /subagent-hub"]);
});

test("widget keeps queued and finished fleets summary-only, including undisposed terminal states", () => {
  for (const statuses of [
    ["queued", "queued"],
    ["settled", "failed", "cancelled"],
  ] as const) {
    const children = statuses.map((status, index) =>
      snapshot(String(index), { status, disposed: index === 0 && status !== "queued" }),
    );
    const widget = createChildWidget(() => children, theme);
    assert.equal(widget.render(180).length, 1);
    for (const status of new Set(statuses))
      assert.match(
        widget.render(180)[0],
        new RegExp(`${statuses.filter((s) => s === status).length} ${status}`),
      );
    assert.match(widget.render(55).join("\n"), /\/subagent-hub/);
    for (const status of new Set(statuses))
      assert.match(
        widget.render(55)[0],
        new RegExp(`${statuses.filter((s) => s === status).length} ${status}`),
      );
  }
});

test("widget overflow counts only non-disposed setup/running/draining tasks", () => {
  const children = [
    snapshot("done", { status: "settled", disposed: true }),
    snapshot("queued", { status: "queued" }),
    snapshot("disposed", { status: "running", disposed: true }),
    snapshot("setup", { status: "setup" }),
    snapshot("running"),
    snapshot("draining", { status: "draining" }),
    snapshot("extra", { status: "setup" }),
  ];
  const widget = createChildWidget(() => children, theme);
  const lines = widget.render(180);
  assert.equal(lines.length, 5);
  assert.match(lines[0], /Subagents 7.*1 queued.*2 setup.*2 running.*1 draining.*1 settled/);
  assert.match(lines[1], /inspect draining/);
  assert.match(lines[3], /inspect running/);
  assert.equal(lines[4], "└─ 2 more · /subagent-hub");
  assert.doesNotMatch(lines.slice(1).join("\n"), /inspect done|inspect queued|inspect disposed/);
  assert.match(widget.render(55)[0], /4 active · 1 queued/);
});

const effectiveKeys = {
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
  getKeys: (action: string) =>
    (
      {
        "tui.select.cancel": ["escape"],
        "tui.select.confirm": ["enter"],
        "tui.select.up": ["up"],
        "tui.select.down": ["down"],
        "tui.select.pageUp": ["pageUp"],
        "tui.select.pageDown": ["pageDown"],
        "app.tools.expand": ["ctrl+o"],
      } as Record<string, ReturnType<KeybindingsManager["getKeys"]>>
    )[action] ?? [],
};

test("historical lease values add no runtime exclusivity claims", (t) => {
  let child = snapshot("active", { profile: "implementation", writerLease: true });
  const coordinator = new DelegationCoordinator("unused-render-only", "root");
  t.mock.method(coordinator, "list", () => [child]);
  t.mock.method(coordinator, "generations", () => [child]);
  t.mock.method(coordinator, "messages", () => []);
  const hub = createHub(
    coordinator,
    theme,
    effectiveKeys,
    () => {},
    () => {},
    dependencies,
    () => 30,
  );
  try {
    for (const width of [40, 100, 180]) {
      const writerOutput = hub.render(width).map(stripAnsi);
      assert.doesNotMatch(writerOutput.join("\n"), /WRITER:|manual\/external writes/);
      child = { ...child, writerLease: false };
      assert.deepEqual(hub.render(width).map(stripAnsi), writerOutput);
      child = { ...child, writerLease: true };
    }
    hub.handleInput!("\t");
    hub.render(180);
    hub.handleInput!("\x1b[F");
    assert.doesNotMatch(
      stripAnsi(hub.render(180).join("\n")),
      /writer lease|Model-tool writer only/,
    );
  } finally {
    hub.dispose();
  }
});

test("fleet counts every lifecycle and bounds height independently of task count or writer lease", () => {
  const children = [
    snapshot("reader", { profile: "implementation" }),
    ...["setup", "running", "settled", "failed", "cancelled"].map((status) =>
      snapshot(status, {
        status: status as ChildSnapshot["status"],
        disposed: status !== "running" && status !== "setup",
      }),
    ),
  ];
  const widget = createChildWidget(() => children, theme);
  const text = stripAnsi(widget.render(180).join("\n"));
  assert.match(text, /● Subagents 6/);
  assert.match(text, /2 running/);
  assert.match(text, /1 failed/);
  assert.doesNotMatch(text, /no conflicting/);
  children[0] = { ...children[0], writerLease: true };
  assert.doesNotMatch(widget.render(180).join("\n"), /writer|unsafe|no conflicting|!\/!!/i);
  for (const rows of [4, 8, 16, 30])
    assert.ok(
      createChildWidget(
        () => children,
        theme,
        () => rows,
      ).render(40).length <= Math.max(1, Math.floor(rows / 4)),
    );
});

test("Hub selection survives streaming/new completion; search, tabs, full transcript scroll and controls use selected generation", async (t) => {
  const coordinator = new DelegationCoordinator("unused", "root");
  let children = [snapshot("first"), snapshot("second", { generation: 7 })];
  let listener: Parameters<DelegationCoordinator["subscribe"]>[0] | undefined;
  let detached = false,
    closed = 0,
    renders = 0;
  const calls: unknown[] = [];
  t.mock.method(coordinator, "list", () => structuredClone(children));
  t.mock.method(coordinator, "snapshot", (ref: ChildRef) =>
    structuredClone(
      children.find((child) => child.id === ref.id && child.generation === ref.generation),
    ),
  );
  t.mock.method(
    coordinator,
    "subscribe",
    (cb: Parameters<DelegationCoordinator["subscribe"]>[0]) => {
      listener = cb;
      return () => {
        detached = true;
      };
    },
  );
  t.mock.method(coordinator, "messages", () => [
    {
      role: "user",
      content: Array.from({ length: 100 }, (_, i) => `FULL LINE ${i} 中文`).join("\n"),
      timestamp: 1,
    },
  ]);
  t.mock.method(coordinator, "steer", async (ref: ChildRef, text: string) => {
    calls.push([ref.id, ref.generation, text]);
    return "queued";
  });
  t.mock.method(coordinator, "stop", async (ref: ChildRef) => {
    calls.push([ref.id, ref.generation, "stop"]);
  });
  const hub = createHub(
    coordinator,
    theme,
    effectiveKeys,
    () => renders++,
    () => closed++,
    dependencies,
    () => 20,
  );
  const output = () => stripAnsi(hub.render(100).join("\n"));
  assert.match(output(), /> [├└] ● inspect first/);
  hub.handleInput!("\x1b[B");
  assert.match(output(), /> [├└] ● inspect second/);
  children = [...children, snapshot("new", { status: "settled", disposed: true })];
  listener!({ type: "changed", child: children[2] });
  assert.match(output(), /> [├└] ● inspect second/);
  assert.doesNotMatch(output(), /Direct requests/);
  assert.match(output(), /FULL LINE 99/);
  hub.handleInput!("\x1b[H");
  assert.match(output(), /FULL LINE 0/);
  hub.handleInput!("\x1b[6~");
  assert.doesNotMatch(output(), /FULL LINE 0 /);
  hub.handleInput!("\x1b[F");
  assert.match(output(), /FULL LINE 99/);
  hub.handleInput!("\t");
  hub.handleInput!("\x1b[F");
  assert.match(output(), /Followup\/revive: native delegate_coordinate only/);
  hub.handleInput!("\t");
  assert.match(output(), /TOOLS/);
  assert.match(output(), /Steer · Enter to compose a message for this task/);
  hub.handleInput!("\r");
  hub.handleInput!("new direction");
  assert.match(output(), /Steer > new direction/);
  assert.match(output(), /Target: second #7/);
  hub.handleInput!("\r");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls[0], ["second", 7, "new direction"]);
  hub.handleInput!("x");
  hub.handleInput!("\r");
  assert.equal(calls.length, 1, "Enter never confirms stop");
  hub.handleInput!("\x1b");
  hub.handleInput!("x");
  assert.match(output(), /Target: second #7/);
  hub.handleInput!("y");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls[1], ["second", 7, "stop"]);
  hub.handleInput!("/");
  hub.handleInput!("first");
  hub.handleInput!("\r");
  assert.match(output(), /> [├└] ● inspect first/);
  assert.doesNotMatch(output(), /[├└] ● inspect second/);
  hub.handleInput!("\r");
  assert.match(output(), /Steer > /);
  hub.handleInput!("\x1b");
  assert.equal(closed, 0, "Enter focuses the composer and Esc leaves it; neither closes");
  hub.handleInput!("\x1b");
  assert.equal(closed, 1);
  assert.equal(calls.length, 2, "navigation/closing never invokes controls");
  hub.dispose();
  assert.ok(detached);
  assert.ok(renders > 0);
});

test("Delegate results collapse single and batch cards, wrap safely, and use the configured global expansion hint", async (t) => {
  const f = await fixture(t);
  const definition = f.session.extensionRunner.getToolDefinition("delegate_task");
  assert.ok(definition?.renderResult);
  const originalKeys = getKeybindings();
  t.after(() => setKeybindings(originalKeys));
  const children = [
    snapshot("done", {
      assignment: "# Inspect 中文 👩‍💻\nPrivate assignment details",
      generation: 3,
      status: "settled",
      disposed: true,
      result: "Private result preview",
      transcript: "/session/transcript.jsonl",
      artifacts: { text: "/session/result.txt" },
    }),
    snapshot("failed", {
      status: "failed",
      error: "Cannot start\n" + "bad\x1b[31m\u202e".repeat(200),
    }),
    snapshot("cancelled", { status: "cancelled" }),
    snapshot("paused", {
      status: "paused",
      pauseReason: "ancestor deadline",
      retainedContext: true,
    }),
  ];
  assert.deepEqual(taskCard(children[0]), ["Inspect 中文 👩‍💻 · scout #3 · settled"]);
  assert.equal(taskCard(children[1]).length, 2);
  assert.ok(visibleWidth(taskCard(children[1])[1]) < 260, "error preview is bounded");
  assert.doesNotMatch(taskCard(children[1]).join("\n"), /\x1b|\u202e/);
  assert.deepEqual(taskCard(children[2]), ["inspect cancelled · scout #1 · cancelled"]);
  assert.deepEqual(taskCard(children[3]), [
    "inspect paused · scout #1 · paused",
    "Pause: ancestor deadline",
  ]);
  assert.match(taskCard({ ...children[3], pauseReason: undefined }).join("\n"), /Pause: deadline/);
  assert.match(taskCard(undefined).join("\n"), /Task identity unavailable/);

  for (const key of ["ctrl+o", "ctrl+g"] as const) {
    setKeybindings(
      new KeybindingsManager(
        { "app.tools.expand": { defaultKeys: "ctrl+o" } },
        { "app.tools.expand": key },
      ),
    );
    for (const details of [children[0], { children }]) {
      const component = new ToolExecutionComponent(
        "delegate_task",
        "card-call",
        {
          profile: "scout",
          assignment: "Inspect",
          ...("children" in details ? { tasks: [] } : {}),
        },
        { showImages: false, outputPad: 0 },
        definition,
        dependencies.tui,
        process.cwd(),
      );
      component.setArgsComplete();
      const result = {
        content: [{ type: "text", text: "MODEL_FACING_OUTPUT" }],
        details,
        isError: false,
      };
      const before = structuredClone(result);
      component.updateResult(result);
      const collapsed = stripAnsi(component.render(500).join("\n"));
      assert.match(collapsed, /Delegate ·/);
      assert.ok(collapsed.includes(`${key} to expand`));
      assert.equal(collapsed.match(/to expand/g)?.length, 1, "one hint for the entire batch");
      assert.doesNotMatch(
        collapsed,
        /Identity|controlled\/model|Window|Artifacts:|Full transcript|Private|MODEL_FACING_OUTPUT/,
      );
      assert.equal(taskCard(children[0]).length, 1);
      if ("children" in details) {
        assert.match(collapsed, /failed *\nError: Cannot start/);
        assert.match(collapsed, /cancelled/);
        assert.match(collapsed, /paused *\nPause: ancestor deadline/);
      }
      for (const expanded of [false, true, false]) {
        component.setExpanded(expanded);
        for (const width of [12, 24, 40, 80, 500]) {
          const lines = component.render(width);
          assert.ok(
            lines.every((line) => visibleWidth(line) <= width),
            `fits ${width} columns`,
          );
        }
        const rendered = stripAnsi(component.render(500).join("\n"));
        if (expanded) {
          for (const detail of [
            "Identity done #3",
            "controlled/model",
            "Window",
            "Artifacts:",
            "Full transcript:",
            "Assignment:",
            "Result:",
            "Private result preview",
          ])
            assert.ok(rendered.includes(detail), detail);
          assert.doesNotMatch(rendered, /to expand/);
        } else assert.doesNotMatch(rendered, /Identity|Assignment:|Result:/);
      }
      assert.deepEqual(
        result,
        before,
        "UI projection never changes model-facing output or artifacts",
      );
      component.updateResult({
        content: [{ type: "text", text: "Setup failed\nUseful cause\x1b[31m\u202e" }],
        isError: true,
      });
      for (const expanded of [false, true]) {
        component.setExpanded(expanded);
        const error = stripAnsi(component.render(80).join("\n"));
        assert.match(error, /Setup failed *\nUseful cause/);
        assert.doesNotMatch(error, /to expand|\u202e/);
      }
    }
  }
});

test("cards and transcript project real messages and sanitize controls/bidi without exposing opaque provider payloads", () => {
  const child = snapshot("card", {
    transcript: "/session/transcript.jsonl",
    error: "Failed\x1b[31m\u202e",
  });
  assert.match(taskCard(child, true).join("\n"), /inspect card.*scout #1.*running/);
  assert.match(taskCard(child, true).join("\n"), /Full transcript/);
  assert.equal(safe("a\x1b]52;c;secret\x07b\x1b[31m\u200f"), "ab ");
  const messages: ReturnType<DelegationCoordinator["messages"]> = [
    {
      role: "assistant",
      content: [
        { type: "toolCall", id: "call", name: "read\x1b[31m", arguments: { path: "real.ts" } },
      ],
      api: "x",
      model: "x",
      provider: "x",
      timestamp: 1,
      stopReason: "toolUse",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    },
    {
      role: "toolResult",
      toolCallId: "call",
      toolName: "read",
      content: [{ type: "text", text: "ACTUAL OUTPUT\x1b[31m" }],
      details: { credentials: "NOT FOR DISPLAY" },
      isError: true,
      timestamp: 2,
    },
  ];
  const text = transcriptLines(messages, true).join("\n");
  assert.match(text, /Tool read call/);
  assert.match(text, /real.ts/);
  assert.match(text, /ERROR/);
  assert.match(text, /ACTUAL OUTPUT/);
  assert.doesNotMatch(text, /NOT FOR DISPLAY|\x1b|\u202e/);
});

// Mutable registry fixtures must publish the same detached change notifications as the coordinator.
function registryChanges(t: TestContext, coordinator: DelegationCoordinator) {
  let listener!: Parameters<DelegationCoordinator["subscribe"]>[0];
  t.mock.method(coordinator, "subscribe", (callback: typeof listener) => {
    listener = callback;
    return () => {};
  });
  return (child: ChildSnapshot) => listener({ type: "changed", child: structuredClone(child) });
}

for (const action of ["steer", "stop", "message"] as const) {
  test(`Hub ${action} pins the original target across filter changes and refuses stale generations`, async (t) => {
    const coordinator = new DelegationCoordinator("unused", "root");
    const changed = registryChanges(t, coordinator);
    let children = [snapshot("A", { generation: 7 }), snapshot("B", { generation: 9 })];
    const dispatches: ChildRef[] = [];
    const lookups: ChildRef[] = [];
    t.mock.method(coordinator, "list", () => structuredClone(children));
    t.mock.method(coordinator, "snapshot", (ref: ChildRef) => {
      lookups.push({ ...ref });
      const child = children.find((child) => child.id === ref.id);
      if (!child || child.generation !== ref.generation)
        throw new Error("Unknown or stale delegation identity");
      return structuredClone(child);
    });
    t.mock.method(coordinator, "steer", async (ref: ChildRef) => {
      dispatches.push({ ...ref });
      return "queued";
    });
    t.mock.method(coordinator, "stop", async (ref: ChildRef) => {
      dispatches.push({ ...ref });
    });
    t.mock.method(
      coordinator,
      "message",
      async (_actor: ChildRef | undefined, ref: ChildRef | undefined) => {
        dispatches.push({ ...ref! });
        throw new Error("unexpected message dispatch");
      },
    );
    const hub = createHub(
      coordinator,
      theme,
      effectiveKeys,
      () => {},
      () => {},
      dependencies,
      () => 24,
    );
    const render = () => stripAnsi(hub.render(100).join("\n"));
    const open = () =>
      hub.handleInput!(action === "steer" ? "\r" : action === "message" ? "m" : "x");
    const begin = () => {
      render();
      open();
      if (action !== "stop") hub.handleInput!("original target only");
      assert.match(render(), /Target: A #7/);
    };
    const submit = async () => {
      hub.handleInput!(action !== "stop" ? "\r" : "y");
      await new Promise((resolve) => setImmediate(resolve));
      if (action === "steer") {
        // A refused steer keeps its pinned target and draft in the composer until Esc.
        assert.match(render(), /Target: A #7/);
        assert.match(render(), /Steer > original target only/);
        hub.handleInput!("\x1b");
      }
    };
    try {
      hub.handleInput!("/");
      hub.handleInput!("running");
      hub.handleInput!("\r");
      begin();
      children[0] = { ...children[0], status: "settled", disposed: true };
      changed(children[0]);
      assert.match(render(), /> [├└] ● inspect B/, "ordinary roster fallback still works");
      assert.match(render(), /Target: A #7/, "confirmation/input still identifies original target");
      await submit();
      assert.deepEqual(lookups, [{ id: "A", generation: 7 }]);
      assert.deepEqual(dispatches, [], "neither B nor settled A receives the action");
      assert.match(render(), /no longer running; no action sent/);
      assert.doesNotMatch(render(), /Target:/, "submit clears pinned target");

      children = [snapshot("A", { generation: 7 }), snapshot("B", { generation: 9 })];
      changed(children[0]);
      hub.handleInput!("\x1b[A");
      begin();
      children[0] = { ...children[0], generation: 8 };
      changed(children[0]);
      await submit();
      assert.deepEqual(
        lookups.at(-1),
        { id: "A", generation: 7 },
        "must not silently upgrade target generation",
      );
      assert.deepEqual(dispatches, []);
      assert.match(render(), /Unknown or stale delegation identity/);

      children[0] = { ...children[0], generation: 7 };
      changed(children[0]);
      begin();
      children[0] = { ...children[0], status: "draining" };
      changed(children[0]);
      await submit();
      assert.deepEqual(
        dispatches,
        [],
        "a target that starts draining during input refuses every action",
      );
      assert.match(render(), /no action sent/);
      hub.handleInput!("/");
      hub.handleInput!("\x15");
      hub.handleInput!("draining");
      hub.handleInput!("\r");
      open();
      assert.match(
        render(),
        action === "steer" ? /Steering unavailable/ : /Controls unavailable/,
        "already draining targets cannot open controls",
      );
      children[0] = { ...children[0], status: "running" };
      changed(children[0]);
      hub.handleInput!("/");
      hub.handleInput!("\x15");
      hub.handleInput!("running");
      hub.handleInput!("\r");
      hub.handleInput!("\x1b[A");
      begin();
      hub.handleInput!("\x1b");
      assert.doesNotMatch(render(), /Target:/, "cancel clears pinned target");
      hub.handleInput!("\x1b[B");
      open();
      assert.match(render(), /Target: B #9/, "next interaction captures its own target");
    } finally {
      hub.dispose();
    }
  });
}

test("Hub opens with agents on the left and the selected full thread on the right; narrow fallback preserves reading", (t) => {
  const coordinator = new DelegationCoordinator("unused", "root");
  const children = Array.from({ length: 12 }, (_, index) =>
    snapshot(`agent-${index}`, { assignment: `Assignment ${index} 中文 👩‍💻` }),
  );
  t.mock.method(coordinator, "list", () => children);
  t.mock.method(coordinator, "messages", (ref: ChildRef) => [
    {
      role: "user",
      timestamp: 1,
      content: Array.from({ length: 90 }, (_, index) => `${ref.id} THREAD LINE ${index} 中文`).join(
        "\n",
      ),
    },
  ]);
  let rows = 27;
  const hub = createHub(
    coordinator,
    theme,
    effectiveKeys,
    () => {},
    () => {},
    dependencies,
    () => rows,
  );
  const render = (width = 90) => hub.render(width).map(stripAnsi);
  try {
    const wide = render();
    const adjacent = wide.find((line) => line.includes("AGENTS") && line.includes("Assignment 0"));
    assert.ok(adjacent, "selection heading and selected identity must share the same physical row");
    assert.ok(
      wide.some((line) => /> [├└] ● Assignment 0/.test(line) && line.includes("THREAD")),
      "left roster and right view must be adjacent",
    );
    assert.match(wide.join("\n"), /agent-0 THREAD LINE 89/);
    assert.doesNotMatch(wide.join("\n"), /Direct tokens|Limits \{|Prewalk/);
    assert.ok(wide.every((line) => visibleWidth(line) === 90));
    const left = wide.slice(1, -1).map((line) => line.split("│")[1]);
    hub.handleInput!("\x1b[5~");
    assert.match(render().join("\n"), /agent-0 THREAD LINE/);
    assert.deepEqual(
      render()
        .slice(1, -1)
        .map((line) => line.split("│")[1]),
      left,
      "thread scrolling must not scroll the roster",
    );
    for (let index = 0; index < 10; index++) hub.handleInput!("\x1b[B");
    assert.match(render().join("\n"), /> [├└] ● Assignment 10/);
    assert.match(render().join("\n"), /agent-10 THREAD LINE 89/);
    rows = 14;
    const narrow = render(36);
    assert.ok(narrow.every((line) => visibleWidth(line) === 36));
    assert.ok(narrow.length <= rows);
    assert.match(narrow.join("\n"), /> [├└] ● Assignment 10/);
    assert.match(narrow.join("\n"), /THREAD LINE 89/);
    assert.doesNotMatch(narrow.join("\n"), /AGENTS/);
  } finally {
    hub.dispose();
  }
});

test("Hub roster aligns profile and status beneath each name at every nesting depth", (t) => {
  const coordinator = new DelegationCoordinator("unused", "root");
  const children = [1, 2, 3, 8].map((depth) =>
    snapshot(`agent-${depth}`, { assignment: `A${depth}`, depth }),
  );
  t.mock.method(coordinator, "list", () => children);
  t.mock.method(coordinator, "messages", () => []);
  const hub = createHub(
    coordinator,
    theme,
    effectiveKeys,
    () => {},
    () => {},
    dependencies,
    () => 27,
  );
  try {
    for (const width of [76, 90, 120]) {
      for (let selected = 0; selected < children.length; selected++) {
        const rows = hub.render(width).map(stripAnsi);
        const leftWidth = Math.min(32, Math.max(24, Math.floor((width - 4) / 3)));
        for (const child of children) {
          const index = rows.findIndex((row) =>
            row.slice(2, 2 + leftWidth).includes(`A${child.depth}`),
          );
          assert.ok(index >= 0);
          const name = rows[index].slice(2, 2 + leftWidth);
          const details = rows[index + 1].slice(2, 2 + leftWidth);
          const parentColumn = rows
            .find((row) => row.slice(2, 2 + leftWidth).includes("A1"))!
            .slice(2)
            .indexOf("A");
          assert.equal(
            name.indexOf("A") - parentColumn,
            Math.min(3, child.depth - 1) * 4,
            "nested names advance four columns per level, capped at three levels",
          );
          assert.equal(details.indexOf("sco"), name.indexOf("A"));
          assert.equal(
            details.replaceAll("│", " ").trim(),
            stripAnsi(
              truncateToWidth(" ".repeat(name.indexOf("A")) + "scout · running", leftWidth),
            ).trim(),
            "details remain aligned and truncate only at the pane boundary",
          );
          assert.doesNotMatch(name, /scout/, "profile belongs on its own line, not twice");
          assert.equal(visibleWidth(rows[index]), width);
          assert.equal(visibleWidth(rows[index + 1]), width);
        }
        hub.handleInput!("\x1b[B");
      }
    }
  } finally {
    hub.dispose();
  }
});

test("Hub full thread preserves role/thinking/tool/error text, isolates ANSI and holds reading position through streamed deltas", (t) => {
  const coordinator = new DelegationCoordinator("unused", "root");
  const child = snapshot("content");
  let listener!: Parameters<DelegationCoordinator["subscribe"]>[0];
  t.mock.method(
    coordinator,
    "subscribe",
    (callback: Parameters<DelegationCoordinator["subscribe"]>[0]) => {
      listener = callback;
      return () => {};
    },
  );
  t.mock.method(coordinator, "list", () => [child]);
  let messages: ReturnType<DelegationCoordinator["messages"]> = [
    {
      role: "user",
      timestamp: 1,
      content: Array.from(
        { length: 60 },
        (_, index) => `USER_BODY${index} 正文👩‍💻\x1b[91m\x1b]52;c;SECRET\x07\u202e`,
      ).join("\n"),
    },
  ];
  t.mock.method(coordinator, "messages", () => messages);
  const palette = { ...theme, fg: (_color: string, text: string) => `\x1b[32m${text}\x1b[0m` };
  let rows = 27;
  const hub = createHub(
    coordinator,
    palette,
    effectiveKeys,
    () => {},
    () => {},
    dependencies,
    () => rows,
  );
  const render = (width = 90) => hub.render(width);
  const plain = () => render().map(stripAnsi);
  try {
    render();
    hub.handleInput!("\x1b[H");
    hub.handleInput!("\x1b[6~");
    const before = plain().filter((line) => line.includes("USER_BODY"));
    const partial = fauxAssistantMessage("STREAMING_SENTINEL");
    listener({
      type: "sdk",
      child,
      event: {
        type: "message_update",
        message: partial,
        assistantMessageEvent: {
          type: "text_delta",
          contentIndex: 0,
          delta: "STREAMING_SENTINEL",
          partial,
        },
      },
    });
    assert.deepEqual(
      plain().filter((line) => line.includes("USER_BODY")),
      before,
      "appending a stream must not jump the reading position",
    );
    hub.handleInput!("\x1b[F");
    assert.match(plain().join("\n"), /STREAMING_SENTINEL/);
    const assistant = fauxAssistantMessage([
      { type: "thinking", thinking: "THINKING_SENTINEL", thinkingSignature: "SIGNATURE_SECRET" },
      { type: "text", text: "ASSISTANT_SENTINEL\n" + "正文👩‍💻".repeat(60) },
      fauxToolCall("read", { path: "visible.ts" }),
    ]);
    messages = [
      ...messages,
      assistant,
      {
        role: "toolResult",
        toolCallId: "read-call",
        toolName: "read",
        isError: true,
        timestamp: 2,
        content: [
          { type: "text", text: "RESULT_END\x1b[91m" },
          { type: "image", data: "IMAGE_BASE64_SECRET", mimeType: "image/png" },
        ],
        details: { private: "TOOL_DETAILS_SECRET" },
      },
      { ...fauxAssistantMessage("FINAL_SENTINEL"), errorMessage: "ERROR_SENTINEL" },
    ];
    listener({ type: "sdk", child, event: { type: "message_end", message: partial } });
    hub.handleInput!("\x1b[H");
    const pages: string[] = [];
    for (let page = 0; page < 12; page++) {
      pages.push(plain().join("\n"));
      hub.handleInput!("\x1b[6~");
    }
    const full = pages.join("\n");
    for (const content of [
      "USER_BODY0",
      "THINKING_SENTINEL",
      "ASSISTANT_SENTINEL",
      "visible.ts",
      "RESULT_END",
      "payload omitted",
      "FINAL_SENTINEL",
      "ERROR_SENTINEL",
    ])
      assert.ok(full.includes(content), content);
    assert.doesNotMatch(
      full,
      /SIGNATURE_SECRET|TOOL_DETAILS_SECRET|IMAGE_BASE64_SECRET|SECRET|\u202e/,
    );
    for (const width of [0, 1, 3, 8, 36, 40, 75, 76, 90, 200])
      for (rows of [1, 4, 8, 14, 27]) {
        const lines = render(width);
        assert.ok(lines.length <= rows);
        for (const line of lines) {
          assert.equal(visibleWidth(line), width, `${width} columns, ${rows} rows`);
          assert.doesNotMatch(line, /\x1b\[91m|\x1b\]52|\u202e|\x1b\[0m(?!\x1b\[48;)/);
          assert.doesNotMatch(
            line,
            /\x1b\[49m(?!\x1b\[0m|$)/,
            "native background resets must restore the neutral outer panel",
          );
        }
      }
  } finally {
    hub.dispose();
  }
});

test("Hub empty, filtered, queued/setup and terminal threads explain unavailable transcript without allocating work", (t) => {
  const coordinator = new DelegationCoordinator("unused", "root");
  const changed = registryChanges(t, coordinator);
  let children: ChildSnapshot[] = [];
  t.mock.method(coordinator, "list", () => children);
  t.mock.method(coordinator, "messages", () => []);
  const hub = createHub(
    coordinator,
    theme,
    effectiveKeys,
    () => {},
    () => {},
    dependencies,
  );
  const output = () => stripAnsi(hub.render(90).join("\n"));
  try {
    assert.match(output(), /No tasks/);
    for (const status of [
      "queued",
      "setup",
      "draining",
      "settled",
      "failed",
      "cancelled",
    ] as const) {
      children = [
        snapshot(status, {
          status,
          error: status === "failed" ? "ACTUAL FAILURE" : undefined,
          disposed: ["settled", "failed", "cancelled"].includes(status),
        }),
      ];
      changed(children[0]);
      assert.match(output(), new RegExp(status));
      assert.match(
        output(),
        status === "queued"
          ? /no SDK messages yet/
          : status === "failed"
            ? /ACTUAL FAILURE/
            : /Waiting for SDK messages/,
      );
    }
    hub.handleInput!("/");
    hub.handleInput!("unmatched");
    hub.handleInput!("\r");
    assert.match(output(), /No matching tasks/);
  } finally {
    hub.dispose();
  }
});

test("Hub prefilled filter editing starts at the native Input end after an empty control is cancelled", (t) => {
  const coordinator = new DelegationCoordinator("unused", "root");
  t.mock.method(coordinator, "list", () => [
    snapshot("one", { assignment: "alpha" }),
    snapshot("two", { assignment: "alpha beta" }),
  ]);
  t.mock.method(coordinator, "messages", () => []);
  const hub = createHub(
    coordinator,
    theme,
    effectiveKeys,
    () => {},
    () => {},
    dependencies,
  );
  const output = () => stripAnsi(hub.render(90).join("\n"));
  try {
    output();
    hub.handleInput!("/");
    hub.handleInput!("alpha");
    hub.handleInput!("\r");
    hub.handleInput!("m");
    hub.handleInput!("\x1b"); // Input cursor is now at zero, filter is still "alpha".
    hub.handleInput!("/");
    hub.handleInput!(" beta");
    hub.handleInput!("\r");
    assert.match(output(), /Filter: alpha beta · 1 generations/);
    assert.match(output(), /> [├└] ● alpha beta/);
    assert.match(output(), /scout · running/);
    assert.doesNotMatch(output(), /#\d+/, "wide roster and heading hide generation numbers");
    assert.doesNotMatch(
      stripAnsi(hub.render(60).join("\n")),
      /#\d+/,
      "narrow selection hides generation numbers",
    );
    hub.handleInput!("/");
    hub.handleInput!("\x15");
    hub.handleInput!("alpha");
    hub.handleInput!("\r");
    assert.match(
      output(),
      /Filter: alpha · 2 generations/,
      "native Ctrl+U replaces a prefilled filter without an extra cursor workaround",
    );
  } finally {
    hub.dispose();
  }
});

for (const action of ["stop", "steer", "message"] as const) {
  test(`Hub ${action} keeps the full original target visible at short height and blocks hidden controls until resize`, async (t) => {
    const coordinator = new DelegationCoordinator("unused", "root");
    const changed = registryChanges(t, coordinator);
    const a = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      b = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
    let children = [
      snapshot(a, { assignment: "alpha", generation: 7, progress: "match" }),
      snapshot(b, { assignment: "beta", generation: 9, progress: "match" }),
    ];
    const calls: ChildRef[] = [];
    t.mock.method(coordinator, "list", () => structuredClone(children));
    t.mock.method(coordinator, "messages", () => []);
    t.mock.method(coordinator, "snapshot", (ref: ChildRef) =>
      children.find((child) => child.id === ref.id && child.generation === ref.generation),
    );
    t.mock.method(coordinator, "stop", async (ref: ChildRef) => {
      calls.push({ ...ref });
    });
    t.mock.method(coordinator, "steer", async (ref: ChildRef) => {
      calls.push({ ...ref });
      return "queued";
    });
    t.mock.method(
      coordinator,
      "message",
      async (_actor: ChildRef | undefined, ref: ChildRef | undefined) => {
        calls.push({ ...ref! });
        throw new Error("receipt fixture");
      },
    );
    let rows = 8,
      width = 90;
    const hub = createHub(
      coordinator,
      theme,
      effectiveKeys,
      () => {},
      () => {},
      dependencies,
      () => rows,
    );
    const render = () => {
      const lines = hub.render(width);
      assert.ok(lines.length <= rows);
      assert.ok(lines.every((line) => visibleWidth(line) === width));
      return stripAnsi(lines.join("\n"));
    };
    const begin = () => {
      hub.handleInput!(action === "stop" ? "x" : action === "steer" ? "\r" : "m");
      if (action !== "stop") hub.handleInput!("original payload");
    };
    const submit = async () => {
      hub.handleInput!(action === "stop" ? "y" : "\r");
      await new Promise((resolve) => setImmediate(resolve));
    };
    try {
      render();
      hub.handleInput!("/");
      hub.handleInput!("match");
      hub.handleInput!("\r");
      begin();
      children[0] = { ...children[0], progress: "no hit" };
      changed(children[0]);
      await submit();
      assert.deepEqual(
        calls,
        [],
        "a newly opened but not yet displayed target cannot authorize dispatch",
      );
      const short = render();
      assert.match(short, /beta · scout · running/);
      assert.ok(
        short.includes(`Target: ${a} #7`),
        "full pinned identity must outrank filter/status hints at height 8",
      );
      await submit();
      assert.deepEqual(calls, [{ id: a, generation: 7 }]);

      children[0] = { ...children[0], progress: "match" };
      changed(children[0]);
      render();
      hub.handleInput!("\x1b[A");
      begin();
      children[0] = { ...children[0], progress: "no hit" };
      changed(children[0]);
      render();
      rows = 4;
      width = 20;
      await submit();
      assert.equal(calls.length, 1, "shrinking before redraw also blocks submission");
      assert.match(render(), /Resize/);
      await submit();
      assert.equal(calls.length, 1, "hidden UUID cannot authorize confirmation/input submission");
      rows = 27;
      width = 90;
      assert.ok(
        render().includes(`Target: ${a} #7`),
        "resize must retain the original pin and input",
      );
      await submit();
      assert.deepEqual(calls, [
        { id: a, generation: 7 },
        { id: a, generation: 7 },
      ]);

      begin();
      rows = 4;
      width = 20;
      render();
      hub.handleInput!("\x1b");
      rows = 14;
      width = 36;
      assert.doesNotMatch(render(), /Target:/, "cancel clears the blocked interaction");
      begin();
      const reset = render();
      assert.ok(
        reset
          .replaceAll("\n", "")
          .replaceAll("│", "")
          .replaceAll(" ", "")
          .includes(`Target:${b}#9`),
        "new interaction pins B, not cancelled A",
      );
      hub.handleInput!("\x1b");
      for (const [columns, minimumRows] of [
        [90, 7],
        [36, 9],
      ]) {
        width = columns;
        rows = minimumRows;
        begin();
        const visible = render();
        assert.match(visible, /├─+┤/);
        assert.match(visible, action === "stop" ? /y confirms/ : /Enter send/);
        rows--;
        assert.match(render(), /Resize/);
        assert.doesNotMatch(render(), /├─+┤/);
        await submit();
        assert.equal(calls.length, 2, "separator budget must not expose incomplete controls");
        hub.handleInput!("\x1b");
      }
      assert.equal(calls.length, 2);
    } finally {
      hub.dispose();
    }
  });
}

test("human assignment/role labels distinguish same-role agents without changing identity search or full readonly access", (t) => {
  const coordinator = new DelegationCoordinator("unused", "root");
  const a = snapshot("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", {
    assignment: "# Audit parser\nFull original assignment",
    profile: "review",
  });
  const b = snapshot("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", {
    assignment: "Audit scheduler",
    profile: "review",
  });
  t.mock.method(coordinator, "list", () => [a, b]);
  t.mock.method(coordinator, "messages", () => [
    fauxAssistantMessage(
      fauxToolCall(
        "write",
        { path: "result.ts", content: "const result = 1;" },
        { id: "write-call" },
      ),
      { stopReason: "toolUse" },
    ),
    {
      role: "toolResult",
      toolName: "write",
      toolCallId: "write-call",
      timestamp: 2,
      isError: false,
      content: [{ type: "text", text: "Successfully wrote complete text." }],
    },
  ]);
  const hub = createHub(
    coordinator,
    theme,
    effectiveKeys,
    () => {},
    () => {},
    dependencies,
    () => 27,
  );
  const output = () => stripAnsi(hub.render(90).join("\n"));
  try {
    const initial = output();
    assert.match(initial, /> [├└] ● Audit parser/);
    assert.match(initial, /Audit scheduler/);
    assert.doesNotMatch(initial, /aaaaaaaa|bbbbbbbb|Full original assignment/);
    const widget = createChildWidget(
      () => [a, b],
      theme,
      () => 30,
    )
      .render(180)
      .join("\n");
    assert.match(widget, /review.*Audit parser/);
    assert.match(widget, /review.*Audit scheduler/);
    assert.doesNotMatch(widget, /aaaaaaaa|bbbbbbbb/);
    hub.handleInput!("\t");
    assert.ok(output().includes(`Identity ${a.id} #1`));
    hub.handleInput!("\t");
    hub.handleInput!("\x1b[F");
    assert.match(output(), /Successfully wrote complete text/);
    hub.handleInput!("/");
    hub.handleInput!(b.id);
    hub.handleInput!("\r");
    assert.match(output(), /> [├└] ● Audit scheduler/);
    assert.doesNotMatch(output(), /> [├└] ● Audit parser/);
  } finally {
    hub.dispose();
  }
});

test("Hub native thread opens at live tail, detaches for laptop/page reading, follows updates and resumes on End", async (t) => {
  const coordinator = new DelegationCoordinator("unused", "root");
  const child = snapshot("reader", { assignment: "Read newest output" });
  let messages: ReturnType<DelegationCoordinator["messages"]> = [
    {
      role: "user",
      timestamp: 1,
      content: Array.from({ length: 100 }, (_, i) => `NAV_LINE_${i}`).join("\n"),
    },
  ];
  let listener!: Parameters<DelegationCoordinator["subscribe"]>[0];
  t.mock.method(coordinator, "list", () => [child]);
  t.mock.method(coordinator, "messages", () => messages);
  t.mock.method(coordinator, "subscribe", (callback: typeof listener) => {
    listener = callback;
    return () => {};
  });
  t.mock.method(coordinator, "snapshot", () => child);
  const steered: string[] = [];
  t.mock.method(coordinator, "steer", async (_ref: ChildRef, text: string) => {
    steered.push(text);
    return "queued";
  });
  let rows = 27;
  const hub = createHub(
    coordinator,
    theme,
    effectiveKeys,
    () => {},
    () => {},
    dependencies,
    () => rows,
  );
  const output = (width = 90) => stripAnsi(hub.render(width).join("\n"));
  const lines = () =>
    output()
      .split("\n")
      .filter((line) => line.includes("NAV_LINE_"));
  try {
    assert.match(output(), /NAV_LINE_99/);
    assert.match(output(), /LIVE/);
    hub.handleInput!("k");
    assert.match(output(), /READING/);
    hub.handleInput!("j");
    assert.match(output(), /LIVE/, "reaching bottom resumes follow visibly");
    hub.handleInput!("\x1b[5~");
    assert.match(output(), /READING/);
    assert.doesNotMatch(output(), /NAV_LINE_99/);
    hub.handleInput!("k");
    const before = lines();
    const newest = fauxAssistantMessage("NEWEST_MESSAGE");
    messages = [...messages, newest];
    listener({ type: "sdk", child, event: { type: "message_end", message: newest } });
    assert.deepEqual(lines(), before, "appending messages must not move a detached reader");
    hub.handleInput!("j");
    assert.notDeepEqual(lines(), before, "laptop line scrolling moves content, not agents");
    hub.handleInput!("\x15");
    assert.match(output(), /READING/);
    hub.handleInput!("\x04");
    assert.match(output(), /READING/);
    hub.handleInput!("\x1b[F");
    assert.match(output(), /NEWEST_MESSAGE/);
    assert.match(output(), /LIVE/);
    const partial = fauxAssistantMessage("PARTIAL_NEWEST");
    listener({
      type: "sdk",
      child,
      event: {
        type: "message_update",
        message: partial,
        assistantMessageEvent: {
          type: "text_delta",
          contentIndex: 0,
          delta: "PARTIAL_NEWEST",
          partial,
        },
      },
    });
    assert.match(output(), /PARTIAL_NEWEST/);
    rows = 14;
    assert.match(output(36), /PARTIAL_NEWEST/);
    assert.match(output(36), /LIVE/);
    messages = [...messages, partial];
    listener({ type: "sdk", child, event: { type: "message_end", message: partial } });
    assert.match(output(36), /PARTIAL_NEWEST/);
    assert.match(output(36), /LIVE/);
    rows = 27;
    hub.handleInput!("\t");
    assert.match(output(), /Identity reader #1/);
    assert.doesNotMatch(output(), /LIVE/);
    hub.handleInput!("\t");
    hub.handleInput!("\t");
    assert.match(output(), /LIVE/);
    hub.handleInput!("\r");
    hub.handleInput!("j");
    hub.handleInput!("k");
    output();
    hub.handleInput!("\r");
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(steered, ["jk"], "navigation aliases must not steal native input");
  } finally {
    hub.dispose();
  }
});

test("Hub normalized wheel is contained to its reading viewport, never the roster or underlying chat", (t) => {
  const coordinator = new DelegationCoordinator("unused", "root");
  t.mock.method(coordinator, "list", () => [snapshot("one"), snapshot("two")]);
  t.mock.method(coordinator, "messages", () => [
    {
      role: "user",
      timestamp: 1,
      content: Array.from({ length: 100 }, (_, i) => `WHEEL_LINE_${i}`).join("\n"),
    },
  ]);
  const hub = createHub(
    coordinator,
    theme,
    effectiveKeys,
    () => {},
    () => {},
    dependencies,
    () => 27,
  );
  const output = () => stripAnsi(hub.render(90).join("\n"));
  const event = {
    type: "wheel" as const,
    button: "none" as const,
    x: 40,
    y: 5,
    screenX: 45,
    screenY: 7,
    width: 90,
    height: 27,
    shift: false,
    alt: false,
    ctrl: false,
    wheelDelta: -3,
  };
  try {
    output();
    assert.equal(hub.handleMouse?.(event)?.handled, true);
    assert.match(output(), /READING/);
    const before = output();
    assert.equal(hub.handleMouse?.({ ...event, x: 3 })?.handled, true);
    assert.equal(
      output(),
      before,
      "roster wheel must be contained without changing selection or thread",
    );
    assert.match(output(), /> [├└] ● inspect one/);
    const rendered = before.split("\n");
    const separatorY = rendered.findIndex((line) => line.startsWith("├"));
    assert.equal(separatorY, 22);
    for (const y of [
      separatorY - 3,
      separatorY - 2,
      separatorY - 1,
      separatorY,
      separatorY + 1,
      26,
    ]) {
      hub.handleMouse?.({ ...event, y });
      assert.equal(
        output(),
        before,
        "position row, composer, status row, separator and footer must not scroll",
      );
    }
    hub.handleMouse?.({ ...event, y: separatorY - 4 });
    assert.notEqual(output(), before, "last reading row remains wheel-scrollable");
    const position = output().match(/(\d+)–(\d+)\/\d+ lines/)!;
    assert.equal(Number(position[2]) - Number(position[1]) + 1, 16);
    hub.handleInput!("\x1b[6~");
    const nextPosition = output().match(/(\d+)–(\d+)\/\d+ lines/)!;
    assert.equal(Number(nextPosition[1]) - Number(position[1]), 6, "page clamps at the live tail");
    hub.handleInput!("x");
    const confirmation = output();
    hub.handleMouse?.(event);
    assert.equal(output(), confirmation, "wheel must not disturb a pinned interaction");
    hub.handleInput!("\x1b");
    hub.handleInput!("\x1b[F");
    assert.match(output(), /LIVE/);
  } finally {
    hub.dispose();
  }
});

test("Hub lanes stay neutral, selected names use accent, and dots/profiles retain lifecycle colors", (t) => {
  const children = (["running", "failed", "cancelled", "settled"] as const).map((status) =>
    snapshot(status, { assignment: status, status }),
  );
  const coordinator = new DelegationCoordinator("unused", "root");
  t.mock.method(coordinator, "list", () => children);
  t.mock.method(coordinator, "messages", () => []);
  const dots: string[] = [];
  const profiles: string[] = [];
  const palette = {
    ...theme,
    fg: (color: string, text: string) => {
      if (text === "● ") dots.push(color);
      else if (text === "scout") profiles.push(color);
      else if (text === ">" || text === "running" || text.startsWith("running · scout"))
        assert.equal(color, "accent", "selected name and marker retain accent styling");
      else if (
        text.includes("scout") ||
        (text.startsWith("  ") && /^[│ ]+$/.test(text)) ||
        [
          " └ ",
          " ├ ",
          "failed",
          "cancelled",
          "settled",
          " · running",
          " · failed",
          " · cancelled",
          " · settled",
          "> ├ ",
          "  ├ ",
          "  └ ",
          "> └ ",
        ].includes(text)
      )
        assert.equal(color, "text", `agent text must not inherit status/selection color: ${text}`);
      return text;
    },
  };
  const hub = createHub(
    coordinator,
    palette,
    effectiveKeys,
    () => {},
    () => {},
    dependencies,
    () => 27,
  );
  try {
    hub.render(120);
    assert.deepEqual(dots, ["accent", "error", "warning", "success"]);
    assert.deepEqual(profiles, dots);
    dots.length = 0;
    profiles.length = 0;
    const narrow = hub.render(36).map(stripAnsi);
    assert.deepEqual(dots, ["accent"]);
    assert.deepEqual(profiles, dots);
    assert.match(narrow.join("\n"), /> └ ● running/);
    assert.ok(narrow.every((row) => visibleWidth(row) === 36));
  } finally {
    hub.dispose();
  }
});

test("family branches close at the last sibling and ancestor pipes span compact Hub and widget rows", (t) => {
  const lead = snapshot("lead", { assignment: "Lead" });
  const next = snapshot("next", { assignment: "Other" });
  const nested = snapshot("nested", {
    assignment: "Nested",
    parentId: lead.id,
    parentGeneration: 1,
    depth: 2,
  });
  const children = [lead, next, nested];
  assert.deepEqual(
    taskTree(children).map(({ child, indent, last, continuation }) => [
      child.id,
      indent,
      last,
      continuation,
    ]),
    [
      ["lead", "", false, "│   "],
      ["nested", "│   ", true, "│       "],
      ["next", "", true, "    "],
    ],
  );
  const rows = createChildWidget(() => children, theme)
    .render(120)
    .map(stripAnsi);
  assert.ok(rows[1].startsWith("├─ ● scout Lead"));
  assert.ok(rows[2].startsWith("│  ├ Tool: read"));
  assert.ok(rows[3].startsWith("│  └─ ● scout Nested"));
  assert.ok(rows[4].startsWith("└─ ● scout Other"));

  const coordinator = new DelegationCoordinator("unused", "root");
  t.mock.method(coordinator, "list", () => children);
  t.mock.method(coordinator, "messages", () => []);
  const hub = createHub(
    coordinator,
    theme,
    effectiveKeys,
    () => {},
    () => {},
    dependencies,
    () => 27,
  );
  try {
    const left = hub
      .render(120)
      .map(stripAnsi)
      .slice(2, 8)
      .map((row) => row.slice(2, 34).trimEnd());
    assert.deepEqual(left, [
      "> ├ ● Lead",
      "  │   scout · running",
      "  │   └ ● Nested",
      "  │       scout · running",
      "  └ ● Other",
      "      scout · running",
    ]);
  } finally {
    hub.dispose();
  }
});

test("tree connectors account for hidden siblings, exact parent generations and missing ancestors", () => {
  const lead = snapshot("lead");
  const a = snapshot("a", { parentId: lead.id, parentGeneration: 1, depth: 2 });
  const b = snapshot("b", { parentId: lead.id, parentGeneration: 1, depth: 2 });
  const next = snapshot("next");
  const rows = taskTree([lead, next, a, b]);
  assert.equal(rows[1].last, false);
  assert.equal(rows[2].last, true);
  assert.equal(rows[2].indent, "│   ");
  const grandchild = snapshot("grandchild", { parentId: a.id, parentGeneration: 1, depth: 3 });
  const deep = taskTree([lead, next, a, b, grandchild]);
  assert.deepEqual(
    deep.map(({ child }) => child.id),
    ["lead", "a", "grandchild", "b", "next"],
  );
  assert.equal(deep[2].indent, "│   │   ", "both unfinished ancestor lanes continue");
  assert.equal(deep[2].last, true);
  const closed = taskTree([lead, a, grandchild]);
  assert.equal(closed[2].indent, "        ", "completed ancestor lanes contain no pipes");
  const widget = createChildWidget(() => [lead, next, a, b], theme)
    .render(120)
    .map(stripAnsi);
  assert.ok(widget[1].startsWith("├─"), "the root lane continues to the overflow row");
  assert.ok(
    widget[2].startsWith("│  ├─"),
    "the visible child continues to the hidden-child summary",
  );
  assert.equal(widget[3], "│  └─ 1 more nested subagent running");
  assert.equal(widget[2].indexOf("├─"), 3, "widget lanes use exactly three columns");
  assert.equal(widget[4], "└─ 2 more · /subagent-hub");
  assert.equal(
    taskTree([{ ...lead, generation: 2 }, a])[1].indent,
    "    ",
    "old child cannot attach to a new generation",
  );
  assert.equal(taskTree([a])[0].indent, "    ", "missing parent keeps depth without a false pipe");
});

test("widget summarizes two hidden running children below one visible child without double-counting fleet overflow", () => {
  const lead = snapshot("lead", {
    assignment: "Coordinate audit",
    activity: "Waiting for 3 audits",
  });
  const nested = (id: string, extra: Partial<ChildSnapshot> = {}) =>
    snapshot(id, { parentId: lead.id, parentGeneration: 1, depth: 2, ...extra });
  const children = [
    lead,
    nested("one", { assignment: "Visible audit" }),
    nested("two"),
    nested("three"),
    nested("queued", { status: "queued" }),
    nested("finished", { status: "settled", disposed: true }),
    nested("other-generation", { parentGeneration: 2 }),
    ...Array.from({ length: 11 }, (_, i) => snapshot(`root-${i}`)),
  ];
  const widget = createChildWidget(() => children, theme);
  const rows = widget.render(120).map(stripAnsi);
  assert.equal(rows.length, 5);
  assert.ok(rows[1].includes("Coordinate audit"));
  assert.ok(rows[2].startsWith("│  ├─ ● scout Visible audit"));
  assert.equal(rows[3], "│  └─ 2 more nested subagents running");
  assert.equal(rows[4], "└─ 14 more · /subagent-hub");
  assert.doesNotMatch(rows.join("\n"), /Waiting for/);
  for (const height of [1, 4, 8, 12, 16, 30])
    for (const width of [0, 1, 8, 36, 80, 120]) {
      const lines = createChildWidget(
        () => children,
        theme,
        () => height,
      ).render(width);
      assert.ok(lines.length <= Math.max(1, Math.min(5, Math.floor(height / 4))));
      assert.ok(lines.every((line) => visibleWidth(line) <= width));
    }
});

test("widget indents nested agents and activity three columns per level within its row budget", () => {
  for (const depth of [1, 2, 3, 8]) {
    const widget = createChildWidget(
      () => [snapshot("nested", { depth, assignment: "Nested audit" })],
      theme,
    );
    const rows = widget.render(120).map(stripAnsi);
    const indent = " ".repeat(Math.min(3, depth - 1) * 3);
    assert.ok(rows[1].startsWith(`${indent}└─ ● scout Nested audit`));
    assert.ok(rows[2].startsWith(`${indent}   └ Tool: read`));
    for (const width of [0, 1, 8, 36, 80]) {
      const narrow = widget.render(width);
      assert.ok(narrow.length <= 5);
      assert.ok(narrow.every((row) => visibleWidth(row) <= width));
    }
  }
});

test("compact agent tree uses actual status/role/direct stats/activity with truthful queue/overflow without a writer reservation", () => {
  const children = [
    snapshot("A", {
      assignment: "Audit parser",
      toolCalls: 3,
      telemetry: { requests: 2, tokens: null, cost: null, context: null },
    }),
    snapshot("B", { assignment: "Check drain", status: "draining", writerLease: true }),
    ...Array.from({ length: 8 }, (_, i) => snapshot(`q${i}`, { status: "queued" })),
    snapshot("done", {
      assignment: "Finished check",
      status: "settled",
      disposed: true,
      endedAt: 2000,
    }),
  ];
  const widget = createChildWidget(
    () => children,
    theme,
    () => 30,
  );
  const text = stripAnsi(widget.render(120).join("\n"));
  assert.match(text, /● Subagents/);
  assert.match(text, /8 queued/);
  assert.match(text, /[├└]─/);
  assert.match(text, /scout.*Check drain/);
  assert.match(text, /└.*Tool: read/);
  assert.match(text, /scout.*Audit parser/);
  assert.doesNotMatch(text, /more|Finished check/);
  assert.doesNotMatch(text, /writer|unsafe|no conflicting|!\/!!/i);
  assert.doesNotMatch(text, /null|undefined|NaN|context.*%/);
  const measured = createChildWidget(
    () => [
      snapshot("known", {
        toolCalls: 3,
        telemetry: {
          requests: 2,
          tokens: { input: 3, output: 5, cacheRead: 2, cacheWrite: 1, total: 11 },
          cost: 0.125,
          context: null,
        },
      }),
    ],
    theme,
  );
  assert.match(stripAnsi(measured.render(180).join("\n")), /3 tools · 2 req · 11 tok · \$0.125/);
  for (const rows of [1, 4, 8, 16, 30])
    for (const width of [0, 1, 8, 36, 80, 120]) {
      const lines = createChildWidget(
        () => children,
        theme,
        () => rows,
      ).render(width);
      assert.ok(lines.length <= Math.max(1, Math.min(5, Math.floor(rows / 4))));
      assert.ok(lines.every((line) => visibleWidth(line) <= width));
    }
});

test("active writers retain normal headers and reclaim task/activity rows at every row budget", () => {
  let children = [
    snapshot("writer", {
      profile: "implementation",
      assignment: "Update parser",
      writerLease: true,
      endedAt: 2000,
    }),
    snapshot("reader", { assignment: "Inspect parser", endedAt: 2000 }),
    snapshot("paused", { status: "paused" }),
    snapshot("queue", { status: "queued" }),
  ];
  for (const width of [36, 55, 60, 74, 75, 120, 180]) {
    for (const rows of [1, 4, 8, 12, 16, 20, 30]) {
      const widget = createChildWidget(
        () => children,
        theme,
        () => rows,
      );
      const lines = widget.render(width);
      const text = stripAnsi(lines.join("\n"));
      const budget = Math.max(1, Math.min(5, Math.floor(rows / 4)));
      assert.equal(lines.length, Math.min(budget, 4));
      assert.ok(lines.every((line) => visibleWidth(line) <= width));
      assert.doesNotMatch(text, /writer|unsafe|no conflicting|!\/!!/i);
      assert.match(lines[0], /● Subagents 4/);
      if (width >= 55) assert.match(lines[0], /1 queued/);
      if (width < 60) assert.match(lines[0], /2 active/);
      else assert.match(lines[0], /2 running/);
      if (budget === 2) assert.match(text, /2 more/);
      if (budget >= 3) {
        assert.match(text, /implementation.*U/);
        assert.match(text, /scout.*I/);
        if (width >= 75) {
          assert.match(text, /Update parser/);
          assert.match(text, /Inspect parser/);
        }
        assert.doesNotMatch(text, /more/);
      }
      if (budget >= 4) assert.match(text, /└.*Tool: read/);
      const withLease = lines;
      children = children.map((child) => ({ ...child, writerLease: false }));
      assert.deepEqual(
        widget.render(width),
        withLease,
        "lease never displaces normal widget content",
      );
      children[0] = { ...children[0], writerLease: true };
    }
  }
});

test("paused widget stays summary-only while Hub exposes retained context and stop", async (t) => {
  const coordinator = new DelegationCoordinator("unused", "root");
  const child = snapshot("paused-agent", {
    status: "paused",
    pauseReason: "deadline",
    retainedContext: true,
    activity: "old activity",
  });
  const widget = createChildWidget(() => [child], theme);
  const lines = widget.render(140);
  assert.deepEqual(lines, ["● Subagents 1 · 1 paused · /subagent-hub"]);
  assert.match(widget.render(55)[0], /1 paused · \/subagent-hub/);
  const stopped: ChildRef[] = [];
  t.mock.method(coordinator, "list", () => [child]);
  t.mock.method(coordinator, "snapshot", () => child);
  t.mock.method(coordinator, "stop", async (ref: ChildRef) => {
    stopped.push(ref);
  });
  const hub = createHub(
    coordinator,
    theme,
    effectiveKeys,
    () => {},
    () => {},
    dependencies,
    () => 24,
  );
  try {
    hub.handleInput!("\t");
    assert.match(
      stripAnsi(hub.render(180).join("\n")),
      /resources idle SDK; context retained; model resume required/,
    );
    assert.match(taskCard(child, true).join("\n"), /resume via model control after drain/);
    hub.handleInput!("x");
    assert.match(stripAnsi(hub.render(100).join("\n")), /y confirms/);
    hub.handleInput!("y");
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(stopped, [{ id: child.id, generation: child.generation }]);
  } finally {
    hub.dispose();
  }
});

test("widget and unfiltered Hub count sessions, not profiles or latest identities, with bounded active rows", (t) => {
  const children = [
    snapshot("same", {
      generation: 1,
      assignment: "historical task",
      status: "settled",
      disposed: true,
    }),
    snapshot("same", { generation: 2, assignment: "current task" }),
    snapshot("other", { assignment: "separate same-profile task" }),
    ...Array.from({ length: 6 }, (_, index) =>
      snapshot(`nested-${index}`, {
        parentId: "same",
        parentGeneration: 2,
        depth: 2,
      }),
    ),
  ];
  const coordinator = new DelegationCoordinator("unused-render-only", "root");
  t.mock.method(coordinator, "sessions", () => children);
  t.mock.method(coordinator, "list", () => children.slice(1));
  t.mock.method(coordinator, "messages", () => []);
  const widget = createChildWidget(() => coordinator.sessions(), theme);
  const hub = createHub(
    coordinator,
    theme,
    effectiveKeys,
    () => {},
    () => {},
    dependencies,
  );
  try {
    assert.match(stripAnsi(hub.render(180).join("\n")), /SUBAGENTS · 9 generations/);
    const rows = widget.render(180);
    assert.match(rows[0], /Subagents 9 · 8 running · 1 settled/);
    assert.equal(rows.length, 5);
    assert.doesNotMatch(rows.slice(1).join("\n"), /historical task/);
    assert.match(rows.at(-1)!, /more · \/subagent-hub/);
    assert.match(widget.render(55)[0], /Subagents 9 · 8 active/);
    children.splice(
      0,
      children.length,
      ...children.map((child) => ({ ...child, status: "settled" as const, disposed: true })),
    );
    assert.deepEqual(widget.render(180), ["● Subagents 9 · 9 settled · /subagent-hub"]);
  } finally {
    hub.dispose();
  }
});

for (const binding of ["ctrl+o", "ctrl+g", "disabled"] as const) {
  test(`Hub global tool expansion respects ${binding}, input isolation and per-opening lifetime`, (t) => {
    const coordinator = new DelegationCoordinator("unused", "root");
    const children = [snapshot("one"), snapshot("two", { generation: 2 })];
    t.mock.method(coordinator, "list", () => children);
    const messages: ReturnType<DelegationCoordinator["messages"]> = [
      fauxAssistantMessage(fauxToolCall("read", { path: "visible.ts" }, { id: "call" }), {
        stopReason: "toolUse",
      }),
      {
        role: "toolResult",
        toolName: "read",
        toolCallId: "call",
        timestamp: 2,
        isError: false,
        content: [
          {
            type: "text",
            text: Array.from({ length: 50 }, (_, i) => `GLOBAL_BODY_${i}`).join("\n"),
          },
        ],
      },
    ];
    t.mock.method(coordinator, "messages", () => messages);
    const original = structuredClone(messages);
    const manager = new KeybindingsManager(
      {
        "app.tools.expand": { defaultKeys: "ctrl+o" },
        "tui.select.cancel": { defaultKeys: "escape" },
        "tui.select.confirm": { defaultKeys: "enter" },
        "tui.select.down": { defaultKeys: "down" },
      },
      { "app.tools.expand": binding === "disabled" ? [] : binding },
    );
    const key = binding === "ctrl+g" ? "\x07" : "\x0f";
    const open = () =>
      createHub(
        coordinator,
        theme,
        manager,
        () => {},
        () => {},
        dependencies,
        () => 30,
      );
    const hub = open();
    const output = () => stripAnsi(hub.render(100).join("\n"));
    try {
      assert.match(output(), /Tools collapsed/);
      assert.ok(output().includes(binding === "disabled" ? "unbound" : binding));
      assert.doesNotMatch(output(), /GLOBAL_BODY_49/);
      for (const mode of ["/", "\r", "m", "x"]) {
        hub.handleInput!(mode);
        hub.handleInput!(key);
        hub.handleInput!("\x1b");
        assert.match(
          output(),
          /Tools collapsed/,
          `${JSON.stringify(mode)} cannot toggle thread display`,
        );
      }
      if (binding === "ctrl+g") {
        hub.handleInput!("\x0f");
        assert.match(output(), /Tools collapsed/, "default key must not survive remapping");
      }
      hub.handleInput!(key);
      if (binding === "disabled") {
        assert.match(output(), /Tools collapsed/);
        return;
      }
      assert.match(output(), /Tools expanded/);
      assert.match(output(), /GLOBAL_BODY_49/);
      assert.match(output(), /LIVE/);
      hub.handleInput!("\x1b[B");
      assert.match(output(), /inspect two/);
      assert.match(
        output(),
        /GLOBAL_BODY_49/,
        "roster generation switch inherits global preference",
      );
      hub.handleInput!("\t");
      const details = output();
      hub.handleInput!(key);
      assert.equal(output(), details, "Details action unavailable");
      hub.handleInput!("\t");
      const tools = output();
      hub.handleInput!(key);
      assert.equal(output(), tools, "Tools inspection does not toggle");
      hub.handleInput!("\t");
      assert.match(output(), /Tools expanded/);
      hub.handleInput!(key);
      assert.match(output(), /Tools collapsed/);
      assert.doesNotMatch(output(), /GLOBAL_BODY_49/);
      assert.deepEqual(messages, original);
      hub.handleInput!(key);
      assert.match(output(), /Tools expanded/);
      const reopened = open();
      try {
        assert.match(stripAnsi(reopened.render(100).join("\n")), /Tools collapsed/);
      } finally {
        reopened.dispose();
      }
    } finally {
      hub.dispose();
    }
  });
}

test("Hub toggles preserve surviving message/tool reading anchors, safe bounds on resize, and LIVE tail through streaming/final results", (t) => {
  const coordinator = new DelegationCoordinator("unused", "root");
  const child = snapshot("anchor");
  let listener!: Parameters<DelegationCoordinator["subscribe"]>[0];
  t.mock.method(coordinator, "subscribe", (callback: typeof listener) => {
    listener = callback;
    return () => {};
  });
  t.mock.method(coordinator, "list", () => [child]);
  const args = { path: "anchor.ts" };
  const call = fauxAssistantMessage(fauxToolCall("read", args, { id: "call" }), {
    stopReason: "toolUse",
  });
  const content = [
    {
      type: "text" as const,
      text: Array.from({ length: 70 }, (_, i) => `TOOL_ANCHOR_${i}`).join("\n"),
    },
  ];
  let messages: ReturnType<DelegationCoordinator["messages"]> = [
    call,
    {
      role: "toolResult",
      toolName: "read",
      toolCallId: "call",
      timestamp: 2,
      isError: false,
      content,
    },
    fauxAssistantMessage(Array.from({ length: 100 }, (_, i) => `AFTER_TOOL_${i}`).join("\n")),
  ];
  t.mock.method(coordinator, "messages", () => messages);
  const manager = {
    ...effectiveKeys,
    matches: (data: string, action: string) =>
      action === "app.tools.expand" ? data === "\x0f" : effectiveKeys.matches(data, action),
    getKeys: (action: string) =>
      action === "app.tools.expand" ? ["ctrl+o" as const] : effectiveKeys.getKeys(action),
  };
  let rows = 30;
  const hub = createHub(
    coordinator,
    theme,
    manager,
    () => {},
    () => {},
    dependencies,
    () => rows,
  );
  const output = (width = 100) => stripAnsi(hub.render(width).join("\n"));
  const after = () =>
    output()
      .split("\n")
      .filter((line) => line.includes("AFTER_TOOL_"));
  try {
    assert.match(output(), /AFTER_TOOL_99/);
    hub.handleInput!("\x1b[5~");
    const before = after();
    assert.ok(before.length);
    hub.handleInput!("\x0f");
    assert.deepEqual(
      after(),
      before,
      "expanding earlier tool retains first visible assistant location",
    );
    assert.match(output(), /READING/);
    hub.handleInput!("\x0f");
    assert.deepEqual(after(), before, "collapsing earlier tool retains assistant location");
    hub.handleInput!("\x0f");
    output();
    hub.handleInput!("\x1b[H");
    for (let i = 0; i < 35; i++) hub.handleInput!("j");
    assert.match(output(), /TOOL_ANCHOR_3/);
    hub.handleInput!("\x0f");
    assert.match(output(), /anchor.ts/, "hidden body returns to surviving tool header");
    assert.match(output(), /READING/);
    rows = 24;
    assert.match(output(60), /READING/);
    hub.handleInput!("\x1b[F");
    assert.match(output(60), /LIVE/);
    messages = [call];
    listener({
      type: "sdk",
      child,
      event: {
        type: "tool_execution_update",
        toolCallId: "call",
        toolName: "read",
        args,
        partialResult: { content },
      },
    });
    hub.handleInput!("\x0f");
    assert.match(output(60), /TOOL_ANCHOR_69/);
    assert.match(output(60), /LIVE/);
    messages = [
      call,
      {
        role: "toolResult",
        toolName: "read",
        toolCallId: "call",
        timestamp: 2,
        isError: true,
        content,
      },
    ];
    listener({
      type: "sdk",
      child,
      event: {
        type: "tool_execution_end",
        toolCallId: "call",
        toolName: "read",
        result: { content },
        isError: true,
      },
    });
    assert.match(output(60), /TOOL_ANCHOR_69/);
    hub.handleInput!("\x0f");
    assert.match(output(60), /LIVE/);
    assert.doesNotMatch(output(60), /TOOL_ANCHOR_69/);
    for (const width of [12, 36, 60, 100]) {
      const lines = hub.render(width);
      assert.ok(lines.length <= rows && lines.every((line) => visibleWidth(line) === width));
    }
  } finally {
    hub.dispose();
  }
});

test("Hub repeated renders and reading moves do no unchanged transcript or roster work; events, width and theme invalidate", (t) => {
  const coordinator = new DelegationCoordinator("unused", "root");
  const changed = registryChanges(t, coordinator);
  const child = snapshot("cached-reader");
  let normalized = 0;
  Object.defineProperty(child, "progress", {
    get() {
      normalized++;
      return "SEARCHABLE_PROGRESS";
    },
  });
  const sessions = t.mock.method(coordinator, "sessions", () => [child]);
  t.mock.method(coordinator, "list", () => [child]);
  let messages = Array.from({ length: 100 }, (_, i) => fauxAssistantMessage(`CACHE_ROW_${i}`));
  const reads = t.mock.method(coordinator, "messages", () => structuredClone(messages));
  const layout = t.mock.method(AssistantMessageComponent.prototype, "render");
  const serialized = t.mock.method(JSON, "stringify");
  const hub = createHub(
    coordinator,
    theme,
    effectiveKeys,
    () => {},
    () => {},
    { ...dependencies, toolRenderers: { delegate_task: {} } },
  );
  const output = (width = 90) => stripAnsi(hub.render(width).join("\n"));
  try {
    const first = output();
    assert.match(first, /CACHE_ROW_99/);
    assert.equal(
      normalized,
      0,
      "empty query does not normalize hidden progress/result/history fields",
    );
    assert.equal(sessions.mock.callCount(), 1, "one roster read/tree for selection and both panes");
    const nativeWork = layout.mock.callCount(),
      keyWork = serialized.mock.callCount();
    assert.equal(nativeWork, 100);
    assert.deepEqual(output(), first);
    hub.handleInput!("k");
    assert.match(output(), /READING/);
    assert.equal(sessions.mock.callCount(), 1);
    assert.equal(reads.mock.callCount(), 1);
    assert.equal(layout.mock.callCount(), nativeWork);
    assert.equal(
      serialized.mock.callCount(),
      keyWork,
      "unchanged history is not even re-keyed in the Hub",
    );
    output(50);
    assert.equal(layout.mock.callCount(), nativeWork + 100, "resize relayouts native rows");
    assert.equal(reads.mock.callCount(), 1, "resize does not re-clone finalized messages");
    hub.invalidate();
    output(50);
    assert.equal(
      layout.mock.callCount(),
      nativeWork + 200,
      "theme invalidation drops rendered rows",
    );
    messages = [...messages, fauxAssistantMessage("NEW_FINALIZED_ROW")];
    changed(child);
    hub.handleInput!("\x1b[F");
    assert.match(output(50), /NEW_FINALIZED_ROW/);
    assert.equal(sessions.mock.callCount(), 2);
    assert.equal(reads.mock.callCount(), 2);
    hub.handleInput!("/");
    hub.handleInput!("SEARCHABLE_PROGRESS");
    hub.handleInput!("\r");
    assert.match(output(50), /NEW_FINALIZED_ROW/);
    assert.ok(normalized > 0, "nonempty search still indexes full progress fields");
  } finally {
    hub.dispose();
  }
});

test("Hub does not hide a custom tool renderer's asynchronous redraw behind finalized transcript caching", async (t) => {
  const coordinator = new DelegationCoordinator("unused", "root");
  t.mock.method(coordinator, "list", () => [snapshot("custom-reader")]);
  t.mock.method(coordinator, "messages", () => [
    {
      role: "toolResult",
      timestamp: 1,
      toolName: "custom",
      toolCallId: "call",
      isError: false,
      content: [{ type: "text", text: "recorded" }],
    },
  ]);
  let value = "BEFORE_ASYNC",
    invalidate!: () => void;
  const hub = createHub(
    coordinator,
    theme,
    effectiveKeys,
    () => {},
    () => {},
    {
      ...dependencies,
      toolRenderers: {
        custom: {
          renderResult: (_result, _options, _theme, context) => {
            invalidate = context.invalidate;
            return new Text(value, 0, 0);
          },
        },
      },
    },
  );
  try {
    assert.match(stripAnsi(hub.render(90).join("\n")), /BEFORE_ASYNC/);
    await Promise.resolve();
    value = "AFTER_ASYNC";
    invalidate();
    const output = stripAnsi(hub.render(90).join("\n"));
    assert.match(output, /AFTER_ASYNC/);
    assert.doesNotMatch(output, /BEFORE_ASYNC/);
  } finally {
    hub.dispose();
  }
});

// Real configured bindings: TUI defaults plus the app-level expansion action.
const hubBindings = (user: ConstructorParameters<typeof KeybindingsManager>[1] = {}) =>
  new KeybindingsManager(
    {
      ...TUI_KEYBINDINGS,
      "app.tools.expand": { defaultKeys: "ctrl+o", description: "Expand tools" },
    },
    user,
  );
const flat = (lines: readonly string[]) =>
  lines
    .map((line) => stripAnsi(line).replaceAll("│", " "))
    .join(" ")
    .replace(/\s+/g, " ");
const footerRows = (lines: readonly string[]) => {
  const plain = lines.map(stripAnsi);
  return plain.slice(plain.findIndex((line) => line.startsWith("├")) + 1, -1);
};

for (const [name, user, close, steer, closing, inert] of [
  ["default", {}, "escape/ctrl+c", "enter", ["\x1b", "\x03"], []],
  [
    "remapped",
    { "tui.select.cancel": "ctrl+q", "tui.select.confirm": "ctrl+w" },
    "ctrl+q",
    "ctrl+w",
    ["\x11"],
    ["\x1b", "\r", "\x03"],
  ],
] as const) {
  test(`Hub compact/wide hints name every action, the next view and all ${name} close bindings`, (t) => {
    const coordinator = new DelegationCoordinator("unused", "root");
    t.mock.method(coordinator, "list", () => [snapshot("one"), snapshot("two", { generation: 2 })]);
    t.mock.method(coordinator, "messages", () => []);
    const sent: string[] = [];
    for (const method of ["stop", "steer", "message", "coordinateWait", "park"] as const)
      t.mock.method(coordinator, method, async () => {
        sent.push(method);
      });
    let closed = 0,
      rows = 21;
    const open = () =>
      createHub(
        coordinator,
        theme,
        hubBindings(user),
        () => {},
        () => closed++,
        dependencies,
        () => rows,
      );
    const hub = open();
    try {
      // Physical 80×24 → 72×21 overlay, stress 60×16 → 54×14, wide 100×30 → 90×27.
      for (const [width, height] of [
        [72, 21],
        [54, 14],
        [90, 27],
      ]) {
        rows = height;
        for (const next of ["Details", "Tools", "Thread"]) {
          const lines = hub.render(width);
          assert.ok(lines.length <= height);
          assert.ok(lines.every((line) => visibleWidth(line) === width));
          const footer = footerRows(lines);
          for (const hint of [
            `${steer} Steer`,
            "m Inbox",
            "x Stop",
            "/ Filter",
            `Tab ${next}`,
            "? Help",
            `${close}: close`,
          ])
            assert.ok(
              footer.some((line) => line.includes(hint)),
              `${width}×${height}: ${hint}`,
            );
          if (width >= 76)
            for (const hint of ["w Wait", "p Park"])
              assert.ok(footer.some((line) => line.includes(hint)));
          hub.handleInput!("\t");
        }
      }
      for (const key of inert) hub.handleInput!(key);
      assert.equal(closed, 0, "unconfigured keys never close");
      for (const key of closing) hub.handleInput!(key);
      assert.equal(closed, closing.length, "every advertised binding closes from browse");
      assert.deepEqual(sent, [], "hints, tabs, resize and closing send no action");
    } finally {
      hub.dispose();
    }
  });
}

test("Hub ? help is modal and observation-only, then restores selection, view and READING anchor", async (t) => {
  const coordinator = new DelegationCoordinator("unused", "root");
  t.mock.method(coordinator, "list", () => [
    snapshot("alpha"),
    snapshot("beta", { generation: 3 }),
  ]);
  t.mock.method(coordinator, "snapshot", (ref: ChildRef) => snapshot(ref.id, ref));
  t.mock.method(coordinator, "messages", (ref: ChildRef) => [
    {
      role: "user",
      timestamp: 1,
      content: Array.from({ length: 80 }, (_, i) => `${ref.id} LINE ${i}`).join("\n"),
    },
  ]);
  const sent: unknown[] = [];
  for (const method of ["stop", "steer", "message", "coordinateWait", "park"] as const)
    t.mock.method(coordinator, method, async (...args: unknown[]) => {
      sent.push([method, ...args]);
      return "queued";
    });
  let closed = 0,
    rows = 27,
    width = 90;
  const hub = createHub(
    coordinator,
    theme,
    hubBindings(),
    () => {},
    () => closed++,
    dependencies,
    () => rows,
  );
  const render = () => {
    const lines = hub.render(width);
    assert.ok(lines.length <= rows);
    assert.ok(lines.every((line) => visibleWidth(line) === width));
    return lines.map(stripAnsi);
  };
  try {
    render();
    hub.handleInput!("\x1b[B");
    render();
    for (let i = 0; i < 5; i++) hub.handleInput!("k");
    const before = render();
    assert.match(before.join("\n"), /READING/);
    assert.match(before.join("\n"), /> [├└] ● inspect beta/);
    hub.handleInput!("?");
    const shown = render().join("\n");
    assert.match(shown, /Subagent Hub · Help/);
    assert.match(shown, /observation only/);
    assert.match(shown, /x, then y +Stop subtree; reported after drain/);
    assert.match(shown, /escape\/ctrl\+c +Close the Hub; tasks keep running/);
    assert.match(shown, /enter +Steer the selected running task in the composer/);
    assert.match(shown, /ctrl\+o +Toggle all tool output/);
    assert.match(shown, /\? or escape\/ctrl\+c: back to Hub/);
    assert.doesNotMatch(shown, /beta LINE/, "help replaces the thread instead of layering on it");
    for (const key of ["s", "m", "x", "y", "\r", "\t", "/", "w", "p", "f", "r", "\x0f", " "])
      hub.handleInput!(key);
    for (const key of ["\x1b[A", "\x1b[B", "j", "k", "\x1b[5~", "\x1b[6~", "\x1b[H", "\x1b[F"])
      hub.handleInput!(key);
    assert.equal(
      hub.handleMouse?.({
        type: "wheel",
        button: "none",
        x: 50,
        y: 5,
        screenX: 50,
        screenY: 5,
        width: 90,
        height: 27,
        shift: false,
        alt: false,
        ctrl: false,
        wheelDelta: -3,
      })?.handled,
      true,
    );
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(sent, [], "help blocks every underlying control");
    assert.equal(closed, 0, "Enter inside help never closes the Hub");
    for ([width, rows] of [
      [54, 14],
      [20, 4],
      [72, 21],
    ]) {
      const small = render().join("\n");
      if (rows === 14) assert.match(small, /back to Hub · j\/k scroll/);
    }
    [width, rows] = [90, 27];
    assert.match(render().join("\n"), /Help/);
    hub.handleInput!("?");
    assert.deepEqual(render(), before, "explicit ? return restores the original frame");
    hub.handleInput!("?");
    hub.handleInput!("\x1b");
    assert.deepEqual(render(), before, "cancel returns from help instead of closing");
    assert.equal(closed, 0);
    for (const view of ["DETAILS", "TOOLS"]) {
      hub.handleInput!("\t");
      const previous = render();
      assert.match(previous.join("\n"), new RegExp(view));
      hub.handleInput!("?");
      render();
      hub.handleInput!("\x1b");
      assert.deepEqual(render(), previous, `${view} returns without changing scroll/view`);
    }
    hub.handleInput!("\x1b");
    assert.equal(closed, 1, "browse Escape still closes");
  } finally {
    hub.dispose();
  }
});

test("Hub text inputs keep ?, j, k and Space printable; stop confirmation ignores help", async (t) => {
  const coordinator = new DelegationCoordinator("unused", "root");
  t.mock.method(coordinator, "list", () => [snapshot("alpha")]);
  t.mock.method(coordinator, "snapshot", () => snapshot("alpha"));
  t.mock.method(coordinator, "messages", () => []);
  const sent: unknown[] = [];
  t.mock.method(coordinator, "steer", async (ref: ChildRef, text: string) => {
    sent.push(["steer", ref.id, text]);
    return "queued";
  });
  t.mock.method(coordinator, "stop", async (ref: ChildRef) => {
    sent.push(["stop", ref.id]);
  });
  t.mock.method(
    coordinator,
    "message",
    async (_actor: ChildRef | undefined, ref: ChildRef | undefined, text: string) => {
      sent.push(["message", ref!.id, text]);
      return { id: "receipt", status: "queued" };
    },
  );
  const hub = createHub(
    coordinator,
    theme,
    hubBindings(),
    () => {},
    () => {},
    dependencies,
    () => 21,
  );
  const output = () => flat(hub.render(72));
  try {
    output();
    hub.handleInput!("\r");
    for (const key of ["?", " ", "j", " ", "k", " ", "s", "x"]) hub.handleInput!(key);
    assert.match(output(), /Steer > \? j k sx/);
    assert.doesNotMatch(output(), /Help/);
    hub.handleInput!("\r");
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(sent, [["steer", "alpha", "? j k sx"]]);
    hub.handleInput!("m");
    for (const key of ["?", " ", "j", " ", "k"]) hub.handleInput!(key);
    assert.match(output(), /Inbox: > \? j k/);
    hub.handleInput!("\r");
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(sent.at(-1), ["message", "alpha", "? j k"]);
    hub.handleInput!("/");
    for (const key of ["?", "j", " ", "k"]) hub.handleInput!(key);
    assert.match(output(), /Filter: > \?j k/);
    hub.handleInput!("\x1b");
    hub.handleInput!("x");
    hub.handleInput!("?");
    assert.match(output(), /Stop target\? y confirms/, "? cannot hide a pinned stop prompt");
    hub.handleInput!("y");
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(sent.at(-1), ["stop", "alpha"]);
  } finally {
    hub.dispose();
  }
});

test("Hub thread-column composer explains availability, ignores empty sends and fits narrow layouts", async (t) => {
  const coordinator = new DelegationCoordinator("unused", "root");
  const children = [
    snapshot("alpha"),
    snapshot("done", { status: "settled", disposed: true, assignment: "finished work" }),
  ];
  t.mock.method(coordinator, "list", () => structuredClone(children));
  t.mock.method(coordinator, "snapshot", (ref: ChildRef) =>
    structuredClone(children.find((child) => child.id === ref.id)),
  );
  t.mock.method(coordinator, "messages", () => []);
  const sent: string[] = [];
  t.mock.method(coordinator, "steer", async (_ref: ChildRef, text: string) => {
    sent.push(text);
    return "queued";
  });
  let closed = 0;
  const hub = createHub(
    coordinator,
    theme,
    hubBindings(),
    () => {},
    () => closed++,
    dependencies,
    () => 21,
  );
  const output = (width = 90) => stripAnsi(hub.render(width).join("\n"));
  try {
    for (const width of [90, 54]) {
      const lines = output(width).split("\n");
      const separator = lines.findIndex((line) => line.startsWith("├"));
      assert.match(lines[separator - 2], /Steer · Enter to compose a message for this task/);
      assert.match(lines[separator - 1], /controlled\/model · effort unavailable │$/);
    }
    hub.handleInput!("\r");
    hub.handleInput!("   ");
    hub.handleInput!("\r");
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(sent, [], "whitespace-only drafts send nothing");
    assert.match(output(), /Nothing to send/);
    assert.match(output(), /Target: alpha #1/, "composer stays focused after an empty send");
    hub.handleInput!("\x1b");
    hub.handleInput!("\x1b[B");
    assert.match(output(54), /Steer · unavailable · ended/);
    hub.handleInput!("\r");
    assert.match(output(), /Steering unavailable/);
    assert.doesNotMatch(output(), /Target:/);
    assert.equal(closed, 0, "Enter never closes the Hub");
  } finally {
    hub.dispose();
  }
});

const usage: ChildSnapshot["telemetry"] = {
  requests: 3,
  tokens: { input: 12_000, output: 3_100, cacheRead: 40_000, cacheWrite: 2_000, total: 57_100 },
  cost: 0.042,
  context: { tokens: 82_400, contextWindow: 200_000, percent: 41.2 },
};

test("status line shows direct usage left and provider/model/effort right like Pi's footer", () => {
  const plain = (_color: string, text: string) => text;
  const child = snapshot("status", {
    model: { provider: "anthropic", id: "claude-opus-4-5" },
    effort: "high",
    telemetry: usage,
  });
  const model = "anthropic/claude-opus-4-5 · effort high";
  const full = statusLine(child, 100, plain);
  assert.equal(visibleWidth(full), 100);
  assert.match(
    full,
    /^↑12k ↓3\.1k R40k W2\.0k \$0\.042 41\.2%\/200k +anthropic\/claude-opus-4-5 · effort high$/,
  );
  assert.equal(statusLine(undefined, 100, plain), "", "no selection renders an empty row");
  assert.equal(statusLine(child, 0, plain), "");

  const right = (patch: Partial<ChildSnapshot>) => statusLine({ ...child, ...patch }, 100, plain);
  assert.match(right({ effort: null }), /anthropic\/claude-opus-4-5 · effort unavailable$/);
  assert.match(right({ effort: "off" }), /· effort off$/);
  const unknown = { requests: null, tokens: null, cost: null, context: null };
  assert.equal(right({ telemetry: unknown }), " ".repeat(100 - model.length) + model);
  const zeros = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
  assert.equal(
    right({ telemetry: { ...unknown, tokens: zeros, cost: 0 } }).trim(),
    model,
    "zero usage is omitted, never printed as 0",
  );
  assert.match(right({ telemetry: { ...usage, costIncomplete: true } }), / ≥\$0\.042 /);
  assert.match(right({ telemetry: { ...unknown, cost: 0, costIncomplete: true } }), /^≥\$0\.000 /);
  assert.match(
    right({
      telemetry: { ...unknown, context: { tokens: null, contextWindow: 200_000, percent: null } },
    }),
    /^\?\/200k /,
    "unknown percent is explicit, not synthesized",
  );
  assert.match(
    right({ model: { provider: "evil\u001b]8;;x\u0007", id: "m\u001b[31m" } }),
    /evil.*\/m.* · effort high$/,
  );
  assert.doesNotMatch(
    right({ model: { provider: "evil\u001b]8;;x\u0007", id: "m\u001b[31m" } }),
    /[\x00-\x1f\x7f-\x9f]/,
  );

  for (const [percent, expected] of [
    [41.2, "dim"],
    [70, "dim"],
    [70.1, "warning"],
    [75, "warning"],
    [90, "warning"],
    [90.1, "error"],
    [95, "error"],
  ] as const) {
    const colors = new Map<string, string>();
    statusLine(
      {
        ...child,
        telemetry: { ...usage, context: { tokens: 1, contextWindow: 200_000, percent } },
      },
      100,
      (color, text) => (colors.set(text, color), text),
    );
    assert.equal(colors.get(`${percent.toFixed(1)}%/200k`), expected);
  }

  // Pi footer token thresholds.
  for (const [count, text] of [
    [999, "999"],
    [1_000, "1.0k"],
    [9_949, "9.9k"],
    [10_000, "10k"],
    [999_000, "999k"],
    [1_000_000, "1.0M"],
    [12_300_000, "12M"],
  ] as const) {
    const tokens = { input: count, output: 0, cacheRead: 0, cacheWrite: 0, total: count };
    assert.match(
      right({
        telemetry: { ...unknown, tokens, context: { ...usage.context!, contextWindow: count } },
      }),
      new RegExp(`^↑${text.replace(".", "\\.")} 41\\.2%/${text.replace(".", "\\.")} `),
    );
  }

  // Model/effort outrank usage; whole usage parts yield (cache, ↑, ↓, cost, context).
  const parts = ["↑12k", "↓3.1k", "R40k", "W2.0k", "$0.042", "41.2%/200k"];
  const leftAt = (width: number) => statusLine(child, width, plain).split(/ {2,}/)[0];
  const fitting = (left: string) => model.length + 2 + left.length;
  assert.equal(leftAt(fitting("↑12k ↓3.1k $0.042 41.2%/200k")), "↑12k ↓3.1k $0.042 41.2%/200k");
  assert.equal(leftAt(fitting("↓3.1k $0.042 41.2%/200k")), "↓3.1k $0.042 41.2%/200k");
  assert.equal(leftAt(fitting("$0.042 41.2%/200k")), "$0.042 41.2%/200k");
  assert.equal(leftAt(fitting("41.2%/200k")), "41.2%/200k");
  assert.equal(statusLine(child, model.length, plain), model, "usage yields entirely before model");
  assert.equal(
    statusLine(child, model.length - 1, plain),
    "claude-opus-4-5 · effort high".padStart(model.length - 1),
    "provider yields before the model or effort is truncated",
  );
  for (let width = 1; width <= 120; width++) {
    const line = statusLine(child, width, plain);
    assert.equal(visibleWidth(line), width);
    const segments = stripAnsi(line).trim().split(/ {2,}/);
    if (segments.length > 1)
      for (const part of segments[0].split(" "))
        assert.ok(parts.includes(part), `whole part: ${part}`);
  }
  assert.ok(
    stripAnsi(statusLine(child, 10, plain)) === "claude-op…",
    "model truncates only when it alone overflows",
  );
});

test("Hub status row sits below the composer and follows the selected generation live", (t) => {
  const coordinator = new DelegationCoordinator("unused", "root");
  let children = [
    snapshot("alpha", {
      model: { provider: "anthropic", id: "claude-opus-4-5" },
      effort: "high",
      telemetry: usage,
    }),
    snapshot("beta", { model: { provider: "openai", id: "gpt-5" }, effort: "low" }),
  ];
  let listener: Parameters<DelegationCoordinator["subscribe"]>[0] | undefined;
  t.mock.method(coordinator, "list", () => structuredClone(children));
  t.mock.method(coordinator, "snapshot", (ref: ChildRef) =>
    structuredClone(children.find((child) => child.id === ref.id)),
  );
  t.mock.method(coordinator, "messages", () => []);
  t.mock.method(coordinator, "subscribe", (cb: typeof listener) => {
    listener = cb;
    return () => {};
  });
  let rows = 24;
  // Pi's Theme.fg is a method that reads `this`; the Hub must keep the receiver.
  const methodTheme = {
    ...theme,
    marker: "",
    fg(this: { marker: string }, _color: string, text: string) {
      return this.marker + text;
    },
  };
  const hub = createHub(
    coordinator,
    methodTheme,
    hubBindings(),
    () => {},
    () => {},
    dependencies,
    () => rows,
  );
  const lines = (width: number) => hub.render(width).map(stripAnsi);
  const statusRow = (width: number) => {
    const rendered = lines(width);
    const separator = rendered.findIndex((line) => line.startsWith("├"));
    return {
      rendered,
      separator,
      composer: rendered[separator - 2],
      status: rendered[separator - 1],
    };
  };
  try {
    for (const width of [100, 60]) {
      const { rendered, composer, status } = statusRow(width);
      assert.ok(rendered.every((line) => visibleWidth(line) === width));
      assert.match(composer, /Steer · Enter to compose/);
      assert.match(status, /anthropic\/claude-opus-4-5 · effort high │$/);
      assert.match(status, /41\.2%\/200k/);
    }
    // Fallback/prewalk switches and new telemetry arrive as ordinary registry updates.
    children = [
      {
        ...children[0],
        model: { provider: "google", id: "gemini-2.5-pro" },
        effort: "medium",
        telemetry: {
          ...usage,
          cost: 0.5,
          context: { tokens: 1, contextWindow: 1_000_000, percent: 92 },
        },
      },
      children[1],
    ];
    listener!({ type: "changed", child: children[0] });
    assert.match(
      statusRow(100).status,
      /\$0\.500 92\.0%\/1\.0M +google\/gemini-2\.5-pro · effort medium │$/,
    );
    hub.handleInput!("\x1b[B");
    assert.match(
      statusRow(100).status,
      /│ +openai\/gpt-5 · effort low │$/,
      "selection switches values",
    );
    assert.doesNotMatch(statusRow(100).status, /gemini|\$/);
    hub.handleInput!("\r");
    hub.handleInput!("draft");
    const steering = statusRow(100);
    assert.match(steering.composer, /Steer > draft/);
    assert.match(
      steering.status,
      /openai\/gpt-5 · effort low │$/,
      "status stays below a focused composer",
    );
    hub.handleInput!("\x1b");
    for (rows = 1; rows <= 27; rows++)
      for (const width of [40, 60, 100]) {
        const rendered = lines(width);
        assert.ok(
          rendered.length <= rows && rendered.every((line) => visibleWidth(line) === width),
        );
        const status = rendered.findIndex((line) => /effort low/.test(line));
        if (status < 0) continue;
        assert.match(
          rendered[status - 1],
          /Steer/,
          "status row never appears without the composer",
        );
        assert.ok(
          rendered.slice(3, status - 2).length >= 2,
          `at least two reading rows remain at ${width}x${rows}`,
        );
      }
  } finally {
    hub.dispose();
  }
});

const delayed = {
  stop: { key: "x", submit: "y", label: "Stop", pending: "stopping and draining…" },
  steer: { key: "\r", submit: "\r", label: "Steer", pending: "sending…" },
  message: { key: "m", submit: "\r", label: "Inbox", pending: "sending…" },
  wait: {
    key: "w",
    submit: "",
    label: "Wait",
    pending: "waiting up to 1000ms (not model acknowledgment)…",
  },
} as const;
for (const action of ["stop", "steer", "message", "wait"] as const)
  for (const outcome of ["success", "error"] as const)
    for (const [width, height] of [
      [72, 21],
      [54, 12],
    ])
      test(`Hub delayed ${action} ${outcome} at ${width}×${height} stays attributed to A while browsing B, filtering and a new generation`, async (t) => {
        const coordinator = new DelegationCoordinator("unused", "root");
        const changed = registryChanges(t, coordinator);
        const a = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
          b = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
        const children = [
          snapshot(a, { assignment: "alpha audit", generation: 7 }),
          snapshot(b, { assignment: "beta audit", generation: 9 }),
        ];
        t.mock.method(coordinator, "list", () => structuredClone(children));
        t.mock.method(coordinator, "messages", () => []);
        t.mock.method(coordinator, "snapshot", (ref: ChildRef) =>
          structuredClone(
            children.find((child) => child.id === ref.id && child.generation === ref.generation),
          ),
        );
        let settle!: () => void, fail!: (error: Error) => void;
        const finished = new Promise<void>((resolve, reject) => {
          settle = resolve;
          fail = reject;
        });
        const dispatched: ChildRef[] = [];
        const respond =
          <T>(value: T) =>
          async (...args: unknown[]) => {
            const ref = args.find(
              (arg): arg is ChildRef => typeof arg === "object" && arg !== null && "id" in arg,
            )!;
            dispatched.push({ id: ref.id, generation: ref.generation });
            await finished;
            return value;
          };
        t.mock.method(coordinator, "stop", respond(undefined));
        t.mock.method(coordinator, "steer", respond("queued"));
        t.mock.method(coordinator, "message", respond({ id: "receipt-1", status: "queued" }));
        t.mock.method(coordinator, "coordinateWait", respond({ status: "timeout" }));
        let renders = 0;
        const hub = createHub(
          coordinator,
          theme,
          hubBindings(),
          () => renders++,
          () => {},
          dependencies,
          () => height,
        );
        const output = () => {
          const lines = hub.render(width);
          assert.ok(lines.length <= height);
          assert.ok(lines.every((line) => visibleWidth(line) <= width));
          return flat(lines);
        };
        const { key, submit, label, pending } = delayed[action];
        const who = `${a} #7 · alpha audit · scout`;
        try {
          output();
          hub.handleInput!(key);
          if (action === "steer" || action === "message") hub.handleInput!("check shutdown");
          if (submit) {
            output();
            hub.handleInput!(submit);
          }
          await new Promise((resolve) => setImmediate(resolve));
          assert.ok(output().includes(`${label} ${who}: ${pending}`), "pending names A");
          hub.handleInput!("\x1b[B");
          assert.ok(
            output().includes(`${label} ${who}: ${pending}`),
            "optional browse hints yield to the complete original-target notice",
          );
          hub.handleInput!("/");
          hub.handleInput!("beta");
          hub.handleInput!("\r");
          children[0] = { ...children[0], generation: 8 };
          changed(children[0]);
          assert.match(output(), /beta audit · scout/);
          assert.ok(
            output().includes(`${label} ${who}: ${pending}`),
            "pending retains A while browsing B",
          );
          assert.doesNotMatch(output(), /stopped and drained/, "stop success waits for drain");
          hub.handleInput!("?");
          assert.ok(
            output().includes(`${label} ${who}: ${pending}`),
            "help retains the whole notice",
          );
          hub.handleInput!("?");
          if (outcome === "success") settle();
          else fail(new Error("provider refused"));
          await new Promise((resolve) => setImmediate(resolve));
          await new Promise((resolve) => setImmediate(resolve));
          const text = output();
          const expected =
            outcome === "error"
              ? `${label} ${who} failed: Error: provider refused`
              : {
                  stop: `Stop ${who}: stopped and drained`,
                  steer: `Steer ${who}: queued · NOT model acknowledgment`,
                  message: `Inbox ${who}: message receipt-1 · queued · NOT model acknowledgment`,
                  wait: `Wait ${who}: {"status":"timeout"}`,
                }[action];
          assert.ok(text.includes(expected), `${expected}\n${text}`);
          assert.ok(!text.includes(`${b} #9`) && !text.includes(`${a} #8`), "never retargets");
          assert.deepEqual(dispatched, [{ id: a, generation: 7 }]);
          hub.dispose();
          const after = renders;
          children[1] = { ...children[1], status: "settled" };
          changed(children[1]);
          assert.equal(renders, after, "disposed Hub ignores later events");
        } finally {
          hub.dispose();
        }
      });

test("Hub park notices retain exact target identity and label", (t) => {
  const coordinator = new DelegationCoordinator("unused", "root");
  const a = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
  t.mock.method(coordinator, "list", () => [
    snapshot(a, { assignment: "alpha audit", generation: 7, status: "settled", disposed: true }),
  ]);
  t.mock.method(coordinator, "messages", () => []);
  let refuse = false;
  t.mock.method(coordinator, "park", () => {
    if (refuse) throw new Error("not idle");
  });
  const hub = createHub(
    coordinator,
    theme,
    hubBindings(),
    () => {},
    () => {},
    dependencies,
    () => 21,
  );
  try {
    hub.render(72);
    hub.handleInput!("p");
    assert.ok(flat(hub.render(72)).includes(`Park ${a} #7 · alpha audit · scout: parked`));
    refuse = true;
    hub.handleInput!("p");
    assert.ok(
      flat(hub.render(72)).includes(`Park ${a} #7 · alpha audit · scout failed: Error: not idle`),
    );
  } finally {
    hub.dispose();
  }
});

test("compact widget keeps failure explicit, distinguishes outcomes without color and discloses /subagent-hub within budget", () => {
  const fleets: Record<string, ChildSnapshot["status"][]> = {
    failed: ["failed"],
    settled: ["settled"],
    cancelled: ["cancelled"],
    mixed: ["settled", "failed", "cancelled", "settled"],
    queued: ["queued", "queued"],
    paused: ["paused"],
  };
  const frames = new Map<string, string>();
  for (const [name, statuses] of Object.entries(fleets)) {
    const children = statuses.map((status, index) =>
      snapshot(`${name}-${index}`, {
        status,
        disposed: ["settled", "failed", "cancelled"].includes(status),
      }),
    );
    for (const width of [0, 8, 20, 40, 55, 60, 80, 180])
      for (const rows of [4, 8, 24, 30]) {
        const lines = createChildWidget(
          () => children,
          theme,
          () => rows,
        ).render(width);
        assert.ok(lines.length <= Math.max(1, Math.min(5, Math.floor(rows / 4))));
        assert.ok(lines.every((line) => visibleWidth(line) <= width));
        const text = lines.map(stripAnsi).join("\n");
        if (width >= 20) assert.match(text, new RegExp(`^● Subagents ${children.length}`));
        if (width >= 55) assert.match(text, /\/subagent-hub/, `${name} ${width}`);
        if (width >= 40) {
          const failed = statuses.filter((status) => status === "failed").length;
          if (failed)
            assert.match(text, new RegExp(`${failed} failed`), `${name} ${width}×${rows}`);
          else assert.doesNotMatch(text, /failed/);
        }
        if (width === 55 && rows === 24) frames.set(name, text);
      }
  }
  assert.equal(new Set(frames.values()).size, frames.size, "each outcome renders distinct text");
  // Representative monochrome frames at 55 columns.
  assert.deepEqual(Object.fromEntries(frames), {
    failed: "● Subagents 1 · 1 failed · /subagent-hub",
    settled: "● Subagents 1 · 1 settled · /subagent-hub",
    cancelled: "● Subagents 1 · 1 cancelled · /subagent-hub",
    mixed: "● Subagents 4 · 2 settled · 1 failed · 1 cancelled\n└─ /subagent-hub for details",
    queued: "● Subagents 2 · 2 queued · /subagent-hub",
    paused: "● Subagents 1 · 1 paused · /subagent-hub",
  });
});

test("Hub remapped input/cancel hints and unbound expansion/help have no default-key fallback", async (t) => {
  const coordinator = new DelegationCoordinator("unused", "root");
  const child = snapshot("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", { assignment: "alpha" });
  t.mock.method(coordinator, "list", () => [child]);
  t.mock.method(coordinator, "snapshot", () => structuredClone(child));
  t.mock.method(coordinator, "messages", () => []);
  const sent: string[] = [];
  t.mock.method(coordinator, "steer", async (_target: ChildRef, text: string) => {
    sent.push(text);
    return "queued";
  });
  let rows = 21,
    closed = 0;
  const hub = createHub(
    coordinator,
    theme,
    hubBindings({
      "tui.select.cancel": ["ctrl+q", "ctrl+z"],
      "tui.select.confirm": ["ctrl+w", "ctrl+e"],
      "app.tools.expand": [],
    }),
    () => {},
    () => closed++,
    dependencies,
    () => rows,
  );
  const output = () => flat(hub.render(72));
  try {
    assert.match(output(), /ctrl\+q\/ctrl\+z: close/);
    assert.match(output(), /ctrl\+w\/ctrl\+e Steer/);
    assert.match(output(), /Tools collapsed · unbound: toggle all/);
    hub.handleInput!("\x0f");
    assert.match(output(), /Tools collapsed/);
    hub.handleInput!("?");
    assert.match(output(), /Help/);
    for (let i = 0; i < 15; i++) {
      hub.handleInput!("j");
      output();
    }
    assert.match(output(), /unbound Toggle all tool output/);
    hub.handleInput!("\x1b");
    assert.match(output(), /Help/, "unbound default Escape cannot exit help");
    hub.handleInput!("\x11");
    hub.handleInput!("\r");
    assert.doesNotMatch(output(), /Target:/, "default Enter is inert under remapped confirm");
    hub.handleInput!("\x17");
    hub.handleInput!("? j k");
    assert.match(output(), /ctrl\+w\/ctrl\+e send · ctrl\+q\/ctrl\+z back/);
    rows = 4;
    hub.handleInput!("\x17");
    assert.deepEqual(sent, [], "hidden controls refuse remapped confirmation before redraw");
    assert.match(output(), /Resize/);
    hub.handleInput!("\x17");
    assert.deepEqual(sent, []);
    rows = 21;
    assert.match(output(), /Steer > \? j k/);
    hub.handleInput!("\x05");
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(sent, ["? j k"]);
    hub.handleInput!("\x05");
    output();
    hub.handleInput!("cancel me");
    hub.handleInput!("\x1a");
    assert.doesNotMatch(output(), /Target:/);
    assert.equal(sent.length, 1);
    assert.equal(closed, 0, "local configured cancel does not close");
    hub.handleInput!("\x11");
    assert.equal(closed, 1);
  } finally {
    hub.dispose();
  }
});

for (const outcome of ["success", "error"] as const)
  test(`Hub disposed pending stop ${outcome} never redraws or changes the next opening`, async (t) => {
    const coordinator = new DelegationCoordinator("unused", "root");
    const child = snapshot("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", { assignment: "alpha" });
    t.mock.method(coordinator, "list", () => [child]);
    t.mock.method(coordinator, "snapshot", () => structuredClone(child));
    t.mock.method(coordinator, "messages", () => []);
    let settle!: () => void, fail!: (error: Error) => void;
    const drained = new Promise<void>((resolve, reject) => {
      settle = resolve;
      fail = reject;
    });
    let calls = 0;
    t.mock.method(coordinator, "stop", async () => {
      calls++;
      await drained;
    });
    let renders = 0;
    const open = () =>
      createHub(
        coordinator,
        theme,
        hubBindings(),
        () => renders++,
        () => {},
        dependencies,
        () => 21,
      );
    const old = open();
    old.render(72);
    old.handleInput!("x");
    old.render(72);
    old.handleInput!("y");
    old.dispose();
    const fresh = open();
    try {
      const before = fresh.render(72).map(stripAnsi);
      const count = renders;
      if (outcome === "success") settle();
      else fail(new Error("late failure"));
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(renders, count);
      assert.deepEqual(fresh.render(72).map(stripAnsi), before);
      assert.equal(calls, 1, "disposing UI never sends another stop");
    } finally {
      fresh.dispose();
    }
  });

test("single-row compact widget prioritizes failed text and Hub discovery even in a mixed live fleet", () => {
  const children = [
    snapshot("running"),
    snapshot("failed", { status: "failed", disposed: true }),
    snapshot("queued", { status: "queued" }),
    snapshot("settled", { status: "settled", disposed: true }),
  ];
  const output = createChildWidget(
    () => children,
    theme,
    () => 4,
  ).render(55);
  assert.equal(output.length, 1);
  assert.ok(visibleWidth(output[0]) <= 55);
  assert.match(output[0], /Subagents 4/);
  assert.match(output[0], /1 failed/);
  assert.match(output[0], /1 active/);
  assert.match(output[0], /\/subagent-hub/);
});
