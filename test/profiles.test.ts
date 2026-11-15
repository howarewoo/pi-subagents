import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveProfile } from "../src/profiles.ts";
import { parentModelRuntime } from "../src/model-adapter.ts";
import { fixture } from "./fixtures.ts";
import { ModelRegistry } from "@earendil-works/pi-coding-agent";

test("explicit profiles deny missing/unsupported/broadened grants; project can only narrow operator authority", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "delegation-profile-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const operator = join(root, "operator");
  const project = join(root, ".pi");
  await mkdir(operator);
  await mkdir(project);
  const resolve = (name = "general", trusted = true) =>
    resolveProfile(name, root, trusted, operator);
  assert.deepEqual((await resolve()).profile.tools, [
    "read",
    "grep",
    "find",
    "ls",
    "write",
    "edit",
    "bash",
  ]);
  await assert.rejects(resolve("unknown"), /Unknown/);
  for (const invalid of [
    { tools: ["unknown"] },
    { extensions: ["/evil.ts"] },
    { mcp: ["server"] },
    { model: "different" },
    { skills: ["relative.md"] },
  ]) {
    await writeFile(join(operator, "delegation.json"), JSON.stringify({ general: invalid }));
    await assert.rejects(resolve(), /broaden|Unsupported|mint/);
  }
  const skill = join(root, "SKILL.md");
  await writeFile(
    skill,
    "---\nname: selected\ndescription: Explicitly selected fixture skill\n---\nOnly selected content.",
  );
  await writeFile(
    join(operator, "delegation.json"),
    JSON.stringify({ general: { tools: ["read", "grep"], skills: [skill] } }),
  );
  await writeFile(
    join(project, "delegation.json"),
    JSON.stringify({
      general: { tools: ["read"], skills: [skill], prompt: "Project-specialized analysis" },
    }),
  );
  const selected = await resolve();
  assert.deepEqual(selected.profile.tools, ["read"]);
  assert.equal(selected.skills[0].filePath, skill);
  assert.equal(selected.profile.prompt, "Project-specialized analysis");
  await writeFile(
    join(project, "delegation.json"),
    JSON.stringify({ general: { tools: ["write"] } }),
  );
  await assert.rejects(resolve(), /broaden/);
  assert.deepEqual(
    (await resolve("general", false)).profile.tools,
    ["read", "grep"],
    "untrusted project config is not honored",
  );
  await writeFile(
    join(project, "delegation.json"),
    JSON.stringify({ general: { skills: [join(root, "ambient.md")] } }),
  );
  await assert.rejects(resolve(), /mint/);
  await writeFile(
    join(operator, "delegation.json"),
    JSON.stringify({ general: { skills: [join(root, "missing.md")] } }),
  );
  await assert.rejects(resolve("general", false), /ENOENT/);
});

test("public parent model adapter rejects missing model/provider/auth and scope without fallback", async (t) => {
  const { root, runtime, model } = await fixture(t);
  const registry = new ModelRegistry(runtime);
  const ctx = { model: model.getModel(), modelRegistry: registry, scopedModels: [] };
  await assert.rejects(
    parentModelRuntime({ ...ctx, model: undefined }, root),
    /selected parent model/,
  );
  await assert.rejects(
    parentModelRuntime({ ...ctx, model: { ...ctx.model, provider: "missing" } }, root),
    /no public provider/,
  );
  await assert.rejects(
    parentModelRuntime({ ...ctx, scopedModels: [{ model: { ...ctx.model, id: "other" } }] }, root),
    /outside/,
  );
  t.mock.method(registry, "hasConfiguredAuth", () => false);
  await assert.rejects(parentModelRuntime(ctx, root), /No configured parent authentication/);
});

test("only operator can mint recursive role grants; project may remove but never re-enable them", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "delegation-spawn-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const operator = join(root, "operator");
  const project = join(root, ".pi");
  await mkdir(operator);
  await mkdir(project);
  const resolve = () => resolveProfile("general", root, true, operator);
  for (const name of ["general", "scout", "review", "implementation"])
    assert.deepEqual((await resolveProfile(name, root, true, operator)).profile.spawn, [
      "scout",
      "review",
    ]);
  await writeFile(
    join(project, "delegation.json"),
    JSON.stringify({ general: { spawn: ["scout"] } }),
  );
  assert.deepEqual((await resolve()).profile.spawn, ["scout"]);
  await writeFile(
    join(operator, "delegation.json"),
    JSON.stringify({ general: { spawn: ["scout"] } }),
  );
  await writeFile(
    join(project, "delegation.json"),
    JSON.stringify({ general: { spawn: ["review"] } }),
  );
  await assert.rejects(resolve(), /mint spawn grants/);
  await writeFile(join(operator, "delegation.json"), JSON.stringify({ general: { spawn: [] } }));
  await writeFile(
    join(project, "delegation.json"),
    JSON.stringify({ general: { spawn: ["scout"] } }),
  );
  await assert.rejects(resolve(), /mint spawn grants/);
  await writeFile(
    join(project, "delegation.json"),
    JSON.stringify({ general: { spawn: ["general"] } }),
  );
  await assert.rejects(resolve(), /mint spawn grants/);
  await writeFile(
    join(operator, "delegation.json"),
    JSON.stringify({ general: { spawn: ["general"] } }),
  );
  assert.deepEqual((await resolve()).profile.spawn, ["general"]);
  await writeFile(join(project, "delegation.json"), JSON.stringify({ general: { spawn: [] } }));
  assert.deepEqual((await resolve()).profile.spawn, []);
  await writeFile(join(operator, "delegation.json"), JSON.stringify({ general: { spawn: [] } }));
  await writeFile(
    join(project, "delegation.json"),
    JSON.stringify({ general: { spawn: ["general"] } }),
  );
  await assert.rejects(resolve(), /mint spawn grants/);
});

test("restricted general leaf grants are operator-owned; project narrowing and renewal intersection cannot mint them", async (t) => {
  const { root } = await fixture(t, { speed: 0 });
  const operator = join(root, "operator");
  await mkdir(operator, { recursive: true });
  await mkdir(join(root, ".pi"));
  await writeFile(
    join(operator, "delegation.json"),
    JSON.stringify({ general: { leafTools: ["reviewed"] } }),
  );
  await writeFile(
    join(root, ".pi", "delegation.json"),
    JSON.stringify({ general: { leafTools: [] } }),
  );
  assert.deepEqual((await resolveProfile("general", root, true)).profile.leafTools, []);
  assert.deepEqual((await resolveProfile("general", root, false)).profile.leafTools, ["reviewed"]);
  await writeFile(
    join(root, ".pi", "delegation.json"),
    JSON.stringify({ general: { leafTools: ["other"] } }),
  );
  await assert.rejects(resolveProfile("general", root, true), /mint leaf/);
  await writeFile(
    join(operator, "delegation.json"),
    JSON.stringify({ scout: { leafTools: ["reviewed"] } }),
  );
  await assert.rejects(resolveProfile("scout", root, false), /mint leaf/);
  const { intersectProfileGrants } = await import("../src/profiles.ts");
  // Catalog validation rejects invalid sibling definitions too.
  await assert.rejects(resolveProfile("general", root, false), /mint leaf/);
  await writeFile(
    join(operator, "delegation.json"),
    JSON.stringify({ general: { leafTools: ["reviewed"] } }),
  );
  const profile = (await resolveProfile("general", root, false)).profile;
  assert.deepEqual(
    intersectProfileGrants({ ...profile, leafTools: ["new"] }, { ...profile, leafTools: [] })
      .leafTools,
    [],
  );
});
