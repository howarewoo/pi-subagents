import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { resolveProfileCatalog, resolveProfile, intersectProfileGrants } from "../src/profiles.ts";
import { allowsModel } from "../src/model-policy.ts";
import { fixture } from "./fixtures.ts";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";

const custom = {
  description: "Independent",
  prompt: "Explicit instructions",
  tools: ["read"],
  skills: [],
  spawn: [],
  coordination: [],
};
const a = { provider: "controlled", id: "a", effort: "off" as const };
const b = { ...a, id: "b" };
const c = { ...a, id: "c" };

test("catalog preserves raw layers, independent local content, narrowing and provenance", () => {
  const global = {
    customProfiles: { audit: custom },
    scout: { models: [a, b], model: a },
    projectRoleCeilings: ["scout"],
  };
  const project = {
    scout: { tools: ["read"], models: [b] },
    customProfiles: { audit: { prompt: "override" }, local: { ...custom, ceiling: "scout" } },
  };
  // An inherited bundled default excluded by narrowing remains invalid, as before.
  assert.throws(() => resolveProfileCatalog(global, project), /exact operator model grant/);
  delete (global.scout as { model?: unknown }).model;
  const result = resolveProfileCatalog(global, project);
  const local = result.profiles.find((p) => p.name === "local")!;
  assert.equal(local.prompt, custom.prompt);
  assert.equal(local.model, undefined);
  assert.equal(local.models, undefined, "authority does not mint explicit override grants");
  assert.equal(allowsModel(local, a), false);
  assert.equal(allowsModel(local, b), true);
  assert.equal(allowsModel(local, c), false);
  assert.deepEqual(result.provenance.local, {
    source: "project",
    globalOverride: false,
    projectOverride: false,
    ceiling: "scout",
  });
  assert.equal(result.provenance.audit.projectOverride, true);
  assert.deepEqual(local.spawn, []);
  assert.deepEqual(local.skills, []);
  assert.deepEqual(local.leafTools, []);
  const retained = intersectProfileGrants({ ...local, inheritedModelCeiling: [a, b] }, local);
  assert.equal(allowsModel(retained, a), false);
});

test("custom names, explicit fields, memberships, collisions and local authority fail closed", () => {
  for (const name of [
    "general",
    "worker",
    "constructor",
    "prototype",
    "__proto__",
    "customProfiles",
    "Bad",
    "x".repeat(65),
  ])
    assert.throws(
      () =>
        resolveProfileCatalog(
          JSON.parse(`{"customProfiles":{${JSON.stringify(name)}:${JSON.stringify(custom)}}}`),
          {},
        ),
      /name/,
    );
  assert.throws(
    () => resolveProfileCatalog({ customProfiles: { audit: { tools: [] } } }, {}),
    /explicit/,
  );
  assert.throws(
    () =>
      resolveProfileCatalog({ customProfiles: { audit: { ...custom, spawn: ["missing"] } } }, {}),
    /spawn/,
  );
  assert.throws(
    () => resolveProfileCatalog({}, { projectRoleCeilings: ["scout"] }),
    /Unknown project/,
  );
  const project = { customProfiles: { local: { ...custom, ceiling: "scout" } } };
  assert.throws(() => resolveProfileCatalog({}, project), /authorized ceiling/);
  assert.throws(
    () => resolveProfileCatalog({ projectRoleCeilings: ["local"] }, project),
    /global roles/,
  );
  assert.throws(
    () =>
      resolveProfileCatalog(
        { customProfiles: { local: custom }, projectRoleCeilings: ["scout"] },
        project,
      ),
    /Unsupported profile field: ceiling/,
  );
  for (const fields of [
    { tools: ["write"] },
    { skills: ["/ungranted"] },
    { spawn: ["implementation"] },
    { coordination: ["message"] },
    { leafTools: ["read"] },
    { models: [c] },
    { prewalk: b, models: [b] },
    { fallback: [b, a], models: [a, b] },
  ])
    assert.throws(() =>
      resolveProfileCatalog(
        { scout: { models: [a, b], fallback: [a, b] }, projectRoleCeilings: ["scout"] },
        { customProfiles: { local: { ...custom, ...fields, ceiling: "scout" } } },
      ),
    );
  const global = { scout: { models: [a, b], prewalk: a }, projectRoleCeilings: ["scout"] };
  const valid = resolveProfileCatalog(global, {
    customProfiles: { local: { ...custom, models: [b], ceiling: "scout" } },
  });
  assert.equal(
    valid.profiles.at(-1)!.prewalk,
    undefined,
    "no routing/content inheritance from ceiling",
  );
});

