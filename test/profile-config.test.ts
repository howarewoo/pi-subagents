import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  ProfileConfigDraft,
  ProfileConfigError,
  type ProfileDraftOptions,
} from "../src/profile-config.ts";
import { resolveProfile } from "../src/profiles.ts";
import { fixture } from "./fixtures.ts";

const role = {
  description: "Custom description",
  prompt: "Independent instructions",
  tools: ["read"],
  skills: [],
  spawn: [],
  coordination: [],
};
const json = (value: unknown) => JSON.stringify(value, null, 2) + "\n";
async function workspace(t: TestContext, global?: unknown, project?: unknown) {
  const root = await fs.mkdtemp(join(tmpdir(), "profile-config-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const globalPath = join(root, "operator", "delegation.json");
  const projectPath = join(root, ".pi", "delegation.json");
  for (const [path, value] of [
    [globalPath, global],
    [projectPath, project],
  ] as const) {
    if (value === undefined) continue;
    await fs.mkdir(dirname(path), { recursive: true });
    await fs.writeFile(path, json(value));
  }
  const options: ProfileDraftOptions = {
    cwd: root,
    operatorDir: dirname(globalPath),
    isProjectTrusted: () => true,
    coordinator: { profileUsage: () => [] },
  };
  return { root, globalPath, projectPath, options };
}
async function failure(operation: Promise<unknown>, stage: ProfileConfigError["stage"]) {
  try {
    await operation;
    assert.fail("expected failure");
  } catch (error) {
    assert.ok(error instanceof ProfileConfigError, String(error));
    assert.equal(error.stage, stage, error.message);
    return error;
  }
}
async function noTemps(path: string) {
  assert.ok(!(await fs.readdir(dirname(path))).some((name) => name.startsWith(".delegation-")));
}

test("opening, editing, previewing and discarding missing-file drafts never creates files", async (t) => {
  const f = await workspace(t);
  const draft = await ProfileConfigDraft.open("global", f.options);
  assert.equal(draft.dirty, false);
  assert.equal(draft.path, f.globalPath);
  draft.value.general = { prompt: "draft only" };
  assert.equal(draft.dirty, true);
  assert.equal((await draft.validate()).profiles[0].prompt, "draft only");
  assert.deepEqual(await fs.readdir(f.root), []);
  assert.deepEqual(draft.original, {});
});

test("save creates one private file, independently reads it back, and refreshes baselines", async (t) => {
  const f = await workspace(t);
  const draft = await ProfileConfigDraft.open("global", f.options);
  draft.value.customProfiles = { audit: role };
  draft.value.projectRoleCeilings = ["audit"];
  const saved = await draft.save();
  assert.equal(saved.path, f.globalPath);
  assert.equal(saved.catalog.provenance.audit.source, "global");
  assert.equal(draft.dirty, false);
  assert.deepEqual(JSON.parse(await fs.readFile(saved.path, "utf8")), draft.value);
  assert.equal((await fs.stat(saved.path)).mode & 0o777, 0o600);
  await assert.rejects(fs.stat(f.projectPath), /ENOENT/);
  await noTemps(saved.path);
  draft.value.general = { prompt: "second save" };
  await draft.save();
  assert.equal(draft.catalog.profiles[0].prompt, "second save");
});

test("project saves and reset preserve scheduling, unrelated values and existing file modes", async (t) => {
  const global = {
    scheduling: { concurrency: 5 },
    general: { tools: ["read", "write"] },
    customProfiles: { audit: role },
  };
  const project = {
    scheduling: { concurrency: 2 },
    general: { prompt: "local instructions", tools: [] },
    customProfiles: { audit: { description: "local description" } },
    review: { prompt: "unrelated" },
  };
  const f = await workspace(t, global, project);
  await fs.chmod(f.projectPath, 0o640);
  const before = await fs.readFile(f.globalPath, "utf8");
  const draft = await ProfileConfigDraft.open("project", f.options);
  draft.resetOverride("general");
  assert.throws(() => draft.deleteCustomRole("audit"), /reset an override/);
  draft.resetOverride("audit");
  const saved = await draft.save();
  assert.equal((await fs.stat(f.projectPath)).mode & 0o777, 0o640);
  assert.deepEqual(JSON.parse(await fs.readFile(f.projectPath, "utf8")), {
    scheduling: project.scheduling,
    customProfiles: {},
    review: project.review,
  });
  assert.equal(saved.catalog.profiles[0].prompt, draft.catalog.profiles[0].prompt);
  assert.deepEqual(saved.catalog.profiles[0].tools, ["read", "write"]);
  assert.equal(await fs.readFile(f.globalPath, "utf8"), before);
  assert.throws(() => draft.deleteCustomRole("general"), /reserved/);
  draft.value.scheduling = { concurrency: 1 };
  await failure(draft.save(), "validate");
  assert.deepEqual(
    JSON.parse(await fs.readFile(f.projectPath, "utf8")).scheduling,
    project.scheduling,
  );
});

test("untrusted projects are not read or writable, and trust changes require reopening", async (t) => {
  const f = await workspace(t, {}, {});
  await fs.writeFile(f.projectPath, "invalid project config");
  let trusted = false;
  f.options.isProjectTrusted = () => trusted;
  await failure(ProfileConfigDraft.open("project", f.options), "open");
  const draft = await ProfileConfigDraft.open("global", f.options);
  draft.value.general = { prompt: "operator change" };
  await draft.save();
  assert.equal(await fs.readFile(f.projectPath, "utf8"), "invalid project config");
  trusted = true;
  draft.value.general = { prompt: "stale trust" };
  await failure(draft.save(), "conflict");
  assert.equal(
    JSON.parse(await fs.readFile(f.globalPath, "utf8")).general.prompt,
    "operator change",
  );
});

test("malformed/unsupported input and symlink/nonregular files refuse drafts without replacement", async (t) => {
  for (const content of [
    "{broken",
    "[]",
    json({ unknown: {} }),
    json({ general: { unsupported: true } }),
    json({ scheduling: { unknown: 1 } }),
  ]) {
    const f = await workspace(t, {});
    await fs.writeFile(f.globalPath, content);
    const error = await failure(ProfileConfigDraft.open("global", f.options), "open");
    assert.match(error.message, /repair.*externally/);
    assert.equal(await fs.readFile(f.globalPath, "utf8"), content);
    await noTemps(f.globalPath);
  }
  const f = await workspace(t, {});
  const real = join(f.root, "actual.json");
  await fs.rename(f.globalPath, real);
  await fs.symlink(real, f.globalPath);
  await failure(ProfileConfigDraft.open("global", f.options), "open");
  assert.equal((await fs.lstat(f.globalPath)).isSymbolicLink(), true);
  assert.equal(await fs.readFile(real, "utf8"), json({}));
  await fs.unlink(f.globalPath);
  await fs.mkdir(f.globalPath);
  await failure(ProfileConfigDraft.open("global", f.options), "open");
});

test("candidate validation uses exact runtime skill files including grants hidden by project narrowing", async (t) => {
  const f = await workspace(t, {}, {});
  const valid = join(f.root, "SKILL.md");
  const invalid = join(f.root, "not-skill.md");
  await fs.writeFile(
    valid,
    "---\nname: fixture\ndescription: Explicit validation fixture\n---\nInstructions",
  );
  await fs.writeFile(invalid, "not skill metadata");
  const draft = await ProfileConfigDraft.open("global", f.options);
  for (const paths of [[join(f.root, "missing.md")], [invalid], [f.root], [valid, valid]]) {
    draft.value.general = { skills: paths };
    await failure(draft.save(), "validate");
    assert.equal(await fs.readFile(f.globalPath, "utf8"), json({}));
  }
  draft.value.general = { skills: [valid] };
  await draft.save();
  assert.equal(
    (await resolveProfile("general", f.root, true, dirname(f.globalPath))).skills[0].filePath,
    valid,
  );
  await fs.writeFile(f.projectPath, json({ general: { skills: [] } }));
  await fs.unlink(valid);
  const error = await failure(ProfileConfigDraft.open("project", f.options), "open");
  assert.match(error.message, /SKILL.md/);
});

test("global edits that invalidate current project policy block without cross-file repairs", async (t) => {
  const f = await workspace(
    t,
    { general: { tools: ["read", "write"] } },
    { general: { tools: ["write"] } },
  );
  const draft = await ProfileConfigDraft.open("global", f.options);
  const before = await fs.readFile(f.globalPath, "utf8");
  const project = await fs.readFile(f.projectPath, "utf8");
  draft.value.general = { tools: ["read"] };
  const error = await failure(draft.save(), "validate");
  assert.match(error.message, /No cross-file repair/);
  assert.ok(error.message.includes(f.projectPath));
  assert.equal(await fs.readFile(f.globalPath, "utf8"), before);
  assert.equal(await fs.readFile(f.projectPath, "utf8"), project);
  assert.equal(draft.dirty, true);
});

test("both layer baselines detect edits or missing-file creation before saving; draft survives", async (t) => {
  for (const destination of ["global", "project"] as const) {
    for (const changed of ["global", "project"] as const) {
      const f = await workspace(t);
      const draft = await ProfileConfigDraft.open(destination, f.options);
      draft.value.review = { prompt: "unsaved" };
      const path = changed === "global" ? f.globalPath : f.projectPath;
      await fs.mkdir(dirname(path), { recursive: true });
      await fs.writeFile(path, json({ scout: { prompt: "external" } }));
      const error = await failure(draft.save(), "conflict");
      assert.ok(error.message.includes(path));
      assert.equal(error.replacement, "not-attempted");
      assert.equal(draft.dirty, true);
      assert.equal(await fs.readFile(path, "utf8"), json({ scout: { prompt: "external" } }));
      const target = destination === "global" ? f.globalPath : f.projectPath;
      if (changed !== destination) await assert.rejects(fs.stat(target), /ENOENT/);
    }
  }
});

test("in-process competing target/authority saves serialize and reject stale baselines", async (t) => {
  for (const secondDestination of ["global", "project"] as const) {
    const f = await workspace(t, {}, {});
    const first = await ProfileConfigDraft.open("global", f.options);
    const second = await ProfileConfigDraft.open(secondDestination, f.options);
    first.value.general = { prompt: "first" };
    second.value.review = { prompt: "second" };
    const result = await Promise.allSettled([first.save(), second.save()]);
    assert.equal(result[0].status, "fulfilled");
    assert.equal(result[1].status, "rejected");
    if (result[1].status === "rejected") assert.equal(result[1].reason.stage, "conflict");
    assert.equal(second.dirty, true);
    assert.equal(JSON.parse(await fs.readFile(f.globalPath, "utf8")).general.prompt, "first");
    assert.equal(await fs.readFile(f.projectPath, "utf8"), json({}));
  }
});

test("atomic save presents a complete same-directory temp, preserves mode and cleans it", async (t) => {
  const f = await workspace(t, { general: { prompt: "old" } });
  await fs.chmod(f.globalPath, 0o640);
  const draft = await ProfileConfigDraft.open("global", f.options);
  draft.value.general = { prompt: "new".repeat(10000) };
  const rename = fs.rename;
  let count = 0;
  t.mock.method(fs, "rename", async (...args: Parameters<typeof fs.rename>) => {
    const [from, to] = args;
    count++;
    assert.equal(dirname(String(from)), dirname(String(to)));
    assert.equal(JSON.parse(await fs.readFile(String(to), "utf8")).general.prompt, "old");
    assert.deepEqual(JSON.parse(await fs.readFile(String(from), "utf8")), draft.value);
    assert.equal((await fs.stat(String(from))).mode & 0o777, 0o640);
    await rename(from, to);
  });
  await draft.save();
  assert.equal(count, 1);
  await noTemps(f.globalPath);
});

test("a non-target authority change during temp writing is detected before rename", async (t) => {
  const f = await workspace(t, {}, {});
  const draft = await ProfileConfigDraft.open("project", f.options);
  draft.value.review = { prompt: "draft" };
  const open = fs.open;
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    const handle = await open(...args);
    if (String(args[0]).endsWith(".tmp"))
      await fs.writeFile(f.globalPath, json({ review: { prompt: "external authority" } }));
    return handle;
  });
  await failure(draft.save(), "conflict");
  assert.equal(await fs.readFile(f.projectPath, "utf8"), json({}));
  await noTemps(f.projectPath);
});

