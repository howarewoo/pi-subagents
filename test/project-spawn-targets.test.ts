import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  fauxAssistantMessage,
  fauxToolCall,
  type FauxResponseFactory,
} from "@earendil-works/pi-ai";
import { resolveProfileCatalog, resolveProfile } from "../src/profiles.ts";
import { writeFileSync } from "node:fs";
import { fixture, eventually } from "./fixtures.ts";

const local = {
  description: "Independent local audit",
  prompt: "Exact trusted-project instructions",
  tools: ["read"],
  skills: [],
  spawn: [],
  coordination: [],
  ceiling: "scout",
};
const global = {
  projectRoleCeilings: ["scout"],
  projectSpawnTargets: { "release-audit": "scout" },
  general: { tools: ["read"], spawn: ["release-audit"] },
};
const project = { customProfiles: { "release-audit": local } };

test("exact registrations authorize references across projects, never profiles or automatic grants", () => {
  const missing = resolveProfileCatalog(global, {});
  assert.equal(missing.profiles.length, 4);
  assert.deepEqual(missing.profiles[0].spawn, ["release-audit"]);
  const present = resolveProfileCatalog(global, project);
  assert.equal(present.profiles.at(-1)!.projectCeiling, "scout");
  assert.equal(present.profiles.at(-1)!.projectSpawnAuthorized, true);
  assert.deepEqual(
    present.profiles[1].spawn,
    ["scout", "review"],
    "registration never adds parent grants",
  );
  const otherProject = resolveProfileCatalog(global, {
    customProfiles: {
      "release-audit": { ...local, prompt: "Different independent trusted-project content" },
    },
  });
  assert.equal(
    otherProject.profiles.at(-1)!.prompt,
    "Different independent trusted-project content",
  );
  const rootOnly = resolveProfileCatalog({ projectRoleCeilings: ["scout"] }, project).profiles.at(
    -1,
  )!;
  assert.equal(
    rootOnly.projectSpawnAuthorized,
    false,
    "root local resolution does not require incoming registration",
  );
  for (const registrations of [
    null,
    [],
    { "release-audit": "review" },
    { worker: "scout" },
    { general: "scout" },
    { constructor: "scout" },
    JSON.parse('{"__proto__":"scout"}'),
    { projectSpawnTargets: "scout" },
    { "bad/name": "scout" },
  ])
    assert.throws(() =>
      resolveProfileCatalog({ ...global, projectSpawnTargets: registrations }, {}),
    );
  assert.throws(
    () =>
      resolveProfileCatalog(
        { ...global, customProfiles: { "release-audit": { ...local, ceiling: undefined } } },
        {},
      ),
    /collides/,
  );
  assert.throws(
    () => resolveProfileCatalog(global, { projectSpawnTargets: {} }),
    /Unknown project/,
  );
  assert.throws(
    () =>
      resolveProfileCatalog(
        { ...global, projectRoleCeilings: ["scout", "review"] },
        { customProfiles: { "release-audit": { ...local, ceiling: "review" } } },
      ),
    /registered ceiling scout/,
  );
  assert.throws(
    () => resolveProfileCatalog({ ...global, projectSpawnTargets: {} }, project),
    /spawn grants/,
  );
  for (const internal of ["projectCeiling", "projectSpawnAuthorized", "inheritedModelCeiling"])
    assert.throws(
      () =>
        resolveProfileCatalog(global, {
          customProfiles: {
            "release-audit": {
              ...local,
              [internal]: internal === "projectSpawnAuthorized" ? true : "scout",
            },
          },
        }),
      /Unsupported profile field/,
    );
  assert.deepEqual(resolveProfileCatalog({}, {}).projectSpawnTargets, {});
});

