import {
  sliceByColumn,
  truncateToWidth,
  visibleWidth,
  type Component,
} from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { ChildSnapshot } from "./coordinator.ts";
import { activity, assignmentHeadline, lineText, statuses, taskTree } from "./task-presentation.ts";

/** Full session totals with an event-driven, bounded active-agent tree; details remain in the Hub. */
export function createChildWidget(
  snapshot: () => ChildSnapshot[],
  theme: Pick<Theme, "fg"> & Partial<Pick<Theme, "bold">>,
  availableRows = () => 30,
): Component {
  return {
    render(width) {
      width = Math.max(0, width);
      const children = snapshot();
      if (!children.length) return [];
      const priority = (child: ChildSnapshot) =>
        child.status === "draining" || child.status === "pausing"
          ? 0
          : child.status === "running"
            ? 1
            : child.status === "setup"
              ? 2
              : 3;
      const live = children
        .filter(
          (child) =>
            !child.disposed &&
            (child.status === "setup" ||
              child.status === "running" ||
              child.status === "draining" ||
              child.status === "pausing"),
        )
        .sort((a, b) => priority(a) - priority(b));
      const budget = Math.max(1, Math.min(5, Math.floor(availableRows() / 4)));
      const count = (status: ChildSnapshot["status"]) =>
        children.filter((child) => child.status === status).length;
      const title = `● Subagents ${children.length}`;
      const summary = (parts: string[]) =>
        theme.fg("accent", title) +
        parts
          .map((part) => theme.fg(part.endsWith(" failed") ? "error" : "muted", " · " + part))
          .join("");
      const all = statuses.flatMap((status) =>
        count(status) ? [`${count(status)} ${status}`] : [],
      );
      // Compact order keeps failures ahead of low-urgency totals; words, not color, carry outcome.
      const compact = [
        `${live.length} active`,
        ...(["failed", "queued", "paused", "cancelled", "settled"] as const).flatMap((status) =>
          count(status) ? [`${count(status)} ${status}`] : [],
        ),
      ];
      const parts =
        (width < 60 && live.length) || visibleWidth([title, ...all].join(" · ")) > width
          ? compact
          : all;
      const rows = [summary(parts)];
      const room = Math.max(0, budget - 1);
      const activityRows = live.length && room >= (live.length > 1 ? 3 : 2) ? 1 : 0;
      const slots = room - activityRows;
      const overflow = live.length > slots;
      const visible = taskTree(live)
        .slice(0, Math.max(0, slots - (overflow ? 1 : 0)))
        .map(({ child }) => child);
      // Close the last visible sibling; the root overflow row represents hidden tasks.
      const shown = taskTree(visible, { laneWidth: 3, rootContinues: overflow });
      const lead = visible[0];
      const nestedUnderLead = (child: ChildSnapshot) =>
        lead &&
        child.parentId === lead.id &&
        (child.parentGeneration ?? child.generation) === lead.generation;
      const hiddenRunning = activityRows
        ? live.filter(
            (child) =>
              nestedUnderLead(child) && child.status === "running" && !visible.includes(child),
          ).length
        : 0;
      shown.forEach(({ child, indent, last, continuation }, index) => {
        const color =
          child.status === "draining" || child.status === "pausing" ? "warning" : "accent";
        const role = lineText(child.profile);
        const prefix =
          theme.fg(
            "muted",
            `${indent}${last && !(hiddenRunning && nestedUnderLead(child)) ? "└─" : "├─"} `,
          ) +
          theme.fg(color, "● ") +
          (theme.bold?.(role) ?? role) +
          " ";
        const elapsed = Math.max(
          0,
          Math.floor(((child.endedAt ?? Date.now()) - child.createdAt) / 1000),
        );
        const stats = [
          child.status,
          `${elapsed}s`,
          `${child.toolCalls} tools`,
          ...(child.telemetry.requests === null ? [] : [`${child.telemetry.requests} req`]),
          ...(child.telemetry.tokens ? [`${child.telemetry.tokens.total} tok`] : []),
          ...(child.telemetry.cost === null ? [] : [`$${child.telemetry.cost.toFixed(3)}`]),
        ].join(" · ");
        const metric = truncateToWidth(stats, Math.max(8, Math.floor(width / 2)));
        const headline = assignmentHeadline(child);
        rows.push(
          prefix +
            theme.fg(
              "text",
              truncateToWidth(
                headline,
                Math.max(4, width - visibleWidth(prefix) - visibleWidth(metric) - 3),
              ),
            ) +
            theme.fg("muted", " · " + metric),
        );
        if (!index && activityRows && !hiddenRunning) {
          const next = shown[index + 1]?.child;
          const hasVisibleChild =
            next?.parentId === child.id &&
            (next.parentGeneration ?? next.generation) === child.generation;
          const prefix = `${continuation}${hasVisibleChild ? "├" : "└"} `;
          const text = lineText(activity(child));
          const columns = Math.max(0, width - visibleWidth(prefix));
          const length = visibleWidth(text);
          // Progress is an accumulated tail; keep its newest text, not a frozen opening paragraph.
          const preview =
            length > columns
              ? "…" +
                sliceByColumn(text, length - Math.max(0, columns - 1), Math.max(0, columns - 1))
              : text;
          rows.push(theme.fg("muted", prefix + preview));
        }
      });
      if (hiddenRunning) {
        rows.push(
          theme.fg(
            "muted",
            `${shown[0].continuation}└─ ${hiddenRunning} more nested subagent${hiddenRunning === 1 ? "" : "s"} running`,
          ),
        );
      }
      if (shown.length < live.length && room)
        rows.push(theme.fg("muted", `└─ ${live.length - shown.length} more · /subagent-hub`));
      // Summary-only output still names where details live, inline or in one budgeted row.
      if (rows.length === 1) {
        if (visibleWidth(rows[0]) + 16 <= width) rows[0] += theme.fg("muted", " · /subagent-hub");
        else if (budget > 1) rows.push(theme.fg("muted", "└─ /subagent-hub for details"));
        else if (width >= 40) {
          // One-row budgets prioritize failure and discovery over secondary state totals.
          const prioritized = [...parts].sort(
            (a, b) => Number(b.endsWith(" failed")) - Number(a.endsWith(" failed")),
          );
          const fitting: string[] = [];
          for (const part of prioritized)
            if (visibleWidth([title, ...fitting, part].join(" · ")) + 16 <= width)
              fitting.push(part);
          rows[0] = summary(fitting) + theme.fg("muted", " · /subagent-hub");
        }
      }
      return rows.slice(0, budget).map((line) => truncateToWidth(line, width));
    },
    invalidate() {},
  };
}
