# Installation, updates and migrations

This page covers host requirements, install sources, updates, pinned versions and the breaking-change migration notes. For a first run, start with the [README quick start](../README.md#quick-start).

## Requirements and install sources

Requires **Node 22.19+** and **stable Pi 1.5.2 or newer**. Tested host: Pi 1.6.0;
other stable versions at or above the minimum are allowed, not guaranteed compatible. Prerelease, older, malformed
and unknown host versions are rejected before task reads, allocation or model requests.
Wildcard host peer dependencies follow Pi's package format, not a compatibility promise.
See [host support](delegation-contract.md#supported-host) for version rules.

If the host is unsupported, let active tasks drain, update Pi and restart. Status,
stop/cleanup and diagnostics remain available where the extension can load; arbitrary
older SDKs may fail at module load. The minimum-host restriction is a breaking change
in 0.2.0. When upgrading from 0.1.x, drain active tasks, install stable Pi 1.5.2 or newer,
update the extension and restart Pi.

Install from npm:

```sh
pi install npm:@howarewoo/pi-subagents
```

Alternatively, install from Git with `pi install git:github.com/howarewoo/pi-subagents`.
Use only one source: when switching between npm, Git or a local checkout, remove the
previously registered source first so Pi does not load the extension twice.

Restart Pi and run `/subagent-profiles` to check the installation.

### Migrate from the old package

If you installed the former unscoped package, follow the
[0.1.1 migration instructions](../CHANGELOG.md#011) before installing the current package.

## Updates and rollback

Let active subagents finish before updating, then restart Pi. Shutdown or `/reload` aborts
and drains children; active tasks are not migrated to the new version. There is no extension-owned
auto-updater.

```sh
# Update an unpinned npm installation
pi update npm:@howarewoo/pi-subagents

# Or update all installed extension packages
pi update --extensions
```

Plain `pi update` updates Pi itself, not installed extension packages. For a Git installation,
use `pi update git:github.com/howarewoo/pi-subagents`, matching the source you registered.
An unpinned Git source tracks the repository's default branch, including unreleased commits.

For a reproducible npm installation or rollback, select an exact published version:

```sh
pi install npm:@howarewoo/pi-subagents@0.5.0
```

For Git, select a published tag, for example
`pi install git:github.com/howarewoo/pi-subagents@v0.5.0`.
Exact npm versions and Git tags stay pinned; updating does not advance them to the next release.
Install a different version explicitly to change the pin.

[CHANGELOG.md](../CHANGELOG.md) lists user-facing changes and migrations. Pi shows new package
changelog entries on the next fresh launch after a version increase. See the
[maintainer release guide](releases.md) for publishing and recovery.

## Migration notes

**0.4.0 migration (breaking behavior):** native background/direct resume now wake the parent,
and followup/revive now notify and wake. This can add parent model turns and provider costs.
Drain active tasks, install `npm:@howarewoo/pi-subagents@0.4.0`, then restart Pi. Grants,
configuration and the stable Pi 1.5.2 minimum/tested host are unchanged. Updating a checkout
does not repair an already loaded runtime. See the [delegation contract](delegation-contract.md).

**0.5.0 migration (breaking):** subagents no longer pause after 30 minutes by default, and each
resume starts fresh request/tool budgets; set `"scheduling": {"deadlineMs": 1800000}` in
`~/.pi/agent/delegation.json` to keep the old pause. `/subagent-status` and `/subagent-steer`
are removed (see below), and Subagent Profiles edits now autosave per item. Drain active tasks,
install `npm:@howarewoo/pi-subagents@0.5.0`, then restart Pi. Existing configuration and the
stable Pi 1.5.2 minimum/tested host are unchanged. See [CHANGELOG.md](../CHANGELOG.md) for
rollback steps.