function userText(context: Parameters<FauxResponseFactory>[0]) {
  const user = context.messages.filter((message) => message.role === "user").at(-1);
  return typeof user?.content === "string"
    ? user.content
    : (user?.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("") ?? "");
}
for (const tool of ["delegate_task", "subagent"]) {
  test(`${tool} launches a real nested registered local target and atomically rejects a later missing target`, async (t) => {
    const f = await fixture(t, {
      tools: "default",
      speed: 0,
      response: (context) => {
        const text = userText(context),
          last = context.messages.at(-1);
        if (last?.role === "user" && text.startsWith("CALL ")) {
          return fauxAssistantMessage(fauxToolCall(tool, JSON.parse(text.slice(5))), {
            stopReason: "toolUse",
          });
        }
        if (last?.role === "user" && text === "OWNER")
          return fauxAssistantMessage(
            fauxToolCall("delegate_task", { profile: "release-audit", assignment: "LOCAL" }),
            { stopReason: "toolUse" },
          );
        if (last?.role === "user" && text === "LOCAL")
          return fauxAssistantMessage(fauxToolCall("read", { path: "public.txt" }), {
            stopReason: "toolUse",
          });
        return fauxAssistantMessage("done");
      },
    });
    await mkdir(join(f.root, "operator"), { recursive: true });
    await mkdir(join(f.root, ".pi"));
    await writeFile(join(f.root, "operator", "delegation.json"), JSON.stringify(global));
    await writeFile(join(f.root, ".pi", "delegation.json"), JSON.stringify(project));
    await writeFile(join(f.root, "public.txt"), "registered-local-effect");
    const owner =
      tool === "subagent"
        ? { agent: "general", task: "OWNER", async: false }
        : { profile: "general", assignment: "OWNER" };
    await f.session.prompt("CALL " + JSON.stringify(owner));
    const child = f.events.findLast((event) => event.child.depth === 2)!.child;
    assert.equal(child.profile, "release-audit");
    assert.equal(child.status, "settled");
    const transcript = await readFile(child.transcript!, "utf8");
    assert.match(transcript, /Exact trusted-project instructions/);
    assert.match(transcript, /registered-local-effect/);
    assert.deepEqual(child.tools, ["read"]);
    await writeFile(join(f.root, ".pi", "delegation.json"), "{}");
    const count = new Set(f.events.map((event) => event.child.id)).size;
    const missing =
      tool === "subagent"
        ? { agent: "release-audit", task: "missing" }
        : { profile: "release-audit", assignment: "missing" };
    await f.session.prompt("CALL " + JSON.stringify({ tasks: [owner, missing] }));
    const result = f.session.messages.findLast(
      (message) => message.role === "toolResult" && message.toolName === tool,
    );
    assert.ok(result?.role === "toolResult" && result.isError);
    assert.equal(
      new Set(f.events.map((event) => event.child.id)).size,
      count,
      "invalid later item inserts no earlier owner",
    );
    await assert.rejects(
      resolveProfile("release-audit", f.root, true),
      /Unknown delegation profile/,
    );
    await writeFile(join(f.root, ".pi", "delegation.json"), JSON.stringify(project));
    await assert.rejects(
      resolveProfile("release-audit", f.root, false),
      /Unknown delegation profile/,
    );
  });
}

async function activeOwner(
  t: Parameters<typeof fixture>[0],
  config: unknown = global,
  respond?: FauxResponseFactory,
  onRead?: (path: string) => void | Promise<void>,
) {
  let release!: () => void,
    entered = false;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const f = await fixture(t, {
    speed: 0,
    response: (context, ...args) => {
      if (context.messages.at(-1)?.role === "user" && userText(context) === "OWNER")
        return fauxAssistantMessage(fauxToolCall("read", { path: "hold-owner.txt" }), {
          stopReason: "toolUse",
        });
      return respond?.(context, ...args) ?? fauxAssistantMessage("done");
    },
    extra(pi) {
      pi.on("tool_call", async (event) => {
        if (event.toolName !== "read") return;
        const path = String(event.input.path);
        if (path.endsWith("hold-owner.txt")) {
          entered = true;
          await held;
        } else await onRead?.(path);
      });
    },
  });
  await mkdir(join(f.root, "operator"), { recursive: true });
  await mkdir(join(f.root, ".pi"));
  await writeFile(join(f.root, "operator", "delegation.json"), JSON.stringify(config));
  await writeFile(join(f.root, ".pi", "delegation.json"), JSON.stringify(project));
  await writeFile(join(f.root, "hold-owner.txt"), "held owner");
  await writeFile(join(f.root, "protected.txt"), "protected payload");
  const parent = await f.direct("OWNER", "general");
  try {
    await eventually(() => entered);
  } catch (error) {
    release();
    throw error;
  }
  return {
    ...f,
    parent,
    release,
    operator: join(f.root, "operator", "delegation.json"),
    projectPath: join(f.root, ".pi", "delegation.json"),
  };
}

