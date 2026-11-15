import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import {
  SelectList,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
  type KeybindingsManager,
} from "@earendil-works/pi-tui";
import { isDeepStrictEqual } from "node:util";
import {
  ProfileConfigDraft,
  ProfileConfigError,
  type ProfileDraftOptions,
  type ProfileDestination,
} from "./profile-config.ts";
import {
  bundledProfiles,
  WRITE_TOOLS,
  COORDINATION_ACTIONS,
  validateCustomRoleName,
  loadProfileCatalog,
  resolveProfileCatalog,
  validateProfileSkills,
  type Profile,
  type ProfileCatalog,
} from "./profiles.ts";
import { createProfileViewer } from "./profile-viewer.ts";
import { safe } from "./thread.ts";
import { EFFORTS, modelSelection, sameSelection, type ModelSelection } from "./model-policy.ts";

export type ProfileEditorView = {
  title: string;
  lines: readonly string[];
  choices: readonly { value: string; label: string }[];
};
export type ProfileEditorOptions = ProfileDraftOptions & {
  modelStatus?: (selection: ModelSelection) => string;
};
type Show = (view: ProfileEditorView) => Promise<string | undefined>;
type ScreenTheme = Pick<Theme, "fg">;
type ScreenKeys = Pick<KeybindingsManager, "matches" | "getKeys">;

/** Bounded native selection/detail screen. Text dialogs run only after this interaction closes. */
export function createProfileEditorScreen(
  view: ProfileEditorView,
  theme: ScreenTheme,
  keys: ScreenKeys,
  requestRender: () => void,
  done: (choice: string | undefined) => void,
  availableRows: () => number,
): Component {
  let selected = 0;
  let offset = 0;
  let maximum = 0;
  let viewport = 1;
  let compact = true;
  const cell = (text: string, width: number) => {
    const clipped = truncateToWidth(text, width);
    return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
  };
  return {
    capturesViewportInput: true,
    render(width) {
      width = Math.max(0, width);
      const height = Math.max(1, Math.floor(availableRows()));
      const close = safe(keys.getKeys("tui.select.cancel").join("/") || "Esc");
      const confirm = safe(keys.getKeys("tui.select.confirm").join("/") || "Enter");
      compact = width < 24 || height < 12;
      if (compact)
        return ["Profiles · resize", "Draft retained; no save", `${close}: back`]
          .slice(0, height)
          .map((line) => truncateToWidth(line, width));
      const inner = width - 4;
      const footer = [
        `↑↓ action · ${confirm} select · ${close} back`,
        "j/k detail · PgUp/Dn · Home/End",
      ].flatMap((line) => wrapTextWithAnsi(line, inner));
      const bodyHeight = height - 3 - footer.length;
      const wide = width >= 88;
      const menuHeight = wide ? bodyHeight : Math.min(4, Math.max(2, Math.floor(bodyHeight / 3)));
      const detailHeight = wide ? bodyHeight : bodyHeight - menuHeight - 1;
      const menuWidth = wide ? Math.min(30, Math.floor(inner / 3)) : inner;
      const detailWidth = wide ? inner - menuWidth - 3 : inner;
      // SelectList handles menu measurement/scrolling; injected bindings own navigation.
      const menu = new SelectList(
        view.choices.map((choice) => ({
          ...choice,
          label: safe(choice.label).replaceAll("\n", " "),
        })),
        Math.max(1, menuHeight - 1),
        {
          selectedPrefix: (text) => theme.fg("accent", text),
          selectedText: (text) => theme.fg("accent", text),
          description: (text) => theme.fg("muted", text),
          scrollInfo: (text) => theme.fg("muted", text),
          noMatch: (text) => theme.fg("warning", text),
        },
      );
      menu.setSelectedIndex(selected);
      const roster = menu.render(menuWidth).slice(0, menuHeight);
      const lines = [
        view.title,
        `Selected action: ${view.choices[selected]?.label ?? "none"}`,
        ...view.lines,
      ].flatMap((line) =>
        safe(line)
          .split("\n")
          .flatMap((part) => wrapTextWithAnsi(part, detailWidth)),
      );
      viewport = Math.max(1, detailHeight - 1);
      maximum = Math.max(0, lines.length - viewport);
      offset = Math.min(offset, maximum);
      const detail = [
        ...lines.slice(offset, offset + viewport),
        ...Array(Math.max(0, viewport - (lines.length - offset))).fill(""),
        theme.fg(
          "muted",
          `Detail ${offset + 1}–${Math.min(lines.length, offset + viewport)}/${lines.length}`,
        ),
      ];
      const body = wide
        ? Array.from(
            { length: bodyHeight },
            (_, index) =>
              cell(roster[index] ?? "", menuWidth) +
              theme.fg("border", " │ ") +
              cell(detail[index] ?? "", detailWidth),
          )
        : [
            ...roster,
            ...Array(Math.max(0, menuHeight - roster.length)).fill(""),
            theme.fg("border", "─".repeat(inner)),
            ...detail,
          ];
      const row = (text: string) =>
        theme.fg("border", "│") + ` ${cell(text, inner)} ` + theme.fg("border", "│");
      const frame = (left: string, title: string, right: string) =>
        theme.fg("border", left) +
        theme.fg("accent", truncateToWidth(title, width - 2)) +
        theme.fg("border", "─".repeat(Math.max(0, width - 2 - visibleWidth(title))) + right);
      return [
        frame("╭", ` ${safe(view.title).replaceAll("\n", " ")} `, "╮"),
        ...body.map(row),
        frame("├", "", "┤"),
        ...footer.map((line) => row(theme.fg("muted", line))),
        frame("╰", "", "╯"),
      ].map((line) => truncateToWidth(line, width));
    },
    handleInput(data) {
      if (keys.matches(data, "tui.select.cancel")) {
        done(undefined);
        return;
      }
      // Never activate an invisible choice (especially Save) in a tiny/short terminal.
      if (compact) return;
      if (keys.matches(data, "tui.select.confirm")) {
        done(view.choices[selected]?.value);
        return;
      }
      if (keys.matches(data, "tui.select.up")) {
        selected = Math.max(0, selected - 1);
        offset = 0;
      } else if (keys.matches(data, "tui.select.down")) {
        selected = Math.min(view.choices.length - 1, selected + 1);
        offset = 0;
      } else if (data === "j") offset = Math.min(maximum, offset + 1);
      else if (data === "k") offset = Math.max(0, offset - 1);
      else if (keys.matches(data, "tui.select.pageDown"))
        offset = Math.min(maximum, offset + viewport);
      else if (keys.matches(data, "tui.select.pageUp")) offset = Math.max(0, offset - viewport);
      else if (matchesKey(data, "home")) offset = 0;
      else if (matchesKey(data, "end")) offset = maximum;
      else return;
      requestRender();
    },
    invalidate() {},
  };
}

