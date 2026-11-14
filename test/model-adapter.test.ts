import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fixture } from "./fixtures.ts";

test("actual SDK child calls effective configured parent provider with public auth, headers and exact model; no key artifacts", async (t) => {
  const { root, runtime, model, launch, events } = await fixture(t);
  const seen: { key?: string; header?: string | null; model: string }[] = [];
  const base = model.provider;
  runtime.registerNativeProvider({
    ...base,
    auth: {
      apiKey: {
        name: "controlled auth",
        resolve: async ({ credential }) =>
          credential?.type === "api_key" && credential.key
            ? {
                auth: {
                  apiKey: credential.key,
                  headers: { "x-controlled-auth": "header-sentinel" },
                },
              }
            : undefined,
      },
    },
    streamSimple: (selected, context, options) => {
      seen.push({
        key: options?.apiKey,
        header: options?.headers?.["x-controlled-auth"],
        model: selected.id,
      });
      return base.streamSimple(selected, context, options);
    },
  });
  await runtime.setRuntimeApiKey(base.id, "credential-sentinel-never-persist");
  const ref = await launch("authenticated child", "general", false);
  assert.equal(seen.length, 3, "parent task request, child request, parent continuation");
  assert.ok(
    seen.every(
      (call) =>
        call.key === "credential-sentinel-never-persist" &&
        call.header === "header-sentinel" &&
        call.model === model.getModel().id,
    ),
  );
  const state = events.filter((event) => event.child.id === ref.id).at(-1)!.child;
  assert.equal(state.status, "settled");
  assert.equal(state.telemetry.requests, 1, "child direct requests only, not parent/subtree");
  const disk = await readFile(state.transcript!, "utf8");
  assert.ok(!disk.includes("credential-sentinel"));
  assert.ok(!disk.includes("header-sentinel"));
  const agent = join(root, "parent", "delegation", state.parentId, state.id, "agent");
  const files = await readdir(agent);
  assert.ok(!files.some((file) => /auth|credential/.test(file)));
});

test("selected skills are explicit and project/ambient executable resources cannot mint grants before launch", async (t) => {
  const { root, launch, events, session } = await fixture(t);
  const operator = join(root, "operator");
  await mkdir(operator);
  const skill = join(root, "SKILL.md");
  await writeFile(
    skill,
    "---\nname: selected\ndescription: ONLY_SELECTED_SKILL_DESCRIPTION\n---\nUse read to inspect evidence.",
  );
  await writeFile(
    join(operator, "delegation.json"),
    JSON.stringify({ general: { skills: [skill] } }),
  );
  const ref = await launch("selected resource", "general", false);
  const state = events.filter((event) => event.child.id === ref.id).at(-1)!.child;
  assert.match(await readFile(state.transcript!, "utf8"), /ONLY_SELECTED_SKILL_DESCRIPTION/);
  await writeFile(
    join(operator, "delegation.json"),
    JSON.stringify({ general: { extensions: ["/must-not-execute.ts"] } }),
  );
  const before = events.length;
  await assert.rejects(launch("forbidden extension"), /Unsupported profile field/);
  assert.equal(
    events.length,
    before,
    "forbidden grants fail before any registry setup or SDK creation",
  );
  assert.equal(
    session.messages.filter(
      (message) => message.role === "toolResult" && message.toolName === "delegate_task",
    ).length,
    2,
  );
});

test("public registry dispatch gate does not charge a physical attempt when request-time auth fails", async (t) => {
  const fx = await fixture(t);
  const captured = await fx.direct("capture adapter context");
  await fx.coordinator.wait(captured);
  let configured = true;
  let dispatched = 0;
  let charged = 0;
  const base = fx.model.provider;
  fx.runtime.registerNativeProvider({
    ...base,
    auth: {
      apiKey: {
        name: "controlled",
        resolve: async () => (configured ? { auth: { apiKey: "ephemeral-sentinel" } } : undefined),
      },
    },
    streamSimple: (model, context, options) => {
      dispatched++;
      return base.streamSimple(model, context, options);
    },
  });
  await fx.runtime.setRuntimeApiKey(base.id, "configured-sentinel");
  const { parentModelRuntime } = await import("../src/model-adapter.ts");
  const runtime = await parentModelRuntime(fx.context, join(fx.root, "adapter"), () => {
    charged++;
  });
  configured = false;
  const message = await runtime
    .streamSimple(fx.model.getModel(), {
      messages: [{ role: "user", content: "must not dispatch", timestamp: Date.now() }],
    })
    .result();
  assert.equal(message.stopReason, "error");
  assert.equal(dispatched, 0);
  assert.equal(charged, 0);
});
