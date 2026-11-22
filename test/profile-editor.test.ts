import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters as stripAnsi } from "node:util";
import {
  visibleWidth,
  oklchColor,
  styleText,
  backgroundAnsi,
  type TUI,
  type Component,
  type KeybindingsManager,
} from "@earendil-works/pi-tui";
import type { ExtensionCommandContext, ThemeStyle } from "@earendil-works/pi-coding-agent";
import {
  createProfileEditorScreen,
  runProfileEditor,
  runProfileStructuralTransaction,
  profilePermissionChanges,
  profileSaveReview,
  type ProfileEditorView,
} from "../src/profile-editor.ts";
import { createEditableProfileInspector, type InspectorExit } from "../src/profile-inspector.ts";
import { ProfileAutosaveController } from "../src/profile-autosave.ts";
import { ProfileConfigDraft, type ProfileDraftOptions } from "../src/profile-config.ts";
import { bundledProfiles } from "../src/profiles.ts";
import { EFFORTS } from "../src/model-policy.ts";
import { profileModelReason, type ProfileModelCatalog } from "../src/profile-model-catalog.ts";

const keys = {
  matches: (data: string, action: string) =>
    (action === "tui.select.cancel" && data === "\x03") ||
    data ===
      (
        {
          "tui.select.cancel": "\x1b",
          "tui.select.confirm": "\r",
          "tui.input.submit": "\r",
          "tui.select.up": "up",
          "tui.select.down": "down",
          "tui.select.pageUp": "pgup",
          "tui.select.pageDown": "pgdown",
        } as Record<string, string>
      )[action],
  getKeys: (action: string) =>
    action === "tui.select.confirm" || action === "tui.input.submit"
      ? ["enter" as const]
      : ["escape" as const, "ctrl+c" as const],
};
const theme = {
  fg: (_color: string, text: string) => text,
  style: (text: string) => text,
  colors: { customMessageBg: oklchColor(0.2, 0, 0) },
};
const a = { provider: "fixture", id: "a", effort: "off" as const };
const b = { provider: "fixture", id: "b", effort: "high" as const };
const models: ProfileModelCatalog = {
  entries: [
    {
      provider: "fixture",
      id: "a",
      name: "Friendly Alpha",
      providerLabel: "Custom Fixture",
      efforts: [{ effort: "off" }, { effort: "high" }],
    },
    {
      provider: "fixture",
      id: "b",
      name: "Friendly Beta",
      providerLabel: "Custom Fixture",
      efforts: [{ effort: "high" }],
    },
  ],
};
function bounds(lines: readonly string[], width: number, height: number) {
  assert.ok(lines.length <= height, `${lines.length} > ${height}`);
  for (const line of lines) {
    assert.ok(visibleWidth(line) <= width, `${visibleWidth(line)} > ${width}: ${line}`);
    assert.doesNotMatch(
      stripAnsi(
        line
          .replaceAll("\x1b_pi:fc\x07", "")
          .replaceAll("\x1b_pi:/fc\x07", "")
          .replaceAll("\x1b_pi:c\x07", ""),
      ),
      /\x1b|\n|\r/,
    );
  }
}
async function files(
  t: TestContext,
  global: unknown = {
    general: {
      description: "Global description",
      prompt: "Global instructions",
      tools: ["read", "write"],
    },
  },
  project: unknown = {},
) {
  const root = await fs.mkdtemp(join(tmpdir(), "profile-editor-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(join(root, "operator"));
  await fs.mkdir(join(root, ".pi"));
  const globalPath = join(root, "operator", "delegation.json"),
    projectPath = join(root, ".pi", "delegation.json");
  await fs.writeFile(globalPath, JSON.stringify(global));
  await fs.writeFile(projectPath, JSON.stringify(project));
  let trusted = true;
  const options: ProfileDraftOptions = {
    cwd: root,
    operatorDir: join(root, "operator"),
    isProjectTrusted: () => trusted,
    coordinator: { profileUsage: () => [] },
  };
  return {
    root,
    globalPath,
    projectPath,
    global,
    project,
    options,
    setTrusted(value: boolean) {
      trusted = value;
    },
    disk: async () => JSON.parse(await fs.readFile(globalPath, "utf8")),
  };
}
async function inspector(
  t: TestContext,
  global?: unknown,
  project?: unknown,
  destination: "global" | "project" = "global",
  initialRole?: string,
  bindings: Pick<KeybindingsManager, "matches" | "getKeys"> = keys,
) {
  const f = await files(t, global, project);
  let metadata = models;
  let renders = 0;
  const controller = await ProfileAutosaveController.open(destination, {
    ...f.options,
    checkSelection(target) {
      const reason = profileModelReason(metadata, target);
      if (reason) throw new Error(reason);
    },
  });
  let height = 36,
    width = 120;
  let exited = false,
    result: InspectorExit;
  const tui = {
    terminal: { rows: 36 },
    requestRender() {
      renders++;
    },
  } as unknown as TUI;
  const screen = createEditableProfileInspector(
    controller,
    { modelCatalog: () => metadata, isProjectTrusted: f.options.isProjectTrusted, initialRole },
    tui,
    theme,
    bindings,
    () => {
      renders++;
    },
    (value) => {
      exited = true;
      result = value;
    },
    () => height,
  );
  t.after(() => screen.dispose());
  screen.focused = true;
  const render = () => {
    const lines = screen.render(width);
    bounds(lines, width, height);
    return stripAnsi(lines.join("\n"));
  };
  const input = (...values: string[]) => {
    for (const value of values) {
      render();
      screen.handleInput?.(value);
    }
    render();
  };
  const go = (label: string) => {
    input("\x1b[H");
    for (let count = 0; count < 240; count++) {
      const output = render();
      if (output.includes(`› ${label}`) || output.includes(`❯ ${label}`)) return;
      input("down");
    }
    assert.fail(`Unreachable action ${label}:\n${render()}`);
  };
  const open = (label: string) => {
    input("1"); // Group jumps return to the compact overview, without changing the destination.
    go(label);
    input("\r");
  };
  const activate = (label: string) => {
    go(label);
    input("\r");
  };
  return {
    ...f,
    controller,
    screen,
    render,
    input,
    go,
    activate,
    open,
    renders: () => renders,
    setMetadata(value: ProfileModelCatalog) {
      metadata = value;
    },
    resize(w: number, h: number) {
      width = w;
      height = h;
    },
    exit: () => ({ exited, result }),
  };
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("editable Inspector commits Enter/blur once to original profile, native multiline submits, Escape cancels unfinished input only", async (t) => {
  const f = await inspector(t);
  f.open("Description");
  f.activate("Edit description");
  f.input("\x05", "\x15", "j/k 路径 é 👩‍💻", "\t", "down", "\t");
  assert.match(f.render(), /scout/);
  await f.controller.settled();
  assert.equal((await f.disk()).general.description, "j/k 路径 é 👩‍💻");
  assert.equal((await f.disk()).scout, undefined);
  f.input("\t", "up", "\t");
  f.open("Description");
  f.activate("Edit description");
  f.input("\x05", "\x15", "not committed", "\x1b");
  assert.equal((await f.disk()).general.description, "j/k 路径 é 👩‍💻");
  f.open("Instructions");
  f.activate("Edit instructions (prompt)");
  f.input("\x01", "\x0b", "\x1b[200~Multiline\nUnicode j/k 路径\x1b[201~", "\r", "\t");
  await f.controller.settled();
  assert.equal((await f.disk()).general.prompt, "Multiline\nUnicode j/k 路径");
  assert.equal(f.controller.pending.length, 0);
  assert.ok(f.renders() > 10, "async phases request rendering");
  assert.doesNotMatch(f.render(), /Review \/ Save|Apply|Cancel draft/);
});

test("catalog inside persistent rail discloses atomic Add/grant, supports dependent move and cross-profile text while saving", async (t) => {
  const f = await inspector(t, { general: { models: [a], fallback: [a] } });
  const entered = deferred(),
    release = deferred();
  const rename = fs.rename;
  let count = 0;
  const writes: unknown[] = [];
  t.mock.method(fs, "rename", async (...args: Parameters<typeof fs.rename>) => {
    if (++count === 1) {
      entered.resolve();
      await release.promise;
    }
    await rename(...args);
    writes.push(await f.disk());
  });
  f.open("Models");
  f.activate("+ Add fallback…");
  assert.match(f.render(), /Profiles/);
  assert.match(f.render(), /explicit overrides/);
  assert.doesNotMatch(f.render(), /no automatic grants/);
  f.input("Beta", "\r", "\r");
  await entered.promise;
  assert.equal(f.controller.pending.length, 1);
  f.go("↳ fixture/b:high");
  f.input("\x1b[1;2A"); // Shift+↑ moves the selected target earlier.
  assert.equal(f.controller.pending.length, 2);
  f.input("\t", "down", "down", "\t");
  f.open("Instructions");
  f.activate("Edit instructions (prompt)");
  f.input("\x01", "\x0b", "cross-profile", "\r");
  assert.equal(f.controller.pending.at(-1)!.profile, "review");
  assert.match(f.render(), /pending|Pending/);
  assert.deepEqual(await f.disk(), { general: { models: [a], fallback: [a] } });
  const before = f.renders();
  release.resolve();
  await f.controller.settled();
  assert.ok(f.renders() > before);
  assert.equal(writes.length, 3);
  assert.deepEqual((await f.disk()).general.fallback, [b, a]);
  assert.deepEqual((await f.disk()).general.models, [a, b]);
  assert.equal((await f.disk()).review.prompt, "cross-profile");
  assert.match(f.render(), /Saved · verified/);
});

test("immediate permissions, exact skills/leaf grants and dependent grant removal; saved unavailable rows do not block unrelated changes", async (t) => {
  const f = await inspector(t, {
    general: { tools: ["read", "write"], models: [a], fallback: [a] },
  });
  f.open("Tools");
  f.activate("[x] write");
  await f.controller.settled();
  assert.deepEqual((await f.disk()).general.tools, ["read"]);
  f.input("1");
  f.open("Delegation");
  f.activate("Coordination (coordination):");
  f.activate("[ ] message");
  await f.controller.settled();
  assert.deepEqual((await f.disk()).general.coordination, ["message"]);
  const skill = join(f.root, "SKILL.md");
  await fs.writeFile(skill, "---\nname: fixture\ndescription: Controlled skill\n---\nInstructions");
  f.input("1");
  f.open("Skills");
  f.activate("Add exact absolute skill path");
  f.input(skill, "\r");
  await f.controller.settled();
  assert.deepEqual((await f.disk()).general.skills, [skill]);
  f.input("1");
  f.open("Reviewed tools");
  f.activate("Add exact reviewed leaf name");
  f.input("trusted_leaf", "\r");
  await f.controller.settled();
  assert.deepEqual((await f.disk()).general.leafTools, ["trusted_leaf"]);
  f.input("1");
  f.open("Advanced");
  f.activate("Exact model grants:");
  f.go("Remove grant:");
  assert.match(f.render(), /Required by a current/);
  f.input("\r");
  assert.deepEqual((await f.disk()).general.models, [a]);
  f.input("1");
  f.setMetadata({ entries: [], error: "Metadata unavailable" });
  f.open("Description");
  f.activate("Edit description");
  f.input("\x05", "\x15", "unrelated", "\r");
  await f.controller.settled();
  assert.equal((await f.disk()).general.description, "unrelated");
  f.open("Models");
  f.go("fixture/a");
  assert.match(f.render(), /fixture\/a +⦸ off ⚠ unavailable|fixture\/a ⚠ unavailable +⦸ off/);
  assert.match(f.render(), /⚠ Metadata unavailable/);
  f.input("x");
  await f.controller.settled();
  assert.deepEqual((await f.disk()).general.fallback, false);
  assert.deepEqual((await f.disk()).general.models, [a]);
});

test("failure retains attempted field, cancels drain permanently, browsing remains read-only; Retry/Revert/Reload controls act on actual files", async (t) => {
  const f = await inspector(t);
  const open = fs.open;
  let fail = true;
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    if (fail && String(args[0]).endsWith(".tmp")) throw new Error("injected permission failure");
    return open(...args);
  });
  f.open("Description");
  f.activate("Edit description");
  f.input("\x05", "\x15", "attempted", "\r");
  f.input("\x1b");
  await f.controller.settled();
  assert.equal(f.exit().exited, false);
  assert.equal(f.controller.status, "not-saved");
  f.input("\t", "down", "\t");
  f.go("Retry same action");
  assert.match(f.render(), /general.description/);
  fail = false;
  f.input("\r");
  await f.controller.settled();
  assert.equal(f.exit().exited, false);
  assert.equal((await f.disk()).general.description, "attempted");
  await fs.writeFile(f.projectPath, JSON.stringify({ review: { description: "external" } }));
  f.open("Description");
  f.activate("Edit description");
  f.input("\x05", "\x15", "abandon", "\r");
  await f.controller.settled();
  assert.equal(f.controller.status, "reload-required");
  f.activate("Reload · abandon");
  await new Promise<void>((resolve) => setImmediate(resolve));
  // Reload is asynchronous; settle by waiting on the observed state, not a timing delay.
  for (let i = 0; i < 100 && f.controller.status === "read-only"; i++)
    await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(f.controller.pending.length, 0);
  assert.equal((await f.disk()).scout, undefined);
});

test("wide/narrow/short/tiny and paint retain focus/state, no hidden action activation; j/k stay printable inside native input", async (t) => {
  const f = await inspector(t);
  f.open("Description");
  f.activate("Edit description");
  f.input("\x05", "\x15", "jkjk");
  for (const [w, h] of [
    [120, 36],
    [100, 24],
    [80, 24],
    [52, 24],
    [100, 12],
    [24, 12],
    [20, 6],
    [1, 1],
    [0, 1],
  ]) {
    f.resize(w, h);
    f.render();
    if (w < 32 || h < 16) f.input("\r");
  }
  assert.equal(f.controller.pending.length, 0);
  f.resize(100, 24);
  f.input("\r");
  await f.controller.settled();
  assert.equal((await f.disk()).general.description, "jkjk");
  const palette = {
    colors: { customMessageBg: oklchColor(0.3, 0.15, 330) },
    fg: (_c: string, s: string) => `\x1b[31m${s}\x1b[0m\x1b[49m`,
    style: (s: string, { bg }: ThemeStyle) => {
      if (bg) assert.ok(typeof bg !== "string");
      return styleText(s, { bg }, "truecolor");
    },
  };
  const painted = createEditableProfileInspector(
    f.controller,
    { isProjectTrusted: () => true },
    { terminal: { rows: 24 } } as TUI,
    palette,
    keys,
    () => {},
    () => {},
    () => 24,
  );
  t.after(() => painted.dispose());
  for (const lightness of [0.3, 0.9]) {
    palette.colors.customMessageBg = oklchColor(lightness, 0.15, 330);
    for (const line of painted.render(100)) {
      assert.equal(visibleWidth(line), 100);
      assert.ok(line.startsWith(backgroundAnsi(oklchColor(lightness, 0, 0), "truecolor")));
      assert.doesNotMatch(line, /\x1b\[49m(?!\x1b\[0m|$)/);
    }
  }
});

test("Project-local profile under Global stays browsable with explicit Project switch, never creates a Global shadow", async (t) => {
  const local = {
    description: "Local",
    prompt: "Independent",
    tools: [],
    skills: [],
    spawn: [],
    coordination: [],
    ceiling: "scout",
  };
  const f = await inspector(
    t,
    { projectRoleCeilings: ["scout"] },
    { customProfiles: { local } },
    "global",
    "local",
  );
  assert.match(f.render(), /Project-local/);
  f.open("Description");
  f.activate("Edit description");
  assert.equal(f.controller.pending.length, 0);
  assert.equal((await f.disk()).customProfiles, undefined);
  f.activate("Change destination");
  assert.deepEqual(f.exit().result, { action: "destination", profile: "local" });
});

type StructuralStep = {
  title: RegExp;
  choice: string;
  inspect?: (view: ProfileEditorView) => void | Promise<void>;
};
function structuralDialogs(steps: StructuralStep[], inputs: (string | undefined)[] = []) {
  let index = 0,
    inputIndex = 0;
  const show = async (view: ProfileEditorView) => {
    const step = steps[index++];
    assert.ok(step, `Unexpected ${view.title}`);
    assert.match(view.title, step.title);
    const choice = view.choices.find(
      (choice) => choice.label === step.choice || choice.value === step.choice,
    );
    assert.ok(choice, `Missing ${step.choice}: ${view.choices.map((c) => c.label).join(", ")}`);
    await step.inspect?.(view);
    return choice.value;
  };
  return {
    show,
    ctx: {
      ui: {
        input: async () => {
          assert.ok(inputIndex < inputs.length);
          return inputs[inputIndex++];
        },
      },
    } as unknown as Pick<ExtensionCommandContext, "ui">,
    finished() {
      assert.equal(index, steps.length);
      assert.equal(inputIndex, inputs.length);
    },
  };
}
const saveStructural: StructuralStep[] = [
  { title: /Advanced structural transaction/, choice: "review" },
  { title: /Review profile save/, choice: "save" },
];

test("Advanced one-time general copy confirms explicit skills, strips leaf metadata, saves atomically and returns resynced Inspector", async (t) => {
  const f = await files(t);
  const skill = join(f.root, "SKILL.md");
  await fs.writeFile(
    skill,
    "---\nname: explicit\ndescription: Explicit fixture\n---\nInstructions",
  );
  await fs.writeFile(
    f.globalPath,
    JSON.stringify({ general: { skills: [skill], leafTools: ["trusted_leaf"] } }),
  );
  const d = structuralDialogs(
    [
      { title: /Independent custom definition/, choice: "copy" },
      {
        title: /Review one-time copied grants/,
        choice: "copy",
        inspect(view) {
          assert.ok(view.lines.includes(skill));
          assert.match(view.lines.join("\n"), /NOT copied/);
        },
      },
      ...saveStructural,
    ],
    ["audit"],
  );
  assert.equal(
    await runProfileStructuralTransaction(d.ctx, d.show, "global", f.options, "general", "create"),
    "audit",
  );
  d.finished();
  const copied = (await f.disk()).customProfiles.audit;
  assert.deepEqual(copied.skills, [skill]);
  assert.equal(copied.leafTools, undefined);
  assert.equal(copied.name, undefined);
  const controller = await ProfileAutosaveController.open("global", {
    ...f.options,
    checkSelection() {},
  });
  controller.enqueue({
    destination: "global",
    profile: "audit",
    field: "prompt",
    action: "set",
    value: "After structural return",
  });
  await controller.settled();
  assert.equal((await f.disk()).customProfiles.audit.prompt, "After structural return");
});

test("Advanced ceiling authorization and trusted local creation keep authority separate from grants and independent content", async (t) => {
  const f = await files(t);
  const auth = structuralDialogs([
    { title: /Operator project-role ceiling authorization/, choice: "toggle:scout" },
    { title: /Operator project-role ceiling authorization/, choice: "apply" },
    ...saveStructural,
  ]);
  await runProfileStructuralTransaction(
    auth.ctx,
    auth.show,
    "global",
    f.options,
    "general",
    "ceilings",
  );
  auth.finished();
  const prior = await fs.readFile(f.globalPath, "utf8");
  const local = structuralDialogs(
    [
      { title: /Choose project-local authority ceiling/, choice: "scout" },
      { title: /Independent custom definition/, choice: "blank" },
      ...saveStructural,
    ],
    ["local-audit"],
  );
  await runProfileStructuralTransaction(
    local.ctx,
    local.show,
    "project",
    f.options,
    "general",
    "create",
  );
  local.finished();
  const saved = JSON.parse(await fs.readFile(f.projectPath, "utf8")).customProfiles["local-audit"];
  assert.equal(saved.ceiling, "scout");
  for (const key of ["tools", "skills", "spawn", "coordination"]) assert.deepEqual(saved[key], []);
  assert.equal(await fs.readFile(f.globalPath, "utf8"), prior);
  const unavailable = await files(t);
  const denied = structuralDialogs(
    [
      {
        title: /Choose project-local authority ceiling/,
        choice: "back",
        inspect(view) {
          assert.match(view.lines.join("\n"), /No authorized ceilings/);
        },
      },
    ],
    ["local-denied"],
  );
  await runProfileStructuralTransaction(
    denied.ctx,
    denied.show,
    "project",
    unavailable.options,
    "general",
    "create",
  );
  denied.finished();
  assert.deepEqual(JSON.parse(await fs.readFile(unavailable.projectPath, "utf8")), {});
});

test("Advanced deletion retains blockers, explicit reference removals and cancel/undo; no silent cascade", async (t) => {
  const definition = {
    description: "Independent",
    prompt: "Explicit",
    tools: ["read"],
    skills: [],
    spawn: [],
    coordination: [],
  };
  const global = {
    customProfiles: { audit: definition, owner: { ...definition, spawn: ["audit"] } },
    projectRoleCeilings: ["audit"],
  };
  const f = await files(t, global);
  const cancelled = structuralDialogs([
    {
      title: /Review custom deletion/,
      choice: "spawn:owner:audit",
      inspect(view) {
        assert.match(view.lines.join("\n"), /Spawn grant still references|Operator authorization/);
      },
    },
    { title: /Review custom deletion/, choice: "back" },
  ]);
  await runProfileStructuralTransaction(
    cancelled.ctx,
    cancelled.show,
    "global",
    f.options,
    "audit",
    "delete",
  );
  cancelled.finished();
  assert.deepEqual(await f.disk(), global);
  const d = structuralDialogs([
    { title: /Review custom deletion/, choice: "spawn:owner:audit" },
    { title: /Review custom deletion/, choice: "ceiling" },
    { title: /Review custom deletion/, choice: "delete" },
    ...saveStructural,
  ]);
  await runProfileStructuralTransaction(d.ctx, d.show, "global", f.options, "audit", "delete");
  d.finished();
  assert.deepEqual(await f.disk(), {
    customProfiles: { owner: definition },
    projectRoleCeilings: [],
  });
});

test("Advanced custom-ceiling deletion tracks conditional references after registration removal; undo restores staged changes", async (t) => {
  const definition = {
    description: "Authority",
    prompt: "Explicit",
    tools: ["read"],
    skills: [],
    spawn: [],
    coordination: [],
  };
  const global = {
    customProfiles: { authority: definition },
    projectRoleCeilings: ["authority"],
    projectSpawnTargets: { "release-audit": "authority" },
    general: { spawn: ["release-audit"] },
  };
  const f = await files(t, global);
  const d = structuralDialogs([
    { title: /Review custom deletion/, choice: "registration:release-audit" },
    {
      title: /Review custom deletion/,
      choice: "spawn:general:release-audit",
      inspect(view) {
        assert.match(view.lines.join("\n"), /Explicitly remove conditional target release-audit/);
      },
    },
    { title: /Review custom deletion/, choice: "ceiling" },
    { title: /Review custom deletion/, choice: "delete" },
    { title: /Advanced structural transaction/, choice: "undo" },
  ]);
  await runProfileStructuralTransaction(d.ctx, d.show, "global", f.options, "authority", "delete");
  d.finished();
  assert.deepEqual(await f.disk(), global);
});

test("Advanced registration-only save reviews cross-project reach, creates no role/parent grant; explicit removal repairs refs atomically", async (t) => {
  const f = await files(t, { projectRoleCeilings: ["scout"] });
  const d = structuralDialogs(
    [
      {
        title: /Global project-local spawn registrations/,
        choice: "add",
        inspect(view) {
          assert.match(view.lines.join("\n"), /ALL trusted projects/);
        },
      },
      { title: /Required ceiling/, choice: "ceiling:scout" },
      { title: /Global project-local spawn registrations/, choice: "apply" },
      { title: /Advanced structural transaction/, choice: "review" },
      {
        title: /Review profile save/,
        choice: "save",
        inspect(view) {
          assert.match(view.lines.join("\n"), /GLOBAL authorization projectSpawnTargets/);
        },
      },
    ],
    ["release-audit"],
  );
  await runProfileStructuralTransaction(
    d.ctx,
    d.show,
    "global",
    f.options,
    "general",
    "registrations",
  );
  d.finished();
  assert.deepEqual(await f.disk(), {
    projectRoleCeilings: ["scout"],
    projectSpawnTargets: { "release-audit": "scout" },
  });
  const controller = await ProfileAutosaveController.open("global", {
    ...f.options,
    checkSelection() {},
  });
  controller.enqueue({
    destination: "global",
    profile: "general",
    field: "spawn",
    action: "include",
    item: "release-audit",
  });
  await controller.settled();
  const removal = structuralDialogs([
    { title: /Global project-local spawn registrations/, choice: "empty" },
    { title: /Advanced structural transaction/, choice: "repair:general:release-audit" },
    ...saveStructural,
  ]);
  await runProfileStructuralTransaction(
    removal.ctx,
    removal.show,
    "global",
    f.options,
    "general",
    "registrations",
  );
  removal.finished();
  assert.deepEqual((await f.disk()).general.spawn, ["scout", "review"]);
  assert.deepEqual((await f.disk()).projectSpawnTargets, {});
});

test("Advanced registered-local copy strips resolver metadata and retains chosen ceiling; conflict never overwrites external authority", async (t) => {
  const definition = {
    description: "Local",
    prompt: "Independent",
    tools: ["read"],
    skills: [],
    spawn: [],
    coordination: [],
    ceiling: "scout",
  };
  const f = await files(
    t,
    { projectRoleCeilings: ["scout"], projectSpawnTargets: { "release-audit": "scout" } },
    { customProfiles: { "release-audit": definition } },
  );
  const d = structuralDialogs(
    [
      { title: /Choose project-local authority ceiling/, choice: "scout" },
      { title: /Independent custom definition/, choice: "copy" },
      { title: /Review one-time copied grants/, choice: "copy" },
      ...saveStructural,
    ],
    ["copied-local"],
  );
  await runProfileStructuralTransaction(
    d.ctx,
    d.show,
    "project",
    f.options,
    "release-audit",
    "create",
  );
  d.finished();
  const copied = JSON.parse(await fs.readFile(f.projectPath, "utf8")).customProfiles[
    "copied-local"
  ];
  assert.equal(copied.ceiling, "scout");
  for (const field of [
    "projectCeiling",
    "projectSpawnAuthorized",
    "inheritedModelCeiling",
    "leafTools",
    "name",
  ])
    assert.equal(copied[field], undefined);
  const original = await fs.readFile(f.globalPath, "utf8");
  const conflict = structuralDialogs([
    { title: /Global project-local spawn registrations/, choice: "reset" },
    {
      title: /Advanced structural transaction/,
      choice: "review",
      async inspect() {
        await fs.writeFile(f.projectPath, JSON.stringify({ general: { prompt: "External" } }));
      },
    },
    { title: /Profile configuration error/, choice: "reload" },
  ]);
  await runProfileStructuralTransaction(
    conflict.ctx,
    conflict.show,
    "global",
    f.options,
    "general",
    "registrations",
  );
  conflict.finished();
  assert.equal(await fs.readFile(f.globalPath, "utf8"), original);
});

test("command entry is read-only, explicit destination leads to real inline autosave; close drains without ordinary review", async (t) => {
  const f = await files(t);
  let step = 0;
  const ctx = {
    mode: "tui",
    ui: {
      custom: (factory: (...args: any[]) => Component) =>
        new Promise((resolve) => {
          const component = factory(
            { terminal: { rows: 40 }, requestRender() {} },
            theme,
            keys,
            resolve,
          );
          const draw = () => stripAnsi(component.render(120).join("\n"));
          if (step++ === 0) {
            assert.match(draw(), /read-only/);
            component.handleInput?.("e");
          } else if (step === 2) {
            assert.match(draw(), /Choose write destination/);
            component.handleInput?.("down");
            draw();
            component.handleInput?.("\r");
          } else {
            assert.match(draw(), /Saved · verified/);
            component.handleInput?.("\r");
            draw();
            component.handleInput?.("\r");
            draw();
            for (const data of ["\x05", "\x15", "Command saved", "\r", "\x1b", "\x1b"]) {
              draw();
              component.handleInput?.(data);
            }
          }
        }),
    },
  } as unknown as Pick<ExtensionCommandContext, "mode" | "ui">;
  await runProfileEditor(ctx, f.options);
  assert.equal(step, 3);
  assert.equal((await f.disk()).general.description, "Command saved");
  for (const mode of ["rpc", "json", "print"] as const)
    await assert.rejects(runProfileEditor({ ...ctx, mode }, f.options), /native TUI/);
});

test("bounded structural review and shared paint preserve safe defaults and reject invisible activation", async (t) => {
  const f = await files(t);
  const draft = await ProfileConfigDraft.open("global", f.options);
  draft.value.general = { description: "Changed", prompt: "路径\n".repeat(50) };
  const view = profileSaveReview(draft, await draft.validate());
  let h = 36,
    result: string | undefined;
  const screen = createProfileEditorScreen(
    view,
    theme,
    keys,
    () => {},
    (value) => {
      result = value;
    },
    () => h,
  );
  for (const [w, rows] of [
    [120, 36],
    [52, 24],
    [20, 6],
    [1, 1],
    [0, 1],
  ]) {
    h = rows;
    bounds(screen.render(w), w, h);
    if (w < 24 || h < 12) {
      screen.handleInput?.("down");
      screen.handleInput?.("\r");
      assert.equal(result, undefined);
    }
  }
  h = 36;
  screen.render(120);
  screen.handleInput?.("\r");
  assert.equal(result, "back");
  assert.deepEqual(await f.disk(), f.global);
  const profiles = bundledProfiles();
  const narrowed = profiles.map((p) =>
    p.name === "general" ? { ...p, models: [], tools: ["read" as const] } : p,
  );
  assert.match(
    profilePermissionChanges(profiles, narrowed).join("\n"),
    /general.models: <unset \/ inherited> → \[\]/,
  );
});

test("exact-entry local validation retains native Input and focus without queuing, then permits correction in place", async (t) => {
  const f = await inspector(t);
  const skill = join(f.root, "SKILL.md");
  await fs.writeFile(
    skill,
    "---\nname: local-input\ndescription: Local input validation fixture\n---\nInstructions",
  );
  f.open("Skills");
  f.activate("Add exact absolute skill path");
  f.input("relative/SKILL.md", "\r");
  assert.match(f.render(), /absolute skill path/);
  assert.match(f.render(), /skills:.*relative\/SKILL.md/);
  assert.equal(f.controller.pending.length, 0);
  assert.equal((await f.disk()).general.skills, undefined);
  f.input("\t"); // Invalid blur must not move focus to the rail or abandon this Input.
  assert.match(f.render(), /relative\/SKILL.md/);
  f.input("\x05", "\x15", skill, "\r");
  await f.controller.settled();
  assert.deepEqual((await f.disk()).general.skills, [skill]);
  f.activate("Add exact absolute skill path");
  f.input(skill, "\r");
  assert.match(f.render(), /already included/);
  assert.equal(f.controller.pending.length, 0);
  f.input("\x1b");
  f.input("1");
  f.open("Reviewed tools");
  f.activate("Add exact reviewed leaf name");
  f.input("reviewed_leaf", "\r");
  await f.controller.settled();
  f.activate("Add exact reviewed leaf name");
  f.input("reviewed_leaf", "\r");
  assert.match(f.render(), /already included/);
  assert.equal(f.controller.pending.length, 0);
  f.input("\x05", "\x15", "another_leaf", "\r");
  await f.controller.settled();
  assert.deepEqual((await f.disk()).general.leafTools, ["reviewed_leaf", "another_leaf"]);
});

test("resize Escape cancels hidden single-line/multiline/catalog input before navigation and never saves", async (t) => {
  const f = await inspector(t);
  let writes = 0;
  const rename = fs.rename;
  t.mock.method(fs, "rename", async (...args: Parameters<typeof fs.rename>) => {
    writes++;
    return rename(...args);
  });
  for (const [setting, field] of [
    ["Description", "Edit description"],
    ["Instructions", "Edit instructions (prompt)"],
    ["Models", "+ Add fallback…"],
  ]) {
    f.open(setting);
    f.activate(field);
    f.input("cancel hidden input");
    f.resize(20, 6);
    f.render();
    f.input("\r", "\x1b");
    assert.equal(f.exit().exited, false, `${field}: first Escape must not close`);
    assert.equal(f.controller.pending.length, 0);
    f.resize(100, 24);
    assert.doesNotMatch(f.render(), /cancel hidden input/);
    assert.equal((await f.disk()).general.description, "Global description");
    assert.equal((await f.disk()).general.prompt, "Global instructions");
  }
  await f.controller.settled();
  assert.equal(writes, 0);
});

test("empty description and multiline prompt remain valid explicit item commits", async (t) => {
  const f = await inspector(t);
  f.open("Description");
  f.activate("Edit description");
  f.input("\x05", "\x15", "\r");
  f.open("Instructions");
  f.activate("Edit instructions (prompt)");
  f.input("\x01", "\x0b", "\r");
  await f.controller.settled();
  assert.equal(f.controller.status, "saved");
  assert.equal((await f.disk()).general.description, "");
  assert.equal((await f.disk()).general.prompt, "");
});

test("compact overview is browsing-only; focused model targets keep exact identity and route controls separate", async (t) => {
  const f = await inspector(t, { general: { models: [a, b], fallback: [a, b], tools: [] } });
  let writes = 0;
  const rename = fs.rename;
  t.mock.method(fs, "rename", async (...args: Parameters<typeof fs.rename>) => {
    writes++;
    return rename(...args);
  });
  const initial = f.render();
  assert.match(initial, /Editing GLOBAL/);
  assert.match(initial, /Description/);
  assert.match(initial, /Instructions/);
  assert.doesNotMatch(initial, /Last verified|Earlier|Remove from chain|Reset chain|GLOBAL REACH/);
  assert.match(initial, /Models +fixture\/a ⦸ off · \+1 fallback/);
  f.open("Models");
  assert.match(f.render(), /❯ fixture\/a +⦸ off/);
  assert.match(f.render(), /  ↳ fixture\/b:high/);
  assert.match(f.render(), /Friendly Alpha · fixture\/a · off/);
  assert.doesNotMatch(f.render(), /Earlier|Change supported effort|Remove from chain/);
  f.input("down");
  assert.match(f.render(), /❯ ↳ fixture\/b:high/);
  assert.match(f.render(), /Friendly Beta · fixture\/b · high/);
  f.input("\x1b");
  assert.match(f.render(), /› Models/);
  f.open("Tools");
  assert.match(f.render(), /explicit empty grant; denies all/);
  f.input("\x1b");
  assert.match(f.render(), /› Tools/);
  await f.controller.settled();
  assert.equal(writes, 0);
  assert.equal(f.controller.pending.length, 0);
  assert.deepEqual((await f.disk()).general.fallback, [a, b]);
});

test("same-friendly-name unavailable saved routes retain exact selected-target identity and recovery overrides nested help", async (t) => {
  const f = await inspector(t, { general: { models: [a, b], fallback: [a, b] } });
  f.setMetadata({ entries: models.entries.map((e) => ({ ...e, name: "Same friendly name" })) });
  f.open("Models");
  f.go("↳ fixture/b:high");
  assert.match(f.render(), /Same friendly name · fixture\/b · high/);
  f.setMetadata({ entries: [] });
  assert.match(f.render(), /❯ ↳ fixture\/b:high ⚠ unavailable/);
  assert.match(f.render(), /⚠ Unavailable in accessible catalog/);
  f.input("x");
  await f.controller.settled();
  assert.deepEqual((await f.disk()).general.fallback, [a]);
  assert.deepEqual((await f.disk()).general.models, [a, b]);
  const open = fs.open;
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    if (String(args[0]).endsWith(".tmp")) throw new Error("injected before replacement");
    return open(...args);
  });
  f.open("Instructions");
  f.activate("Edit instructions (prompt)");
  f.input("replacement instructions", "\r");
  await f.controller.settled();
  f.input("\t", "down", "\t");
  f.go("Retry same action");
  assert.match(f.render(), /general.prompt.*Not saved|general.prompt.*unsaved/);
  f.activate("Revert · discard");
  assert.equal(f.controller.pending.length, 0);
  assert.deepEqual(
    (await f.disk()).general.fallback,
    [a],
    "earlier verified route save survives recovery",
  );
});

test("route-level disclosures follow selection and distinguish Disable from inherited Reset before autosave", async (t) => {
  const f = await inspector(t, { general: { models: [a, b], fallback: [a, b] } });
  f.open("Models");
  assert.doesNotMatch(f.render(), /Keeps exact model grants|Reset removes this layer/);
  f.go("Disable chain");
  assert.match(f.render(), /Keeps exact model grants/);
  assert.match(f.render(), /Disables fallback.*selected parent model/);
  assert.match(f.render(), /permissions[\s│]*may deny dispatch/);
  assert.equal(f.controller.pending.length, 0);
  f.input("\r");
  await f.controller.settled();
  assert.equal((await f.disk()).general.fallback, false);
  assert.deepEqual((await f.disk()).general.models, [a, b]);
  f.go("Reset chain to inherited");
  assert.match(f.render(), /Reset removes this layer's fallback/);
  f.input("\r");
  await f.controller.settled();
  assert.equal(Object.hasOwn((await f.disk()).general, "fallback"), false);
  assert.deepEqual((await f.disk()).general.models, [a, b]);
});

test("very long unavailable saved model identity stays inspectable and removable through bounded target rows", async (t) => {
  const target = { ...a, id: "long-saved-model-".repeat(300) + "EXACT-TAIL" };
  const f = await inspector(t, { general: { models: [target], fallback: [target] } });
  f.setMetadata({ entries: [] });
  f.resize(80, 28);
  f.open("Models");
  assert.match(f.render(), /❯ …\/long-saved-model-.*… ⚠ unavailable +⦸ off/);
  // j reveals one line at a time; at the end the last viewport holds the remaining lines.
  const seen: string[] = [];
  for (let i = 0; i < 120; i++) {
    const frame = f.render().split("\n");
    if (frame[5] === seen.at(-1)) {
      seen.push(...frame.slice(6));
      break;
    }
    seen.push(frame[5]!);
    f.input("j");
  }
  const all = seen.join("").replace(/[\s│]/g, "");
  assert.ok(all.includes(`Exact:fixture/${target.id}·off`));
  assert.ok(all.includes("xsavesfallback:false.Keepsexactmodelgrants"));
  f.go("…/long-saved-model");
  f.input("x");
  await f.controller.settled();
  assert.equal((await f.disk()).general.fallback, false);
  assert.deepEqual(
    (await f.disk()).general.models,
    [target],
    "display clipping never normalizes exact identity or revokes the grant",
  );
});

test("paused mutations still allow read-only nested target and delegation inspection without replaying the failed intent", async (t) => {
  const f = await inspector(t, { general: { models: [a], fallback: [a] } });
  const open = fs.open;
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    if (String(args[0]).endsWith(".tmp")) throw new Error("synthetic write failure");
    return open(...args);
  });
  f.open("Description");
  f.activate("Edit description");
  f.input("\x05", "\x15", "Pending description", "\r");
  await f.controller.settled();
  assert.equal(f.controller.status, "not-saved");
  f.open("Models");
  assert.match(f.render(), /❯ fixture\/a +⦸ off/);
  f.input("x", "\x1b[C", "]");
  assert.match(f.render(), /Read-only/);
  assert.equal(f.controller.pending.length, 1);
  f.open("Delegation");
  f.activate("Spawn targets (spawn):");
  assert.match(f.render(), /\[disabled: Read-only\]/);
  f.go("[x] scout");
  f.input(" ");
  assert.equal(f.controller.pending.length, 1);
  assert.equal((await f.disk()).general.description, undefined);
});

