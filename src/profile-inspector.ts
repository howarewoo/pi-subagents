import {
  Editor,
  Input,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
  type Focusable,
  type KeybindingsManager,
  type TUI,
} from "@earendil-works/pi-tui";
import {
  bundledProfiles,
  resolveProfileCatalog,
  WRITE_TOOLS,
  COORDINATION_ACTIONS,
  type Profile,
} from "./profiles.ts";
import {
  ProfileAutosaveController,
  profileGrantRemovalReason,
  type OrdinaryProfileField,
  type ProfileIntent,
} from "./profile-autosave.ts";
import { type ModelSelection } from "./model-policy.ts";
import {
  profileModelLabel,
  profileModelReason,
  type ProfileModelCatalog,
  type ProfileModelSource,
} from "./profile-model-catalog.ts";
import { createProfileModelPicker } from "./profile-model-picker.ts";
import {
  profileCell as cell,
  profileChainRow,
  profileEffortLabel,
  profileKeyText,
  profileRowPaint,
  profileSettingLines,
  type ProfilePanelTheme,
} from "./profile-presentation.ts";
import {
  profileOverview,
  profileOverviewValue,
  profileSettingLabels,
  profileSettingHelp,
  profileRawRole as rawRole,
  profileSettingFields,
  type ProfileSetting,
} from "./profile-overview.ts";
import { safe } from "./thread.ts";
import { isAbsolute } from "node:path";

export type StructuralAction =
  | "create"
  | "delete"
  | "ceiling"
  | "ceilings"
  | "registrations"
  | "reset-override";
export type InspectorExit =
  | { profile: string; action: "destination" | StructuralAction }
  | undefined;
type Row = {
  id: string;
  text: string;
  run?: () => void;
  reason?: string;
  heading?: boolean;
  label?: string;
  value?: string;
  /** Position in the model chain; rendered as a chain row with keys of its own. */
  chain?: number;
  divider?: boolean;
  /** `value` is already sanitized and styled. */
  styled?: boolean;
  help?: string;
  metadata?: string;
  warning?: string;
  outcome?: string;
  membership?: boolean;
  /** Overview text preview, truncated to one line; the full text opens in its setting. */
  preview?: boolean;
  /** Read-only detail owned by the preceding action; rendered indented beneath it. */
  detail?: boolean;
};
const bundled = new Set(bundledProfiles().map((p) => p.name));
const exact = (target: ModelSelection) =>
  JSON.stringify([target.provider, target.id, target.effort]);
function leftTruncate(text: string, width: number): string {
  if (visibleWidth(text) <= width) return text;
  if (width < 2) return truncateToWidth(text, width, "");
  const chars = [...text];
  let tail = "";
  for (let index = chars.length - 1; index >= 0; index--) {
    if (visibleWidth(chars[index] + tail) > width - 1) break;
    tail = chars[index] + tail;
  }
  return `…${tail}`;
}
const format = (value: unknown) =>
  value === undefined ? "unset / inherited" : JSON.stringify(value);

/** Persistent rail and grouped pane. Native input, multiline editor and catalog are composed inside
 * the same painted surface; only drained structural transactions leave this component. */
