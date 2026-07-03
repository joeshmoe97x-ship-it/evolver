#!/usr/bin/env bash
#
# bedrock-alias-watch.sh — daily check for new Anthropic Bedrock model IDs.
#
# Fetches the AWS Bedrock "Supported foundation models" page, extracts every
# `*.anthropic.claude-{family}-{major}-{minor}` model ID, and posts a Slack
# message for any family/major/minor or dated-revision that KNOWN_BEDROCK_ALIASES
# in evolver/src/proxy/router/messages_route.js doesn't yet cover.
#
# Three diff layers (each suppresses the no-op cases):
#   (a) New family/major/minor: diffs AWS keys (family/major/minor) against
#       the JS table keys. This collapses `us.*` / `global.*` / `eu.*` /
#       `ap.*` regional siblings of the same model to one key, so the
#       canonicalizer at canonicalizeForBedrock() (which also keys on
#       family/major/minor) doesn't need per-region entries.
#   (b) Dated revision: a same-region full ID whose family/major/minor IS
#       already in the table but whose dated suffix is newer (e.g. AWS
#       ships `global.anthropic.claude-haiku-4-5-20251201-v1:0` while the
#       table still points at `-20251001-v1:0`). Without this pass, a
#       revision update would be silently missed and the proxy would keep
#       forwarding the OLD dated form to Bedrock.
#   (c) Retired: a family/major/minor in the table but no longer listed on
#       AWS. The canonicalizer would still try to rewrite inbounds to the
#       table's (now-Bedrock-rejected) value and Bedrock would 400 them,
#       so the operator needs to know to act — typically: remove the
#       entry. If the model later comes back to AWS, the seen_retired
#       entry is cleared so a future retirement re-alerts.
#   Cross-region siblings (AWS has `us.*` while the table has `global.*`
#   for the same family) are intentionally NOT alerted — the canonicalizer
#   already rewrites the inbound to the table's value.
#
# Regional prefix coverage: the regex prefix alternation comes from the
# BEDROCK_REGIONAL_PREFIXES env var (default global|us|eu|ap). AWS-side
# additions can be picked up by exporting the env var; KNOWN_BEDROCK_ALIASES
# entries whose prefix is not in the list trigger a WARN at the top of
# every run so the operator does not miss the gap.
#
# Crontab (06:00 daily in the system timezone — cron does NOT honor UTC):
#   0 6 * * *  /path/to/evolver/scripts/bedrock-alias-watch.sh >> $HOME/.local/state/evolver/bedrock-alias-watch.log 2>&1
#
# Env (required):
#   SLACK_WEBHOOK_URL   Incoming-webhook URL. Each webhook is bound to one
#                       channel. If unset, the new-ID list is written to
#                       stderr instead — cron then emails the local mailbox.
#
# Env (optional, with defaults):
#   MESSAGES_ROUTE_FILE   Path to messages_route.js
#                         (default: ../src/proxy/router/messages_route.js
#                         relative to this script).
#   AWS_BEDROCK_URL       Override the AWS doc URL
#                         (default: supported-models page).
#   STATE_DIR             Override state directory
#                         (default: ${XDG_STATE_HOME:-$HOME/.local/state}/evolver).
#   BEDROCK_REGIONAL_PREFIXES  | separated alternation of regional prefixes
#                              the script greps for and warns about
#                              (default: global|us|eu|ap). AWS-side
#                              additions (e.g. a future jp.*) can be
#                              picked up via this env var; KNOWN_BEDROCK_ALIASES
#                              entries whose prefix is not in the list trigger
#                              a WARN at the top of every run so the operator
#                              does not miss the gap.
#   DRY_RUN=1             Print new IDs but skip the Slack post AND skip
#                         the state-file update. Useful for testing.
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MESSAGES_ROUTE_FILE="${MESSAGES_ROUTE_FILE:-$SCRIPT_DIR/../src/proxy/router/messages_route.js}"
AWS_BEDROCK_URL="${AWS_BEDROCK_URL:-https://docs.aws.amazon.com/bedrock/latest/userguide/models-supported.html}"
STATE_DIR="${STATE_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/evolver}"
STATE_FILE="$STATE_DIR/bedrock-alias-watch.json"
LOCK_DIR="$STATE_DIR/bedrock-alias-watch.lock"

