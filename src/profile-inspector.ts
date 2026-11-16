import {
  Editor,
  Input,
  matchesKey,
  truncateToWidth,
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
  profileRowPaint,
  profileSettingLines,
  type ProfilePanelTheme,
} from "./profile-presentation.ts";
import {
  profileOverview,
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
  model?: ModelSelection;
  help?: string;
  metadata?: string;
  warning?: string;
};
const bundled = new Set(bundledProfiles().map((p) => p.name));
const exact = (target: ModelSelection) =>
  JSON.stringify([target.provider, target.id, target.effort]);
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
  let targetPanel: string | undefined;
  let panelReturn = "description";
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
    } else if (targetPanel) {
      activeId = targetPanel;
      targetPanel = undefined;
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
  let textEdit:
    | {
        input: Input | Editor;
        profile: string;
        field: "description" | "prompt" | "skills" | "leafTools";
        original: string;
      }
    | undefined;
  const positions = new Map<
    string,
    {
      id: string;
      offset: number;
      panel?: ProfileSetting;
      listField?: typeof listField;
      targetPanel?: string;
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
  const compactModelLabel = (target: ModelSelection, styled = false) => {
    const snapshot = metadata();
    const entry = snapshot.entries.find(
      (e) => e.provider === target.provider && e.id === target.id,
    );
    const reason = profileModelReason(snapshot, target);
    const label = truncateToWidth(safe(entry?.name ?? target.id), 40);
    const provider = truncateToWidth(safe(entry?.providerLabel ?? target.provider), 22);
    const warning = reason ? ` · ${reason.includes("scope") ? "Restricted" : "Unavailable"}` : "";
    return `${label} · ${styled ? theme.fg("muted", provider) : provider} · ${target.effort}${styled ? theme.fg("warning", warning) : warning}`;
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
  const finishText = (submit: boolean, submitted?: string) => {
    const editing = textEdit;
    if (!editing) return true;
    const value =
      submitted ??
      (editing.input instanceof Input ? editing.input.getValue() : editing.input.getExpandedText());
    if (submit && value && (editing.field === "skills" || editing.field === "leafTools")) {
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
    if (!submit || value === editing.original) return true;
    if (editing.field === "skills" || editing.field === "leafTools") {
      if (value)
        send({
          destination,
          profile: editing.profile,
          field: editing.field,
          action: "include",
          item: value,
        });
    } else
      send({ destination, profile: editing.profile, field: editing.field, action: "set", value });
    return true;
  };
  const editText = (field: "description" | "prompt" | "skills" | "leafTools") => {
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
    child = createProfileModelPicker(
      options.modelCatalog,
      {
        title: `${name} · ${action === "switch-from-prewalk" ? "Switch from prewalk and add" : action === "switch-from-fallback" ? "Disable fallback and select prewalk" : field}`,
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
        allowed:
          action === "replace-target" && target
            ? (
                metadata().entries.find(
                  (entry) => entry.provider === target.provider && entry.id === target.id,
                )?.efforts ?? []
              )
                .map(({ effort }) => ({ ...target, effort }))
                .filter(
                  (selection) =>
                    (profile.models?.length ?? 0) < 64 ||
                    profile.models?.some((grant) => exact(grant) === exact(selection)),
                )
            : field === "fallback"
              ? (profile.models?.length ?? 0) >= 64
                ? profile.models
                : undefined
              : field === "models" && destination === "global"
                ? undefined
                : field === "prewalk" && destination === "project"
                  ? profile.prewalk
                    ? [profile.prewalk]
                    : []
                  : (profile.models ?? []),
        excluded:
          field === "fallback"
            ? profile.fallback
            : field === "models"
              ? profile.models
              : profile[field]
                ? [profile[field]!]
                : undefined,
        selectionLabel: compound
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
          targetPanel = `chain:${exact(selection)}`;
          activeId = targetPanel;
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
  const navigate = (action?: "destination" | StructuralAction) => {
    try {
      controller.drain(() => done(action ? { profile: name, action } : undefined));
    } catch (error) {
      notice = String(error);
    }
  };
  const unsubscribe = controller.subscribe(() => {
    // An exceptional failure freezes fields but never freezes read-only profile browsing.
    if (controller.failure) {
      child = undefined;
      textEdit = undefined;
      activeId = controller.failure.recovery === "reload" ? "reload" : "retry";
      follow = true;
    }
    requestRender();
  });
  const buildRows = (): Row[] => {
    const current = catalog();
    const profile = selected();
    if (!profile)
      return [{ id: "empty", text: "Profile no longer exists; browse another profile." }];
    const raw = rawRole(current, destination, name);
    const own = !bundled.has(name) && (destination === "global" || Object.hasOwn(raw, "ceiling"));
    const result: Row[] = [];
    const info = (text: string, id = `info:${result.length}`) => result.push({ id, text });
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
      } else if (id === "disable-chain" || id.endsWith(":remove")) {
        warning = `Keeps exact model grants. ${id === "disable-chain" || profile.fallback?.length === 1 ? `Disables fallback → ${profile.model ? compactModelLabel(profile.model) : "selected parent model"}; current permissions may deny dispatch.` : "Removes only this route target."}`;
      }
      result.push({
        id,
        text,
        run,
        warning,
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
    const field = (key: "description" | "prompt") => {
      action(
        key,
        `${key === "prompt" ? "Instructions (prompt)" : "Description"}${fieldState(key) ? ` · ${fieldState(key)}` : ""} · ${Object.hasOwn(raw, key) ? "override" : "inherited"}`,
        () => editText(key),
      );
      info(String(raw[key] ?? profile[key]));
      if (!own)
        action(
          `reset:${key}`,
          `Reset ${key} to inherited`,
          () => reset(key),
          Object.hasOwn(raw, key) ? undefined : "Already inherited",
        );
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
      if (failure.recovery === "reload")
        action(
          "reload",
          `Reload · abandon ${controller.pending.length} unsaved changes`,
          () => {
            notice = "";
            void controller.reload();
          },
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
      action(
        "reload",
        "Reload current allowed layers",
        () => {
          notice = "";
          void controller.reload();
        },
        undefined,
        true,
      );
    }
    if (notice) info(notice, "notice");
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
        for (const target of grants)
          action(
            `grant:${exact(target)}`,
            `Remove grant: ${modelLabel(target)}`,
            () => send({ ...identity(), field: "models", action: "revoke", target }),
            profileGrantRemovalReason(profile, target),
          );
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
        }
        if (listField === "skills" || listField === "leafTools")
          action(
            "add-exact",
            `Add exact ${listField === "skills" ? "absolute skill path" : "reviewed leaf name"}`,
            () => editText(listField as "skills" | "leafTools"),
            destination === "project"
              ? "Project may only retain authorized grants; edit Global"
              : undefined,
          );
      }
      action(
        "empty-list",
        `Explicit empty grant [] · ${listField}`,
        () => send({ ...identity(), field: listField!, action: "clear" }),
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
          () => reset(listField!),
          Object.hasOwn(raw, listField) ? undefined : "Already inherited",
        );
    } else if (!panel) {
      for (const item of profileOverview(
        profile,
        profile.fallback?.[0] && compactModelLabel(profile.fallback[0]),
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
          value: `${item.value}${state ? ` · ${state}` : ""}`,
          metadata: `${fields.some((f) => Array.isArray(raw[f]) && (raw[f] as unknown[]).length === 0) ? "explicit empty · " : ""}${inheritance}`,
          help: profileSettingHelp[key],
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
                    : "select:model";
          },
        });
      }
    } else {
      action(
        "back-panel",
        targetPanel ? "Back to Models" : "Back to overview",
        back,
        undefined,
        true,
      );
      if (panel === "description" || panel === "prompt") {
        heading(profileSettingLabels[panel], "instructions");
        field(panel);
      }
      if (panel === "route") {
        heading(`Models${fieldState("fallback") ? ` · ${fieldState("fallback")}` : ""}`, "chain");
        info(
          "Primary runs first; retries follow in order. Unavailable rows may be skipped; admission still applies.",
        );
        const chain = profile.fallback ?? [];
        if (!chain.length)
          info(
            `No chain · ${profile.model ? modelLabel(profile.model) : "selected parent model"} route${profile.prewalk ? "; prewalk configured" : ""}. Current permissions may deny dispatch.`,
          );
        for (const [index, target] of chain.entries()) {
          const id = `chain:${exact(target)}`;
          if (targetPanel && targetPanel !== id) continue;
          action(
            id,
            `${index === 0 ? "Primary" : `↳ Retry ${index}`} · ${compactModelLabel(target)}`,
            () => {
              targetPanel = id;
              activeId = `${id}:earlier`;
              offset = 0;
            },
            undefined,
            true,
          );
          Object.assign(result.at(-1)!, {
            label: index === 0 ? "Primary" : `↳ Retry ${index}`,
            value: compactModelLabel(target),
            model: target,
            help: `Exact: ${target.provider}/${target.id} · ${target.effort}. Enter opens this target’s controls.`,
          });
          if (targetPanel !== id) continue;
          info(`Exact target: ${target.provider}/${target.id} · ${target.effort}`);
          const unavailable = profileModelReason(metadata(), target);
          if (unavailable) info(`Warning: ${unavailable}`, `unavailable:${id}`);
          action(
            `${id}:earlier`,
            "  ↑ Earlier",
            () => {
              send({
                ...identity(),
                field: "fallback",
                action: "move",
                target,
                direction: "earlier",
              });
              activeId = id;
            },
            destination === "project"
              ? "Operator order only; change to Global"
              : index === 0
                ? "Already first"
                : undefined,
          );
          action(
            `${id}:later`,
            "  ↓ Later",
            () => {
              send({
                ...identity(),
                field: "fallback",
                action: "move",
                target,
                direction: "later",
              });
              activeId = id;
            },
            destination === "project"
              ? "Operator order only; change to Global"
              : index === chain.length - 1
                ? "Already last"
                : undefined,
          );
          action(
            `${id}:effort`,
            "  Change supported effort (retains old grant)",
            () => pick("fallback", "replace-target", target),
            destination === "project"
              ? "Project cannot choose a different exact target"
              : undefined,
          );
          action(
            `${id}:remove`,
            chain.length === 1
              ? "  Remove final target → disable fallback; keep grants"
              : "  Remove from chain; keep grants",
            () => {
              send({ ...identity(), field: "fallback", action: "remove", target });
              targetPanel = undefined;
              activeId = "add-chain";
            },
          );
        }
        if (!targetPanel) {
          action(
            "add-chain",
            profile.prewalk
              ? "Switch from prewalk and add / grant"
              : "Add to chain / Add and grant",
            () => pick("fallback", profile.prewalk ? "switch-from-prewalk" : "add"),
            destination === "project"
              ? "Change destination to Global; inherited prewalk cannot be bypassed"
              : chain.length >= 64
                ? "Maximum 64 chain targets"
                : undefined,
          );
          action(
            "disable-chain",
            "Disable chain → Advanced default / parent route (may be denied)",
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
      "Change destination explicitly",
      () => navigate("destination"),
      controller.failure ? "Resolve recovery first" : undefined,
      true,
    );
    action(
      "close",
      "Close · finish verified saves first",
      () => navigate(),
      controller.failure ? "Resolve recovery first" : undefined,
      true,
    );
    return result;
  };
  return {
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
      const height = Math.max(1, Math.floor(availableRows()));
      const paint = profileRowPaint(theme, width);
      compact = width < 32 || height < 16;
      if (compact) {
        visible.clear();
        return [
          "Profiles · resize",
          `${controller.status} · ${controller.pending.length} pending`,
          "Esc: finish / close",
        ]
          .slice(0, height)
          .map(paint);
      }
      const inner = width - 4;
      const wide = width >= 88;
      const railWidth = wide ? Math.min(25, Math.floor(inner / 3)) : inner;
      const paneWidth = wide ? inner - railWidth - 3 : inner;
      const bodyHeight = height - 5;
      viewport = bodyHeight - (wide ? 0 : 2) - 3;
      childHeight = viewport;
      rows = buildRows();
      const actions = rows.filter((row) => row.run);
      if (!actions.some((row) => row.id === activeId)) activeId = actions[0]?.id ?? "";
      let content: string[];
      visible.clear();
      if (child) {
        child.focused = focused && focus === "settings";
        const errorLines = textError
          ? wrapTextWithAnsi(safe(textError), paneWidth).map((line) => theme.fg("warning", line))
          : [];
        content = [...child.render(paneWidth), ...errorLines].slice(0, viewport);
      } else {
        const indexed = rows.map((row) => {
          const selectedRow = row.id === activeId && focus === "settings";
          const lines = row.label
            ? profileSettingLines(
                theme,
                row.label,
                row.model ? compactModelLabel(row.model, true) : safe(row.value ?? ""),
                paneWidth,
                selectedRow,
                row.metadata,
              )
            : safe(
                `${row.run ? (selectedRow ? "› " : "  ") : ""}${row.text}${row.reason ? ` [disabled: ${row.reason}]` : ""}`,
              )
                .split("\n")
                .flatMap((line) => wrapTextWithAnsi(line, paneWidth))
                .map((line) =>
                  row.heading
                    ? theme.style(line, {
                        fg:
                          row.id === "recovery" || row.id === "reopen-error" ? "warning" : "accent",
                        bold: true,
                      })
                    : theme.fg(
                        row.id === "failure-message" ||
                          row.id === "notice" ||
                          row.id.startsWith("unavailable:")
                          ? "warning"
                          : row.reason
                            ? "muted"
                            : selectedRow
                              ? "accent"
                              : "text",
                        line,
                      ),
                );
          if (row.warning && row.id === activeId)
            lines.push(
              ...wrapTextWithAnsi(safe(row.warning), paneWidth).map((line) =>
                theme.fg("warning", line),
              ),
            );
          if (row.run || row.heading) lines.push("");
          return { row, lines };
        });
        let start = 0;
        const spans = indexed.map((item) => {
          const from = start;
          start += item.lines.length;
          return { ...item, from, to: start };
        });
        maximum = Math.max(0, start - viewport);
        const active = spans.find(({ row }) => row.id === activeId);
        if (follow && focus === "settings" && active) {
          if (active.from < offset) offset = active.from;
          else if (active.to > offset + viewport) offset = Math.max(0, active.to - viewport);
        }
        offset = Math.max(0, Math.min(maximum, offset));
        for (const span of spans)
          if (span.from >= offset && span.to <= offset + viewport && span.row.run)
            visible.add(span.row.id);
        content = spans.flatMap((span) => span.lines).slice(offset, offset + viewport);
        follow = false;
      }
      const selectedHelp =
        rows.find((r) => r.id === activeId)?.help ??
        (panel
          ? profileSettingHelp[panel]
          : "Enter: open selected setting. Browsing never changes permissions.");
      const help = controller.failure
        ? `${controller.failure.intent.profile}.${controller.failure.intent.field}: Not saved · ${controller.pending.length} unsaved · ${controller.failure.recovery === "reload" ? "Reload required" : "Retry / Revert available"}`
        : controller.reloadError
          ? "Read-only: reopening failed. Reload current allowed layers, or close."
          : selectedHelp;
      content = [
        ...content,
        ...Array(Math.max(0, viewport - content.length)).fill(""),
        "",
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
              .map(
                (p) =>
                  `${name === p.name && focus === "rail" ? "›" : " "} ${p.name}${controller.pending.some((i) => i.profile === p.name) ? " [pending]" : ""}`,
              ),
            "",
            `Source: ${catalog().provenance[name]?.source ?? "resolved"}`,
            "Callable tools: unknown",
          ]
        : [
            `${focus === "rail" ? "›" : " "} Profiles ${selectedIndex + 1}/${profiles.length} · ${name}`,
            "─".repeat(inner),
          ];
      const body = wide
        ? Array.from(
            { length: bodyHeight },
            (_, i) =>
              cell(safe(roster[i] ?? ""), railWidth) +
              theme.fg("border", " │ ") +
              cell(content[i] ?? "", paneWidth),
          )
        : [...roster, ...Array.from({ length: viewport + 3 }, (_, i) => content[i] ?? "")];
      const row = (text: string) => paint(`│ ${cell(text, inner)} │`);
      const label = textEdit
        ? "Unfinished text · not committed"
        : controller.status === "finishing"
          ? "Finishing saves"
          : controller.status === "saved"
            ? "Saved · verified"
            : controller.status;
      const mode = controller.status === "read-only" ? "Read-only" : "Editing";
      return [
        paint(`╭${cell(` Subagent Profiles / ${safe(name)} · ${label} `, width - 2)}╮`),
        row(
          `${destination === "global" ? `${mode} GLOBAL · other workspaces` : options.isProjectTrusted() ? `${mode} Trusted Project` : "Read-only Project · trust unavailable"} · ${controller.pending.length} pending · ${focus}`,
        ),
        row(safe(controller.path)),
        ...body.map(row),
        row(
          child
            ? textEdit
              ? `${textEdit.field === "prompt" ? "Native submit" : "Enter / blur"}: commit · Esc: unfinished only · Tab: profiles`
              : "Catalog · Tab focus · Esc back · Ctrl+← profiles"
            : "Tab rail/settings · ↑↓ · Enter open · 1–4 groups · Esc back/close",
        ),
        paint("╰" + "─".repeat(width - 2) + "╯"),
      ];
    },
    handleInput(data) {
      if (compact) {
        if (keys.matches(data, "tui.select.cancel")) {
          // Resize never changes Escape into a close/commit of hidden unfinished input.
          if (textEdit) finishText(false);
          else if (child) child.handleInput?.(data);
          else if (panel || listField) back();
          else navigate();
          requestRender();
        }
        return;
      }
      if (child && focus === "settings") {
        if (keys.matches(data, "tui.select.cancel")) {
          if (textEdit) finishText(false);
          else child.handleInput?.(data);
        } else if ((textEdit && matchesKey(data, "tab")) || matchesKey(data, "ctrl+left")) {
          // Only single-line blur commits. Multiline commits exclusively on native submit.
          if (textEdit?.input instanceof Input) {
            if (!finishText(true)) return;
          } else if (textEdit) finishText(false);
          else leaveChild();
          focus = "rail";
        } else child.handleInput?.(data);
        requestRender();
        return;
      }
      if (keys.matches(data, "tui.select.cancel")) {
        if (listField || panel) back();
        else navigate();
        requestRender();
        return;
      }
      if (matchesKey(data, "tab") || matchesKey(data, "shift+tab")) {
        focus = focus === "rail" ? "settings" : "rail";
        follow = true;
      } else if (keys.matches(data, "tui.select.up") || keys.matches(data, "tui.select.down")) {
        const delta = keys.matches(data, "tui.select.up") ? -1 : 1;
        if (focus === "rail") {
          const profiles = catalog().profiles;
          positions.set(name, { id: activeId, offset, panel, listField, targetPanel, panelReturn });
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
          targetPanel = saved?.targetPanel;
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
      } else if (keys.matches(data, "tui.select.confirm")) {
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
        targetPanel = undefined;
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
}