test("nested admission requires the originally admitted parent grant, current target and trust", async (t) => {
  const f = await activeOwner(t, {
    projectRoleCeilings: ["scout"],
    general: { tools: ["read"], spawn: ["scout"] },
  });
  try {
    await writeFile(f.operator, JSON.stringify(global));
    const { profile } = await resolveProfile("release-audit", f.root, true);
    const before = f.coordinator.list().map((state) => state.id);
    await assert.rejects(
      f.direct("LOCAL", "general", { profile, parent: f.parent }),
      /spawn.*denied|spawn.*grant.*denied/i,
    );
    assert.deepEqual(
      f.coordinator.list().map((state) => state.id),
      before,
      "new registration and parent grant cannot expand admitted rights",
    );
  } finally {
    f.release();
  }
  const current = await activeOwner(t);
  try {
    const { profile } = await resolveProfile("release-audit", current.root, true);
    const before = current.coordinator.list().length;
    const trust = t.mock.method(current.context, "isProjectTrusted", () => false);
    await assert.rejects(
      current.direct("LOCAL", "general", { profile, parent: current.parent }),
      /Unknown delegation profile/,
    );
    trust.mock.restore();
    await writeFile(current.projectPath, "{}");
    await assert.rejects(
      current.direct("LOCAL", "general", { profile, parent: current.parent }),
      /Unknown delegation profile/,
    );
    await writeFile(
      current.projectPath,
      JSON.stringify({ customProfiles: { "release-audit": { ...local, ceiling: "review" } } }),
    );
    await assert.rejects(
      current.direct("LOCAL", "general", { profile, parent: current.parent }),
      /authorized ceiling|registered ceiling/,
    );
    assert.equal(current.coordinator.list().length, before);
  } finally {
    current.release();
  }
});

for (const revoked of ["registry", "spawn", "ceiling", "binding"] as const) {
  test(`retained nested local resume rejects ${revoked} revocation without mutating its conversation`, async (t) => {
    const f = await activeOwner(t);
    try {
      const { profile } = await resolveProfile("release-audit", f.root, true);
      const child = await f.direct("LOCAL", "general", { profile, parent: f.parent });
      const done = await f.coordinator.wait(child);
      assert.equal(done.status, "settled");
      assert.equal(done.retainedContext, true);
      const messages = f.coordinator.messages(child);
      if (revoked === "registry")
        await writeFile(
          f.operator,
          JSON.stringify({
            ...global,
            projectSpawnTargets: {},
            general: { tools: ["read"], spawn: [] },
          }),
        );
      if (revoked === "spawn")
        await writeFile(
          f.operator,
          JSON.stringify({ ...global, general: { tools: ["read"], spawn: [] } }),
        );
      if (revoked === "ceiling")
        await writeFile(f.operator, JSON.stringify({ ...global, projectRoleCeilings: [] }));
      if (revoked === "binding") {
        await writeFile(
          f.operator,
          JSON.stringify({
            ...global,
            projectRoleCeilings: ["scout", "review"],
            projectSpawnTargets: { "release-audit": "review" },
          }),
        );
        await writeFile(
          f.projectPath,
          JSON.stringify({ customProfiles: { "release-audit": { ...local, ceiling: "review" } } }),
        );
      }
      await assert.rejects(
        f.coordinator.resume(child, "continue"),
        /registration|spawn.*revoked|allowlisted|binding changed/,
      );
      assert.deepEqual(f.coordinator.snapshot(child), done);
      assert.deepEqual(f.coordinator.messages(child), messages);
      if (revoked === "registry") {
        const root = await f.direct("ROOT-LOCAL", "general", {
          profile: (await resolveProfile("release-audit", f.root, true)).profile,
        });
        assert.equal(
          (await f.coordinator.wait(root)).status,
          "settled",
          "root launch is independent of incoming registration",
        );
      }
    } finally {
      f.release();
    }
  });
}

