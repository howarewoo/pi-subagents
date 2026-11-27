# Architectural decisions

The [feature comparison](comparison.md) links here for the reasoning behind each choice.

These choices define the current execution contract and its trade-offs. They are not
claims that other designs are unsafe or impossible. Deferred capabilities are identified
separately; an unsupported feature is not automatically a permanent exclusion.

## Why background tasks are parent-bound

Background tasks belong to the live parent Pi runtime. Shutdown or `/reload` cancels
children and drains their tools and descendants before releasing capacity.
Closing Subagent Hub does not stop work. Stopping tasks retain their permits until
actual drain, while unrelated siblings may continue within available capacity.

Keep Pi running until tasks finish: there is no detached runner or restart recovery.
Unresponsive provider, permission or tool code can delay drain; abrupt process death
cannot guarantee cleanup. Saved transcripts are inspection records, not restart state.

In the cited versions, nicobailon uses detached background processes. Tintinweb stops
agents on shutdown but supports persisted conversation resume and foreground-to-background
handoff. Persisted conversations do not keep jobs running after exit.
See [the delegation contract](delegation-contract.md) for continuation semantics.

## Why nested delegation is foreground-only

Nested calls require explicit profile grants and wait for their children while retaining
their execution slot. Work that cannot start immediately is rejected rather than queued
behind waiting ancestors or given extra capacity. A writing child may spawn a writer
only with explicit grants and sufficient immediate capacity.