export function createEditableProfileInspector(
  controller: ProfileAutosaveController,
  options: {
    modelCatalog?: ProfileModelSource;
    availableSkills?: Parameters<typeof resolveProfileCatalog>[2];
    initialRole?: string;
    isProjectTrusted: () => boolean;
  },
  tui: TUI,
  theme: ProfilePanelTheme,
  keys: Pick<KeybindingsManager, "matches" | "getKeys">,
  requestRender: () => void,
  done: (result: InspectorExit) => void,
  availableRows: () => number,
): Component & Focusable & { dispose: () => void } {
  let name = options.initialRole ?? "general";
  let focus: "rail" | "settings" = "settings";
  let activeId = "description";
  let offset = 0;
  let viewport = 1;
  let maximum = 0;
  let compact = true;
  let focused = false;
  let rows: Row[] = [];
  let visible = new Set<string>();
  let follow = true;
  let notice = "";
  let listField: Exclude<OrdinaryProfileField, "description" | "prompt"> | "models" | undefined;
  let diagnostic = false;
  let panel: ProfileSetting | undefined;
  let panelReturn = "description";
  /** A previewed chain-row effort: memory only, discarded by any key other than ←/→ or its save. */
  let staged: { id: string; profile: string; effort: ModelSelection["effort"] } | undefined;
  const back = () => {
    if (listField) {
      const field = listField;
      listField = undefined;
      if (field === "tools" || field === "skills" || field === "leafTools") {
        panel = undefined;
        activeId = field;
        offset = 0;
        follow = true;
        return;
      }
      activeId = field === "models" ? "models" : `list:${field}`;
    } else {
      panel = undefined;
      activeId = panelReturn;
    }
    offset = 0;
    follow = true;
  };
  let child: (Component & Focusable) | undefined;
  let childHeight = 14;
  let textError = "";
  type TextField = "description" | "prompt" | "skills" | "leafTools";
  type TextDraft = { input: Input | Editor; profile: string; field: TextField; original: string };
  let textEdit: TextDraft | undefined;
  // Unsubmitted native buffers, keyed by original owner (destination is fixed per Inspector).
  // Memory-only UI state for this Inspector's lifetime; never an autosave intent.
  const drafts = new Map<string, TextDraft>();
  const draftKey = (profile: string, field: string) => JSON.stringify([profile, field]);
  const textOf = (draft: TextDraft) =>
    draft.input instanceof Input ? draft.input.getValue() : draft.input.getExpandedText();
  const ownerOf = (draft: TextDraft) =>
    `${destination === "global" ? "Global" : "Project"} ${draft.profile}.${draft.field}`;
  // A pending destructive choice; the default always keeps text.
  let decision: { action: string; affected: TextDraft[]; proceed: () => void } | undefined;
  let failed = false;
  const positions = new Map<
    string,
    {
      id: string;
      offset: number;
      panel?: ProfileSetting;
      listField?: typeof listField;
      panelReturn: string;
    }
  >();
  const catalog = () => controller.projected;
  const destination = controller.destination;
  const selected = (): Profile | undefined => {
    const current = catalog();
    try {
      return (
        (destination === "global"
          ? resolveProfileCatalog(current.global, {}, options.availableSkills ?? []).profiles
          : current.profiles
        ).find((p) => p.name === name) ?? current.profiles.find((p) => p.name === name)
      );
    } catch {
      return current.profiles.find((p) => p.name === name);
    }
  };
  const metadata = (): ProfileModelCatalog => {
    try {
      return options.modelCatalog?.() ?? { entries: [], error: "Metadata unavailable" };
    } catch {
      return { entries: [], error: "Metadata unavailable" };
    }
  };
  const modelLabel = (target: ModelSelection) => profileModelLabel(metadata(), target);
  const entryOf = (target: ModelSelection) =>
    metadata().entries.find((e) => e.provider === target.provider && e.id === target.id);
  /** Short warning tag for a saved target the current snapshot cannot run. */
  const warningOf = (target: ModelSelection) => {
    const reason = profileModelReason(metadata(), target);
    return reason && (reason.includes("scope") ? "restricted" : "unavailable");
  };
  const compactModelLabel = (target: ModelSelection) => {
    const entry = entryOf(target);
    const label = truncateToWidth(safe(entry?.name ?? target.id), 40);
    const provider = truncateToWidth(safe(entry?.providerLabel ?? target.provider), 22);
    const warning = warningOf(target);
    return `${label} · ${provider} · ${target.effort}${warning ? ` · ${warning[0]!.toUpperCase()}${warning.slice(1)}` : ""}`;
  };
  const mutable = () =>
    ["saved", "saving"].includes(controller.status) &&
    (destination !== "project" || options.isProjectTrusted()) &&
    !(destination === "global" && catalog().provenance[name]?.source === "project");
  const send = (intent: ProfileIntent) => {
    try {
      controller.enqueue(intent);
      notice = "";
    } catch (error) {
      notice = String(error);
    }
    follow = true;
    requestRender();
  };
  const identity = () => ({ destination, profile: name });
  const reset = (field: OrdinaryProfileField | "fallback" | "models" | "model" | "prewalk") =>
    send({ ...identity(), field, action: "reset" });
  const leaveChild = () => {
    child = undefined;
    textEdit = undefined;
    textError = "";
    follow = true;
    requestRender();
  };
  /** Keep the active buffer (if changed) for an explicit later Resume; never submits. */
  const suspend = () => {
    if (textEdit && textOf(textEdit) !== textEdit.original)
      drafts.set(draftKey(textEdit.profile, textEdit.field), textEdit);
    leaveChild();
  };
  /** Destructive actions first identify affected drafts; the default choice keeps them. */
  const guard = (action: string, affected: TextDraft[], proceed: () => void) => {
    if (!affected.length) return proceed();
    decision = { action, affected, proceed };
    focus = "settings";
    activeId = "keep-drafts";
    offset = 0;
    follow = true;
  };
  const finishText = (submit: boolean, submitted?: string) => {
    const editing = textEdit;
    if (!editing) return true;
    const value = submitted ?? textOf(editing);
    if (!submit) {
      // Explicit Escape cancels only this buffer.
      drafts.delete(draftKey(editing.profile, editing.field));
      leaveChild();
      return true;
    }
    if (value && (editing.field === "skills" || editing.field === "leafTools")) {
      const current = catalog();
      const profile = selected();
      const values = (rawRole(current, destination, editing.profile)[editing.field] ??
        profile?.[editing.field] ??
        []) as readonly string[];
      textError =
        editing.field === "skills" && !isAbsolute(value)
          ? "Use an exact absolute skill path; edit this value to correct it."
          : values.includes(value)
            ? "This exact entry is already included; edit the value or Escape."
            : "";
      if (textError) {
        requestRender();
        return false;
      }
    }
    leaveChild(); // Clear before enqueue: Enter followed by blur cannot submit twice.
    const { profile, field } = editing;
    const list = field === "skills" || field === "leafTools";
    if (value === editing.original || (list && !value)) return true;
    try {
      if (!mutable()) throw new Error("Not saved: editing is paused or read-only; text kept");
      controller.enqueue(
        list
          ? { destination, profile, field, action: "include", item: value }
          : { destination, profile, field, action: "set", value },
      );
      notice = "";
      return true;
    } catch (error) {
      // A rejected commit never loses text: restore the same native buffer (Editor clears on submit).
      if (editing.input instanceof Editor) editing.input.setText(value);
      textEdit = editing;
      child = editing.input;
      child.focused = focused;
      textError = String(error);
      return false;
    }
  };
  const editText = (field: TextField) => {
    const existing = drafts.get(draftKey(name, field));
    if (existing) {
      // Resume the retained buffer and native cursor state, not the current preview.
      drafts.delete(draftKey(name, field));
      textEdit = existing;
      existing.input.focused = focused;
      child = existing.input;
      return;
    }
    const current = selected();
    const original =
      field === "skills" || field === "leafTools"
        ? ""
        : String(rawRole(catalog(), destination, name)[field] ?? current?.[field] ?? "");
    const input =
      field === "prompt"
        ? new Editor(tui, {
            borderColor: (s) => theme.fg("border", s),
            selectList: {
              selectedPrefix: (s) => theme.fg("accent", s),
              selectedText: (s) => theme.fg("accent", s),
              description: (s) => theme.fg("muted", s),
              scrollInfo: (s) => theme.fg("muted", s),
              noMatch: (s) => theme.fg("warning", s),
            },
          })
        : new Input({ prompt: `${field}: ` });
    if (input instanceof Input) input.setValue(safe(original));
    else input.setText(safe(original));
    textEdit = { input, profile: name, field, original: safe(original) };
    input.onSubmit = (value) => finishText(true, value);
    input.focused = focused;
    child = input;
  };
  const pick = (
    field: "fallback" | "models" | "model" | "prewalk",
    action:
      | "add"
      | "switch-from-prewalk"
      | "replace-target"
      | "grant"
      | "select"
      | "switch-from-fallback",
    target?: ModelSelection,
  ) => {
    const profile = selected()!;
    const origin = identity();
    const compound = ["add", "switch-from-prewalk", "replace-target"].includes(action);
    const position = target
      ? (profile.fallback ?? []).findIndex((t) => exact(t) === exact(target))
      : -1;
    const grantsFull = (profile.models?.length ?? 0) >= 64;
    child = createProfileModelPicker(
      options.modelCatalog,
      {
        title:
          action === "add"
            ? `Adding to ${name} chain`
            : action === "switch-from-prewalk"
              ? `Switching ${name} from prewalk and adding to chain`
              : action === "replace-target"
                ? `Replacing ${position ? `fallback ${position}` : "default"} in ${name}`
                : action === "grant"
                  ? `Granting exact model to ${name}`
                  : action === "switch-from-fallback"
                    ? `Disabling ${name} fallback and choosing prewalk`
                    : `Choosing ${name} ${field}`,
        context: [
          destination === "global"
            ? "Global · affects other workspaces"
            : "Project · operator grants only",
          compound
            ? "Grant permits explicit overrides too"
            : field === "models"
              ? "Exact grant permits explicit overrides"
              : "Existing exact grant required",
          compound ? "Saves route + exact grant atomically" : "No provider requests",
        ],
        // Chain add/replace: any accessible selection not already in the chain (`excluded`);
        // at 64 grants only granted selections, so a save never needs a new grant.
        allowed:
          field === "fallback"
            ? grantsFull
              ? profile.models
              : undefined
            : field === "models" && destination === "global"
              ? undefined
              : field === "prewalk" && destination === "project"
                ? profile.prewalk
                  ? [profile.prewalk]
                  : []
                : (profile.models ?? []),
        prioritized: field === "fallback" ? profile.models : undefined,
        preferredEffort: target?.effort,
        excluded:
          field === "fallback"
            ? profile.fallback
            : field === "models"
              ? profile.models
              : profile[field]
                ? [profile[field]!]
                : undefined,
        selectionLabel:
          action === "replace-target"
            ? "Replace in place and grant"
            : compound
              ? "Add and grant / add to chain"
              : field === "models"
                ? "Grant exact selection"
                : "Select exact target",
      },
      theme,
      keys,
      requestRender,
      (selection) => {
        leaveChild();
        if (!selection) return;
        if (action === "replace-target" && target) {
          activeId = `chain:${exact(selection)}`;
          send({ ...origin, field: "fallback", action, target, replacement: selection });
        } else if (field === "fallback" && (action === "add" || action === "switch-from-prewalk")) {
          activeId = `chain:${exact(selection)}`;
          send({ ...origin, field, action, target: selection });
        } else if (field === "models")
          send({ ...origin, field, action: "grant", target: selection });
        else if (field === "model" || field === "prewalk")
          send({
            ...origin,
            field,
            action: action === "switch-from-fallback" ? action : "select",
            target: selection,
          });
      },
      () => childHeight,
    );
    child.focused = focused;
  };
  const readOnly = () =>
    mutable() ? undefined : controller.status === "finishing" ? "Finishing saves" : "Read-only";
  const replaceTarget = (target: ModelSelection) => {
    const why =
      readOnly() ??
      (destination === "project" ? "Project cannot choose a different exact target" : undefined);
    if (why) notice = why;
    else pick("fallback", "replace-target", target);
  };
  /** Supported, eligible efforts ←/→ visit for a chain target (its own effort always included). */
  const effortChoices = (profile: Profile, target: ModelSelection) => {
    const grants = profile.models ?? [];
    return (entryOf(target)?.efforts ?? [])
      .map(({ effort }) => ({ ...target, effort }))
      .filter(
        (option) =>
          option.effort === target.effort ||
          (!profileModelReason(metadata(), option) &&
            // Another chain entry already routes this exact model/effort.
            !profile.fallback?.some((item) => exact(item) === exact(option)) &&
            (grants.length < 64 || grants.some((grant) => exact(grant) === exact(option)))),
      )
      .map(({ effort }) => effort);
  };
  /**
   * Keys on a selected chain row. `previous` is the staged effort this key may act on; every
   * other key has already discarded it. Returns false for keys the row does not own.
   */
  const chainKey = (data: string, previous: typeof staged): boolean => {
    if (panel !== "route" || listField || decision || focus !== "settings") return false;
    const profile = selected();
    const chain = profile?.fallback ?? [];
    const index = chain.findIndex((target) => `chain:${exact(target)}` === activeId);
    const target = chain[index];
    const pending = previous?.id === activeId && previous.profile === name ? previous : undefined;
    const left = matchesKey(data, "left");
    const direction =
      matchesKey(data, "shift+up") || data === "["
        ? "earlier"
        : matchesKey(data, "shift+down") || data === "]"
          ? "later"
          : undefined;
    const remove = data === "x" || matchesKey(data, "delete");
    if (data === "f") {
      const add = rows.find((row) => row.id === "add-chain");
      if (!visible.has(activeId)) return true;
      if (add?.reason) notice = add.reason;
      else add?.run?.();
      return true;
    }
    if (!profile || !target) return false;
    if (keys.matches(data, "tui.select.cancel")) return Boolean(pending); // Discarded above.
    const save = pending && keys.matches(data, "tui.select.confirm");
    if (!(left || matchesKey(data, "right") || direction || remove || save)) return false;
    if (!visible.has(activeId)) return true; // Never act on a scrolled-away row.
    const why =
      readOnly() ??
      (destination === "project" && !remove
        ? direction
          ? "Operator order only; change to Global"
          : "Project cannot choose a different exact target"
        : undefined);
    if (why) notice = why;
    else if (remove) {
      const next = chain[index + 1];
      activeId = next ? `chain:${exact(next)}` : "add-chain";
      send({ ...identity(), field: "fallback", action: "remove", target });
    } else if (direction) {
      const to = index + (direction === "earlier" ? -1 : 1);
      if (to < 0 || to >= chain.length)
        notice = direction === "earlier" ? "Already first" : "Already last";
      else send({ ...identity(), field: "fallback", action: "move", target, direction });
    } else if (save) {
      const replacement = { ...target, effort: pending.effort };
      activeId = `chain:${exact(replacement)}`;
      send({ ...identity(), field: "fallback", action: "replace-target", target, replacement });
    } else {
      const choices = effortChoices(profile, target);
      const from = choices.indexOf(pending?.effort ?? target.effort);
      const effort =
        choices[
          from < 0
            ? left
              ? choices.length - 1
              : 0
            : Math.max(0, Math.min(choices.length - 1, from + (left ? -1 : 1)))
        ];
      notice = choices.some((item) => item !== target.effort)
        ? ""
        : (profileModelReason(metadata(), target) ?? "No other eligible effort for this model");
      staged =
        effort && effort !== target.effort ? { id: activeId, profile: name, effort } : undefined;
    }
    return true;
  };
  const navigate = (action?: "destination" | StructuralAction) => {
    // Never ask to discard drafts for a navigation that recovery would refuse anyway.
    if (controller.failure) {
      notice = "Resolve recovery first";
      return;
    }
    guard(
      action === "destination" ? "Change destination" : action ? "Structural transaction" : "Close",
      [...drafts.values()],
      () => {
        try {
          controller.drain(() => done(action ? { profile: name, action } : undefined));
        } catch (error) {
          notice = String(error);
        }
      },
    );
  };
  const reload = () =>
    guard("Reload", [...drafts.values()], () => {
      notice = "";
      void controller.reload();
    });
  const resume = (draft: TextDraft) => {
    positions.set(name, { id: activeId, offset, panel, listField, panelReturn });
    name = draft.profile;
    panel = panelReturn = draft.field;
    listField = draft.field === "skills" || draft.field === "leafTools" ? draft.field : undefined;
    activeId = listField ? "add-exact" : draft.field;
    offset = 0;
    focus = "settings";
    editText(draft.field);
  };
  const unsubscribe = controller.subscribe(() => {
    // An exceptional failure freezes fields but never freezes read-only profile browsing.
    // Only the transition suspends input, so repeated notifications cannot drop/duplicate drafts.
    if (controller.failure && !failed) {
      if (textEdit) suspend();
      else child = undefined;
      decision = undefined;
      focus = "settings";
      activeId = controller.failure.recovery === "reload" ? "reload" : "retry";
      follow = true;
    }
    failed = Boolean(controller.failure);
    requestRender();
  });
  const decisionRows = ({ action, affected, proceed }: NonNullable<typeof decision>): Row[] => [
    {
      id: "drafts-decision",
      heading: true,
      text: `${action} would discard ${affected.length} unsaved draft${affected.length === 1 ? "" : "s"}`,
    },
    ...affected.map((draft, index) => ({
      id: `draft-owner:${index}`,
      text: `${ownerOf(draft)}: ${truncateToWidth(textOf(draft).split("\n")[0] ?? "", 32)} (${textOf(draft).length} chars)`,
    })),
    ...(action === "Reload"
      ? [
          {
            id: "draft-queued",
            text: `Reload also abandons ${controller.pending.length} queued unsaved changes.`,
          },
        ]
      : []),
    {
      id: "keep-drafts",
      text: "Keep drafts and return (default)",
      help: "Drafts stay in memory for this Inspector only; nothing is saved or submitted.",
      run: () => {
        decision = undefined;
      },
    },
    {
      id: "discard-drafts",
      text: `Discard ${affected.length} draft${affected.length === 1 ? "" : "s"} and continue: ${action}`,
      run: () => {
        for (const draft of affected) drafts.delete(draftKey(draft.profile, draft.field));
        decision = undefined;
        proceed();
      },
    },
  ];
  const buildRows = (): Row[] => {
    if (decision) return decisionRows(decision);
    const current = catalog();
    const profile = selected();
    if (!profile)
      return [{ id: "empty", text: "Profile no longer exists; browse another profile." }];
    const raw = rawRole(current, destination, name);
    const disables = `Disables fallback → ${profile.model ? compactModelLabel(profile.model) : "selected parent model"}; current permissions may deny dispatch.`;
    const own = !bundled.has(name) && (destination === "global" || Object.hasOwn(raw, "ceiling"));
    const result: Row[] = [];
    const info = (text: string, id = `info:${result.length}`) => result.push({ id, text });
    const detail = (text: string, id = `info:${result.length}`) =>
      result.push({ id, text, detail: true });
    const heading = (text: string, id: string) => result.push({ id, text, heading: true });
    const action = (
      id: string,
      text: string,
      run: () => void,
      reason?: string,
      recovery = false,
    ) => {
      let warning: string | undefined;
      if (id.startsWith("reset:") || id === "reset-list" || id === "reset-chain") {
        const field =
          id === "reset-list" ? listField! : id === "reset-chain" ? "fallback" : id.slice(6);
        try {
          const inherited = structuredClone(current);
          delete rawRole(inherited, destination, name)[field];
          const resolved = resolveProfileCatalog(
            inherited.global,
            destination === "project" ? inherited.project : {},
            options.availableSkills ?? [],
          ).profiles.find((p) => p.name === name);
          const value = resolved?.[field as keyof Profile];
          const inheritedValue =
            field === "description" || field === "prompt"
              ? `${destination === "global" ? "bundled" : "operator / bundled"} ${field} (full text in Advanced source details)`
              : Array.isArray(value)
                ? `${value.length} inherited ${field === "fallback" ? "ordered targets" : "ceiling entries"}${field === "fallback" && value[0] ? `; primary ${compactModelLabel(value[0] as ModelSelection)}` : ""}`
                : format(value);
          warning = `Reset removes this layer's ${field}; inherits ${inheritedValue}. Other fields are unchanged.${field === "fallback" ? " Unchained routes use the default / parent model; admission may deny dispatch." : ""}`;
        } catch (error) {
          warning = `Reset inheritance is currently invalid: ${String(error)}`;
        }
      } else if (id === "add-chain") {
        warning =
          destination === "global"
            ? "Global affects other workspaces. Add and grant permits explicit overrides too, not only fallback; route + required grant save atomically."
            : "Project can only retain/remove the authorized ordered subsequence. Change destination explicitly for Global controls.";
      } else if (id === "disable-chain") warning = `Keeps exact model grants. ${disables}`;
      // Default to navigation: draft Resume/decision controls must never imply a save.
      let outcome = "Open";
      if (id.startsWith("reset:") || ["reset-list", "reset-chain"].includes(id))
        outcome = "Reset and save";
      else if (id.startsWith("grant:")) outcome = "Revoke grant and save";
      else if (id === "disable-chain") outcome = "Disable chain and save";
      else if (id === "empty-list") outcome = "Deny all and save";
      else if (["description", "prompt", "add-exact"].includes(id)) outcome = "Edit text";
      else if (
        ["create", "delete", "ceiling", "ceilings", "registrations", "reset-override"].includes(id)
      )
        outcome = "Open structural review";
      else if (id === "retry") outcome = "Retry saves";
      else if (id === "revert") outcome = "Discard unsaved changes";
      else if (id === "reload") outcome = "Reload allowed layers";
      else if (id === "close") outcome = "Finish saves and close";
      else if (id === "back-list" || id === "back-panel") outcome = "Back";
      result.push({
        id,
        text,
        run,
        warning,
        outcome,
        reason:
          reason ??
          (!recovery && !mutable()
            ? controller.status === "finishing"
              ? "Finishing saves"
              : "Read-only"
            : undefined),
      });
    };
    const fieldState = (field: string) => {
      const pending = controller.pending;
      const index = pending.findIndex((i) => i.profile === name && i.field === field);
      return index < 0
        ? ""
        : controller.failure
          ? "Not saved / pending"
          : index === 0
            ? "Saving"
            : "Pending";
    };
    const draftOf = (field: string) => drafts.get(draftKey(name, field));
    // Resetting/replacing a drafted field first offers keep vs explicit discard of that draft only.
    const replace = (field: string, label: string, run: () => void) => {
      const draft = draftOf(field);
      guard(label, draft ? [draft] : [], run);
    };
    const field = (key: "description" | "prompt") => {
      const draft = draftOf(key);
      action(
        key,
        `${draft ? "Resume" : "Edit"} ${key === "prompt" ? "instructions (prompt)" : "description"}${draft ? " · unsaved draft" : ""}${fieldState(key) ? ` · ${fieldState(key)}` : ""} · ${Object.hasOwn(raw, key) ? "override" : "inherited"}`,
        () => editText(key),
        undefined,
        Boolean(draft), // Retained text stays readable/editable while paused; commit rechecks.
      );
      detail(String(raw[key] ?? profile[key]) || "(empty)");
      if (!own) {
        const origin = identity();
        action(
          `reset:${key}`,
          `Reset ${key} to inherited`,
          () =>
            replace(key, `Reset ${key}`, () => send({ ...origin, field: key, action: "reset" })),
          Object.hasOwn(raw, key) ? undefined : "Already inherited",
        );
      }
    };
    const failure = controller.failure;
    if (failure) {
      heading(
        failure.recovery === "reload"
          ? "Reload required · disk state is not verified"
          : "Not saved · mutations paused",
        "recovery",
      );
      info(
        `${failure.intent.profile}.${failure.intent.field} · ${failure.intent.action} · ${controller.pending.length} unsaved changes`,
      );
      info(
        `${failure.error.stage}: ${failure.error.path} · replacement ${failure.error.replacement}`,
      );
      info(failure.error.message, "failure-message");
      if (drafts.size)
        info(`${drafts.size} unsaved drafts retained · Resume below; never auto-submitted.`);
      if (failure.recovery === "reload")
        action(
          "reload",
          `Reload · abandon ${controller.pending.length} unsaved changes${drafts.size ? ` + ${drafts.size} drafts` : ""}`,
          reload,
          undefined,
          true,
        );
      else {
        action(
          "retry",
          "Retry same action, then queued tail",
          () => {
            notice = "";
            controller.retry();
          },
          undefined,
          true,
        );
        action(
          "revert",
          `Revert · discard ${controller.pending.length} unsaved changes`,
          () => {
            notice = `Discarded ${controller.revert()} unsaved changes; prior verified saves kept`;
          },
          undefined,
          true,
        );
      }
      action(
        "facts",
        diagnostic ? "Hide observed disk facts" : "Show observed disk facts",
        () => {
          diagnostic = !diagnostic;
        },
        undefined,
        true,
      );
      if (diagnostic)
        for (const [layer, observation] of Object.entries(failure.error.observed ?? {}))
          if (observation)
            info(
              `${layer} ${observation.path}: ${"content" in observation ? (observation.content ?? "<missing>") : observation.error}`,
            );
    }
    if (controller.reloadError) {
      heading("Read-only · reopening failed; close is available", "reopen-error");
      info(String(controller.reloadError));
      action("reload", "Reload current allowed layers", reload, undefined, true);
    }
    if (notice) info(notice, "notice");
    if (drafts.size) {
      heading("Unsaved drafts · memory only · never auto-saved", "drafts");
      for (const draft of drafts.values())
        action(
          `resume:${draftKey(draft.profile, draft.field)}`,
          `Resume ${ownerOf(draft)} draft`,
          () => resume(draft),
          undefined,
          true,
        );
    }
    if (destination === "global" && current.provenance[name]?.source === "project")
      info(
        "Project-local definition: browse only here. Change destination explicitly to trusted Project; no Global shadow is created.",
      );
    if (listField) {
      heading(
        `${listField === "models" ? "Exact model grants (models)" : listField === "spawn" ? "Spawn targets" : listField === "coordination" ? "Coordination" : profileSettingLabels[listField]}${fieldState(listField) ? ` · ${fieldState(listField)}` : ""}`,
        "list",
      );
      action("back-list", "Back to overview / previous setting", back, undefined, true);
      info(
        listField === "leafTools"
          ? "Trusted reviewed leaf code, not a sandbox or forwarding grant."
          : listField === "skills"
            ? "Exact absolute skill paths become explicit grants; no discovery or execution."
            : "Each membership change saves immediately. [] denies; reset inherits. Callable tools unknown.",
      );
      info(
        Object.hasOwn(raw, listField)
          ? `Selected layer: ${Array.isArray(raw[listField]) && (raw[listField] as unknown[]).length === 0 ? "explicit empty grant; denies all" : "explicit override"}. Reset removes only this layer's declaration.`
          : "Selected layer: inherited. An explicit empty grant denies all; reset inherits again.",
      );
      if (listField === "models") {
        const grants = profile.models ?? [];
        action(
          "grant",
          "Grant exact model / effort",
          () => pick("models", "grant"),
          grants.length >= 64
            ? "Maximum 64 grants"
            : destination === "project"
              ? "Project cannot mint grants; change destination to Global"
              : undefined,
        );
        for (const [index, target] of grants.entries()) {
          const id = `grant:${exact(target)}`;
          const removalReason = profileGrantRemovalReason(profile, target);
          action(
            id,
            `Remove grant: ${index + 1} · ${compactModelLabel(target)}`,
            () => send({ ...identity(), field: "models", action: "revoke", target }),
            removalReason,
          );
          Object.assign(result.at(-1)!, {
            label: `Remove grant: ${index + 1}`,
            value: `${compactModelLabel(target)}${removalReason ? ` [disabled: ${removalReason}]` : ""}`,
            help: "Revoke only this exact grant and save. j/k scroll full target and warning; routing-required grants stay disabled.",
          });
          if (activeId === id) {
            detail(`Exact target: ${target.provider}/${target.id} · ${target.effort}`);
            const reason = profileModelReason(metadata(), target);
            if (reason) detail(`Warning: ${reason}`, `unavailable:${id}`);
          }
        }
      } else {
        const values = (raw[listField] ?? profile[listField] ?? []) as readonly string[];
        const authorityName = profile.projectCeiling ?? name;
        const authority = resolveProfileCatalog(
          controller.failure ? controller.verified.global : current.global,
          {},
          options.availableSkills ?? [],
        ).profiles.find((p) => p.name === authorityName);
        const choices =
          listField === "tools"
            ? destination === "global"
              ? (bundledProfiles().find((p) => p.name === name)?.tools ?? WRITE_TOOLS)
              : (authority?.tools ?? [])
            : listField === "coordination"
              ? destination === "global"
                ? COORDINATION_ACTIONS
                : (authority?.coordination ?? [])
              : listField === "spawn"
                ? destination === "global"
                  ? [
                      ...bundled,
                      ...Object.keys((current.global.customProfiles ?? {}) as object),
                      ...Object.keys(current.projectSpawnTargets),
                    ]
                  : (authority?.spawn ?? [])
                : [];
        for (const item of new Set([...choices, ...values])) {
          const included = values.includes(item);
          action(
            `item:${item}`,
            `[${included ? "x" : " "}] ${item}${listField === "spawn" && current.projectSpawnTargets[item] ? ` [registered:${current.projectSpawnTargets[item]}; conditional trusted local]` : ""}`,
            () =>
              send({
                ...identity(),
                field: listField as Exclude<OrdinaryProfileField, "description" | "prompt">,
                action: "toggle",
                item,
              }),
          );
          Object.assign(result.at(-1)!, { membership: true, outcome: "Toggle and save" });
        }
        if (listField === "skills" || listField === "leafTools") {
          const draft = draftOf(listField);
          action(
            "add-exact",
            draft
              ? `Resume unsaved exact entry draft: ${textOf(draft)}`
              : `Add exact ${listField === "skills" ? "absolute skill path" : "reviewed leaf name"}`,
            () => editText(listField as "skills" | "leafTools"),
            destination === "project"
              ? "Project may only retain authorized grants; edit Global"
              : undefined,
            Boolean(draft),
          );
        }
      }
      const listOrigin = { ...identity(), field: listField };
      action(
        "empty-list",
        `Explicit empty grant [] · ${listField}`,
        () => replace(listField!, "Clear list", () => send({ ...listOrigin, action: "clear" })),
        listField === "models" &&
          (profile.models ?? []).some((target) => profileGrantRemovalReason(profile, target))
          ? "Current chain/default/prewalk still requires grants; adjust routing first"
          : Array.isArray(raw[listField]) && (raw[listField] as unknown[]).length === 0
            ? "Already explicitly empty"
            : undefined,
      );
      if (!own || listField === "models" || listField === "leafTools")
        action(
          "reset-list",
          `Reset ${listField} to inherited`,
          () => replace(listField!, "Reset list", () => send({ ...listOrigin, action: "reset" })),
          Object.hasOwn(raw, listField) ? undefined : "Already inherited",
        );
    } else if (!panel) {
      for (const item of profileOverview(
        profile,
        profile.fallback?.[0] && warningOf(profile.fallback[0]),
      )) {
        if (!item.key) {
          heading(item.heading!, `group:${item.heading}`);
          continue;
        }
        const key = item.key;
        const fields = profileSettingFields(key);
        const state = [...new Set(fields.map(fieldState).filter(Boolean))].join(" / ");
        const inheritance =
          key === "advanced"
            ? ""
            : fields.some((f) => Object.hasOwn(raw, f))
              ? "override"
              : "inherited";
        result.push({
          id: key,
          text: profileSettingLabels[key],
          label: profileSettingLabels[key],
          value: `${profileOverviewValue(theme, item)}${state ? ` · ${state}` : ""}`,
          styled: true,
          metadata: `${fields.some((f) => Array.isArray(raw[f]) && (raw[f] as unknown[]).length === 0) ? "explicit empty · " : ""}${inheritance}`,
          help: profileSettingHelp[key],
          preview: key === "description" || key === "prompt",
          outcome: "Open setting",
          run: () => {
            panel = key;
            panelReturn = key;
            offset = 0;
            if (key === "tools" || key === "skills" || key === "leafTools") listField = key;
            activeId =
              key === "description" || key === "prompt"
                ? key
                : key === "route"
                  ? profile.fallback?.[0]
                    ? `chain:${exact(profile.fallback[0])}`
                    : "add-chain"
                  : key === "delegation"
                    ? "list:spawn"
                    : profile.fallback
                      ? "select:prewalk"
                      : "select:model";
          },
        });
      }
    } else {
      action("back-panel", "Back to overview", back, undefined, true);
      if (panel === "description" || panel === "prompt") {
        heading(profileSettingLabels[panel], "instructions");
        field(panel);
      }
      if (panel === "route") {
        heading(
          `Models · ${Object.hasOwn(raw, "fallback") ? "override" : "inherited"}${fieldState("fallback") ? ` · ${fieldState("fallback")}` : ""}`,
          "chain",
        );
        info("Tried in order; unavailable may be skipped; admission applies.", "chain-note");
        const chain = profile.fallback ?? [];
        const label = (target: ModelSelection) =>
          `${safe(target.provider)}/${safe(target.id)}:${target.effort}`;
        if (!chain.length)
          info(
            `— unchained → ${profile.model ? label(profile.model) : "selected parent model"}${profile.prewalk ? ` · prewalk ${label(profile.prewalk)} configured` : ""} · current permissions may deny dispatch`,
            "unchained",
          );
        for (const [index, target] of chain.entries()) {
          const reason = profileModelReason(metadata(), target);
          const entry = entryOf(target);
          const exactLabel = `${safe(target.provider)}/${safe(target.id)} · ${target.effort}`;
          result.push({
            id: `chain:${exact(target)}`,
            text: label(target),
            chain: index,
            run: () => replaceTarget(target),
            help: `${entry ? `${safe(entry.name)} · ` : ""}${exactLabel}${reason ? ` · ⚠ ${reason}` : ""}`,
            // A clipped identity stays readable (j/k) beneath the row; removing the last target
            // also disables fallback, disclosed before x is pressed.
            warning:
              [
                visibleWidth(exactLabel) > paneRoom - 16 && `Exact: ${exactLabel}`,
                chain.length === 1 &&
                  `x saves fallback:false. Keeps exact model grants. ${disables}`,
              ]
                .filter(Boolean)
                .join(" ") || undefined,
          });
        }
        action(
          "add-chain",
          profile.prewalk ? "+ Switch from prewalk and add…" : "+ Add fallback…",
          () => pick("fallback", profile.prewalk ? "switch-from-prewalk" : "add"),
          destination === "project"
            ? "Change destination to Global; inherited prewalk cannot be bypassed"
            : chain.length >= 64
              ? "Maximum 64 chain targets"
              : undefined,
        );
        result.push({ id: "chain-divider", text: "", divider: true });
        action(
          "disable-chain",
          "Disable chain → unchained model / parent route (may be denied)",
          () => send({ ...identity(), field: "fallback", action: "disable" }),
          !chain.length ? "Already unchained" : undefined,
        );
        action(
          "reset-chain",
          "Reset chain to inherited (not Disable)",
          () => reset("fallback"),
          Object.hasOwn(raw, "fallback") ? undefined : "Already inherited",
        );
      }
      if (panel === "delegation") {
        heading("Delegation", "permissions");
        info(
          "Maximum declarations only; callable tools unknown. General inherits available parent skills, never parent instructions/history.",
        );
        for (const field of ["spawn", "coordination"] as const)
          action(
            `list:${field}`,
            `${field === "spawn" ? "Spawn targets (spawn)" : "Coordination (coordination)"}: ${(profile[field] ?? []).join(", ") || "None"}${fieldState(field) ? ` · ${fieldState(field)}` : ""}`,
            () => {
              listField = field;
              activeId = "back-list";
            },
            undefined,
            true,
          );
      }
      if (panel === "advanced") {
        heading("Advanced", "advanced");
        for (const field of ["model", "prewalk"] as const) {
          if (field === "model" && profile.fallback) {
            info(
              "Default is the first entry in Models. Unchained routing remains in source diagnostics.",
            );
            continue;
          }
          info(
            `${field}: ${profile[field] ? modelLabel(profile[field]!) : field === "model" ? "selected parent model" : "not configured"} · ${fieldState(field)}`,
          );
          action(
            `select:${field}`,
            field === "prewalk" && profile.fallback
              ? "Disable fallback and select prewalk (compound)"
              : `Choose ${field} from exact grants`,
            () =>
              pick(
                field,
                field === "prewalk" && profile.fallback ? "switch-from-fallback" : "select",
              ),
            field === "prewalk" && destination === "project"
              ? "Only inherited operator prewalk; change to Global"
              : undefined,
          );
          action(
            `reset:${field}`,
            `Reset ${field} to inherited (no off sentinel)`,
            () => reset(field),
            Object.hasOwn(raw, field) ? undefined : "Already inherited",
          );
        }
        action(
          "models",
          `Exact model grants: ${profile.models?.length ?? "unset"}`,
          () => {
            listField = "models";
            activeId = "grant";
          },
          undefined,
          true,
        );
        const structural = (actionName: StructuralAction, label: string) =>
          action(actionName, label, () => navigate(actionName));
        structural("create", "Create / copy custom role · structural transaction");
        if (own) structural("delete", "Delete custom definition · confirmed transaction");
        else structural("reset-override", "Reset whole override · structural transaction");
        if (profile.projectCeiling && destination === "project")
          structural("ceiling", "Change local authority ceiling · structural transaction");
        if (destination === "global") {
          structural("ceilings", "Authorize project-role ceilings · structural transaction");
          structural(
            "registrations",
            "Register project-local spawn targets · structural transaction",
          );
        }
      }
    }
    if (panel === "advanced")
      action(
        "provenance",
        diagnostic
          ? "Hide raw / inherited / effective details"
          : "Inspect raw / inherited / effective details",
        () => {
          diagnostic = !diagnostic;
        },
        undefined,
        true,
      );
    if (diagnostic && panel === "advanced") {
      info(`Destination path: ${controller.path}`);
      info(`Source: ${format(current.provenance[name])}`);
      info(`Raw ${destination}: ${format(raw)}`);
      const inherited = resolveProfileCatalog(
        destination === "global"
          ? {}
          : controller.failure
            ? controller.verified.global
            : current.global,
        {},
        options.availableSkills ?? [],
      ).profiles.find((p) => p.name === name);
      info(
        `Inherited: ${own ? "independent definition; required fields do not inherit" : format(inherited)}`,
      );
      info(`Effective workspace: ${format(current.profiles.find((p) => p.name === name))}`);
    }
    action(
      "destination",
      "Change destination (Global / Project)",
      () => navigate("destination"),
      controller.failure ? "Resolve recovery first" : undefined,
      true,
    );
    action(
      "close",
      "Close · waits for pending saves",
      () => navigate(),
      controller.failure ? "Resolve recovery first" : undefined,
      true,
    );
    return result;
  };
  let renderWidth = 0;
  let paneRoom = 80;
  const component: Component & Focusable & { dispose: () => void } = {
    capturesViewportInput: true,
    get focused() {
      return focused;
    },
    set focused(value) {
      focused = value;
      if (child) child.focused = value && focus === "settings";
    },
    dispose: unsubscribe,
    render(width) {
      width = Math.max(0, width);
      renderWidth = width;
      const height = Math.max(1, Math.floor(availableRows()));
      const paint = profileRowPaint(theme, width);
      const binding = (action: Parameters<typeof keys.getKeys>[0]) =>
        safe(keys.getKeys(action).join("/") || "unbound");
      const glyph = (action: Parameters<typeof keys.getKeys>[0]) => profileKeyText(keys, action);
      const marker = panel === "route" && !listField && !decision ? "❯ " : "› ";
      const addsGrant = (effort: ModelSelection["effort"], target: ModelSelection) =>
        !selected()?.models?.some((grant) => exact(grant) === exact({ ...target, effort }));
      const confirm = binding("tui.select.confirm");
      const cancel = binding("tui.select.cancel");
      const submit = binding("tui.input.submit");
      compact = width < 32 || height < 16;
      if (compact) {
        visible.clear();
        // Resize never commits or discards; the hint names Escape's actual local outcome.
        return [
          "Profiles · resize",
          `${controller.status} · ${controller.pending.length} pending${drafts.size ? ` · ${drafts.size} drafts kept` : ""}`,
          textEdit
            ? `${cancel}: discard unfinished text`
            : child
              ? `${cancel}: back`
              : decision
                ? `${cancel}: keep drafts`
                : panel || listField
                  ? `${cancel}: back`
                  : drafts.size
                    ? "Enlarge to resume or discard drafts"
                    : `${cancel}: finish / close`,
        ]
          .slice(0, height)
          .map(paint);
      }
      const inner = width - 4;
      const wide = width >= 88;
      const railWidth = wide ? Math.min(25, Math.floor(inner / 3)) : inner;
      const paneWidth = wide ? inner - railWidth - 3 : inner;
      paneRoom = paneWidth;
      const bodyHeight = height - 5;
      const helpHeight = child ? 0 : 3;
      viewport = bodyHeight - (wide ? 0 : 2) - helpHeight;
      childHeight = viewport;
      rows = buildRows();
      const actions = rows.filter((row) => row.run);
      if (!actions.some((row) => row.id === activeId)) activeId = actions[0]?.id ?? "";
      let content: string[];
      let total = 0;
      visible.clear();
      if (child) {
        child.focused = focused && focus === "settings";
        const errorLines = textError
          ? wrapTextWithAnsi(safe(textError), paneWidth).map((line) => theme.fg("warning", line))
          : [];
        content = [...child.render(paneWidth), ...errorLines].slice(0, viewport);
      } else {
        const indexed = rows.map((row, index) => {
          const selectedRow = row.id === activeId && focus === "settings";
          // Actions keep wrapped text under their label; details sit under their owning action.
          const indent = row.detail ? "    " : row.run ? "  " : "";
          const target = row.chain === undefined ? undefined : selected()?.fallback?.[row.chain];
          const preview = staged?.id === row.id && staged.profile === name ? staged : undefined;
          const lines = target
            ? [
                profileChainRow(theme, target, row.chain!, paneWidth, {
                  selected: selectedRow,
                  warning: warningOf(target),
                  right:
                    preview &&
                    `${theme.style(`[${profileEffortLabel(preview.effort)}]`, { fg: "accent", bold: true })}${theme.fg("muted", " · unsaved")}${addsGrant(preview.effort, target) ? theme.fg("warning", " · adds grant") : ""}`,
                }),
              ]
            : row.divider
              ? [` ${theme.fg("border", "─".repeat(Math.max(0, paneWidth - 2)))}`]
              : row.label
                ? profileSettingLines(
                    theme,
                    row.label,
                    row.preview
                      ? // Text previews stay one line so override/inherited state remains visible.
                        truncateToWidth(
                          safe(row.value ?? ""),
                          Math.max(
                            8,
                            paneWidth -
                              (paneWidth >= 64 ? 17 : 4) -
                              visibleWidth(` · ${row.metadata}`),
                          ),
                        )
                      : row.styled
                        ? (row.value ?? "")
                        : safe(row.value ?? ""),
                    paneWidth,
                    selectedRow,
                    row.metadata,
                  )
                : safe(`${row.text}${row.reason ? ` [disabled: ${row.reason}]` : ""}`)
                    .split("\n")
                    .flatMap((line) =>
                      wrapTextWithAnsi(line, Math.max(1, paneWidth - indent.length)),
                    )
                    .map(
                      (line, lineIndex) =>
                        (row.run && selectedRow && lineIndex === 0 ? marker : indent) + line,
                    )
                    .map((line) =>
                      row.heading
                        ? theme.style(line, {
                            fg:
                              row.id === "recovery" || row.id === "reopen-error"
                                ? "warning"
                                : "accent",
                            bold: true,
                          })
                        : theme.fg(
                            row.id === "failure-message" ||
                              row.id === "notice" ||
                              row.id.startsWith("unavailable:")
                              ? "warning"
                              : row.reason || row.id === "unchained" || row.id === "chain-note"
                                ? "muted"
                                : selectedRow
                                  ? "accent"
                                  : "text",
                            line,
                          ),
                    );
          if (row.warning && row.id === activeId)
            lines.push(
              ...wrapTextWithAnsi(safe(row.warning), Math.max(1, paneWidth - 4)).map((line) =>
                theme.fg("warning", `    ${line}`),
              ),
            );
          // One spacer separates groups; rows inside a group stay dense so a full overview,
          // checklist or route fits the production 80×24 overlay.
          // Spans key off the row's first text line, so the spacer is counted separately.
          const lead = (row.heading || row.id === "back-panel") && index > 0 ? 1 : 0;
          if (lead) lines.unshift("");
          return { row, lines, lead };
        });
        let start = 0;
        const spans = indexed.map((item) => {
          const from = start + item.lead;
          start += item.lines.length;
          return { ...item, from };
        });
        maximum = Math.max(0, start - viewport);
        const active = spans.find(({ row }) => row.id === activeId);
        if (follow && focus === "settings" && active) {
          if (active.from < offset) offset = active.from;
          else if (active.from >= offset + viewport) offset = active.from;
        }
        offset = Math.max(0, Math.min(maximum, offset));
        for (const span of spans)
          if (span.from >= offset && span.from < offset + viewport && span.row.run)
            visible.add(span.row.id);
        content = spans.flatMap((span) => span.lines).slice(offset, offset + viewport);
        total = start;
        follow = false;
      }
      const selectedRow = rows.find((r) => r.id === activeId);
      const chainTarget =
        selectedRow?.chain === undefined ? undefined : selected()?.fallback?.[selectedRow.chain];
      const preview =
        chainTarget && staged?.id === activeId && staged.profile === name
          ? staged.effort
          : undefined;
      const selectedHelp =
        (preview && chainTarget
          ? `Unsaved effort ${chainTarget.effort} → ${preview}${addsGrant(preview, chainTarget) ? " · adds exact grant (also permits explicit overrides)" : ""}; old grant kept · ${glyph("tui.select.confirm")} saves, ${glyph("tui.select.cancel")} discards`
          : undefined) ??
        (selectedRow?.reason ? `Disabled: ${selectedRow.reason}` : selectedRow?.help) ??
        (panel
          ? profileSettingHelp[panel]
          : "Keys 1–4 jump to Profile, Model, Access, Advanced. Browsing never changes permissions.");
      const help = controller.failure
        ? `${controller.failure.intent.profile}.${controller.failure.intent.field}: Not saved · ${controller.pending.length} unsaved · ${controller.failure.recovery === "reload" ? "Reload required" : "Retry / Revert available"}${drafts.size ? ` · ${drafts.size} drafts retained; Resume below` : ""}`
        : controller.reloadError
          ? "Read-only: reopening failed. Reload current allowed layers, or close."
          : selectedHelp;
      if (!child)
        content = [
          ...content,
          ...Array(Math.max(0, viewport - content.length)).fill(""),
          // The separator doubles as an overflow cue: rows below/above are otherwise invisible.
          maximum > 0
            ? theme.fg(
                "muted",
                truncateToWidth(
                  `${offset > 0 ? "↑" : " "}${offset < maximum ? "↓" : " "} lines ${offset + 1}–${Math.min(total, offset + viewport)} of ${total} · j/k scroll`,
                  paneWidth,
                ),
              )
            : "",
          ...wrapTextWithAnsi(safe(help), paneWidth)
            .slice(0, 2)
            .map((line) =>
              theme.fg(controller.failure || controller.reloadError ? "warning" : "muted", line),
            ),
        ];
      const profiles = catalog().profiles;
      if (!profiles.some((p) => p.name === name)) name = profiles[0]?.name ?? "general";
      const selectedIndex = profiles.findIndex((p) => p.name === name);
      const roster = wide
        ? [
            theme.fg("muted", `Profiles · ${profiles.length}`),
            ...profiles
              .slice(
                Math.max(0, selectedIndex - bodyHeight + 5),
                Math.max(0, selectedIndex - bodyHeight + 5) + bodyHeight - 4,
              )
              .map((p) => {
                // The current profile stays identifiable when focus is in settings: `›` marks
                // rail focus, `•` the profile whose settings are shown.
                const current = name === p.name;
                const text = safe(
                  `${current ? (focus === "rail" ? "›" : "•") : " "} ${p.name}${controller.pending.some((i) => i.profile === p.name) ? " [pending]" : ""}${[...drafts.values()].some((d) => d.profile === p.name) ? " [draft]" : ""}`,
                );
                return current ? theme.style(text, { fg: "accent", bold: true }) : text;
              }),
            "",
            theme.fg("muted", safe(`Source: ${catalog().provenance[name]?.source ?? "resolved"}`)),
            theme.fg("muted", "Callable tools: unknown"),
          ]
        : [
            safe(
              `${focus === "rail" ? "›" : " "} Profiles ${selectedIndex + 1}/${profiles.length} · ${name}`,
            ),
            theme.fg("border", "─".repeat(inner)),
          ];
      const body = wide
        ? Array.from(
            { length: bodyHeight },
            (_, i) =>
              cell(roster[i] ?? "", railWidth) +
              theme.fg("border", " │ ") +
              cell(content[i] ?? "", paneWidth),
          )
        : [...roster, ...Array.from({ length: viewport + helpHeight }, (_, i) => content[i] ?? "")];
      const row = (text: string) => paint(`│ ${cell(text, inner)} │`);
      const label = `${
        textEdit
          ? "Unfinished text · not committed"
          : controller.status === "finishing"
            ? "Finishing saves"
            : controller.status === "saved"
              ? "Saved · verified"
              : controller.status
      }${drafts.size ? ` · ${drafts.size} unsaved draft${drafts.size === 1 ? "" : "s"}` : ""}`;
      const mode = controller.status === "read-only" ? "Read-only" : "Editing";
      const activation = selectedRow?.reason ? "Disabled" : (selectedRow?.outcome ?? "Open");
      const hint =
        focus === "rail"
          ? `Tab / ${confirm}: settings · ↑↓ profiles · ${cancel}: back/close`
          : preview
            ? `${glyph("tui.select.confirm")} save effort · ←/→ effort · ${glyph("tui.select.cancel")} discard`
            : chainTarget
              ? `${glyph("tui.select.confirm")} replace · ←/→ effort · ⇧↑/↓ [ ] move · x remove · f add · ${glyph("tui.select.cancel")} back`
              : `${confirm}${selectedRow?.membership && !selectedRow.reason ? " / Space" : ""}: ${activation} · Tab: profiles · ${cancel}: ${panel || listField ? "back" : "close"}`;
      return [
        paint(`╭${cell(` Subagent Profiles / ${safe(name)} · ${label} `, width - 2)}╮`),
        row(
          `${destination === "global" ? `${mode} GLOBAL · other workspaces` : options.isProjectTrusted() ? `${mode} Trusted Project` : "Read-only Project · trust unavailable"} · ${controller.pending.length} pending`,
        ),
        // Clip the directory, not the file name, so the written file stays identifiable.
        row(theme.fg("muted", leftTruncate(safe(controller.path), inner))),
        ...body.map(row),
        row(
          child
            ? textEdit
              ? `${!mutable() ? "Paused · Tab: keep draft" : textEdit.input instanceof Input ? `${submit} / Tab: commit` : `${submit}: commit · Tab: keep draft`} · ${cancel}: discard text`
              : `Catalog · ${cancel}: back`
            : decision
              ? `↑↓ choose · ${confirm} select · ${cancel} keep drafts`
              : hint,
        ),
        paint("╰" + "─".repeat(width - 2) + "╯"),
      ];
    },
    handleInput(data) {
      component.render(renderWidth);
      const previous = staged;
      staged = undefined; // Any key but ←/→ on its row, or Enter saving it, discards a preview.
      if (compact) {
        if (keys.matches(data, "tui.select.cancel")) {
          // Resize never changes Escape into a close/commit of hidden unfinished input.
          if (textEdit) finishText(false);
          else if (child) child.handleInput?.(data);
          else if (decision) decision = undefined;
          else if (panel || listField) back();
          else if (!drafts.size) navigate(); // Its keep/discard choice needs a visible layout.
          requestRender();
        }
        return;
      }
      if (child && focus === "settings") {
        if (keys.matches(data, "tui.select.cancel")) {
          if (textEdit) finishText(false);
          else child.handleInput?.(data);
        } else if (textEdit && matchesKey(data, "tab")) {
          // Only an editable single-line blur commits; multiline (or paused) text is kept as a draft.
          if (textEdit.input instanceof Input && mutable()) {
            if (!finishText(true)) return;
          } else suspend();
          focus = "rail";
        } else if (
          textEdit &&
          !mutable() &&
          (keys.matches(data, "tui.input.submit") ||
            (textEdit.input instanceof Input && data === "\n"))
        ) {
          // In particular don't let Editor clear/trim a paused draft on native submit.
          textError = "Not saved: editing is paused or read-only; text kept";
        } else child.handleInput?.(data); // Native text keys, including Ctrl+Left word movement.
        requestRender();
        return;
      }
      if (chainKey(data, previous)) {
        follow = true;
        requestRender();
        return;
      }
      if (keys.matches(data, "tui.select.cancel")) {
        if (decision) decision = undefined;
        else if (listField || panel) back();
        else navigate();
        requestRender();
        return;
      }
      // A pending discard decision is modal: no rail/group jumps can retarget it.
      if (
        decision &&
        (matchesKey(data, "tab") || matchesKey(data, "shift+tab") || /^[1-4]$/.test(data))
      )
        return;
      if (matchesKey(data, "tab") || matchesKey(data, "shift+tab")) {
        focus = focus === "rail" ? "settings" : "rail";
        follow = true;
      } else if (keys.matches(data, "tui.select.up") || keys.matches(data, "tui.select.down")) {
        const delta = keys.matches(data, "tui.select.up") ? -1 : 1;
        if (focus === "rail") {
          const profiles = catalog().profiles;
          positions.set(name, { id: activeId, offset, panel, listField, panelReturn });
          name =
            profiles[
              Math.max(
                0,
                Math.min(profiles.length - 1, profiles.findIndex((p) => p.name === name) + delta),
              )
            ]!.name;
          const saved = positions.get(name);
          activeId = saved?.id ?? "description";
          offset = saved?.offset ?? 0;
          listField = saved?.listField;
          panel = saved?.panel;
          panelReturn = saved?.panelReturn ?? "description";
        } else {
          const actions = rows.filter((row) => row.run);
          activeId =
            actions[
              Math.max(
                0,
                Math.min(
                  actions.length - 1,
                  actions.findIndex((row) => row.id === activeId) + delta,
                ),
              )
            ]?.id ?? "";
        }
        follow = true;
      } else if (
        keys.matches(data, "tui.select.confirm") ||
        (data === " " &&
          focus === "settings" &&
          rows.some((row) => row.id === activeId && row.membership))
      ) {
        const row = rows.find((row) => row.id === activeId);
        if (focus === "rail") focus = "settings";
        else if (row && visible.has(row.id)) {
          if (row.reason) notice = row.reason;
          else row.run?.();
        }
        follow = true;
      } else if (matchesKey(data, "home") || matchesKey(data, "end")) {
        const actions = rows.filter((row) => row.run);
        activeId = (matchesKey(data, "home") ? actions[0] : actions.at(-1))?.id ?? "";
        focus = "settings";
        follow = true;
      } else if (/^[1-4]$/.test(data)) {
        listField = undefined;
        panel = undefined;
        offset = 0;
        focus = "settings";
        activeId = ["description", "route", "tools", "advanced"][Number(data) - 1]!;
        follow = true;
      } else if (
        data === "j" ||
        data === "k" ||
        keys.matches(data, "tui.select.pageDown") ||
        keys.matches(data, "tui.select.pageUp")
      ) {
        offset = Math.max(
          0,
          Math.min(
            maximum,
            offset +
              (data === "j"
                ? 1
                : data === "k"
                  ? -1
                  : keys.matches(data, "tui.select.pageDown")
                    ? viewport
                    : -viewport),
          ),
        );
        follow = false;
      } else return;
      requestRender();
    },
    invalidate() {
      child?.invalidate();
    },
  };
  return component;
}
