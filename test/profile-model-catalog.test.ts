import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import {
  ModelRegistry,
  ModelRuntime,
  type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { fauxProvider, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai/compat";
import { oklchColor, visibleWidth } from "@earendil-works/pi-tui";
import {
  readProfileModelCatalog,
  filterProfileModels,
  profileModelReason,
  profileModelPickReason,
  profileModelLabel,
  type ProfileModelCatalog,
  type ProfileModelPickOptions,
} from "../src/profile-model-catalog.ts";
import { createProfileModelPicker } from "../src/profile-model-picker.ts";
import {
  PROFILE_EFFORT_GLYPHS,
  profileEffortLabel,
  profileModelIdentity,
  profilePrice,
  profileTokenCount,
} from "../src/profile-presentation.ts";
import { EFFORTS, type ModelSelection } from "../src/model-policy.ts";

const keys = {
  matches: (data: string, action: string) =>
    data ===
    (
      {
        "tui.select.cancel": "esc",
        "tui.select.confirm": "enter",
        "tui.select.up": "up",
        "tui.select.down": "down",
      } as Record<string, string>
    )[action],
  getKeys: (action: string) =>
    action === "tui.select.confirm" ? ["enter" as const] : ["escape" as const],
};
const theme = {
  fg: (_name: string, text: string) => text,
  style: (text: string) => text,
  colors: { customMessageBg: oklchColor(0.2, 0, 0) },
};
const a: ModelSelection = { provider: "custom", id: "opaque-1", effort: "off" };
const b: ModelSelection = { ...a, effort: "high" };
const catalog: ProfileModelCatalog = {
  entries: [
    {
      provider: a.provider,
      id: a.id,
      name: "Friendly Model",
      providerLabel: "Custom Company",
      efforts: [
        { effort: "off" },
        { effort: "high", reason: "Outside current session model/effort scope" },
      ],
    },
    {
      provider: "other",
      id: "opaque-2",
      name: "Second Model",
      providerLabel: "Other Company",
      efforts: [{ effort: "off", reason: "Outside current session model/effort scope" }],
    },
  ],
};
const options: ProfileModelPickOptions = {
  title: "general · Model chain",
  context: ["Global: /fixture/delegation.json"],
};
const plain = (text: string) =>
  stripVTControlCharacters(text.replaceAll(/\x1b_pi:[^\x07]*\x07/g, ""));

function picker(source: () => ProfileModelCatalog = () => catalog, opts = options) {
  let result: ModelSelection | undefined;
  let finished = false;
  let height = 24;
  const component = createProfileModelPicker(
    source,
    opts,
    theme,
    keys,
    () => {},
    (value) => {
      result = value;
      finished = true;
    },
    () => height,
  );
  component.focused = true;
  const render = (width = 100) => plain(component.render(width).join("\n"));
  render();
  const send = (...data: string[]) => {
    for (const key of data) {
      component.handleInput?.(key);
      render();
    }
  };
  return {
    component,
    render,
    send,
    get result() {
      return result;
    },
    get finished() {
      return finished;
    },
    resize(value: number) {
      height = value;
    },
  };
}

test("catalog search covers friendly name, exact provider/custom label and ID, without normalizing identities", () => {
  for (const query of ["friendly", "CUSTOM COMPANY", "custom", "opaque-1"])
    assert.deepEqual(filterProfileModels(catalog, query), [catalog.entries[0]]);
  assert.equal(filterProfileModels(catalog, "", "other").length, 1);
  assert.deepEqual(filterProfileModels(catalog, "no-match"), []);
  assert.deepEqual(filterProfileModels(catalog, " Friendly"), []);
  assert.match(profileModelReason(catalog, b)!, /scope/);
  assert.equal(profileModelReason(catalog, a), undefined);
  assert.match(profileModelReason(catalog, { ...a, effort: "max" })!, /Unsupported effort/);
  assert.match(profileModelLabel(catalog, { ...a, id: "gone" }), /gone.*Warning: Unavailable/);
  assert.match(profileModelReason({ entries: [], error: "Metadata error" }, a)!, /Metadata error/);
});

test("authorization, duplicate identity and scope are independent, including empty allowed lists", () => {
  assert.match(profileModelPickReason(catalog, a, { ...options, allowed: [] })!, /Not authorized/);
  assert.equal(
    profileModelPickReason(catalog, a, { ...options, allowed: [a], excluded: [b] }),
    undefined,
  );
  assert.match(
    profileModelPickReason(catalog, a, { ...options, excluded: [a] })!,
    /already present/,
  );
  assert.match(profileModelPickReason(catalog, b, { ...options, allowed: [b] })!, /scope/);
});

const F1 = "\x1bOP";
const right = "\x1b[C";
const altRight = "\x1bf";
const altLeft = "\x1bb";
const ctrlR = "\x12";
const three: ProfileModelCatalog = {
  entries: [
    { ...catalog.entries[0], id: "first", name: "First", efforts: [{ effort: "off" }] },
    {
      ...catalog.entries[0],
      id: "granted",
      name: "Granted",
      efforts: [{ effort: "off" }, { effort: "high" }],
    },
    { ...catalog.entries[0], id: "third", name: "Third", efforts: [{ effort: "off" }] },
  ],
};

test("typing always searches, including literal j/k/? and paste; arrows move the text cursor", () => {
  const p = picker();
  for (const key of ["j", " ", "k", "?"]) p.send(key);
  assert.match(p.render(), /🔍 > j k\?/);
  assert.match(p.render(), /No matching models/);
  assert.equal(p.finished, false);
  for (let i = 0; i < 4; i++) p.send("\x7f");
  p.send("\x1b[200~Custom Company\x1b[201~");
  assert.match(p.render(), /❯ custom\/opaque-1/);
  p.send("\x1b[D", "\x1b[D", "X");
  assert.match(p.render(), /🔍 > Custom CompaXny/);
  assert.doesNotMatch(p.render(), /Effort:/);
});

test("granted models list first above a divider and ↑/↓ crosses it; other modes have no divider", () => {
  const p = picker(() => three, {
    ...options,
    prioritized: [{ provider: "custom", id: "granted", effort: "high" }],
  });
  assert.match(
    p.render(),
    /❯ custom\/granted *\n ─{20}[^\n]*\n {2}custom\/first *\n {2}custom\/third/,
  );
  p.send("down");
  assert.match(p.render(), /\n❯ custom\/first/);
  p.send("down", "down");
  assert.match(p.render(), /\n❯ custom\/third/);
  p.send("up", "up", "up");
  assert.match(p.render(), /\n❯ custom\/granted/);
  // Enter preselects the effort that already has a grant, so choosing it adds none.
  p.send("enter");
  assert.match(p.render(), /Effort: ⦸ off {2}\[◕ high\]/);
  p.send("enter");
  assert.deepEqual(p.result, { provider: "custom", id: "granted", effort: "high" });
  assert.doesNotMatch(picker(() => three).render(), /─{20}/);
});

test("provider tabs switch with alt+arrows and Tab/Shift+Tab without selecting", () => {
  const p = picker(() => ({
    entries: [...three.entries, { ...catalog.entries[1], efforts: [{ effort: "off" }] }],
  }));
  assert.match(p.render(), /Provider: ◀ all ▶ {2}custom {2}other/);
  p.send(altRight);
  assert.match(p.render(), /Provider: all {2}◀ custom ▶ {2}other/);
  assert.doesNotMatch(p.render(), /other\/opaque-2/);
  p.send("\t");
  assert.match(p.render(), /◀ other ▶/);
  assert.match(p.render(), /❯ other\/opaque-2/);
  assert.doesNotMatch(p.render(), /custom\/first/);
  p.send("\x1b[Z", altLeft);
  assert.match(p.render(), /◀ all ▶/);
  p.send(altLeft);
  assert.match(p.render(), /◀ other ▶/);
  assert.equal(p.finished, false);
});

test("Enter opens the effort strip, Enter on an eligible effort rechecks a fresh snapshot and completes", () => {
  let reads = 0;
  const p = picker(() => {
    reads++;
    return catalog;
  });
  assert.doesNotMatch(p.render(), /Effort:/);
  p.send("enter");
  assert.match(p.render(), /Effort: \[⦸ off\] {2}◕ high/);
  assert.match(p.render(), /Accessible in this session/);
  assert.match(
    p.render(),
    /←\/→ effort · ⏎ select \(no automatic grants\) · F1 details · ⎋ back to list/,
  );
  assert.equal(p.finished, false);
  p.send("enter");
  assert.deepEqual(p.result, a);
  assert.equal(reads, 2);
});

test("ineligible efforts stay inspectable with their exact reason and never complete", () => {
  const p = picker();
  p.send("enter", right);
  assert.match(p.render(), /Effort: ⦸ off {2}\[◕ high\]/);
  assert.match(p.render(), /Outside current session model\/effort scope/);
  p.send("enter");
  assert.equal(p.finished, false);
  assert.match(p.render(), /Outside current session model\/effort scope/);
  p.send(right);
  assert.match(p.render(), /\[◕ high\]/, "the strip stops at the last effort");
  p.send("\x1b[D", "enter");
  assert.deepEqual(p.result, a);
});

test("Escape peels details, then the effort strip, then cancels; typing or ↑/↓ leaves the strip", () => {
  const p = picker();
  p.send("F", "enter", F1);
  assert.match(p.render(), /Model details/);
  p.send("esc");
  assert.match(p.render(), /Effort: \[⦸ off\]/);
  p.send("esc");
  assert.doesNotMatch(p.render(), /Effort:/);
  assert.match(p.render(), /🔍 > F/);
  assert.match(p.render(), /❯ custom\/opaque-1/);
  p.send("enter", "r");
  assert.doesNotMatch(p.render(), /Effort:/);
  assert.match(p.render(), /🔍 > Fr/);
  p.send("enter", "down");
  assert.doesNotMatch(p.render(), /Effort:/);
  assert.equal(p.finished, false);
  p.send("esc");
  assert.equal(p.finished, true);
  assert.equal(p.result, undefined);
});

test("F1 details keep exact metadata, scroll with j/k and never accept", () => {
  const p = picker();
  p.send("enter", F1);
  const details = p.render();
  for (const text of [
    "ID: custom/opaque-1",
    "· high — Outside current session",
    "Selected effort: off",
    "^R refresh rereads the host snapshot only",
    "Hidden matching models (exact reasons)",
    "ID: other/opaque-2",
  ])
    assert.ok(details.includes(text), text);
  p.send("enter", " ", "j", "k");
  assert.equal(p.finished, false);
  assert.match(p.render(), /Model details/);
  p.send(F1);
  assert.match(p.render(), /Effort: \[⦸ off\]/);
});

test("ctrl+r rereads only the snapshot, resets a vanished provider and the selection", () => {
  let reads = 0;
  let current: ProfileModelCatalog = three;
  const p = picker(() => {
    reads++;
    return current;
  });
  p.send("down", "down", "enter");
  assert.match(p.render(), /❯ custom\/third/);
  p.send(ctrlR);
  assert.equal(reads, 2);
  assert.match(p.render(), /❯ custom\/first/);
  assert.match(p.render(), /Reread the host model snapshot; no network refresh/);
  assert.doesNotMatch(p.render(), /Effort:/);
  p.send(altRight);
  assert.match(p.render(), /◀ custom ▶/);
  current = { entries: [{ ...catalog.entries[1], efforts: [{ effort: "off" }] }] };
  p.send(ctrlR);
  assert.match(p.render(), /◀ all ▶/);
  assert.match(p.render(), /❯ other\/opaque-2/);
  assert.equal(p.finished, false);
});

test("stale confirmation rejects with its reason and returns to the list without saving", () => {
  let current = catalog;
  const p = picker(() => current);
  p.send("enter");
  current = {
    entries: catalog.entries.map((entry) => ({
      ...entry,
      efforts: entry.efforts.map((e) => ({
        ...e,
        reason: "Outside current session model/effort scope",
      })),
    })),
  };
  p.send("enter");
  assert.equal(p.finished, false);
  assert.doesNotMatch(p.render(), /custom\/opaque-1|Effort:/);
  assert.match(p.render(), /Outside current session model\/effort scope/);
  current = catalog;
  p.send(ctrlR, "enter");
  assert.match(p.render(), /Effort: \[⦸ off\]/);
  assert.equal(p.finished, false);
});

test("hidden-model reasons follow search/provider and exact effort eligibility, including empty efforts", () => {
  const empty = { ...catalog.entries[0], id: "empty", name: "No efforts", efforts: [] };
  const source = () => ({ entries: [...catalog.entries, empty] });
  const p = picker(source, { ...options, allowed: [a], excluded: [a] });
  assert.doesNotMatch(p.render(), /opaque-1|opaque-2|custom\/empty/);
  assert.match(p.render(), /All matching models are hidden/);
  assert.match(p.render(), /3 models hidden:/);
  assert.match(p.render(), /already present/);
  assert.match(p.render(), /no supported efforts/);
  p.send("Friendly");
  assert.match(p.render(), /1 model hidden:/);
  assert.doesNotMatch(p.render(), /no supported efforts/);
  p.send(altRight, altRight);
  assert.match(p.render(), /No matching models/);
  assert.doesNotMatch(p.render(), /models? hidden:/);
  p.send("enter", "enter");
  assert.equal(p.finished, false);
  const none = picker(() => catalog, { ...options, allowed: [] });
  assert.match(none.render(), /exact grants/);
});

test("short heights shed spacers, then the hidden summary, then the detail line, before results", () => {
  const many: ProfileModelCatalog = {
    entries: [
      ...Array.from({ length: 8 }, (_, index) => ({
        ...catalog.entries[0],
        id: `model-${index}`,
        name: `Model ${index}`,
        contextWindow: 200_000,
        efforts: [{ effort: "off" as const }],
      })),
      catalog.entries[1],
    ],
  };
  const p = picker(() => many, {
    ...options,
    context: Array.from({ length: 11 }, (_, index) => `Disclosure ${index} stays visible`),
  });
  const seen = new Set<string>();
  for (let height = 30; height >= 14; height--) {
    p.resize(height);
    const frame = p.render(60);
    if (/resize/.test(frame)) continue;
    const summary = /1 model hidden: session scope\./.test(frame);
    const detail = /Model 0 · 200k ctx/.test(frame);
    const spacer = /🔍 >[^\n]*\n *\n/.test(frame);
    assert.ok((frame.match(/custom\/model-/g) ?? []).length >= 3, frame);
    assert.match(
      frame.replace(/\s+/g, " "),
      /Disclosure 10 stays visible/,
      "disclosures never shed",
    );
    assert.ok(!spacer || summary, "spacers shed before the summary");
    assert.ok(!summary || detail, "the summary sheds before the detail line");
    assert.equal(summary, !/F1 1 hidden/.test(frame), "a shed summary still counts hidden models");
    seen.add(`${spacer}${summary}${detail}`);
  }
  assert.deepEqual(
    [...seen],
    ["truetruetrue", "falsetruetrue", "falsefalsetrue", "falsefalsefalse"],
  );
});

test("rows show provider/id with reasoning, context and price columns that drop price → context → reasoning", () => {
  const rich: ProfileModelCatalog = {
    entries: [
      {
        ...catalog.entries[0],
        efforts: [{ effort: "off" }],
        contextWindow: 1_000_000,
        maxTokens: 128_000,
        cost: { input: 0.75, output: 3.75 },
        reasoning: true,
        vision: true,
      },
      { ...catalog.entries[0], id: "bare", name: "Bare", efforts: [{ effort: "off" }] },
    ],
  };
  const p = picker(() => rich);
  const wide = p.render(100);
  assert.match(wide, /❯ custom\/opaque-1 +🧠 {2}1m {2}\$0\.75\/3\.75\n/);
  assert.match(wide, /\n {2}custom\/bare\s*\n/, "missing metadata leaves blank cells");
  assert.match(
    wide,
    /Friendly Model · 1m ctx · 128k out · \$0\.75\/3\.75 per M · reasoning · vision/,
  );
  assert.match(p.render(46), /❯ custom\/opaque-1 +🧠 {2}1m {2}\$0\.75\/3\.75\n/);
  assert.match(p.render(45), /❯ custom\/opaque-1 +🧠 {2}1m\n/);
  assert.match(p.render(33), /❯ custom\/opaque-1 +🧠\n/);
});

test("picker fits 72×25, 80×24, 120×36 and smaller, and cannot activate invisible choices", () => {
  const p = picker(() => ({ entries: [...catalog.entries, ...three.entries] }), {
    ...options,
    prioritized: [{ provider: "custom", id: "granted", effort: "off" }],
  });
  p.send("down", "enter");
  for (const [width, height] of [
    [72, 25],
    [80, 24],
    [120, 36],
    [52, 24],
    [100, 12],
    [24, 12],
    [20, 6],
    [1, 1],
    [0, 1],
  ]) {
    p.resize(height);
    const lines = p.component.render(width);
    assert.ok(lines.length <= height);
    for (const line of lines) {
      assert.ok(visibleWidth(line) <= width, `${visibleWidth(line)} > ${width}`);
      assert.doesNotMatch(plain(line), /[\x00-\x08\x0b-\x1f\x7f]/);
    }
    if (width >= 72 && height >= 14) assert.match(plain(lines.join("\n")), /Effort: \[⦸ off\]/);
    if (width < 32 || height < 14) {
      if (height > 1) assert.match(plain(lines.join("\n")), /resize|Saved/);
      p.component.handleInput?.("enter");
      assert.equal(p.finished, false);
    }
  }
  p.resize(24);
  p.render();
  p.send("enter");
  assert.deepEqual(p.result, a);
});

test("empty/error/unavailable source states offer refresh/back and never manual-ID fallback", () => {
  for (const source of [
    () => ({ entries: [] }),
    () => ({ entries: [], error: "Controlled metadata error" }),
    () => {
      throw new Error("secret host diagnostic");
    },
  ]) {
    const p = picker(source);
    const text = p.render();
    assert.match(text, /\^R refresh/);
    assert.doesNotMatch(text, /secret host diagnostic/);
    p.send("enter");
    assert.equal(p.finished, false);
    p.send("esc");
    assert.equal(p.finished, true);
    assert.equal(p.result, undefined);
  }
});

test("production 68x14 picker budgets mixed diagnostics before results and retains details/selection", () => {
  const present = { ...catalog.entries[0], id: "present", efforts: [{ effort: "off" as const }] };
  const inaccessible = {
    ...present,
    id: "missing",
    efforts: [
      { effort: "off" as const, reason: "Unavailable metadata/access " + "reason ".repeat(30) },
    ],
  };
  const long = {
    ...present,
    id: "exact-" + "x".repeat(140),
    name: "Eligible 終 " + "name ".repeat(30),
  };
  const p = picker(() => ({ entries: [long, present, catalog.entries[1], inaccessible] }), {
    ...options,
    context: [
      "Global · affects other workspaces",
      "Grant permits explicit overrides too",
      "Saves route + exact grant atomically",
    ],
    excluded: [{ provider: present.provider, id: present.id, effort: "off" }],
  });
  p.resize(14);
  const frame = p.render(68);
  assert.doesNotMatch(frame, /resize/);
  for (const label of [
    "🔍 >",
    "Provider:",
    "/exact-xxx",
    "Saves route",
    "^R refresh",
    "3 models hidden",
  ])
    assert.ok(frame.includes(label), `${label}\n${frame}`);
  p.component.handleInput!(F1);
  let details = p.render(68);
  for (let i = 0; i < 80; i++) {
    p.component.handleInput!("j");
    details += p.render(68);
  }
  assert.match(details, /already present/);
  assert.match(details, /session model\/effort scope/);
  assert.match(details, /Unavailable metadata\/access/);
  p.component.handleInput!("esc");
  for (const key of ["enter", "enter"]) {
    p.component.handleInput!(key);
    p.render(68);
  }
  assert.deepEqual(p.result, { provider: long.provider, id: long.id, effort: "off" });
});

test("hints use bound keys and unbound actions do not invent confirmation keys", () => {
  let finished = false;
  const p = createProfileModelPicker(
    () => catalog,
    options,
    theme,
    { ...keys, getKeys: () => [] },
    () => {},
    () => {
      finished = true;
    },
    () => 24,
  );
  p.render(100);
  const frame = plain(p.render(100).join("\n"));
  assert.match(frame, /— unbound assigns, unbound cancels/);
  assert.match(frame, /unbound choose effort/);
  assert.doesNotMatch(frame, /⏎|⎋|Enter|Esc/);
  const bound = picker().render();
  assert.match(bound, /general · Model chain — ⏎ assigns, ⎋ cancels/);
  assert.match(
    bound,
    /type to search · ↑\/↓ move · ⌥←\/→\/Tab provider · ⏎ choose effort · F1 details · \^R refresh · ⎋ cancel/,
  );
  assert.equal(finished, false);
});

test("real SDK registry boundary exposes supported efforts and custom labels without invoking provider/auth operations", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "profile-catalog-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    modelsStorePath: join(root, "cache.json"),
    refreshOnCreate: false,
  });
  const faux = fauxProvider({
    provider: "catalog-controlled",
    models: [{ id: "actual-shape", reasoning: true }],
  });
  let browsing = false;
  runtime.registerNativeProvider({
    ...faux.provider,
    name: "Custom Catalog Provider",
    auth: {
      apiKey: {
        name: "controlled",
        resolve: async () => {
          if (browsing) throw new Error("Auth resolution forbidden while browsing");
          return { auth: {} };
        },
      },
    },
  });
  await runtime.setRuntimeApiKey("catalog-controlled", "fake-in-memory-test-key");
  await runtime.refresh({ allowNetwork: false });
  browsing = true;
  const registry = new ModelRegistry(runtime);
  const model = registry.find("catalog-controlled", "actual-shape")!;
  assert.ok(model);
  const allowedCalls = new Set([
    "getError",
    "getAvailable",
    "getProvider",
    "hasConfiguredAuth",
    "getProviderDisplayName",
    "find",
  ]);
  const calls: string[] = [];
  const narrow = new Proxy(registry, {
    get(target, property) {
      assert.ok(allowedCalls.has(String(property)), `Unexpected host method: ${String(property)}`);
      return (...args: unknown[]) => {
        calls.push(String(property));
        return Reflect.apply(Reflect.get(target, property), target, args);
      };
    },
  });
  const context: Pick<ExtensionCommandContext, "modelRegistry" | "scopedModels"> = {
    modelRegistry: narrow,
    scopedModels: [],
  };
  const snapshot = readProfileModelCatalog(context);
  assert.equal(snapshot.error, undefined);
  const entry = snapshot.entries.find((item) => item.provider === model.provider)!;
  assert.equal(entry.providerLabel, "Custom Catalog Provider");
  assert.deepEqual(
    entry.efforts.map((item) => item.effort),
    getSupportedThinkingLevels(model),
  );
  assert.ok(entry.efforts.every((item) => !item.reason));
  for (const level of EFFORTS) {
    const scoped = readProfileModelCatalog({
      ...context,
      scopedModels: [{ model, thinkingLevel: level }],
    });
    for (const effort of scoped.entries.find((item) => item.provider === model.provider)!.efforts)
      assert.equal(!!effort.reason, effort.effort !== level);
  }
  const unrestrictedEffort = readProfileModelCatalog({ ...context, scopedModels: [{ model }] });
  assert.ok(unrestrictedEffort.entries[0].efforts.every((item) => !item.reason));
  assert.ok(calls.length);
  const errorRegistry = new Proxy(registry, {
    get() {
      throw new Error("private failure");
    },
  });
  assert.doesNotMatch(
    JSON.stringify(readProfileModelCatalog({ modelRegistry: errorRegistry, scopedModels: [] })),
    /private failure/,
  );
});

