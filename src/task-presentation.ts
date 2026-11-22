import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { ChildSnapshot, DelegationCoordinator } from "./coordinator.ts";
import { safe } from "./thread.ts";

export const lineText = (text: string) => safe(text).replaceAll("\n", " ");
export const assignmentHeadline = (child: ChildSnapshot) =>
  safe(child.assignment)
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean)
    ?.replace(/^#{1,6}\s+/, "") || "Assignment";
export const agentLabel = (child: ChildSnapshot) =>
  `${assignmentHeadline(child)} · ${lineText(child.profile)}`;
export const deadlineLabel = ({ limits }: ChildSnapshot) =>
  limits.deadlineMs ? `deadline ${limits.deadlineMs}ms per window` : "no deadline";
export const active = (child: ChildSnapshot) => !child.disposed && child.status !== "paused";
const partialKind = (child: ChildSnapshot) =>
  child.status === "paused" ? "paused before a final answer" : "budget wrap-up report";
/** Bounded one-line partial marker; paused windows preview their last assistant text. */
const partialLine = (child: ChildSnapshot) =>
  `Partial: ${partialKind(child)}${child.status === "paused" ? ` · last text: ${child.partialText ? truncateToWidth(lineText(child.partialText), 240, "… [preview truncated]") : "none yet"}` : ""}`;
export const activity = (child: ChildSnapshot) =>
  (child.status === "paused"
    ? `Paused: ${child.pauseReason ?? "deadline"} · context ${child.retainedContext ? "retained" : "not yet available"} · resume via model or stop in Hub`
    : child.error) ||
  (active(child) ? child.activity || child.progress : child.result) ||
  child.progress ||
  "Waiting for SDK activity";

/** Presentation-only preorder, keyed by exact parent generation. */
export function taskTree(children: ChildSnapshot[], { laneWidth = 4, rootContinues = false } = {}) {
  const byIdentity = new Map(children.map((child) => [`${child.id}/${child.generation}`, child]));
  const siblings = new Map<ChildSnapshot | undefined, ChildSnapshot[]>();
  for (const child of children) {
    const candidate = byIdentity.get(
      `${child.parentId}/${child.parentGeneration ?? child.generation}`,
    );
    const parent = candidate && candidate.depth < child.depth ? candidate : undefined;
    const group = siblings.get(parent) ?? [];
    group.push(child);
    siblings.set(parent, group);
  }
  const rows: { child: ChildSnapshot; indent: string; last: boolean; continuation: string }[] = [];
  const visit = (parent: ChildSnapshot | undefined, lanes: string) => {
    const group = siblings.get(parent) ?? [];
    group.forEach((child, index) => {
      const last = index === group.length - 1 && (parent !== undefined || !rootContinues);
      // Missing/filtered ancestors retain depth without inventing continuation pipes.
      const indent = parent
        ? lanes.slice(0, laneWidth * 3)
        : " ".repeat(laneWidth * Math.min(3, Math.max(0, child.depth - 1)));
      const continuation = indent + (last ? " " : "│") + " ".repeat(laneWidth - 1);
      rows.push({ child, indent, last, continuation });
      visit(child, continuation);
    });
  };
  visit(undefined, "");
  return rows;
}

export const statuses = [
  "queued",
  "setup",
  "running",
  "draining",
  "pausing",
  "paused",
  "settled",
  "failed",
  "cancelled",
] as const;
export function fleetSummary(children: ChildSnapshot[]): string {
  return children.length
    ? statuses
        .map((status) => `${status} ${children.filter((child) => child.status === status).length}`)
        .join(" · ")
    : "No tasks · ask the model to delegate_task";
}

/** Pi footer token thresholds; the SDK does not export its formatter. */
const compactTokens = (count: number) =>
  count < 1000
    ? `${count}`
    : count < 10_000
      ? `${(count / 1000).toFixed(1)}k`
      : count < 1_000_000
        ? `${Math.round(count / 1000)}k`
        : count < 10_000_000
          ? `${(count / 1_000_000).toFixed(1)}M`
          : `${Math.round(count / 1_000_000)}M`;

/**
 * Pi-style status row for one generation: direct usage left, model/effort right-aligned.
 * Unknown or zero usage is omitted. When width is short, model/effort outrank usage, and whole usage
 * parts are dropped (cache, then token, then cost, then context) so no number is cut mid-value.
 */
export function statusLine(
  child: ChildSnapshot | undefined,
  width: number,
  fg: (color: "dim" | "warning" | "error", text: string) => string,
): string {
  if (!child || width <= 0) return "";
  const id = lineText(child.model.id);
  const effort = `effort ${lineText(child.effort ?? "unavailable")}`;
  let right = `${lineText(child.model.provider)}/${id} · ${effort}`;
  if (visibleWidth(right) > width) right = truncateToWidth(`${id} · ${effort}`, width, "…");
  const { tokens, cost, costIncomplete, context } = child.telemetry;
  const percent = context?.percent ?? null;
  // Display order matches Pi's footer; `drop` is the order parts yield under width pressure.
  type Part = { text: string; drop: number; color: "dim" | "warning" | "error" };
  let parts: Part[] = [];
  const counts = tokens
    ? ([
        ["↑", tokens.input, 2],
        ["↓", tokens.output, 3],
        ["R", tokens.cacheRead, 0],
        ["W", tokens.cacheWrite, 1],
      ] as const)
    : [];
  for (const [label, count, drop] of counts)
    if (count > 0) parts.push({ text: label + compactTokens(count), drop, color: "dim" });
  if (cost !== null && (cost > 0 || costIncomplete))
    parts.push({ text: `${costIncomplete ? "≥" : ""}$${cost.toFixed(3)}`, drop: 4, color: "dim" });
  if (context)
    parts.push({
      text: `${percent === null ? "?" : percent.toFixed(1) + "%"}/${compactTokens(context.contextWindow)}`,
      drop: 5,
      color: (percent ?? 0) > 90 ? "error" : (percent ?? 0) > 70 ? "warning" : "dim",
    });
  const available = width - visibleWidth(right) - 2;
  const plainWidth = () => visibleWidth(parts.map((part) => part.text).join(" "));
  while (parts.length && plainWidth() > available)
    parts = parts.filter((part) => part.drop !== Math.min(...parts.map(({ drop }) => drop)));
  const left = parts.map((part) => fg(part.color, part.text)).join(fg("dim", " "));
  return left + " ".repeat(width - visibleWidth(left) - visibleWidth(right)) + fg("dim", right);
}

export function taskCard(child: ChildSnapshot | undefined, expanded = false): string[] {
  if (!child)
    return [
      "Task identity unavailable",
      "See tool error; /subagent-hub lists current runtime tasks",
    ];
  const headline = `${truncateToWidth(assignmentHeadline(child), 240, "… [preview truncated]")} · ${lineText(child.profile)} #${child.generation} · ${child.status}`;
  if (!expanded)
    return [
      headline,
      ...(child.status === "paused"
        ? [
            `Pause: ${truncateToWidth(lineText(child.pauseReason ?? "deadline"), 240, "… [preview truncated]")}`,
          ]
        : child.error
          ? [`Error: ${truncateToWidth(lineText(child.error), 240, "… [preview truncated]")}`]
          : []),
      ...(child.partial ? [partialLine(child)] : []),
    ].map(lineText);
  return [
    headline,
    `Identity ${child.id} #${child.generation}`,
    `${child.model.provider}/${child.model.id} · effort ${child.effort ?? "unavailable"}`,
    truncateToWidth(lineText(activity(child)), 240, "… [preview truncated]"),
    `Prewalk ${child.prewalk ? JSON.stringify(child.prewalk) : "off"} · advisor unavailable`,
    ...(child.fallback
      ? [
          `Fallback ${child.fallback.exhausted ? "exhausted" : `target ${child.fallback.index + 1}/${child.fallback.chain.length}`} · failures ${child.fallback.failures} · attempts ${child.fallback.attempts.length} · skipped ${child.fallback.skipped.length}`,
        ]
      : []),
    `Parent ${child.parentId}${child.parentGeneration ? ` #${child.parentGeneration}` : ""} · depth ${child.depth}`,
    ...(child.outcome
      ? [
          `Structured ${child.outcome.validation} · ${child.outcome.finalized ? "finalized" : "provisional"} · attempts ${child.outcome.attempts}`,
        ]
      : []),
    ...(child.limitReason ? [`Limit: ${child.limitReason}`] : []),
    ...(child.pauseReason
      ? [
          `Pause: ${child.pauseReason} · context ${child.retainedContext ? "retained" : "not yet available"} · resume via model control after drain`,
        ]
      : []),
    ...(child.partial ? [partialLine(child)] : []),
    `Window ${child.window ?? 1} · requests ${(child.telemetry.requests ?? 0) - (child.windowStart?.requests ?? 0)}/${child.limits.requests} · tools ${child.toolCalls - (child.windowStart?.toolCalls ?? 0)}/${child.limits.tools} · ${deadlineLabel(child)} · cumulative requests ${child.telemetry.requests ?? 0} · tools ${child.toolCalls} · spawns ${child.spawned ?? 0}/${child.limits.spawns}`,
    ...(child.artifacts ? [`Artifacts: ${JSON.stringify(child.artifacts)}`] : []),
    "Assignment: " + truncateToWidth(lineText(child.assignment), 480, "… [preview truncated]"),
    "Result: " +
      truncateToWidth(
        lineText(child.result || child.error || "Not available yet"),
        480,
        "… [preview truncated]",
      ),
    child.transcript
      ? `Full transcript: ${child.transcript} · /subagent-hub`
      : "Transcript unavailable (setup) · /subagent-hub",
  ].map(lineText);
}

/** Read-only content projection: never dumps provider/auth objects, image payloads or opaque signatures. */
export function transcriptLines(
  messages: ReturnType<DelegationCoordinator["messages"]>,
  toolsOnly = false,
): string[] {
  const lines: string[] = [];
  for (const message of messages) {
    if (message.role === "system") continue;
    const start = lines.length;
    const blocks = "content" in message ? message.content : undefined;
    if (!toolsOnly || message.role === "toolResult") {
      lines.push(
        `[${message.role}${message.role === "toolResult" ? ` ${message.toolName} ${message.toolCallId} ${message.isError ? "ERROR" : "result"}` : ""}]`,
      );
      if (typeof blocks === "string") lines.push(safe(blocks));
    }
    if (Array.isArray(blocks))
      for (const block of blocks) {
        if (block.type === "toolCall")
          lines.push(
            `Tool ${block.name} ${block.id}\nArguments: ${safe(JSON.stringify(block.arguments, null, 2))}`,
          );
        else if (!toolsOnly || message.role === "toolResult") {
          if (block.type === "text") lines.push(safe(block.text));
          else if (block.type === "thinking") lines.push("Thinking: " + safe(block.thinking));
          else if (block.type === "image")
            lines.push(`[image ${safe(block.mimeType)}; payload omitted]`);
        }
      }
    if (message.role === "assistant" && message.errorMessage)
      lines.push("Error: " + safe(message.errorMessage));
    if (start && lines.length > start) lines.splice(start, 0, "");
  }
  return lines.length
    ? lines.map(safe)
    : [toolsOnly ? "No tool calls yet" : "Waiting for SDK messages"];
}

export function taskDetails(
  child: ChildSnapshot,
  presence: ReturnType<DelegationCoordinator["agents"]>[number]["presence"],
): string[] {
  const metric = (value: unknown) =>
    value === null || value === undefined ? "unavailable" : JSON.stringify(value);
  return [
    `Identity ${child.id} #${child.generation}`,
    "",
    "Assignment",
    safe(child.assignment),
    "",
    "Result",
    safe(child.result || "Not available yet"),
    "",
    ...(child.partial
      ? [
          `Partial (${partialKind(child)})`,
          ...(child.status === "paused"
            ? [safe(child.partialText || "No assistant text yet")]
            : []),
          "",
        ]
      : []),
    ...(child.error ? ["Error", safe(child.error), ""] : []),
    ...(child.outcome ? ["Structured outcome", JSON.stringify(child.outcome, null, 2), ""] : []),
    ...(child.artifacts ? ["Saved artifacts", JSON.stringify(child.artifacts, null, 2), ""] : []),
    `Workspace: ${safe(child.cwd ?? "parent workspace")}`,
    `Effective builtin tools: ${child.tools.join(", ")}`,
    `${child.model.provider}/${child.model.id} · effort ${child.effort ?? "unavailable"}`,
    `Prewalk ${child.prewalk ? JSON.stringify(child.prewalk) : "off"} · advisor unavailable`,
    ...(child.fallback ? [`Fallback ${JSON.stringify(child.fallback)}`] : []),
    `Presence ${presence ?? "historical"} · resources ${child.disposed ? "disposed" : child.status === "paused" ? "idle SDK; context retained; model resume required" : "live"}`,
    `Elapsed ${Math.max(0, Math.floor(((child.endedAt ?? Date.now()) - child.createdAt) / 1000))}s`,
    `Direct requests ${metric(child.telemetry.requests)} · cost ${metric(child.telemetry.cost)}${child.telemetry.costIncomplete ? " (known subtotal; failed usage unknown)" : ""}`,
    `Direct tokens ${metric(child.telemetry.tokens)}`,
    `Context ${metric(child.telemetry.context)}`,
    `Parent ${child.parentId} #${child.parentGeneration ?? "root"} · depth ${child.depth} · direct generation only`,
    `Limits ${JSON.stringify(child.limits)} · ${deadlineLabel(child)} · calls ${child.toolCalls} · reason ${child.limitReason ?? "none"}`,
    "Activity: " + safe(activity(child)),
    "Full transcript: " + safe(child.transcript ?? "unavailable (queued/setup)"),
    "Followup/revive: native delegate_coordinate only (Hub has no tool dispatcher)",
  ];
}