test("write/rename permission failures retain drafts, report observed disk and clean temp", async (t) => {
  const f = await workspace(t, {});
  const draft = await ProfileConfigDraft.open("global", f.options);
  draft.value.review = { prompt: "draft" };
  t.mock.method(fs, "rename", async () => {
    throw Object.assign(new Error("permission denied"), { code: "EACCES" });
  });
  const error = await failure(draft.save(), "write");
  assert.equal(error.replacement, "unknown", "no success claim after failed replacement attempt");
  assert.deepEqual(error.observed?.global, { path: f.globalPath, content: json({}) });
  assert.match(error.message, /permission denied/);
  assert.equal(draft.dirty, true);
  await noTemps(f.globalPath);
});

test("post-write changes/readback failures report completed replacement and never rollback disk", async (t) => {
  for (const changed of ["target", "authority"] as const) {
    await t.test(changed, async (t) => {
      const f = await workspace(t, {}, {});
      const draft = await ProfileConfigDraft.open("project", f.options);
      draft.value.review = { prompt: "draft" };
      const rename = fs.rename;
      t.mock.method(fs, "rename", async (...args: Parameters<typeof fs.rename>) => {
        await rename(...args);
        await fs.writeFile(
          changed === "target" ? f.projectPath : f.globalPath,
          json({ review: { prompt: "external" } }),
        );
      });
      const error = await failure(draft.save(), "verify");
      assert.equal(error.replacement, "completed");
      assert.deepEqual(error.observed?.project, {
        path: f.projectPath,
        content: json(changed === "target" ? { review: { prompt: "external" } } : draft.value),
      });
      assert.deepEqual(error.observed?.global, {
        path: f.globalPath,
        content: json(changed === "authority" ? { review: { prompt: "external" } } : {}),
      });
      assert.equal(draft.dirty, true);
      assert.deepEqual(draft.original, {});
      assert.equal(
        JSON.parse(await fs.readFile(changed === "target" ? f.projectPath : f.globalPath, "utf8"))
          .review.prompt,
        "external",
      );
      await noTemps(f.projectPath);
    });
  }
});

