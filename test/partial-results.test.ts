import test from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  fauxAssistantMessage,
  fauxToolCall,
  type FauxResponseFactory,
} from "@earendil-works/pi-ai";
import { CustomMessageComponent, initTheme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { fixture, eventually } from "./fixtures.ts";
import { DEFAULT_POLICY } from "../src/scheduling.ts";
import { taskCard } from "../src/hub.ts";
import { taskDetails } from "../src/task-presentation.ts";

type Context = Parameters<FauxResponseFactory>[0];
const userText = (context: Context, first = false) => {
  const users = context.messages.filter((message) => message.role === "user");
  const user = first ? users[0] : users.at(-1);
  return typeof user?.content === "string"
    ? user.content
    : (user?.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("") ?? "");
};
const guidance = (context: Context) =>
  context.messages
    .filter((message) => message.role === "system")
    .map((message) => message.content)
    .join("\n");
/** Parent turns: launch the requested delegate_task, then acknowledge. */
const parentTurn = (context: Context) => {
  if (!userText(context, true).startsWith("LAUNCH ")) return undefined;
  const text = userText(context);
  return text.startsWith("LAUNCH ") && context.messages.at(-1)?.role !== "toolResult"
    ? fauxAssistantMessage(fauxToolCall("delegate_task", JSON.parse(text.slice(7))), {
        stopReason: "toolUse",
      })
    : fauxAssistantMessage("acknowledged");
};
const hostile = "partial \x1b[31mfindings\u202e so far";

test("paused windows carry partial plus a bounded last-text preview; resume clears it", async (t) => {
  let release!: () => void;
  let entered = 0;
  const f = await fixture(t, {
    speed: 0,
    tokenSize: { min: 10000, max: 10000 },
    extra: (pi) => {
      pi.on("tool_call", async (event) => {
        if (event.toolName === "read") {
          entered++;
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        }
      });
    },
    response: (context) =>
      userText(context) === "finish"
        ? fauxAssistantMessage("final answer")
        : fauxAssistantMessage(
            [
              { type: "text", text: "x".repeat(5000) + " latest findings" },
              fauxToolCall("read", { path: "input.txt" }),
            ],
            { stopReason: "toolUse" },
          ),
  });
  await writeFile(join(f.root, "input.txt"), "data");
  f.coordinator.configure({ ...DEFAULT_POLICY, deadlineMs: 500 });
  const ref = await f.direct("original");
  const waiter = f.coordinator.wait(ref);
  await eventually(() => entered === 1);
  await eventually(() => f.coordinator.snapshot(ref)!.status === "pausing");
  assert.equal(f.coordinator.snapshot(ref)!.partial, undefined, "only drained pauses are partial");
  release();
  const paused = await waiter;
  assert.equal(paused.status, "paused");
  assert.equal(paused.partial, true);
  assert.equal(paused.artifacts, undefined, "paused windows publish no outcome artifacts");
  assert.ok(paused.partialText!.startsWith("xxx"));
  assert.ok(paused.partialText!.length < 2200, "preview is bounded");
  assert.match(paused.partialText!, /Preview truncated/);
  assert.match(taskCard(paused).join("\n"), /Partial: paused before a final answer · last text: x/);

  assert.match(
    taskDetails(paused, "paused").join("\n"),
    /Partial \(paused before a final answer\)\nxxx/,
  );
  await f.coordinator.resume(ref, "finish");
  assert.equal(f.coordinator.snapshot(ref)!.partial, undefined, "resume clears partial");
  assert.equal(f.coordinator.snapshot(ref)!.partialText, undefined);
  const final = await f.coordinator.wait(ref);
  assert.equal(final.status, "settled");
  assert.equal(final.result, "final answer");
  assert.equal(final.partial, undefined, "ordinary settle is not partial");
  assert.doesNotMatch(taskCard(final, true).join("\n"), /Partial/);
});

test("wrap-up-settled windows are partial; ordinary settles are not", async (t) => {
  const f = await fixture(t, {
    speed: 0,
    response: (context) => {
      if (userText(context) === "quick") return fauxAssistantMessage("quick report");
      if (guidance(context).includes("Delegation wrap-up"))
        return fauxAssistantMessage("wrap-up report");
      return fauxAssistantMessage(fauxToolCall("read", { path: "missing.txt" }), {
        stopReason: "toolUse",
      });
    },
  });
  const ref = await f.direct("long", "scout", {
    limits: { requests: 10, tools: 2 },
  });
  const wrapped = await f.coordinator.wait(ref);
  assert.equal(wrapped.status, "settled");
  assert.equal(wrapped.result, "wrap-up report");
  assert.equal(wrapped.partial, true);
  assert.equal(wrapped.partialText, undefined, "the report itself is the result");
  assert.deepEqual(taskCard(wrapped).slice(1), ["Partial: budget wrap-up report"]);

  const quick = await f.coordinator.wait(
    await f.direct("quick", "scout", { limits: { requests: 3 } }),
  );
  assert.equal(quick.status, "settled");
  assert.equal(quick.partial, undefined);
  assert.equal(taskCard(quick).length, 1);
});

for (const kind of ["paused", "wrap-up"] as const)
  test(`background ${kind} notification carries the partial marker and sanitized, width-safe card`, async (t) => {
    let release!: () => void;
    let entered = false;
    const f = await fixture(t, {
      speed: 0,
      extra: (pi) => {
        pi.on("tool_call", async (event) => {
          if (kind === "paused" && event.toolName === "read") {
            entered = true;
            await new Promise<void>((resolve) => {
              release = resolve;
            });
          }
        });
      },
      response: (context) => {
        const parent = parentTurn(context);
        if (parent) return parent;
        if (guidance(context).includes("Delegation wrap-up")) return fauxAssistantMessage(hostile);
        return fauxAssistantMessage(
          [{ type: "text", text: hostile }, fauxToolCall("read", { path: "input.txt" })],
          { stopReason: "toolUse" },
        );
      },
    });
    await writeFile(join(f.root, "input.txt"), "data");
    await f.session.prompt(
      "LAUNCH " +
        JSON.stringify({
          assignment: "Partial assignment",
          profile: "general",
          background: true,
          limits: kind === "paused" ? { deadlineMs: 500 } : { requests: 2 },
        }),
    );
    if (kind === "paused") {
      await eventually(() => entered);
      await eventually(() => f.events.some((event) => event.child.status === "pausing"));
      release();
    }
    const notices = () =>
      f.session.messages.filter(
        (message) => message.role === "custom" && message.customType === "delegation",
      );
    await eventually(() => notices().length === 1);
    const message = notices()[0];
    assert.ok(message.role === "custom" && typeof message.content === "string");
    const [references] = message.content.split("\n");
    assert.match(references, /"status":"(paused|settled)","partial":true/);
    assert.match(message.content, kind === "paused" ? /"partialText"/ : /"result": "partial/);

    initTheme("dark", false);
    const renderer = f.session.extensionRunner.getMessageRenderer("delegation");
    const component = new CustomMessageComponent(message, renderer);
    const collapsed = component.render(200).join("\n");
    assert.match(
      collapsed,
      kind === "paused"
        ? /Partial: paused before a final answer · last text: partial .*findings/
        : /Partial: budget wrap-up report/,
    );
    assert.doesNotMatch(collapsed, /\u202e|\x1b\[31m/);
    component.setExpanded(true);
    const expanded = component.render(200).join("\n");
    assert.match(expanded, /Partial: /);
    assert.doesNotMatch(expanded, /\u202e|\x1b\[31m/);
    for (const width of [10, 40, 120])
      for (const expand of [false, true]) {
        component.setExpanded(expand);
        assert.ok(component.render(width).every((line) => visibleWidth(line) <= width));
      }
  });

test("a wrap-up-settled window resumes into a fresh window that settles without partial", async (t) => {
  let guidanceOnResume: string | undefined;
  const f = await fixture(t, {
    speed: 0,
    response: (context) => {
      if (userText(context) === "finish") {
        guidanceOnResume = guidance(context);
        return fauxAssistantMessage("finished normally");
      }
      if (guidance(context).includes("Delegation wrap-up"))
        return fauxAssistantMessage("wrap-up report");
      return fauxAssistantMessage(fauxToolCall("read", { path: "missing.txt" }), {
        stopReason: "toolUse",
      });
    },
  });
  const ref = await f.direct("long", "scout", { limits: { requests: 10, tools: 2 } });
  const wrapped = await f.coordinator.wait(ref);
  assert.equal(wrapped.status, "settled");
  assert.equal(wrapped.partial, true);

  await f.coordinator.resume(ref, "finish");
  const resumed = f.coordinator.snapshot(ref)!;
  assert.equal(resumed.window, 2);
  assert.equal(resumed.partial, undefined, "resume clears partial for the new window");
  assert.equal(resumed.partialText, undefined);
  const final = await f.coordinator.wait(ref);
  assert.equal(final.window, 2);
  assert.equal(final.status, "settled");
  assert.equal(final.result, "finished normally");
  assert.doesNotMatch(guidanceOnResume ?? "", /Delegation wrap-up/, "no new wrap-up");
  assert.equal(final.partial, undefined, "a normally finished resumed window is not partial");
  assert.equal(taskCard(final).length, 1);
  assert.equal(final.completedWindows?.[0]?.result, "wrap-up report");
});
