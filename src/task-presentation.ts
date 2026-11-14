import { truncateToWidth } from "@earendil-works/pi-tui";
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
export const active = (child: ChildSnapshot) => !child.disposed && child.status !== "paused";
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
    `Window ${child.window ?? 1} · cumulative requests ${child.telemetry.requests ?? 0}/${child.limits.requests} · tools ${child.toolCalls}/${child.limits.tools} · spawns ${child.spawned ?? 0}/${child.limits.spawns}`,
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
    `Limits ${JSON.stringify(child.limits)} · calls ${child.toolCalls} · reason ${child.limitReason ?? "none"}`,
    "Activity: " + safe(activity(child)),
    "Full transcript: " + safe(child.transcript ?? "unavailable (queued/setup)"),
    "Followup/revive: native delegate_coordinate only (Hub has no tool dispatcher)",
  ];
}