test("deletion exposes spawn/override/authorization/ceiling blockers and never rewrites references", async (t) => {
  const global = {
    customProfiles: { audit: role, owner: { ...role, spawn: ["audit"] } },
    projectRoleCeilings: ["audit"],
  };
  const project = {
    customProfiles: {
      audit: { description: "local override" },
      local: { ...role, ceiling: "audit" },
    },
  };
  const f = await workspace(t, global, project);
  const draft = await ProfileConfigDraft.open("global", f.options);
  draft.deleteCustomRole("audit");
  const error = await failure(draft.save(), "validate");
  assert.equal(error.blockers.length, 4);
  for (const reason of [/Spawn/, /Operator/, /Local definition/, /Project entry/])
    assert.ok(error.blockers.some((blocker) => reason.test(blocker.reason)));
  assert.equal(await fs.readFile(f.globalPath, "utf8"), json(global));
  assert.equal(await fs.readFile(f.projectPath, "utf8"), json(project));
  // Explicitly staging reference removal in the same file does not cascade to the other file.
  draft.value.projectRoleCeilings = [];
  (draft.value.customProfiles as Record<string, unknown>).owner = role;
  assert.equal(draft.deletionBlockers().length, 2);
});

test("safe deletion can stage same-file reference removal; project-local deletion is independent", async (t) => {
  const f = await workspace(
    t,
    {
      customProfiles: { audit: role, owner: { ...role, spawn: ["audit"] } },
      projectRoleCeilings: ["audit", "scout"],
    },
    { customProfiles: { local: { ...role, ceiling: "scout" } } },
  );
  const draft = await ProfileConfigDraft.open("global", f.options);
  assert.throws(() => draft.resetOverride("audit"), /not an independent/);
  draft.deleteCustomRole("audit");
  draft.value.projectRoleCeilings = ["scout"];
  (draft.value.customProfiles as Record<string, unknown>).owner = role;
  await draft.save();
  assert.ok(!draft.catalog.profiles.some((profile) => profile.name === "audit"));
  const local = await ProfileConfigDraft.open("project", f.options);
  assert.throws(() => local.resetOverride("local"), /independent/);
  local.deleteCustomRole("local");
  await local.save();
  assert.ok(!local.catalog.profiles.some((profile) => profile.name === "local"));
});

