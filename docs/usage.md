# Using delegation

This page shows how to call `delegate_task`, the native `subagent` tool and `delegate_coordinate`, and lists the extension's commands. The [delegation contract](delegation-contract.md) is the full reference.

## Batches, roles and notifications

Submit a batch for parallel read-only work:

```json
{
  "tasks": [
    { "assignment": "Locate startup code", "profile": "scout" },
    { "assignment": "Review lifecycle tests", "profile": "review", "limits": { "requests": 20 } }
  ],
  "background": false
}
```

The default is 16 concurrent tasks, a 32-item queue and up to 16 tasks per batch. Every item passes preflight before any starts. One failed task does not cancel its siblings.

`scout` and `review` allow up to `read`, `grep`, `find` and `ls`. `general` and `implementation` also allow `write`, `edit` and `bash`. Each role receives only the builtins already callable in the parent. With Pi's default tools, scouts get `read` only. Tool calls retain the parent's permission hooks; incompatible tool overrides are rejected.

`general` inherits available parent skills, not parent instructions or history. Its role prompt and assignment remain intact. Operator/trusted-project `tools` and `skills` settings can narrow inheritance; `[]` removes grants. General can write when its effective tool set allows it.

**Extension/MCP tools require operator review.** Set `general.leafTools` to exact names only for trusted tools that never call other Pi tools or change the tool/model/session loadout. Descriptions and annotations do not grant trust. Orchestrating/reaching tools, codemode, tool search, owned controls, hidden/model-only tools and builtin replacements cannot be forwarded. Leaf tools require the root workspace; only builtins support cwd adaptation. See [restricted inheritance](delegation-contract.md#restricted-general-inheritance).

Foreground calls return the final results. Set `background:true` to return immediately and receive one ordered completion message after the batch actually drains, automatically waking the owning parent (or queuing a follow-up if busy).
Direct `delegate_coordinate resume/followup/revive` and `subagent resume` likewise send one
wake-enabled outcome per new execution window; followup/revive identify the new generation.
Foreground calls add no extra notice; rejected calls add none. Paused, failed and cancelled
outcomes notify too, but do not authorize automatic resume. A wake requests a model turn,
not guaranteed task continuation. All notices remain parent-bound and are suppressed on
shutdown/reload; no polling or forced continuation loop is added.

## Commands

The extension adds three commands:

```text
/subagent-hub                     # watch, steer and control subagents
/subagent-profiles                # inspect or edit profiles
/subagent-stop <id> <generation>  # stop and drain one task
```

Open `/subagent-hub` to check status or steer a running task from its composer. Outside the TUI (RPC, JSON or print mode), `/subagent-hub` prints the current task list instead. For anything else, such as per-task status or a fallback reset, ask the orchestrator; it controls tasks with the `subagent` and `delegate_coordinate` tools.

**Removed commands:** `/subagent-status`, `/subagent-steer` and `/subagent-fallback-reset` no longer exist and have no aliases. Use Subagent Hub (or the non-TUI `/subagent-hub` list) for status, the Hub composer for steering, and ask the orchestrator to call `delegate_coordinate` `reset_fallback` for fallback resets.

## Native orchestration

Pi discovers the native `subagent` tool at startup through its tool description and coding-worker guidance; no enable call is needed. For replacement use, load only one extension providing `subagent`: Pi uses the first registration, not an automatic provider preference. Switching providers does not migrate or remove old runs.

```json
{
  "agent": "worker",
  "task": "Implement the approved change; follow the supplied repository guidelines and task references",
  "cwd": "/absolute/path/to/task-worktree"
}
```

- `worker` maps to the configured `implementation` profile; `scout`, `review` and `general` are also available.
- Calls are async by default and wake the parent after drain. Set `async:false` to wait; use `tasks:[{agent,task,cwd?}]` for a batch.
- Control a task with its returned `id` and `action:"status"`, `"steer"`, `"stop"` or `"resume"`. Steer/resume also require `message`.
- Resume continues a drained paused **or completed** conversation, preserving the same identity, generation, session count and full SDK conversation/tool history. Completed idle/parked agents restore their canonical session into a new SDK runtime using the same transcript, not a result summary. Missing restoration state, stopped identities, failed identities without a fallback reset, and retired descendants reject; there is no fresh-context fallback. Explicit `delegate_coordinate` followup/revive still start fresh work.

The coordinator supplies an existing workspace and the complete handoff, including accessible skill/reference paths. The extension does not create or manage worktrees. This is the [supported orchestration interface](delegation-contract.md#native-orchestration-compatibility), not compatibility with every competing workflow script or ambient Markdown agent definition.

## Messages and follow-up work

Use `delegate_coordinate` to message a running subagent, wait for an outcome or assign follow-up work. Include it in any explicit tool allowlist alongside `delegate_task`.

```json
{"action":"message","target":{"id":"<task-id>","generation":1},"text":"Check the shutdown path too","mode":"steer"}
{"action":"wait","target":{"id":"<task-id>","generation":1},"timeoutMs":30000}
{"action":"followup","target":{"id":"<task-id>","generation":1},"assignment":"Now review the cancellation path"}
```

Each line is a separate call. An accepted or queued message is not a delivery confirmation; even a delivered receipt does not prove the model understood it. Follow-ups start a new generation without replaying the old conversation, so include the context it needs. Follow-up and revival are model-tool operations, unavailable directly in Subagent Hub. Child messaging is off until explicitly granted. See the [coordination reference](delegation-contract.md#live-parent-messaging-waits-and-presence).

### Task files and structured results

Use `taskFile` instead of `assignment` to read instructions from a workspace-relative text file. Add `resultSchema` when you need a validated JSON value:

```json
{
  "taskFile": "tasks/review.txt",
  "profile": "review",
  "resultSchema": {
    "type": "object",
    "properties": { "summary": { "type": "string" } },
    "required": ["summary"],
    "additionalProperties": false
  }
}
```

Task files must be regular UTF-8 files of 1 to 50000 bytes, outside hidden paths and `node_modules`. Reads use the parent's permission hooks. Schema-required children call `submit_result({value:...})`; missing or invalid results fail visibly. See [supported schemas](delegation-contract.md#required-structured-results) and [task-file checks](delegation-contract.md#checked-task-file-input).
