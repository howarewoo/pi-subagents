import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  ProfileAutosaveController,
  type ProfileAutosaveOptions,
  type ProfileIntent,
} from "../src/profile-autosave.ts";
import type { ModelSelection } from "../src/model-policy.ts";
import { ProfileConfigDraft } from "../src/profile-config.ts";

const a: ModelSelection = { provider: "fixture", id: "a", effort: "off" };
const b: ModelSelection = { provider: "fixture", id: "b", effort: "high" };
const text = (profile: string, value: string): ProfileIntent => ({
  destination: "global",
  profile,
  field: "prompt",
  action: "set",
  value,
});
const route = (
  action: "add" | "switch-from-prewalk" | "remove",
  target: ModelSelection,
): ProfileIntent => ({
  destination: "global",
  profile: "general",
  field: "fallback",
  action,
  target,
});
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function workspace(t: TestContext, global: unknown = {}, project: unknown = {}) {
  const root = await fs.mkdtemp(join(tmpdir(), "profile-autosave-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const globalPath = join(root, "operator", "delegation.json");
  const projectPath = join(root, ".pi", "delegation.json");
  for (const [path, value] of [
    [globalPath, global],
    [projectPath, project],
  ] as const) {
    await fs.mkdir(dirname(path), { recursive: true });
    await fs.writeFile(path, JSON.stringify(value));
  }
  let trusted = true;
  const checked: ModelSelection[] = [];
  const options: ProfileAutosaveOptions = {
    cwd: root,
    operatorDir: dirname(globalPath),
    isProjectTrusted: () => trusted,
    coordinator: { profileUsage: () => [] },
    checkSelection: (target) => {
      checked.push(target);
    },
  };
  const controller = await ProfileAutosaveController.open("global", options);
  return {
    controller,
    options,
    globalPath,
    projectPath,
    checked,
    trust(value: boolean) {
      trusted = value;
    },
    disk: async () => JSON.parse(await fs.readFile(globalPath, "utf8")),
  };
}

test("FIFO persists each semantic action independently, projects dependent Add/move, attributes original profile", async (t) => {
  const f = await workspace(t, { general: { models: [a], fallback: [a] } });
  const entered = deferred();
  const release = deferred();
  const rename = fs.rename;
  const writes: unknown[] = [];
  t.mock.method(fs, "rename", async (...args: Parameters<typeof fs.rename>) => {
    if (!writes.length) {
      entered.resolve();
      await release.promise;
    }
    await rename(...args);
    writes.push(await f.disk());
  });
  f.controller.enqueue(route("add", b));
  await entered.promise;
  f.controller.enqueue({
    destination: "global",
    profile: "general",
    field: "fallback",
    action: "move",
    target: b,
    direction: "earlier",
  });
  f.controller.enqueue(text("review", "original profile, not selected rail"));
  assert.equal(f.controller.status, "saving");
  assert.deepEqual(f.controller.verified.global, { general: { models: [a], fallback: [a] } });
  assert.deepEqual(f.controller.projected.profiles.find((p) => p.name === "general")!.fallback, [
    b,
    a,
  ]);
  assert.equal((await f.disk()).review, undefined);
  assert.throws(() => f.controller.enqueue(route("add", b)), /already/);
  release.resolve();
  await f.controller.settled();
  assert.equal(f.controller.status, "saved");
  assert.deepEqual(writes, [
    { general: { models: [a, b], fallback: [a, b] } },
    { general: { models: [a, b], fallback: [b, a] } },
    {
      general: { models: [a, b], fallback: [b, a] },
      review: { prompt: "original profile, not selected rail" },
    },
  ]);
  assert.deepEqual(f.checked, [b]); // Reorder does not reclassify saved targets as new.
  assert.deepEqual(await f.disk(), f.controller.verified.global);
});

test("pre-replacement I/O failure retains attempted projection, freezes tail; Retry revalidates and cannot resurrect close", async (t) => {
  const f = await workspace(t);
  f.controller.enqueue(text("general", "verified before failure"));
  await f.controller.settled();
  const open = fs.open;
  let fail = true;
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    if (fail && String(args[0]).endsWith(".tmp"))
      throw new Error("injected temporary open failure");
    return open(...args);
  });
  f.controller.enqueue(route("add", a));
  f.controller.enqueue(text("review", "tail"));
  let closes = 0;
  f.controller.drain(() => {
    closes++;
  });
  assert.equal(f.controller.status, "finishing");
  await f.controller.settled();
  assert.equal(closes, 0);
  assert.equal(f.controller.status, "not-saved");
  assert.equal(f.controller.failure!.intent.action, "add");
  assert.equal(f.controller.pending.length, 2);
  assert.deepEqual((await f.disk()).general, { prompt: "verified before failure" });
  assert.deepEqual(f.controller.projected.profiles[0]!.fallback, [a]);
  assert.throws(() => f.controller.enqueue(text("general", "hidden")), /paused/);
  fail = false;
  f.controller.retry();
  await f.controller.settled();
  assert.equal(closes, 0);
  assert.deepEqual(f.checked, [a, a]);
  assert.equal((await f.disk()).review.prompt, "tail");
  f.controller.drain(() => {
    closes++;
  });
  assert.equal(closes, 1);
  assert.throws(() => f.controller.enqueue(text("general", "advanced competing writer")), /paused/);
  await f.controller.reload();
  assert.equal(f.controller.status, "saved");
});

