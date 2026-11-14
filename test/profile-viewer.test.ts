import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters as stripAnsi } from "node:util";
import { visibleWidth, oklchColor, styleText, backgroundAnsi } from "@earendil-works/pi-tui";
import { createProfileViewer, resolvedProfiles } from "../src/profile-viewer.ts";
import { bundledProfiles } from "../src/profiles.ts";
import extension from "../src/pi-extended-subagents.ts";
import {
  loadSkills,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ThemeStyle,
} from "@earendil-works/pi-coding-agent";
const keys = {
  matches: (data: string, action: string) =>
    data ===
    (
      {
        "tui.select.cancel": "\x1b",
        "tui.select.up": "up",
        "tui.select.down": "down",
        "tui.select.pageUp": "pgup",
        "tui.select.pageDown": "pgdown",
      } as Record<string, string>
    )[action],
  getKeys: () => ["escape" as const],
};
const theme = {
  fg: (_color: string, text: string) => text,
  style: (text: string) => text,
  colors: { customMessageBg: oklchColor(0.2, 0, 0) },
};

test("resolved command uses operator/trusted project settings and preserves non-TUI JSON envelope", async () => {
  const root = await mkdtemp(join(tmpdir(), "profile-viewer-"));
  const old = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(root, "operator");
  try {
    await mkdir(join(root, "operator"));
    await mkdir(join(root, ".pi"));
    const skillPath = join(root, "SKILL.md");
    await writeFile(
      skillPath,
      "---\nname: inherited\ndescription: Synthetic inherited skill\n---\nSkill body",
    );
    const { skills } = loadSkills({
      cwd: root,
      agentDir: join(root, "operator"),
      skillPaths: [skillPath],
      includeDefaults: false,
    });
    assert.equal(skills.length, 1);
    await writeFile(
      join(root, "operator", "delegation.json"),
      JSON.stringify({
        scout: {
          description: "operator description",
          prompt: "operator prompt",
          tools: ["read"],
          spawn: ["review"],
          coordination: ["message"],
        },
      }),
    );
    await writeFile(
      join(root, ".pi", "delegation.json"),
      JSON.stringify({
        scout: { prompt: "project prompt", tools: [], spawn: [], coordination: [] },
      }),
    );
    assert.equal((await resolvedProfiles(root, false))[1].prompt, "operator prompt");
    const commands = new Map<
      string,
      { handler: (args: string, ctx: ExtensionCommandContext) => Promise<unknown> }
    >();
    const messages: { content: string }[] = [];
    extension({
      registerCommand: (name: string, command: Parameters<ExtensionAPI["registerCommand"]>[1]) =>
        commands.set(name, command),
      registerTool: () => {},
      on: () => {},
      registerMessageRenderer: () => {},
      sendMessage: (message: { content: string }) => messages.push(message),
    } as unknown as ExtensionAPI);
    const ctx = {
      cwd: root,
      getSystemPromptOptions: () => ({
        skills,
        contextFiles: [{ path: "/private/AGENTS.md", content: "PRIVATE PARENT INSTRUCTIONS" }],
        customPrompt: "PRIVATE PARENT PROMPT",
      }),
      isProjectTrusted: () => true,
      mode: "json",
      ui: {
        custom: () => {
          throw new Error("must not open TUI");
        },
      },
    } as unknown as ExtensionCommandContext;
    await commands.get("subagent-profiles")!.handler("", ctx);
    const value = JSON.parse(messages[0].content);
    assert.match(value.toolPolicy, /unknown/);
    assert.deepEqual(value.profiles[0].skills, [skillPath]);
    assert.deepEqual(value.profiles[0].tools, [
      "read",
      "grep",
      "find",
      "ls",
      "write",
      "edit",
      "bash",
    ]);
    assert.deepEqual(value.profiles[0].spawn, ["scout", "review"]);
    assert.deepEqual(value.profiles[1].skills, []);
    assert.doesNotMatch(messages[0].content, /PRIVATE PARENT|private\/AGENTS/);
    assert.equal(value.profiles[1].prompt, "project prompt");
    assert.equal(value.profiles[1].description, "operator description");
    assert.deepEqual(value.profiles[1].tools, []);
    assert.deepEqual(value.profiles[1].spawn, []);
    assert.deepEqual(value.profiles[1].coordination, []);
    let opened = false;
    await commands.get("subagent-profiles")!.handler("", {
      ...ctx,
      mode: "tui",
      ui: {
        custom: async (_factory: unknown, options: { overlay: boolean }) => {
          opened = options.overlay;
        },
      },
    } as unknown as ExtensionCommandContext);
    assert.ok(opened);
    assert.equal(messages.length, 1);
    await writeFile(
      join(root, ".pi", "delegation.json"),
      JSON.stringify({ general: { skills: [], tools: ["read"], leafTools: [], spawn: [] } }),
    );
    await commands.get("subagent-profiles")!.handler("", ctx);
    const narrowed = JSON.parse(messages[1].content).profiles[0];
    assert.deepEqual(narrowed.skills, []);
    assert.deepEqual(narrowed.tools, ["read"]);
    assert.deepEqual(narrowed.leafTools, []);
    assert.deepEqual(narrowed.spawn, []);
    await writeFile(join(root, ".pi", "delegation.json"), "{bad");
    await assert.rejects(() => resolvedProfiles(root, true), /Invalid delegation config/);
    assert.equal((await resolvedProfiles(root, false)).length, 4);
  } finally {
    if (old === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = old;
    await rm(root, { recursive: true, force: true });
  }
});

test("viewer selects arbitrary roles, scrolls complete sanitized details, stacks and fits tiny geometry", () => {
  const profiles = bundledProfiles();
  profiles.push({
    ...profiles[0],
    name: "future role",
    prompt: "line\n".repeat(60) + "END PROMPT\x1b[31m",
    skills: ["/synthetic/SKILL.md"],
  });
  let rows = 22;
  let closed = false;
  let refresh = 0;
  const viewer = createProfileViewer(
    profiles,
    theme,
    keys,
    () => refresh++,
    () => {
      closed = true;
    },
    () => rows,
  );
  const render = (width: number) => viewer.render(width).join("\n");
  assert.match(render(120), /general.*│.*general/);
  const generalDetails = scrollThrough(viewer, 120);
  assert.match(generalDetails, /Tools ceiling:.*write, edit, bash/);
  assert.match(generalDetails, /Inheritance: available parent skills and callable builtins/);
  assert.match(generalDetails, /no parent[\s│]*instructions\/history/);
  assert.match(generalDetails, /Reviewed leaf ceiling: none.*shared writes/);
  assert.match(generalDetails, /trusted code, not sandboxed/);
  assert.match(generalDetails, /Spawn ceiling: scout, review/);
  for (let i = 0; i < 4; i++) viewer.handleInput!("down");
  assert.match(render(120), /future role/);
  const futureDetails = scrollThrough(viewer, 120);
  assert.match(futureDetails, /\/synthetic\/SKILL.md/);
  assert.match(futureDetails, /Models grant/);
  viewer.handleInput!("\x1b[H");
  viewer.handleInput!("pgdown");
  assert.doesNotMatch(render(120), /Description/);
  viewer.handleInput!("\x1b[F");
  const end = render(120);
  assert.match(end, /Admission also applies/);
  assert.doesNotMatch(end, /\x1b/);
  viewer.handleInput!("\x1b[H");
  assert.match(render(120), /Description/);
  viewer.handleInput!("up");
  assert.match(render(120), /implementation/);
  assert.match(render(42), /─{10}/);
  for (const width of [0, 1, 12, 23, 24, 42, 87, 88, 120])
    for (rows = 1; rows <= 25; rows++) {
      const lines = viewer.render(width);
      assert.ok(lines.length <= rows);
      assert.ok(
        lines.every((line) => visibleWidth(line) <= width),
        `width ${width}`,
      );
    }
  viewer.invalidate();
  viewer.handleInput!("\x1b");
  assert.ok(closed);
  assert.ok(refresh > 0);
});

test("viewer pins a framed footer and selected header outside the scroll viewport", () => {
  const viewer = createProfileViewer(
    bundledProfiles(),
    theme,
    keys,
    () => {},
    () => {},
    () => 24,
  );
  const first = viewer.render(120);
  assert.match(first[0], /╭.*Subagent Profiles.*╮/);
  assert.match(first.at(-1)!, /╰─+╯/);
  const divider = first.findIndex((line) => /^├─+┤$/.test(line));
  assert.ok(divider > 0);
  assert.match(first.slice(divider + 1).join("\n"), /escape: close.*callable tools unknown here/);
  viewer.handleInput!("\x1b[F");
  const last = viewer.render(120);
  assert.match(last.slice(0, 4).join("\n"), /general.*resolved.*read-only/s);
  assert.deepEqual(last.slice(divider), first.slice(divider));
});

function scrollThrough(viewer: ReturnType<typeof createProfileViewer>, width: number): string {
  viewer.handleInput!("\x1b[H");
  const frames: string[] = [];
  let previous = "";
  for (let step = 0; step < 500; step++) {
    const frame = viewer.render(width).join("\n");
    frames.push(frame);
    if (frame === previous) return frames.join("\n");
    previous = frame;
    viewer.handleInput!("j");
  }
  assert.fail("details should reach a stable end within the fixture's line count");
}

test("wrapped content, skills, structured policies and extra fields remain completely scrollable after resize", () => {
  const selection = { provider: "provider-marker", id: "model-marker", effort: "high" as const };
  const tokens = Array.from({ length: 80 }, (_, i) => `word-${i}-終`);
  const profile = Object.assign(
    {
      ...bundledProfiles()[0],
      name: "custom\x1b[31m\x1b]8;;https://untrusted\x07role\x1b]8;;\x07",
      description: "description-marker\treadable\u202e",
      prompt: tokens.join(" ") + "\nlast-prompt-marker\x1b[2J",
      skills: ["/first/SKILL.md", "/second/SKILL.md"],
      model: selection,
      models: [selection, { ...selection, id: "second-model-marker", effort: "off" as const }],
      prewalk: selection,
    },
    { extra: { retained: "extra-marker" } },
  );
  let rows = 22;
  const viewer = createProfileViewer(
    [profile, ...bundledProfiles()],
    theme,
    keys,
    () => {},
    () => {},
    () => rows,
  );
  for (const width of [120, 42, 88]) {
    rows = width === 42 ? 26 : 22;
    const all = scrollThrough(viewer, width);
    const unwrapped = all
      .split("\n")
      .map((line) => line.split("│").at(-2) ?? "")
      .join("")
      .replace(/\s/g, "");
    for (const token of [...tokens, "last-prompt-marker", "description-marker", "extra-marker"])
      assert.ok(unwrapped.includes(token), `missing ${token} at ${width}`);
    for (const label of [
      "Tools and permissions",
      "Model policy",
      "Model default:",
      "Models grant:",
      "Prewalk:",
      "provider: provider-marker",
      "id: model-marker",
      "effort: high",
      "second-model-marker",
    ])
      assert.ok(all.includes(label), `missing ${label} at ${width}`);
    assert.match(all, /\/first\/SKILL.md[^\n]*\n/);
    assert.match(all, /\/second\/SKILL.md/);
    assert.doesNotMatch(all, /\/first\/SKILL.md.*\/second\/SKILL.md/);
    assert.doesNotMatch(all, /[\x1b\u202e]/);
    assert.doesNotMatch(all, /https:\/\/untrusted/);
    viewer.handleInput!("down");
    assert.match(viewer.render(width).join("\n"), /Description/);
    viewer.handleInput!("up");
  }
});

test("empty profiles and empty grants remain distinct from default model policy", () => {
  const empty = createProfileViewer(
    [],
    theme,
    keys,
    () => {},
    () => {},
    () => 22,
  );
  assert.match(empty.render(120).join("\n"), /No resolved profiles/);
  for (const key of ["down", "up", "j", "k", "pgdown", "pgup", "\x1b[F", "\x1b[H"])
    empty.handleInput!(key);
  assert.match(empty.render(42).join("\n"), /0\/0/);
  const profiles = [
    bundledProfiles()[0],
    { ...bundledProfiles()[0], tools: [], skills: [], spawn: [], coordination: [], models: [] },
  ];
  const viewer = createProfileViewer(
    profiles,
    theme,
    keys,
    () => {},
    () => {},
    () => 22,
  );
  const defaults = scrollThrough(viewer, 120);
  assert.match(defaults, /Model default: selected parent model/);
  assert.match(defaults, /Models grant: no explicit override grant/);
  assert.match(defaults, /Prewalk: off/);
  viewer.handleInput!("down");
  const narrowed = scrollThrough(viewer, 120);
  for (const text of [
    "Tools ceiling: none",
    "Spawn ceiling: none",
    "Coordination: none",
    "Models grant: none (empty grant)",
  ])
    assert.ok(narrowed.includes(text));
  assert.doesNotMatch(narrowed, /no explicit override grant/);
});

test("theme-derived neutral paint covers frames, padding and ANSI resets and refreshes on theme change", () => {
  const calls: { color: string; text: string }[] = [];
  const palette = {
    colors: { customMessageBg: oklchColor(0.3, 0.1, 330) },
    fg: (color: string, text: string) => {
      calls.push({ color, text });
      return `\x1b[31m${text}\x1b[0m\x1b[49m`;
    },
    style: (text: string, { bg }: ThemeStyle) => {
      assert.ok(bg && typeof bg !== "string");
      return styleText(text, { bg }, "truecolor");
    },
  };
  let rows = 22;
  const viewer = createProfileViewer(
    bundledProfiles(),
    palette,
    keys,
    () => {},
    () => {},
    () => rows,
  );
  for (const width of [0, 1, 23, 24, 42, 88, 120]) {
    for (rows of [1, 6, 12, 22]) {
      const lines = viewer.render(width);
      assert.ok(lines.length <= rows);
      for (const line of lines) {
        assert.equal(visibleWidth(line), width);
        assert.ok(line.startsWith(backgroundAnsi(oklchColor(0.3, 0, 0), "truecolor")));
        assert.doesNotMatch(line, /\x1b\[49m(?!\x1b\[0m|$)/);
        assert.doesNotMatch(stripAnsi(line), /\x1b/);
      }
    }
  }
  assert.ok(calls.some(({ color, text }) => color === "accent" && text === "> general"));
  assert.ok(calls.some(({ color, text }) => color === "accent" && text === "Description"));
  assert.ok(calls.some(({ color, text }) => color === "border" && text.includes("┤")));
  palette.colors.customMessageBg = oklchColor(0.9, 0.1, 330);
  viewer.invalidate();
  assert.ok(
    viewer
      .render(120)
      .every((line) => line.startsWith(backgroundAnsi(oklchColor(0.9, 0, 0), "truecolor"))),
  );
});

test("paging, line scrolling and resize clamping keep the footer and full final viewport reachable", () => {
  let rows = 18;
  const viewer = createProfileViewer(
    [
      {
        ...bundledProfiles()[0],
        prompt: Array.from({ length: 50 }, (_, i) => `prompt-line-${i}`).join("\n"),
      },
    ],
    theme,
    keys,
    () => {},
    () => {},
    () => rows,
  );
  const render = (width: number) => viewer.render(width).join("\n");
  const initial = render(120);
  viewer.handleInput!("pgdown");
  const page = render(120);
  assert.notEqual(page, initial);
  viewer.handleInput!("pgup");
  assert.equal(render(120), initial);
  viewer.handleInput!("j");
  assert.notEqual(render(120), initial);
  viewer.handleInput!("k");
  assert.equal(render(120), initial);
  viewer.handleInput!("\x1b[F");
  render(120);
  rows = 30;
  const resized = render(42);
  assert.match(resized, /Admission also applies/);
  const lines = resized.split("\n");
  const divider = lines.findIndex((line) => /^├─+┤$/.test(line));
  const footer = lines
    .slice(divider + 1, -1)
    .map((line) => line.slice(2, -2).trim())
    .join(" ");
  assert.match(footer, /↑↓ select · j\/k scroll · PgUp\/Dn · Home\/End/);
  assert.match(footer, /escape: close · callable tools unknown here/);
  assert.match(resized, /general\s*│\n│ resolved · read-only/);
  const position = resized.match(/detail (\d+)–(\d+)\/(\d+)/)!;
  assert.ok(Number(position[2]) <= Number(position[3]), "resize must clamp to content bounds");
  // Narrower details add wrapped policy lines; End must still reach the complete final viewport.
  viewer.handleInput!("\x1b[F");
  const finalPosition = render(42).match(/detail (\d+)–(\d+)\/(\d+)/)!;
  assert.equal(finalPosition[2], finalPosition[3], "the final content line must remain reachable");
  rows = 2;
  assert.match(render(42), /Resize for details/);
  rows = 30;
  viewer.handleInput!("\x1b[H");
  assert.match(render(42), /Description/);
});

test("configured fallback chains are visible separately from unordered model grants", () => {
  const primary = { provider: "primary-chain-marker", id: "primary", effort: "high" as const };
  const backup = { provider: "backup-chain-marker", id: "backup", effort: "low" as const };
  const viewer = createProfileViewer(
    [{ ...bundledProfiles()[0], models: [backup, primary], fallback: [primary, backup] }],
    theme,
    keys,
    () => {},
    () => {},
    () => 30,
  );
  for (const width of [120, 42]) {
    const output = scrollThrough(viewer, width).replace(/\s/g, "");
    assert.match(output, /Fallbackchain\(routing,notgrants\)/);
    assert.match(output, /primary-chain-marker/);
    assert.match(output, /backup-chain-marker/);
    assert.match(output, /Modeldefault\(unchained\)/);
  }
});
