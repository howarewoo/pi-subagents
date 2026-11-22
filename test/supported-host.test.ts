import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { access, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

// Substitute only the SDK's public VERSION binding; all session, extension,
// validation and dispatch code remains the installed Pi implementation.
const boundary = globalThis as typeof globalThis & { setHostVersion: (version: unknown) => void };
registerHooks({
  load(url, context, nextLoad) {
    const result = nextLoad(url, context);
    if (url.endsWith("/@earendil-works/pi-coding-agent/dist/config.js")) {
      const source = String(result.source);
      const declaration = 'export const VERSION = pkg.version || "0.0.0";';
      assert.ok(source.includes(declaration));
      return {
        ...result,
        source: source.replace(
          declaration,
          'export let VERSION = pkg.version || "0.0.0"; globalThis.setHostVersion = (version) => { VERSION = version; };',
        ),
      };
    }
    return result;
  },
});
const { fixture } = await import("./fixtures.ts");
const { fauxAssistantMessage, fauxToolCall } = await import("@earendil-works/pi-ai");

test("stable Pi >=1.5.2 admits execution; unsupported hosts retain diagnostics and cleanup", async (t) => {
  let reads = 0;
  let childRequests = 0;
  boundary.setHostVersion("1.5.1");
  t.after(() => boundary.setHostVersion("1.5.2"));
  const f = await fixture(t, {
    tools: "default",
    extra: (pi) => {
      pi.on("tool_call", (event) => {
        if (event.toolName === "read") reads++;
      });
    },
    response: (context) => {
      const user = context.messages.findLast((message) => message.role === "user");
      const text =
        typeof user?.content === "string"
          ? user.content
          : (user?.content
              .filter((block) => block.type === "text")
              .map((block) => block.text)
              .join("") ?? "");
      if (context.messages.at(-1)?.role === "toolResult") return fauxAssistantMessage("ack");
      if (text.startsWith("CALL ")) {
        const { name, args } = JSON.parse(text.slice(5));
        return fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });
      }
      childRequests++;
      return fauxAssistantMessage("done");
    },
  });
  boundary.setHostVersion("1.5.2");
  const call = async (name: string, args: unknown) => {
    await f.session.prompt("CALL " + JSON.stringify({ name, args }));
    const result = f.session.messages.findLast(
      (message) => message.role === "toolResult" && message.toolName === name,
    );
    assert.ok(result?.role === "toolResult");
    return result;
  };
  await writeFile(join(f.root, "task.txt"), "do work");
  const stableVersions = [
    "1.5.2",
    "1.5.3",
    "1.6.0",
    "2.0.0",
    "1.5.10",
    "1.10.0",
    "10.0.0",
    "1.5.2+build.001",
    "2.0.0+build-1",
  ];
  let state!: { id: string; generation: number };
  for (const [index, version] of stableVersions.entries()) {
    boundary.setHostVersion(version);
    const priorEvents = f.events.length;
    const priorFiles = await readdir(f.root, { recursive: true });
    const supported = await call("delegate_task", {
      profile: "scout",
      taskFile: "task.txt",
      background: false,
    });
    assert.equal(supported.isError, false, JSON.stringify(supported));
    assert.equal(reads, index + 1);
    assert.equal(childRequests, reads);
    assert.ok(f.events.length > priorEvents, "actual child allocation and state changes");
    assert.notDeepEqual(await readdir(f.root, { recursive: true }), priorFiles);
    state = supported.details as { id: string; generation: number };
  }
  const before = await readdir(f.root, { recursive: true });
  const eventCount = f.events.length;
  const target = { id: state.id, generation: state.generation };
  try {
    for (const version of [
      "0.9.99",
      "1.4.99",
      "1.5.1",
      "1.5.1+build",
      "1.5.2-rc.1",
      "2.0.0-rc.1+build",
      "1.5",
      "1.5.2.0",
      "v1.5.2",
      "01.5.2",
      "1.05.2",
      "1.5.02",
      "1.5.2+",
      "1.5.2+build..1",
      "1.5.2+build_1",
      " 1.5.2",
      "1.5.2\n",
      "unknown",
      "",
      undefined,
      null,
      152,
    ]) {
      boundary.setHostVersion(version);
      for (const [name, args] of [
        ["delegate_task", { profile: "scout", taskFile: "task.txt" }],
        ["delegate_task", { tasks: [{ profile: "scout", taskFile: "task.txt" }] }],
        ["subagent", { agent: "scout", task: "no execution" }],
        ["subagent", { tasks: [{ agent: "scout", task: "no execution" }] }],
        ...["resume", "followup", "revive"].map(
          (action) =>
            ["delegate_coordinate", { action, target, assignment: "no execution" }] as const,
        ),
        ["subagent", { action: "resume", id: `${state.id}@1`, message: "no execution" }],
        ["subagent", { action: "steer", id: `${state.id}@1`, message: "no execution" }],
        ...["steer", "followUp"].map(
          (mode) =>
            [
              "delegate_coordinate",
              { action: "message", target, mode, text: "no execution" },
            ] as const,
        ),
      ] as const) {
        const result = await call(name, args);
        assert.equal(result.isError, true);
        assert.match(JSON.stringify(result), /supported.*1\.5\.2/i);
        assert.ok(
          JSON.stringify(result).includes(
            JSON.stringify(String(version || "unknown")).slice(1, -1),
          ),
        );
      }
      await assert.rejects(async () => f.coordinator.admit([]), /supported.*1\.5\.2/i);
      await assert.rejects(f.coordinator.start({} as never), /supported.*1\.5\.2/i);
      await assert.rejects(
        async () => f.coordinator.renew(target, {} as never),
        /supported.*1\.5\.2/i,
      );
      await assert.rejects(f.coordinator.resume(target, "continue"), /supported.*1\.5\.2/i);
      await assert.rejects(f.coordinator.steer(target, "continue"), /supported.*1\.5\.2/i);
      await assert.rejects(
        f.coordinator.message(undefined, target, "continue", "followUp"),
        /supported.*1\.5\.2/i,
      );
      assert.equal((await call("subagent", { action: "list" })).isError, false);
      assert.equal(
        (await call("delegate_coordinate", { action: "status", target })).isError,
        false,
      );
      assert.equal(reads, stableVersions.length, "no taskFile read dispatch");
      assert.equal(childRequests, stableVersions.length, "no child model requests");
      assert.equal(f.events.length, eventCount, "no child allocation or state changes");
      assert.deepEqual(
        await readdir(f.root, { recursive: true }),
        before,
        "no task directory setup",
      );
      await assert.rejects(access(join(f.root, "direct")), /ENOENT/);
    }
    assert.equal((await call("delegate_coordinate", { action: "stop", target })).isError, false);
    await f.coordinator.shutdown();
    await f.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
  } finally {
    boundary.setHostVersion("1.5.2");
  }
});