test("production-sized model flow browses eligible rows, promotes the first target and preserves the unchained default", async (t) => {
  const f = await inspector(t, { general: { model: b, models: [a, b], fallback: [a] } });
  f.setMetadata({
    entries: [
      models.entries[0],
      {
        ...models.entries[0],
        id: "blocked",
        name: "Hidden Scope Model",
        efforts: [{ effort: "off", reason: "Outside current session model/effort scope" }],
      },
      models.entries[1],
    ],
  });
  for (const [width, height] of [
    [72, 25],
    [120, 36],
  ]) {
    f.resize(width, height);
    f.open("Models");
    f.activate("+ Add fallback…");
    assert.doesNotMatch(f.render(), /Models · resize|Hidden Scope Model/);
    assert.match(f.render(), /1 model hidden: session scope/);
    // Both models hold grants, so no divider separates them.
    assert.match(f.render(), /❯ fixture\/a[^\n]*\n[^\n]*│ {3}fixture\/b/);
    f.input("down");
    assert.match(f.render(), /❯ fixture\/b/);
    f.input("up", "down");
    assert.match(f.render(), /❯ fixture\/b/);
    f.input("\r");
    assert.match(f.render(), /Effort: \[◕ high\]/);
    assert.equal(f.controller.pending.length, 0);
    if (width === 72) f.input("\x1b", "\x1b"); // Effort strip, then the picker.
  }
  f.input("\r");
  await f.controller.settled();
  assert.equal(f.controller.status, "saved");
  assert.deepEqual((await f.disk()).general.fallback, [a, b]);
  assert.deepEqual((await f.disk()).general.model, b);
  assert.match(f.render(), /  fixture\/a +⦸ off/);
  assert.match(f.render(), /❯ ↳ fixture\/b:high/, "selection follows the added target");
  f.open("Advanced");
  assert.match(f.render(), /Default is the first entry in Models/);
  f.input("\x1b[F");
  assert.doesNotMatch(f.render(), /Choose model|Reset model/);
  assert.equal(f.controller.pending.length, 0);
  f.open("Models");
  f.go("↳ fixture/b:high");
  f.input("[");
  await f.controller.settled();
  assert.deepEqual((await f.disk()).general.fallback, [b, a]);
  assert.deepEqual((await f.disk()).general.model, b);
  assert.match(f.render(), /❯ fixture\/b +◕ high/, "selection follows the moved target");
  f.input("\x1b[3~"); // Delete
  await f.controller.settled();
  assert.match(f.render(), /❯ fixture\/a +⦸ off/, "selection moves to the next row");
  assert.doesNotMatch(f.render(), /↳/);
  f.go("Disable chain");
  assert.match(f.render(), /Disables fallback.*Friendly Beta/);
  f.input("\r");
  await f.controller.settled();
  assert.equal((await f.disk()).general.fallback, false);
  assert.deepEqual((await f.disk()).general.model, b);
  assert.deepEqual((await f.disk()).general.models, [a, b]);
  f.open("Advanced");
  f.go("Choose model from exact grants");
  assert.match(f.render(), /model: Friendly Beta/);
  assert.equal(f.controller.status, "saved");
});