test("local registry blocks retained/current task usage, ignores superseded history only after retirement", async (t) => {
  const f = await fixture(t, { speed: 0 });
  const path = join(f.root, "operator", "delegation.json");
  await fs.mkdir(dirname(path), { recursive: true });
  await fs.writeFile(path, json({ customProfiles: { audit: role } }));
  const first = await f.direct("first", "audit");
  await f.coordinator.wait(first);
  const draft = await ProfileConfigDraft.open("global", {
    cwd: f.root,
    isProjectTrusted: () => true,
    operatorDir: dirname(path),
    coordinator: f.coordinator,
  });
  draft.deleteCustomRole("audit");
  const before = f.coordinator.snapshot(first);
  const error = await failure(draft.save(), "validate");
  assert.ok(error.blockers.some((b) => b.location === `${first.id}@1`));
  assert.deepEqual(
    f.coordinator.snapshot(first),
    before,
    "deletion checks never mutate task history",
  );
  const { profile, skills } = await resolveProfile("audit", f.root, false, dirname(path));
  const second = await f.coordinator.renew(first, {
    profile,
    skills,
    context: f.context,
    callerId: "profile-test",
    assertTools: () => {},
    assignment: "new generation",
  });
  await f.coordinator.wait(second);
  assert.equal(f.coordinator.sessions().length, 2);
  assert.equal(f.coordinator.profileUsage("audit").length, 1);
  assert.equal(f.coordinator.profileUsage("audit")[0].generation, 2);
  assert.equal(draft.deletionBlockers().length, 1);
  await f.coordinator.stop(second);
  assert.equal(f.coordinator.profileUsage("audit").length, 0);
  assert.equal(
    f.coordinator.sessions()[0].retainedContext,
    true,
    "immutable superseded snapshot is not resumable",
  );
  await draft.save();
  assert.equal(f.coordinator.sessions().length, 2);
});

