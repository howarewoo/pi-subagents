import type { Skill } from "@earendil-works/pi-coding-agent";
import {
  matchesKey,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
  type KeybindingsManager,
} from "@earendil-works/pi-tui";
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
  profileRawRole,
  profileSettingFields,
  type ProfileSetting,
} from "./profile-overview.ts";
import { safe } from "./thread.ts";
import {
  resolveProfileCatalog,
  resolvedCatalogProfiles,
  type Profile,
  type ProfileCatalog,
} from "./profiles.ts";

export const profileToolPolicy =
  "Profile tools are maximum allowlists, not requirements. Admission intersects callable parent builtins without activating tools. Command context has no callable-tool dispatcher: effective tools are unknown here. Active declarations are not proof of callability. General inherits available parent skills and callable builtins within its ceiling, not parent instructions/history; only operator-reviewed leaf tools may be forwarded and callers coordinate concurrent writes. Leaf grants assert trusted code, not a sandbox. Inspect task snapshot tools, leafTools, skills and capabilityDenials for admitted grants.";

/** Resolve through the same trust/config/skill validation boundary used by admission. */
export async function resolvedProfiles(
  cwd: string,
  trusted: boolean,
  operatorDir?: string,
  availableSkills: readonly Skill[] = [],
): Promise<Profile[]> {
  return resolvedCatalogProfiles(cwd, trusted, operatorDir, availableSkills);
}

type DetailLine = { text: string; heading?: boolean };

function details(profile: Profile, panel: ProfileSetting): DetailLine[] {
  const list = (items: readonly string[] | undefined) =>
    items?.length ? items.join(", ") : "none";
  const known = new Set([
    "name",
    "description",
    "prompt",
    "tools",
    "skills",
    "leafTools",
    "spawn",
    "coordination",
    "models",
    "model",
    "prewalk",
    "fallback",
  ]);
  const heading = (text: string): DetailLine => ({ text, heading: true });
  const value = (text: string): DetailLine => ({ text });
  const structured = (label: string, item: unknown, indent = ""): DetailLine[] => {
    if (Array.isArray(item))
      return [
        value(`${indent}${label}:${item.length ? "" : " none (empty grant)"}`),
        ...item.flatMap((entry, index) =>
          structured(`Selection ${index + 1}`, entry, indent + "  "),
        ),
      ];
    if (item && typeof item === "object")
      return [
        value(`${indent}${label}:`),
        ...Object.entries(item).flatMap(([key, entry]) => structured(key, entry, indent + "  ")),
      ];
    return [value(`${indent}${label}: ${String(item)}`)];
  };
  if (panel === "description" || panel === "prompt")
    return [
      heading(panel === "description" ? "Description" : "Instructions (prompt)"),
      value(profile[panel]),
    ];
  if (panel === "route")
    return [
      heading("Models"),
      value("Fallback chain (routing, not grants)"),
      ...(profile.fallback?.length
        ? profile.fallback.map((target, index) =>
            value(
              `${index === 0 ? "Primary" : `  ↳ Retry ${index}`}: ${target.provider}/${target.id} · ${target.effort}`,
            ),
          )
        : [
            value(
              `No chain · ${profile.prewalk ? `Prewalk: ${profile.prewalk.provider}/${profile.prewalk.id} · ${profile.prewalk.effort}` : "Advanced default / selected parent model route applies."}`,
            ),
          ]),
      value("Unavailable targets may be skipped; runtime admission still applies."),
    ];
  if (panel === "tools")
    return [
      heading("Tools"),
      value(`Tools ceiling: ${list(profile.tools)}`),
      value("Callable tools: unknown in command context; inspect admitted task tools."),
      ...(profile.name === "general"
        ? [
            value(
              "Inheritance: available parent skills and callable builtins; no parent instructions/history.",
            ),
          ]
        : []),
    ];
  if (panel === "skills")
    return [
      heading("Skills (exact paths)"),
      ...(profile.skills.length ? profile.skills.map(value) : [value("none")]),
    ];
  if (panel === "delegation")
    return [
      heading("Delegation"),
      value(`Spawn ceiling: ${list(profile.spawn)}`),
      value(`Coordination: ${list(profile.coordination)}`),
    ];
  if (panel === "leafTools")
    return [
      heading("Reviewed tools (leafTools)"),
      value(
        `Reviewed leaf ceiling: ${list(profile.leafTools)} (shared writes; trusted code, not sandboxed)`,
      ),
    ];
  return [
    heading("Advanced · model policy"),
    ...structured(
      profile.fallback ? "Model default (unchained)" : "Model default",
      profile.model ?? "selected parent model",
    ),
    ...structured("Models grant", profile.models ?? "no explicit override grant"),
    ...structured("Prewalk", profile.prewalk ?? "off"),
    ...Object.entries(profile)
      .filter(([key]) => !known.has(key))
      .map(([key, item]) => value(`${key}: ${JSON.stringify(item)}`)),
    value(
      "Admission also applies parent/ancestry, model availability and capacity checks. This viewer grants nothing.",
    ),
  ];
}