test("production overlay retains eligible results and confirmation when mixed hidden reasons wrap", async (t) => {
  const f = await inspector(t, { general: { models: [a], fallback: [a] } });
  f.setMetadata({
    entries: [
      { ...models.entries[0], efforts: [{ effort: "off" }] },
      {
        ...models.entries[0],
        id: "scoped",
        efforts: [{ effort: "off", reason: "Outside current session model/effort scope" }],
      },
      {
        ...models.entries[0],
        id: "unavailable",
        efforts: [
          { effort: "off", reason: "Unavailable physical model metadata or configured access" },
        ],
      },
      models.entries[1],
    ],
  });
  f.resize(72, 25);
  f.open("Models");
  f.activate("+ Add fallback…");
  const rendered = f.render();
  assert.doesNotMatch(rendered, /Models · resize/);
  assert.match(rendered, /3 models hidden: already present, session scope/);
  assert.match(rendered.replace(/[│\s]+/g, " "), /unavailable metadata\/access/);
  assert.match(rendered, /\^R refresh/);
  f.input("down");
  assert.match(f.render(), /❯ fixture\/b/);
  f.input("\r");
  assert.match(f.render(), /Effort: \[◕ high\]/);
  f.input("\r");
  await f.controller.settled();
  assert.equal(f.controller.status, "saved");
  assert.deepEqual((await f.disk()).general.fallback, [a, b]);
});

