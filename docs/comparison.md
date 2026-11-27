# Feature comparison

Compared with three community alternatives using their documentation. Nicobailon and tintinweb were checked on 2026-11-11; tintinweb's messaging scope was additionally checked against source at revision `b72b414` (2026-11-12). `pi-better-subagents` was checked against its published 0.32.4 documentation on 2026-11-13. This is a feature comparison, not a performance or reliability benchmark. UI cells name documented surfaces; they do not imply other features are absent.

| Feature                        | @howarewoo/pi-subagents                                                                                                                     | [nicobailon/pi-subagents](https://github.com/nicobailon/pi-subagents)                                                                                                                            | [tintinweb/pi-subagents](https://github.com/tintinweb/pi-subagents)                                                                                                                                                    | [pi-better-subagents](https://pi.dev/packages/pi-better-subagents)                     |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Background tasks               | ✅ [Parent-bound by design; until exit or reload](design-decisions.md#why-background-tasks-are-parent-bound)                                | ✅ Supported                                                                                                                                                                                     | ✅ Supported                                                                                                                                                                                                           | ✅ Non-blocking `pi -p` child processes; completion callbacks                          |
| Nested delegation              | ✅ [Supported](design-decisions.md#why-nested-delegation-is-foreground-only)                                                                | ✅ Supported                                                                                                                                                                                     | ✅ Supported                                                                                                                                                                                                           | ⚠️ Opt-in for unconfined children; disabled in sandbox                                 |
| Task list / conversation       | ✅ [Subagent Hub: split panes; full-width thread on narrow terminals](design-decisions.md#why-the-ui-observes-one-native-registry)          | ✅ Fleet inspector: roster and output pane                                                                                                                                                       | ✅ FleetView opens a separate conversation viewer                                                                                                                                                                      | ✅ Background-work navigator; output/result tools                                      |
| Message / tool rendering       | ✅ [Native Pi message and tool components](design-decisions.md#why-the-ui-observes-one-native-registry)                                     | ✅ Structured Markdown/tool transcripts                                                                                                                                                          | ✅ Markdown + session-registered tool renderers                                                                                                                                                                        | — Not assessed                                                                         |
| Bi-directional agent messaging | ✅ [Supported; parent/child and siblings](design-decisions.md#why-agent-messaging-is-family-scoped)                                         | ⚠️ [Child/supervisor requests and replies](https://github.com/nicobailon/pi-subagents/blob/c99503aed6d6b20d2397a1767f7d60730efe3963/docs/workflows.md#supervisor-coordination-child-asks-parent) | ⚠️ [Parent-to-child steering + result return; no built-in child-initiated or sibling messaging](https://github.com/tintinweb/pi-subagents/blob/b72b414581d8aa9bbfb1d44c832aed0d0b0b9053/src/nested-tools.ts#L400-L430) | ⚠️ Parent-to-child communication + result return; no blocking child-to-parent requests |
| Live follow / scrollback       | ✅ Scroll up to pause; End to follow                                                                                                        | ✅ Scroll away to pause; bottom resumes                                                                                                                                                          | ✅ Scroll up to pause; End to follow                                                                                                                                                                                   | — Not assessed                                                                         |
| In-UI task controls            | ✅ [Hub: steer, inbox, stop, wait, park](design-decisions.md#why-controls-are-identity-pinned)                                              | ✅ Inspector: steer/follow-up and stop async runs                                                                                                                                                | ✅ Viewer: steer, stop, foreground-to-background handoff                                                                                                                                                               | ✅ Navigator stop controls                                                             |
| Tool / usage inspection        | ✅ [Tools: sanitized arguments/results; Details: direct usage](design-decisions.md#why-the-ui-observes-one-native-registry)                 | ✅ Expandable tool details + token counts                                                                                                                                                        | ✅ Expandable tool output + tokens; optional cost                                                                                                                                                                      | ✅ Output/result tools expose optional cost and tool counts                            |
| Schema-validated results       | ✅ [Supported](design-decisions.md#why-structured-results-require-explicit-submission)                                                      | ✅ Supported                                                                                                                                                                                     | ⚠️ Workflow agents only                                                                                                                                                                                                | — No equivalent caller-supplied result schema documented                               |
| Managed Git worktrees          | 🚫 [By design; caller-managed worktrees supported](design-decisions.md#why-workspaces-are-caller-managed-and-writes-are-caller-coordinated) | ✅ Supported                                                                                                                                                                                     | ✅ Supported                                                                                                                                                                                                           | ⚠️ Optional self-contained Git clone; not managed linked worktrees                     |
| Workflow scripts               | 🚫 [By design; caller-owned](design-decisions.md#why-orchestration-stays-with-the-caller)                                                   | ✅ Supported                                                                                                                                                                                     | ✅ Supported                                                                                                                                                                                                           | — Not assessed                                                                         |
| Scheduled runs                 | 🚫 [By design; pair any external scheduler](workspaces.md#why-workflows-and-scheduling-stay-external)                                       | ✅ Supported                                                                                                                                                                                     | ⚠️ Session-scoped agents only                                                                                                                                                                                          | — Not assessed                                                                         |

Legend: ✅ Supported (stated design boundaries apply) · ⚠️ Supported with scope restrictions · 🚫 By design · — Not established by the cited documentation or not assessed.

🚫 marks a deliberate product boundary, not a missing implementation within the current
contract. Linked explanations describe the trade-offs behind this repo's choices.

Sources: [our contract](delegation-contract.md); nicobailon's [README](https://github.com/nicobailon/pi-subagents/blob/c99503aed6d6b20d2397a1767f7d60730efe3963/README.md), [agents](https://github.com/nicobailon/pi-subagents/blob/c99503aed6d6b20d2397a1767f7d60730efe3963/docs/agents.md), [workflows](https://github.com/nicobailon/pi-subagents/blob/c99503aed6d6b20d2397a1767f7d60730efe3963/docs/workflows.md) and [observability](https://github.com/nicobailon/pi-subagents/blob/c99503aed6d6b20d2397a1767f7d60730efe3963/docs/observability.md); tintinweb's [README](https://github.com/tintinweb/pi-subagents/blob/8df7fa7d8e8130151a8fbfa991a1d3fa6b443739/README.md) and [workflows](https://github.com/tintinweb/pi-subagents/blob/8df7fa7d8e8130151a8fbfa991a1d3fa6b443739/docs/workflows.md); pi-better-subagents' [usage guide (0.32.4)](https://cdn.jsdelivr.net/npm/pi-better-subagents@0.32.4/docs/usage.md) and [agent catalog (0.32.4)](https://cdn.jsdelivr.net/npm/pi-better-subagents@0.32.4/docs/agent-catalog.md).

## Why choose this repo?

Choose this repo for a supervised workflow in an existing checkout:

- Child tools retain parent permission hooks. Profiles cap authority; trusted-project
  settings and tasks can only narrow operator grants. Ambient extension/MCP runtimes
  are not loaded, and extra leaf tools require operator review.
  See [permissions and resources](design-decisions.md#why-permissions-and-resources-are-explicit).
- Children use the parent's physical model and effort unless an exact operator-approved override
  or profile-owned fallback chain applies. Unchained unavailable selections fail without fallback.
  See [model routing](design-decisions.md#why-model-routing-is-exact).
- `resultSchema` requires explicit, validated submission. Batches pass preflight before
  any child starts, retain input order and report background outcomes after all siblings
  drain. See [structured results](design-decisions.md#why-structured-results-require-explicit-submission).
- Hub combines native Pi conversations, tool arguments/results, usage and identity-pinned
  controls. Granted parent/child and sibling messaging stays bounded within the live
  parent runtime. See [Hub](hub.md) and [messaging](design-decisions.md#why-agent-messaging-is-family-scoped).
- Writers and parent tools may run concurrently in the same checkout, within ordinary
  FIFO capacity. Assign independent responsibilities and coordinate shared operations;
  the extension does not prevent collisions, lost updates or Git index contention.
  See [workspace ownership](design-decisions.md#why-workspaces-are-caller-managed-and-writes-are-caller-coordinated).

### Compared with nicobailon/pi-subagents

This repo keeps background assignments under one live parent responsible for grants,
admission, descendant drain and bounded concurrency. Nicobailon also runs foreground
children in-process, but uses a detached background runner. Both have fleet inspection
and schema-validated results.

Choose nicobailon for packaged review loops, council patterns, custom agents with
per-agent memory, managed worktrees, durable missions or scheduled runs. This repo
leaves workflows and workspace lifecycle to the caller, with no built-in scheduler or restart
recovery.

### Compared with tintinweb/pi-subagents

This repo supports granted parent/child and sibling messaging, plus schema-validated
results on ordinary assignments. Tintinweb's cited implementation has parent-to-child
steering and result return; its schema-validated results are documented for workflow
agents. This repo's Hub keeps the roster beside the conversation on wide terminals;
tintinweb's FleetView opens a separate viewer.

Choose tintinweb for Claude Code-style tool conventions, compatible JavaScript workflows,
persistent agent memory, session-scoped scheduling or managed worktrees that preserve
changes on a branch. Both support conversation continuation, but this repo retains it
only within the owning parent runtime; tintinweb documents persisted resume. Its worktree
isolation is not an OS sandbox.

### Compared with pi-better-subagents

This repo supports foreground results or background completion, live family messaging
and explicitly submitted schema-validated results. `pi-better-subagents` uses independent,
non-blocking child processes with completion callbacks and no mid-task blocking
child-to-parent requests.

Choose `pi-better-subagents` for opt-in macOS/Linux sandboxing (off by default), saved
conversations another foreground session can continue, or optional sandbox-oriented Git
clones. This repo has no OS sandbox; changing `cwd` does not provide containment.
The other package also has an editable role/named-agent catalog and, with Background
Tasks loaded and its documented prerequisites met, workers that release slots while
waiting for long operations.

Recommendations apply to the cited versions, without a performance or reliability ranking.
Unassessed controls may exist in the alternatives.
