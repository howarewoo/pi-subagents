# Security policy

## Reporting a vulnerability

Please report suspected security vulnerabilities privately through
[GitHub's vulnerability reporting form](https://github.com/howarewoo/pi-subagents/security/advisories/new).
Do not disclose vulnerabilities, credentials, or sensitive reproduction details in public
issues or pull requests.

Include the affected version, reproduction steps, and potential impact. Remove API keys,
tokens, personal data, and private repository content from logs and examples.

## Supported versions

Security fixes target the latest published release. Please upgrade to the latest release
before reporting a problem, when possible.

## Trust boundaries

This extension runs delegated agents with access to tools and local project content.
Treat tool access as a permission boundary, not as an operating-system sandbox. Review
agent permissions and only run the extension in projects you trust. Do not include secrets
in prompts, task files, or checked-in configuration.

## Local task storage

New task and successor-generation directories, including extension-owned `agent/` and
`transcripts/` directories, are created with POSIX mode `0700` (subject to further
restriction by the process umask). Fixed outcome artifacts retain exclusive publication
and mode `0600`. SDK transcript files remain SDK-managed; their enclosing private
directories restrict access by other OS users even under a permissive umask.

This applies only to newly created records. Historical records, existing files, parent
session directories and global storage permissions are not changed or migrated. Review
older records separately if they may contain sensitive prompts, tool output or results.
On Windows, Node's POSIX mode bits do not establish equivalent access control: privacy
depends on the account and inherited filesystem ACLs. These modes are not an ACL
framework or a sandbox against the same OS account, privileged processes, delegated
tools or external filesystem changes. Protect parent session storage accordingly.

## Profile fallback destinations

An operator-owned profile `fallback` chain explicitly authorizes sending the child's
conversation and tool results to each listed provider, subject to exact model/effort grants
and parent scopes. The `models` grant list alone never enables ordered routing. Project/task
inputs can narrow or disable a chain, not introduce or reorder providers. Review every
chain destination for the sensitivity of the task; never put credentials in chain settings.
Authentication stays in the parent registry and no parent router/config/state is inherited.

Retries and failed requests can incur provider charges. Every dispatched attempt uses the
same cumulative request budget and deadline ownership. Failed streamed drafts stay in raw
transcripts for audit, while append-only edits omit them from future model context. Completed
tool results are not replayed by SDK recovery, but no exactly-once external-effect guarantee
is made. Status/transcripts contain physical attempt and skip evidence and require the same
storage protection as other task output. Reset is an idle root-operator command, not model
or child-tool authority, and cannot replenish budgets or bypass revoked scopes/grants.
