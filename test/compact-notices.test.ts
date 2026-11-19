import test from "node:test";
import assert from "node:assert/strict";
import { CustomMessageComponent, convertToLlm, initTheme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { fixture, eventually } from "./fixtures.ts";
import type { ChildSnapshot } from "../src/coordinator.ts";

for (const batch of [false, true])
  test(`compact ${batch ? "batch" : "single"} notices use Pi's registered renderer without changing payload or delivery`, async (t) => {
    const f = await fixture(t, { speed: 0 });
    const tasks = ["First assignment", "Failed assignment"].map((assignment, index) => ({
      assignment,
      profile: "general",
      ...(index ? { resultSchema: { type: "integer" } } : {}),
    }));
    await f.session.prompt(
      "LAUNCH " + JSON.stringify({ ...(batch ? { tasks } : tasks[0]), background: true }),
    );
    const notices = () =>
      f.session.messages.filter(
        (message) => message.role === "custom" && message.customType === "delegation",
      );
    await eventually(() => notices().length === 1);
    const message = notices()[0];
    assert.ok(message.role === "custom");
    const calls = f.model.state.callCount;
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(f.model.state.callCount, calls, "native background notice does not wake parent");
    assert.equal(notices().length, 1, "one notice for the whole batch");

    const states = tasks
      .slice(0, batch ? 2 : 1)
      .map(
        (task) =>
          f.events.filter((event) => event.child.assignment === task.assignment).at(-1)!.child,
      );
    const references = states.map((state) => ({
      id: state.id,
      generation: state.generation,
      status: state.status,
      transcript: state.transcript,
      artifacts: state.artifacts,
    }));
    assert.equal(
      message.content,
      `References: ${JSON.stringify(references)}\n${JSON.stringify(batch ? states : states[0], null, 2)}`,
      "model-facing preview stays byte-for-byte unchanged",
    );
    assert.deepEqual(
      convertToLlm([message]),
      convertToLlm([{ ...message, details: undefined }]),
      "rendering metadata never enters model context",
    );
    initTheme("dark", false);
    const renderer = f.session.extensionRunner.getMessageRenderer("delegation");
    assert.ok(renderer, "renderer registered through the actual extension API");
    const component = new CustomMessageComponent(message, renderer);
    const collapsed = component.render(120).join("\n");
    assert.match(collapsed, /First assignment · general #1 · settled/);
    assert.doesNotMatch(collapsed, /References:|"assignment"|Identity |Result:/);
    if (batch) {
      assert.match(collapsed, /Failed assignment · general #1 · failed/);
      assert.match(collapsed, /Error:.*not submitted/);
      assert.ok(collapsed.indexOf("First assignment") < collapsed.indexOf("Failed assignment"));
    }
    for (const width of [10, 40, 120])
      assert.ok(component.render(width).every((line) => visibleWidth(line) <= width));
    component.setExpanded(true);
    const expanded = component.render(180).join("\n");
    assert.match(expanded, /Identity /);
    assert.match(expanded, /Assignment: First assignment/);
    assert.match(expanded, /Result: Controlled response: First assignment/);
    assert.match(expanded, /Full transcript:/);
    component.setExpanded(false);
    assert.equal(component.render(120).join("\n"), collapsed);

    const historical = new CustomMessageComponent({ ...message, details: undefined }, renderer);
    assert.match(historical.render(180).join("\n"), /References:/);
    assert.match(historical.render(180).join("\n"), /First assignment/);
    const malformed = new CustomMessageComponent(
      { ...message, details: { taskNotice: { collapsed: [42], expanded: [] } } },
      renderer,
    );
    assert.match(malformed.render(180).join("\n"), /References:/);

    const before = f.model.state.callCount;
    await f.session.prompt("/subagent-profiles");
    await f.session.prompt("/subagent-hub");
    assert.equal(f.model.state.callCount, before, "explicit commands do not infer");
    const profile = notices().at(-2)!;
    const status = notices().at(-1)!;
    assert.ok(profile.role === "custom" && status.role === "custom");
    assert.equal(profile.details, undefined);
    assert.match(new CustomMessageComponent(profile, renderer).render(180).join("\n"), /profiles/);
    assert.match(
      new CustomMessageComponent(status, renderer).render(180).join("\n"),
      /First assignment · general #1 · settled/,
    );
    // RPC consumers retain the readable content even when TUI metadata is available.
    assert.match(String(status.content), /References:/);
    assert.deepEqual(
      (JSON.parse(String(status.content).split("\n").slice(1).join("\n")) as ChildSnapshot[]).map(
        (state) => state.assignment,
      ),
      states.map((state) => state.assignment),
    );
  });