for (const boundary of ["tool", "next-model"] as const) {
  for (const revoked of ["registry", "spawn", "ceiling"] as const) {
    test(`live ${revoked} revocation denies the registered local ${boundary} boundary`, async (t) => {
      let operator = "",
        protectedReads = 0,
        localRequests = 0;
      const revoke = () =>
        writeFileSync(
          operator,
          JSON.stringify(
            revoked === "registry"
              ? { ...global, projectSpawnTargets: {}, general: { tools: ["read"], spawn: [] } }
              : revoked === "spawn"
                ? { ...global, general: { tools: ["read"], spawn: [] } }
                : { ...global, projectRoleCeilings: [] },
          ),
        );
      const f = await activeOwner(
        t,
        global,
        (context) => {
          if (userText(context) === "LOCAL") {
            localRequests++;
            if (boundary === "tool") revoke();
            return fauxAssistantMessage(fauxToolCall("read", { path: "protected.txt" }), {
              stopReason: "toolUse",
            });
          }
          return fauxAssistantMessage("done");
        },
        (path) => {
          if (path.endsWith("protected.txt")) {
            protectedReads++;
            if (boundary === "next-model") revoke();
          }
        },
      );
      operator = f.operator;
      try {
        const { profile } = await resolveProfile("release-audit", f.root, true);
        const child = await f.direct("LOCAL", "general", { profile, parent: f.parent });
        await eventually(() => !!f.coordinator.snapshot(child)?.disposed);
        const done = await f.coordinator.wait(child);
        assert.equal(done.status, "failed", JSON.stringify(done));
        assert.equal(localRequests, 1, "revocation denies the next physical dispatch");
        assert.equal(protectedReads, boundary === "tool" ? 0 : 1);
        assert.match(done.error ?? "", /registration|spawn|allowlisted/);
      } finally {
        f.release();
      }
    });
  }
}

test("current ancestor direct-edge revocation denies a registered local descendant before insertion", async (t) => {
  let releaseMiddle!: () => void,
    middleEntered = false;
  const middleGate = new Promise<void>((resolve) => {
    releaseMiddle = resolve;
  });
  const config = {
    ...global,
    general: { tools: ["read"], spawn: ["scout", "release-audit"] },
    scout: { tools: ["read"], spawn: ["release-audit"] },
  };
  const f = await activeOwner(
    t,
    config,
    (context) => {
      if (userText(context) === "MIDDLE" && context.messages.at(-1)?.role === "user")
        return fauxAssistantMessage(fauxToolCall("read", { path: "protected.txt" }), {
          stopReason: "toolUse",
        });
      return fauxAssistantMessage("done");
    },
    async (path) => {
      if (path.endsWith("protected.txt")) {
        middleEntered = true;
        await middleGate;
      }
    },
  );
  try {
    const middle = await f.direct("MIDDLE", "scout", { parent: f.parent });
    await eventually(() => middleEntered);
    await writeFile(
      f.operator,
      JSON.stringify({ ...config, general: { tools: ["read"], spawn: ["release-audit"] } }),
    );
    const count = f.coordinator.list().length;
    const { profile } = await resolveProfile("release-audit", f.root, true);
    await assert.rejects(
      f.direct("LOCAL", "general", { profile, parent: middle }),
      /ancestor.*spawn.*denied/i,
    );
    assert.equal(f.coordinator.list().length, count);
  } finally {
    releaseMiddle();
    f.release();
  }
});