test("physical 80×24 Global Add uses the production 90% overlay and accepts every supported effort", async (t) => {
  for (const [index, effort] of EFFORTS.entries())
    await t.test(effort, async (t) => {
      const f = await inspector(t);
      f.setMetadata({
        entries: [
          {
            provider: "fixture",
            id: "all-effort-target",
            name: "All effort model",
            providerLabel: "Fixture Provider",
            efforts: EFFORTS.map((effort) => ({ effort })),
          },
        ],
      });
      f.resize(Math.floor(80 * 0.9), Math.floor(24 * 0.9));
      f.open("Models");
      f.activate("+ Add fallback…");
      assert.doesNotMatch(f.render(), /Models · resize/);
      assert.match(f.render().replace(/[│\s]+/g, " "), /Grant permits explicit overrides too/);
      assert.match(f.render(), /All effort model/);
      assert.match(f.render(), /other workspaces/);
      f.input("all-effort", "\r");
      for (let i = 0; i < index; i++) f.input("\x1b[C");
      assert.equal(f.controller.pending.length, 0);
      assert.match(f.render(), new RegExp(`\\[. ${effort}\\]`));
      f.input("\x1bOP"); // F1 exposes complete secondary metadata without leaving the picker.
      let details = f.render();
      for (let i = 0; i < 30; i++) {
        f.input("j");
        details += f.render();
      }
      for (const supported of EFFORTS)
        assert.ok(details.includes(`· ${supported}`), `${supported} must remain inspectable`);
      assert.match(details, /fixture\/all-effort-target/);
      f.input("\r");
      assert.equal(
        f.controller.pending.length,
        0,
        "Enter in metadata details cannot accept a hidden selection",
      );
      f.input("\x1b", "\r");
      await f.controller.settled();
      const target = { provider: "fixture", id: "all-effort-target", effort };
      assert.deepEqual((await f.disk()).general.fallback, [target]);
      assert.deepEqual((await f.disk()).general.models, [target]);
      assert.equal(f.controller.status, "saved");
    });
});