test("untrusted config is ignored and local inherited physical selection is checked at real admission", async (t) => {
  const f = await fixture(t);
  await mkdir(join(f.root, "operator"), { recursive: true });
  await mkdir(join(f.root, ".pi"), { recursive: true });
  await writeFile(
    join(f.root, "operator", "delegation.json"),
    JSON.stringify({ scout: { models: [a] }, projectRoleCeilings: ["scout"] }),
  );
  await writeFile(
    join(f.root, ".pi", "delegation.json"),
    JSON.stringify({ customProfiles: { local: { ...custom, ceiling: "scout" } } }),
  );
  await assert.rejects(resolveProfile("local", f.root, false), /Unknown/);
  const { profile } = await resolveProfile("local", f.root, true);
  const before = f.events.length;
  await assert.rejects(f.direct("denied", "general", { profile }), /Model selection denied/);
  assert.equal(f.events.length, before);
});

test("both native tools discover fresh custom roles and reject a later unknown batch before launch", async (t) => {
  const f = await fixture(t, {
    tools: "default",
    response: (context) => {
      const last = context.messages.at(-1);
      const text =
        last?.role === "user"
          ? typeof last.content === "string"
            ? last.content
            : last.content
                .filter((b) => b.type === "text")
                .map((b) => b.text)
                .join("")
          : "";
      if (text.startsWith("CALL ")) {
        const { tool, args } = JSON.parse(text.slice(5));
        return fauxAssistantMessage(fauxToolCall(tool, args), { stopReason: "toolUse" });
      }
      return fauxAssistantMessage("done");
    },
  });
  await mkdir(join(f.root, "operator"), { recursive: true });
  const configure = (customProfiles: unknown) =>
    writeFile(join(f.root, "operator", "delegation.json"), JSON.stringify({ customProfiles }));
  const call = async (tool: string, args: unknown) => {
    await f.session.prompt("CALL " + JSON.stringify({ tool, args }));
    const result = f.session.messages.findLast(
      (m) => m.role === "toolResult" && m.toolName === tool,
    );
    assert.ok(result?.role === "toolResult");
    return result;
  };
  await configure({ audit: custom });
  for (const tool of ["delegate_task", "subagent"]) {
    const args =
      tool === "subagent"
        ? { agent: "audit", task: "work", async: false }
        : { profile: "audit", assignment: "work" };
    const ok = await call(tool, args);
    assert.equal(ok.isError, false, JSON.stringify(ok));
    assert.equal((ok.details as { profile: string }).profile, "audit");
    const before = f.events.length;
    const bad = await call(tool, {
      tasks: [
        args,
        tool === "subagent"
          ? { agent: "unknown", task: "deny" }
          : { profile: "unknown", assignment: "deny" },
      ],
    });
    assert.equal(bad.isError, true);
    assert.equal(f.events.length, before);
  }
  await configure({ fresh: custom });
  const discovery = await call("subagent", { action: "agents" });
  assert.ok(
    (discovery.details as { agents: { name: string }[] }).agents.some((p) => p.name === "fresh"),
  );
  assert.ok(
    !(discovery.details as { agents: { name: string }[] }).agents.some((p) => p.name === "audit"),
  );
});

