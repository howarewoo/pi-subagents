import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters as stripAnsi } from "node:util";
import { visibleWidth, oklchColor, type Component } from "@earendil-works/pi-tui";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  createProfileEditorScreen,
  runProfileEditor,
  profilePermissionChanges,
  profileSaveReview,
} from "../src/profile-editor.ts";
import { ProfileConfigDraft, type ProfileDraftOptions } from "../src/profile-config.ts";
import { bundledProfiles } from "../src/profiles.ts";

const keys = {
  matches: (data: string, action: string) =>
    data ===
    (
      {
        "tui.select.cancel": "\x1b",
        "tui.select.confirm": "\r",
        "tui.select.up": "up",
        "tui.select.down": "down",
        "tui.select.pageUp": "pgup",
        "tui.select.pageDown": "pgdown",
      } as Record<string, string>
    )[action],
  getKeys: (action: string) =>
    action === "tui.select.confirm" ? ["enter" as const] : ["escape" as const],
};
const theme = {
  fg: (_color: string, text: string) => text,
  style: (text: string) => text,
  colors: { customMessageBg: oklchColor(0.2, 0, 0) },
};
const choose = (index: number) => [...Array(index).fill("down"), "\r"];
function bounds(lines: string[], width: number, height: number) {
  assert.ok(lines.length <= height, `${lines.length} > ${height}`);
  for (const line of lines) {
    assert.ok(visibleWidth(line) <= width, `${visibleWidth(line)} > ${width}: ${line}`);
    assert.doesNotMatch(stripAnsi(line), /\x1b|\n|\r/);
  }
}
function allDetails(component: Component, width = 100): string {
  const pages: string[] = [];
  let previous = "";
  for (let count = 0; count < 100; count++) {
    const page = stripAnsi(component.render(width).join("\n"));
    pages.push(page);
    // Reassemble wrapped detail text (paths may legitimately span several terminal rows).
    const detailLines = page
      .split("\n")
      .map((line) =>
        (line.includes(" │ ") ? line.split(" │ ").at(-1)! : line).replace(/^│ | │$/g, "").trim(),
      );
    pages.push(detailLines.join(""), detailLines.join(" "));
    if (page === previous) break;
    previous = page;
    component.handleInput?.("pgdown");
  }
  component.handleInput?.("\x1b[H");
  return pages.join("\n");
}
function compare(t: TestContext, label: string, component: Component) {
  for (const width of [100, 52]) {
    const lines = component.render(width);
    t.diagnostic(`${label} at ${width} columns\n${stripAnsi(lines.join("\n"))}`);
  }
  component.render(100);
}
async function files(t: TestContext) {
  const root = await fs.mkdtemp(join(tmpdir(), "profile-editor-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(join(root, "operator"));
  await fs.mkdir(join(root, ".pi"));
  const globalPath = join(root, "operator", "delegation.json"),
    projectPath = join(root, ".pi", "delegation.json");
  const global = {
    general: {
      description: "Global description",
      prompt: "Global instructions",
      tools: ["read", "write"],
    },
  };
  const project = { general: { prompt: "Project instructions", tools: ["read"] } };
  await fs.writeFile(globalPath, JSON.stringify(global));
  await fs.writeFile(projectPath, JSON.stringify(project));
  const options: ProfileDraftOptions = {
    cwd: root,
    operatorDir: join(root, "operator"),
    isProjectTrusted: () => true,
    coordinator: { profileUsage: () => [] },
  };
  return { root, globalPath, projectPath, global, project, options };
}
type Step = {
  title: RegExp;
  input: string[] | { choice: string };
  inspect?: (component: Component, detail: string) => void | Promise<void>;
};
function dialogs(
  steps: Step[],
  text: { prompt?: string; description?: string; inputs?: (string | undefined)[] } = {},
) {
  let nextInput = 0;
  let driverError: unknown;
  let active = false,
    screen = 0,
    prompts = 0,
    descriptions = 0;
  const context = {
    mode: "tui",
    ui: {
      custom: async (
        factory: (
          tui: unknown,
          theme: unknown,
          keys: unknown,
          done: (choice: string | undefined) => void,
        ) => Component | Promise<Component>,
      ) => {
        if (driverError) throw driverError;
        try {
          assert.equal(active, false, "previous interaction disposed before next dialog");
          active = true;
          let result: string | undefined,
            finished = false;
          const terminal = { rows: 30 };
          const component = await factory(
            { terminal, requestRender() {} },
            theme,
            keys,
            (choice) => {
              finished = true;
              result = choice;
              active = false;
            },
          );
          const step = steps[screen++];
          assert.ok(step, "unexpected custom screen");
          for (const [width, rows] of [
            [100, 30],
            [52, 30],
            [20, 6],
            [100, 7],
          ]) {
            terminal.rows = rows;
            bounds(component.render(width), width, Math.max(1, Math.floor(rows * 0.9)));
          }
          terminal.rows = 30;
          const initial = component.render(100);
          bounds(initial, 100, 27);
          assert.match(initial.join("\n"), step.title);
          const detail = allDetails(component);
          await step.inspect?.(component, detail);
          if (Array.isArray(step.input))
            for (const input of step.input) component.handleInput?.(input);
          else {
            let found = false;
            for (let count = 0; count < 160; count++) {
              const rendered = allDetails(component, 160);
              if (rendered.includes(`Selected action: ${step.input.choice}`)) {
                found = true;
                break;
              }
              component.handleInput?.("down");
            }
            assert.ok(found, `Choice not reachable: ${step.input.choice}`);
            component.handleInput?.("\r");
          }
          assert.equal(finished, true, `screen did not finish: ${initial[0]}`);
          return result;
        } catch (error) {
          active = false;
          driverError = error;
          throw error;
        }
      },
      editor: async (title: string, prefill: string) => {
        assert.equal(active, false, "viewer must not own native prompt keys");
        assert.match(title, /Prompt/);
        assert.equal(prefill, "Project instructions");
        prompts++;
        return text.prompt;
      },
      input: async (title: string) => {
        assert.equal(active, false, "viewer must not own native description keys");
        if (title.includes("description")) {
          descriptions++;
          return text.description;
        }
        assert.ok(
          text.inputs && nextInput < text.inputs.length,
          `Unexpected native input: ${title}`,
        );
        return text.inputs[nextInput++];
      },
    },
  } as unknown as Pick<ExtensionCommandContext, "mode" | "ui">;
  return {
    context,
    assertFinished() {
      assert.equal(screen, steps.length);
      if (text.inputs) assert.equal(nextInput, text.inputs.length);
      return { prompts, descriptions };
    },
  };
}

test("representative command flow edits native text, keeps dirty drafts, reviews then explicitly saves one file", async (t) => {
  const f = await files(t);
  const original = await fs.readFile(f.globalPath, "utf8");
  const prompt =
    "Multiline edited instructions\nUnicode 路径 é 👩‍💻\nj is prompt text, not a scroll key";
  const d = dialogs(
    [
      {
        title: /Subagent Profiles/,
        input: ["\r"],
        inspect: (_c, text) => {
          compare(t, "Resolved landing", _c);
          assert.match(text, /Source: bundled/);
          assert.ok(text.includes(f.globalPath));
          assert.match(text, /No write destination selected/);
        },
      },
      {
        title: /Choose write destination/,
        input: choose(2),
        inspect: (_c, text) => {
          compare(t, "Destination", _c);
          assert.ok(text.includes(f.projectPath));
          assert.match(text, /Global edits affect other workspaces/);
        },
      },
      {
        title: /Edit general.*project.*clean/,
        input: choose(1),
        inspect: (_c, text) => {
          compare(t, "Instruction form", _c);
          assert.match(text, /Selected-layer value: <unset \/ inherited>/);
          assert.match(text, /Inherited baseline: "Global description"/);
        },
      },
      {
        title: /Edit general.*unsaved/,
        input: choose(5),
        inspect: (_c, text) => assert.ok(text.includes("j is prompt text")),
      },
      {
        title: /Review profile save/,
        input: ["\r"],
        inspect: async (_c, text) => {
          compare(t, "Save review", _c);
          assert.match(text, /Raw selected-layer changes/);
          assert.match(text, /general.prompt/);
          assert.match(text, /No effective permission additions\/removals/);
          assert.ok(text.includes(f.projectPath));
          assert.match(text, /Retained prompts are not rewritten/);
          assert.match(text, /Callable tools are unknown/);
          assert.deepEqual(JSON.parse(await fs.readFile(f.projectPath, "utf8")), f.project);
        },
      },
      { title: /Edit general.*unsaved/, input: ["\x1b"] },
      { title: /Unsaved profile draft/, input: ["\r"] },
      {
        title: /Edit general.*unsaved/,
        input: ["\r"],
        inspect: (_c, text) => assert.ok(text.includes("j is prompt text")),
      },
      {
        title: /Edit general.*unsaved/,
        input: choose(5),
        inspect: (_c, text) => assert.match(text, /Selected-layer value: ""/),
      },
      { title: /Review profile save/, input: choose(1) },
      {
        title: /Edit general.*clean/,
        input: ["\x1b"],
        inspect: (_c, text) => {
          assert.match(text, /Saved and verified:/);
          assert.ok(text.includes(f.projectPath));
        },
      },
      {
        title: /Subagent Profiles/,
        input: ["\x1b"],
        inspect: (_c, text) => assert.ok(text.includes("Multiline edited instructions")),
      },
    ],
    { prompt, description: "" },
  );
  await runProfileEditor(d.context, f.options);
  assert.deepEqual(d.assertFinished(), { prompts: 1, descriptions: 1 });
  assert.equal(await fs.readFile(f.globalPath, "utf8"), original);
  assert.deepEqual(JSON.parse(await fs.readFile(f.projectPath, "utf8")), {
    general: { ...f.project.general, prompt, description: "" },
  });
});

test("dirty scope/role switching defaults to keep; explicit discard never saves and requires destination selection", async (t) => {
  const f = await files(t);
  const d = dialogs(
    [
      { title: /Subagent Profiles/, input: ["e"] },
      { title: /Choose write destination/, input: choose(2) },
      { title: /Edit general/, input: ["\r"] },
      { title: /Edit general.*unsaved/, input: choose(6) },
      { title: /Unsaved profile draft/, input: ["\x1b"] },
      {
        title: /Edit general.*unsaved/,
        input: choose(7),
        inspect: (_c, text) => assert.ok(text.includes("unsaved description")),
      },
      { title: /Unsaved profile draft/, input: choose(1) },
      { title: /Choose profile/, input: choose(1) },
      {
        title: /Choose write destination/,
        input: choose(1),
        inspect: (_c, text) => assert.match(text, /Role: scout/),
      },
      { title: /Edit scout.*global.*clean/, input: ["\x1b"] },
      { title: /Subagent Profiles/, input: ["\x1b"] },
    ],
    { description: "unsaved description" },
  );
  await runProfileEditor(d.context, f.options);
  d.assertFinished();
  assert.deepEqual(JSON.parse(await fs.readFile(f.globalPath, "utf8")), f.global);
  assert.deepEqual(JSON.parse(await fs.readFile(f.projectPath, "utf8")), f.project);
});

test("reset review names exact configured permission additions/removals without claiming callability", async (t) => {
  const f = await files(t);
  const d = dialogs([
    { title: /Subagent Profiles/, input: ["e"] },
    { title: /Choose write destination/, input: choose(2) },
    { title: /Edit general/, input: choose(4) },
    { title: /Edit general.*unsaved/, input: choose(5) },
    {
      title: /Review profile save/,
      input: choose(1),
      inspect: (_c, text) => {
        assert.match(text, /general.tools/);
        assert.match(text, /added: "write"/);
        assert.match(text, /removed: none/);
        assert.match(text, /Callable tools are unknown/);
      },
    },
    { title: /Edit general.*clean/, input: ["\x1b"] },
    { title: /Subagent Profiles/, input: ["\x1b"] },
  ]);
  await runProfileEditor(d.context, f.options);
  d.assertFinished();
  assert.deepEqual(JSON.parse(await fs.readFile(f.projectPath, "utf8")), {});
});

test("conflict UI retains edits by default; reload requires explicit discard and never force-overwrites", async (t) => {
  const f = await files(t);
  const external = { general: { prompt: "external change", tools: ["read"] } };
  const d = dialogs(
    [
      { title: /Subagent Profiles/, input: ["e"] },
      { title: /Choose write destination/, input: choose(2) },
      { title: /Edit general/, input: ["\r"] },
      {
        title: /Edit general.*unsaved/,
        input: choose(5),
        inspect: async () => {
          await fs.writeFile(f.projectPath, JSON.stringify(external));
        },
      },
      {
        title: /Profile configuration error/,
        input: ["\r"],
        inspect: (_c, text) => {
          compare(t, "Conflict recovery", _c);
          assert.match(text, /conflict/);
          assert.match(text, /Replacement: not-attempted/);
          assert.match(text, /draft retained|Draft retained/);
          assert.doesNotMatch(text, /Force overwrite/);
        },
      },
      {
        title: /Edit general.*unsaved/,
        input: choose(5),
        inspect: (_c, text) => assert.match(text, /retain me/),
      },
      { title: /Profile configuration error/, input: choose(1) },
      { title: /Unsaved profile draft/, input: ["\r"] },
      {
        title: /Edit general.*unsaved/,
        input: choose(5),
        inspect: (_c, text) => assert.match(text, /retain me/),
      },
      { title: /Profile configuration error/, input: choose(1) },
      { title: /Unsaved profile draft/, input: choose(1) },
      {
        title: /Edit general.*clean/,
        input: ["\x1b"],
        inspect: (_c, text) => {
          assert.match(text, /Reloaded current disk/);
          assert.match(text, /external change/);
          assert.doesNotMatch(text, /retain me/);
        },
      },
      { title: /Subagent Profiles/, input: ["\x1b"] },
    ],
    { description: "retain me" },
  );
  await runProfileEditor(d.context, f.options);
  d.assertFinished();
  assert.deepEqual(JSON.parse(await fs.readFile(f.projectPath, "utf8")), external);
});

test("untrusted destinations and malformed files have no interactive write route; non-TUI is guarded", async (t) => {
  const f = await files(t);
  f.options.isProjectTrusted = () => false;
  const d = dialogs([
    { title: /Subagent Profiles/, input: ["e"] },
    {
      title: /Choose write destination/,
      input: ["\r"],
      inspect: (_c, text) => {
        assert.match(text, /Project editing disabled/);
        assert.doesNotMatch(text, /→ Trusted project settings/);
      },
    },
    { title: /Subagent Profiles/, input: ["\x1b"] },
  ]);
  await runProfileEditor(d.context, f.options);
  d.assertFinished();
  for (const mode of ["rpc", "json", "print"] as const)
    await assert.rejects(runProfileEditor({ ...d.context, mode }, f.options), /native TUI/);
  await fs.writeFile(f.globalPath, "{broken");
  const bad = dialogs([
    {
      title: /Profile configuration error/,
      input: ["\x1b"],
      inspect: (_c, text) => {
        assert.ok(text.includes(f.globalPath));
        assert.match(text, /repair|Repair/);
      },
    },
  ]);
  await runProfileEditor(bad.context, f.options);
  bad.assertFinished();
  assert.equal(await fs.readFile(f.globalPath, "utf8"), "{broken");
});

test("representative screens stay safe and bounded across wide/narrow/tiny/short resize; hidden Enter cannot save", async (t) => {
  const f = await files(t);
  const draft = await ProfileConfigDraft.open("global", f.options);
  draft.value.general = {
    ...f.global.general,
    prompt: "Edited 路径\nline ".repeat(40),
    tools: ["read"],
  };
  const review = profileSaveReview(draft, await draft.validate());
  const views = [
    {
      title: "Choose write destination",
      lines: [
        `Global: ${f.globalPath}`,
        `Project: ${f.projectPath}`,
        "Project editing requires host trust. No file selected yet.",
      ],
      choices: [
        { value: "back", label: "Back" },
        { value: "global", label: "Global" },
        { value: "project", label: "Trusted project" },
      ],
    },
    {
      title: "Edit general · project · unsaved",
      lines: [
        `Exact path: ${f.projectPath}`,
        "Definition source: bundled",
        "Selected-layer prompt: explicit",
        "Inherited baseline: Global instructions",
        "Effective workspace value:",
        "Unicode 路径 é 👩‍💻\n".repeat(35) + "FINAL EFFECTIVE VALUE",
        "\x1b]0;BAD TITLE\x07\x1b[31mcontrol text",
      ],
      choices: [
        { value: "prompt", label: "Edit prompt" },
        { value: "review", label: "Review / Save" },
      ],
    },
    {
      title: "Profile configuration error",
      lines: [
        `Conflict ${f.projectPath}`,
        "Draft retained. No automatic overwrite or rollback.",
        "Observed project: external change",
      ],
      choices: [
        { value: "keep", label: "Keep editing" },
        { value: "reload", label: "Reload / review disk" },
      ],
    },
    review,
  ];
  for (const view of views) {
    let height = 24,
      result: string | undefined;
    const component = createProfileEditorScreen(
      view,
      theme,
      keys,
      () => {},
      (choice) => {
        result = choice;
      },
      () => height,
    );
    for (const width of [100, 52]) {
      const lines = component.render(width);
      bounds(lines, width, height);
      component.handleInput?.("pgdown");
      bounds(component.render(width), width, height);
      component.handleInput?.("\x1b[H");
    }
    for (const [width, rows] of [
      [20, 6],
      [100, 7],
      [1, 1],
      [0, 1],
      [24, 12],
    ]) {
      height = rows;
      bounds(component.render(width), width, height);
      if (view === review && ((width === 20 && rows === 6) || (width === 100 && rows === 7)))
        t.diagnostic(
          `Review resize fallback ${width}x${rows}\n${stripAnsi(component.render(width).join("\n"))}`,
        );
      if (rows < 12 || width < 24) {
        component.handleInput?.("down");
        component.handleInput?.("\r");
        assert.equal(result, undefined);
      }
    }
    height = 24;
    component.render(100);
    const detail = allDetails(component);
    assert.doesNotMatch(detail, /\x1b|BAD TITLE/);
    if (view.title.startsWith("Edit")) assert.match(detail, /FINAL EFFECTIVE VALUE/);
    component.handleInput?.("\r");
    assert.equal(result, view.choices[0].value, "resize retained safe default selection");
  }
  assert.equal(draft.dirty, true, "resize did not mutate draft state");
  assert.deepEqual(JSON.parse(await fs.readFile(f.globalPath, "utf8")), f.global);
});

test("permission review distinguishes unset from empty model grants and includes routing policy changes", () => {
  const profiles = bundledProfiles();
  const narrowed = profiles.map((profile) =>
    profile.name === "general" ? { ...profile, models: [], tools: ["read" as const] } : profile,
  );
  const text = profilePermissionChanges(profiles, narrowed).join("\n");
  assert.match(text, /general.models: <unset \/ inherited> → \[\]/);
  assert.match(text, /removed:.*"write"/);
});

test("invalid reset keeps raw controls reachable through error/keep/discard instead of looping", async (t) => {
  const f = await files(t);
  const selection = { provider: "synthetic", id: "exact", effort: "off" };
  const global = { general: { models: [selection] } },
    project = { general: { models: [selection] } };
  await fs.writeFile(f.globalPath, JSON.stringify(global));
  await fs.writeFile(f.projectPath, JSON.stringify(project));
  const d = dialogs([
    { title: /Subagent Profiles/, input: ["e"] },
    { title: /Choose write destination/, input: choose(1) },
    { title: /Edit general/, input: choose(4) },
    {
      title: /Edit general.*unsaved/,
      input: choose(5),
      inspect: (_c, text) => {
        assert.match(text, /Effective preview unavailable \/ invalid/);
        assert.match(text, /Cannot mint model grants/);
        assert.match(text, /Raw controls remain editable/);
      },
    },
    { title: /Profile configuration error/, input: ["\r"] },
    {
      title: /Edit general.*unsaved/,
      input: ["\x1b"],
      inspect: (_c, text) => assert.match(text, /Raw controls remain editable/),
    },
    { title: /Unsaved profile draft/, input: choose(1) },
    { title: /Subagent Profiles/, input: ["\x1b"] },
  ]);
  await runProfileEditor(d.context, f.options);
  d.assertFinished();
  assert.deepEqual(JSON.parse(await fs.readFile(f.globalPath, "utf8")), global);
  assert.deepEqual(JSON.parse(await fs.readFile(f.projectPath, "utf8")), project);
});

test("structured exact rows repair an invalid reset and interdependent prewalk/fallback edits without pruning", async (t) => {
  const f = await files(t);
  const a = { provider: "synthetic", id: "exact", effort: "off" };
  await fs.writeFile(f.globalPath, JSON.stringify({ general: { models: [a] } }));
  await fs.writeFile(f.projectPath, JSON.stringify({ general: { models: [a] } }));
  const select = { choice: "synthetic/exact:off · unavailable metadata (fixture)" };
  const d = dialogs(
    [
      { title: /Subagent Profiles/, input: ["e"] },
      { title: /Choose write destination/, input: choose(1) },
      { title: /Edit general/, input: choose(4) },
      {
        title: /Edit general/,
        input: { choice: "Exact model allowlist" },
        inspect: (_c, text) => assert.match(text, /Effective preview unavailable/),
      },
      { title: /Exact model allowlist/, input: { choice: "Explicit empty grant []" } },
      { title: /Edit general/, input: { choice: "Exact model allowlist" } },
      { title: /Exact model allowlist/, input: { choice: "Add exact model grant" } },
      { title: /Exact model effort/, input: { choice: "off" } },
      { title: /Exact model allowlist/, input: { choice: "Apply exact model grants" } },
      { title: /Edit general.*clean/, input: { choice: "Prewalk target" } },
      { title: /Prewalk target/, input: select },
      { title: /Edit general/, input: { choice: "Ordered fallback chain" } },
      { title: /Ordered fallback chain/, input: { choice: "Append granted exact target" } },
      { title: /Choose exact authorized model/, input: select },
      { title: /Ordered fallback chain/, input: { choice: "Apply ordered chain" } },
      {
        title: /Edit general/,
        input: { choice: "Review / Save" },
        inspect: (_c, text) => assert.match(text, /fallback and prewalk cannot be combined/),
      },
      { title: /Profile configuration error/, input: ["\r"] },
      {
        title: /Edit general/,
        input: { choice: "Prewalk target" },
        inspect: (_c, text) => assert.match(text, /Raw controls remain editable/),
      },
      { title: /Prewalk target/, input: { choice: "Reset selected-layer setting" } },
      { title: /Edit general/, input: { choice: "Default model" } },
      { title: /Default model/, input: select },
      { title: /Edit general/, input: { choice: "Review / Save" } },
      { title: /Review profile save/, input: { choice: "Save this file" } },
      { title: /Edit general.*clean/, input: ["\x1b"] },
      { title: /Subagent Profiles/, input: ["\x1b"] },
    ],
    { inputs: ["synthetic", "exact"] },
  );
  await runProfileEditor(d.context, {
    ...f.options,
    modelStatus: () => "unavailable metadata (fixture)",
  });
  d.assertFinished();
  assert.deepEqual(JSON.parse(await fs.readFile(f.globalPath, "utf8")), {
    general: { models: [a], fallback: [a], model: a },
  });
  assert.deepEqual(JSON.parse(await fs.readFile(f.projectPath, "utf8")), {
    general: { models: [a] },
  });
});

test("one-time general copy confirms explicit skills, strips leaf privileges and deletes independently", async (t) => {
  const f = await files(t);
  const skill = join(f.root, "SKILL.md");
  await fs.writeFile(
    skill,
    "---\nname: explicit\ndescription: Explicit fixture skill\n---\nInstructions",
  );
  const global = { general: { tools: ["read"], skills: [skill], leafTools: ["reviewed"] } };
  await fs.writeFile(f.globalPath, JSON.stringify(global));
  await fs.writeFile(f.projectPath, "{}");
  let copied: Record<string, unknown> | undefined;
  const d = dialogs(
    [
      { title: /Subagent Profiles/, input: ["e"] },
      { title: /Choose write destination/, input: choose(1) },
      { title: /Edit general/, input: { choice: "Create / copy custom role" } },
      { title: /Independent custom definition/, input: { choice: "Copy resolved general once" } },
      {
        title: /Review one-time copied grants/,
        input: { choice: "Stage explicit one-time copy" },
        inspect: (_c, text) => {
          assert.ok(text.includes(skill));
          assert.match(text, /explicit grants/);
          assert.match(text, /NOT copied/);
        },
      },
      {
        title: /Edit docs-audit.*unsaved/,
        input: { choice: "Review / Save" },
        inspect: (_c, text) => assert.match(text, /Independent definition/),
      },
      { title: /Review profile save/, input: { choice: "Save this file" } },
      {
        title: /Edit docs-audit.*clean/,
        input: { choice: "Delete custom definition" },
        inspect: async () => {
          copied = JSON.parse(await fs.readFile(f.globalPath, "utf8")).customProfiles["docs-audit"];
          assert.equal(copied!.leafTools, undefined);
          assert.deepEqual(copied!.skills, [skill]);
        },
      },
      { title: /Review custom deletion/, input: { choice: "Stage definition deletion" } },
      { title: /Delete docs-audit.*staged/, input: { choice: "Review / Save" } },
      { title: /Review profile save/, input: { choice: "Save this file" } },
      { title: /Saved profile deletion/, input: ["\r"] },
      { title: /Subagent Profiles/, input: ["\x1b"] },
    ],
    { inputs: ["docs-audit"] },
  );
  await runProfileEditor(d.context, f.options);
  d.assertFinished();
  assert.ok(copied);
  assert.deepEqual(JSON.parse(await fs.readFile(f.globalPath, "utf8")), {
    ...global,
    customProfiles: {},
  });
});

test("explicit global ceiling authorization enables blank trusted local creation without minting spawn grants", async (t) => {
  const f = await files(t);
  const authorization = dialogs([
    { title: /Subagent Profiles/, input: ["e"] },
    { title: /Choose write destination/, input: choose(1) },
    { title: /Edit general/, input: { choice: "Authorize project-role ceilings" } },
    { title: /Operator project-role ceiling authorization/, input: { choice: "[ ] scout" } },
    {
      title: /Operator project-role ceiling authorization/,
      input: { choice: "Apply explicit selection" },
    },
    { title: /Edit general/, input: { choice: "Review / Save" } },
    { title: /Review profile save/, input: { choice: "Save this file" } },
    { title: /Edit general.*clean/, input: ["\x1b"] },
    { title: /Subagent Profiles/, input: ["\x1b"] },
  ]);
  await runProfileEditor(authorization.context, f.options);
  authorization.assertFinished();
  const global = await fs.readFile(f.globalPath, "utf8");
  const local = dialogs(
    [
      { title: /Subagent Profiles/, input: ["e"] },
      { title: /Choose write destination/, input: choose(2) },
      { title: /Edit general/, input: { choice: "Create / copy custom role" } },
      { title: /Choose project-local authority ceiling/, input: { choice: "scout" } },
      { title: /Independent custom definition/, input: { choice: "Blank independent definition" } },
      {
        title: /Edit local-audit/,
        input: { choice: "Builtin tools" },
        inspect: (_c, text) => assert.match(text, /Independent definition/),
      },
      {
        title: /Builtin tools/,
        input: { choice: "[ ] read" },
        inspect: (_c, text) => assert.doesNotMatch(text, /\[ \] write/),
      },
      { title: /Builtin tools/, input: { choice: "Apply explicit selection" } },
      { title: /Edit local-audit/, input: { choice: "Review / Save" } },
      { title: /Review profile save/, input: { choice: "Save this file" } },
      { title: /Edit local-audit.*clean/, input: ["\x1b"] },
      { title: /Subagent Profiles/, input: ["\x1b"] },
    ],
    { inputs: ["local-audit"] },
  );
  await runProfileEditor(local.context, f.options);
  local.assertFinished();
  const saved = JSON.parse(await fs.readFile(f.projectPath, "utf8")).customProfiles["local-audit"];
  assert.equal(saved.ceiling, "scout");
  assert.deepEqual(saved.tools, ["read"]);
  assert.deepEqual(saved.spawn, []);
  assert.deepEqual(saved.skills, []);
  assert.deepEqual(saved.coordination, []);
  assert.equal(await fs.readFile(f.globalPath, "utf8"), global);
});

test("finite permissions and exact skill/leaf lists stage explicit grants, never activate tools", async (t) => {
  const f = await files(t);
  const skill = join(f.root, "SKILL.md");
  await fs.writeFile(
    skill,
    "---\nname: controlled\ndescription: Controlled list fixture\n---\nInstructions",
  );
  const d = dialogs(
    [
      { title: /Subagent Profiles/, input: ["e"] },
      { title: /Choose write destination/, input: choose(1) },
      { title: /Edit general/, input: { choice: "Builtin tools" } },
      { title: /Builtin tools/, input: { choice: "[x] write" } },
      { title: /Builtin tools/, input: { choice: "Apply explicit selection" } },
      { title: /Edit general/, input: { choice: "Spawn targets" } },
      { title: /Spawn targets/, input: { choice: "[x] review" } },
      { title: /Spawn targets/, input: { choice: "Apply explicit selection" } },
      { title: /Edit general/, input: { choice: "Coordination actions" } },
      { title: /Coordination actions/, input: { choice: "[ ] message" } },
      { title: /Coordination actions/, input: { choice: "Apply explicit selection" } },
      { title: /Edit general/, input: { choice: "Exact skill paths" } },
      { title: /Exact skill paths/, input: { choice: "Add exact absolute skill path" } },
      { title: /Exact skill paths/, input: { choice: "Apply exact list" } },
      { title: /Edit general/, input: { choice: "General reviewed leaf tools" } },
      { title: /General reviewed leaf tools/, input: { choice: "Add reviewed leaf name" } },
      { title: /General reviewed leaf tools/, input: { choice: "Apply exact list" } },
      { title: /Edit general/, input: { choice: "Review / Save" } },
      { title: /Review profile save/, input: { choice: "Save this file" } },
      { title: /Edit general.*clean/, input: ["\x1b"] },
      { title: /Subagent Profiles/, input: ["\x1b"] },
    ],
    { inputs: [skill, "reviewed-leaf"] },
  );
  await runProfileEditor(d.context, f.options);
  d.assertFinished();
  const saved = JSON.parse(await fs.readFile(f.globalPath, "utf8")).general;
  assert.deepEqual(saved.tools, ["read"]);
  assert.deepEqual(saved.spawn, ["scout"]);
  assert.deepEqual(saved.coordination, ["message"]);
  assert.deepEqual(saved.skills, [skill]);
  assert.deepEqual(saved.leafTools, ["reviewed-leaf"]);
});

test("deletion UI requires explicit same-file reference removals and preserves blocked drafts on cancel", async (t) => {
  const f = await files(t);
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
  await fs.writeFile(f.globalPath, JSON.stringify(global));
  await fs.writeFile(f.projectPath, "{}");
  const d = dialogs([
    { title: /Subagent Profiles/, input: ["down", "down", "down", "down", "e"] },
    { title: /Choose write destination/, input: choose(1) },
    { title: /Edit audit/, input: { choice: "Delete custom definition" } },
    {
      title: /Review custom deletion/,
      input: { choice: "Remove owner.spawn reference" },
      inspect: (_c, text) => {
        assert.match(text, /Spawn grant still references/);
        assert.match(text, /Operator authorization/);
      },
    },
    { title: /Review custom deletion/, input: { choice: "Cancel deletion changes" } },
    { title: /Edit audit.*clean/, input: { choice: "Delete custom definition" } },
    { title: /Review custom deletion/, input: { choice: "Remove owner.spawn reference" } },
    { title: /Review custom deletion/, input: { choice: "Remove operator ceiling authorization" } },
    { title: /Review custom deletion/, input: { choice: "Stage definition deletion" } },
    { title: /Delete audit.*staged/, input: { choice: "Review / Save" } },
    { title: /Review profile save/, input: { choice: "Save this file" } },
    { title: /Saved profile deletion/, input: ["\r"] },
    { title: /Subagent Profiles/, input: ["\x1b"] },
  ]);
  await runProfileEditor(d.context, f.options);
  d.assertFinished();
  assert.deepEqual(JSON.parse(await fs.readFile(f.globalPath, "utf8")), {
    customProfiles: { owner: definition },
    projectRoleCeilings: [],
  });
});

test("project creation without operator authorization only explains prerequisite and writes nothing", async (t) => {
  const f = await files(t);
  const d = dialogs(
    [
      { title: /Subagent Profiles/, input: ["e"] },
      { title: /Choose write destination/, input: choose(2) },
      { title: /Edit general/, input: { choice: "Create / copy custom role" } },
      {
        title: /Choose project-local authority ceiling/,
        input: ["\r"],
        inspect: (_c, text) => assert.match(text, /No authorized ceilings/),
      },
      { title: /Edit general.*clean/, input: ["\x1b"] },
      { title: /Subagent Profiles/, input: ["\x1b"] },
    ],
    { inputs: ["local-audit"] },
  );
  await runProfileEditor(d.context, f.options);
  d.assertFinished();
  assert.deepEqual(JSON.parse(await fs.readFile(f.globalPath, "utf8")), f.global);
  assert.deepEqual(JSON.parse(await fs.readFile(f.projectPath, "utf8")), f.project);
});

test("registration-only UI reviews cross-project authority, lists absent conditional targets, and separately grants spawn", async (t) => {
  const f = await files(t);
  await fs.writeFile(f.globalPath, JSON.stringify({ projectRoleCeilings: ["scout"] }));
  await fs.writeFile(f.projectPath, "{}");
  const d = dialogs(
    [
      { title: /Subagent Profiles/, input: ["e"] },
      { title: /Choose write destination/, input: choose(1) },
      { title: /Edit general/, input: { choice: "Register project-local spawn targets" } },
      {
        title: /Global project-local spawn registrations/,
        input: { choice: "Register exact local name" },
        inspect: (_c, text) => {
          assert.match(text, /ALL trusted projects/);
          assert.match(text, /creates no profile/);
          assert.ok(text.includes(f.globalPath));
        },
      },
      { title: /Required ceiling for release-audit/, input: { choice: "scout" } },
      {
        title: /Global project-local spawn registrations/,
        input: { choice: "Apply exact registrations" },
      },
      { title: /Edit general/, input: { choice: "Review / Save" } },
      {
        title: /Review profile save/,
        input: { choice: "Save this file" },
        inspect: (_c, text) => {
          assert.match(text, /GLOBAL authorization projectSpawnTargets/);
          assert.match(text, /ALL trusted projects/);
          assert.match(text, /No effective permission additions/);
        },
      },
      {
        title: /Edit general.*clean/,
        input: { choice: "Spawn targets" },
        inspect: async () => {
          const value = JSON.parse(await fs.readFile(f.globalPath, "utf8"));
          assert.deepEqual(value.projectSpawnTargets, { "release-audit": "scout" });
          assert.equal(value.general, undefined, "registration-only save adds no parent grant");
        },
      },
      {
        title: /Spawn targets/,
        input: { choice: "[ ] release-audit [registered:scout; conditional trusted local]" },
      },
      { title: /Spawn targets/, input: { choice: "Apply explicit selection" } },
      { title: /Edit general/, input: { choice: "Review / Save" } },
      { title: /Review profile save/, input: { choice: "Save this file" } },
      { title: /Edit general.*clean/, input: ["\x1b"] },
      {
        title: /Subagent Profiles/,
        input: ["\x1b"],
        inspect: (_c, text) => {
          assert.match(text, /1\/4/);
          assert.doesNotMatch(text, /> release-audit/);
        },
      },
    ],
    { inputs: ["release-audit"] },
  );
  await runProfileEditor(d.context, f.options);
  d.assertFinished();
  assert.deepEqual(JSON.parse(await fs.readFile(f.globalPath, "utf8")).general.spawn, [
    "scout",
    "review",
    "release-audit",
  ]);
});

test("registration editing supports explicit empty/reset and restores raw correction after dangling spawn refs", async (t) => {
  const f = await files(t);
  await fs.writeFile(
    f.globalPath,
    JSON.stringify({
      projectRoleCeilings: ["scout"],
      projectSpawnTargets: { "release-audit": "scout" },
      general: { spawn: ["release-audit"] },
    }),
  );
  await fs.writeFile(f.projectPath, "{}");
  const d = dialogs([
    { title: /Subagent Profiles/, input: ["e"] },
    { title: /Choose write destination/, input: choose(1) },
    { title: /Edit general/, input: { choice: "Register project-local spawn targets" } },
    {
      title: /Global project-local spawn registrations/,
      input: { choice: "Explicit empty registrations {}" },
    },
    {
      title: /Edit general/,
      input: { choice: "Review / Save" },
      inspect: (_c, text) => assert.match(text, /Effective preview unavailable/),
    },
    { title: /Profile configuration error/, input: ["\r"] },
    { title: /Edit general/, input: { choice: "Spawn targets" } },
    { title: /Spawn targets/, input: { choice: "Explicit empty grant []" } },
    { title: /Edit general/, input: { choice: "Review / Save" } },
    { title: /Review profile save/, input: { choice: "Save this file" } },
    {
      title: /Edit general.*clean/,
      input: { choice: "Register project-local spawn targets" },
      inspect: async () =>
        assert.deepEqual(
          JSON.parse(await fs.readFile(f.globalPath, "utf8")).projectSpawnTargets,
          {},
        ),
    },
    {
      title: /Global project-local spawn registrations/,
      input: { choice: "Reset registration key" },
    },
    { title: /Edit general/, input: { choice: "Review / Save" } },
    { title: /Review profile save/, input: { choice: "Save this file" } },
    { title: /Edit general.*clean/, input: ["\x1b"] },
    { title: /Subagent Profiles/, input: ["\x1b"] },
  ]);
  await runProfileEditor(d.context, f.options);
  d.assertFinished();
  assert.equal(JSON.parse(await fs.readFile(f.globalPath, "utf8")).projectSpawnTargets, undefined);
});

test("custom ceiling deletion dialog tracks conditional spawn references after registration removal and can undo", async (t) => {
  const f = await files(t);
  const authority = {
    description: "Independent ceiling",
    prompt: "Explicit instructions",
    tools: ["read"],
    skills: [],
    spawn: [],
    coordination: [],
  };
  const global = {
    customProfiles: { authority },
    projectRoleCeilings: ["authority"],
    projectSpawnTargets: { "release-audit": "authority" },
    general: { spawn: ["release-audit"] },
  };
  await fs.writeFile(f.globalPath, JSON.stringify(global));
  await fs.writeFile(f.projectPath, "{}");
  const d = dialogs([
    { title: /Subagent Profiles/, input: ["down", "down", "down", "down", "e"] },
    { title: /Choose write destination/, input: choose(1) },
    { title: /Edit authority/, input: { choice: "Delete custom definition" } },
    { title: /Review custom deletion/, input: { choice: "Remove registration release-audit" } },
    {
      title: /Review custom deletion/,
      input: { choice: "Cancel deletion changes" },
      inspect: (_c, text) =>
        assert.match(text, /Explicitly remove conditional target release-audit/),
    },
    { title: /Edit authority.*clean/, input: { choice: "Delete custom definition" } },
    { title: /Review custom deletion/, input: { choice: "Remove registration release-audit" } },
    {
      title: /Review custom deletion/,
      input: { choice: "Remove general.spawn reference to release-audit" },
    },
    { title: /Review custom deletion/, input: { choice: "Remove operator ceiling authorization" } },
    { title: /Review custom deletion/, input: { choice: "Stage definition deletion" } },
    { title: /Delete authority.*staged/, input: { choice: "Undo deletion changes" } },
    { title: /Edit authority.*clean/, input: ["\x1b"] },
    { title: /Subagent Profiles/, input: ["\x1b"] },
  ]);
  await runProfileEditor(d.context, f.options);
  d.assertFinished();
  assert.deepEqual(JSON.parse(await fs.readFile(f.globalPath, "utf8")), global);
});

test("registration binding edits remain staged after a non-target conflict and discard never overwrites disk", async (t) => {
  const f = await files(t);
  const global = {
    projectRoleCeilings: ["scout", "review"],
    projectSpawnTargets: { "release-audit": "scout" },
  };
  await fs.writeFile(f.globalPath, JSON.stringify(global));
  await fs.writeFile(f.projectPath, "{}");
  const d = dialogs([
    { title: /Subagent Profiles/, input: ["e"] },
    { title: /Choose write destination/, input: choose(1) },
    { title: /Edit general/, input: { choice: "Register project-local spawn targets" } },
    {
      title: /Global project-local spawn registrations/,
      input: { choice: "Edit/remove release-audit" },
    },
    { title: /Required ceiling for release-audit/, input: { choice: "review" } },
    {
      title: /Global project-local spawn registrations/,
      input: { choice: "Apply exact registrations" },
    },
    {
      title: /Edit general/,
      input: { choice: "Review / Save" },
      inspect: async () =>
        fs.writeFile(
          f.projectPath,
          JSON.stringify({ general: { prompt: "external project edit" } }),
        ),
    },
    {
      title: /Profile configuration error/,
      input: ["\r"],
      inspect: (_c, text) => assert.match(text, /conflict/),
    },
    { title: /Edit general.*unsaved/, input: { choice: "Register project-local spawn targets" } },
    {
      title: /Global project-local spawn registrations/,
      input: ["\x1b"],
      inspect: (_c, text) => assert.match(text, /release-audit → review/),
    },
    { title: /Edit general/, input: ["\x1b"] },
    { title: /Unsaved profile draft/, input: choose(1) },
    { title: /Subagent Profiles/, input: ["\x1b"] },
  ]);
  await runProfileEditor(d.context, f.options);
  d.assertFinished();
  assert.deepEqual(JSON.parse(await fs.readFile(f.globalPath, "utf8")), global);
});

test("copying a registered local definition strips resolver authority metadata and retains the chosen ceiling", async (t) => {
  const f = await files(t);
  const definition = {
    description: "Independent local",
    prompt: "Independent instructions",
    tools: ["read"],
    skills: [],
    spawn: [],
    coordination: [],
    ceiling: "scout",
  };
  await fs.writeFile(
    f.globalPath,
    JSON.stringify({
      projectRoleCeilings: ["scout"],
      projectSpawnTargets: { "release-audit": "scout" },
    }),
  );
  await fs.writeFile(
    f.projectPath,
    JSON.stringify({ customProfiles: { "release-audit": definition } }),
  );
  const d = dialogs(
    [
      { title: /Subagent Profiles/, input: ["down", "down", "down", "down", "e"] },
      { title: /Choose write destination/, input: choose(1) },
      { title: /Edit release-audit/, input: { choice: "Create / copy custom role" } },
      { title: /Choose project-local authority ceiling/, input: { choice: "scout" } },
      {
        title: /Independent custom definition/,
        input: { choice: "Copy resolved release-audit once" },
      },
      { title: /Review one-time copied grants/, input: { choice: "Stage explicit one-time copy" } },
      { title: /Edit copied-local/, input: { choice: "Review / Save" } },
      { title: /Review profile save/, input: { choice: "Save this file" } },
      { title: /Edit copied-local.*clean/, input: ["\x1b"] },
      { title: /Subagent Profiles/, input: ["\x1b"] },
    ],
    { inputs: ["copied-local"] },
  );
  await runProfileEditor(d.context, f.options);
  d.assertFinished();
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
  assert.deepEqual(copied.spawn, []);
});