test("head-time eligibility failure pauses tail; Revert discards full unsaved count, never prior verified saves", async (t) => {
  const f = await workspace(t);
  f.controller.enqueue(text("general", "keep"));
  await f.controller.settled();
  f.options.checkSelection = () => {
    throw new Error("selection is now out of scope");
  };
  f.controller.enqueue(route("add", a));
  f.controller.enqueue(text("review", "discard"));
  await f.controller.settled();
  assert.match(f.controller.failure!.error.message, /out of scope/);
  assert.equal((await f.disk()).review, undefined);
  assert.equal(f.controller.revert(), 2);
  assert.deepEqual(await f.disk(), { general: { prompt: "keep" } });
  assert.deepEqual(f.controller.projected.global, f.controller.verified.global);
});

test("both-file external conflict requires Reload, abandons tail without replay; malformed reload is closable read-only", async (t) => {
  const f = await workspace(t);
  await fs.writeFile(f.projectPath, JSON.stringify({ review: { prompt: "external project" } }));
  f.controller.enqueue(text("general", "never save"));
  f.controller.enqueue(text("review", "never replay"));
  await f.controller.settled();
  assert.equal(f.controller.status, "reload-required");
  assert.throws(() => f.controller.retry(), /Reload/);
  assert.throws(() => f.controller.revert(), /Reload/);
  assert.deepEqual(await f.disk(), {});
  assert.equal(await f.controller.reload(), 2);
  assert.equal(
    f.controller.verified.project.review &&
      (f.controller.verified.project.review as { prompt: string }).prompt,
    "external project",
  );
  await fs.writeFile(f.globalPath, "{malformed");
  f.controller.enqueue(text("general", "abandon"));
  await f.controller.settled();
  assert.equal(await f.controller.reload(), 1);
  assert.equal(f.controller.status, "read-only");
  assert.ok(f.controller.reloadError);
  assert.equal(f.controller.pending.length, 0);
  let closed = false;
  f.controller.drain(() => {
    closed = true;
  });
  assert.equal(closed, true);
  assert.equal(await fs.readFile(f.globalPath, "utf8"), "{malformed");
});

for (const replacement of ["completed", "unknown"] as const) {
  test(`${replacement} replacement failure forbids retry/rollback and reloads actual disk`, async (t) => {
    const f = await workspace(t);
    const rename = fs.rename;
    t.mock.method(fs, "rename", async (...args: Parameters<typeof fs.rename>) => {
      await rename(...args);
      if (replacement === "unknown") throw new Error("rename outcome unavailable");
      await fs.writeFile(
        f.globalPath,
        JSON.stringify({ general: { prompt: "external after replace" } }),
      );
    });
    f.controller.enqueue(text("general", "attempted"));
    f.controller.enqueue(text("review", "tail"));
    await f.controller.settled();
    assert.equal(f.controller.failure!.error.replacement, replacement);
    assert.equal(f.controller.status, "reload-required");
    assert.throws(() => f.controller.retry(), /Reload/);
    assert.equal((await f.disk()).review, undefined);
    assert.equal(await f.controller.reload(), 2);
    assert.equal(
      (await f.disk()).general.prompt,
      replacement === "completed" ? "external after replace" : "attempted",
    );
    assert.deepEqual(f.controller.verified.global, await f.disk());
  });
}