test("custom spawn names need explicit admitted grants and fresh policy keeps revocation effective", async (t) => {
  const f = await fixture(t, { speed: 1 });
  await mkdir(join(f.root, "operator"), { recursive: true });
  const path = join(f.root, "operator", "delegation.json");
  const configure = (spawn: string[]) =>
    writeFile(
      path,
      JSON.stringify({ customProfiles: { owner: { ...custom, spawn }, audit: custom } }),
    );
  await configure([]);
  const deniedParent = await f.direct("owner without grant", "owner");
  await assert.rejects(
    f.direct("child", "audit", { parent: deniedParent }),
    /spawn role denied|spawn grant denied/,
  );
  await configure(["audit"]);
  // Changing disk cannot expand the admitted parent's grants.
  await assert.rejects(
    f.direct("child", "audit", { parent: deniedParent }),
    /spawn role denied|spawn grant denied/,
  );
  const parent = await f.direct("owner with explicit grant", "owner");
  const child = await f.direct("child", "audit", { parent });
  assert.equal(f.coordinator.snapshot(child)!.profile, "audit");
  await configure([]);
  const before = f.coordinator.list().map((entry) => entry.id);
  await assert.rejects(
    f.direct("revoked child", "audit", { parent }),
    /spawn grant denied|spawn role denied/,
  );
  assert.deepEqual(
    f.coordinator.list().map((entry) => entry.id),
    before,
  );
});

test("local routing is independent, accepts authorized subsequences and fails closed on ceiling changes", () => {
  const project = {
    customProfiles: { local: { ...custom, ceiling: "scout", models: [a, c], fallback: [a, c] } },
  };
  const global = {
    scout: { models: [a, b, c], fallback: [a, b, c] },
    projectRoleCeilings: ["scout"],
  };
  assert.deepEqual(resolveProfileCatalog(global, project).profiles.at(-1)!.fallback, [a, c]);
  assert.throws(
    () => resolveProfileCatalog({ ...global, projectRoleCeilings: [] }, project),
    /authorized ceiling/,
  );
  assert.throws(
    () =>
      resolveProfileCatalog({ ...global, scout: { models: [a, b], fallback: [a, b] } }, project),
    /exceeds ceiling scout/,
  );
  assert.throws(
    () => resolveProfileCatalog(global, { ...project, scout: { fallback: false } }),
    /exceeds ceiling scout/,
  );
  const walk = {
    customProfiles: { local: { ...custom, ceiling: "scout", models: [a], prewalk: a } },
  };
  assert.deepEqual(
    resolveProfileCatalog(
      { scout: { models: [a], prewalk: a }, projectRoleCeilings: ["scout"] },
      walk,
    ).profiles.at(-1)!.prewalk,
    a,
  );
  assert.throws(
    () => resolveProfileCatalog({ scout: { models: [a] }, projectRoleCeilings: ["scout"] }, walk),
    /prewalk/,
  );
});

test("documented additive global/project examples resolve through the shared parser", async () => {
  const { readFile } = await import("node:fs/promises");
  const text = await readFile(new URL("../docs/delegation-contract.md", import.meta.url), "utf8");
  const section = text
    .split("### Custom definitions and project-role ceilings")[1]
    .split("## Capacity and bounded execution")[0];
  const examples = [...section.matchAll(/```json\n([\s\S]*?)\n```/g)].map((match) =>
    JSON.parse(match[1]),
  );
  assert.equal(examples.length, 2);
  const catalog = resolveProfileCatalog(examples[0], examples[1]);
  assert.equal(catalog.provenance["docs-audit"].projectOverride, true);
  assert.equal(catalog.provenance["release-audit"].ceiling, "scout");
  assert.deepEqual(catalog.profiles.find((profile) => profile.name === "release-audit")!.tools, [
    "read",
  ]);
  assert.deepEqual(catalog.profiles[0].spawn, ["scout", "review", "docs-audit", "release-audit"]);
  assert.deepEqual(catalog.projectSpawnTargets, { "release-audit": "scout" });
  assert.equal(
    catalog.profiles.find((profile) => profile.name === "release-audit")!.projectSpawnAuthorized,
    true,
  );
});