const bundledNames = new Set(bundledProfiles().map((profile) => profile.name));
function entries(layer: Record<string, unknown>): Record<string, unknown> {
  return (layer.customProfiles ?? {}) as Record<string, unknown>;
}
function rawRole(layer: Record<string, unknown>, name: string): Record<string, unknown> {
  return ((bundledNames.has(name) ? layer[name] : entries(layer)[name]) ?? {}) as Record<
    string,
    unknown
  >;
}
function editRole(draft: ProfileConfigDraft, name: string): Record<string, unknown> {
  if (bundledNames.has(name)) return (draft.value[name] ??= {}) as Record<string, unknown>;
  const custom = (draft.value.customProfiles ??= {}) as Record<string, unknown>;
  return (custom[name] ??= {}) as Record<string, unknown>;
}
function candidateCatalog(draft: ProfileConfigDraft, options: ProfileDraftOptions): ProfileCatalog {
  const catalog = draft.catalog;
  catalog[draft.destination] = structuredClone(draft.value);
  return {
    ...catalog,
    ...resolveProfileCatalog(catalog.global, catalog.project, options.availableSkills?.() ?? []),
  };
}
function display(value: unknown): string {
  return value === undefined ? "<unset / inherited>" : JSON.stringify(value);
}
function rawChanges(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  prefix = "",
): string[] {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].flatMap((key) => {
    const old = before[key],
      next = after[key],
      path = prefix ? `${prefix}.${key}` : key;
    if (isDeepStrictEqual(old, next)) return [];
    if (
      old &&
      next &&
      typeof old === "object" &&
      typeof next === "object" &&
      !Array.isArray(old) &&
      !Array.isArray(next)
    )
      return rawChanges(old as Record<string, unknown>, next as Record<string, unknown>, path);
    return [`${path}:`, `  before ${display(old)}`, `  after  ${display(next)}`];
  });
}
/** Compare configured ceilings/routing, never claim command-context callability. */
export function profilePermissionChanges(
  before: readonly Profile[],
  after: readonly Profile[],
): string[] {
  const changes: string[] = [];
  for (const name of new Set([...before, ...after].map((profile) => profile.name))) {
    const old = before.find((profile) => profile.name === name),
      next = after.find((profile) => profile.name === name);
    for (const field of [
      "tools",
      "skills",
      "leafTools",
      "spawn",
      "coordination",
      "models",
      "inheritedModelCeiling",
      "model",
      "prewalk",
      "fallback",
    ] as const) {
      if (isDeepStrictEqual(old?.[field], next?.[field])) continue;
      changes.push(`${name}.${field}: ${display(old?.[field])} → ${display(next?.[field])}`);
      if (Array.isArray(old?.[field]) || Array.isArray(next?.[field])) {
        const from = ((old?.[field] ?? []) as readonly unknown[]).map(display),
          to = ((next?.[field] ?? []) as readonly unknown[]).map(display);
        changes.push(
          `  added: ${to.filter((value) => !from.includes(value)).join(", ") || "none"}`,
          `  removed: ${from.filter((value) => !to.includes(value)).join(", ") || "none"}`,
        );
      }
    }
  }
  return changes.length
    ? changes
    : ["No effective permission additions/removals or routing changes."];
}
export function profileSaveReview(
  draft: ProfileConfigDraft,
  candidate: ProfileCatalog,
): ProfileEditorView {
  return {
    title: "Review profile save",
    choices: [
      { value: "back", label: "Keep editing" },
      { value: "save", label: "Save this file" },
    ],
    lines: [
      `Destination: ${draft.destination}`,
      `Write path: ${draft.path}`,
      draft.destination === "global"
        ? "GLOBAL REACH: affects other workspaces using these operator settings."
        : "Trusted-project override only; cannot mint grants.",
      "New sessions use changed instructions. Retained prompts are not rewritten. Current policy revalidation can revoke later operations; no agent restarts automatically.",
      "Callable tools are unknown here. Saving never activates tools or proves model availability.",
      "",
      "Raw selected-layer changes",
      ...rawChanges(draft.original, draft.value),
      "",
      "Effective permission additions/removals and routing",
      ...profilePermissionChanges(draft.catalog.profiles, candidate.profiles),
      ...(["projectRoleCeilings", "projectSpawnTargets"] as const).flatMap((field) =>
        isDeepStrictEqual(draft.catalog[field], candidate[field])
          ? []
          : [
              `GLOBAL authorization ${field}: ${display(draft.catalog[field])} → ${display(candidate[field])}`,
              "Scope: ALL trusted projects using these operator settings. Each may supply independent instructions for the exact registered name under its ceiling. Registration creates no profile and adds no parent spawn grant; explicit parent spawn authorization is separate.",
            ],
      ),
      "",
      "Save rechecks both relevant files. Conflicts retain the draft; there is no force-overwrite or automatic rollback.",
    ],
  };
}
function formView(
  draft: ProfileConfigDraft,
  name: string,
  options: ProfileDraftOptions,
  notice: string,
): ProfileEditorView {
  let catalog: ProfileCatalog | undefined;
  let previewError: unknown;
  try {
    catalog = candidateCatalog(draft, options);
  } catch (error) {
    previewError = error;
  }
  const effective = catalog?.profiles.find((profile) => profile.name === name);
  const source = catalog?.provenance[name] ??
    draft.catalog.provenance[name] ?? {
      source: draft.destination,
      globalOverride: false,
      projectOverride: false,
    };
  const ownDefinition = independent(draft, name);
  const inherited = inheritedProfile(draft, name, options);
  const raw = rawRole(draft.value, name);
  return {
    title: `Edit ${name} · ${draft.destination} · ${draft.dirty ? "unsaved" : "clean"}`,
    choices: [
      { value: "description", label: "Edit description" },
      { value: "prompt", label: "Edit multiline prompt" },
      ...(!ownDefinition
        ? [
            { value: "reset-description", label: "Reset description" },
            { value: "reset-prompt", label: "Reset prompt" },
            { value: "reset", label: "Reset whole override" },
          ]
        : []),
      { value: "review", label: "Review / Save" },
      { value: "destination", label: "Change destination" },
      { value: "role", label: "Change role" },
      { value: "back", label: "Back to resolved view" },
      ...["tools", "skills", "spawn", "coordination", "models", "model", "prewalk", "fallback"].map(
        (field) => ({ value: `field:${field}`, label: fieldLabels[field] }),
      ),
      ...(name === "general" ? [{ value: "field:leafTools", label: fieldLabels.leafTools }] : []),
      { value: "create", label: "Create / copy custom role" },
      ...(ownDefinition && !bundledNames.has(name)
        ? [{ value: "delete", label: "Delete custom definition" }]
        : []),
      ...(source.source === "project"
        ? [{ value: "ceiling", label: "Change local authority ceiling" }]
        : []),
      ...(draft.destination === "global"
        ? [
            { value: "ceilings", label: "Authorize project-role ceilings" },
            { value: "registrations", label: "Register project-local spawn targets" },
          ]
        : []),
    ],
    lines: [
      ...(notice ? [notice, ""] : []),
      `Write destination: ${draft.destination}`,
      `Exact path: ${draft.path}`,
      `Definition source: ${source.source}${source.ceiling ? `; continuing ceiling: ${source.ceiling}` : ""}`,
      `Overrides: global ${source.globalOverride ? "yes" : "no"}; project ${source.projectOverride ? "yes" : "no"}`,
      "Callable tools: unknown. All changes are drafts until validated, reviewed and saved.",
      ...(previewError
        ? [
            `Effective preview unavailable / invalid: ${String(previewError)}`,
            "Raw controls remain editable. Correct the draft or discard it; Save still validates and rejects invalid policy.",
          ]
        : []),
      ownDefinition
        ? "Independent definition: instructions are required, not inherited from a copied role or ceiling."
        : "Unset means inherit in this destination; empty text is an explicit override.",
      "",
      ...(["description", "prompt"] as const).flatMap((field) => [
        field === "prompt" ? "Prompt" : "Description",
        `Selected-layer value: ${Object.hasOwn(raw, field) ? display(raw[field]) : "<unset / inherited>"}`,
        `Inherited baseline: ${ownDefinition ? "not applicable (independent definition)" : display(inherited?.[field])}`,
        "Effective workspace value:",
        effective?.[field] ?? "<effective preview unavailable>",
        "",
      ]),
      ...Object.keys(fieldLabels)
        .filter((field) => field !== "leafTools" || name === "general")
        .flatMap((field) => [
          fieldLabels[field],
          `Selected-layer: ${display(raw[field])}`,
          `Inherited baseline: ${ownDefinition ? "not applicable (independent definition)" : display(inherited?.[field as keyof Profile])}`,
          `Effective: ${effective ? display(effective[field as keyof Profile]) : "<effective preview unavailable>"}`,
          "",
        ]),
      "Project model/prewalk reset only removes this layer's key; it can re-inherit the operator setting, not disable it. Fallback alone supports explicit false. No null/off sentinel is invented.",
      "Incoming local spawning requires an exact global projectSpawnTargets name/ceiling registration AND a separate parent spawn grant. Scope is all trusted projects using these operator settings, with independent project instructions. Root local launch needs no incoming registration.",
      "Prompt dialog uses native multiline editing. Control characters are displayed safely; submitting replaces that field. Cancel leaves it unchanged.",
    ],
  };
}
const fieldLabels: Record<string, string> = {
  tools: "Builtin tools",
  skills: "Exact skill paths",
  spawn: "Spawn targets",
  coordination: "Coordination actions",
  models: "Exact model allowlist",
  model: "Default model",
  prewalk: "Prewalk target",
  fallback: "Ordered fallback chain",
  leafTools: "General reviewed leaf tools",
};
const requiredArrays = ["tools", "skills", "spawn", "coordination"];
function independent(draft: ProfileConfigDraft, name: string): boolean {
  return (
    !bundledNames.has(name) &&
    (draft.destination === "global" || Object.hasOwn(rawRole(draft.value, name), "ceiling"))
  );
}
function inheritedProfile(
  draft: ProfileConfigDraft,
  name: string,
  options: ProfileDraftOptions,
): Profile | undefined {
  if (independent(draft, name)) return;
  try {
    return resolveProfileCatalog(
      draft.destination === "global" ? {} : draft.catalog.global,
      {},
      options.availableSkills?.() ?? [],
    ).profiles.find((profile) => profile.name === name);
  } catch {
    return;
  }
}
function currentField(
  draft: ProfileConfigDraft,
  name: string,
  field: string,
  options: ProfileDraftOptions,
): unknown {
  const raw = rawRole(draft.value, name);
  if (Object.hasOwn(raw, field)) return raw[field];
  try {
    return candidateCatalog(draft, options).profiles.find((p) => p.name === name)?.[
      field as keyof Profile
    ];
  } catch {
    return inheritedProfile(draft, name, options)?.[field as keyof Profile];
  }
}
function fieldNotes(draft: ProfileConfigDraft, name: string, field: string): string[] {
  return [
    `${name}.${field} · ${draft.destination}`,
    `Write path: ${draft.path}`,
    `Selected-layer value: ${display(rawRole(draft.value, name)[field])}`,
    "This dialog stages only. Back cancels this field's pending selection. Applying a list stores an explicit array; [] removes grants, while reset removes the layer key.",
    ...(field === "skills"
      ? [
          "Exact paths become explicit grants, not future skill discovery. No skill is executed here.",
        ]
      : []),
    ...(field === "leafTools"
      ? [
          "General only. Reviewed names assert trusted leaf code, not a sandbox; no reaching/tool-to-tool forwarding grants.",
        ]
      : []),
    ...(["model", "prewalk"].includes(field)
      ? [
          "Reset removes this layer's key. A project may re-inherit the global setting; it has no model/prewalk off sentinel.",
        ]
      : []),
  ];
}
async function finiteList(
  show: Show,
  title: string,
  notes: string[],
  initial: readonly string[],
  choices: readonly string[],
  reset: boolean,
  label: (value: string) => string = (value) => value,
): Promise<string[] | "reset" | undefined> {
  let selected = [...initial];
  for (;;) {
    const action = await show({
      title,
      lines: [...notes, `Explicit selection: ${display(selected)}`],
      choices: [
        { value: "back", label: "Back without changes" },
        ...(reset ? [{ value: "reset", label: "Reset / inherit" }] : []),
        { value: "apply", label: "Apply explicit selection" },
        { value: "empty", label: "Explicit empty grant []" },
        ...[...new Set([...choices, ...selected])].map((value) => ({
          value: `toggle:${value}`,
          label: `${selected.includes(value) ? "[x]" : "[ ]"} ${label(value)}`,
        })),
      ],
    });
    if (!action || action === "back") return;
    if (action === "reset") return "reset";
    if (action === "apply") return selected;
    if (action === "empty") return [];
    const value = action.slice("toggle:".length);
    selected = selected.includes(value)
      ? selected.filter((item) => item !== value)
      : [...selected, value];
  }
}
async function exactList(
  ctx: Pick<ExtensionCommandContext, "ui">,
  show: Show,
  draft: ProfileConfigDraft,
  name: string,
  field: string,
  options: ProfileDraftOptions,
): Promise<void> {
  let values = [...((currentField(draft, name, field, options) ?? []) as string[])];
  const reset = !(independent(draft, name) && requiredArrays.includes(field));
  for (;;) {
    const action = await show({
      title: fieldLabels[field],
      lines: [...fieldNotes(draft, name, field), ...values.map((value, i) => `${i + 1}. ${value}`)],
      choices: [
        { value: "back", label: "Back without changes" },
        ...(reset ? [{ value: "reset", label: "Reset / inherit" }] : []),
        { value: "apply", label: "Apply exact list" },
        { value: "empty", label: "Explicit empty grant []" },
        {
          value: "add",
          label: field === "skills" ? "Add exact absolute skill path" : "Add reviewed leaf name",
        },
        ...values.map((value, i) => ({ value: String(i), label: `Remove ${i + 1}: ${value}` })),
      ],
    });
    if (!action || action === "back") return;
    if (action === "reset") {
      delete rawRole(draft.value, name)[field];
      return;
    }
    if (action === "apply" || action === "empty") {
      editRole(draft, name)[field] = action === "empty" ? [] : values;
      return;
    }
    if (action === "add") {
      const value = await ctx.ui.input(
        field === "skills"
          ? "Exact absolute skill file path (no trimming)"
          : "Exact reviewed leaf tool name",
      );
      if (value !== undefined && value !== "") values.push(value);
    } else values = values.filter((_, index) => index !== Number(action));
  }
}
function authorityProfile(
  draft: ProfileConfigDraft,
  name: string,
  options: ProfileDraftOptions,
): Profile | undefined {
  const layers = draft.catalog;
  layers[draft.destination] = draft.value;
  const ceiling = rawRole(draft.value, name).ceiling;
  try {
    return resolveProfileCatalog(
      layers.global,
      typeof ceiling === "string" ? layers.project : {},
      options.availableSkills?.() ?? [],
    ).profiles.find((p) => p.name === (ceiling ?? name));
  } catch {
    return draft.catalog.profiles.find((p) => p.name === (ceiling ?? name));
  }
}
const selectionLabel = (selection: ModelSelection) =>
  `${selection.provider}/${selection.id}:${selection.effort}`;