for (const when of ["before", "after-replacement"] as const) {
  test(`trust loss ${when} never reads untrusted Project, including observations and Reload`, async (t) => {
    const f = await workspace(t);
    const open = fs.open;
    let untrusted = false;
    let projectReads = 0;
    t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
      if (untrusted && String(args[0]) === f.projectPath) projectReads++;
      return open(...args);
    });
    const loseTrust = () => {
      untrusted = true;
      f.trust(false);
    };
    if (when === "before") loseTrust();
    else {
      const rename = fs.rename;
      t.mock.method(fs, "rename", async (...args: Parameters<typeof fs.rename>) => {
        await rename(...args);
        loseTrust();
      });
    }
    f.controller.enqueue(text("general", "attempt"));
    await f.controller.settled();
    assert.equal(f.controller.status, "reload-required");
    assert.equal(f.controller.failure!.error.observed?.project, undefined);
    await fs.writeFile(f.projectPath, "malformed and untrusted");
    await f.controller.reload();
    assert.equal(f.controller.status, "saved");
    assert.equal(projectReads, 0);
    assert.deepEqual(f.controller.verified.project, {});
    f.trust(true); // Gain also conflicts with the retained untrusted baseline.
    f.controller.enqueue(text("general", "trust gain"));
    await f.controller.settled();
    assert.equal(f.controller.status, "reload-required");
  });
}

test("explicit prewalk switch is atomic, final removal disables route without revoking grants", async (t) => {
  const f = await workspace(t, { general: { models: [a], prewalk: a } });
  assert.throws(() => f.controller.enqueue(route("add", b)), /explicit Switch/);
  f.controller.enqueue(route("switch-from-prewalk", b));
  await f.controller.settled();
  assert.deepEqual((await f.disk()).general, { models: [a, b], fallback: [b] });
  f.controller.enqueue(route("remove", b));
  await f.controller.settled();
  assert.deepEqual((await f.disk()).general, { models: [a, b], fallback: false });
});

test("successful drain navigates only after verification and refuses new mutations until resync", async (t) => {
  const f = await workspace(t);
  const entered = deferred();
  const release = deferred();
  const rename = fs.rename;
  t.mock.method(fs, "rename", async (...args: Parameters<typeof fs.rename>) => {
    entered.resolve();
    await release.promise;
    await rename(...args);
  });
  f.controller.enqueue(text("review", "saved before destination switch"));
  await entered.promise;
  let navigated = false;
  f.controller.drain(() => {
    navigated = true;
    assert.equal(
      f.controller.verified.profiles.find((p) => p.name === "review")!.prompt,
      "saved before destination switch",
    );
  });
  assert.equal(navigated, false);
  assert.throws(() => f.controller.enqueue(text("general", "too late")), /paused/);
  release.resolve();
  await f.controller.settled();
  assert.equal(navigated, true);
  assert.equal((await f.disk()).review.prompt, "saved before destination switch");
});

for (const phase of ["baseline", "readback", "final-readback", "error-observation"] as const) {
  test(`trust lost during awaited Global ${phase} read prevents the following Project read`, async (t) => {
    const f = await workspace(t);
    let replaced = false;
    let verificationReads = 0;
    let failed = false;
    let lost = false;
    let projectReads = 0;
    const open = fs.open;
    const rename = fs.rename;
    t.mock.method(fs, "rename", async (...args: Parameters<typeof fs.rename>) => {
      await rename(...args);
      replaced = true;
    });
    t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
      const path = String(args[0]);
      if (phase === "error-observation" && path.endsWith(".tmp")) {
        failed = true;
        throw new Error("injected before replacement");
      }
      if (path === f.projectPath && lost) projectReads++;
      const file = await open(...args);
      if (path === f.globalPath) {
        if (replaced) verificationReads++;
        if (
          phase === "baseline" ||
          (phase === "readback" && verificationReads === 1) ||
          (phase === "final-readback" && verificationReads === 2) ||
          (phase === "error-observation" && failed)
        ) {
          lost = true;
          f.trust(false);
        }
      }
      return file;
    });
    f.controller.enqueue(text("general", "attempt"));
    await f.controller.settled();
    assert.equal(lost, true);
    assert.equal(projectReads, 0);
    assert.equal(f.controller.status, "reload-required");
    assert.equal(f.controller.failure!.error.observed?.project, undefined);
    assert.equal((await f.disk()).general?.prompt, replaced ? "attempt" : undefined);
  });
}

