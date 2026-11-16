import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  colorToOklch,
  oklchColor,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";

export type ProfilePanelTheme = Pick<Theme, "fg" | "style"> & {
  colors: Pick<Theme["colors"], "customMessageBg">;
};

export function profileCell(text: string, width: number): string {
  const clipped = truncateToWidth(text, width);
  return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}

/** Full-row neutral surface; restore it after foreground and truncation ANSI resets. */
export function profileRowPaint(theme: ProfilePanelTheme, width: number): (text: string) => string {
  const bg = oklchColor(colorToOklch(theme.colors.customMessageBg).l, 0, 0);
  const restoreBg = theme.style("", { bg }).replace("\x1b[49m", "");
  return (text) =>
    profileCell(text, width)
      .split("\x1b[0m")
      .map((part) => theme.style(part.replaceAll("\x1b[49m", restoreBg), { bg }))
      .join("\x1b[0m");
}

/** Aligned label/value hierarchy; narrow panes keep wrapped values under their label. */
export function profileSettingLines(
  theme: ProfilePanelTheme,
  label: string,
  value: string,
  width: number,
  selected = false,
  metadata = "",
): string[] {
  if (metadata) value += ` · ${theme.fg("muted", metadata)}`;
  const prefix = selected ? "› " : "  ";
  const styledLabel = theme.style(label, { fg: selected ? "accent" : "text", bold: true });
  const column = 15;
  if (width >= 64) {
    const indent = 2 + column;
    const values = wrapTextWithAnsi(value, Math.max(1, width - indent));
    return values.map((line, index) =>
      index === 0
        ? `${prefix}${styledLabel}${" ".repeat(Math.max(1, column - visibleWidth(label)))}${line}`
        : " ".repeat(indent) + line,
    );
  }
  return [
    prefix + styledLabel,
    ...wrapTextWithAnsi(value, Math.max(1, width - 4)).map((s) => `    ${s}`),
  ];
}
