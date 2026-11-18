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
  getKeys: () => ["escape" as const],
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
  stripVTControlCharacters(text.replaceAll("\x1b_pi:fc\x07", "").replaceAll("\x1b_pi:/fc\x07", ""));

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

test("picker requires an explicitly chosen supported effort, respects disabled efforts and rechecks local metadata", () => {
  let reads = 0;
  const p = picker(() => {
    reads++;
    return catalog;
  });
  p.send("enter", "enter", "enter", "enter");
  assert.equal(p.finished, false);
  p.send("\x1b[Z", "\x1b[C", "enter", "enter");
  assert.deepEqual(p.result, a);
  assert.equal(reads, 2);
  const denied = picker();
  denied.send("enter", "enter", "\x1b[C", "\x1b[C", "enter", "enter");
  assert.equal(denied.finished, false);
  assert.match(denied.render(), /Outside current session/);
  const stale = picker(() => (reads++ === 2 ? catalog : { entries: [] }));
  stale.send("enter", "enter", "\x1b[C", "enter", "enter");
  assert.equal(stale.finished, false);
});

test("picker native search accepts printable j/k and paste, provider filtering and explicit Refresh do not select", () => {
  let reads = 0;
  const p = picker(() => {
    reads++;
    return catalog;
  });
  p.send("j");
  assert.match(p.render(), /No matching models/);
  p.send("\x7f", "\x1b[200~Custom Company\x1b[201~");
  assert.match(p.render(), /1 matches/);
  p.send("\t", "\x1b[C");
  assert.match(p.render(), /Provider: Custom Company/);
  p.send("\t", "\t", "\t", "\t", "enter");
  assert.equal(reads, 2);
  assert.equal(p.finished, false);
  assert.match(p.render(), /not chosen/);
});

test("arrows enter eligible results directly from Search without skipping the first model or choosing effort", () => {
  const last = {
    ...catalog.entries[0],
    id: "last",
    name: "Last Model",
    efforts: [{ effort: "off" as const }],
  };
  const p = picker(() => ({ entries: [...catalog.entries, last] }));
  assert.doesNotMatch(p.render(), /Second Model/);
  assert.match(p.render(), /1 model hidden: session scope/);
  p.send("down");
  assert.match(p.render(), /› Friendly Model/);
  p.send("down");
  assert.match(p.render(), /› Last Model/);
  p.send("up");
  assert.match(p.render(), /› Friendly Model/);
  p.send("down", "enter", "enter", "enter");
  assert.equal(p.finished, false, "browsing/Enter cannot implicitly choose an effort");
  p.send("\x1b[Z", "\x1b[C", "enter", "enter");
  assert.deepEqual(p.result, { provider: last.provider, id: last.id, effort: "off" });
});

test("hidden-model reasons follow search/provider and exact effort eligibility, including empty efforts", () => {
  const empty = { ...catalog.entries[0], id: "empty", name: "No efforts", efforts: [] };
  const source = () => ({ entries: [...catalog.entries, empty] });
  const p = picker(source, { ...options, allowed: [a], excluded: [a] });
  assert.doesNotMatch(p.render(), /Friendly Model|Second Model|No efforts/);
  assert.match(p.render(), /All matching models are hidden/);
  assert.match(p.render(), /3 models hidden:/);
  assert.match(p.render(), /already present/);
  assert.match(p.render(), /no supported efforts/);
  p.send("Friendly");
  assert.match(p.render(), /1 model hidden:/);
  assert.doesNotMatch(p.render(), /no supported efforts/);
  p.send("\t", "\x1b[C", "\x1b[C");
  assert.match(p.render(), /No matching models/);
  assert.doesNotMatch(p.render(), /models? hidden:/);
  p.send("\t", "down", "enter", "\x1b[C", "enter", "enter");
  assert.equal(p.finished, false);
  const partial = picker(() => catalog, { ...options, allowed: [a], excluded: [b] });
  assert.match(partial.render(), /Friendly Model/);
  assert.doesNotMatch(partial.render(), /Second Model/);
  const none = picker(() => catalog, { ...options, allowed: [] });
  assert.match(none.render(), /exact grants/);
  assert.match(none.render(), /0 matches/);
});

test("stale confirmation rebuilds eligible rows, clears effort and explains rejection without saving", () => {
  let current = catalog;
  const p = picker(() => current);
  p.send("down", "enter", "\x1b[C", "enter");
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
  assert.doesNotMatch(p.render(), /Friendly Model/);
  assert.match(p.render(), /Outside current session model\/effort scope/);
  assert.match(p.render(), /Effort: not chosen/);
  current = catalog;
  p.send("\t", "enter");
  assert.match(p.render(), /Friendly Model/);
  assert.match(p.render(), /Effort: not chosen/);
  assert.equal(p.finished, false);
});

test("empty/error/unavailable source states have metadata Refresh/back and never manual-ID fallback", () => {
  for (const source of [
    () => ({ entries: [] }),
    () => ({ entries: [], error: "Controlled metadata error" }),
    () => {
      throw new Error("secret host diagnostic");
    },
  ]) {
    const p = picker(source);
    const text = p.render();
    assert.match(text, /Refresh metadata/);
    assert.doesNotMatch(text, /secret host diagnostic/);
    assert.equal(p.finished, false);
    p.send("esc");
    assert.equal(p.finished, true);
    assert.equal(p.result, undefined);
  }
});

test("picker fits wide/narrow/short/tiny, retains native input/focus and cannot activate invisible choices", () => {
  const p = picker();
  p.send("enter", "enter", "\x1b[C", "enter");
  for (const [width, height] of [
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
    p.resize(height);
    const lines = p.component.render(width);
    assert.ok(lines.length <= height);
    for (const line of lines)
      assert.ok(visibleWidth(line) <= width, `${visibleWidth(line)} > ${width}`);
    if (width < 32 || height < 14) {
      p.component.handleInput?.("enter");
      assert.equal(p.finished, false);
    }
  }
  p.resize(24);
  p.render();
  p.send("enter");
  assert.deepEqual(p.result, a);
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
    "Search:",
    "Provider:",
    "Models:",
    "Eligible",
    "Effort:",
    "Select",
    "Refresh",
    "F1",
  ])
    assert.ok(frame.includes(label), label);
  p.component.handleInput!("\x1bOP");
  let details = p.render(68);
  for (let i = 0; i < 80; i++) {
    p.component.handleInput!("j");
    details += p.render(68);
  }
  assert.match(details, /already present/);
  assert.match(details, /session model\/effort scope/);
  assert.match(details, /Unavailable metadata\/access/);
  p.component.handleInput!("esc");
  for (const key of ["down", "enter", "\x1b[C", "enter", "enter"]) {
    p.component.handleInput!(key);
    p.render(68);
  }
  assert.deepEqual(p.result, { provider: long.provider, id: long.id, effort: "off" });
});

test("catalog search keeps Space/j/k/? printable and unbound hints do not invent confirmation keys", () => {
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
    () => 14,
  );
  p.render(68);
  for (const key of ["j", " ", "k", "?"]) p.handleInput!(key);
  const frame = plain(p.render(68).join("\n"));
  assert.match(frame, /Search: j k\?/);
  assert.match(frame, /unbound: results/);
  assert.match(frame, /unbound back/);
  assert.doesNotMatch(frame, /Enter|Esc/);
  assert.equal(finished, false);
});