const ctrlLeft = "\x1b[1;5D";

test("native Ctrl+Left edits text; multiline Tab keeps an owned draft across profile browsing; Resume submits once; Escape cancels only the active buffer", async (t) => {
  const f = await inspector(t);
  let writes = 0;
  const rename = fs.rename;
  t.mock.method(fs, "rename", async (...args: Parameters<typeof fs.rename>) => {
    writes++;
    return rename(...args);
  });
  f.open("Description");
  f.activate("Edit description");
  f.input("\x05", "\x15", "ab cd", ctrlLeft, "X");
  assert.equal(f.controller.pending.length, 0);
  f.input("\t"); // Existing single-line blur commit, exactly once.
  await f.controller.settled();
  assert.equal((await f.disk()).general.description, "ab Xcd");
  assert.equal(writes, 1);
  f.input("\t");
  f.open("Models");
  f.activate("+ Add fallback…");
  f.input("ab cd", ctrlLeft, "X");
  assert.match(f.render().replaceAll(/\x1b_pi:\/?f?c\x07/g, ""), /🔍 > ab Xcd/);
  assert.equal(f.controller.pending.length, 0);
  f.input("\x1b");
  f.open("Instructions");
  f.activate("Edit instructions (prompt)");
  f.input("\x01", "\x0b", "draft one two", ctrlLeft, "X");
  assert.equal(f.exit().exited, false);
  f.input("\t", "down"); // Suspend, then browse scout in the rail.
  let output = f.render();
  assert.match(output, /Subagent Profiles \/ scout .*1 unsaved draft/);
  assert.match(output, /general \[draft\]/);
  assert.match(output, /Resume Global general\.prompt draft/);
  assert.equal(f.controller.pending.length, 0);
  f.open("Instructions");
  f.activate("Edit instructions (prompt)");
  f.input("\x01", "\x0b", "scout abandoned", "\x1b"); // Cancels only scout's active buffer.
  assert.match(f.render(), /Resume Global general\.prompt draft/);
  assert.doesNotMatch(f.render(), /scout\.prompt/);
  f.activate("Resume Global general.prompt draft");
  output = f.render().replaceAll(/\x1b_pi:\/?f?c\x07/g, "");
  assert.match(output, /Subagent Profiles \/ general/);
  assert.match(output, /draft one Xtwo/);
  f.input("\r");
  assert.deepEqual(
    f.controller.pending.map(({ profile, field }) => `${profile}.${field}`),
    ["general.prompt"],
  );
  await f.controller.settled();
  assert.equal((await f.disk()).general.prompt, "draft one Xtwo");
  assert.equal((await f.disk()).scout, undefined);
  assert.equal(writes, 2);
  assert.doesNotMatch(f.render(), /unsaved draft|Resume Global/);
  // Opening without changing creates no draft or exit prompt.
  f.open("Instructions");
  f.activate("Edit instructions (prompt)");
  f.input("\t", "\t", "\x1b", "\x1b");
  assert.equal(f.exit().exited, true);
});

