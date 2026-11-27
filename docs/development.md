# Local development

This page is for contributors working from a source checkout. It also documents where subagent output is saved.

From a source checkout:

```sh
npm ci --ignore-scripts
npm run lint
npm run format:check
npm run typecheck
npm test
npm run exercise
npm pack --dry-run
npm run test:package
```

`npm run check` runs lint, formatting, typecheck, tests and the controlled SDK exercise.
`npm run test:package` packs the tarball, checks its files and installs it in a temporary
directory, then checks that the pinned Pi host loads the production entrypoint and registers
its tools and commands. It prefers the npm cache but may fetch registry metadata for runtime
dependencies. It does not use model credentials and leaves your Pi settings unchanged.

Oxlint checks correctness rules; warnings fail the lint command. Control-character regexes are allowed in tests, and in terminal rendering code through inline `oxlint-disable` comments, because they match ANSI escape sequences. Run `npm run lint:fix` for safe lint fixes and `npm run format` to apply Oxfmt formatting. Formatting skips the generated lockfile.

Load the production entrypoint with `pi -e /absolute/path/to/src/pi-extended-subagents.ts`. Tests and examples use controlled providers without credentials or live inference.

## Offline CLI walkthrough

Run this from the checkout in a disposable workspace. The controlled example deliberately starts a long background child; normal print-parent exit aborts it.

```sh
repo="$PWD"
root="$(mktemp -d)"
node_bin="$(command -v node)"
mkdir -p "$root/home" "$root/workspace"
(
  cd "$root/workspace"
  env -i PATH="$PATH" HOME="$root/home" PI_CODING_AGENT_DIR="$root/agent" PI_OFFLINE=1 \
    "$node_bin" "$repo/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js" \
    --offline --no-extensions --no-mcp --no-skills --no-prompt-templates \
    --no-themes --no-context-files --tools read,grep,find,ls,delegate_task \
    --session-dir "$root/sessions" -e "$repo/src/pi-extended-subagents.ts" \
    -e "$repo/examples/controlled-parent.ts" -p 'delegate example' </dev/null
)
# Inspect only these new files before removing the temporary walkthrough root:
find "$root/sessions/delegation" -name '*.jsonl'
rm -rf -- "$root"
```

The child's JSONL records `stopReason:aborted`. Do not install the controlled example as a production provider. This checks the SDK lifecycle, not live-provider reliability.

For the UI exercise, create `input.txt` in a disposable cwd. Run the local CLI with `--offline --no-extensions --no-mcp --no-skills --no-prompt-templates --no-context-files`, `-e /absolute/path/src/pi-extended-subagents.ts -e /absolute/path/examples/controlled-fleet.ts`, and tools `read,grep,find,ls,write,edit,bash,delegate_task,delegate_coordinate`. Enter `fleet example`, then `/subagent-hub`. `/fleet-theme dark` and `/fleet-theme light` switch themes. `fleet coordinate <JSON>` calls the coordination tool. The example writes `fleet-output.txt`; it is not loaded by the package manifest.

## Saved output

New files live under the parent session directory:

```text
delegation/<parent-session-id>/<task-id>/
  agent/                     # scoped child runtime cache location, no copied credentials
  transcripts/<new-id>.jsonl # actual SDK messages/tool results
  result.txt                 # complete last-assistant text after drain (when referenced)
  structured.json            # accepted JSON value, if supplied (when referenced)
```

Completed generations keep their own immutable files. New generations use `<task-id>-g<generation>/`. Old `extended-subagents-proof` data is left untouched and is not loaded or migrated. SDK hosts must emit the public shutdown lifecycle before disposal; bare `session.dispose()` does not perform that cleanup.
