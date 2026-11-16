// Regenerate README illustrations: node scripts/render-hub-hero.ts [--profiles | --widget]
// Uses production components with synthetic data, never a provider or a live session.
import { writeFileSync } from "node:fs";
import { stripVTControlCharacters } from "node:util";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { initTheme } from "@earendil-works/pi-coding-agent";
import {
  ProcessTerminal,
  TuiMainScreen,
  oklchColor,
  parseColor,
  styleText,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { DelegationCoordinator, type ChildSnapshot } from "../src/coordinator.ts";
import { createHub } from "../src/hub.ts";
import { createChildWidget } from "../src/subagent-widget.ts";
import { createProfileViewer } from "../src/profile-viewer.ts";
import { bundledProfiles } from "../src/profiles.ts";
import { DEFAULT_POLICY } from "../src/scheduling.ts";

// The SVG converter expects RGB colors, including those from native thread components.
process.env.COLORTERM = "truecolor";
initTheme("dark", false);
// Four read-only leads, each with three foreground descendants, fill all 16 slots.
// Two further root batches of 16 fill the queue. No concurrent writers or extra grants.
const topics = ["Scheduler", "Permissions", "Lifecycle", "Terminal UI"];
const checks = ["Trace admission", "Review edge cases", "Inspect tests"];
const running = topics.flatMap((topic, group) => [
  { assignment: `${topic}: coordinate audit`, profile: "review", parentId: "root", depth: 1 },
  ...checks.map((check, index) => ({
    assignment: `${topic}: ${check.toLowerCase()}`,
    profile: index === 1 ? "review" : "scout",
    parentId: `demo-${group * 4}`,
    depth: DEFAULT_POLICY.depth,
  })),
]);
const queued = Array.from({ length: DEFAULT_POLICY.queue }, (_, index) => ({
  assignment: `${topics[index % topics.length]}: follow-up ${Math.floor(index / topics.length) + 1}`,
  profile: index % 2 ? "review" : "scout",
  parentId: "root",
  depth: 1,
}));
if (running.length !== DEFAULT_POLICY.concurrency)
  throw new Error("Update the illustration tree to match default concurrency");
const children: ChildSnapshot[] = [...running, ...queued].map((task, index) => ({
  id: `demo-${index}`,
  generation: 1,
  ...task,
  status: index < running.length ? "running" : "queued",
  limits: { ...DEFAULT_POLICY },
  toolCalls: index < running.length ? 12 + index : 0,
  tools: ["read"],
  activity: index % 4 === 0 ? "Waiting for 3 nested scout/review audits" : "Tool: read",
  progress: "",
  result: "",
  model: { provider: "synthetic", id: "demo" },
  effort: null,
  telemetry: { requests: null, tokens: null, cost: null, context: null },
  disposed: false,
  createdAt: 1000,
  endedAt: null,
  writerLease: false,
}));
const coordinator = new DelegationCoordinator("unused-illustration-only", "root");
coordinator.list = () => children;
coordinator.generations = (id) => children.filter((child) => child.id === id);
coordinator.messages = () => [
  { role: "user", timestamp: 1, content: children[0].assignment },
  fauxAssistantMessage(fauxToolCall("read", { path: "audit-plan.txt" }, { id: "demo-read" }), {
    stopReason: "toolUse",
  }),
  {
    role: "toolResult",
    toolCallId: "demo-read",
    toolName: "read",
    timestamp: 2,
    content: [
      {
        type: "text",
        text: [
          "Synthetic capacity-demo plan (not repository source).",
          "16 running tasks; 32 queued across two root batches.",
          "4 audit leads + 12 nested scouts/reviewers; depth 2.",
          "Each lead delegates 3 checks in the foreground.",
          "Read-only tools; no child messaging grants required.",
          "Per task: 30 minutes, 200 requests, 500 tool calls.",
          "No live provider requests or load-test results.",
        ].join("\n"),
      },
    ],
    isError: false,
  },
];
const colors: Record<string, string> = {
  accent: "#a798d7",
  border: "#5fa8cc",
  muted: "#9da5a9",
  text: "#dee0e1",
  error: "#e06c75",
  warning: "#cd9a22",
  success: "#98c379",
};
const tui = new TuiMainScreen(new ProcessTerminal());
tui.requestRender = () => {};
const profilesMode = process.argv.includes("--profiles");
const widgetMode = process.argv.includes("--widget");
const palette: Parameters<typeof createHub>[1] = {
  fg: (color, text) =>
    styleText(text, { fg: parseColor(colors[color] ?? colors.text) }, "truecolor"),
  style: (text, options) =>
    styleText(
      text,
      {
        ...options,
        fg:
          typeof options.fg === "string"
            ? parseColor(colors[options.fg] ?? colors.text)
            : options.fg,
      },
      "truecolor",
    ),
  colors: { customMessageBg: oklchColor(0.337, 0, 0) },
};
const hub = createHub(
  coordinator,
  palette,
  { matches: () => false, getKeys: () => ["escape", "enter"] },
  () => {},
  () => {},
  { tui, cwd: process.cwd() },
  () => 37,
);
const profiles = createProfileViewer(
  bundledProfiles(),
  palette,
  { matches: () => false, getKeys: () => ["escape"] },
  () => {},
  () => {},
  () => 23,
  { edit: () => {} },
);
// Keep elapsed widget metrics reproducible without a live clock/session.
const widget = createChildWidget(
  () => children.map((child) => ({ ...child, endedAt: 2000 })),
  palette,
);
const lines = (widgetMode ? widget : profilesMode ? profiles : hub).render(120);
hub.dispose();
const title = widgetMode
  ? "Pinned Subagents widget"
  : profilesMode
    ? "Subagent Profiles"
    : "Subagent Hub";
const description = widgetMode
  ? "Production pinned widget at default capacity: 16 running, 32 queued, nesting depth 2. Synthetic data; not a terminal screenshot."
  : profilesMode
    ? "Production profile viewer with bundled profiles and no inherited skills. Synthetic offline data; not a terminal screenshot."
    : "Production terminal renderer at default capacity: 16 running, 32 queued, nesting depth 2. Synthetic data; not a terminal screenshot.";
const escape = (text: string) =>
  text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
const width = 1048;
const height = 48 + lines.length * 22 + 36;
const svg = [
  `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="title desc">`,
  `<title id="title">${title} — renderer illustration</title>`,
  `<desc id="desc">${description}</desc>`,
  '<rect width="100%" height="100%" rx="8" fill="#181818"/>',
  `<text x="20" y="28" fill="#aaaaaa" font-family="Menlo, monospace" font-size="12">ILLUSTRATION · ${title} · offline synthetic demo</text>`,
];
for (const [row, line] of lines.entries()) {
  let column = 0,
    fg = "#dddddd",
    bg = "",
    bold = false;
  // Native renderer colors are SGR escape sequences, not user-supplied text.
  // eslint-disable-next-line no-control-regex
  for (const part of line.split(/(\x1b\[[0-9;]*m)/)) {
    if (part.startsWith("\x1b[")) {
      const codes = part.slice(2, -1).split(";").map(Number);
      for (let i = 0; i < codes.length; i++) {
        const code = codes[i];
        if (code === 0) {
          fg = "#dddddd";
          bg = "";
          bold = false;
        } else if (code === 1) bold = true;
        else if (code === 22) bold = false;
        else if (code === 39) fg = "#dddddd";
        else if (code === 49) bg = "";
        else if ((code === 38 || code === 48) && codes[i + 1] === 2) {
          const color = `rgb(${codes.slice(i + 2, i + 5).join(",")})`;
          if (code === 38) fg = color;
          else bg = color;
          i += 4;
        }
      }
      continue;
    }
    const text = stripVTControlCharacters(part);
    const columns = visibleWidth(text);
    if (!columns) continue;
    const x = 20 + column * 8.4,
      y = 48 + row * 22,
      length = columns * 8.4;
    if (bg) svg.push(`<rect x="${x}" y="${y}" width="${length}" height="22" fill="${bg}"/>`);
    svg.push(
      `<text x="${x}" y="${y + 16}" xml:space="preserve" fill="${fg}" font-family="Menlo, monospace" font-size="14"${bold ? ' font-weight="bold"' : ""} textLength="${length}" lengthAdjust="spacingAndGlyphs">${escape(text)}</text>`,
    );
    column += columns;
  }
}
svg.push("</svg>\n");
writeFileSync(
  new URL(
    `../docs/images/subagent-${widgetMode ? "widget" : profilesMode ? "profiles" : "hub"}.svg`,
    import.meta.url,
  ),
  svg.join(""),
);
