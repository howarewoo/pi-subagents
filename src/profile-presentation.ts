import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  colorToOklch,
  oklchColor,
  sliceByColumn,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { ModelSelection } from "./model-policy.ts";

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

/** One glyph per supported effort, rising from off to max. */
export const PROFILE_EFFORT_GLYPHS: Readonly<Record<ModelSelection["effort"], string>> = {
  off: "⦸",
  minimal: "◌",
  low: "◔",
  medium: "◑",
  high: "◕",
  xhigh: "●",
  max: "◉",
};

/** `◔ low` */
export function profileEffortLabel(effort: ModelSelection["effort"]): string {
  return `${PROFILE_EFFORT_GLYPHS[effort]} ${effort}`;
}

/** Token counts as `1m`, `500k`, `8.2k`; unknown or non-positive counts render blank. */
export function profileTokenCount(tokens: number | undefined): string {
  if (!tokens || !Number.isFinite(tokens) || tokens <= 0) return "";
  const [value, unit] =
    tokens >= 1e6 ? [tokens / 1e6, "m"] : tokens >= 1e3 ? [tokens / 1e3, "k"] : [tokens, ""];
  return `${value < 10 ? Number(value.toFixed(1)) : Math.round(value)}${unit}`;
}

/** `$input/output` per million tokens; all-zero cost is `$0` because zero may mean unknown. */
export function profilePrice(
  cost: Readonly<{ input: number; output: number }> | undefined,
): string {
  if (!cost) return "";
  const amount = (value: number) => String(Number(value.toFixed(3)));
  return cost.input === 0 && cost.output === 0
    ? "$0"
    : `$${amount(cost.input)}/${amount(cost.output)}`;
}

/**
 * Muted `provider/` and a bright id within `width`. The provider is truncated first (down to `…/`)
 * so the id stays visible; only an id too long on its own is truncated too.
 */
export function profileModelIdentity(
  theme: Pick<ProfilePanelTheme, "fg">,
  provider: string,
  id: string,
  width: number,
  idColor: "text" | "accent" = "text",
): string {
  // Plain clipping keeps each part inside its own color (truncateToWidth would insert resets).
  const clip = (text: string, room: number) =>
    visibleWidth(text) <= room ? text : room < 1 ? "" : `${sliceByColumn(text, 0, room - 1)}…`;
  if (width < 3) return theme.fg(idColor, clip(id, width));
  const providerRoom = Math.max(1, width - visibleWidth(id) - 1);
  return (
    theme.fg("muted", `${clip(provider, providerRoom)}/`) +
    theme.fg(idColor, clip(id, width - providerRoom - 1))
  );
}
