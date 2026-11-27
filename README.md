# @howarewoo/pi-subagents

[![npm version](https://img.shields.io/npm/v/@howarewoo/pi-subagents)](https://www.npmjs.com/package/@howarewoo/pi-subagents)
[![npm downloads](https://img.shields.io/npm/dm/@howarewoo/pi-subagents)](https://www.npmjs.com/package/@howarewoo/pi-subagents)

A [Pi coding agent](https://pi.dev) extension that hands code exploration, reviews and implementation tasks to subagents you can watch, steer and stop while they run.

![Terminal illustration of Subagent Hub at default capacity: 48 tasks, with nested audit agents in the list and a synthetic capacity plan in the selected conversation.](docs/images/subagent-hub.svg)

_Subagent Hub with a synthetic fleet at the default capacity of 16 running and 32 queued tasks. Illustration from native renderer output, not a live load test._

## Why use it

Use it to supervise delegated work inside a running Pi session, in the checkout you already have open:

- [Subagent Hub](docs/hub.md) shows each subagent's conversation and tool calls with Pi's own renderers, and you can steer, message or stop a task from the same screen.
- Child tool calls go through the parent's permission hooks. Profiles cap which tools each role gets, and project settings or task requests can only narrow what the operator granted.
- Subagents use your selected model and effort unless an operator-approved override or a [profile-owned fallback chain](docs/configuration.md#profile-owned-model-chains) applies.
- With a `resultSchema`, the subagent has to submit a matching JSON value. Every task in a batch is checked before any of them starts, and one failure does not cancel the others.
- With explicit grants, parents, children and siblings can message each other while the parent runs.
- Orchestrating agents get a native `subagent` tool that runs tasks in the background and wakes the parent when they finish.

The extension does not create or clean up Git worktrees, run workflow scripts or schedules, keep tasks running after Pi exits, or sandbox the filesystem. Writers can run at the same time in one checkout, so you coordinate shared writes. If you need managed worktrees, durable background runs or opt-in sandboxing, one of the alternatives in the [feature comparison](docs/comparison.md) fits better.

## Project status

Actively maintained, with releases below 1.0 (the npm badge shows the current version). It needs Node 22.19 or newer and stable Pi 1.5.2 or newer, and is tested with Pi 1.6.0. Before 1.0, a minor release can change behavior, so read the [update notes](docs/installation.md#updates-and-rollback) before upgrading.

## Install

```sh
pi install npm:@howarewoo/pi-subagents
```

To install from Git instead, run `pi install git:github.com/howarewoo/pi-subagents`. Register only one source, or Pi loads the extension twice.

Restart Pi, then run `/subagent-profiles`. If it lists the `general`, `scout`, `review` and `implementation` profiles, the extension is loaded. See [installation and updates](docs/installation.md) for host version rules, pinned versions and rollback.

## Quick start

Start Pi in a project that has a `README.md` file, and choose a model with Pi's `/login` and `/model` commands. Subagents use that provider, so delegated requests can cost money. The extension never switches to a cheaper model on its own.

Ask Pi:

> Use delegate_task with profile scout to read README.md and summarize this project's purpose in three bullets. Run it in the foreground.

Pi makes this tool call:

```json
{
  "assignment": "Read README.md and summarize this project's purpose in three bullets",
  "profile": "scout",
  "background": false
}
```

The parent waits for the scout and then replies with its three-bullet summary. Run `/subagent-hub` to see the scout's conversation and its `read` call. The scout needs only Pi's default `read` tool, so you don't have to enable `grep`, `find`, `ls` or `bash`.

The extension adds three commands:

```text
/subagent-hub                     # watch, steer and control subagents
/subagent-profiles                # inspect or edit profiles
/subagent-stop <id> <generation>  # stop and drain one task
```

## Documentation

| Topic                                                      | What it covers                                                              |
| ---------------------------------------------------------- | --------------------------------------------------------------------------- |
| [Using delegation](docs/usage.md)                          | Batches, roles, background tasks, the `subagent` tool, messages, task files |
| [Subagent Hub](docs/hub.md)                                | The Hub, its keys and steering composer, and the pinned widget              |
| [Subagent Profiles](docs/profiles.md)                      | Browsing and editing profiles, model chains and grants                      |
| [Configuration](docs/configuration.md)                     | `delegation.json`, model chains, task limits and deadlines                  |
| [Shared checkout and lifetime](docs/workspaces.md)         | Workspaces, worktrees, parent lifetime and pairing with a scheduler         |
| [Installation and updates](docs/installation.md)           | Host support, install sources, updates, rollback and migration notes        |
| [Feature comparison](docs/comparison.md)                   | How this compares with three other Pi subagent extensions                   |
| [Architectural decisions](docs/design-decisions.md)        | Why the extension works the way it does                                     |
| [Delegation contract](docs/delegation-contract.md)         | Full reference for tools, permissions, lifecycle and storage                |
| [Advanced policies](docs/advanced-policies.md)             | Models, prewalk and unsupported capabilities                                |
| [Architecture](ARCHITECTURE.md)                            | How the implementation is put together                                      |
| [Verification](docs/verification.md)                       | Checks, terminal evidence and known limits                                  |
| [Local development](docs/development.md)                   | Building, testing, offline walkthroughs and saved output                    |
| [Releases](docs/releases.md) and [changelog](CHANGELOG.md) | Publishing process and user-facing changes                                  |
| [Parity inventory](docs/parity-inventory.md)               | Historical capability inventory                                             |
| [Provenance](docs/provenance.md)                           | Where reference behavior and adapted code come from                         |

## License

MIT. Includes a resource-loader shape adapted from Pi's SDK examples; see [LICENSE](LICENSE) and [third-party notices](THIRD_PARTY_NOTICES.md).