test("head-time eligibility losing trust requires Reload even if metadata throws first", async (t) => {
  const f = await workspace(t);
  f.options.checkSelection = () => {
    f.trust(false);
    throw new Error("metadata unavailable");
  };
  f.controller.enqueue(route("add", a));
  await f.controller.settled();
  assert.equal(f.controller.status, "reload-required");
  assert.deepEqual(await f.disk(), {});
});

test("Global intent retains operator chain/grants hidden by Project narrowing", async (t) => {
  const c: ModelSelection = { provider: "fixture", id: "c", effort: "low" };
  const f = await workspace(
    t,
    { general: { models: [a, b], fallback: [a, b] } },
    { general: { models: [a], fallback: [a] } },
  );
  f.controller.enqueue(route("add", c));
  await f.controller.settled();
  assert.equal(f.controller.status, "saved");
  assert.deepEqual((await f.disk()).general, { models: [a, b, c], fallback: [a, b, c] });
  assert.deepEqual(f.controller.verified.profiles[0]!.fallback, [a]);
});

test("Project remove uses authorized subsequence, retains stale saved grants and cannot add/reorder", async (t) => {
  const f = await workspace(t, { general: { models: [a, b], fallback: [a, b] } });
  f.options.checkSelection = () => {
    throw new Error("saved model unavailable");
  };
  const project = await ProfileAutosaveController.open("project", f.options);
  const local = (intent: ProfileIntent): ProfileIntent => ({ ...intent, destination: "project" });
  assert.throws(
    () =>
      project.enqueue(
        local({
          destination: "global",
          profile: "general",
          field: "fallback",
          action: "move",
          target: b,
          direction: "earlier",
        }),
      ),
    /Global/,
  );
  project.enqueue(local(route("remove", a)));
  project.enqueue(local(route("remove", b)));
  await project.settled();
  assert.equal(project.status, "saved");
  assert.deepEqual(JSON.parse(await fs.readFile(f.projectPath, "utf8")), {
    general: { fallback: false },
  });
  assert.deepEqual((await f.disk()).general, { models: [a, b], fallback: [a, b] });
  assert.throws(() => project.enqueue(local(route("add", a))), /Global/);
});

for (const phase of [
  "initial-open",
  "reload",
  "baseline",
  "readback",
  "final-readback",
  "error-observation",
] as const) {
  for (const boundary of ["open", "stat"] as const) {
    test(`Project trust loss during ${phase} ${boundary} never initiates untrusted content reads`, async (t) => {
      const f = await workspace(t);
      let replaced = false;
      let failed = false;
      let lost = false;
      let projectVerificationReads = 0;
      let untrustedContentReads = 0;
      let untrustedStats = 0;
      let guardedHandlesClosed = 0;
      const open = fs.open;
      const rename = fs.rename;
      t.mock.method(fs, "rename", async (...args: Parameters<typeof fs.rename>) => {
        await rename(...args);
        replaced = true;
      });
      t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
        if (phase === "error-observation" && String(args[0]).endsWith(".tmp")) {
          failed = true;
          throw new Error("injected before replacement");
        }
        const file = await open(...args);
        if (String(args[0]) !== f.projectPath) return file;
        if (replaced) projectVerificationReads++;
        const revoke =
          phase === "initial-open" ||
          phase === "reload" ||
          phase === "baseline" ||
          (phase === "readback" && projectVerificationReads === 1) ||
          (phase === "final-readback" && projectVerificationReads === 2) ||
          (phase === "error-observation" && failed);
        const loseTrust = () => {
          lost = true;
          f.trust(false);
        };
        const stat = file.stat.bind(file);
        const readFile = file.readFile.bind(file);
        const close = file.close.bind(file);
        t.mock.method(file, "stat", async (...statArgs: Parameters<typeof file.stat>) => {
          if (lost) untrustedStats++;
          const info = await stat(...statArgs);
          if (revoke && boundary === "stat") loseTrust();
          return info;
        });
        t.mock.method(file, "readFile", (...readArgs: Parameters<typeof file.readFile>) => {
          if (lost) untrustedContentReads++;
          return readFile(...readArgs);
        });
        t.mock.method(file, "close", async () => {
          if (revoke) guardedHandlesClosed++;
          await close();
        });
        if (revoke && boundary === "open") loseTrust();
        return file;
      });
      if (phase === "initial-open") {
        await assert.rejects(ProfileAutosaveController.open("global", f.options), /trust changed/);
      } else if (phase === "reload") {
        assert.equal(await f.controller.reload(), 0);
        assert.equal(f.controller.status, "read-only");
        assert.ok(f.controller.reloadError);
        let closed = false;
        f.controller.drain(() => {
          closed = true;
        });
        assert.equal(closed, true);
      } else {
        f.controller.enqueue(text("general", "attempt"));
        await f.controller.settled();
        assert.equal(f.controller.status, "reload-required");
        assert.throws(() => f.controller.retry(), /Reload/);
        assert.throws(() => f.controller.revert(), /Reload/);
        assert.deepEqual(f.controller.verified.global, {});
        assert.equal((await f.disk()).general?.prompt, replaced ? "attempt" : undefined);
        await f.controller.reload();
        assert.equal(f.controller.status, "saved");
        assert.deepEqual(f.controller.verified.project, {});
      }
      assert.equal(lost, true);
      assert.equal(untrustedContentReads, 0);
      assert.equal(untrustedStats, 0);
      assert.equal(guardedHandlesClosed, 1);
    });
  }
}

