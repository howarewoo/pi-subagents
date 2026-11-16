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
import { profileRowPaint, type ProfilePanelTheme } from "./profile-presentation.ts";
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

/** One metadata snapshot per opening, with explicit local-metadata Refresh. Search uses native Input. */
export function createProfileModelPicker(
  source: ProfileModelSource | undefined,
  options: ProfileModelPickOptions,
  theme: ProfilePanelTheme,
  keys: Pick<KeybindingsManager, "matches" | "getKeys">,
  requestRender: () => void,
  done: (selection: ModelSelection | undefined) => void,
  availableRows: () => number,
): Component & Focusable {
  const input = new Input({ prompt: "Search: ", placeholder: "Name, provider or ID" });
  let catalog: ProfileModelCatalog = unavailable;
  const refresh = () => {
    try {
      catalog = source?.() ?? unavailable;
    } catch {
      catalog = unavailable;
    }
  };
  refresh();
  const focuses = ["search", "provider", "models", "effort", "add", "refresh"] as const;
  let focus = 0;
  let provider = "";
  let selected = 0;
  let effort: ModelSelection["effort"] | undefined;
  let compact = true;
  let focused = false;
  let details = false;
  let detailOffset = 0;
  let detailMaximum = 0;
  let detailViewport = 1;
  let notice = "";
  const matches = () => filterProfileModels(catalog, input.getValue(), provider);
  const eligible = (entry: ProfileModelEntry) =>
    entry.efforts.some(
      ({ effort }) =>
        !profileModelPickReason(
          catalog,
          { provider: entry.provider, id: entry.id, effort },
          options,
        ),
    );
  const rows = () => matches().filter(eligible);
  const selection = (): ModelSelection | undefined => {
    const entry = rows()[selected];
    return entry && effort ? { provider: entry.provider, id: entry.id, effort } : undefined;
  };
  const reason = () => {
    const target = selection();
    return target
      ? profileModelPickReason(catalog, target, options)
      : "Choose a supported effort before selecting";
  };
  const reset = () => {
    selected = 0;
    effort = undefined;
    notice = "";
  };
  return {
    capturesViewportInput: true,
    get focused() {
      return focused;
    },
    set focused(value) {
      focused = value;
      input.focused = value && focus === 0 && !details;
    },
    render(width) {
      width = Math.max(0, width);
      const height = Math.max(1, Math.floor(availableRows()));
      const paint = profileRowPaint(theme, width);
      const cancel = safe(keys.getKeys("tui.select.cancel").join("/") || "Esc");
      compact = width < 32 || height < 14;
      if (compact)
        return ["Models · resize", "Saved entries retained", `${cancel}: back`]
          .slice(0, height)
          .map(paint);
      const list = rows();
      selected = Math.max(0, Math.min(selected, list.length - 1));
      const entry = list[selected];
      const active = (name: (typeof focuses)[number], text: string) => {
        const colon = text.indexOf(":");
        const label = colon >= 0 ? text.slice(0, colon + 1) : text;
        return `${focuses[focus] === name && focused ? "›" : " "} ${theme.style(label, { fg: focuses[focus] === name ? "accent" : "text", bold: true })}${text.slice(label.length)}`;
      };
      const disabledReason = reason();
      const reasonLines = wrapTextWithAnsi(
        safe(
          notice ||
            disabledReason ||
            "Accessible in this session; profile authorization remains separate.",
        ),
        width,
      );
      const contextLines = options.context.flatMap((line) => wrapTextWithAnsi(safe(line), width));
      const providerLabel =
        catalog.entries.find((item) => item.provider === provider)?.providerLabel ??
        "All providers";
      input.focused = focused && focus === 0 && !details;
      if (details) {
        const lines = [
          ...options.context,
          "",
          entry ? `ID: ${entry.provider}/${entry.id}` : "No selected model",
          "",
          "Supported efforts (exact values)",
          ...(entry?.efforts.map(
            (item) => `· ${item.effort}${item.reason ? ` — ${item.reason}` : ""}`,
          ) ?? ["None"]),
          "",
          `Selected effort: ${effort ?? "not chosen"}`,
          disabledReason ?? "Accessible in this session; profile authorization remains separate.",
          "",
          "Metadata Refresh rereads the host snapshot only; no network refresh.",
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
      const prefix = [
        theme.style(safe(options.title), { fg: "accent", bold: true }),
        ...contextLines.map((line) => theme.fg("muted", line)),
        "",
        ...input.render(width),
        active("provider", `Provider: ${safe(providerLabel)} · ←/→ filter`),
        "",
        active("models", `Models: ${list.length} matches · ↑/↓ browse`),
      ];
      const hidden = matches().filter((item) => !eligible(item));
      const hiddenReasons = new Set(
        hidden.flatMap((item) =>
          item.efforts.length
            ? item.efforts.map(({ effort }) => {
                const why = profileModelPickReason(
                  catalog,
                  { provider: item.provider, id: item.id, effort },
                  options,
                );
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
      const suffix = [
        ...(hidden.length
          ? wrapTextWithAnsi(
              `${hidden.length} model${hidden.length === 1 ? "" : "s"} hidden: ${[...hiddenReasons].join(", ")}.`,
              width,
            ).map((line) => theme.fg("muted", line))
          : []),
        "",
        ...wrapTextWithAnsi(
          active(
            "effort",
            `Effort: ${effort ?? "not chosen"} · ←/→ choose · ${entry?.efforts.length ?? 0} supported`,
          ),
          width,
        ),
        ...reasonLines.map((line) =>
          theme.fg(notice || disabledReason ? "warning" : "muted", line),
        ),
        "",
        ...wrapTextWithAnsi(
          active(
            "add",
            disabledReason
              ? "Select [disabled]"
              : `${options.selectionLabel ?? "Select (no automatic grants)"} · ${effort}`,
          ),
          width,
        ),
        active("refresh", "Refresh metadata · host snapshot only, no network refresh"),
        theme.fg(
          "muted",
          `↑↓: browse · Tab: focus · Enter: choose · F1: details · ${cancel}: back`,
        ),
      ];
      // Reclaim spacers before hiding otherwise usable results in a short overlay.
      for (const block of [suffix, prefix]) {
        while (prefix.length + suffix.length >= height) {
          const spacer = block.lastIndexOf("");
          if (spacer < 0) break;
          block.splice(spacer, 1);
        }
      }
      const fixedHeight = prefix.length + suffix.length;
      if (height <= fixedHeight) {
        compact = true;
        return ["Models · resize", `${cancel}: back`].slice(0, height).map(paint);
      }
      const resultHeight = height - fixedHeight;
      const start = Math.max(
        0,
        Math.min(selected - Math.floor(resultHeight / 2), list.length - resultHeight),
      );
      const results = list.slice(start, start + resultHeight).map((item, index) => {
        const selectedRow = start + index === selected;
        const name = truncateToWidth(safe(item.name), Math.max(1, width - 2));
        const providerRoom = Math.max(0, width - 2 - visibleWidth(name) - 3);
        const providerText =
          providerRoom >= 8
            ? ` · ${theme.fg("muted", truncateToWidth(safe(item.providerLabel), providerRoom))}`
            : "";
        return `${selectedRow && focus === 2 && focused ? "›" : " "} ${theme.fg(selectedRow ? "accent" : "text", name)}${providerText}`;
      });
      if (!results.length)
        results.push(
          ...wrapTextWithAnsi(
            safe(
              catalog.error ??
                (hidden.length
                  ? "All matching models are hidden. See reasons below."
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
      if (keys.matches(data, "tui.select.cancel")) {
        if (details) {
          details = false;
          requestRender();
          return;
        }
        done(undefined);
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
      } else if (matchesKey(data, "tab") || matchesKey(data, "shift+tab")) {
        focus = (focus + (matchesKey(data, "shift+tab") ? focuses.length - 1 : 1)) % focuses.length;
      } else if (
        (focus === 0 || focus === 2) &&
        (keys.matches(data, "tui.select.up") || keys.matches(data, "tui.select.down"))
      ) {
        if (focus === 2)
          selected = Math.max(
            0,
            Math.min(rows().length - 1, selected + (keys.matches(data, "tui.select.up") ? -1 : 1)),
          );
        focus = 2;
        effort = undefined;
        notice = "";
      } else if (focus === 0) {
        if (keys.matches(data, "tui.select.confirm")) focus = 2;
        else {
          input.handleInput(data);
          reset();
        }
      } else if (
        (focus === 1 || focus === 3) &&
        (matchesKey(data, "left") || matchesKey(data, "right"))
      ) {
        const delta = matchesKey(data, "left") ? -1 : 1;
        if (focus === 1) {
          const providers = ["", ...new Set(catalog.entries.map((entry) => entry.provider))];
          provider =
            providers[
              (Math.max(0, providers.indexOf(provider)) + delta + providers.length) %
                providers.length
            ];
          reset();
        } else {
          notice = "";
          const efforts = rows()[selected]?.efforts ?? [];
          const index = efforts.findIndex((item) => item.effort === effort);
          effort = efforts.length
            ? efforts[
                index < 0
                  ? delta > 0
                    ? 0
                    : efforts.length - 1
                  : (index + delta + efforts.length) % efforts.length
              ].effort
            : undefined;
        }
      } else if (keys.matches(data, "tui.select.confirm")) {
        if (focus === 2) focus = 3;
        else if (focus === 3) focus = 4;
        else if (focus === 4 && !reason()) {
          // A second local snapshot closes stale eligibility without touching credentials or disk.
          const target = selection();
          refresh();
          const rejection = target && profileModelPickReason(catalog, target, options);
          if (target && !rejection) {
            done(target);
            return;
          }
          reset();
          notice = rejection || "Selection is no longer available; choose again.";
        } else if (focus === 5) {
          refresh();
          if (!catalog.entries.some((item) => item.provider === provider)) provider = "";
          reset();
        }
      } else return;
      input.focused = focused && focus === 0 && !details;
      requestRender();
    },
    invalidate() {
      input.invalidate();
    },
  };
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
