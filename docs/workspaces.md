# Shared checkout, lifetime and scheduling

This page explains where subagents run, how long they live, and how to pair the extension with worktrees and a scheduler.

Subagents use your checkout unless you supply an existing directory as `cwd`. Parent permission hooks still apply and may deny access. **Writers and parent tools may run together**, bounded by ordinary FIFO capacity. Workspace selection is not a sandbox. Coordinate shared writes, including manual commands, external editors and other sessions. See [workspace safety](design-decisions.md#why-workspaces-are-caller-managed-and-writes-are-caller-coordinated).

Keep the parent runtime alive until work finishes. Shutdown or reload aborts and drains children; there is no restart recovery or cross-parent revival. Saved transcripts and results may contain sensitive task, tool and model output; protect them like your main Pi transcripts.

## Why worktrees are managed externally

Create or select a workspace externally, then pass `cwd` as in the
[native orchestration example](usage.md#native-orchestration). The caller owns it throughout the
assignment, including inspection, integration and removal. Automatic worktree creation,
commits, apply and cleanup are intentionally outside scope, not planned features.

Separate worktrees do not isolate shared external resources or provide a sandbox.
See [workspace ownership and writer coordination](design-decisions.md#why-workspaces-are-caller-managed-and-writes-are-caller-coordinated).

## Why workflows and scheduling stay external

Separate packages can compose the public delegation tools and own when and how to run
assignments within the parent runtime. This does not grant automatic tool/context
inheritance or promise compatibility with existing third-party workflow packages.
See [orchestration boundaries](design-decisions.md#why-orchestration-stays-with-the-caller).

Scheduling is left out on purpose, so any scheduling extension can run alongside this one
and be swapped for another. This extension registers no scheduling tool, timer or cron
state. A scheduler therefore cannot collide with its tool names or duplicate its timers,
and you are not locked in to one scheduler.

[`@howarewoo/pi-schedule`](https://github.com/howarewoo/pi-schedule) is one standalone
companion. It shares no code, imports, configuration or state with this extension, and
each works without the other:

```sh
pi install npm:@howarewoo/pi-schedule
```

For periodic orchestrator check-ins:

1. The parent launches async subagents with `subagent` (async by default) or a background
   `delegate_task` call, and keeps each returned `id`.
2. The parent schedules a check-in with pi-schedule's `schedule` tool. `cron` creates a
   recurring job; `in` (for example `"in": "30m"`, minimum 1 minute) creates a one-shot
   delay instead:

   ```json
   {
     "action": "create",
     "cron": "*/10 * * * *",
     "name": "subagent-checkin",
     "prompt": "Check each running subagent with action status and steer any that have stalled."
   }
   ```

3. When the job fires, the parent wakes and calls `subagent` with
   `{"action":"status","id":"<task id>"}`, then
   `{"action":"steer","id":"<task id>","message":"…"}` for a stalled worker, or
   `action:"stop"` for one that should not continue.
4. Completed subagents still wake the parent on their own. Once the batch has finished,
   the parent cancels the job with `schedule` `{"action":"cancel","id":"<job id>"}`
   (`{"action":"list"}` shows job ids), so no further turns fire.

Both extensions respect the same live-parent session lifetime, with no daemon or OS
crontab. Scheduled jobs fire only while the session that created them is running, just as
async subagents need their live parent. Quitting Pi stops jobs and aborts and drains
subagents. pi-schedule restores saved jobs when a session is reopened (`/reload`,
`/resume`, `pi -c`), but subagents aborted by shutdown or `/reload` are not revived, so
cancel check-ins left over from an earlier runtime. Schedule from the parent: subagents do
not load ambient extensions, so a child cannot call `schedule`. Every fire starts a parent
model turn and costs tokens.
