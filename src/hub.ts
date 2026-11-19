import {
  colorToOklch,
  Input,
  matchesKey,
  oklchColor,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
  type Focusable,
  type KeybindingsManager,
} from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { ChildRef, ChildSnapshot, DelegationCoordinator } from "./coordinator.ts";
import {
  createNativeThread,
  safe,
  type LiveTool,
  type ThreadDependencies,
  type ThreadAnchor,
} from "./thread.ts";
export { safe } from "./thread.ts";
export { createChildWidget } from "./subagent-widget.ts";
export { agentLabel, fleetSummary, taskCard, transcriptLines } from "./task-presentation.ts";
import {
  agentLabel,
  assignmentHeadline,
  lineText,
  taskDetails,
  taskTree,
  transcriptLines,
} from "./task-presentation.ts";

/** Greedy " · " packing so every named control survives narrow widths as whole tokens. */
function packHints(tokens: string[], width: number) {
  const lines: string[] = [];
  for (const token of tokens) {
    const last = lines.at(-1);
    if (last !== undefined && visibleWidth(last) + 3 + visibleWidth(token) <= width)
      lines[lines.length - 1] = `${last} · ${token}`;
    else lines.push(...wrapTextWithAnsi(token, Math.max(1, width)));
  }
  return lines;
}