test("an earlier save failure retains another draft; repeated failures, Retry and Revert never submit it; Reload asks with draft and queued counts", async (t) => {
  const f = await inspector(t);
  const reload = t.mock.method(f.controller, "reload");
  const open = fs.open;
  let fail = true;
  const gate = deferred();
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    if (fail && String(args[0]).endsWith(".tmp")) {
      await gate.promise;
      throw new Error("injected permission failure");
    }
    return open(...args);
  });
  f.input("\t", "down", "\t");
  f.open("Description");
  f.activate("Edit description");
  f.input("\x05", "\x15", "scout change", "\r");
  assert.equal(f.controller.pending.length, 1);
  f.input("\t", "up", "\t");
  f.open("Instructions");
  f.activate("Edit instructions (prompt)");
  f.input("\x01", "\x0b", "general draft");
  f.resize(72, 21); // Recovery + Resume + Reload disposition at physical 80×24 baseline.
  gate.resolve();
  await f.controller.settled();
  assert.equal(f.controller.status, "not-saved");
  let output = f.render();
  assert.match(output, /1 unsaved drafts retained · Resume below; never auto-submitted/);
  assert.match(output, /› Retry same action/);
  assert.equal(f.controller.pending.length, 1);
  // Retained text is readable/editable while frozen, but submission never enqueues.
  f.activate("Resume Global general.prompt draft");
  f.input("\r");
  assert.match(f.render(), /Not saved: editing is paused or read-only; text kept/);
  assert.match(f.render(), /general draft/);
  assert.equal(f.controller.pending.length, 1);
  f.input("\t");
  f.activate("Retry same action"); // Repeated failure notification.
  await f.controller.settled();
  assert.equal(f.controller.status, "not-saved");
  assert.equal(f.controller.pending.length, 1);
  f.go("Resume Global general.prompt draft");
  assert.match(f.render(), /Resume Global general\.prompt draft/);
  f.activate("Revert");
  assert.equal(f.controller.pending.length, 0);
  assert.match(f.render(), /Resume Global general\.prompt draft/);
  assert.equal((await f.disk()).scout, undefined);
  assert.equal((await f.disk()).general.prompt, "Global instructions");
  // External edit makes the next failure Reload-only.
  fail = false;
  await fs.writeFile(f.projectPath, JSON.stringify({ review: { description: "external" } }));
  f.open("Description");
  f.activate("Edit description");
  f.input("\x05", "\x15", "conflicted", "\r");
  await f.controller.settled();
  assert.equal(f.controller.status, "reload-required");
  f.activate("Reload · abandon 1 unsaved changes + 1 drafts");
  output = f.render();
  assert.match(output, /Reload would discard 1 unsaved draft/);
  assert.match(output, /Global general\.prompt: general draft/);
  assert.match(output, /Reload also abandons 1 queued unsaved changes/);
  assert.match(output, /› Keep drafts and return \(default\)/);
  f.input("\r"); // Default keeps; no Reload.
  assert.equal(f.controller.status, "reload-required");
  f.go("Resume Global general.prompt draft");
  assert.match(f.render(), /Resume Global general\.prompt draft/);
  f.activate("Reload · abandon");
  f.input("\x1b"); // Escape also keeps.
  assert.equal(f.controller.status, "reload-required");
  f.activate("Reload · abandon");
  f.activate("Discard 1 draft and continue: Reload");
  assert.equal(reload.mock.callCount(), 1);
  await reload.mock.calls[0]!.result; // Await the UI-triggered reopen, not event-loop turns.
  assert.equal(f.controller.status, "saved");
  assert.equal(f.controller.pending.length, 0);
  assert.doesNotMatch(f.render(), /Resume Global|unsaved draft/);
  assert.equal((await f.disk()).general.description, "Global description");
});

test("close, destination, structural and field reset ask keep-or-discard for owned drafts; unrelated toggles do not", async (t) => {
  const f = await inspector(t);
  const draft = () => {
    f.open("Instructions");
    f.activate("Edit instructions (prompt)");
    f.input("\x01", "\x0b", "keep me", "\t", "\t");
  };
  draft();
  f.open("Tools");
  f.activate("[x] write"); // Unrelated toggle saves immediately without a prompt.
  assert.equal(f.controller.pending.length, 1);
  await f.controller.settled();
  f.input("1", "\x1b");
  assert.match(f.render(), /Close would discard 1 unsaved draft/);
  f.input("\t", "2", "\r"); // Modal: Tab/group jumps ignored; Enter is the default keep.
  assert.equal(f.exit().exited, false);
  assert.match(f.render(), /Resume Global general\.prompt draft/);
  f.open("Instructions");
  f.activate("Reset prompt to inherited");
  assert.match(f.render(), /Reset prompt would discard 1 unsaved draft/);
  f.input("\x1b");
  assert.equal(f.controller.pending.length, 0);
  f.activate("Reset prompt to inherited");
  f.activate("Discard 1 draft and continue: Reset prompt");
  assert.deepEqual(f.controller.pending.at(-1), {
    destination: "global",
    profile: "general",
    field: "prompt",
    action: "reset",
  });
  await f.controller.settled();
  assert.doesNotMatch(f.render(), /Resume Global/);
  draft();
  f.open("Advanced");
  f.activate("Create / copy custom role");
  assert.match(f.render(), /Structural transaction would discard 1 unsaved draft/);
  f.input("\r");
  assert.equal(f.exit().exited, false);
  f.activate("Change destination");
  assert.match(f.render(), /Change destination would discard 1 unsaved draft/);
  f.activate("Discard 1 draft and continue: Change destination");
  assert.deepEqual(f.exit(), {
    exited: true,
    result: { profile: "general", action: "destination" },
  });
  assert.equal((await f.disk()).general.prompt, undefined);
});

test("physical 80×24 overlay keeps draft decision usable; subminimum resize preserves drafts with accurate Escape hints", async (t) => {
  const f = await inspector(t);
  f.resize(72, 21);
  f.open("Instructions");
  f.activate("Edit instructions (prompt)");
  f.input("\x01", "\x0b", "baseline draft");
  const footer = f.render().split("\n").at(-2)!;
  assert.match(footer, /enter: commit · Tab: keep draft · escape\/ctrl\+c: discard text/);
  assert.doesNotMatch(footer, /\.\.\.|…/);
  f.input("\t", "\t");
  f.resize(54, 14); // Physical 60×16 under the 90% overlay.
  assert.match(f.render(), /1 drafts kept/);
  assert.match(f.render(), /escape\/ctrl\+c: back/);
  f.input("\x1b");
  assert.match(f.render(), /Enlarge to resume or discard drafts/);
  f.input("\x1b", "\r");
  assert.equal(f.exit().exited, false);
  f.resize(72, 21);
  f.input("\x1b");
  const output = f.render();
  assert.match(output, /Close would discard 1 unsaved draft/);
  assert.match(output, /› Keep drafts and return/);
  assert.match(output, /Discard 1 draft and continue: Close/);
  assert.match(output, /escape\/ctrl\+c keep drafts/);
  f.activate("Discard 1 draft and continue: Close");
  assert.deepEqual(f.exit(), { exited: true, result: undefined });
  assert.equal((await f.disk()).general.prompt, "Global instructions");
});

test("trust loss keeps an active Project draft readable without enqueueing or reading untrusted layers", async (t) => {
  const f = await inspector(t, undefined, {}, "project");
  f.open("Instructions");
  f.activate("Edit instructions (prompt)");
  f.input("\x01", "\x0b", "project draft");
  f.setTrusted(false);
  f.input("\r");
  assert.match(f.render(), /Not saved: editing is paused or read-only; text kept/);
  assert.match(f.render(), /project draft/);
  assert.equal(f.controller.pending.length, 0);
  f.input("\t");
  assert.match(f.render(), /Resume Project general\.prompt draft/);
  assert.deepEqual(JSON.parse(await fs.readFile(f.projectPath, "utf8")), {});
});

test("successful Retry keeps an interrupted invalid exact entry and never enqueues it; correction stays bound to its owner", async (t) => {
  const f = await inspector(t);
  const open = fs.open;
  const gate = deferred();
  let fail = true;
  t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
    if (fail && String(args[0]).endsWith(".tmp")) {
      await gate.promise;
      throw new Error("first save fails");
    }
    return open(...args);
  });
  f.open("Description");
  f.activate("Edit description");
  f.input("\x05", "\x15", "accepted", "\r");
  f.input("\t", "down", "\t");
  f.open("Skills");
  f.activate("Add exact absolute skill path");
  f.input("relative invalid entry");
  gate.resolve();
  await f.controller.settled();
  assert.equal(f.controller.pending.length, 1);
  f.activate("Resume Global scout.skills draft");
  assert.match(f.render(), /relative invalid entry/);
  assert.match(f.render(), /Paused · Tab: keep draft · escape\/ctrl\+c: discard text/);
  f.input("\r", "\t"); // Paused: no validation enqueue or blur save.
  assert.equal(f.controller.pending.length, 1);
  fail = false;
  f.activate("Retry same action");
  await f.controller.settled();
  assert.equal((await f.disk()).general.description, "accepted");
  assert.equal((await f.disk()).scout, undefined);
  assert.equal(f.controller.pending.length, 0);
  assert.match(f.render(), /Resume Global scout.skills draft/);
  f.activate("Resume Global scout.skills draft");
  f.input("\t"); // Recovered: original single-line validation still retains invalid entry.
  assert.match(f.render(), /Use an exact absolute skill path/);
  assert.match(f.render(), /relative invalid entry/);
  assert.equal(f.controller.pending.length, 0);
  const skill = join(f.root, "SKILL.md");
  await fs.writeFile(skill, "---\nname: resumed\ndescription: Resumed fixture\n---\nInstructions");
  f.input("\x05", "\x15", skill, "\r");
  assert.equal(f.controller.pending.at(-1)?.profile, "scout");
  await f.controller.settled();
  assert.deepEqual((await f.disk()).scout.skills, [skill]);
});

