# dev-fixtures

Local-dev fixtures for `make watch` (which drives
`scripts/bedrock-alias-watch.sh` in a loop with a 60s interval).

For **quick-start commands** (`make watch`, `WATCH_INTERVAL=N make watch`,
`make watch-fresh`, `make watch-once`, `make watch-tail`), see the
[**"Local dev: `make watch`"**](../README.md#local-dev-make-watch) section
in the main README.

Edit these files in real time during a `make watch` session to simulate
AWS adding/removing model IDs:

- **`aws.html`** — mock AWS Bedrock "Supported foundation models" page.
  Add/remove `<li>global.anthropic.claude-…</li>` entries.
- **`messages_route.js`** — mock `KNOWN_BEDROCK_ALIASES` table. Keys are
  `family/major/minor`, values are the full Bedrock InvokeModel alias.
- **`state/`** — gitignored. Persisted watch state (seen keys, dated
  revisions, retirements) so re-runs are idempotent.
- **`.receiver.port`**, **`.receiver.pid`**, **`receiver.log`** —
  gitignored. Local Slack receiver bookkeeping.
