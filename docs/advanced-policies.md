# Advanced policy support and capability boundaries (Pi 1.5.2)

This is a capability ledger for operators and integrators, not a full-parity or readiness claim. OMP revision `eda28eff97cf7a352fd3057a03581be1686dbc7a` is a behavioral reference only. No OMP implementation, prompts, private Pi runtime, or pi-subagents runtime is loaded. The native orchestration compatibility surface is defined in the [delegation contract](delegation-contract.md#native-orchestration-compatibility), not a full competitor API port.

## Exact model and reasoning policy — implemented

Unchained tasks use the captured physical parent model, effort and public authentication adapter. No automatic cheap model, alias or catalog refresh is introduced. Generic virtual-parent inheritance remains unsupported; independently selected physical profile/task models and profile chains do not need the parent router.

Only operator `<agent-dir>/delegation.json` can grant exact alternative selections, per bundled role:

```json
{
  "implementation": {
    "models": [
      { "provider": "your-provider", "id": "planning-model", "effort": "high" },
      { "provider": "your-provider", "id": "implementation-model", "effort": "medium" }
    ],
    "model": { "provider": "your-provider", "id": "planning-model", "effort": "high" },
    "prewalk": { "provider": "your-provider", "id": "implementation-model", "effort": "medium" }
  }
}
```

These identifiers are illustrative; use exact models already configured in the public parent registry. This configuration authorizes potentially billable dispatch when the operator runs real providers. It does not provision models or accounts. `models` has at most 64 selections; each includes a provider, model ID and explicit effort (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`). The model must actually support that effort and declare known finite positive context/output limits. Parent scoped-model effort pins also apply. No suffix parsing or silent effort coercion occurs.

- Absent `models`: only the inherited physical parent selection, no explicit override. Present `models` is an allowlist, including for the inherited default: list the default pair/effort if it should remain usable. `[]` denies dispatch for that role.
- Optional `model` sets the role's default. It requires a matching exact `models` grant. Optional task-item `model` has the same object shape and selects only a granted entry. Optional task-item `models` narrows the admitted exact allowlist (including `[]`); it cannot add entries and its ceiling remains in effect for descendants and renewal. It does not mint a grant or alter the parent.
- Trusted project configuration may only narrow the exact operator list or choose a default from it. It cannot introduce an alternative effort. Untrusted project configuration is ignored.
- Default descendants inherit their immediate parent’s actual selection, not the root’s different model. Every descendant selection and armed prewalk target must fit ancestor admitted authority. An ancestor without alternative grants permits only its actual selection. Renewal intersects current and previously admitted/request-narrowed grants; explicit request selections remain pinned. Removed alternatives cannot be restored by renewal. Ordinary inherited defaults revalidate the current physical parent on renewal.
- Whole-batch preflight checks every selection/armed target, provider, public availability, configured auth, parent scope and supported effort before inserting any identity or creating directories. Actual asynchronous auth resolution can still fail after admission and is reported as failure, not fallback. Each next turn rechecks current operator/project and ancestor policy; each dispatch rechecks live public registry/auth/scope/effort before counting and forwarding it. Revocation never authorizes an additional direct request.
- Snapshots name the actual current physical model and effort, not an invented role alias. SDK transcripts record real selections/responses. Direct request/token/cost telemetry belongs to that generation once, including both prewalk phases; parent and descendants are not charged again in an aggregate here.

## Profile-owned fallback chains

For resilience, define both exact permission grants and a separate ordered chain in the
operator's `<agent-dir>/delegation.json`. These identifiers are illustrative: replace them
with exact physical models already configured and authenticated in the parent registry.

```json
{
  "general": {
    "models": [
      { "provider": "your-primary-provider", "id": "primary-model", "effort": "high" },
      { "provider": "your-backup-provider", "id": "backup-model", "effort": "medium" }
    ],
    "fallback": [
      { "provider": "your-primary-provider", "id": "primary-model", "effort": "high" },
      { "provider": "your-backup-provider", "id": "backup-model", "effort": "medium" }
    ]
  }
}
```

`models` is permission, **not order**. `fallback` is a nonempty ordered array of at most
64 distinct exact provider/model/effort tuples. Every tuple needs an exact grant; known
virtual targets and fallback plus `prewalk` reject. A trusted root project may provide
an ordered subsequence or `fallback:false`, never add/reorder destinations. Alternate
workspaces do not supply grants. Tasks can disable fallback with `fallback:false` or
narrow `models`; they cannot supply a chain. Explicit task `model` stays pinned unless
`fallback:true` is also supplied. Opt-in requires membership and starts at that exact
entry, considering only its subsequent authorized entries. Without a task override the
profile chain, not the parent selection or profile `model` default, owns the primary.

A chain starts at its first available authorized target and preserves its exact effort.
Unavailable/missing/unauthenticated catalog targets are skipped with reasons before calls;
unauthorized scopes/efforts, revoked grants and known virtual targets hard-stop, never skip.
Authentication can still fail at request time: a runtime 401/403 is terminal. No provider,
credential or destination is automatically discovered. Parent auth/refresh remains owned
by the public registry; this feature neither copies keys nor loads parent extensions.

Each eligible failed request receives **two same-model retries** (three attempts total)
before advancing. Native Pi retries own transient attempts; a package-owned public
`agent_before_settle` controller handles exhausted native retries and quota/credit limits.
Quota backoff starts at 2 seconds and doubles, capped at 60 seconds. Provider retries are
zero in the owned child settings, preventing retry multiplication. Success resets only
the failure counter, not the selected backup. Authentication/permission failures, invalid
requests, refusals, tool errors and cancellation do not trigger automatic recovery.

Failed streamed drafts remain raw transcript evidence and are omitted from future model
projection using append-only context edits. Failed tool-call drafts never execute; completed
assistant/tool-result pairs remain and are not replayed by the SDK. A model may independently
request a similar action later: this is not an exactly-once external-side-effect guarantee.
Targets lacking image input are skipped rather than receiving Pi image placeholders.
Context/output limits and effort are validated; context overflow is not a fallback trigger.
No conversation truncation or capability conversion is added to make a target fit.

Every physical attempt, including retries, consumes the same cumulative direct-request
budget. Failed attempts can incur charges; `fallback.attempts[].usageKnown` distinguishes
unmeasured failed usage from a measured zero. Known usage remains in native transcript
accounting; `telemetry.costIncomplete` marks the displayed cost as a known subtotal. Backoff is within the existing deadline window, and cancellation/deadlines
abort it without another request. Explicit resume retains route, failure count and all
cumulative budgets. Existing explicit resume starts its ordinary new deadline window;
reset alone does not renew it. New followup/revival generations validate a fresh chain.

`/subagent-status <id> <generation>` reports the chain, current index/failure count,
`exhausted`, skipped targets, and physical attempt/error/usage-known history. Recovery
context edits, physical selections/responses and recovery audit entries are in the SDK
transcript. The route is scoped to this child identity/generation and retained parent
lifetime; it is not restored after parent shutdown/reload.

Exhaustion never wraps. `/subagent-fallback-reset <id> <generation>` is **operator-only**,
requires an idle/paused retained child, revalidates current/admitted grants and scopes,
and selects the first available target without a model request. It preserves attempts,
limits and cumulative budgets. A reset failed child may then explicitly resume, retaining
the failed window as evidence. No model-facing reset action exists. A changed chain is
not silently remapped on resume: explicit reset and revalidation are required. Restore
revoked grants or start a newly authorized operation when reset is denied.

The implementation is independent of any main-session fallback package: no shared config,
state, imports, reset, virtual routing or implicit permissions. A chained profile works
beneath a controlled virtual parent without invoking it. Unchained profiles retain the
existing virtual-parent restriction unless they select an independently authorized physical
profile/task model. Tests in `model-fallback-sdk.test.ts` and `model-fallback.test.ts` use
Pi 1.5.2 public APIs and controlled providers, not paid/live inference or a combined installed
extension compatibility certification.

## Prewalk — implemented bounded builtin subset

Pinned OMP `task/prewalk.ts` resolves a definition's opt-in. `session/prewalk.ts` runs the planning model first, then hands the **same conversation** to a target after the first completed granted builtin `edit`/`write` at the assistant turn boundary. This is not repository scanning or a context-file preloader.

An explicit task-item `model` is an exact assignment contract: it **suppresses inherited role prewalk**, as pinned OMP `task/executor.ts` and `executor-exact-model.test.ts` require. Its snapshot reports `prewalk.status:"suppressed-exact"` when a role prewalk was configured; neither the dormant role default nor target needs to be available. Exact selection/effort and suppression survive followup/revival, with current grant/auth/scope checks and no role fallback. A future explicit task `prewalk` field is not supported and is rejected, not silently discarded. Role `model` defaults may still prewalk. A target already identical to the effective source/effort reports `no-op` and adds no planning nudge, switch or extra dispatch.

The implementation above enables that one-way switch through operator `prewalk`, with both source and target independently admitted. It uses the awaited public extension `turn_end` and public `AgentSession.setModel` / `setThinkingLevel`; no internal agent state is rewritten. Like the reference's direct builtin predicate, the completed call can have an error result: handoff means an implementation call occurred, not proof a file changed. Bash is not a handoff trigger. There is no injected todo/plan file or extra forced model call. Independently written planning guidance is added only for configured prewalk.

Only existing effective tools and explicitly selected skills/assignment text are visible. Reads still traverse root permission hooks and consume the existing tool budget. No ambient context, credentials, environment, repository prescan, old history or additional resource discovery is added. Source and target use the same finite request/tool/deadline limits and public model context/output limits. Invalid later batch targets cause no earlier speculative launches. Cancellation/drain retains the permit; a cancelled write does not switch or dispatch the target. A completed handoff survives fresh-generation renewal as the target selection, without rearming; renewal is still a fresh session with no warm history replay.

Excluded reference behaviors: auto-prewalk classifier/smol routing, todo gating, deep-plan/continuation/checklist prompt machinery, hidden plan-nudge removal, plan-yolo approval transport, device/MCP mutation tiers, fallback/context promotion/cache affinity, automatic task-reset source restoration and warm parked transcript revival. These are not silently simulated. The supported public builtin/one-way contract was reconciled with the coordinator before implementation.

## Advisor — excluded from current product scope

Advisor is excluded from the current product scope. It is not awaiting an owner contract, an automatic follow-on implementation or a current release gate. Explicit ordinary `review` delegation remains supported; no advisor implementation or substitute is provided. The investigation below is retained as reference evidence, not an implementation plan.

OMP `advisor/runtime.ts` and `session/session-advisors.ts` implement a **retained incremental observer**, not an ordinary one-shot review task. They capture primary transcript deltas at turn boundaries even when cadence holds dispatch; retain an append-only advisor conversation/cursor; gate review cadence and catch-up; route `advise` notes differently during primary continuation versus terminal unwind; avoid advice-triggered self-review; retain separate cost/transcript state; and drain pending reviews/cards. Per-agent enablement is off independently of parent enablement. This implementation does not expose an advisor option or imply a configured advisor is active.

Public Pi sessions can retain their own conversation over multiple prompts; owned subscriptions, `steer`/`followUp`, custom tools, abort and `waitForIdle` are real building blocks. Missing a method named advisor is **not** evidence that extension-owned observers are impossible. However, this registry currently finalizes/disposes each prompt assignment, closes descendant presence, and holds ordinary permits for waiting ancestors. For reference, a faithful retained observer would need a retained-observer admission/lifetime contract covering delta/context grant and redaction boundary, finite cadence/backlog/input/output/request caps, read-only `advise` authority and terminal delivery, direct generation accounting, capacity/depth reservation and rejection when no permit is free, authorization and drain across primary terminal/renewal/shutdown. Those boundaries explain the reference capability; they are not pending requirements for the current product.

A boundary-only one-shot review changes the product meaning and already overlaps `review` delegation. Current product scope excludes both advisor implementation and an advisor substitute; ordinary explicit review tasks remain available on their own terms. No observer service, invisible side billing, extra calls, new queue or implicit overcommit was implemented.

## Production isolation — deferred and unimplemented

Filesystem isolation remains deferred and unimplemented. Worktree lifecycle management is intentionally caller-owned: automatic worktree creation, commits, copying/apply and cleanup are outside scope, not planned extension features. See [why worktrees are managed externally](../README.md#why-worktrees-are-managed-externally).

Existing caller-supplied workspaces are supported through explicitly approved file-path and shell-cwd adaptation, preserving the original parent dispatcher and its hooks. Hooks see the actual transformed arguments, not a transparently rebound cwd. The public dispatcher still has no per-call cwd. This execution adapter does not coordinate shared writes and is not filesystem containment or an OS sandbox; see [the workspace contract](delegation-contract.md#explicit-working-directory).

## Bounded investigations — not enabled

| Capability                       | Public evidence and precise boundary                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Disposition                                                                                                                                                                                                                                                                                                                                                   |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Completion probes                | OMP `task/completion-probe.ts` uses active-session `runEphemeralTurn`, same prompt/tools/history/cache, no transcript leaf change, bounded backoff and late cost capture. Pi 1.5.2 public `AgentSession` has no such method. Actual controlled busy-session `prompt()` rejects a second ordinary prompt without `steer`/`followUp`; those alternatives enter ordinary transcript/turn semantics. Public registry completion in a separate context is possible but does not establish ephemeral/cache/late-cost equivalence. | Unsupported as reference probes. No synthetic percentages, timer or extra inference.                                                                                                                                                                                                                                                                          |
| Speculative launch               | OMP `task/speculative-launch.ts` requires host-authorized partial JSON object closure plus veto/approval/adoption/abort ownership. Pi provider/message streaming exposes deltas, but extension `tool_call` authorizes complete arguments, not an adopted speculative operation. The extension cannot infer future whole-batch approval from a closed prefix.                                                                                                                                                                | Parked: no authorized partial-argument seam proven. Existing atomic invalid-later batch behavior remains mandatory.                                                                                                                                                                                                                                           |
| Worker/workpool                  | Public SDK can run in a Node worker/other host, but functions, public root dispatcher contexts and configured runtime/auth are not transferable automatically. OMP `task/workpool.ts` has persistent workers, item queues and incremental aggregate job yields; thread entrypoints additionally mirror host managers/resources. This package has finite in-process assignments, no admitted warm worker/workpool/backend/result contract.                                                                                   | Not implemented. Placement feasibility is not authorization to invent a worker pool, detached jobs or cloud backend.                                                                                                                                                                                                                                          |
| Exact executable extension paths | Actual public `DefaultResourceLoader` with `noExtensions:true`, all other discovery disabled, in-memory settings and `additionalExtensionPaths:[exactSyntheticFile]` executes only that fixture module; hostile ambient project extension stays unloaded. Module code can write directly through Node before a model tool runs.                                                                                                                                                                                             | Public path loading supportable, **not a sandbox or inheritance grant**. Production still rejects `extensions`. A future exact canonical-file operator grant needs project/ancestor/revival intersection, exported registration/tool scope, lifecycle/shutdown and executable-code authority acceptance before enabling. No directory/package/glob discovery. |
| MCP/resources                    | Public `createMcpExtension()` / `McpExtensionOptions.loadConfig` can select explicit server configs and an SDK resource loader can select skills/context files. Ordinary MCP startup otherwise discovers user/project configs and connects enabled servers. MCP tools/resources, executable transports, environment/auth interpolation, activation and shutdown have distinct authority contracts; extension path loading cannot grant them implicitly. No real server was connected or provisioned.                        | Production denies MCP/executable resources. Existing exact skills remain supported. No automatic environment/credentials copying. Exact server/resource grants and transport lifetime need owner reconciliation before implementation.                                                                                                                        |
| Historical consultation          | Public `SessionManager.open`/branch/fork can read fresh synthetic transcripts (existing controlled SDK reopen tests); reopening is not read-only consultation or revival. OMP `task/seance-policy.ts` explicitly strips extensions/MCP/IRC/context/spawn/resources and separates historical evidence.                                                                                                                                                                                                                       | Historical source selection/access/redaction and consultation ownership unapproved. No retained sessions, old drafts or provider data scanned; no historical migration/mutation. Existing fresh-generation renewal intentionally reads no old history.                                                                                                        |

Reference tests also include pinned `task/model-approval.test.ts`, `task/executor-prewalk.test.ts`, `task/parked-subagent-prewalk-revive.test.ts`, `subagent-advisor.test.ts`, `task/completion-probe-cost.test.ts`, `task/speculative-launch.test.ts`, `task/workpool.test.ts` and `task/seance-artifact-lifecycle.test.ts`; these are read-only reference evidence, not copied or executed upstream suites.

The exact extension-path and busy-prompt counterexamples are in `test/advanced-capabilities.test.ts`; model/prewalk evidence is in `test/model-policy.test.ts`. These are controlled-provider actual SDK/runtime/filesystem observations, **not live provider inference, external billing/cache/auth reliability or OS isolation proof**. No test implies broader executable inheritance is authorized.

## Joined fleet consumer

The one registry still owns queued/setup/running/draining/terminal state, limits, identity/generation/history, artifacts and direct telemetry. The joined native fleet widget/cards/Hub display those alongside actual model/effort and prewalk armed/handed-off/suppressed-exact/no-op, immutable selected-generation history and separate presence. No inferred role fallback, subtree double billing, new provider call or advisor observer is added. Hub input/stop/message targets stay pinned to original UUID+generation. Native followup/revive remains model-issued only because Hub command context has no permission-preserving dispatcher. See the [supported surface table](delegation-contract.md#storage-and-fleet-observation). Explicit workspace path/shell adaptation is supported; production filesystem isolation remains deferred, worktree lifecycle management remains caller-owned and retained advisor is excluded from current product scope. Neither excluded advisor nor deferred filesystem isolation is a current release gate. Other unsupported/parked capabilities above remain explicit gaps, not implied support.
