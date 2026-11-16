import type { Theme } from "@earendil-works/pi-coding-agent";
import { colorToOklch, oklchColor, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

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