test("metadata adapter keeps accessible out-of-scope entries, rejects nonphysical/accessless entries and safely handles host failures", () => {
  const physical = fauxProvider({ provider: "controlled-adapter" }).getModel();
  const models = [
    physical,
    { ...physical, id: "bad-limits", contextWindow: Infinity },
    { ...physical, id: "virtual", api: "pi-virtual" },
    { ...physical, id: "no-auth" },
    { ...physical, provider: "not-registered", id: "no-provider" },
    physical,
  ];
  const methods = {
    getError: () => undefined,
    getAvailable: () => models,
    getProvider: (id: string) => (id === physical.provider ? {} : undefined),
    hasConfiguredAuth: (model: { id: string }) => model.id !== "no-auth",
    getProviderDisplayName: () => "Custom nonsecret label",
    find: (provider: string, id: string) =>
      models.find((model) => model.provider === provider && model.id === id),
  };
  // SDK-shaped metadata facade, with traps against every method outside the narrow adapter contract.
  const registry = new Proxy(methods, {
    get(target, key) {
      assert.ok(key in target);
      return Reflect.get(target, key);
    },
  }) as unknown as ExtensionCommandContext["modelRegistry"];
  const snapshot = readProfileModelCatalog({
    modelRegistry: registry,
    scopedModels: [{ model: { ...physical, id: "other-scope" }, thinkingLevel: "off" }],
  });
  assert.equal(snapshot.entries.filter((entry) => entry.id === physical.id).length, 1);
  assert.ok(snapshot.entries.every((entry) => entry.efforts.every((item) => item.reason)));
  assert.ok(
    !snapshot.entries.some((entry) => ["virtual", "no-auth", "no-provider"].includes(entry.id)),
  );
  const unrestricted = readProfileModelCatalog({ modelRegistry: registry, scopedModels: [] });
  assert.ok(
    unrestricted.entries
      .find((entry) => entry.id === physical.id)!
      .efforts.every((item) => !item.reason),
  );
  assert.ok(
    unrestricted.entries
      .find((entry) => entry.id === "bad-limits")!
      .efforts.every((item) => item.reason),
  );
  for (const method of ["getError", "getAvailable", "getProviderDisplayName"]) {
    const failing = new Proxy(registry, {
      get(target, key) {
        if (key === method)
          return () => {
            throw new Error("private host failure");
          };
        return Reflect.get(target, key);
      },
    });
    const result = readProfileModelCatalog({ modelRegistry: failing, scopedModels: [] });
    assert.ok(result.error);
    assert.equal(result.entries.length, 0);
    assert.doesNotMatch(JSON.stringify(result), /private host failure/);
  }
});

