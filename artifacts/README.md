# artifacts/

Captured evidence from local CI runs of the `link-check` workflow —
recorded so the canonical green/red verdict at a given commit is durable
across sessions (the legacy `/tmp/ci-artifact/*.log` filesystems clear
on container restart, so anything we want to keep long-term lives here).

## Files

- **`link-check.log`** — Verbatim output of `npm run check-links` plus
  the canonical verdict from a local `act` run against
  `.github/workflows/link-check.yml`, captured against this branch's
  current `HEAD`. Regenerate locally with:

  ```bash
  npm run check-links                  # canonical local equivalent
  # OR
  act -W .github/workflows/link-check.yml -j link-check   # GHA-equivalent
  ```

  Either invocation should produce the same `PASS` verdict. If the
  verdict flips, edit the README files (don't edit the artifact log)
  to fix the regression and re-record.

## Why local and not GitHub-hosted run?

We don't push a durable green-log to GitHub Actions output as an
artifact; GitHub-Actions run logs are viewable but not archivable as
repo files. Promoting one local `act` invocation per commit into
`artifacts/` gives the repo a single canonical “this commit's link
audit was green” record, readable from any clone.

## Lifecycle

- Regenerate every time the README cross-link corpus or
  `scripts/check-readme-links.js` changes.
- Don't commit the log on every push — only when you've intentionally
  revalidated the corpus (e.g. after adding/removing language siblings,
  after fixing a stale anchor).
- The log is content, not configuration; an outdated version is
  infinitely preferable to no version. If unsure, commit anyway and
  overwrite next time.