This keeps capacity and authorization predictable but limits fan-out. Parent completion or
stop drains descendants; there are no detached grandchildren.
See [lifecycle and scheduling](../ARCHITECTURE.md#lifecycle-and-scheduling).

## Why permissions and resources are explicit

Profiles cap tools at what the parent can call. Builtin calls retain the parent's
permission hooks; operator grants set authority, and trusted-project configuration and
task requests can only narrow it. Selecting another workspace does not load its trust policy.

Children receive their assignment, role prompt and granted skills, not parent
instructions, history or ambient context. General also inherits available skills and
may use exact operator-reviewed leaf tools. Full extension/MCP runtime inheritance and
tool-to-tool forwarding are unsupported, so provide a complete handoff.
Tool grants and cwd adaptation are not an OS sandbox.
See [permission and resource boundaries](../ARCHITECTURE.md#permission-and-resource-boundaries).

## Why model routing is exact

Children use the parent's selected physical model and effort by default. Overrides require exact
operator-approved provider/model/effort grants. Unchained unavailable selections and unsupported
effort fail visibly. Optional [profile-owned fallback chains](advanced-policies.md#profile-owned-fallback-chains)
recover eligible failures only across explicitly listed exact targets; grants alone do not enable routing.
Authentication stays with the parent's registry, not child task directories.

A configured role prewalk can make one approved model switch after an edit/write call;
it adds no hidden planning inference.
See [models and authentication](../ARCHITECTURE.md#models-and-authentication).

## Why workspaces are caller-managed and writes are caller-coordinated

Pass an existing directory as `cwd`, including a caller-created worktree. The extension
adapts builtin paths and shell cwd through parent permission hooks. Worktree creation,
branch/base selection, integration and cleanup stay with the caller or separate tooling,
keeping this extension focused on subagent execution, coordination and UI.

Workspace selection is not containment: paths and shell commands can reach outside the
directory when parent permissions allow. Writers, reviewed leaf tools and parent tools
may run together by default, including across supplied workspaces. There is no lock,
file ownership, merge, rollback or conflict guarantee. Assign independent files/responsibilities
and coordinate Git, generated files and other shared operations yourself. Reads and
reviews during writes are not stable snapshots; repeat verification after coordinated edits finish.

Cancellation is not rollback: completed writes remain, and in-flight tools can take time
to drain. Stop/drain affected work, inspect the actual checkout, reconcile same-file
conflicts deliberately, and verify before retry/resume; do not automatically replay mutations.
Manual `!`/`!!`, external editors, other sessions and arbitrary extension JavaScript are
also caller-coordinated. To load changed extension source, let active children drain and
reload/restart the parent; editing source does not replace its running coordinator.
See [tool execution and workspaces](../ARCHITECTURE.md#tool-execution-and-workspaces)
and [explicit working directory](delegation-contract.md#explicit-working-directory).

## Why structured results require explicit submission

Schema-required children must call `submit_result` with a value matching the supported
bounded JSON Schema subset. Final prose is not parsed. Submission is provisional until
execution and descendants drain: it cannot override cancellation or failure, and a
missing required submission fails the task.

Whole batches pass preflight before admission. Results keep input order, and a failed
child does not cancel unrelated siblings. Background batches send one outcome after
drain, so fast results may wait for slower siblings.
See [results and persistence](../ARCHITECTURE.md#results-and-persistence).

## Why the UI observes one native registry

Hub, the widget and result cards observe the same coordinator; viewers do not start
another executor. Pi's native components render sanitized conversations, using split
panes or a full-width thread on narrow terminals.

Usage is reported directly per generation, without recursive parent totals or estimates
for missing provider usage. Display sanitization does not redact saved files.
See [observation and terminal UI](../ARCHITECTURE.md#observation-and-terminal-ui).

## Why controls are identity-pinned

Controls target a UUID and generation, so stale selections cannot change newer
assignments. Paused continuation keeps its conversation; follow-up or revival of completed
work starts a fresh generation under current, narrowed authority. Supply needed prior
conclusions: old transcripts are not replayed.

Hub uses the same registry authority as the tools, but cannot start new generations:
its command context lacks Pi's permission-preserving tool dispatcher. Use model-issued
tool calls for those actions.
See [coordination, presence and generations](../ARCHITECTURE.md#coordination-presence-and-generations).

## Why agent messaging is family-scoped

Explicit grants allow parent/child messages in both directions and sibling messages
within the same exact parent generation. Senders must know the recipient's UUID and
generation. Children cannot enumerate the registry, address arbitrary sessions or read
peer transcripts.

`delegate_coordinate` supports inbox, steering/follow-up delivery and bounded event-driven
waits. Recipients must be running; inbox delivery does not trigger parent inference.
Receipts distinguish acceptance, queuing and visibility, not model acknowledgment.
Mailboxes and waits are finite, waits retain capacity, and cycles are rejected. Callers
must arrange identities and replies; this is not a durable broker or blocking supervisor
interview.

Nicobailon documents child `contact_supervisor` requests and parent `subagent_supervisor`
replies, including nested supervision. Tintinweb implements steering and result return.
At `b72b414`, its [nested steering tool](https://github.com/tintinweb/pi-subagents/blob/b72b414581d8aa9bbfb1d44c832aed0d0b0b9053/src/nested-tools.ts#L400-L430)
targets only owned children; its [completion outbox](https://github.com/tintinweb/pi-subagents/blob/b72b414581d8aa9bbfb1d44c832aed0d0b0b9053/src/index.ts#L466-L497)
returns results, not child-initiated dialogue. No built-in upstream or sibling messaging
was found in that source inspection.
See the [coordination contract](delegation-contract.md#live-parent-messaging-waits-and-presence).

## Why orchestration stays with the caller

The caller owns the larger plan and workspace preparation. This extension provides
bounded assignments, batches and live coordination, not a workflow-script runtime or
scheduling service. Scripts and recurring jobs need separate tooling and must respect
the live-parent lifetime. See [external scheduling](workspaces.md#why-workflows-and-scheduling-stay-external)
for pairing with any scheduler, such as `@howarewoo/pi-schedule`, for periodic check-ins.

The native `subagent` interface uses the same executor; it does not interpret competitors'
workflow scripts or custom agent definitions.
See [entry points and runtime ownership](../ARCHITECTURE.md#entry-points-and-runtime-ownership).
