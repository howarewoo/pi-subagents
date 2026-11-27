# Configuration

This page covers `delegation.json`, profile-owned model chains and task limits. The [delegation contract](delegation-contract.md) and [advanced policies](advanced-policies.md) hold the full reference.

No configuration is needed for the bundled roles. To change prompts or narrow tools, use `~/.pi/agent/delegation.json`:

```json
{
  "review": {
    "tools": ["read", "grep"],
    "skills": ["/absolute/operator-reviewed/review/SKILL.md"],
    "prompt": "Review this assignment and report concrete findings with source locations."
  }
}
```

All bundled profiles may delegate to `scout` and `review` by default, within a total depth of two (root 0, child 1, grandchild 2). Other nested targets and child messaging need explicit operator grants. Set `spawn: []` to revoke nesting. General inherits available parent skills; other roles need explicit skill grants. Trusted project configuration in `.pi/delegation.json` can narrow grants, never expand them. Children do not load ambient extension/MCP runtimes or context files; general can forward only the reviewed leaf tools described above.

## Profile-owned model chains

Configure `models` as permission grants and a separate ordered `fallback` array on a profile
in `delegation.json`. The chain starts at its own first available authorized physical target,
regardless of the parent's model, including when the parent selects a virtual model. It never
executes or inherits that parent's router. Profiles without a chain keep existing routing.
Every child, with or without a chain, retries a transient provider error twice on the same
model and automatically compacts its own context when it fills; each retry and summary
request consumes the request budget.

Each failed eligible request gets two same-model retries before advancing. Transient outages
and exhausted quota/credits are eligible; authentication, permission, invalid requests,
refusals, tool failures and cancellation are not. Backups remain selected across explicit
resume until a fallback reset. Every attempt consumes the current window's request budget;
backoff consumes the current deadline window, if one is configured.

An explicit task `model` stays pinned unless `fallback:true` opts into that model's suffix of
the profile chain. `fallback:false` disables chaining. Task `models` can remove destinations,
not add or reorder them. Fallback and prewalk cannot be combined. Listing a provider in a
chain authorizes sending that child's conversation to it; failed calls may still cost money.

The orchestrator inspects routing with the `subagent` status action. To retry an exhausted
chain, ask it to reset the idle/paused retained child with root-only
`delegate_coordinate` `{"action":"reset_fallback","target":{"id":"<task-id>","generation":1}}`
and then resume it. Reset sends no request and replenishes no budgets or deadline; the resume
opens its ordinary new window. Children cannot reset routing. No state survives parent shutdown.
See [configuration, safety and diagnostics](advanced-policies.md#profile-owned-fallback-chains).

## Task limits and deadlines

Default task limits are **no deadline**, **200 direct model requests** and **500 tool calls** per execution window:

- Operator `scheduling.deadlineMs` in `~/.pi/agent/delegation.json` may set a positive per-window deadline (up to 24 hours); `0`, the default, disables it. A trusted project or a task's `limits.deadlineMs` can set or shorten a deadline but cannot disable an operator's deadline.
- Requests and tools are hard caps. Before reaching them, a subagent can use reserved capacity to report partial findings or submit a structured result instead of starting new work. Wrap-up does not add capacity or guarantee a result. Trusted project and per-task limits can still only narrow the applicable budgets.
- A configured deadline pauses the active subtree after tool/provider drain, releasing capacity but retaining sessions and conversations.
- Use `subagent` resume or root-only `delegate_coordinate` `{action:"resume",target:{id,generation},assignment:"Continue…"}` to continue the same identity and conversation. Each resume starts a fresh window: a fresh deadline (if configured) and fresh request/tool budgets. Snapshot request/tool counters stay cumulative, `windowStart` records where the current window began, and spawn counts remain cumulative (at most 64 windows per generation). Completed windows retain earlier result/artifact evidence in `completedWindows`; a resumed completed structured assignment requires a new `submit_result`.
- Resume the parent first, then explicitly selected children. Descendants never resume automatically.
- Paused windows publish no final artifacts, but their snapshot, background notice and task card are marked `partial` with a bounded preview of the last assistant text. A window that settles with a budget wrap-up report is also marked `partial`; its result is that report. Resume clears the marker for the new window.
- Stop, shutdown and hard request/tool limits cancel and dispose. Unresponsive code must drain before pause or cancellation can release resources.

See [limits and nesting](delegation-contract.md#capacity-and-bounded-execution), [profile grants](delegation-contract.md#subagent-profiles-and-explicit-spawn-grants), and [model selection and prewalk](advanced-policies.md).