test("catalog copies optional model metadata from the host snapshot and omits unknown values", () => {
  const faux = fauxProvider({
    provider: "metadata-fixture",
    models: [
      {
        id: "rich",
        name: "Rich",
        reasoning: true,
        input: ["text", "image"],
        contextWindow: 1_000_000,
        maxTokens: 128_000,
        cost: { input: 2, output: 10, cacheRead: 0, cacheWrite: 0 },
      },
      { id: "plain", reasoning: false, input: ["text"] },
    ],
  });
  const models = faux.models.map((model) => ({ ...model, provider: "metadata-fixture" }));
  const bare = {
    ...models[1],
    id: "bare",
    contextWindow: 0,
    maxTokens: Infinity,
    cost: undefined,
    input: undefined,
    reasoning: undefined,
  };
  const all = [...models, bare];
  const registry = {
    getError: () => undefined,
    getAvailable: () => all,
    getProvider: () => ({}),
    hasConfiguredAuth: () => true,
    getProviderDisplayName: () => "Metadata",
    find: (provider: string, id: string) =>
      all.find((model) => model.provider === provider && model.id === id),
  } as unknown as ExtensionCommandContext["modelRegistry"];
  const snapshot = readProfileModelCatalog({ modelRegistry: registry, scopedModels: [] });
  const [rich, plainEntry, bareEntry] = snapshot.entries;
  assert.equal(rich.contextWindow, 1_000_000);
  assert.equal(rich.maxTokens, 128_000);
  assert.deepEqual(rich.cost, { input: 2, output: 10 });
  assert.equal(rich.reasoning, true);
  assert.equal(rich.vision, true);
  assert.equal(plainEntry.reasoning, false);
  assert.equal(plainEntry.vision, false);
  for (const field of ["contextWindow", "maxTokens", "cost", "reasoning", "vision"])
    assert.ok(!(field in bareEntry), field);
});