test("rapid item toggles remain two FIFO saves with live phase notifications, not a captured list or coalesced result", async (t) => {
  const f = await workspace(t, { general: { tools: ["read", "write"] } });
  const writes: unknown[] = [];
  const rename = fs.rename;
  t.mock.method(fs, "rename", async (...args: Parameters<typeof fs.rename>) => {
    await rename(...args);
    writes.push(await f.disk());
  });
  const phases: string[] = [];
  const unsubscribe = f.controller.subscribe(() => {
    phases.push(`${f.controller.status}:${f.controller.pending.length}`);
  });
  const toggle = {
    destination: "global",
    profile: "general",
    field: "tools",
    action: "toggle",
    item: "write",
  } as const;
  f.controller.enqueue(toggle);
  f.controller.enqueue(toggle);
  assert.deepEqual(f.controller.projected.global, { general: { tools: ["read", "write"] } });
  await f.controller.settled();
  unsubscribe();
  assert.deepEqual(writes, [
    { general: { tools: ["read"] } },
    { general: { tools: ["read", "write"] } },
  ]);
  assert.ok(phases.includes("saving:2"));
  assert.ok(phases.includes("saving:1"));
  assert.ok(phases.includes("saved:0"));
});

test("effort replacement retains old grants; default/prewalk compound and grant dependency removal remain atomic", async (t) => {
  const f = await workspace(t, { general: { models: [a, b], fallback: [a] } });
  const high = { ...a, effort: "high" as const };
  f.controller.enqueue({
    destination: "global",
    profile: "general",
    field: "fallback",
    action: "replace-target",
    target: a,
    replacement: high,
  });
  await f.controller.settled();
  assert.deepEqual((await f.disk()).general, { models: [a, b, high], fallback: [high] });
  assert.throws(
    () =>
      f.controller.enqueue({
        destination: "global",
        profile: "general",
        field: "models",
        action: "revoke",
        target: high,
      }),
    /Required by/,
  );
  f.controller.enqueue({
    destination: "global",
    profile: "general",
    field: "model",
    action: "select",
    target: a,
  });
  f.controller.enqueue({
    destination: "global",
    profile: "general",
    field: "prewalk",
    action: "switch-from-fallback",
    target: b,
  });
  await f.controller.settled();
  assert.deepEqual((await f.disk()).general, {
    models: [a, b, high],
    fallback: false,
    model: a,
    prewalk: b,
  });
  assert.throws(
    () =>
      f.controller.enqueue({
        destination: "global",
        profile: "general",
        field: "models",
        action: "revoke",
        target: b,
      }),
    /Required by/,
  );
  f.controller.enqueue({
    destination: "global",
    profile: "general",
    field: "prewalk",
    action: "reset",
  });
  f.controller.enqueue({
    destination: "global",
    profile: "general",
    field: "models",
    action: "revoke",
    target: b,
  });
  await f.controller.settled();
  assert.deepEqual((await f.disk()).general.models, [a, high]);
  assert.deepEqual(f.checked, [high, a, b]);
});