test("descendant role usage blocks deletion until original subtree has drained and retired", async (t) => {
  const f = await fixture(t, { speed: 1 });
  const path = join(f.root, "operator", "delegation.json");
  await fs.mkdir(dirname(path), { recursive: true });
  await fs.writeFile(
    path,
    json({ customProfiles: { owner: { ...role, spawn: ["audit"] }, audit: role } }),
  );
  const parent = await f.direct("owner", "owner");
  const child = await f.direct("child", "audit", { parent });
  assert.equal(f.coordinator.profileUsage("audit")[0].id, child.id);
  const draft = await ProfileConfigDraft.open("global", {
    cwd: f.root,
    isProjectTrusted: () => true,
    operatorDir: dirname(path),
    coordinator: f.coordinator,
  });
  draft.deleteCustomRole("audit");
  (draft.value.customProfiles as Record<string, unknown>).owner = role;
  assert.ok(
    draft
      .deletionBlockers()
      .some((blocker) => blocker.location === `${child.id}@${child.generation}`),
  );
  await f.coordinator.stop(parent);
  assert.equal(f.coordinator.profileUsage("audit").length, 0);
  await draft.save();
});

test("preview also detects stale authority and metadata-only changes instead of showing stale validation", async (t) => {
  const f = await workspace(t, {}, {});
  const draft = await ProfileConfigDraft.open("project", f.options);
  await fs.chmod(f.globalPath, 0o640);
  await failure(draft.validate(), "conflict");
  assert.equal(await fs.readFile(f.projectPath, "utf8"), json({}));
});