test("formatters: effort glyphs, token counts, prices and provider-first identity truncation", () => {
  for (const effort of EFFORTS) {
    assert.equal(visibleWidth(PROFILE_EFFORT_GLYPHS[effort]), 1, effort);
    assert.equal(profileEffortLabel(effort), `${PROFILE_EFFORT_GLYPHS[effort]} ${effort}`);
  }
  assert.equal(new Set(Object.values(PROFILE_EFFORT_GLYPHS)).size, EFFORTS.length);
  assert.equal(profileEffortLabel("low"), "◔ low");
  for (const [tokens, text] of [
    [1_000_000, "1m"],
    [1_048_576, "1m"],
    [2_500_000, "2.5m"],
    [500_000, "500k"],
    [131_072, "131k"],
    [16_384, "16k"],
    [8192, "8.2k"],
    [512, "512"],
    [0, ""],
    [undefined, ""],
    [Infinity, ""],
  ] as const)
    assert.equal(profileTokenCount(tokens), text, String(tokens));
  assert.equal(profilePrice({ input: 2, output: 10 }), "$2/10");
  assert.equal(profilePrice({ input: 0.75, output: 3.75 }), "$0.75/3.75");
  assert.equal(profilePrice({ input: 0, output: 0 }), "$0");
  assert.equal(profilePrice({ input: 0.075, output: 0.3 }), "$0.075/0.3");
  assert.equal(profilePrice(undefined), "");
  const fg = (color: string, text: string) => `<${color}>${text}</>`;
  const identity = (width: number, color?: "accent", themeFg = fg) =>
    profileModelIdentity(
      { fg: themeFg } as Parameters<typeof profileModelIdentity>[0],
      "google-antigravity",
      "claude-sonnet",
      width,
      color,
    );
  assert.equal(identity(40), "<muted>google-antigravity/</><text>claude-sonnet</>");
  assert.equal(identity(40, "accent"), "<muted>google-antigravity/</><accent>claude-sonnet</>");
  assert.equal(identity(22), "<muted>google-…/</><text>claude-sonnet</>");
  assert.equal(identity(15), "<muted>…/</><text>claude-sonnet</>");
  assert.equal(identity(10), "<muted>…/</><text>claude-…</>");
  for (const width of [0, 1, 2, 3, 10, 15, 22, 40])
    assert.ok(
      visibleWidth(identity(width, undefined, (_color, text) => text)) <= width,
      String(width),
    );
});