# Regional prefix alternation. The grep/sed regexes below use
# PREFIX_REGEX (the | separated alternation wrapped in (...) anchoring)
# rather than a hardcoded literal list. AWS-side additions (e.g. a future
# jp.* or me.*) can be picked up by exporting BEDROCK_REGIONAL_PREFIXES.
# The (...) wrapping matters: a bare `${BEDROCK_REGIONAL_PREFIXES}` would
# expand to `global|us|eu|ap` and parse as `global OR us OR eu OR ap` in
# sed (unanchored) instead of the intended `(global|us|eu|ap)`.
BEDROCK_REGIONAL_PREFIXES="${BEDROCK_REGIONAL_PREFIXES:-global|us|eu|ap}"
PREFIX_REGEX="(${BEDROCK_REGIONAL_PREFIXES})"

log() { printf '[%s] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >&2; }
die() { log "ERROR: $*"; exit 1; }

for cmd in curl jq grep sort comm mktemp; do
  command -v "$cmd" >/dev/null 2>&1 || die "missing required command: $cmd"
done

# Lock + trap BEFORE doing any work. The trap is installed first so a crash
# between any later command and the end of the script can't leak the lock.
# `rmdir "$LOCK_DIR" 2>/dev/null || true` is safe even when mkdir failed
# (the dir doesn't exist) or is foreign-owned (rmdir of a non-empty or
# foreign dir fails silently under `|| true`).
TMP_FILES=()
cleanup() { rm -f "${TMP_FILES[@]}" 2>/dev/null || true; rmdir "$LOCK_DIR" 2>/dev/null || true; }
trap cleanup EXIT

if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  log "another run is in progress; exiting"
  exit 0
fi

# --- 1. Parse KNOWN_BEDROCK_ALIASES from the JS source.
[[ -f "$MESSAGES_ROUTE_FILE" ]] || die "messages_route.js not found at $MESSAGES_ROUTE_FILE"
KNOWN_KEYS_FILE="$(mktemp)"; TMP_FILES+=("$KNOWN_KEYS_FILE")
grep -oE "'(opus|sonnet|haiku)/[0-9]+/[0-9]+'" "$MESSAGES_ROUTE_FILE" \
  | tr -d "'" | sort -u > "$KNOWN_KEYS_FILE"

KNOWN_FULL_FILE="$(mktemp)"; TMP_FILES+=("$KNOWN_FULL_FILE")
grep -oE "'${PREFIX_REGEX}\.anthropic\.claude-[a-z0-9.:-]+'" "$MESSAGES_ROUTE_FILE" \
  | tr -d "'" | sort -u > "$KNOWN_FULL_FILE"

# canon -> full_id map. Invariant: KNOWN_BEDROCK_ALIASES has exactly one
# entry per canon (family/major/minor), so each canon appears at most
# once below. The dated-revision loop relies on this to pick the right
# full ID for the prefix comparison.
KNOWN_MAP_FILE="$(mktemp)"; TMP_FILES+=("$KNOWN_MAP_FILE")
while IFS= read -r full_id; do
  canon="$(printf '%s' "$full_id" | sed -E "s/^${PREFIX_REGEX}\.anthropic\.claude-([a-z]+)-([0-9]+)-([0-9]+).*/\2\/\3\/\4/")"
  printf '%s|%s\n' "$canon" "$full_id"
done < "$KNOWN_FULL_FILE" > "$KNOWN_MAP_FILE"
log "known family/major/minor: $(wc -l < "$KNOWN_KEYS_FILE" | tr -d ' ')  full IDs: $(wc -l < "$KNOWN_FULL_FILE" | tr -d ' ')"

# --- 1b. Smoke check on KNOWN_BEDROCK_ALIASES: warn if any entry has a
#      regional prefix that is not in the configured BEDROCK_REGIONAL_PREFIXES.
#      If AWS adds `jp.*` (or similar) and an operator forgets to extend either
#      the env var or the table, this check catches it before the diff pass.
#      Backed by UNKNOWN_PREFIX_FILE + a single log() loop -- cheap even on
#      thousands of entries.
UNKNOWN_PREFIX_FILE="$(mktemp)"; TMP_FILES+=("$UNKNOWN_PREFIX_FILE")
while IFS= read -r full_id; do
  # `tr -d "'"` strips the JS single-quote artifacts the grep above emitted
  # so the prefix match works on a clean "global." / "us." token.
  normalised="$(printf '%s' "$full_id" | tr -d "'")"
  prefix="$(printf '%s' "$normalised" | cut -d. -f1)"
  # Match $prefix against the configured | separated literal list.
  # `printf | tr | grep -Fxq` is the bash-no-array idiom for "in list".
  if ! printf '%s\n' "$BEDROCK_REGIONAL_PREFIXES" | tr '|' '\n' | grep -Fxq "$prefix"; then
    printf '%s\n' "$normalised"
  fi
done < "$KNOWN_FULL_FILE" > "$UNKNOWN_PREFIX_FILE" || true
UNKNOWN_COUNT="$(wc -l < "$UNKNOWN_PREFIX_FILE" | tr -d ' ')"
if [[ "$UNKNOWN_COUNT" -gt 0 ]]; then
  log "WARN: $UNKNOWN_COUNT known alias(es) have a regional prefix not in BEDROCK_REGIONAL_PREFIXES (default: 'global|us|eu|ap'). Operator should review + extend BEDROCK_REGIONAL_PREFIXES if AWS added a new region:"
  while IFS= read -r unknown_id; do
    log "  - $unknown_id"
  done < "$UNKNOWN_PREFIX_FILE"
fi

# --- 2. Load previously-seen keys + dated IDs from the state file.
#      Backwards-compat: read either `seen_keys` (current) or `seen_ids`
#      (round-1 format) so existing state files aren't invalidated.
mkdir -p "$STATE_DIR"
SEEN_KEYS_FILE="$(mktemp)"; TMP_FILES+=("$SEEN_KEYS_FILE")
SEEN_DATED_FILE="$(mktemp)"; TMP_FILES+=("$SEEN_DATED_FILE")
SEEN_RETIRED_FILE="$(mktemp)"; TMP_FILES+=("$SEEN_RETIRED_FILE")
if [[ -f "$STATE_FILE" ]]; then
  jq -r '(.seen_keys // .seen_ids // empty)[]?' "$STATE_FILE" 2>/dev/null | sort -u > "$SEEN_KEYS_FILE" || true
  jq -r '(.seen_dated_ids // empty)[]?' "$STATE_FILE" 2>/dev/null | sort -u > "$SEEN_DATED_FILE" || true
  jq -r '(.seen_retired // empty)[]?' "$STATE_FILE" 2>/dev/null | sort -u > "$SEEN_RETIRED_FILE" || true
fi
log "previously seen: $(wc -l < "$SEEN_KEYS_FILE" | tr -d ' ') keys, $(wc -l < "$SEEN_DATED_FILE" | tr -d ' ') dated, $(wc -l < "$SEEN_RETIRED_FILE" | tr -d ' ') retired"

# --- 3. Fetch the AWS doc + extract both keys and full IDs.
HTML_FILE="$(mktemp)"; TMP_FILES+=("$HTML_FILE")
if ! curl -fsSL --max-time 30 "$AWS_BEDROCK_URL" -o "$HTML_FILE"; then
  log "WARN: AWS fetch failed; skipping (state NOT updated, will retry tomorrow)"
  exit 0
fi
AWS_KEYS_FILE="$(mktemp)"; TMP_FILES+=("$AWS_KEYS_FILE")
AWS_FULL_FILE="$(mktemp)"; TMP_FILES+=("$AWS_FULL_FILE")
grep -oE "${PREFIX_REGEX}\.anthropic\.claude-(opus|sonnet|haiku)-[0-9]+-[0-9]+" "$HTML_FILE" \
  | sed -E 's/.*claude-([a-z]+)-([0-9]+)-([0-9]+).*/\1\/\2\/\3/' | sort -u > "$AWS_KEYS_FILE"
grep -oE "${PREFIX_REGEX}\.anthropic\.claude-[a-z0-9.:-]+" "$HTML_FILE" | sort -u > "$AWS_FULL_FILE"
log "AWS-listed: $(wc -l < "$AWS_KEYS_FILE" | tr -d ' ') keys, $(wc -l < "$AWS_FULL_FILE" | tr -d ' ') full IDs"

# --- 4a. New family/major/minor: (AWS \ KNOWN) \ SEEN.
NEW_KEYS_FILE="$(mktemp)"; TMP_FILES+=("$NEW_KEYS_FILE")
comm -23 "$AWS_KEYS_FILE" "$KNOWN_KEYS_FILE" | comm -23 - "$SEEN_KEYS_FILE" > "$NEW_KEYS_FILE" || true
NEW_KEYS_COUNT="$(wc -l < "$NEW_KEYS_FILE" | tr -d ' ')"

# --- 4b. Dated revision: a same-region full ID whose family/major/minor
#         is already in the table but whose full ID is new.
#         Cross-region siblings (e.g. us.* when table has global.*) are
#         intentionally skipped — the canonicalizer handles them.
DATED_FILE="$(mktemp)"; TMP_FILES+=("$DATED_FILE")
while IFS= read -r aws_id; do
  # Skip if the full ID is already known
  grep -qx "$aws_id" "$KNOWN_FULL_FILE" && continue
  # Skip if the family/major/minor isn't in the table (handled by 4a)
  canon="$(printf '%s' "$aws_id" | sed -E "s/^${PREFIX_REGEX}\.anthropic\.claude-([a-z]+)-([0-9]+)-([0-9]+).*/\2\/\3\/\4/")"
  grep -qx "$canon" "$KNOWN_KEYS_FILE" || continue
  # Find the table's full ID for this family
  known_full="$(grep -E "^${canon}[|]" "$KNOWN_MAP_FILE" | head -1 | cut -d'|' -f2-)"
  [[ -z "$known_full" ]] && continue
  # Same regional prefix? → dated revision. Different? → cross-region
  # sibling — INTENTIONALLY SKIPPED: the canonicalizer rewrites the
  # inbound to the table's value regardless of the dated suffix, so
  # there's no table update to do. Alerting here would be a false positive.
  [[ "${aws_id%%.*}" != "${known_full%%.*}" ]] && continue
  # Skip if we've already alerted on this dated ID
  grep -qx "$aws_id" "$SEEN_DATED_FILE" && continue
  printf '%s|%s\n' "$canon" "$aws_id"
done < "$AWS_FULL_FILE" > "$DATED_FILE" || true
DATED_COUNT="$(wc -l < "$DATED_FILE" | tr -d ' ')"

# --- 4c. Retired: a family/major/minor in KNOWN_BEDROCK_ALIASES but no
#         longer listed on AWS. The canonicalizer would still try to
#         rewrite inbounds to the table's (now-Bedrock-rejected) value,
#         so the operator needs to know to remove the entry.
RETIRED_KEYS_FILE="$(mktemp)"; TMP_FILES+=("$RETIRED_KEYS_FILE")
comm -23 "$KNOWN_KEYS_FILE" "$AWS_KEYS_FILE" | comm -23 - "$SEEN_RETIRED_FILE" > "$RETIRED_KEYS_FILE" || true
RETIRED_COUNT="$(wc -l < "$RETIRED_KEYS_FILE" | tr -d ' ')"

log "diff: $NEW_KEYS_COUNT new key(s), $DATED_COUNT dated revision(s), $RETIRED_COUNT retired"

# --- 5. Notify if either diff has entries.
if [[ "$NEW_KEYS_COUNT" -gt 0 || "$DATED_COUNT" -gt 0 || "$RETIRED_COUNT" -gt 0 ]]; then
  MSG_FILE="$(mktemp)"; TMP_FILES+=("$MSG_FILE")
  {
    [[ "$NEW_KEYS_COUNT" -gt 0 ]] && {
      printf 'Anthropic Bedrock published %d new family/major/minor not yet in `KNOWN_BEDROCK_ALIASES`:\n' "$NEW_KEYS_COUNT"
      while IFS= read -r key; do printf '  • `%s`\n' "$key"; done < "$NEW_KEYS_FILE"
    }
    [[ "$DATED_COUNT" -gt 0 ]] && {
      printf '%d dated revision(s) of an existing family/major/minor — update the VALUE in the table:\n' "$DATED_COUNT"
      while IFS='|' read -r canon aws_id; do
        # Look up the table's current value for this family so the operator
        # can see at a glance what changed. Suffix is the part after
        # claude-{family}-{major}-{minor} — empty for bare IDs, "-YYYYMMDD-v1:0"
        # for dated forms. "<bare>" is shown for empty suffixes so the
        # was/now pair always has two visible values.
        old_full="$(grep -E "^${canon}[|]" "$KNOWN_MAP_FILE" | head -1 | cut -d'|' -f2-)"
        old_suffix="$(printf '%s' "$old_full" | sed -E 's/.*claude-[a-z]+-[0-9]+-[0-9]+//')"
        new_suffix="$(printf '%s' "$aws_id"  | sed -E 's/.*claude-[a-z]+-[0-9]+-[0-9]+//')"
        printf '  • `%s` — was: `%s`, now: `%s`\n' \
          "$canon" "${old_suffix:-<bare>}" "${new_suffix:-<bare>}"
      done < "$DATED_FILE"
    }
    [[ "$RETIRED_COUNT" -gt 0 ]] && {
      printf '%d family/major/minor no longer listed on AWS Bedrock (possibly retired — the canonicalizer would 400 inbounds to these):\n' "$RETIRED_COUNT"
      while IFS= read -r key; do
        # Look up the full ID for operator context. [\|] is a character class
        # containing the literal | (ERE alternation `|` would treat it as OR).
        full_id="$(grep -E "^${key}[|]" "$KNOWN_MAP_FILE" | head -1 | cut -d'|' -f2-)"
        printf '  • `%s` (was: `%s`)\n' "$key" "$full_id"
      done < "$RETIRED_KEYS_FILE"
    }
    # Per-section instructions are inline; the followup line is the
    # same regardless of which categories fired.
    printf 'See the per-section instructions above for the action to take on evolver/src/proxy/router/messages_route.js.\n'
  } > "$MSG_FILE"

  if [[ "${DRY_RUN:-0}" == "1" ]]; then
    log "DRY_RUN=1: would post the following to Slack:"
    cat "$MSG_FILE" >&2
  elif [[ -n "${SLACK_WEBHOOK_URL:-}" ]]; then
    PAYLOAD_FILE="$(mktemp)"; TMP_FILES+=("$PAYLOAD_FILE")
    jq -Rs '{text: .}' < "$MSG_FILE" > "$PAYLOAD_FILE"
    if curl -fsS --max-time 15 -X POST -H 'Content-Type: application/json' \
        --data @"$PAYLOAD_FILE" "$SLACK_WEBHOOK_URL" >/dev/null; then
      log "posted $((NEW_KEYS_COUNT + DATED_COUNT)) new entry/entries to Slack"
    else
      log "WARN: Slack post failed; entries:"
      cat "$MSG_FILE" >&2
    fi
  else
    log "SLACK_WEBHOOK_URL unset; entries (operator should configure webhook and update KNOWN_BEDROCK_ALIASES):"
    cat "$MSG_FILE" >&2
  fi
fi

# --- 6. Persist state — union of SEEN + AWS. Uses mktemp INSIDE STATE_DIR
#         so the final `mv` is a same-FS rename (atomic on POSIX) regardless
#         of whether /tmp is tmpfs.
if [[ "${DRY_RUN:-0}" == "1" ]]; then
  log "DRY_RUN=1: skipping state update"
  exit 0
fi
ALL_KEYS_FILE="$(mktemp)"; TMP_FILES+=("$ALL_KEYS_FILE")
cat "$SEEN_KEYS_FILE" "$AWS_KEYS_FILE" | sort -u > "$ALL_KEYS_FILE"
# seen_dated_ids ∪ (just the aws_id column from DATED_FILE)
NEW_DATED_IDS_FILE="$(mktemp)"; TMP_FILES+=("$NEW_DATED_IDS_FILE")
awk -F'|' '$2 != "" {print $2}' "$DATED_FILE" | sort -u > "$NEW_DATED_IDS_FILE"
ALL_DATED_FILE="$(mktemp)"; TMP_FILES+=("$ALL_DATED_FILE")
cat "$SEEN_DATED_FILE" "$NEW_DATED_IDS_FILE" | sort -u > "$ALL_DATED_FILE"
# seen_retired: union of (still-retired entries) ∪ (newly-retired keys).
# "still-retired" = (previous) ∩ KNOWN ∩ (not in AWS)
#   — drops entries that came back to AWS
#   — drops entries the operator removed from the table
# "newly-retired" = RETIRED_KEYS (just alerted above)
SEEN_RETIRED_NEXT_FILE="$(mktemp)"; TMP_FILES+=("$SEEN_RETIRED_NEXT_FILE")
comm -12 "$SEEN_RETIRED_FILE" "$KNOWN_KEYS_FILE" | comm -23 - "$AWS_KEYS_FILE" > "$SEEN_RETIRED_NEXT_FILE" || true
ALL_RETIRED_FILE="$(mktemp)"; TMP_FILES+=("$ALL_RETIRED_FILE")
cat "$SEEN_RETIRED_NEXT_FILE" "$RETIRED_KEYS_FILE" | sort -u > "$ALL_RETIRED_FILE"

TMP_STATE="$(mktemp "$STATE_DIR/.state.XXXXXX")"; TMP_FILES+=("$TMP_STATE")
jq -n --arg last_run "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
      --rawfile keys "$ALL_KEYS_FILE" \
      --rawfile dated "$ALL_DATED_FILE" \
      --rawfile retired "$ALL_RETIRED_FILE" \
      '{last_run: $last_run,
        seen_keys: ($keys    | split("\n") | map(select(length > 0))),
        seen_dated_ids: ($dated  | split("\n") | map(select(length > 0))),
        seen_retired: ($retired | split("\n") | map(select(length > 0)))}' \
  > "$TMP_STATE"
mv "$TMP_STATE" "$STATE_FILE"
log "state updated: $(jq '.seen_keys | length' "$STATE_FILE") keys, $(jq '.seen_dated_ids | length' "$STATE_FILE") dated, $(jq '.seen_retired | length' "$STATE_FILE") retired"