type Palette = Pick<Theme, "fg" | "style"> & { colors: Pick<Theme["colors"], "customMessageBg"> };
/** Observation only: closing or disposing never touches child execution. */
export function createHub(
  coordinator: DelegationCoordinator,
  theme: Palette,
  keybindings: Pick<KeybindingsManager, "matches" | "getKeys">,
  requestRender: () => void,
  done: () => void,
  dependencies: ThreadDependencies,
  availableRows = () => 24,
): Component & Focusable & { dispose(): void } {
  let selected: string | undefined;
  let query = "";
  let interactionTarget: ChildRef | undefined;
  let interactionLabel = "";
  let interactionVisibleAtHeight: number | undefined;
  let mode: "browse" | "search" | "steer" | "message" | "stop" = "browse";
  let tab: "thread" | "details" | "tools" = "thread";
  let offset = 0;
  let following = true;
  let toolsExpanded = false;
  let expansionAnchor: ThreadAnchor | undefined;
  let maxOffset = 0;
  let threadBounds: { x: number; y: number; width: number; height: number } | undefined;
  let viewport = 1;
  let notice = "";
  // Observation-only overlay: browse state underneath stays untouched until explicit return.
  let help: { offset: number } | undefined;
  let disposed = false;
  const input = new Input();
  const nativeThread = createNativeThread(dependencies);
  const refresh = () => {
    if (!disposed) requestRender();
  };
  // Live projections are separate from the selected generation's detached transcript read.
  const streaming = new Map<string, ReturnType<DelegationCoordinator["messages"]>[number]>();
  const liveTools = new Map<string, LiveTool>();
  let rosterCache:
    | {
        query: string;
        tree: ReturnType<typeof taskTree>;
        children: ChildSnapshot[];
        current: Set<string>;
        total: number;
      }
    | undefined;
  let transcript:
    | {
        ref: string;
        messages: ReturnType<DelegationCoordinator["messages"]>;
        width?: number;
        lines?: string[];
      }
    | undefined;
  const unsubscribe = coordinator.subscribe((event) => {
    rosterCache = undefined;
    // Streaming objects are mutable SDK state, not stable finalized transcript identities.
    if (transcript?.ref === identity(event.child)) transcript = undefined;
    if (event.event?.type === "message_update")
      streaming.set(identity(event.child), event.event.message);
    if (event.event?.type === "message_end" || event.child.disposed)
      streaming.delete(identity(event.child));
    const sdk = event.event;
    if (sdk?.type === "tool_execution_start" || sdk?.type === "tool_execution_update") {
      liveTools.set(identity(event.child), {
        toolName: sdk.toolName,
        toolCallId: sdk.toolCallId,
        args: sdk.args,
        ...(sdk.type === "tool_execution_update" ? { content: sdk.partialResult.content } : {}),
      });
    }
    if (sdk?.type === "tool_execution_end" || event.child.disposed)
      liveTools.delete(identity(event.child));
    refresh();
  });
  const identity = (ref: ChildRef) => `${ref.id}/${ref.generation}`;
  const roster = () => {
    if (!rosterCache || rosterCache.query !== query) {
      const sessions = coordinator.sessions();
      const normalizedQuery = query.toLowerCase();
      const filtered = normalizedQuery
        ? sessions.filter((child) =>
            lineText(
              [
                child.id,
                child.parentId,
                child.profile,
                child.status,
                child.assignment,
                child.progress,
                child.result,
                child.error,
                child.model.id,
              ].join(" "),
            )
              .toLowerCase()
              .includes(normalizedQuery),
          )
        : sessions;
      const tree = taskTree(filtered);
      rosterCache = {
        query,
        tree,
        children: tree.map(({ child }) => child),
        current: new Set(coordinator.list().map(identity)),
        total: sessions.length,
      };
    }
    return rosterCache;
  };
  const selection = () => {
    const children = roster().children;
    if (!children.some((child) => identity(child) === selected)) {
      selected = children[0] && identity(children[0]);
      expansionAnchor = undefined;
      offset = 0;
      following = tab === "thread";
    }
    return children.find((child) => identity(child) === selected);
  };
  const scrollBy = (delta: number) => {
    expansionAnchor = undefined;
    offset = Math.max(0, Math.min(maxOffset, offset + delta));
    if (tab === "thread") following = delta > 0 && offset === maxOffset;
    refresh();
  };
  // Captured when a control opens: later selection, filtering or generations never retarget it.
  const describe = (child: ChildSnapshot) =>
    `${child.id} #${child.generation} · ${truncateToWidth(lineText(agentLabel(child)), 32)}`;
  const control = async (target: ChildRef, who: string, text?: string, message = false) => {
    const action = text === undefined ? "Stop" : message ? "Inbox" : "Steer";
    notice = `${action} ${who}: ${text === undefined ? "stopping and draining…" : "sending…"}`;
    refresh();
    try {
      const child = coordinator.snapshot(target);
      if (
        !child ||
        child.disposed ||
        child.status === "draining" ||
        child.status === "pausing" ||
        (text !== undefined && child.status !== "running")
      )
        throw new Error(
          `Target ${target.id} #${target.generation} is no longer running; no action sent`,
        );
      if (text === undefined) {
        await coordinator.stop(target);
        notice = `Stop ${who}: stopped and drained`;
      } else if (message) {
        const receipt = await coordinator.message(undefined, target, text);
        notice = `Inbox ${who}: message ${receipt.id} · ${receipt.status} · NOT model acknowledgment${receipt.error ? ` · ${receipt.error}` : ""}`;
      } else
        notice = `Steer ${who}: ${await coordinator.steer(target, text)} · NOT model acknowledgment`;
    } catch (error) {
      notice = `${action} ${who} failed: ${String(error)}`;
    }
    refresh();
  };
  const observeControl = async (target: ChildRef, who: string, action: "wait" | "park") => {
    try {
      if (action === "park") {
        coordinator.park(target);
        notice = `Park ${who}: parked (session already disposed)`;
      } else {
        notice = `Wait ${who}: waiting up to 1000ms (not model acknowledgment)…`;
        refresh();
        notice = `Wait ${who}: ${JSON.stringify(await coordinator.coordinateWait(undefined, target, 1000))}`;
      }
    } catch (error) {
      notice = `${action === "park" ? "Park" : "Wait"} ${who} failed: ${String(error)}`;
    }
    refresh();
  };
  const bindingHint = (action: Parameters<typeof keybindings.getKeys>[0]) =>
    keybindings
      .getKeys(action)
      .map((key) => key.replaceAll("escape", "Esc").replaceAll("enter", "Enter"))
      .join("/") || "unbound";
  const canSubmitInteraction = () => {
    if (interactionVisibleAtHeight === Math.max(1, availableRows())) return true;
    notice = `Resize for controls · ${bindingHint("tui.select.cancel")} cancels; no action sent`;
    refresh();
    return false;
  };
  const steerable = (child: ChildSnapshot) => !child.disposed && child.status === "running";
  const finishInput = () => {
    if (mode === "steer" && interactionTarget) {
      if (!lineText(input.getValue()).trim()) {
        notice = `Nothing to send · type a message or ${bindingHint("tui.select.cancel")} to go back`;
        refresh();
        return;
      }
      // Keep the draft when the pinned target can no longer be steered; nothing was sent.
      let reason: string | undefined;
      try {
        const current = coordinator.snapshot(interactionTarget);
        if (!current || !steerable(current)) reason = "target is no longer running";
      } catch (error) {
        reason = String(error);
      }
      if (reason) {
        notice = `Steer ${interactionLabel}: ${reason}; no action sent · ${bindingHint("tui.select.cancel")} discards the draft`;
        refresh();
        return;
      }
    }
    if (interactionTarget && !canSubmitInteraction()) return;
    if (mode === "search") {
      query = lineText(input.getValue());
      offset = 0;
      following = tab === "thread";
    } else if ((mode === "steer" || mode === "message") && interactionTarget)
      void control(interactionTarget, interactionLabel, input.getValue(), mode === "message");
    interactionTarget = undefined;
    mode = "browse";
    input.setValue("");
    refresh();
  };
  return {
    focused: false,
    render(width) {
      interactionVisibleAtHeight = undefined;
      threadBounds = undefined;
      width = Math.max(0, width);
      const height = Math.max(1, availableRows());
      const child = selection();
      const panelBg = oklchColor(colorToOklch(theme.colors.customMessageBg).l, 0, 0);
      const paint = (text: string) => {
        const clipped = truncateToWidth(text, width);
        const padded = clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
        const restoreBg = theme.style("", { bg: panelBg }).replace(/\x1b\[49m$/, "");
        return padded
          .split("\x1b[0m")
          .map((part) => theme.style(part.replaceAll("\x1b[49m", restoreBg), { bg: panelBg }))
          .join("\x1b[0m");
      };
      if (width < 4 || height < 3)
        return [
          paint(
            interactionTarget
              ? `Resize · ${bindingHint("tui.select.cancel")} cancels`
              : "Subagent Hub " + roster().total,
          ),
        ];
      const inner = Math.max(0, width - 4);
      const row = (text: string) => {
        const clipped = truncateToWidth(text, inner);
        return paint(
          theme.fg("border", "│") +
            " " +
            clipped +
            " ".repeat(Math.max(1, width - 3 - visibleWidth(clipped))) +
            theme.fg("border", "│"),
        );
      };
      const frame = (left: string, title: string, right: string) => {
        const text = truncateToWidth(title, width - 2);
        return paint(
          theme.fg("border", left) +
            theme.fg("accent", text) +
            theme.fg("border", "─".repeat(Math.max(0, width - 2 - visibleWidth(text))) + right),
        );
      };
      const children = roster().children;
      const historical = (item: ChildRef) => !roster().current.has(identity(item));
      const index = children.findIndex((item) => identity(item) === selected);
      const wide = width >= 76;
      const leftWidth = wide ? Math.min(32, Math.max(24, Math.floor(inner / 3))) : 0;
      const threadWidth = wide ? inner - leftWidth - 3 : inner;
      const close = keybindings.getKeys("tui.select.cancel").join("/");
      const keyNames = (action: Parameters<typeof keybindings.getKeys>[0]) =>
        keybindings.getKeys(action).join("/") || "unbound";
      const footer: string[] = [];
      const noticeLines: string[] = [];
      if (query)
        footer.push(
          theme.fg("muted", `Filter: ${lineText(query)} · ${children.length} generations`),
        );
      if (notice) {
        const lines = wrapTextWithAnsi(lineText(notice), Math.max(1, inner));
        noticeLines.push(
          ...lines
            .slice(0, 3)
            .map((line, index) =>
              theme.fg(
                "warning",
                index === 2 && lines.length > 3
                  ? truncateToWidth(line, Math.max(0, inner - 19)) + " [notice truncated]"
                  : line,
              ),
            ),
        );
      }
      if (help) {
        // Rendering help never touches browse offsets, selection or reading anchors.
        const body = [
          "HELP · observation only; keys here never send an action",
          `${keyNames("tui.select.up")} / ${keyNames("tui.select.down")}  Select task or generation`,
          "j / k  Scroll one line",
          `Ctrl+u/d, ${keyNames("tui.select.pageUp")} / ${keyNames("tui.select.pageDown")}  Scroll a page`,
          "Home / End  Top / follow the live thread",
          "Tab  Next view: thread → details → tools",
          `/  Filter tasks; ${keyNames("tui.select.cancel")} keeps the previous filter`,
          `${keyNames("tui.select.confirm")}  Steer the selected running task in the composer (pinned target)`,
          "m  Inbox message; a receipt is not model acknowledgment",
          "x, then y  Stop subtree; reported after drain; Enter never confirms",
          "w  Wait up to 1000ms for an outcome",
          "p  Park a disposed idle task",
          `${keyNames("app.tools.expand")}  Toggle all tool output (thread view)`,
          `${close || "unbound"}  Close the Hub; tasks keep running`,
        ].flatMap((line) => wrapTextWithAnsi(line, Math.max(1, inner)));
        const footerBudget = Math.max(1, Math.min(4, height - 5));
        const shown = [
          ...(noticeLines.length < footerBudget ? noticeLines : []),
          `? or ${keyNames("tui.select.cancel")}: back to Hub`,
        ];
        if (query && shown.length < footerBudget) shown.unshift(...footer);
        const bodyRows = Math.max(0, height - 3 - shown.length);
        help.offset = Math.max(0, Math.min(help.offset, body.length - bodyRows));
        if (body.length > bodyRows) shown[shown.length - 1] += " · j/k scroll";
        return [
          frame("╭", " Subagent Hub · Help ", "╮"),
          ...body
            .slice(help.offset, help.offset + bodyRows)
            .map((line) => row(theme.fg("text", line))),
          ...Array(Math.max(0, bodyRows - (body.length - help.offset))).fill(row("")),
          ...(height > 3 ? [paint(theme.fg("border", "├" + "─".repeat(width - 2) + "┤"))] : []),
          ...shown.map(row),
          frame("╰", "", "╯"),
        ].slice(0, height);
      }
      const targetLines = interactionTarget
        ? wrapTextWithAnsi(
            `Target: ${interactionTarget.id} #${interactionTarget.generation}`,
            Math.max(1, inner),
          )
        : [];
      if (interactionTarget && (inner < 26 || height < targetLines.length + 6)) {
        return [
          frame("╭", ` Resize / ${bindingHint("tui.select.cancel")} cancel `, "╮"),
          ...targetLines.slice(0, height - 3).map(row),
          row(`Resize for controls · ${bindingHint("tui.select.cancel")} cancels`),
          frame("╰", "", "╯"),
        ];
      }
      footer.push(...targetLines.map((line) => theme.fg("accent", line)));
      if (mode === "search" || mode === "steer" || mode === "message") {
        input.focused = this.focused;
        const label = mode === "search" ? "Filter: " : "Inbox: ";
        // Steering text is edited in the thread-column composer, not the footer.
        if (mode !== "steer")
          footer.push(label + input.render(Math.max(1, inner - visibleWidth(label)))[0]);
        footer.push(
          `${bindingHint("tui.select.confirm")} ${mode === "search" ? "apply filter" : "send"} · ${bindingHint("tui.select.cancel")} back (no action)`,
        );
      } else if (mode === "stop")
        footer.push(
          `Stop target? y confirms · ${bindingHint("tui.select.cancel")} back`,
          "Enter does not confirm stop",
        );
      else {
        const next = tab === "thread" ? "Details" : tab === "details" ? "Tools" : "Thread";
        footer.push(
          ...packHints(
            [
              ...(wide
                ? [
                    `${keyNames("tui.select.up")}/${keyNames("tui.select.down")} agents`,
                    "j/k line",
                    `Ctrl+u/d ${keyNames("tui.select.pageUp")}/${keyNames("tui.select.pageDown")} page`,
                  ]
                : [
                    `${keyNames("tui.select.up")}/${keyNames("tui.select.down")} agent`,
                    "j/k scroll",
                    "End live",
                  ]),
              `${keyNames("tui.select.confirm")} Steer`,
              "m Inbox",
              "x Stop",
              ...(wide ? ["w Wait", "p Park"] : []),
              "/ Filter",
              `Tab ${next}`,
              "? Help",
              `${close || "unbound"}: close`,
            ],
            inner,
          ),
        );
      }
      if (mode === "browse" && tab === "thread")
        footer.push(
          `Tools ${toolsExpanded ? "expanded" : "collapsed"} · ${keybindings.getKeys("app.tools.expand").join("/") || "unbound"}: toggle all`,
        );
      // Targets, controls and notices are indivisible; optional hints must yield first.
      const requiredFooter = interactionTarget
        ? targetLines.length + (mode === "steer" ? 1 : 2)
        : 0;
      const footerBudget =
        requiredFooter || height >= 8 ? Math.max(2, height - 7, requiredFooter) : 0;
      const shownNotice = noticeLines.length <= footerBudget - requiredFooter ? noticeLines : [];
      const optionalBudget = footerBudget - shownNotice.length;
      const shownFooter = [
        ...shownNotice,
        ...(optionalBudget ? footer.slice(-optionalBudget) : []),
      ];
      const separatorRows = shownFooter.length ? 1 : 0;
      const paneHeight = Math.max(1, height - 2 - shownFooter.length - separatorRows);
      // A focused composer outranks reading rows; idle hints need room for a reading line.
      const composerRows = mode === "steer" || paneHeight >= 4 ? 1 : 0;
      if (interactionTarget) interactionVisibleAtHeight = height;
      viewport = Math.max(1, paneHeight - 3 - composerRows);
      let detail: string[] = [];
      let nativeLines: string[] | undefined;
      if (child) {
        if (tab === "details") {
          detail = taskDetails(
            child,
            coordinator
              .agents()
              .find((agent) => agent.id === child.id && agent.generation === child.generation)
              ?.presence,
          );
        } else {
          try {
            const ref = identity(child);
            if (transcript?.ref !== ref)
              transcript = { ref, messages: coordinator.messages(child) };
            const messages = transcript.messages;
            const partial = streaming.get(identity(child));
            if (
              tab === "thread" &&
              (messages.length || partial || liveTools.has(identity(child)))
            ) {
              const live = liveTools.get(ref);
              // These messages are our detached read, never SDK objects or caller-owned inputs.
              // Live/custom components can change independently and must still be visited.
              if (
                !transcript.lines ||
                transcript.width !== threadWidth ||
                partial ||
                live ||
                nativeThread.hasCustomRenderers()
              ) {
                transcript.lines = nativeThread.render(ref, messages, partial, live, threadWidth);
                transcript.width = threadWidth;
              }
              nativeLines = transcript.lines;
            } else
              detail =
                messages.length || partial
                  ? [
                      ...transcriptLines(partial ? [...messages, partial] : messages, true),
                      ...(liveTools.get(identity(child))
                        ? [
                            "Live tool: " + liveTools.get(identity(child))!.toolName,
                            "Arguments: " +
                              JSON.stringify(liveTools.get(identity(child))!.args, null, 2),
                            ...(liveTools.get(identity(child))!.content ?? []).flatMap((block) =>
                              block.type === "text" ? [block.text ?? ""] : [],
                            ),
                          ]
                        : []),
                    ]
                  : [
                      child.error ||
                        child.result ||
                        (child.status === "queued"
                          ? "Queued · no SDK messages yet"
                          : "Waiting for SDK messages"),
                    ];
          } catch (error) {
            detail = ["Transcript unavailable: " + safe(String(error))];
          }
        }
      } else
        detail = [
          query
            ? "No matching tasks · / to change filter"
            : "No tasks · ask the model to delegate_task",
        ];
      const wrapped =
        nativeLines ??
        detail.flatMap((text) =>
          safe(text)
            .split("\n")
            .flatMap((line) => wrapTextWithAnsi(line, Math.max(1, threadWidth))),
        );
      if (tab === "thread" && expansionAnchor) {
        offset = nativeThread.offsetFor(expansionAnchor) ?? offset;
        expansionAnchor = undefined;
      }
      maxOffset = Math.max(0, wrapped.length - viewport);
      offset = tab === "thread" && following ? maxOffset : Math.max(0, Math.min(offset, maxOffset));
      threadBounds = {
        x: wide ? 2 + leftWidth + 3 : 2,
        y: 3,
        width: threadWidth,
        height: Math.max(0, paneHeight - 3 - composerRows),
      };
      const content = wrapped
        .slice(offset, offset + viewport)
        .map((line) => (nativeLines ? line : theme.fg("text", line)));
      const statusColor = (item: ChildSnapshot): "error" | "warning" | "success" | "accent" =>
        item.status === "failed"
          ? "error"
          : item.status === "cancelled"
            ? "warning"
            : item.status === "settled"
              ? "success"
              : "accent";
      const selectedLabel = child
        ? `${agentLabel(child)} · ${child.status}${historical(child) ? " · history" : ""}`
        : "No selection";
      const viewLabel = `${tab.toUpperCase()} · Tab: ${tab === "thread" ? "details" : tab === "details" ? "tools" : "thread"}`;
      const position = `${tab === "thread" ? (following ? "LIVE · " : "READING · ") : ""}${offset + 1}–${Math.min(wrapped.length, offset + viewport)}/${wrapped.length} lines${tab === "thread" ? (following ? " · k/PgUp read" : " · End: live") : offset < maxOffset ? " · more ↓" : ""}`;
      // The native Input renders its own "> " prompt after this label.
      const composerLabel = "Steer ";
      const composer =
        mode === "steer" && interactionTarget
          ? theme.fg("accent", composerLabel) +
            input.render(Math.max(1, threadWidth - visibleWidth(composerLabel)))[0]
          : theme.fg(
              "muted",
              "Steer · " +
                (!child
                  ? "no task selected"
                  : steerable(child)
                    ? `${bindingHint("tui.select.confirm")} to compose a message for this task`
                    : `unavailable · ${child.disposed ? "ended" : child.status}${historical(child) ? " · history" : ""}`),
            );
      const pane: string[] = [];
      if (wide) {
        const slots = Math.max(1, Math.floor((paneHeight - 2) / 2));
        const start = Math.max(0, index - slots + 1);
        const left = [
          theme.fg("accent", `SUBAGENTS · ${children.length} generations`),
          ...roster()
            .tree.slice(start, start + slots)
            .flatMap(({ child: item, indent, last, continuation }) => {
              const prefix = `${identity(item) === selected ? ">" : " "} ${indent}${last ? "└" : "├"} `;
              return [
                theme.fg(identity(item) === selected ? "accent" : "text", prefix[0]) +
                  theme.fg("text", prefix.slice(1)) +
                  theme.fg(statusColor(item), "● ") +
                  theme.fg(
                    identity(item) === selected ? "accent" : "text",
                    `${assignmentHeadline(item)}${historical(item) ? " · history" : ""}`,
                  ),
                theme.fg("text", `  ${continuation}`) +
                  theme.fg(statusColor(item), lineText(item.profile)) +
                  theme.fg("text", ` · ${item.status}`),
              ];
            }),
        ];
        const right = [
          theme.fg("accent", lineText(selectedLabel)),
          theme.fg("muted", viewLabel),
          ...content,
        ];
        const cell = (text: string, columns: number) => {
          const clipped = truncateToWidth(text, columns);
          return clipped + " ".repeat(Math.max(0, columns - visibleWidth(clipped)));
        };
        for (let index = 0; index < paneHeight; index++)
          pane.push(
            cell(
              index === paneHeight - 1
                ? theme.fg(
                    "muted",
                    `${children.length ? start + 1 : 0}–${Math.min(children.length, start + slots)}/${children.length} · ↑↓ select`,
                  )
                : (left[index] ?? ""),
              leftWidth,
            ) +
              theme.fg("border", " │ ") +
              cell(
                composerRows && index === paneHeight - 1
                  ? composer
                  : index === paneHeight - 1 - composerRows
                    ? theme.fg("muted", position)
                    : (right[index] ?? ""),
                threadWidth,
              ),
          );
      } else {
        const suffix = child ? ` · ${index + 1}/${children.length}` : "";
        pane.push(
          child
            ? theme.fg("accent", ">") +
                theme.fg("text", " └ ") +
                theme.fg(statusColor(child), "● ") +
                theme.fg(
                  "accent",
                  `${truncateToWidth(agentLabel(child), Math.max(0, inner - 6 - visibleWidth(suffix)))}${suffix}`,
                )
            : theme.fg("accent", "No selection"),
        );
        if (paneHeight > 1)
          pane.push(
            child
              ? theme.fg("text", `${tab.toUpperCase()} · `) +
                  theme.fg(statusColor(child), lineText(child.profile)) +
                  theme.fg("text", ` · ${child.status}`)
              : theme.fg("muted", tab.toUpperCase()),
          );
        if (paneHeight > 2)
          pane.push(
            ...content.slice(0, Math.max(0, paneHeight - 3 - composerRows)),
            ...Array(Math.max(0, paneHeight - 3 - composerRows - content.length)).fill(""),
            theme.fg("muted", position),
          );
        if (composerRows) pane.splice(paneHeight - 1, pane.length, composer);
      }
      return [
        frame("╭", " Subagent Hub ", "╮"),
        ...pane.slice(0, height - 2).map(row),
        ...(separatorRows ? [paint(theme.fg("border", "├" + "─".repeat(width - 2) + "┤"))] : []),
        ...shownFooter.map(row),
        frame("╰", "", "╯"),
      ];
    },
    handleInput(data) {
      if (help) {
        // Modal: only explicit return or help scrolling; underlying controls are unreachable.
        if (data === "?" || keybindings.matches(data, "tui.select.cancel")) help = undefined;
        else if (data === "j" || keybindings.matches(data, "tui.select.down")) help.offset++;
        else if (data === "k" || keybindings.matches(data, "tui.select.up"))
          help.offset = Math.max(0, help.offset - 1);
        refresh();
        return;
      }
      if (keybindings.matches(data, "tui.select.cancel")) {
        if (mode !== "browse") {
          mode = "browse";
          interactionTarget = undefined;
          input.setValue("");
          refresh();
        } else done();
        return;
      }
      if (mode === "search" || mode === "steer" || mode === "message") {
        if (keybindings.matches(data, "tui.select.confirm")) finishInput();
        else {
          input.handleInput(data);
          const cleaned = lineText(input.getValue());
          if (cleaned !== input.getValue()) input.setValue(cleaned);
          refresh();
        }
        return;
      }
      if (mode === "stop") {
        if (data === "y") {
          if (interactionTarget && !canSubmitInteraction()) return;
          if (interactionTarget) void control(interactionTarget, interactionLabel);
          interactionTarget = undefined;
          mode = "browse";
        }
        refresh();
        return;
      }
      if (tab === "thread" && keybindings.matches(data, "app.tools.expand")) {
        if (!following) expansionAnchor = nativeThread.anchorAt(offset);
        toolsExpanded = !toolsExpanded;
        nativeThread.setExpanded(toolsExpanded);
        if (transcript) transcript.lines = undefined;
        refresh();
        return;
      }
      if (keybindings.matches(data, "tui.select.confirm")) {
        const child = selection();
        if (child && steerable(child)) {
          mode = "steer";
          interactionTarget = { id: child.id, generation: child.generation };
          interactionLabel = describe(child);
          interactionVisibleAtHeight = undefined;
          input.setValue("");
        } else
          notice = child
            ? "Steering unavailable: historical/disposed target, or task not running"
            : "Select a running task to steer";
        refresh();
        return;
      }
      if (
        keybindings.matches(data, "tui.select.up") ||
        keybindings.matches(data, "tui.select.down")
      ) {
        const children = roster().children;
        const index = children.findIndex((child) => identity(child) === selected);
        const next =
          children[
            Math.max(
              0,
              Math.min(
                children.length - 1,
                index + (keybindings.matches(data, "tui.select.up") ? -1 : 1),
              ),
            )
          ];
        selected = next && identity(next);
        expansionAnchor = undefined;
        offset = 0;
        following = tab === "thread";
      } else if (keybindings.matches(data, "tui.select.pageUp") || matchesKey(data, "ctrl+u"))
        scrollBy(-viewport);
      else if (keybindings.matches(data, "tui.select.pageDown") || matchesKey(data, "ctrl+d"))
        scrollBy(viewport);
      else if (data === "k") scrollBy(-1);
      else if (data === "j") scrollBy(1);
      else if (matchesKey(data, "home")) {
        expansionAnchor = undefined;
        offset = 0;
        following = false;
      } else if (matchesKey(data, "end")) {
        expansionAnchor = undefined;
        offset = maxOffset;
        following = tab === "thread";
      } else if (matchesKey(data, "tab")) {
        expansionAnchor = undefined;
        tab = tab === "thread" ? "details" : tab === "details" ? "tools" : "thread";
        offset = 0;
        following = tab === "thread";
      } else if (data === "?") help = { offset: 0 };
      else if (data === "/") {
        mode = "search";
        input.setValue(query);
        // Native Input.setValue preserves its old cursor; a saved filter starts editing at its end.
        input.handleInput("\x1b[F");
      } else if (["w", "p", "f", "r"].includes(data)) {
        const child = selection();
        if (!child) notice = "Select an identity first";
        else if (data === "w" || data === "p")
          void observeControl(
            { id: child.id, generation: child.generation },
            describe(child),
            data === "w" ? "wait" : "park",
          );
        else {
          notice =
            "Followup/revive: native model-issued delegate_coordinate only. Hub command context has no permission-preserving tool dispatcher; no generation started.";
        }
      } else if (data === "x" || data === "m") {
        const child = selection();
        if (
          child &&
          !child.disposed &&
          child.status !== "draining" &&
          child.status !== "pausing" &&
          (data === "x" || child.status === "running")
        ) {
          mode = data === "m" ? "message" : "stop";
          interactionTarget = { id: child.id, generation: child.generation };
          interactionLabel = describe(child);
          interactionVisibleAtHeight = undefined;
          input.setValue("");
        } else
          notice =
            "Controls unavailable: historical/disposed target, or task not running (stop accepts queued/setup/running)";
      }
      refresh();
    },
    handleMouse(event) {
      if (event.type !== "wheel" || disposed) return;
      // Overlay wheels outside the reading viewport must not fall through to the main chat.
      if (
        mode === "browse" &&
        !help &&
        threadBounds &&
        event.x >= threadBounds.x &&
        event.x < threadBounds.x + threadBounds.width &&
        event.y >= threadBounds.y &&
        event.y < threadBounds.y + threadBounds.height &&
        event.wheelDelta
      )
        scrollBy(event.wheelDelta);
      return { handled: true };
    },
    invalidate() {
      input.invalidate();
      nativeThread.invalidate();
      if (transcript) transcript.lines = undefined;
    },
    dispose() {
      disposed = true;
      help = undefined;
      interactionTarget = undefined;
      unsubscribe();
      streaming.clear();
      liveTools.clear();
      nativeThread.clear();
      transcript = undefined;
      rosterCache = undefined;
    },
  };
}