/** Read-only snapshot consumer; no fixed role count or policy defaults in the renderer. */
export function createProfileViewer(
  profiles: readonly Profile[],
  theme: ProfilePanelTheme,
  keys: Pick<KeybindingsManager, "matches" | "getKeys">,
  requestRender: () => void,
  done: () => void,
  availableRows: () => number,
  options: {
    initialRole?: string;
    edit?: (name: string) => void;
    catalog?: Pick<
      ProfileCatalog,
      "provenance" | "globalPath" | "projectPath" | "projectSpawnTargets"
    > &
      Partial<Pick<ProfileCatalog, "global" | "project">>;
    trusted?: boolean;
    availableSkills?: readonly Skill[];
  } = {},
): Component {
  let selected = Math.max(
    0,
    profiles.findIndex((profile) => profile.name === options.initialRole),
  );
  let offset = 0;
  let viewport = 1;
  let maximum = 0;
  let compact = true;
  let focus: "profiles" | "settings" = "profiles";

  let setting: ProfileSetting = "description";
  let panel: ProfileSetting | undefined;
  let settingKeys: ProfileSetting[] = [];
  let follow = true;
  let visibleSettings = new Set<ProfileSetting>();
  const scrollPositions = new Map<string, number>();
  return {
    capturesViewportInput: true,
    render(width) {
      width = Math.max(0, width);
      const height = Math.max(1, Math.floor(availableRows()));
      const close = keys.getKeys("tui.select.cancel").join("/") || "Esc";
      const confirm = safe(keys.getKeys("tui.select.confirm").join("/") || "Enter");
      const paint = profileRowPaint(theme, width);
      const fallback = () =>
        [`Profiles · ${safe(close)}: close`, "Resize for details"].slice(0, height).map(paint);
      compact = true;
      if (width < 24) return fallback();
      const inner = width - 4;
      const wide = width >= 88;
      const leftWidth = wide ? Math.min(28, Math.floor(inner / 3)) : inner;
      const rightWidth = wide ? inner - leftWidth - 3 : inner;
      const footer = [
        `Tab: ${focus} · ↑↓ ${focus === "settings" && panel ? "scroll" : "select"} · j/k scroll · PgUp/Dn · Home/End`,
        "1 Profile · 2 Model · 3 Access · 4 Advanced",
        `${confirm}: open · ${options.edit ? "e: edit · " : ""}${safe(close)}: back/close · callable tools unknown here`,
      ].flatMap((line) => wrapTextWithAnsi(line, inner));
      // Frames, divider and hints are reserved before assigning any viewport rows.
      const bodyHeight = height - 3 - footer.length;
      const listHeight = wide ? bodyHeight : 1;
      const detailHeight = wide ? bodyHeight : bodyHeight - listHeight - 1;
      if (detailHeight < 4) return fallback();
      viewport = detailHeight - 6;
      if (viewport < 1) return fallback();
      compact = false;
      const profile = profiles[selected];
      const name = profile ? safe(profile.name).replaceAll("\n", " ") : "No selection";
      const provenance = profile && options.catalog?.provenance[profile.name];
      const roleRows = Math.max(1, listHeight - 6);
      const start = Math.max(0, selected - roleRows + 1);
      const roster = wide
        ? [
            theme.fg("muted", `Profiles · ${profiles.length}`),
            ...profiles
              .slice(start, start + roleRows)
              .map((entry, index) =>
                theme.fg(
                  start + index === selected ? "accent" : "text",
                  `${start + index === selected && focus === "profiles" ? ">" : " "} ${safe(entry.name).replaceAll("\n", " ")}`,
                ),
              ),
            "",
            theme.fg("muted", `Source: ${provenance?.source ?? "resolved"}`),
            theme.fg("muted", options.trusted ? "Trusted project" : "Project ignored: untrusted"),
            theme.fg("muted", "Callable tools: unknown"),
          ]
        : [
            theme.fg(
              "accent",
              `Profiles ${profiles.length ? selected + 1 : 0}/${profiles.length} · ${focus === "profiles" ? "> " : ""}${name}`,
            ),
          ];
      const content = profile
        ? [
            ...details(profile, panel ?? "description"),
            ...(panel === "advanced"
              ? [
                  { text: "" },
                  { text: "Advanced · source and security", heading: true },
                  ...(provenance
                    ? [
                        {
                          text: `Source: ${provenance.source}${provenance.ceiling ? ` · authority ceiling: ${provenance.ceiling}` : ""}`,
                        },
                        {
                          text: `Overrides: global ${provenance.globalOverride ? "yes" : "no"} · project ${provenance.projectOverride ? "yes" : "no"}`,
                        },
                      ]
                    : []),
                  ...(options.catalog
                    ? [
                        { text: `Global: ${options.catalog.globalPath}` },
                        {
                          text: `Project${options.trusted ? " (trusted)" : " (ignored: untrusted)"}: ${options.catalog.projectPath}`,
                        },
                        { text: "No write destination selected. Editing is explicit." },
                        ...(options.catalog.global
                          ? [
                              { text: `Raw Global: ${JSON.stringify(options.catalog.global)}` },
                              {
                                text: `Raw Project: ${JSON.stringify(options.catalog.project ?? {})}`,
                              },
                              {
                                text: `Inherited operator profile: ${JSON.stringify(resolveProfileCatalog(options.catalog.global, {}, options.availableSkills).profiles.find((p) => p.name === profile.name))}`,
                              },
                              { text: `Effective workspace: ${JSON.stringify(profile)}` },
                            ]
                          : []),
                        {
                          text: `Registered incoming local targets (all trusted projects): ${JSON.stringify(options.catalog.projectSpawnTargets)}`,
                        },
                        ...(profile.projectCeiling
                          ? [
                              {
                                text: `Incoming registration: ${profile.projectSpawnAuthorized ? "matching; separate parent spawn grant still required" : "not registered (root launch remains available)"}`,
                              },
                            ]
                          : []),
                        { text: "" },
                      ]
                    : []),
                ]
              : []),
          ]
        : [{ text: "No resolved profiles" }];
      // A clipped pinned name still has a complete, scrollable representation.
      if (profile && (visibleWidth(name) > rightWidth || profile.name.includes("\n")))
        content.unshift({ text: profile.name });

      let lines = content.flatMap(({ text, heading }) => {
        const wrappedLines = safe(text)
          .split("\n")
          .flatMap((line) =>
            wrapTextWithAnsi(line, rightWidth).map((wrapped) =>
              heading
                ? theme.style(wrapped, { fg: "accent", bold: true })
                : theme.fg("text", wrapped),
            ),
          );

        return wrappedLines;
      });
      visibleSettings = new Set();
      if (profile && !panel) {
        let count = 0;

        settingKeys = [];
        const metadata = (key: ProfileSetting) => {
          if (!options.catalog?.global || key === "advanced") return "";
          const layers = {
            global: options.catalog.global,
            project: options.trusted ? (options.catalog.project ?? {}) : {},
          };
          const fields = profileSettingFields(key);
          for (const layer of ["project", "global"] as const) {
            const raw = profileRawRole(layers, layer, profile.name);
            if (fields.some((f) => Object.hasOwn(raw, f)))
              return `${fields.some((f) => Array.isArray(raw[f]) && (raw[f] as unknown[]).length === 0) ? "explicit empty · " : ""}${layer === "global" ? "Global" : "Project"} override`;
          }
          return "inherited";
        };
        lines = profileOverview(profile).flatMap((item) => {
          if (!item.key) {
            const heading = [theme.style(item.heading!, { fg: "accent", bold: true }), ""];
            count += heading.length;
            return heading;
          }
          const key = item.key;
          settingKeys.push(key);
          const from = count;
          const rendered = [
            ...profileSettingLines(
              theme,
              profileSettingLabels[key],
              safe(item.value),
              rightWidth,
              key === setting && focus === "settings",
              metadata(key),
            ),
            "",
          ];
          count += rendered.length;
          if (follow && key === setting && focus === "settings") {
            if (from < offset) offset = from;
            else if (count > offset + viewport) offset = Math.max(0, count - viewport);
          }
          return rendered;
        });
        let index = 0;
        for (const item of profileOverview(profile)) {
          const size = item.key
            ? profileSettingLines(
                theme,
                profileSettingLabels[item.key],
                safe(item.value),
                rightWidth,
                false,
                metadata(item.key),
              ).length + 1
            : 2;
          if (item.key && index >= offset && index + size <= offset + viewport)
            visibleSettings.add(item.key);
          index += size;
        }
        follow = false;
      }
      maximum = Math.max(0, lines.length - viewport);
      offset = Math.min(maximum, offset);
      const detail = [
        theme.fg("accent", name),
        theme.fg("muted", `resolved · read-only · ${provenance?.source ?? "snapshot"}`),
        ...lines.slice(offset, offset + viewport),
        ...Array(Math.max(0, viewport - (lines.length - offset))).fill(""),
        "",
        ...Array.from({ length: 2 }, (_, i) =>
          theme.fg(
            "muted",
            wrapTextWithAnsi(
              safe(
                panel
                  ? "Read-only detail · Esc returns to the selected setting."
                  : profileSettingHelp[setting],
              ),
              rightWidth,
            )[i] ?? "",
          ),
        ),
        theme.fg(
          "muted",
          `${profiles.length ? selected + 1 : 0}/${profiles.length} · detail ${offset + 1}–${Math.min(lines.length, offset + viewport)}/${lines.length}`,
        ),
      ];
      const body = wide
        ? Array.from(
            { length: bodyHeight },
            (_, index) =>
              cell(roster[index] ?? "", leftWidth) +
              theme.fg("border", " │ ") +
              cell(detail[index] ?? "", rightWidth),
          )
        : [
            ...roster,
            ...Array(Math.max(0, listHeight - roster.length)).fill(""),
            theme.fg("border", "─".repeat(inner)),
            ...detail,
          ];
      const row = (text: string) =>
        paint(theme.fg("border", "│") + ` ${cell(text, inner)} ` + theme.fg("border", "│"));
      const frame = (left: string, title: string, right: string) =>
        paint(
          theme.fg("border", left) +
            theme.fg("accent", title) +
            theme.fg("border", "─".repeat(Math.max(0, width - 2 - visibleWidth(title))) + right),
        );
      return [
        frame("╭", " Subagent Profiles ", "╮"),
        ...body.map(row),
        frame("├", "", "┤"),
        ...footer.map((line) => row(theme.fg("muted", line))),
        frame("╰", "", "╯"),
      ];
    },
    handleInput(data) {
      if (keys.matches(data, "tui.select.cancel")) {
        if (panel) {
          panel = undefined;
          offset = 0;
          follow = true;
          requestRender();
        } else done();
        return;
      }
      if (matchesKey(data, "tab") || matchesKey(data, "shift+tab")) {
        focus = focus === "profiles" ? "settings" : "profiles";
        requestRender();
        return;
      }
      if (/^[1-4]$/.test(data)) {
        panel = undefined;
        setting = ["description", "route", "tools", "advanced"][Number(data) - 1] as ProfileSetting;
        offset = 0;
        follow = true;
        focus = "settings";
        requestRender();
        return;
      }
      if (keys.matches(data, "tui.select.confirm")) {
        if (compact) return;
        if (focus === "profiles") focus = "settings";
        else if (!panel && visibleSettings.has(setting)) {
          panel = setting;
          offset = 0;
        }
        requestRender();
        return;
      }
      if (options.edit && data === "e") {
        if (compact) return;
        const profile = profiles[selected];
        if (profile) options.edit(profile.name);
        return;
      }
      if (keys.matches(data, "tui.select.up") || keys.matches(data, "tui.select.down")) {
        const delta = keys.matches(data, "tui.select.up") ? -1 : 1;
        if (focus === "settings") {
          if (panel) offset = Math.max(0, Math.min(maximum, offset + delta));
          else {
            setting =
              settingKeys[
                Math.max(0, Math.min(settingKeys.length - 1, settingKeys.indexOf(setting) + delta))
              ] ?? "description";
            follow = true;
          }
        } else {
          if (profiles[selected]) scrollPositions.set(profiles[selected].name, offset);
          selected = Math.max(0, Math.min(profiles.length - 1, selected + delta));
          offset = scrollPositions.get(profiles[selected]?.name ?? "") ?? 0;
          panel = undefined;
          setting = "description";
          follow = true;
        }
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