async function exactSelection(
  ctx: Pick<ExtensionCommandContext, "ui">,
  show: Show,
): Promise<ModelSelection | undefined> {
  const provider = await ctx.ui.input("Exact physical model provider (no aliases or trimming)");
  if (provider === undefined) return;
  const id = await ctx.ui.input("Exact model id (no aliases or trimming)");
  if (id === undefined) return;
  const effort = await show({
    title: "Exact model effort",
    lines: [
      `Provider: ${provider}`,
      `Model id: ${id}`,
      "No provider request or auth operation. Availability and supported effort are checked at admission.",
    ],
    choices: [
      { value: "back", label: "Back without adding" },
      ...EFFORTS.map((value) => ({ value, label: value })),
    ],
  });
  if (!effort || effort === "back") return;
  return modelSelection({ provider, id, effort });
}
async function modelField(
  ctx: Pick<ExtensionCommandContext, "ui">,
  show: Show,
  draft: ProfileConfigDraft,
  name: string,
  field: string,
  options: ProfileEditorOptions,
): Promise<void> {
  const notes = fieldNotes(draft, name, field);
  const raw = rawRole(draft.value, name);
  const grants = (currentField(draft, name, "models", options) ?? []) as ModelSelection[];
  const authorized = authorityProfile(draft, name, options);
  const label = (value: ModelSelection) =>
    `${selectionLabel(value)} · ${options.modelStatus?.(value) ?? "availability unknown; checked at admission"}`;
  if (field === "model" || field === "prewalk") {
    const eligible =
      field === "prewalk" && draft.destination === "project"
        ? grants.filter((item) => !!authorized?.prewalk && sameSelection(item, authorized.prewalk))
        : grants;
    const action = await show({
      title: fieldLabels[field],
      lines: [
        ...notes,
        "Eligible exact selections come from the model allowlist. No implicit grants, aliases or effort coercion.",
        "Fallback and prewalk cannot coexist. Make related changes explicitly; temporary invalid drafts remain editable.",
        ...eligible.map(label),
      ],
      choices: [
        { value: "back", label: "Back without changes" },
        { value: "reset", label: "Reset selected-layer setting" },
        ...eligible.map((item, i) => ({ value: String(i), label: label(item) })),
      ],
    });
    if (action === "reset") delete raw[field];
    else if (action !== undefined && action !== "back")
      editRole(draft, name)[field] = eligible[Number(action)];
    return;
  }
  const fallback = field === "fallback";
  const current = currentField(draft, name, field, options);
  let values = Array.isArray(current) ? ([...current] as ModelSelection[]) : [];
  for (;;) {
    const action = await show({
      title: fieldLabels[field],
      lines: [
        ...notes,
        fallback
          ? "Ordered chain; false explicitly disables it. Projects may only keep an allowed subsequence, never add/reorder targets. Prewalk must be absent."
          : "models grants exact overrides, not routing order. Unset permits physical-parent inheritance, not arbitrary overrides; [] denies every selection.",
        "At most 64 rows. Unavailable entries are retained, not silently removed. Structural save validation does not prove auth/scope/effort/provider availability.",
        ...values.map((item, i) => `${i + 1}. ${label(item)}`),
      ],
      choices: [
        { value: "back", label: "Back without changes" },
        { value: "reset", label: "Reset / inherit" },
        { value: "apply", label: fallback ? "Apply ordered chain" : "Apply exact model grants" },
        {
          value: "disable",
          label: fallback ? "Disable fallback (false)" : "Explicit empty grant []",
        },
        ...(values.length < 64
          ? [
              {
                value: "add",
                label: fallback ? "Append granted exact target" : "Add exact model grant",
              },
            ]
          : []),
        ...values.map((item, i) => ({ value: `row:${i}`, label: `${i + 1}. ${label(item)}` })),
      ],
    });
    if (!action || action === "back") return;
    if (action === "reset") {
      delete rawRole(draft.value, name)[field];
      return;
    }
    if (action === "disable") {
      editRole(draft, name)[field] = fallback ? false : [];
      return;
    }
    if (action === "apply") {
      if (fallback && !values.length)
        throw new Error(
          "Fallback requires a nonempty chain; choose explicit Disable fallback instead",
        );
      editRole(draft, name)[field] = values;
      return;
    }
    if (action === "add") {
      let value: ModelSelection | undefined;
      if (!fallback && draft.destination === "global") value = await exactSelection(ctx, show);
      else {
        const choices = fallback
          ? draft.destination === "project"
            ? (authorized?.fallback ?? []).filter((item) =>
                grants.some((grant) => sameSelection(grant, item)),
              )
            : grants
          : (authorized?.models ?? []);
        const selected = await show({
          title: "Choose exact authorized model",
          lines: [
            "Choose an existing exact grant. Projects cannot mint model/prewalk/fallback authority.",
            ...choices.map(label),
          ],
          choices: [
            { value: "back", label: "Back without adding" },
            ...choices.map((item, i) => ({ value: String(i), label: label(item) })),
          ],
        });
        if (selected !== undefined && selected !== "back") value = choices[Number(selected)];
      }
      if (value) values.push(value);
    } else {
      const index = Number(action.slice("row:".length));
      const row = await show({
        title: `Exact row ${index + 1}`,
        lines: [label(values[index]), "Removing/reordering is explicit. No model dispatch occurs."],
        choices: [
          { value: "back", label: "Back" },
          { value: "remove", label: "Remove this row" },
          ...(fallback && draft.destination === "global"
            ? [
                { value: "up", label: "Move earlier" },
                { value: "down", label: "Move later" },
              ]
            : []),
        ],
      });
      if (row === "remove") values.splice(index, 1);
      const next = row === "up" ? index - 1 : row === "down" ? index + 1 : -1;
      if (next >= 0 && next < values.length)
        [values[index], values[next]] = [values[next], values[index]];
    }
  }
}
async function editField(
  ctx: Pick<ExtensionCommandContext, "ui">,
  show: Show,
  draft: ProfileConfigDraft,
  name: string,
  field: string,
  options: ProfileEditorOptions,
): Promise<void> {
  if (["models", "model", "prewalk", "fallback"].includes(field))
    return modelField(ctx, show, draft, name, field, options);
  if (field === "skills" || field === "leafTools")
    return exactList(ctx, show, draft, name, field, options);
  const targets = (
    draft.destination === "global"
      ? (draft.value.projectSpawnTargets ?? {})
      : draft.catalog.projectSpawnTargets
  ) as Record<string, string>;
  const roles = [
    ...bundledNames,
    ...Object.keys(entries(draft.catalog.global)),
    ...(draft.destination === "global" ? Object.keys(entries(draft.value)) : []),
    ...Object.keys(targets),
  ];
  const authority =
    draft.destination === "project"
      ? authorityProfile(draft, name, options)
      : bundledProfiles().find((p) => p.name === name);
  const choices =
    field === "tools"
      ? [...(authority?.tools ?? (draft.destination === "global" ? WRITE_TOOLS : []))]
      : field === "coordination"
        ? [
            ...(draft.destination === "global"
              ? COORDINATION_ACTIONS
              : (authority?.coordination ?? [])),
          ]
        : draft.destination === "global"
          ? roles
          : [...(authority?.spawn ?? [])];
  const selected = await finiteList(
    show,
    fieldLabels[field],
    fieldNotes(draft, name, field),
    (currentField(draft, name, field, options) ?? []) as string[],
    choices,
    !(independent(draft, name) && requiredArrays.includes(field)),
    (value) =>
      field === "spawn" && Object.hasOwn(targets, value)
        ? `${value} [registered:${targets[value]}; conditional trusted local]`
        : value,
  );
  if (selected === "reset") delete rawRole(draft.value, name)[field];
  else if (selected !== undefined) editRole(draft, name)[field] = selected;
}
async function registrations(
  ctx: Pick<ExtensionCommandContext, "ui">,
  show: Show,
  draft: ProfileConfigDraft,
): Promise<void> {
  const targets = structuredClone(
    (draft.value.projectSpawnTargets ?? {}) as Record<string, string>,
  );
  const allowed = (draft.value.projectRoleCeilings ?? []) as string[];
  for (;;) {
    const action = await show({
      title: "Global project-local spawn registrations",
      lines: [
        `Exact operator path: ${draft.path}`,
        "Scope: ALL trusted projects using these operator settings; each can supply independent instructions for an exact registered name under its required ceiling. No workspace/path binding.",
        "Registration creates no profile, no local definition and no parent spawn entry. Separately edit the parent's Spawn targets. Missing/untrusted targets still reject at launch; projects cannot mint registrations.",
        "Back cancels this dialog. Reset removes the metadata key; explicit {} disables registrations. Removing/rebinding an in-use target requires explicit spawn-reference repair and may require a separate project edit; no cross-file cascade.",
        ...Object.entries(targets).map(([name, ceiling]) => `${name} → ${ceiling}`),
      ],
      choices: [
        { value: "back", label: "Back without changes" },
        { value: "reset", label: "Reset registration key" },
        { value: "empty", label: "Explicit empty registrations {}" },
        { value: "apply", label: "Apply exact registrations" },
        { value: "add", label: "Register exact local name" },
        ...Object.keys(targets).map((name) => ({
          value: `edit:${name}`,
          label: `Edit/remove ${name}`,
        })),
      ],
    });
    if (!action || action === "back") return;
    if (action === "reset") {
      delete draft.value.projectSpawnTargets;
      return;
    }
    if (action === "empty" || action === "apply") {
      draft.value.projectSpawnTargets = action === "empty" ? {} : targets;
      return;
    }
    const name =
      action === "add"
        ? await ctx.ui.input("Exact project-local target name (not a global role; no wildcard)")
        : action.slice("edit:".length);
    if (name === undefined) continue;
    validateCustomRoleName(name);
    if (Object.hasOwn(entries(draft.value), name))
      throw new Error(`Registered target collides with global custom role: ${name}`);
    const choice = await show({
      title: `Required ceiling for ${name}`,
      lines: [
        "Choose an already operator-allowlisted global ceiling. Changing this binding does not change independent project content; mismatches reject.",
        ...(allowed.length
          ? []
          : [
              "No allowlisted ceilings. Edit global project-role ceiling authorization explicitly first.",
            ]),
      ],
      choices: [
        { value: "back", label: "Back without changes" },
        ...(Object.hasOwn(targets, name)
          ? [{ value: "remove", label: "Remove this registration" }]
          : []),
        ...allowed.map((ceiling) => ({ value: `ceiling:${ceiling}`, label: ceiling })),
      ],
    });
    if (choice === "remove") delete targets[name];
    else if (choice?.startsWith("ceiling:")) targets[name] = choice.slice("ceiling:".length);
  }
}

