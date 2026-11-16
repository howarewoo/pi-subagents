import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  Input,
  matchesKey,
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
  const rows = () => filterProfileModels(catalog, input.getValue(), provider);
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
  };
  return {
    capturesViewportInput: true,
    get focused() {
      return focused;
    },
    set focused(value) {
      focused = value;
      input.focused = value && focus === 0;
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
      const active = (name: (typeof focuses)[number], text: string) =>
        `${focuses[focus] === name ? "›" : " "} ${text}`;
      const reasonLines = wrapTextWithAnsi(
        safe(reason() ?? "Accessible in this session; profile authorization remains separate."),
        width,
      ).slice(0, 3);
      const resultHeight = Math.max(1, height - 10 - reasonLines.length);
      const start = Math.max(
        0,
        Math.min(selected - Math.floor(resultHeight / 2), list.length - resultHeight),
      );
      const results = list.slice(start, start + resultHeight).map((item, index) => {
        const allDisabled = item.efforts.every((e) =>
          profileModelPickReason(
            catalog,
            { provider: item.provider, id: item.id, effort: e.effort },
            options,
          ),
        );
        return `${start + index === selected ? "›" : " "} ${safe(item.name)} · ${safe(item.providerLabel)}${allDisabled ? " [disabled]" : ""}`;
      });
      if (!results.length)
        results.push(
          ...wrapTextWithAnsi(
            safe(
              catalog.error ??
                (catalog.entries.length
                  ? "No matching models. Change search/provider."
                  : "No accessible physical models in host metadata."),
            ),
            width,
          ).slice(0, resultHeight),
        );
      while (results.length < resultHeight) results.push("");
      const providerLabel =
        catalog.entries.find((item) => item.provider === provider)?.providerLabel ??
        "All providers";
      input.focused = focused && focus === 0;
      return [
        theme.fg("accent", safe(options.title)),
        safe(options.context.join(" · ")),
        ...input.render(width),
        active("provider", `Provider: ${safe(providerLabel)} · ←/→ filter`),
        active("models", `Accessible models · ${list.length} matches · ↑/↓ browse`),
        ...results,
        entry
          ? `ID: ${safe(entry.provider)}/${safe(entry.id)}`
          : "Saved selections are not changed by browsing.",
        active(
          "effort",
          `Effort: ${effort ?? "not chosen"} · ←/→ choose · ${entry?.efforts.map((e) => e.effort).join(" / ") ?? "none"}`,
        ),
        ...reasonLines.map((line) => theme.fg(reason() ? "warning" : "muted", line)),
        active("add", reason() ? "Select [disabled]" : `Select ${effort} (no automatic grants)`),
        active("refresh", "Refresh metadata · host snapshot only, no network refresh"),
        theme.fg("muted", `Tab: focus · Enter: choose · ${cancel}: back`),
      ]
        .slice(0, height)
        .map(paint);
    },
    handleInput(data) {
      if (keys.matches(data, "tui.select.cancel")) {
        done(undefined);
        return;
      }
      if (compact) return;
      if (matchesKey(data, "tab") || matchesKey(data, "shift+tab")) {
        focus = (focus + (matchesKey(data, "shift+tab") ? focuses.length - 1 : 1)) % focuses.length;
      } else if (focus === 0) {
        if (keys.matches(data, "tui.select.confirm")) focus = 2;
        else {
          input.handleInput(data);
          reset();
        }
      } else if (
        focus === 2 &&
        (keys.matches(data, "tui.select.up") || keys.matches(data, "tui.select.down"))
      ) {
        selected = Math.max(
          0,
          Math.min(rows().length - 1, selected + (keys.matches(data, "tui.select.up") ? -1 : 1)),
        );
        effort = undefined;
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
          if (target && !profileModelPickReason(catalog, target, options)) {
            done(target);
            return;
          }
          effort = undefined;
        } else if (focus === 5) {
          refresh();
          if (!catalog.entries.some((item) => item.provider === provider)) provider = "";
          reset();
        }
      } else return;
      input.focused = focused && focus === 0;
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