test("a target replaced by a symlink after opening is never replaced or followed on save", async (t) => {
  const f = await workspace(t, {});
  const draft = await ProfileConfigDraft.open("global", f.options);
  draft.value.review = { prompt: "unsaved" };
  const target = join(f.root, "real.json");
  await fs.rename(f.globalPath, target);
  await fs.symlink(target, f.globalPath);
  const error = await failure(draft.save(), "conflict");
  assert.match(error.message, /symlink/);
  assert.equal(error.replacement, "not-attempted");
  assert.equal((await fs.lstat(f.globalPath)).isSymbolicLink(), true);
  assert.equal(await fs.readFile(target, "utf8"), json({}));
});

test("failed temp creation does not delete an unowned path or replace the target", async (t) => {
  const f = await workspace(t, {});
  const draft = await ProfileConfigDraft.open("global", f.options);
  draft.value.review = { prompt: "unsaved" };
  const open = fs.open;
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    if (String(args[0]).endsWith(".tmp")) {
      await fs.writeFile(String(args[0]), "unowned existing file");
      throw Object.assign(new Error("existing temporary path"), { code: "EEXIST" });
    }
    return open(...args);
  });
  const error = await failure(draft.save(), "write");
  assert.equal(error.replacement, "not-attempted");
  assert.equal(await fs.readFile(f.globalPath, "utf8"), json({}));
  const name = (await fs.readdir(dirname(f.globalPath))).find((name) => name.endsWith(".tmp"))!;
  assert.equal(
    await fs.readFile(join(dirname(f.globalPath), name), "utf8"),
    "unowned existing file",
  );
});

test("a task reference appearing during temp writing prevents deletion at the final boundary", async (t) => {
  const f = await workspace(t, { customProfiles: { audit: role } });
  let blocked = false;
  f.options.coordinator.profileUsage = () =>
    blocked
      ? [
          { id: "new-task", generation: 1, status: "running", profile: "audit" } as ReturnType<
            typeof f.options.coordinator.profileUsage
          >[number],
        ]
      : [];
  const draft = await ProfileConfigDraft.open("global", f.options);
  draft.deleteCustomRole("audit");
  const open = fs.open;
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    const result = await open(...args);
    if (String(args[0]).endsWith(".tmp")) blocked = true;
    return result;
  });
  const error = await failure(draft.save(), "validate");
  assert.equal(error.blockers[0].location, "new-task@1");
  assert.deepEqual(JSON.parse(await fs.readFile(f.globalPath, "utf8")).customProfiles.audit, role);
  await noTemps(f.globalPath);
});

test("post-write skill invalidation fails readback verification without restoring earlier config", async (t) => {
  const f = await workspace(t, {});
  const skill = join(f.root, "SKILL.md");
  await fs.writeFile(
    skill,
    "---\nname: fixture\ndescription: Fixture instructions\n---\nExplicit content",
  );
  const draft = await ProfileConfigDraft.open("global", f.options);
  draft.value.general = { skills: [skill] };
  const rename = fs.rename;
  t.mock.method(fs, "rename", async (...args: Parameters<typeof fs.rename>) => {
    await rename(...args);
    await fs.unlink(skill);
  });
  const error = await failure(draft.save(), "verify");
  assert.equal(error.replacement, "completed");
  assert.match(error.message, /SKILL.md/);
  assert.deepEqual(JSON.parse(await fs.readFile(f.globalPath, "utf8")), draft.value);
  assert.equal(draft.dirty, true);
});