test("invalid ordinary reset is retained Not saved and revert restores verified state without a rollback write", async (t) => {
  const f = await workspace(t, { general: { models: [a], fallback: [a] } });
  f.controller.enqueue({
    destination: "global",
    profile: "general",
    field: "models",
    action: "reset",
  });
  await f.controller.settled();
  assert.equal(f.controller.status, "not-saved");
  assert.equal(
    (f.controller.projected.global.general as Record<string, unknown>).models,
    undefined,
  );
  assert.deepEqual((await f.disk()).general.models, [a]);
  assert.equal(f.controller.revert(), 1);
  assert.deepEqual(f.controller.projected.global, f.controller.verified.global);
});

test("project cannot mint grants or switch inherited prewalk; max64 is checked against projected state", async (t) => {
  const f = await workspace(t, { general: { models: [a], prewalk: a } });
  const project = await ProfileAutosaveController.open("project", f.options);
  project.enqueue({
    destination: "project",
    profile: "general",
    field: "models",
    action: "grant",
    target: b,
  });
  await project.settled();
  assert.equal(project.status, "not-saved");
  assert.equal(project.revert(), 1);
  assert.deepEqual(JSON.parse(await fs.readFile(f.projectPath, "utf8")), {});
  assert.throws(
    () =>
      project.enqueue({
        destination: "project",
        profile: "general",
        field: "prewalk",
        action: "switch-from-fallback",
        target: a,
      }),
    /Global/,
  );
  const targets = Array.from({ length: 64 }, (_, i) => ({ ...a, id: `model-${i}` }));
  const full = await workspace(t, { general: { models: targets, fallback: targets } });
  assert.throws(() => full.controller.enqueue(route("add", b)), /Maximum 64/);
  assert.equal(full.controller.pending.length, 0);
  assert.deepEqual((await full.disk()).general.models, targets);
});

test("an external edit during failed selection validation overrides Retry with explicit Reload", async (t) => {
  const f = await workspace(t);
  f.options.checkSelection = async () => {
    await fs.writeFile(
      f.projectPath,
      JSON.stringify({ review: { prompt: "external during eligibility" } }),
    );
    throw new Error("selection lost eligibility");
  };
  f.controller.enqueue(route("add", a));
  f.controller.enqueue(text("review", "do not replay"));
  await f.controller.settled();
  assert.equal(f.controller.status, "reload-required");
  assert.throws(() => f.controller.retry(), /Reload/);
  assert.deepEqual(await f.disk(), {});
  assert.equal(await f.controller.reload(), 2);
  assert.equal(
    (f.controller.verified.project.review as { prompt: string }).prompt,
    "external during eligibility",
  );
});

test("observer invalidation errors cannot turn verified saves into failed intents or stop FIFO", async (t) => {
  const f = await workspace(t);
  f.controller.subscribe(() => {
    throw new Error("disposed renderer");
  });
  f.controller.enqueue(text("general", "verified head"));
  f.controller.enqueue(text("review", "verified tail"));
  await f.controller.settled();
  assert.equal(f.controller.status, "saved");
  assert.equal(f.controller.failure, undefined);
  assert.deepEqual(await f.disk(), {
    general: { prompt: "verified head" },
    review: { prompt: "verified tail" },
  });
});

test("overlapping Reload requests share one deferred actual-file open and cannot clobber newer verified saves", async (t) => {
  const f = await workspace(t);
  const entered = deferred(),
    release = deferred();
  const open = ProfileConfigDraft.open;
  let opens = 0;
  t.mock.method(
    ProfileConfigDraft,
    "open",
    async (...args: Parameters<typeof ProfileConfigDraft.open>) => {
      const draft = await open(...args); // Capture the actual {} baseline before holding completion.
      opens++;
      entered.resolve();
      await release.promise;
      return draft;
    },
  );
  const first = f.controller.reload();
  await entered.promise;
  const second = f.controller.reload();
  assert.equal(second, first, "Repeated Reload joins the outstanding reopen");
  assert.equal(opens, 1);
  assert.throws(() => f.controller.enqueue(text("general", "must wait for Reload")), /paused/);
  release.resolve();
  assert.deepEqual(await Promise.all([first, second]), [0, 0]);
  f.controller.enqueue(text("general", "saved after shared reload"));
  await f.controller.settled();
  assert.equal(opens, 1);
  assert.equal((await f.disk()).general.prompt, "saved after shared reload");
  assert.deepEqual(f.controller.verified.global, await f.disk());
  assert.equal(f.controller.status, "saved");
});