async function createRole(
  ctx: Pick<ExtensionCommandContext, "ui">,
  show: Show,
  draft: ProfileConfigDraft,
  source: string,
): Promise<string | undefined> {
  const name = await ctx.ui.input(
    "New independent custom role name (lowercase letters/digits/hyphens, max 64)",
  );
  if (name === undefined) return;
  validateCustomRoleName(name);
  if (
    draft.catalog.profiles.some((p) => p.name === name) ||
    Object.hasOwn(entries(draft.value), name)
  )
    throw new Error(`Role already exists: ${name}; no shadowing or silent conversion`);
  let ceiling: string | undefined;
  if (draft.destination === "project") {
    const allowed = draft.catalog.projectRoleCeilings;
    const selected = await show({
      title: "Choose project-local authority ceiling",
      lines: [
        "Independent explicit settings, not content inheritance. Existing operator authorization is required; the editor never grants it from a project.",
        ...(allowed.length
          ? []
          : [
              "No authorized ceilings. Ask the operator to explicitly edit global project-role ceiling authorization first.",
            ]),
      ],
      choices: [
        { value: "back", label: "Back without creating" },
        ...allowed.map((value) => ({ value, label: value })),
      ],
    });
    if (!selected || selected === "back") return;
    ceiling = selected;
  }
  const mode = await show({
    title: "Independent custom definition",
    lines: [
      "Blank starts with explicit empty grant arrays. Copy is a one-time expansion, never ongoing content inheritance.",
      "Copying general never copies automatic skill discovery or reviewed leaf forwarding. Exact copied skill paths become explicit grants and must be reviewed.",
      "A new name is never added to anyone's spawn grants. Incoming local spawning requires separate exact global registration and an explicit parent grant. Registrations apply across trusted projects, not only this workspace.",
    ],
    choices: [
      { value: "back", label: "Back without creating" },
      { value: "blank", label: "Blank independent definition" },
      { value: "copy", label: `Copy resolved ${source} once` },
    ],
  });
  if (!mode || mode === "back") return;
  let definition: Record<string, unknown> = {
    description: "Custom delegation profile",
    prompt: "Complete the assigned task and report evidence and limitations.",
    tools: [],
    skills: [],
    spawn: [],
    coordination: [],
  };
  if (mode === "copy") {
    const profile = draft.catalog.profiles.find((p) => p.name === source)!;
    if (
      (await show({
        title: "Review one-time copied grants",
        lines: [
          `Source: ${source}`,
          `New independent role: ${name}`,
          "These exact skill paths become explicit grants, not future discovery:",
          ...profile.skills,
          "General-only automatic inheritance and leaf forwarding are NOT copied. Other explicit supported fields are copied; review/narrow them before save.",
        ],
        choices: [
          { value: "back", label: "Back without creating" },
          { value: "copy", label: "Stage explicit one-time copy" },
        ],
      })) !== "copy"
    )
      return;
    const {
      name: _name,
      leafTools: _leaf,
      inheritedModelCeiling: _authority,
      projectCeiling: _ceiling,
      projectSpawnAuthorized: _incoming,
      ...settings
    } = profile;
    definition = structuredClone(settings);
  }
  if (ceiling) definition.ceiling = ceiling;
  const custom = (draft.value.customProfiles ??= {}) as Record<string, unknown>;
  custom[name] = definition;
  return name;
}
async function stageDeletion(
  show: Show,
  draft: ProfileConfigDraft,
  name: string,
): Promise<Record<string, unknown> | undefined> {
  const before = structuredClone(draft.value);
  const affectedTargets = Object.entries({
    ...draft.catalog.projectSpawnTargets,
    ...((draft.value.projectSpawnTargets ?? {}) as Record<string, string>),
  })
    .filter(([target, ceiling]) => target === name || ceiling === name)
    .map(([target]) => target);
  draft.deleteCustomRole(name);
  for (;;) {
    const spawn = [...bundledNames, ...Object.keys(entries(draft.value))].flatMap((role) =>
      [...new Set([name, ...affectedTargets])]
        .filter((target) =>
          (rawRole(draft.value, role).spawn as string[] | undefined)?.includes(target),
        )
        .map((target) => ({ role, target })),
    );
    const blockers = [
      ...draft.deletionBlockers(),
      ...spawn
        .filter(({ target }) => target !== name)
        .map(({ role, target }) => ({
          role: name,
          location: `${draft.path}:${role}.spawn`,
          reason: `Explicitly remove conditional target ${target} before removing its registration/ceiling`,
        })),
    ];
    const ceilings = draft.value.projectRoleCeilings as string[] | undefined;
    const targets = (draft.value.projectSpawnTargets ?? {}) as Record<string, string>;
    const registrationRefs = Object.entries(targets)
      .filter(([target, ceiling]) => target === name || ceiling === name)
      .map(([target]) => target);
    const action = await show({
      title: "Review custom deletion",
      lines: [
        `Delete ${name} from ${draft.path}`,
        "Only this file can change. Other workspaces/processes cannot be checked; their admissions may reject after global deletion. Historical task records are never changed.",
        "Back cancels this deletion and its staged reference removals.",
        ...blockers.map((blocker) => `${blocker.location}: ${blocker.reason}`),
        ...(blockers.length
          ? [
              "Remove references explicitly or stop/drain local tasks using existing /subagent-stop controls. Project overrides/ceiling references in the other file need a separate explicit repair.",
            ]
          : ["No known local reference or reusable-task blockers."]),
      ],
      choices: [
        { value: "back", label: "Cancel deletion changes" },
        ...(!blockers.length ? [{ value: "delete", label: "Stage definition deletion" }] : []),
        ...spawn.map(({ role, target }) => ({
          value: `spawn:${role}:${target}`,
          label: `Remove ${role}.spawn reference${target === name ? "" : ` to ${target}`}`,
        })),
        ...(ceilings?.includes(name)
          ? [{ value: "ceiling", label: "Remove operator ceiling authorization" }]
          : []),
        ...registrationRefs.map((target) => ({
          value: `registration:${target}`,
          label: `Remove registration ${target}`,
        })),
      ],
    });
    if (!action || action === "back") {
      draft.value = before;
      return;
    }
    if (action === "delete") return before;
    if (action.startsWith("registration:")) delete targets[action.slice("registration:".length)];
    else if (action === "ceiling")
      draft.value.projectRoleCeilings = ceilings!.filter((role) => role !== name);
    else {
      const [role, target] = action.slice("spawn:".length).split(":");
      editRole(draft, role).spawn = (rawRole(draft.value, role).spawn as string[]).filter(
        (value) => value !== target,
      );
    }
  }
}

