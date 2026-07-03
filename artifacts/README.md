# artifacts/

Captured evidence from the strict `link-check` and slim `link-check-dev`
GitHub-Actions workflows. Each workflow run writes a per-branch log
to the runner workspace AND publishes it as a GitHub-Actions artifact
(downloadable from the PR's "Checks → Artifacts" tab), so multiple
concurrent PRs each get their own distinct capture rather than fighting
over a single shared file.

## Layout

- **`main/link-check.log`** — strict-workflow capture for push-to-main
  runs. Auto-committed to this directory by the
  `link-check.yml → link-check-link-check → Auto-commit capture to main`
  step after every push-to-main, so the canonical green/red verdict
  at HEAD is durable across sessions. The previous single-root
  `link-check.log` was migrated here.

- **`<branch>/link-check.log`** (PR runs) and **`<branch>/dev-check.log`**
  (PR runs that touch `scripts/**`, captured by the dev-only workflow)
  — per-PR captures that live in the runner workspace during the run
  AND as `link-check-<branch>` / `link-check-dev-<branch>` GH artifacts
  afterwards. The runner copies are not committed (GITHUB_TOKEN on
  `pull_request` events is read-only by default); the GH-artifact
  download is the durable record for reviewers.

## Why per-branch instead of single-root

A single shared root file works for one branch at a time. With multiple
concurrent PRs each generating captures, the root would conflict and
lose history. The per-branch namespace keeps each PR's log distinct,
provides a stable artifact name (`link-check-<branch>`) that reviewers
can link to directly from PR conversations, and aligns the in-runner
layout with the GH-artifact namespace so a single mental model covers
both surfaces.

## Lifecycle

- The `main/link-check.log` file is overwritten on every push-to-main
  by the strict workflow's auto-commit step. Pushing the auto-commit
  back to `main` does not loop the workflow: the commit message
  includes `[skip ci]` which GitHub Actions honors.
- PR-side captures live in the runner and as GH artifacts. The
  dev-only workflow's best-effort `git push` to the PR source branch
  is non-fatal — usually denied by the read-only PR-scoped token,
  and that's expected; the upload-artifact is the durable record.
- Regenerate `main/link-check.log` locally with the same commands
  we've always used:
  ```bash
  npm run check-links                                       # canonical local equivalent
  act -W .github/workflows/link-check.yml -j link-check      # GHA-equivalent
  # OR for the dev-only workflow:
  act -W .github/workflows/link-check-dev.yml -j link-check-dev   # dev-only slim
  ```
- The log is content, not configuration; an outdated version is
  infinitely preferable to no version. Commit anyway if you have
  intentionally revalidated the corpus.
