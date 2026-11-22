# Changelog

## [Unreleased]

## [0.5.0]

Requires Node 22.19+ and stable Pi 1.5.2 or newer, unchanged from 0.4.0. Tested host
remains Pi 1.5.2; newer stable hosts are allowed, not guaranteed compatible. Host peer
dependencies remain wildcards by Pi's package format; the minimum is enforced at execution
boundaries. This release contains three breaking changes, so it is a 0.x minor bump.

### Breaking changes

- feat(profiles)!: autosave Inspector item changes (#74) (00da9af3ab41)

  **What changed:** `/subagent-profiles` was a read-only viewer in 0.4.0; this release adds
  native editing (#70), and ordinary edits persist when each item is committed, without Apply
  or file-level Review/Save. Escape cancels only unfinished input; Revert never rolls back
  verified saves. Advanced structural operations keep explicit transaction review. **Who is
  affected:** operators who open the Inspector and choose a write destination; there is no
  draft-then-save step for ordinary items. **What to do:** no configuration schema migration
  is required. Check the destination (Global or Trusted project) and exact path before
  editing, and treat each committed item as saved to disk.

- feat(limits)!: let long subagent work continue across limits (#87) (b4d50813ec2c)

  **What changed:** subagents no longer pause after 30 minutes by default
  (`scheduling.deadlineMs` now defaults to `0`, no deadline; operators may set a positive
  per-window cap of up to 24 hours). Request and tool budgets apply per execution window:
  an explicit resume starts fresh request/tool budgets and a fresh deadline instead of
  keeping them cumulative. Snapshot counters stay cumulative, new `windowStart` records where
  the current window began, and spawns and the 64-window cap remain cumulative. **Who is
  affected:** operators who relied on the default 30-minute pause, or on cumulative budgets,
  to bound cost or runtime. **What to do:** to keep the old pause, set
  `"scheduling": {"deadlineMs": 1800000}` in `~/.pi/agent/delegation.json`. Trusted projects
  and task `limits.deadlineMs` can set or shorten a deadline but cannot disable an operator's.
  Each resume can now spend a full new request/tool budget, so resume deliberately.

- feat(hub)!: reduce slash commands to hub, profiles and stop (#90) (7ab8b6707b95)

  **What changed:** `/subagent-status` and `/subagent-steer` (shipped in 0.4.0) are removed
  without aliases, as is `/subagent-fallback-reset`, which was added after 0.4.0 and never
  shipped. Remaining commands are `/subagent-hub`, `/subagent-profiles` and `/subagent-stop`.
  In the Hub, Enter now focuses the steering composer instead of closing the Hub, the `s` key
  is removed, and Esc/Ctrl+C close it. **Who is affected:** operators, scripts or prompts that
  call the removed commands, and Hub users relying on `s` to steer or Enter to close. **What
  to do:** use Subagent Hub (or the non-TUI `/subagent-hub` list) for status, the Hub composer
  or the `subagent` steer action for steering, and ask the orchestrator to call root-only
  `delegate_coordinate` `reset_fallback` before resuming an exhausted fallback chain.

### Features

- feat(subagents): add profile-owned model chains (#69) (e3f8a9706797)

  Profiles may configure an ordered `fallback` chain of exactly granted physical targets in
  operator `delegation.json`. Eligible transient and quota failures get two same-model retries
  before advancing; every attempt consumes the request budget and failed calls may still cost
  money. Profiles without a chain keep existing routing; explicit task `model` stays pinned
  unless `fallback:true` is set. Fallback cannot be combined with prewalk.

- feat(profiles): add native editing and custom roles (#70) (daef42236c45)
- feat(profiles): add native Inspector presentation (#71) (26470a36032d)
- feat(profiles): browse registry-backed model selections (#72) (c8b8477ad6d5)
- feat(profiles): simplify the profile editor layout (#75) (999d3487dc0b)
- feat(subagents): reserve budget for final reports (#84) (ad989c14f98a)

  Warn near request and tool limits, then reserve reporting attempts within the existing hard
  caps so a subagent can report partial findings or submit a structured result instead of
  starting new work. Wrap-up adds no capacity and does not guarantee a result.

- feat(results): surface partial output for paused and wrap-up windows (#86) (2c69b9603185)
- feat(child): auto-compact and retry transient errors in subagents (#88) (19fd96baec8c)

  Every child now uses Pi automatic compaction and retries transient provider errors twice on
  the same model, with or without a fallback chain. Summary requests and retries are charged
  to the request budget; compaction never spends the final-report reserve.

- feat(profiles): table-style model picker with inline effort (#91) (df801f455905)
- feat(profiles): inline model chain editing (#92) (fed2a9fac23b)
- feat(hub): add model, effort and usage status line (#94) (eb79ecdae296)

Breaking `feat(...)!` entries #74, #87 and #90 are listed under **Breaking changes** above.

### Fixes and performance

- perf: read completed-resume transcripts asynchronously (#65) (665612242535)

  Completed conversation resumes read their original transcript asynchronously, allowing
  unrelated activity to progress during disk verification. Exact retained-context and
  complete transcript verification remain required; missing, empty, malformed or modified
  evidence still rejects without changing the completed outcome. Pending resumes reserve their
  identity before waiting and recheck cancellation and identity after waits, so duplicates,
  stop, shutdown and replacement generations cannot revive stale work.

- perf: coalesce foreground delegation previews (#66) (c36b2266d91e)

  Foreground delegation streaming previews update at most once per 50ms, showing the latest
  progress at each flush. Lifecycle transitions and final outcomes remain immediate; raw
  registry/SDK events, full snapshots, ordered batch results and completion wakeups are
  unchanged.

- perf: cache unchanged Hub transcripts and native rows (#67) (07f6afed55f9)

  Reuse unchanged Hub roster, selected transcripts, native message projections and rendered
  rows instead of repeatedly cloning, sanitizing and wrapping full history. Custom-renderer
  cache bypasses are limited to tools present in the selected transcript. Native output, full
  transcript access, live/final transitions, reading anchors and tool expansion are preserved.

- fix(profiles): simplify default-first model selection (#76) (f8835d2ebaa1)
- fix(profiles): preserve unfinished text through navigation and recovery (#77) (eb7b50821faa)
- fix(profiles): make compact controls and membership actions reliable (#79) (24d670f72824)
- fix(hub): clarify supervision controls and original-target feedback (#78) (6b8a1ed420b8)
- fix(profiles): clarify inspector focus, density and labels (#85) (67002126c4df)

### Other changes

- build: generate release changelogs from conventional commits (#68) (1b48907da52a)
- build(deps): bump actions/download-artifact from 4.3.0 to 8.0.2 (#83) (47e21b95ae00)
- build(deps): bump pullfrog/pullfrog from 0.1.126 to 0.1.130 (#82) (c44761dff6ec)
- build(deps): bump actions/upload-artifact from 4.6.2 to 7.0.2 (#81) (5d807d39df76)

### Migration

Let active tasks drain, install `@howarewoo/pi-subagents@0.5.0` and restart Pi. Existing valid
0.4.0 configuration loads unchanged; grants, Pi host requirements, identity/artifact formats
and capacity limits are unchanged. Apply the per-change actions above: set
`scheduling.deadlineMs` if you want a default pause again, and replace any use of the removed
commands. Updating a checkout does not change an already loaded runtime; reload and shutdown
abort and drain active children rather than migrate them.

**Rollback to 0.4.x:** 0.4.0 rejects configuration it does not know. Before reinstalling
0.4.0, remove profile `fallback` chains, custom role definitions and project-local spawn-target
registrations, and any `scheduling.deadlineMs` of `0` or above 3600000 from
`delegation.json` files, then restart Pi.

## [0.4.0]

Requires Node 22.19+ and stable Pi 1.5.2 or newer, unchanged from 0.3.3. Tested host
remains Pi 1.5.2; newer stable hosts are allowed, not guaranteed compatible.

- **Breaking behavior:** writers and parent tools now run concurrently by default within existing FIFO/capacity
  limits, in shared or supplied workspaces. Explicitly authorized nested writers and
  continuation windows use ordinary capacity rules; no writer lease or parent mutation
  reservation remains. Callers coordinate collisions; no isolation, rollback, automatic
  merge, file ownership, worktree management or new configuration is provided.
- Preserve permission/provenance/leaf trust, retained-permit drain, grant revalidation
  and 0.4.0 ordered completion wakes. `ChildSnapshot.writerLease` remains a required,
  deprecated boolean, always false for new snapshots; lease-specific UI/help is removed.
- SDK regression coverage proves three overlapping writers, concurrent parent effects,
  cross-workspace compatibility calls, nested authorization, FIFO limits, cancellation,
  pause/resume and ordered once-per-batch wakes after actual drain.

- **Breaking behavior:** root `delegate_task(background:true)` single/batch and direct
  `delegate_coordinate resume` completion notices now automatically request a parent model
  turn. Root `delegate_coordinate followup/revive` now send one drained outcome notice for
  the returned new generation and request a turn too. Compatibility `subagent` async/resume
  retains the same wake behavior. Idle owners wake without a user prompt; busy owners queue
  the notice as a follow-up. This may add parent model turns and provider charges.
- Each successful async launch call sends one ordered batch outcome after all members drain;
  each resume/renewal sends one outcome per new execution window. Foreground and rejected
  operations send no extra notice. Paused, failed and cancelled outcomes notify while the
  owner remains live; a wake is not success, acknowledgment, guaranteed task continuation or
  authority to auto-resume. Closing/stale-owner suppression and parent-bound shutdown/drain
  are unchanged; no polling, forced continuation loop or new lifecycle service is added.
- Hub thread tool output now opens collapsed, using Pi’s native tool components. The configured
  `app.tools.expand` action (default Ctrl+O) toggles all tool blocks for the current Hub opening,
  across agents/generations and tabs. Remapped/disabled keys are respected. LIVE keeps following;
  READING retains the surviving message/tool location when expanding or collapsing. This is
  display-only; Tools still exposes full sanitized inspection text.
- **Migration:** let active tasks drain, install `@howarewoo/pi-subagents@0.4.0` and restart
  Pi. No configuration migration is needed. Grants, model routing, host requirements,
  identity/artifact formats and capacity limits are unchanged. Writer exclusivity is removed;
  callers must coordinate shared writes. Updating a checkout
  does not change an already loaded runtime; reload/shutdown abort and drain rather than
  migrate active children.

## [0.3.3]

Requires Node 22.19+ and stable Pi 1.5.2 or newer, unchanged from 0.3.2. Tested host
remains Pi 1.5.2; newer stable hosts are allowed, not guaranteed compatible. No
configuration migration is required. Default task budgets increase as described below;
permissions, scheduling capacity and lifecycle behavior are unchanged. Let active tasks
finish before updating, then restart Pi; reload and shutdown abort and drain active
children rather than migrating them.

- Raise default per-task budgets from 100 direct model requests and 100 tool calls to 200 requests and 500 tool calls. Explicit operator budgets and narrower project/task limits remain effective; the thirty-minute deadline, 1,000/1,000 operator ceilings, and cumulative resume counters are unchanged. Higher defaults permit more work and potentially higher cost before cancellation.

- Show compact task cards for delegation completion, resume and status notices in Pi's TUI, with assignment headline, profile, generation and status. Error and pause reasons stay visible; expand output using Pi's existing control for task details and transcript references. Model-facing previews and completion wake-ups are unchanged. Older messages and non-task output retain Pi's readable fallback; no migration is required.

## [0.3.2]

Requires Node 22.19+ and stable Pi 1.5.2 or newer, unchanged from 0.3.1. Tested host
remains Pi 1.5.2; newer stable hosts are allowed, not guaranteed compatible. No
configuration migration is required. Runtime behavior, permissions and lifecycle are
unchanged. Let active tasks finish before updating, then restart Pi; reload and shutdown
abort and drain active children rather than migrating them.

- Load the package through a root `index.ts` entrypoint so Pi displays npm installations as `@howarewoo/pi-subagents` without the old `src/pi-extended-subagents.ts` suffix. Keep the existing source entrypoint available for direct loads; local installations still use path-derived labels. No runtime or configuration migration is required.

## [0.3.1]

Requires Node 22.19+ and stable Pi 1.5.2 or newer, unchanged from 0.3.0. Tested host
remains Pi 1.5.2; newer stable hosts are allowed, not guaranteed compatible. No
configuration migration is required. Runtime behavior, permissions and lifecycle are
unchanged. Let active tasks finish before updating, then restart Pi; reload and shutdown
abort and drain active children rather than migrating them.

- Clarify the package description, add Pi/subagent discovery keywords, and lead the README with the supervised workflow, execution trade-offs, comparison links and a bounded read-only quick start.

- Shorten README selection guidance while preserving the comparison sources, feature coverage and execution boundaries.

- Add `pi-better-subagents` 0.32.4 to the README feature comparison with versioned sources and explicit unassessed entries. Explain when to choose this repo's permission hooks, exact model routing, validated batch results, Hub supervision and writer coordination, including sandbox, persistence and automation trade-offs. Add competitor-specific selection guidance for nicobailon, tintinweb and pi-better-subagents, identifying overlapping features and cases where each alternative is a better fit.

## [0.3.0]

Requires Node 22.19+ and stable Pi 1.5.2 or newer, unchanged from 0.2.x. Tested host
remains Pi 1.5.2; newer stable hosts are allowed, not guaranteed compatible.

### Breaking — completed-context resume and migration

- Resume of successfully completed work now continues the same full SDK conversation and tool history, with the same identity, generation and session count, rather than starting a fresh session. To start fresh work in a new generation, use explicit model-issued `delegate_coordinate` `followup` or `revive` and supply the context it needs; those operations do not replay the old conversation.
- Only the deadline window resets on resume; request/tool/spawn counters remain cumulative, with at most 64 execution windows per generation. Paused windows retain provisional structured submission state and publish no final outcome artifacts. Completed windows preserve immutable outcome/artifact evidence in `completedWindows`; later completed-window artifacts use `window-N/` without replacing earlier files. Resumed completed structured assignments require a new `submit_result`.
- Context restoration lasts only for the current parent runtime; saved transcripts are not reload/restart recovery state. Let active tasks drain before updating, then restart Pi. Reload/shutdown aborts and drains children rather than migrating them. Resume the exact parent generation first, then explicitly resume selected children; descendants never resume automatically. Existing authority, grants, authentication, capacity and writer checks still apply.

### Changes

- Make the queued deadline/continuation lifecycle regression test deterministic with a controlled deadline clock, preserving pre-dispatch expiry and repeated continuation coverage while verifying shutdown disposes an actual retained SDK session. Runtime deadline policy is unchanged.

- Correct resume to continue paused or successfully completed conversations with the same identity, generation, session count and full SDK/tool history. Completed runtimes restore from the canonical SessionManager into the same transcript, never a result summary or silent fresh generation. Preserve cumulative budgets and earlier window artifacts/outcomes; revalidate current authority/auth/capacity, reject stopped/failed/retired/unavailable identities, and bound continuations to 64 windows. Explicit followup/revive behavior is unchanged.

- Preserve successfully completed descendants across ancestor completion for explicit parent-first same-context resume, without undoing explicit retirement. Validate retained post-handoff model availability on resume rather than requiring the obsolete admission model; keep lineage, grants and writer checks.

- Count individual subagent sessions, including retained historical generations, in the widget total using the same roster source as the unfiltered Hub. Distinct tasks sharing a profile and nested sessions each count separately; active widget rows remain bounded and scheduling/lifecycle behavior is unchanged.

## [0.2.1]

Requires Node 22.19+ and stable Pi 1.5.2 or newer. Tested host remains Pi 1.5.2;
newer stable hosts are allowed, not guaranteed compatible. No configuration migration is
required. Let active tasks finish before updating, then restart Pi; reload and shutdown
abort and drain active children rather than migrating them. Permissions, scheduling limits
and lifecycle behavior are unchanged.

- Keep Hub tree lanes, unselected agent names and status text in the normal foreground color. Highlight the selected name and selection marker with the accent color, while profile words and status circles retain lifecycle coloring, including compact views.

- Replace the widget activity preview with a summary below the visible child when its parent has additional hidden running children. Show “2 more nested subagents running” for the capacity illustration while keeping the total hidden-fleet overflow count unchanged.

- Add lifecycle-colored status circles to the Hub roster and compact selected-agent header. Use a tee for widget activity when a visible child follows, preserving the last child's elbow connector.

- Render connected subagent trees with three-column widget lanes and four-column Hub lanes, last-sibling elbow branches and continuing ancestor pipes, including aligned activity/profile rows. Group descendants by parent generation. The widget closes its last visible nested sibling before the overflow summary; Hub connectors reflect the full roster across viewport clipping. Remove blank separator rows between Hub agents and refresh the README illustrations. Indentation remains capped at three displayed levels and width/row bounds are unchanged.

- Refresh README Hub and widget illustrations to show the default capacity of 16 running tasks and 32 queued, with depth-two scout/review nesting and bounded widget overflow. Move the widget to the README introduction and the Hub image into its own section. Generate fixtures from the scheduling defaults and retain explicit synthetic-data disclosures; runtime limits are unchanged.

- Simplify README installation and update guidance now that the repository rename is complete. Keep current npm/Git sources, duplicate-loading precautions and a link to the historical package migration instructions.

## [0.2.0]

Requires Node 22.19+ and stable Pi 1.5.2 or newer. Tested host: Pi 1.5.2; newer stable
hosts are allowed, not guaranteed compatible. The npm package remains `@howarewoo/pi-subagents`.

- Prepare the GitHub repository rename from `howarewoo/pi-extended-subagents` to `howarewoo/pi-subagents`: update canonical links, Git installation examples, package metadata and the release repository guard. The npm package remains `@howarewoo/pi-subagents`; the production entrypoint and runtime behavior are unchanged. The repository owner must coordinate the GitHub rename and verify npm trusted publishing before the next release; these external settings are not changed here.

- Simplify the README: put delegation examples before comparisons and architectural rationale, shorten repeated explanations, and make native controls and execution limits easier to scan. Preserve examples, section anchors and safety boundaries.
- Replace the README's unknown tintinweb messaging comparison with source-verified limited support: parent-to-child steering and result return, without built-in child-initiated or sibling messaging.
- Clarify in the README and advanced policy documentation that worktree lifecycle management is intentionally caller-owned, not a deferred extension feature; distinguish it from deferred filesystem isolation. Existing `cwd` support, parent permission hooks and global writer serialization are unchanged; workspace selection is not filesystem containment.
- Compact collapsed Delegate results to task headlines and statuses, keeping error and pause reasons visible. Use Pi’s global tool-output toggle (`Ctrl+O` by default, or the configured binding) to reveal detailed cards; model-facing results, saved artifacts and Subagent Hub behavior are unchanged.
- Enable child-local codemode for every subagent profile, including nested agents, when codemode is enabled in the parent. Scripts expose only child-authorized tools, with the `models` API disabled; existing permission hooks, workspace mapping, tool budgets and cancellation remain enforced. Failed or permission-blocked edits and writes do not trigger the prewalk model handoff.
- Remove persistent writer warnings from the pinned Subagents widget and Subagent Hub footer, freeing space for task activity. Keep the coordination caveat in Hub Details and the README; writer serialization is unchanged.
- Remove unused provider-secret bindings and credential examples from the Pullfrog workflow while retaining its OIDC App token integration.
- Create new task/generation, agent and transcript directories with private POSIX mode `0700`, preserving exclusive creation and `0600` outcome artifacts. Existing records and parent/global storage permissions are unchanged; Windows access control remains dependent on filesystem ACLs.
- Enforce live initiator/ancestor grant revocation for nested task-file reads, spawning and coordination before protected effects; malformed policy fails closed. Already in-flight work and accepted mailbox effects are not rolled back.

### Release isolation

- Separate release validation, human-protected npm publication and GitHub release creation into jobs with distinct credentials. Publish only the exact smoke-tested tarball after mandatory SHA-512 and release-identity verification; suppress npm lifecycle scripts.
- Repository owners must configure the `npm` environment approval and release-tag protections, and verify npm trusted publishing before a live release. These account settings are not configured by the workflow.

### Breaking — minimum supported Pi version

- Require stable Pi 1.5.2 or newer for delegated execution, including native and compatibility launches, resume, followup, revive and direct coordinator execution. Below-minimum, prerelease, malformed and unknown versions reject before task-file reads, child allocation, task-directory setup or child model requests, with an error naming the detected version and minimum stable version. Newer stable patch, minor and major versions are allowed; standard build metadata has equal precedence. Tested host remains Pi 1.5.2, not a compatibility guarantee for future allowed stable versions.
- Keep required wildcard host peers and pinned SDK development packages unchanged. Wildcard peers are a Pi packaging requirement, not a promise of support for every host. Root status, stop/cleanup and diagnostics remain usable where the host can load the extension; arbitrary ancient SDK module-load compatibility is not promised.
- Migration from 0.1.x: let active tasks drain, install stable Pi 1.5.2 or newer, update the extension to `@howarewoo/pi-subagents@0.2.0` and restart Pi. Shutdown or reload aborts and drains active children rather than migrating them.

## [0.1.1]

### Scoped npm package

- Rename the npm package from `pi-extended-subagents` to `@howarewoo/pi-subagents`. The GitHub repository and production entrypoint are unchanged; the package rename does not change runtime behavior.
- To prevent duplicate extension loading, run `pi remove npm:pi-extended-subagents`, then `pi install npm:@howarewoo/pi-subagents`, and restart Pi after active tasks finish.
- Tested host remains Pi 1.5.2; requires Node 22.19 or newer. Shutdown or reload aborts and drains active children rather than migrating them.

### Subagent terminology and command migration

- Standardize current UI and documentation on Subagent Hub, Subagent Profiles and one-word subagent terminology.
- Replace `/agent-hub`, `/task-profiles`, `/task-status`, `/task-steer` and `/task-stop` with `/subagent-hub`, `/subagent-profiles`, `/subagent-status`, `/subagent-steer` and `/subagent-stop`, respectively. Update saved instructions and command invocations; the old commands are not registered as aliases.
- Delegation APIs, permissions, lifecycle and control behavior are unchanged.

## [0.1.0]

Initial versioned release.

- Delegate single assignments and ordered batches through `delegate_task` and the native `subagent` interface.
- Use explicit role, tool, skill, model and nesting grants, with parent-owned permission hooks.
- Follow, steer and stop work in Agent Hub, with live transcripts and generation-pinned controls.
- Validate structured results and retain per-generation transcripts and artifacts.
- Serialize model-tool writers and abort/drain children when the parent shuts down or reloads.

### Compatibility and lifecycle

Tested against Pi 1.5.2; requires Node 22.19 or newer. Other Pi versions are not yet verified.
Only one extension providing `subagent` should be loaded. Updating does not migrate active tasks:
let them finish before updating, then restart Pi. Shutdown or reload aborts and drains children.