test("frozen multiline native submit preserves exact whitespace; confirmed draft discard remains discarded when Reload fails", async (t) => {
  const f = await inspector(t);
  const reload = t.mock.method(f.controller, "reload");
  f.open("Instructions");
  f.activate("Edit instructions (prompt)");
  f.input("\x01", "\x0b", "  exact buffer  ", "\t", "\t");
  await fs.writeFile(f.projectPath, JSON.stringify({ review: { description: "external" } }));
  f.open("Description");
  f.activate("Edit description");
  f.input("\x05", "\x15", "conflicted", "\r");
  await f.controller.settled();
  assert.equal(f.controller.status, "reload-required");
  f.activate("Resume Global general.prompt draft");
  f.input("\r", "\t", "\t");
  f.activate("Resume Global general.prompt draft");
  // The preserved native buffer includes both leading and trailing spaces even after paused Enter.
  const plain = f.render().replaceAll(/\x1b_pi:\/?f?c\x07/g, "");
  assert.match(plain, /  exact buffer {2}/);
  f.input("\t", "\t");
  f.activate("Reload · abandon");
  assert.match(f.render(), /exact buffer   \(16 chars\)/);
  await fs.writeFile(f.projectPath, "{ malformed");
  f.activate("Discard 1 draft and continue: Reload");
  assert.equal(reload.mock.callCount(), 1);
  await reload.mock.calls[0]!.result;
  assert.ok(f.controller.reloadError);
  assert.equal(f.controller.status, "read-only");
  assert.equal(f.controller.pending.length, 0);
  assert.doesNotMatch(f.render(), /Resume Global|unsaved draft/);
  f.activate("Close");
  assert.equal(f.exit().exited, true);
});

test("baseline long exact grant has a bounded revoke label and readable full identity, leaving unrelated grants", async (t) => {
  const long = {
    provider: "fixture",
    id: "long-" + "x".repeat(140) + "終".repeat(240),
    effort: "off" as const,
  };
  const f = await inspector(t, { general: { models: [long, a], tools: [] } });
  f.resize(72, 21);
  f.open("Advanced");
  f.activate("Exact model grants:");
  f.go("Remove grant:");
  assert.match(f.render(), /› Remove grant:/);
  let all = "";
  for (let i = 0; i < 100; i++) {
    all += f.render().split("\n")[5];
    f.input("j");
  }
  assert.ok(all.replace(/[\s│]/g, "").includes(long.id));
  f.go("Remove grant:");
  f.input("\r");
  await f.controller.settled();
  assert.deepEqual((await f.disk()).general.models, [a]);
});

test("representative profile/model component checkpoint at production baseline, wide and subminimum restore", async (t) => {
  const f = await inspector(t, { general: { models: [a], fallback: [a] } });
  f.setMetadata({
    entries: [
      { ...models.entries[0], efforts: [{ effort: "off" }] },
      models.entries[1],
      {
        ...models.entries[0],
        id: "scope",
        efforts: [{ effort: "off", reason: "Outside current session scope" }],
      },
      {
        ...models.entries[0],
        id: "unavailable",
        efforts: [{ effort: "off", reason: "Unavailable metadata/access " + "detail ".repeat(50) }],
      },
    ],
  });
  for (const [width, height] of [
    [72, 21],
    [90, 27],
  ]) {
    f.resize(width, height);
    f.open("Models");
    f.activate("+ Add fallback…");
    assert.doesNotMatch(f.render(), /Models · resize/);
    assert.match(f.render(), /Friendly Beta/);
    f.input("\x1bOP");
    assert.match(f.render(), /Model details/);
    f.input("\x1b", "down", "\r");
    const ready = f.render();
    assert.match(ready, /Add and grant/);
    f.resize(54, 14);
    assert.match(f.render(), /resize/);
    f.input("\r");
    assert.equal(f.controller.pending.length, 0);
    f.resize(width, height);
    assert.match(f.render(), /Add and grant/);
    f.input("\x1b", "\x1b");
    assert.equal(f.controller.pending.length, 0);
  }
  assert.deepEqual((await f.disk()).general.fallback, [a]);
});

test("checkbox Space is a once-only autosave alias; contextual hints and configured confirm stay truthful", async (t) => {
  const remapped = {
    matches: (data: string, action: string) =>
      action === "tui.select.confirm" ? data === "\x07" : keys.matches(data, action),
    getKeys: (action: string) =>
      action === "tui.select.confirm"
        ? ["ctrl+g" as const]
        : action === "tui.input.submit"
          ? ["enter" as const]
          : ["escape" as const],
  };
  const f = await inspector(
    t,
    { general: { tools: ["read"], models: [a] } },
    {},
    "global",
    undefined,
    remapped,
  );
  f.resize(72, 21);
  assert.match(f.render(), /ctrl\+g: Open setting/);
  f.go("Tools");
  f.input("\x07");
  f.go("[x] read");
  assert.match(f.render(), /Space.*Toggle and save/);
  let enqueued = 0;
  const enqueue = f.controller.enqueue.bind(f.controller);
  f.controller.enqueue = (intent) => {
    enqueued++;
    return enqueue(intent);
  };
  f.input(" ");
  await f.controller.settled();
  assert.equal(enqueued, 1);
  assert.deepEqual((await f.disk()).general.tools, []);
  f.input("\x07");
  await f.controller.settled();
  assert.equal(enqueued, 2);
  assert.deepEqual((await f.disk()).general.tools, ["read"]);
  f.input("down", "up");
  assert.equal(enqueued, 2);
  f.resize(72, 17); // Dense rows fit at 72×21; shorten so line scrolling can hide the row.
  for (let i = 0; i < 20; i++) f.input("j");
  assert.doesNotMatch(f.render(), /\[x\] read/);
  f.input(" "); // A scrolled-away selected checkbox is not an actionable footprint.
  assert.equal(enqueued, 2);
  f.resize(72, 21);
  f.go("Reset tools to inherited");
  assert.match(f.render(), /ctrl\+g: Reset and save/);
  f.input(" ");
  assert.equal(enqueued, 2);
  f.resize(54, 14);
  f.screen.handleInput?.(" ");
  f.screen.handleInput?.("\x07");
  assert.equal(enqueued, 2);
  f.resize(72, 21);
  f.input("1");
  f.go("Models");
  f.input(" ");
  assert.doesNotMatch(f.render(), /Add fallback|🔍/);
  assert.equal(enqueued, 2);
  f.go("Description");
  f.input("\x07");
  assert.match(f.render(), /ctrl\+g: Edit text/);
  f.go("Edit description");
  f.input("\x07");
  assert.match(f.render(), /enter.*commit/);
  f.input(" ", "j", "k", "?");
  assert.match(f.render(), / j k\?| jk\?/);
  f.input("\x1b");
  assert.equal(enqueued, 2);
});

test("rail keeps the shown profile identifiable, path keeps its file name and dense groups fit 80×24", async (t) => {
  const f = await inspector(t);
  // Wide: settings focus still marks the profile whose settings are shown.
  assert.match(f.render(), /│ • general /);
  assert.doesNotMatch(f.render(), /[›•] scout/);
  f.input("\t", "down");
  assert.match(f.render(), /│ › scout /);
  f.input("\t");
  assert.match(f.render(), /│ • scout /);
  // Production 80×24 overlay: the file name survives truncation and the overview keeps
  // every Profile/Model/Access setting through Delegation visible without scrolling.
  f.resize(40, 21);
  assert.match(f.render(), /…[^│]*delegation\.json │/);
  f.resize(72, 21);
  const frame = f.render();
  for (const label of ["Description", "Instructions", "Models", "Tools", "Skills", "Delegation"])
    assert.match(frame, new RegExp(`[ ›] ${label} `), label);
  assert.doesNotMatch(frame, /· settings|· rail/);
});

const right = "\x1b[C",
  left = "\x1b[D",
  shiftUp = "\x1b[1;2A",
  shiftDown = "\x1b[1;2B";
const cLow = { provider: "fixture", id: "c", effort: "low" as const };
const cHigh = { ...cLow, effort: "high" as const };
const withC: ProfileModelCatalog = {
  entries: [
    ...models.entries,
    {
      provider: "fixture",
      id: "c",
      name: "Friendly Gamma",
      providerLabel: "Custom Fixture",
      efforts: [
        { effort: "off" },
        { effort: "minimal", reason: "Outside current session model/effort scope" },
        { effort: "low" },
        { effort: "medium" },
        { effort: "high" },
      ],
    },
  ],
};
function countIntents(f: Awaited<ReturnType<typeof inspector>>) {
  const intents: unknown[] = [];
  const enqueue = f.controller.enqueue.bind(f.controller);
  f.controller.enqueue = (intent) => {
    intents.push(intent);
    return enqueue(intent);
  };
  return intents;
}

