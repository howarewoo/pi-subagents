import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
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
  validateCustomRoleName,
  type Profile,
  type ProfileCatalog,
} from "./profiles.ts";
import { createProfileViewer } from "./profile-viewer.ts";
import {
  profileCell as cell,
  profileRowPaint,
  type ProfilePanelTheme,
} from "./profile-presentation.ts";
import { safe } from "./thread.ts";
import { profileModelReason, type ProfileModelSource } from "./profile-model-catalog.ts";
import { ProfileAutosaveController } from "./profile-autosave.ts";
import {
  createEditableProfileInspector,
  type InspectorExit,
  type StructuralAction,
} from "./profile-inspector.ts";

export type ProfileEditorView = {
  title: string;
  lines: readonly string[];
  choices: readonly { value: string; label: string }[];
};
export type ProfileEditorOptions = ProfileDraftOptions & {
  modelCatalog?: ProfileModelSource;
};
type Show = (view: ProfileEditorView) => Promise<string | undefined>;
type ScreenKeys = Pick<KeybindingsManager, "matches" | "getKeys">;

/** Bounded native selection/detail screen. Text dialogs run only after this interaction closes. */
export function createProfileEditorScreen(
  view: ProfileEditorView,
  theme: ProfilePanelTheme,
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
  return {
    capturesViewportInput: true,
    render(width) {
      width = Math.max(0, width);
      const height = Math.max(1, Math.floor(availableRows()));
      const paint = profileRowPaint(theme, width);
      const close = safe(keys.getKeys("tui.select.cancel").join("/") || "Esc");
      const confirm = safe(keys.getKeys("tui.select.confirm").join("/") || "Enter");
      compact = width < 24 || height < 12;
      if (compact)
        return ["Profiles · resize", "Transaction retained", `${close}: back`]
          .slice(0, height)
          .map(paint);
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
      ].map(paint);
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

/** Preserved whole-layer transactions, only for lifecycle and structural authority changes.
 * Ordinary instructions, permissions and model policy are exclusively item intents. */
export async function runProfileStructuralTransaction(
  ctx: Pick<ExtensionCommandContext, "ui">,
  show: Show,
  destination: ProfileDestination,
  options: ProfileEditorOptions,
  initialName: string,
  action: StructuralAction,
): Promise<string> {
  let draft = await ProfileConfigDraft.open(destination, options);
  let name = initialName;
  let deletionUndo: Record<string, unknown> | undefined;
  const change = async () => {
    if (action === "create")
      name = (await createRole(ctx, show, draft, initialName)) ?? initialName;
    else if (action === "delete") deletionUndo = await stageDeletion(show, draft, name);
    else if (action === "reset-override") {
      if (
        (await show({
          title: "Reset whole override",
          lines: [
            `Remove the whole ${name} override in ${draft.path}. Inherited settings return; this is not Disable.`,
          ],
          choices: [
            { value: "back", label: "Back without changes" },
            { value: "reset", label: "Stage whole override reset" },
          ],
        })) === "reset"
      )
        draft.resetOverride(name);
    } else if (action === "registrations") await registrations(ctx, show, draft);
    else if (action === "ceilings") {
      const value = await finiteList(
        show,
        "Operator project-role ceiling authorization",
        [
          "GLOBAL: all trusted projects; independent local authority, not a spawn grant.",
          `Write path: ${draft.path}`,
        ],
        (draft.value.projectRoleCeilings ?? []) as string[],
        [...bundledNames, ...Object.keys(entries(draft.value))],
        true,
      );
      if (value === "reset") delete draft.value.projectRoleCeilings;
      else if (value !== undefined) draft.value.projectRoleCeilings = value;
    } else if (action === "ceiling") {
      const value = await show({
        title: "Change continuing authority ceiling",
        lines: ["Authority only; no instruction/grant copying or automatic pruning."],
        choices: [
          { value: "back", label: "Back without changes" },
          ...draft.catalog.projectRoleCeilings.map((value) => ({ value, label: value })),
        ],
      });
      if (value && value !== "back") editRole(draft, name).ceiling = value;
    }
  };
  await change();
  while (draft.dirty) {
    try {
      const priorTargets = draft.catalog.projectSpawnTargets;
      const nextTargets = (draft.value.projectSpawnTargets ?? {}) as Record<string, string>;
      const repair =
        action === "registrations"
          ? [...bundledNames, ...Object.keys(entries(draft.value))].flatMap((role) =>
              ((rawRole(draft.value, role).spawn ?? []) as string[])
                .filter(
                  (target) =>
                    Object.hasOwn(priorTargets, target) &&
                    priorTargets[target] !== nextTargets[target],
                )
                .map((target) => ({ role, target })),
            )
          : [];
      const choice = await show({
        title: `Advanced structural transaction · ${name}`,
        lines: [
          `Exact path: ${draft.path}`,
          "Ordinary autosaves are drained and frozen. Only these explicit structural changes are staged.",
          ...rawChanges(draft.original, draft.value),
        ],
        choices: [
          { value: "back", label: "Discard structural transaction / return" },
          { value: "review", label: "Review structural save" },
          { value: "change", label: "Continue structural operation" },
          ...(deletionUndo ? [{ value: "undo", label: "Undo deletion changes" }] : []),
          ...repair.map(({ role, target }) => ({
            value: `repair:${role}:${target}`,
            label: `Remove ${role}.spawn reference to ${target}`,
          })),
        ],
      });
      if (!choice || choice === "back") {
        if (
          (await show({
            title: "Discard structural transaction?",
            lines: [
              `Only unsaved structural changes in ${draft.path} are discarded. Earlier item saves remain.`,
            ],
            choices: [
              { value: "keep", label: "Keep structural transaction" },
              { value: "discard", label: "Discard structural changes" },
            ],
          })) === "discard"
        )
          return initialName;
      } else if (choice === "change") await change();
      else if (choice === "undo") {
        draft.value = deletionUndo!;
        deletionUndo = undefined;
      } else if (choice.startsWith("repair:")) {
        const [role, target] = choice.slice(7).split(":");
        editRole(draft, role).spawn = ((rawRole(draft.value, role).spawn ?? []) as string[]).filter(
          (item) => item !== target,
        );
      } else if (choice === "review") {
        const candidate = await draft.validate();
        if ((await show(profileSaveReview(draft, candidate))) === "save") {
          await draft.save();
          return draft.catalog.profiles.some((p) => p.name === name) ? name : "general";
        }
      }
    } catch (error) {
      const uncertain =
        error instanceof ProfileConfigError &&
        (error.stage === "conflict" || error.replacement !== "not-attempted");
      let choice: string | undefined;
      do {
        choice = await show({
          ...errorView(error, !uncertain),
          choices: [
            ...(!uncertain
              ? [{ value: "keep", label: "Keep correcting structural transaction" }]
              : []),
            { value: "reload", label: "Abandon structural changes and Reload" },
          ],
        });
      } while (uncertain && choice !== "reload");
      if (choice === "reload") {
        draft = await ProfileConfigDraft.open(destination, options);
        return initialName;
      }
    }
  }
  return draft.catalog.profiles.some((p) => p.name === name) ? name : initialName;
}

/** Command-only native interaction; non-TUI callers retain their read-only envelope. */
export async function runProfileEditor(
  ctx: Pick<ExtensionCommandContext, "mode" | "ui">,
  options: ProfileEditorOptions,
): Promise<void> {
  if (ctx.mode !== "tui") throw new Error("Profile editing requires native TUI mode");
  const show: Show = (view) =>
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
  let catalog: ProfileCatalog;
  try {
    catalog = (await ProfileConfigDraft.open("global", options)).catalog;
  } catch (error) {
    await show(errorView(error, false));
    return;
  }
  let name: string | undefined;
  let controller: ProfileAutosaveController | undefined;
  const queueOptions = {
    ...options,
    checkSelection(target: Parameters<typeof profileModelReason>[1]) {
      const reason = profileModelReason(
        options.modelCatalog?.() ?? { entries: [], error: "Model metadata unavailable" },
        target,
      );
      if (reason) throw new Error(reason);
    },
  };
  for (;;) {
    if (!controller) {
      if (!name) {
        name = await ctx.ui.custom<string | undefined>(
          (tui, theme, keys, done) =>
            createProfileViewer(
              catalog.profiles,
              theme,
              keys,
              () => tui.requestRender(),
              () => done(undefined),
              () => Math.max(1, Math.floor(tui.terminal.rows * 0.9)),
              { edit: done, catalog, trusted: options.isProjectTrusted() },
            ),
          {
            overlay: true,
            overlayOptions: { width: "90%", maxHeight: "90%", anchor: "center" },
            blocked: { kind: "question", message: "Inspect profiles or explicitly edit" },
          },
        );
        if (!name) return;
      }
      const local = catalog.provenance[name]?.source === "project";
      const destination = await show({
        title: "Choose write destination",
        lines: [
          `Role: ${name}`,
          `Global operator file: ${catalog.globalPath}`,
          `Project file: ${catalog.projectPath}`,
          "Global edits affect other workspaces. Project editing requires existing host trust; no trust is granted here.",
          ...(!options.isProjectTrusted()
            ? ["Project editing disabled: workspace is untrusted"]
            : []),
          ...(local
            ? [
                "Project-local definition cannot be edited in Global; choose trusted Project explicitly.",
              ]
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
        name = undefined;
        continue;
      }
      try {
        controller = await ProfileAutosaveController.open(
          destination as ProfileDestination,
          queueOptions,
        );
      } catch (error) {
        await show(errorView(error, false));
        continue;
      }
    }
    let dispose: (() => void) | undefined;
    const result = await ctx.ui.custom<InspectorExit>(
      (tui, theme, keys, done) => {
        const screen = createEditableProfileInspector(
          controller!,
          {
            modelCatalog: options.modelCatalog,
            availableSkills: options.availableSkills?.(),
            isProjectTrusted: options.isProjectTrusted,
            initialRole: name,
          },
          tui,
          theme,
          keys,
          () => tui.requestRender(),
          done,
          () => Math.max(1, Math.floor(tui.terminal.rows * 0.9)),
        );
        dispose = screen.dispose;
        return screen;
      },
      {
        overlay: true,
        overlayOptions: { width: "90%", maxHeight: "90%", anchor: "center" },
        blocked: { kind: "question", message: "Profile Inspector · item-change autosave" },
      },
    );
    dispose?.();
    await controller.settled();
    if (!result) return;
    name = result.profile;
    if (result.action === "destination") {
      catalog = controller.verified;
      controller = undefined;
      continue;
    }
    try {
      name = await runProfileStructuralTransaction(
        ctx,
        show,
        controller.destination,
        options,
        name,
        result.action,
      );
    } catch (error) {
      await show(errorView(error, false));
    }
    await controller.reload();
  }
}
