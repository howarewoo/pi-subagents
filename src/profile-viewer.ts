import type { Skill, Theme } from "@earendil-works/pi-coding-agent";
import {
  colorToOklch,
  oklchColor,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
  type KeybindingsManager,
} from "@earendil-works/pi-tui";
import { safe } from "./thread.ts";
import { bundledProfiles, resolveProfile, type Profile } from "./profiles.ts";

export const profileToolPolicy =
  "Profile tools are maximum allowlists, not requirements. Admission intersects callable parent builtins without activating tools. Command context has no callable-tool dispatcher: effective tools are unknown here. Active declarations are not proof of callability. General inherits available parent skills and callable builtins within its ceiling, not parent instructions/history; only operator-reviewed leaf tools may be forwarded and callers coordinate concurrent writes. Leaf grants assert trusted code, not a sandbox. Inspect task snapshot tools, leafTools, skills and capabilityDenials for admitted grants.";

/** Resolve through the same trust/config/skill validation boundary used by admission. */
export async function resolvedProfiles(
  cwd: string,
  trusted: boolean,
  operatorDir?: string,
  availableSkills: readonly Skill[] = [],
): Promise<Profile[]> {
  return Promise.all(
    bundledProfiles().map(
      async ({ name }) =>
        (await resolveProfile(name, cwd, trusted, operatorDir, availableSkills)).profile,
    ),
  );
}

type DetailLine = { text: string; heading?: boolean };

function details(profile: Profile): DetailLine[] {
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
  return [
    heading("Description"),
    value(profile.description),
    value(""),
    heading("Prompt"),
    value(profile.prompt),
    value(""),
    heading("Tools and permissions"),
    value(`Tools ceiling: ${list(profile.tools)}`),
    value("Callable tools: unknown in command context; inspect admitted task tools."),
    ...(profile.name === "general"
      ? [
          value(
            "Inheritance: available parent skills and callable builtins; no parent instructions/history.",
          ),
        ]
      : []),
    value(
      `Reviewed leaf ceiling: ${list(profile.leafTools)} (shared writes; trusted code, not sandboxed)`,
    ),
    value(`Spawn ceiling: ${list(profile.spawn)}`),
    value(`Coordination: ${list(profile.coordination)}`),
    value(""),
    heading("Skills (exact paths)"),
    ...(profile.skills.length ? profile.skills.map(value) : [value("none")]),
    value(""),
    heading("Model policy"),
    ...structured(
      profile.fallback ? "Model default (unchained)" : "Model default",
      profile.model ?? "selected parent model",
    ),
    ...structured("Models grant", profile.models ?? "no explicit override grant"),
    ...structured("Prewalk", profile.prewalk ?? "off"),
    ...(profile.fallback
      ? structured("Fallback chain (routing, not grants)", profile.fallback)
      : []),
    ...Object.entries(profile)
      .filter(([key]) => !known.has(key))
      .map(([key, item]) => value(`${key}: ${JSON.stringify(item)}`)),
    value(""),
    value(
      "Admission also applies parent/ancestry, model availability and capacity checks. This viewer grants nothing.",
    ),
  ];
}

/** Read-only snapshot consumer; no fixed role count or policy defaults in the renderer. */
export function createProfileViewer(
  profiles: readonly Profile[],
  theme: Pick<Theme, "fg" | "style"> & { colors: Pick<Theme["colors"], "customMessageBg"> },
  keys: Pick<KeybindingsManager, "matches" | "getKeys">,
  requestRender: () => void,
  done: () => void,
  availableRows: () => number,
): Component {
  let selected = 0;
  let offset = 0;
  let viewport = 1;
  let maximum = 0;
  const cell = (text: string, width: number) => {
    const clipped = truncateToWidth(text, width);
    return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
  };
  return {
    render(width) {
      width = Math.max(0, width);
      const height = Math.max(1, Math.floor(availableRows()));
      const close = keys.getKeys("tui.select.cancel").join("/") || "Esc";
      const panelBg = oklchColor(colorToOklch(theme.colors.customMessageBg).l, 0, 0);
      // Match the Hub: foreground helpers may reset both colors inside a painted line.
      const paint = (text: string) => {
        const padded = cell(text, width);
        const restoreBg = theme.style("", { bg: panelBg }).replace("\x1b[49m", "");
        return padded
          .split("\x1b[0m")
          .map((part) => theme.style(part.replaceAll("\x1b[49m", restoreBg), { bg: panelBg }))
          .join("\x1b[0m");
      };
      const fallback = () =>
        [`Profiles · ${safe(close)}: close`, "Resize for details"].slice(0, height).map(paint);
      if (width < 24) return fallback();
      const inner = width - 4;
      const wide = width >= 88;
      const leftWidth = wide ? Math.min(28, Math.floor(inner / 3)) : inner;
      const rightWidth = wide ? inner - leftWidth - 3 : inner;
      const footer = [
        "↑↓ select · j/k scroll · PgUp/Dn · Home/End",
        `${safe(close)}: close · callable tools unknown here`,
      ].flatMap((line) => wrapTextWithAnsi(line, inner));
      // Frames, divider and hints are reserved before assigning any viewport rows.
      const bodyHeight = height - 3 - footer.length;
      const listHeight = wide ? bodyHeight : Math.min(3, Math.max(1, Math.floor(bodyHeight / 3)));
      const detailHeight = wide ? bodyHeight : bodyHeight - listHeight - 1;
      if (detailHeight < 4) return fallback();
      viewport = detailHeight - 3;
      const start = Math.max(0, selected - listHeight + 1);
      const roster = profiles
        .slice(start, start + listHeight)
        .map((profile, index) =>
          theme.fg(
            start + index === selected ? "accent" : "text",
            `${start + index === selected ? ">" : " "} ${safe(profile.name).replaceAll("\n", " ")}`,
          ),
        );
      const profile = profiles[selected];
      const name = profile ? safe(profile.name).replaceAll("\n", " ") : "No selection";
      const content = profile ? details(profile) : [{ text: "No resolved profiles" }];
      // A clipped pinned name still has a complete, scrollable representation.
      if (profile && (visibleWidth(name) > rightWidth || profile.name.includes("\n")))
        content.unshift({ text: profile.name });
      const lines = content.flatMap(({ text, heading }) =>
        safe(text)
          .split("\n")
          .flatMap((line) =>
            wrapTextWithAnsi(line, rightWidth).map((wrapped) =>
              theme.fg(heading ? "accent" : "text", wrapped),
            ),
          ),
      );
      maximum = Math.max(0, lines.length - viewport);
      offset = Math.min(maximum, offset);
      const detail = [
        theme.fg("accent", name),
        theme.fg("muted", "resolved · read-only"),
        ...lines.slice(offset, offset + viewport),
        ...Array(Math.max(0, viewport - (lines.length - offset))).fill(""),
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
        done();
        return;
      }
      if (keys.matches(data, "tui.select.up") || keys.matches(data, "tui.select.down")) {
        selected = Math.max(
          0,
          Math.min(profiles.length - 1, selected + (keys.matches(data, "tui.select.up") ? -1 : 1)),
        );
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