test("chain rows stage efforts in memory: eligible-only, same-model skip, discard paths and one replace-target per save", async (t) => {
  const f = await inspector(t, {
    general: { models: [cLow, a, cHigh], fallback: [cLow, a, cHigh] },
  });
  f.setMetadata(withC);
  const intents = countIntents(f);
  f.open("Models");
  const panel = f.render();
  assert.match(panel, /Models · override/);
  assert.match(panel, /❯ fixture\/c +◔ low │/);
  assert.match(panel, /│ {3}↳ fixture\/a:off +│/);
  assert.match(panel, /│ {3}↳ fixture\/c:high +│/);
  assert.match(panel, /\+ Add fallback…[^\n]*\n[^\n]*─{20}[^\n]*\n[^\n]*Disable chain/);
  assert.match(panel, /Friendly Gamma · fixture\/c · low/);
  assert.match(
    panel,
    /⏎ replace · ←\/→ effort · ⇧↑\/↓ \[ \] move · x remove · f add · ⎋\/ctrl\+c back/,
  );
  f.input(right);
  assert.match(f.render(), /❯ fixture\/c +\[◑ medium\] · unsaved · adds grant │/);
  assert.match(
    f.render().replace(/[│\s]+/g, " "),
    /Unsaved effort low → medium · adds exact grant/,
  );
  assert.match(f.render(), /⏎ save effort · ←\/→ effort · ⎋\/ctrl\+c discard/);
  f.input(right); // high is routed by fallback 2, so medium stays the last choice.
  assert.match(f.render(), /\[◑ medium\]/);
  f.input(left);
  assert.doesNotMatch(f.render(), /unsaved/, "returning to the saved effort stages nothing");
  f.input(left); // minimal is ineligible in this session.
  assert.match(f.render(), /\[⦸ off\] · unsaved · adds grant/);
  f.input("\x1b");
  assert.doesNotMatch(f.render(), /unsaved/);
  assert.match(f.render(), /Models · override/, "Escape with a preview only discards it");
  f.input(right, "down");
  assert.doesNotMatch(f.render(), /unsaved/);
  f.input("up", right, "1");
  f.open("Models");
  assert.doesNotMatch(f.render(), /unsaved/, "group jumps discard");
  f.input(right, "\t", "down", "up", "\t");
  assert.doesNotMatch(f.render(), /unsaved/, "profile switches discard");
  f.input(right, "f");
  assert.match(f.render(), /Adding to general chain/);
  f.input("\x1b");
  assert.doesNotMatch(f.render(), /unsaved/, "opening the picker discards");
  assert.equal(intents.length, 0);
  f.input("\x1b");
  assert.match(f.render(), /› Models/, "Escape without a preview returns to the overview");
  f.open("Models");
  f.input(right, "\r");
  await f.controller.settled();
  assert.deepEqual(intents, [
    {
      destination: "global",
      profile: "general",
      field: "fallback",
      action: "replace-target",
      target: cLow,
      replacement: { ...cLow, effort: "medium" },
    },
  ]);
  const saved = (await f.disk()).general;
  assert.deepEqual(saved.fallback, [{ ...cLow, effort: "medium" }, a, cHigh]);
  assert.deepEqual(saved.models, [cLow, a, cHigh, { ...cLow, effort: "medium" }]);
  assert.match(f.render(), /❯ fixture\/c +◑ medium │/, "selection follows the replacement");
  f.input("down", "down", left); // medium is now routed by the default, so low is next.
  assert.match(
    f.render(),
    /❯ ↳ fixture\/c:high +\[◔ low\] · unsaved │/,
    "granted: no grant notice",
  );
});

test("chain row keys move, remove and refuse at boundaries; unavailable rows stay movable/removable", async (t) => {
  const f = await inspector(t, { general: { models: [cLow, a, b], fallback: [cLow, a, b] } });
  f.setMetadata(withC);
  const intents = countIntents(f);
  f.open("Models");
  f.input(shiftUp);
  assert.match(f.render(), /Already first/);
  f.input("]");
  await f.controller.settled();
  assert.deepEqual((await f.disk()).general.fallback, [a, cLow, b]);
  assert.match(f.render(), /❯ ↳ fixture\/c:low/, "selection follows the moved target");
  f.setMetadata({ entries: models.entries });
  assert.match(f.render(), /❯ ↳ fixture\/c:low ⚠ unavailable/);
  f.input(right);
  assert.match(f.render(), /Unavailable in accessible catalog/);
  f.input(shiftDown);
  await f.controller.settled();
  assert.deepEqual((await f.disk()).general.fallback, [a, b, cLow]);
  f.input(shiftDown);
  assert.match(f.render(), /Already last/);
  assert.doesNotMatch(f.render(), /x saves fallback:false/);
  f.input("x");
  await f.controller.settled();
  assert.deepEqual((await f.disk()).general.fallback, [a, b]);
  assert.match(f.render(), /❯ \+ Add fallback…/, "selection moves to the add row after the last");
  f.go("fixture/a");
  f.input("\x1b[3~");
  await f.controller.settled();
  assert.match(f.render(), /❯ fixture\/b +◕ high/, "selection moves to the next row");
  assert.match(f.render(), /x saves fallback:false\. Keeps exact model grants\. Disables fallback/);
  f.input("x");
  await f.controller.settled();
  assert.equal((await f.disk()).general.fallback, false);
  assert.deepEqual((await f.disk()).general.models, [cLow, a, b]);
  assert.match(f.render(), /— unchained → selected parent model/);
  assert.equal(intents.length, 5);
});

test("Enter replaces a chain target in place through the picker with any accessible selection not in the chain", async (t) => {
  const f = await inspector(t, { general: { models: [a, b], fallback: [a, b] } });
  f.setMetadata(withC);
  const intents = countIntents(f);
  f.open("Models");
  f.go("↳ fixture/b:high");
  f.input(right, "\r");
  const picker = f.render();
  assert.match(picker, /Replacing fallback 1 in general/);
  assert.doesNotMatch(picker, /unsaved/);
  // Granted models first; b's only effort is already routed, so it is hidden.
  assert.match(picker, /❯ fixture\/a[^\n]*\n[^\n]*─{20}[^\n]*\n[^\n]*fixture\/c/);
  assert.match(picker, /1 model hidden: already present/);
  f.input("\r");
  assert.match(f.render(), /Effort: ⦸ off  \[◕ high\]/, "a:off is already in the chain");
  f.input("\x1b", "\x1b");
  assert.match(f.render(), /❯ ↳ fixture\/b:high/);
  assert.equal(intents.length, 0);
  f.input("\r", "gamma", "\r");
  // A different model keeps the replaced target's effort level (high) when eligible there.
  assert.match(f.render(), /Effort: .*\[◕ high\]/);
  f.input(left);
  assert.match(f.render(), /Effort: .*\[◑ medium\]/);
  assert.match(f.render(), /Replace in place and grant/);
  f.input("\r");
  await f.controller.settled();
  const medium = { ...cLow, effort: "medium" as const };
  assert.deepEqual(intents, [
    {
      destination: "global",
      profile: "general",
      field: "fallback",
      action: "replace-target",
      target: b,
      replacement: medium,
    },
  ]);
  assert.deepEqual((await f.disk()).general.fallback, [a, medium]);
  assert.deepEqual((await f.disk()).general.models, [a, b, medium]);
  assert.match(f.render(), /❯ ↳ fixture\/c:medium/);
  f.input("up", "\r");
  assert.match(f.render(), /Replacing default in general/);
});

test("64 grants limit staged efforts and replacement to existing grants", async (t) => {
  const fillers = Array.from({ length: 62 }, (_, i) => ({
    provider: "fixture",
    id: `filler-${i}`,
    effort: "off" as const,
  }));
  const cOff = { ...cLow, effort: "off" as const };
  const f = await inspector(t, { general: { models: [cLow, cOff, ...fillers], fallback: [cLow] } });
  f.setMetadata(withC);
  f.open("Models");
  f.input(right);
  assert.doesNotMatch(f.render(), /unsaved/, "medium/high would need a 65th grant");
  f.input(left);
  assert.match(f.render(), /\[⦸ off\] · unsaved │/);
  f.input("\r");
  await f.controller.settled();
  assert.deepEqual((await f.disk()).general.fallback, [cOff]);
  assert.equal((await f.disk()).general.models.length, 64);
  f.input("\r");
  assert.match(f.render(), /Replacing default in general/);
  assert.match(f.render(), /❯ fixture\/c/);
  f.input("\r");
  // off is the routed target; the still-granted low is preselected so no grant is needed.
  assert.match(f.render(), /Effort: ⦸ off  ◌ minimal  \[◔ low\]/);
  f.input(right);
  assert.match(f.render(), /Not authorized by exact grants/);
  f.input("\x1b", "\x1b");
  assert.equal(f.controller.pending.length, 0);
});

test("64 chain targets disable add from any row; Project destination refuses every non-removal key with today's reasons", async (t) => {
  const targets = Array.from({ length: 64 }, (_, i) => ({
    provider: "fixture",
    id: `t${i}`,
    effort: "off" as const,
  }));
  const f = await inspector(t, { general: { models: targets, fallback: targets } });
  f.open("Models");
  f.input("f");
  assert.match(f.render(), /Maximum 64 chain targets/);
  assert.doesNotMatch(f.render(), /🔍/);
  const p = await inspector(t, { general: { models: [a, b], fallback: [a, b] } }, {}, "project");
  p.setMetadata(models);
  const intents = countIntents(p);
  p.open("Models");
  for (const [key, reason] of [
    [right, "Project cannot choose a different exact target"],
    [left, "Project cannot choose a different exact target"],
    ["\r", "Project cannot choose a different exact target"],
    [shiftDown, "Operator order only; change to Global"],
    ["]", "Operator order only; change to Global"],
    ["f", "Change destination to Global; inherited prewalk cannot be bypassed"],
  ]) {
    p.input(key);
    assert.match(p.render().replace(/[│\s]+/g, " "), new RegExp(reason), key);
    assert.doesNotMatch(p.render(), /unsaved|🔍/);
  }
  assert.equal(intents.length, 0);
  p.input("x");
  await p.controller.settled();
  assert.equal(intents.length, 1);
  assert.deepEqual(JSON.parse(await fs.readFile(p.projectPath, "utf8")).general.fallback, [b]);
});

test("unchained placeholder and prewalk compound add label; Models bounds at 72×25, 72×21 and 120×36", async (t) => {
  const f = await inspector(t, { general: { model: b, models: [a, b], prewalk: a } });
  f.open("Models");
  assert.match(
    f.render().replace(/[│\s]+/g, " "),
    /— unchained → fixture\/b:high · prewalk fixture\/a:off configured · current permissions may deny dispatch/,
  );
  assert.match(f.render(), /❯ \+ Switch from prewalk and add…/);
  f.input("f");
  assert.match(f.render(), /Switching general from prewalk/);
  f.input("\x1b");
  const g = await inspector(t, { general: { models: [cLow, a, b], fallback: [cLow, a, b] } });
  g.setMetadata(withC);
  for (const [width, height] of [
    [72, 25],
    [72, 21], // Production 80×24 overlay.
    [120, 36],
  ]) {
    g.resize(width, height);
    g.open("Models");
    g.input(right); // render() checks bounds() for every frame.
    const frame = g.render();
    assert.match(frame, /❯ fixture\/c +\[◑ medium\] · unsaved · adds grant/);
    assert.match(frame, /↳ fixture\/b:high/);
    assert.match(frame, /⏎ save effort/);
    g.input("\x1b");
    assert.match(g.render(), /x remove · f add/);
  }
});
