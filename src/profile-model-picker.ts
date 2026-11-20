import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  Input,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
  type Focusable,
  type KeybindingsManager,
} from "@earendil-works/pi-tui";
import {
  profileCell,
  profileEffortLabel,
  profileKeyText,
  profileModelIdentity,
  profilePrice,
  profileRowPaint,
  profileTokenCount,
  type ProfilePanelTheme,
} from "./profile-presentation.ts";
import { safe } from "./thread.ts";
import type { ModelSelection } from "./model-policy.ts";
import {
  filterProfileModels,
  profileModelPickReason,
  type ProfileModelEntry,
  type ProfileModelCatalog,
  type ProfileModelPickOptions,
  type ProfileModelSource,
} from "./profile-model-catalog.ts";

const unavailable: ProfileModelCatalog = {
  entries: [],
  error: "Model metadata is unavailable. No manual ID entry; saved selections are retained.",
};
const accessible = "Accessible in this session; profile authorization remains separate.";

/**
 * One metadata snapshot per opening; ^R rereads it. Search (native Input) always has focus while
 * browsing, Enter opens an effort strip and a second Enter selects after a fresh recheck.
 */
export function createProfileModelPicker(
  source: ProfileModelSource | undefined,
  options: ProfileModelPickOptions,
  theme: ProfilePanelTheme,
  keys: Pick<KeybindingsManager, "matches" | "getKeys">,
  requestRender: () => void,
  done: (selection: ModelSelection | undefined) => void,
  availableRows: () => number,
): Component & Focusable {
  const input = new Input({ prompt: "🔍 > ", placeholder: "name, provider or ID" });
  let catalog: ProfileModelCatalog = unavailable;
  const refresh = () => {
    try {
      catalog = source?.() ?? unavailable;
    } catch {
      catalog = unavailable;
    }
  };
  refresh();
  let provider = "";
  let selected = 0;
  /** Defined while the effort strip is open. */
  let effort: ModelSelection["effort"] | undefined;
  let compact = true;
  let focused = false;
  let details = false;
  let detailOffset = 0;
  let detailMaximum = 0;
  let detailViewport = 1;
  let notice = "";
  const keyText = (action: Parameters<typeof keys.getKeys>[0]) => profileKeyText(keys, action);
  const pickReason = (entry: ProfileModelEntry, value: ModelSelection["effort"]) =>
    profileModelPickReason(
      catalog,
      { provider: entry.provider, id: entry.id, effort: value },
      options,
    );
  const eligible = (entry: ProfileModelEntry) =>
    entry.efforts.some(({ effort }) => !pickReason(entry, effort));
  const granted = (entry: ProfileModelEntry, value?: ModelSelection["effort"]) =>
    !!options.prioritized?.some(
      (item) =>
        item.provider === entry.provider &&
        item.id === entry.id &&
        (value === undefined || item.effort === value),
    );
  const matches = () => filterProfileModels(catalog, input.getValue(), provider);
  /** Eligible rows; models holding a `prioritized` grant come first (`split` of them). */
  const rows = () => {
    const list = matches().filter(eligible);
    const first = list.filter((entry) => granted(entry));
    return { list: [...first, ...list.filter((entry) => !granted(entry))], split: first.length };
  };
  const providers = () => ["", ...new Set(catalog.entries.map((entry) => entry.provider))];
  const selection = (): ModelSelection | undefined => {
    const entry = rows().list[selected];
    return entry && effort ? { provider: entry.provider, id: entry.id, effort } : undefined;
  };
  const openEfforts = (entry: ProfileModelEntry) => {
    const allowed = entry.efforts.filter(({ effort }) => !pickReason(entry, effort));
    // Keep a replaced target's effort level, else prefer an effort that already has an exact
    // grant so choosing it adds none.
    effort = (
      allowed.find(({ effort }) => effort === options.preferredEffort) ??
      allowed.find(({ effort }) => granted(entry, effort)) ??
      allowed[0]
    )?.effort;
  };
  let renderWidth = 0;
  const component: Component & Focusable = {
    capturesViewportInput: true,
    get focused() {
      return focused;
    },
    set focused(value) {
      focused = value;
      input.focused = value && !details;
    },
    render(width) {
      width = Math.max(0, width);
      renderWidth = width;
      const height = Math.max(1, Math.floor(availableRows()));
      const paint = profileRowPaint(theme, width);
      const cancel = keyText("tui.select.cancel");
      const confirm = keyText("tui.select.confirm");
      compact = width < 32 || height < 14;
      if (compact)
        return ["Models · resize", "Saved entries retained", `${cancel}: back`]
          .slice(0, height)
          .map(paint);
      const { list, split } = rows();
      selected = Math.max(0, Math.min(selected, list.length - 1));
      const entry = list[selected];
      if (!entry) effort = undefined;
      const target = entry && effort && { provider: entry.provider, id: entry.id, effort };
      const disabledReason = target
        ? profileModelPickReason(catalog, target, options)
        : "Choose a supported effort before selecting";
      input.focused = focused && !details;
      const hidden = matches().filter((item) => !eligible(item));
      const wrap = (text: string, color?: "muted" | "warning") =>
        wrapTextWithAnsi(text, width).map((line) => (color ? theme.fg(color, line) : line));
      if (details) {
        const lines = [
          ...options.context,
          ...(catalog.error ? [catalog.error] : []),
          "",
          entry ? `ID: ${entry.provider}/${entry.id}` : "No selected model",
          "",
          "Supported efforts (exact values)",
          ...(entry?.efforts.map(
            (item) => `· ${item.effort}${item.reason ? ` — ${item.reason}` : ""}`,
          ) ?? ["None"]),
          "",
          `Selected effort: ${effort ?? "not chosen"}`,
          options.selectionLabel ?? "Select (no automatic grants)",
          disabledReason ?? accessible,
          "",
          "^R refresh rereads the host snapshot only; no network refresh.",
          "",
          "Hidden matching models (exact reasons)",
          ...hidden.flatMap((item) => [
            `ID: ${item.provider}/${item.id}`,
            ...(item.efforts.length
              ? item.efforts.map(
                  ({ effort }) => `${effort}: ${pickReason(item, effort) ?? "Eligible"}`,
                )
              : ["No supported efforts"]),
          ]),
        ].flatMap((line) => wrapTextWithAnsi(safe(line), width));
        detailViewport = height - 4;
        detailMaximum = Math.max(0, lines.length - detailViewport);
        detailOffset = Math.min(detailOffset, detailMaximum);
        return [
          theme.style("Model details", { fg: "accent", bold: true }),
          "",
          ...lines.slice(detailOffset, detailOffset + detailViewport),
          ...Array(Math.max(0, detailViewport - lines.length)).fill(""),
          "",
          theme.fg("muted", `↑/↓ · j/k · PgUp/Dn scroll · F1/${cancel}: back`),
        ].map(paint);
      }
      // Provider tabs scroll so the active tab stays visible; truncation marks the overflow.
      const tabs = providers();
      const active = Math.max(0, tabs.indexOf(provider));
      const tab = (index: number) =>
        index === active
          ? `${theme.fg("accent", "◀")}${theme.style(` ${safe(tabs[index] || "all")} `, { fg: "accent", bold: true, inverse: true })}${theme.fg("accent", "▶")}`
          : theme.fg("muted", safe(tabs[index] || "all"));
      let first = 0;
      const span = (from: number) =>
        visibleWidth(`Provider: ${from ? "… " : ""}`) +
        tabs
          .slice(from, active + 1)
          .reduce((sum, _, index) => sum + visibleWidth(tab(from + index)) + 2, 0);
      while (first < active && span(first) > width) first++;
      const providerLine = truncateToWidth(
        `${theme.fg("muted", `Provider: ${first ? "… " : ""}`)}${tabs
          .slice(first)
          .map((_, index) => tab(first + index))
          .join("  ")}`,
        width,
        "…",
      );
      const hiddenReasons = new Set(
        hidden.flatMap((item) =>
          item.efforts.length
            ? item.efforts.map(({ effort }) => {
                const why = pickReason(item, effort);
                return why?.includes("scope")
                  ? "session scope"
                  : why?.startsWith("Not authorized")
                    ? "exact grants"
                    : why === "Exact selection already present"
                      ? "already present"
                      : "unavailable metadata/access";
              })
            : ["no supported efforts"],
        ),
      );
      const detail = entry
        ? [
            theme.fg("text", safe(entry.name)),
            ...[
              entry.contextWindow && `${profileTokenCount(entry.contextWindow)} ctx`,
              entry.maxTokens && `${profileTokenCount(entry.maxTokens)} out`,
              entry.cost && `${profilePrice(entry.cost)} per M`,
              entry.reasoning && "reasoning",
              entry.vision && "vision",
            ]
              .filter((part) => typeof part === "string")
              .map((part) => theme.fg("muted", part)),
          ].join(theme.fg("muted", " · "))
        : "";
      const strip =
        entry && effort
          ? wrap(
              `${theme.fg("muted", "Effort: ")}${entry.efforts
                .map(({ effort: value }) => {
                  const label = profileEffortLabel(value);
                  const allowed = !pickReason(entry, value);
                  return value === effort
                    ? theme.style(`[${label}]`, { fg: allowed ? "accent" : "warning", bold: true })
                    : theme.fg(allowed ? "text" : "dim", label);
                })
                .join("  ")}`,
            )
          : [];
      const status = notice
        ? wrap(safe(notice), "warning")
        : effort
          ? wrap(safe(disabledReason ?? accessible), disabledReason ? "warning" : "muted")
          : [];
      const hints = (shedHidden: boolean) => {
        const f1 = shedHidden && hidden.length ? `F1 ${hidden.length} hidden` : "F1 details";
        return wrap(
          (effort
            ? [
                "←/→ effort",
                `${confirm} ${options.selectionLabel ?? "select (no automatic grants)"}`,
                f1,
                `${cancel} back to list`,
              ]
            : [
                "type to search",
                "↑/↓ move",
                "⌥←/→/Tab provider",
                `${confirm} choose effort`,
                f1,
                "^R refresh",
                `${cancel} cancel`,
              ]
          ).join(" · "),
          "muted",
        );
      };
      // Shed spacers, then the hidden summary (counted in the hints instead), then the detail
      // line, before results; disclosures, search, effort strip, reasons and hints never shed.
      const divided = split > 0 && split < list.length;
      const items: (ProfileModelEntry | undefined)[] = [...list];
      if (divided) items.splice(split, 0, undefined);
      const minimum = Math.min(5, Math.max(1, items.length));
      let prefix: string[] = [];
      let suffix: string[] = [];
      for (let level = 0; level < 4; level++) {
        prefix = [
          ...wrap(
            `${theme.style(safe(options.title), { fg: "accent", bold: true })}${theme.fg("muted", ` — ${confirm} assigns, ${cancel} cancels`)}`,
          ),
          ...wrap(safe(options.context.join(" · ")), "muted"),
          providerLine,
          ...input.render(width),
          ...(level < 1 ? [""] : []),
        ];
        suffix = [
          ...(level < 1 ? [""] : []),
          ...(level < 3 && detail ? [truncateToWidth(detail, width, "…")] : []),
          ...strip,
          ...status,
          ...(level < 2 && hidden.length
            ? wrap(
                `${hidden.length} model${hidden.length === 1 ? "" : "s"} hidden: ${[...hiddenReasons].join(", ")}.`,
                "muted",
              )
            : []),
          ...hints(level >= 2),
        ];
        if (prefix.length + suffix.length + minimum <= height) break;
      }
      const resultHeight = height - prefix.length - suffix.length;
      if (resultHeight < 1) {
        compact = true;
        return ["Models · resize (80×24 terminal baseline)", `${cancel}: back`]
          .slice(0, height)
          .map(paint);
      }
      // Right-aligned metadata columns are sized over the whole snapshot (stable while searching)
      // and omitted when no model has the value. Narrow widths drop price, context, then reasoning.
      const column = (cell: (item: ProfileModelEntry) => string) => ({
        cell,
        width: Math.max(0, ...catalog.entries.map((item) => visibleWidth(cell(item)))),
      });
      const columns = [
        column((item) => (item.reasoning ? "🧠" : "")),
        column((item) => profileTokenCount(item.contextWindow)),
        column((item) => profilePrice(item.cost)),
      ].filter((item) => item.width);
      const room = () => width - 2 - columns.reduce((sum, item) => sum + item.width + 2, 0);
      while (columns.length && room() < 24) columns.pop();
      const index = selected + (divided && selected >= split ? 1 : 0);
      const start = Math.max(
        0,
        Math.min(index - Math.floor(resultHeight / 2), items.length - resultHeight),
      );
      const results = items.slice(start, start + resultHeight).map((item) => {
        if (!item) return ` ${theme.fg("border", "─".repeat(Math.max(0, width - 2)))}`;
        const current = item === entry;
        return `${current ? theme.fg("accent", "❯") : " "} ${profileCell(
          profileModelIdentity(
            theme,
            safe(item.provider),
            safe(item.id),
            room(),
            current ? "accent" : "text",
          ),
          room(),
        )}${columns
          .map(({ cell, width: size }) => {
            const text = cell(item);
            return `  ${" ".repeat(size - visibleWidth(text))}${theme.fg("muted", text)}`;
          })
          .join("")}`;
      });
      if (!results.length)
        results.push(
          ...wrapTextWithAnsi(
            safe(
              catalog.error ??
                (hidden.length
                  ? "All matching models are hidden. F1: reasons."
                  : catalog.entries.length
                    ? "No matching models. Change search/provider."
                    : "No accessible physical models in host metadata."),
            ),
            width,
          ).slice(0, resultHeight),
        );
      while (results.length < resultHeight) results.push("");
      return [...prefix, ...results, ...suffix].map(paint);
    },
    handleInput(data) {
      component.render(renderWidth);
      if (keys.matches(data, "tui.select.cancel")) {
        // Escape peels one layer: details, then the effort strip, then the picker.
        if (details) details = false;
        else if (effort) {
          effort = undefined;
          notice = "";
        } else {
          done(undefined);
          return;
        }
        requestRender();
        return;
      }
      if (compact) return;
      if (matchesKey(data, "f1")) {
        details = !details;
        detailOffset = 0;
      } else if (details) {
        const up = data === "k" || keys.matches(data, "tui.select.up");
        const down = data === "j" || keys.matches(data, "tui.select.down");
        const pageUp = keys.matches(data, "tui.select.pageUp");
        const pageDown = keys.matches(data, "tui.select.pageDown");
        if (matchesKey(data, "home")) detailOffset = 0;
        else if (matchesKey(data, "end")) detailOffset = detailMaximum;
        else if (up || down || pageUp || pageDown)
          detailOffset = Math.max(
            0,
            Math.min(
              detailMaximum,
              detailOffset + (up ? -1 : down ? 1 : pageUp ? -detailViewport : detailViewport),
            ),
          );
        else return; // Metadata browsing must never activate the hidden selection action.
      } else if (matchesKey(data, "ctrl+r")) {
        refresh();
        if (!providers().includes(provider)) provider = "";
        selected = 0;
        effort = undefined;
        notice = "Reread the host model snapshot; no network refresh.";
      } else if (effort && (matchesKey(data, "left") || matchesKey(data, "right"))) {
        // Ineligible efforts stay reachable so their exact reason can be inspected.
        const efforts = rows().list[selected]?.efforts ?? [];
        const index = efforts.findIndex((item) => item.effort === effort);
        effort =
          efforts[
            Math.max(0, Math.min(efforts.length - 1, index + (matchesKey(data, "left") ? -1 : 1)))
          ]?.effort ?? effort;
        notice = "";
      } else if (effort && keys.matches(data, "tui.select.confirm")) {
        const target = selection();
        const why = target ? profileModelPickReason(catalog, target, options) : "No selected model";
        if (why) notice = why;
        else if (target) {
          // A second local snapshot closes stale eligibility without touching credentials or disk.
          refresh();
          const rejection = profileModelPickReason(catalog, target, options);
          if (!rejection) {
            done(target);
            return;
          }
          effort = undefined;
          notice = rejection;
        }
      } else {
        // List keys. Any other key in the effort strip returns to the list and applies there.
        effort = undefined;
        notice = "";
        const tabKey = matchesKey(data, "tab") || matchesKey(data, "shift+tab");
        if (tabKey || matchesKey(data, "alt+left") || matchesKey(data, "alt+right")) {
          const tabs = providers();
          const delta = matchesKey(data, "alt+left") || matchesKey(data, "shift+tab") ? -1 : 1;
          provider =
            tabs[(Math.max(0, tabs.indexOf(provider)) + delta + tabs.length) % tabs.length];
          selected = 0;
        } else if (keys.matches(data, "tui.select.up") || keys.matches(data, "tui.select.down"))
          selected = Math.max(
            0,
            Math.min(
              rows().list.length - 1,
              selected + (keys.matches(data, "tui.select.up") ? -1 : 1),
            ),
          );
        else if (keys.matches(data, "tui.select.confirm")) {
          const entry = rows().list[selected];
          if (entry) openEfforts(entry);
        } else {
          const before = input.getValue();
          input.handleInput(data);
          if (input.getValue() !== before) selected = 0;
        }
      }
      input.focused = focused && !details;
      requestRender();
    },
    invalidate() {
      input.invalidate();
    },
  };
  return component;
}

export function pickProfileModel(
  ctx: Pick<ExtensionCommandContext, "ui">,
  source: ProfileModelSource | undefined,
  options: ProfileModelPickOptions,
): Promise<ModelSelection | undefined> {
  return ctx.ui.custom<ModelSelection | undefined>(
    (tui, theme, keys, done) =>
      createProfileModelPicker(
        source,
        options,
        theme,
        keys,
        () => tui.requestRender(),
        done,
        () => Math.max(1, Math.floor(tui.terminal.rows * 0.9)),
      ),
    {
      overlay: true,
      overlayOptions: { width: "90%", maxHeight: "90%", anchor: "center" },
      blocked: { kind: "question", message: options.title },
    },
  );
}