test("registration-only saves preserve unrelated values and conflict against either authority layer", async (t) => {
  const global = {
    scheduling: { concurrency: 2 },
    projectRoleCeilings: ["scout"],
    review: { description: "untouched" },
  };
  const f = await workspace(t, global, {});
  const draft = await ProfileConfigDraft.open("global", f.options);
  draft.value.projectSpawnTargets = { "release-audit": "scout" };
  const saved = await draft.save();
  assert.deepEqual(saved.catalog.projectSpawnTargets, { "release-audit": "scout" });
  assert.equal(
    saved.catalog.profiles.length,
    4,
    "registration never persists/discovers placeholder profiles",
  );
  assert.deepEqual(JSON.parse(await fs.readFile(f.globalPath, "utf8")), {
    ...global,
    projectSpawnTargets: { "release-audit": "scout" },
  });
  assert.equal(await fs.readFile(f.projectPath, "utf8"), json({}));
  const stale = await ProfileConfigDraft.open("global", f.options);
  stale.value.projectSpawnTargets = {};
  await fs.writeFile(f.projectPath, json({ scout: { prompt: "external project change" } }));
  await failure(stale.save(), "conflict");
  assert.equal(stale.dirty, true);
  assert.deepEqual(JSON.parse(await fs.readFile(f.globalPath, "utf8")).projectSpawnTargets, {
    "release-audit": "scout",
  });
  const project = await ProfileConfigDraft.open("project", f.options);
  project.value.projectSpawnTargets = {};
  await failure(project.save(), "validate");
});

test("registered local deletion requires explicit global spawn/registration repair before one-file local removal", async (t) => {
  const global = {
    projectRoleCeilings: ["scout"],
    projectSpawnTargets: { "release-audit": "scout" },
    general: { spawn: ["release-audit"] },
  };
  const project = { customProfiles: { "release-audit": { ...role, ceiling: "scout" } } };
  const f = await workspace(t, global, project);
  const local = await ProfileConfigDraft.open("project", f.options);
  local.deleteCustomRole("release-audit");
  const blocked = await failure(local.save(), "validate");
  assert.ok(
    blocked.blockers.some((blocker) => /Incoming target registration/.test(blocker.reason)),
  );
  assert.ok(blocked.blockers.some((blocker) => /Spawn grant/.test(blocker.reason)));
  assert.equal(await fs.readFile(f.projectPath, "utf8"), json(project));
  const authority = await ProfileConfigDraft.open("global", f.options);
  authority.value.projectSpawnTargets = {};
  await failure(authority.save(), "validate");
  assert.deepEqual(
    (authority.value.general as { spawn: string[] }).spawn,
    ["release-audit"],
    "no implicit cascade",
  );
  authority.value.general = { spawn: [] };
  await authority.save();
  await failure(local.save(), "conflict");
  const fresh = await ProfileConfigDraft.open("project", f.options);
  fresh.deleteCustomRole("release-audit");
  await fresh.save();
  assert.equal(fresh.catalog.profiles.length, 4);
});

test("custom ceiling deletion exposes registration references and succeeds only after explicit same-file repairs", async (t) => {
  const global = {
    customProfiles: { authority: role },
    projectRoleCeilings: ["authority"],
    projectSpawnTargets: { "release-audit": "authority" },
    general: { spawn: ["release-audit"] },
  };
  const f = await workspace(t, global, {});
  const draft = await ProfileConfigDraft.open("global", f.options);
  draft.deleteCustomRole("authority");
  const error = await failure(draft.save(), "validate");
  assert.ok(
    error.blockers.some((blocker) => /registration still uses this ceiling/.test(blocker.reason)),
  );
  draft.value.projectRoleCeilings = [];
  draft.value.projectSpawnTargets = {};
  await failure(draft.save(), "validate");
  draft.value.general = { spawn: [] };
  await draft.save();
  assert.equal(draft.catalog.profiles.length, 4);
});