function errorView(error: unknown, editable: boolean): ProfileEditorView {
  return {
    title: "Profile configuration error",
    choices: editable
      ? [
          { value: "keep", label: "Keep editing draft" },
          { value: "reload", label: "Reload / review disk" },
        ]
      : [{ value: "back", label: "Back / close" }],
    lines: [
      String(error),
      "Draft retained. No automatic repair, force-overwrite or rollback.",
      ...(error instanceof ProfileConfigError
        ? [
            `Replacement: ${error.replacement}`,
            ...error.blockers.map((blocker) => `${blocker.location}: ${blocker.reason}`),
            ...Object.entries(error.observed ?? {}).flatMap(([layer, observed]) =>
              observed
                ? [
                    `Observed ${layer}: ${observed.path}`,
                    "content" in observed ? (observed.content ?? "<missing>") : observed.error,
                  ]
                : [],
            ),
          ]
        : []),
      "Repair malformed/unsupported input externally. Reopening uses current disk state only after explicit discard of any dirty draft.",
    ],
  };
}

/** Command-only native interaction. Non-TUI callers keep the separate read-only envelope. */
export async function runProfileEditor(
  ctx: Pick<ExtensionCommandContext, "mode" | "ui">,
  options: ProfileEditorOptions,
): Promise<void> {
  if (ctx.mode !== "tui") throw new Error("Profile editing requires native TUI mode");
  const show = (view: ProfileEditorView) =>
    ctx.ui.custom<string | undefined>(
      (tui, theme, keys, done) =>
        createProfileEditorScreen(
          view,
          theme,
          keys,
          () => tui.requestRender(),
          done,
          () => Math.max(1, Math.floor(tui.terminal.rows * 0.9)),
        ),
      {
        overlay: true,
        overlayOptions: { width: "90%", maxHeight: "90%", anchor: "center" },
        blocked: { kind: "question", message: view.title },
      },
    );
  const discard = async (draft: ProfileConfigDraft) =>
    !draft.dirty ||
    (await show({
      title: "Unsaved profile draft",
      lines: [
        `Unsaved edits for ${draft.path}`,
        "Keep editing retains the entire draft. Discard drops it without saving.",
      ],
      choices: [
        { value: "keep", label: "Keep editing" },
        { value: "discard", label: "Discard draft" },
      ],
    })) === "discard";
  const load = async () => {
    const current = await loadProfileCatalog(
      options.cwd,
      options.isProjectTrusted(),
      options.operatorDir,
      options.availableSkills?.() ?? [],
    );
    await validateProfileSkills(current.profiles, options.cwd, options.operatorDir);
    return current;
  };
  let catalog: ProfileCatalog;
  try {
    catalog = await load();
  } catch (error) {
    await show(errorView(error, false));
    return;
  }
  let name: string | undefined;
  let draft: ProfileConfigDraft | undefined;
  let page: "resolved" | "destination" | "form" = "resolved";
  let notice = "";
  let deletionUndo: Record<string, unknown> | undefined;
  while (true) {
    if (page === "resolved") {
      const result = await ctx.ui.custom<string | undefined>(
        (tui, theme, keys, done) =>
          createProfileViewer(
            catalog.profiles,
            theme,
            keys,
            () => tui.requestRender(),
            () => done(undefined),
            () => Math.max(1, Math.floor(tui.terminal.rows * 0.9)),
            { initialRole: name, edit: done, catalog, trusted: options.isProjectTrusted() },
          ),
        {
          overlay: true,
          overlayOptions: { width: "90%", maxHeight: "90%", anchor: "center" },
          blocked: { kind: "question", message: "Inspect profiles or explicitly edit" },
        },
      );
      if (!result) return;
      name = result;
      page = "destination";
    }
    if (page === "destination") {
      const local = catalog.provenance[name!]?.source === "project";
      const destination = await show({
        title: "Choose write destination",
        lines: [
          `Role: ${name}`,
          `Global operator file: ${catalog.globalPath}`,
          `Project file: ${catalog.projectPath}`,
          "Global edits affect other workspaces. Project edits require existing host trust and can only narrow authority.",
          ...(local
            ? ["This independent project-local definition cannot be edited in the global layer."]
            : []),
          ...(!options.isProjectTrusted()
            ? ["Project editing disabled: workspace is untrusted. Trust is never changed here."]
            : []),
        ],
        choices: [
          { value: "back", label: "Back to resolved view" },
          ...(!local ? [{ value: "global", label: "Global operator settings" }] : []),
          ...(options.isProjectTrusted()
            ? [{ value: "project", label: "Trusted project settings" }]
            : []),
        ],
      });
      if (!destination || destination === "back") {
        page = "resolved";
        continue;
      }
      try {
        draft = await ProfileConfigDraft.open(destination as ProfileDestination, options);
        catalog = draft.catalog;
        page = "form";
      } catch (error) {
        await show(errorView(error, false));
        continue;
      }
    }
    if (!draft) continue;
    try {
      const action = await show(
        deletionUndo
          ? {
              title: `Delete ${name} · staged`,
              lines: [
                `Definition deletion staged in ${draft.path}. Review / Save validates current references and tasks again.`,
                notice,
              ],
              choices: [
                { value: "review", label: "Review / Save" },
                { value: "undo-delete", label: "Undo deletion changes" },
                { value: "back", label: "Back to resolved view" },
              ],
            }
          : formView(draft, name!, options, notice),
      );
      notice = "";
      if (action?.startsWith("field:")) {
        await editField(ctx, show, draft, name!, action.slice("field:".length), options);
      } else if (action === "registrations") {
        await registrations(ctx, show, draft);
      } else if (action === "ceilings") {
        const roles = [...bundledNames, ...Object.keys(entries(draft.value))];
        const selected = await finiteList(
          show,
          "Operator project-role ceiling authorization",
          [
            "GLOBAL operator authorization only. This enables named ceilings for independent local definitions; it is not a spawn grant. Absence/[] disables local creation. Tightening can invalidate existing local definitions and will be validated against this trusted project.",
            `Write path: ${draft.path}`,
          ],
          (draft.value.projectRoleCeilings ?? []) as string[],
          roles,
          true,
        );
        if (selected === "reset") delete draft.value.projectRoleCeilings;
        else if (selected !== undefined) draft.value.projectRoleCeilings = selected;
      } else if (action === "ceiling") {
        const selected = await show({
          title: "Change continuing authority ceiling",
          lines: [
            "This changes authority only; instructions/grants are independent and are never auto-pruned or copied.",
          ],
          choices: [
            { value: "back", label: "Back without changes" },
            ...draft.catalog.projectRoleCeilings.map((role) => ({ value: role, label: role })),
          ],
        });
        if (selected && selected !== "back") editRole(draft, name!).ceiling = selected;
      } else if (action === "create") {
        if (!(await discard(draft))) continue;
        const fresh = await ProfileConfigDraft.open(draft.destination, options);
        draft = fresh;
        catalog = fresh.catalog;
        if (!catalog.profiles.some((profile) => profile.name === name)) name = "general";
        const created = await createRole(ctx, show, fresh, name!);
        if (created) {
          name = created;
          notice =
            "Independent definition staged. Choose usable tools explicitly; no spawn targets were added automatically.";
        }
      } else if (action === "delete") {
        deletionUndo = await stageDeletion(show, draft, name!);
      } else if (action === "undo-delete") {
        draft.value = deletionUndo!;
        deletionUndo = undefined;
      } else if (action === "description" || action === "prompt") {
        const current = currentField(draft, name!, action, options) ?? "";
        const text =
          action === "prompt"
            ? await ctx.ui.editor(
                `Prompt: ${safe(name!)} · submit replaces; cancel preserves`,
                safe(String(current)),
              )
            : await ctx.ui.input(
                `Replace description: ${safe(name!)} (empty allowed; cancel preserves)`,
                safe(String(current)),
              );
        if (text !== undefined) editRole(draft, name!)[action] = text;
      } else if (action === "reset-description" || action === "reset-prompt") {
        delete rawRole(draft.value, name!)[action.slice("reset-".length)];
      } else if (action === "reset") draft.resetOverride(name!);
      else if (action === "review") {
        const candidate = await draft.validate();
        if ((await show(profileSaveReview(draft, candidate))) === "save") {
          const saved = await draft.save();
          catalog = saved.catalog;
          notice = `Saved and verified: ${saved.path}`;
          if (deletionUndo) {
            await show({
              title: "Saved profile deletion",
              lines: [
                notice,
                "Local history remains unchanged. Other workspaces may still reference the deleted global role.",
              ],
              choices: [{ value: "back", label: "Back to resolved view" }],
            });
            deletionUndo = undefined;
            draft = undefined;
            name = undefined;
            page = "resolved";
          }
        }
      } else if (["destination", "role", "back", undefined].includes(action)) {
        if (!(await discard(draft))) continue;
        deletionUndo = undefined;
        if (action === "role") {
          const selected = await show({
            title: "Choose profile",
            lines: ["Changing role opens a fresh draft; no changes are saved implicitly."],
            choices: catalog.profiles.map((profile) => ({
              value: profile.name,
              label: profile.name,
            })),
          });
          if (selected) {
            name = selected;
            draft = undefined;
            page = "destination";
          } else {
            draft = await ProfileConfigDraft.open(draft.destination, options);
            catalog = draft.catalog;
          }
        } else {
          draft = undefined;
          catalog = await load();
          page = action === "destination" ? "destination" : "resolved";
        }
      }
    } catch (error) {
      const retained = draft;
      if (!retained) {
        await show(errorView(error, false));
        page = "resolved";
        continue;
      }
      if ((await show(errorView(error, true))) === "reload" && (await discard(retained))) {
        try {
          const fresh = await ProfileConfigDraft.open(retained.destination, options);
          draft = fresh;
          deletionUndo = undefined;
          catalog = fresh.catalog;
          notice = "Reloaded current disk; review before editing.";
          if (!catalog.profiles.some((profile) => profile.name === name)) {
            draft = undefined;
            name = undefined;
            page = "resolved";
          }
        } catch (reloadError) {
          await show(errorView(reloadError, false));
        }
      }
    }
  }
}
