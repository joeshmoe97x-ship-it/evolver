// Sample KNOWN_BEDROCK_ALIASES table for `make watch`.
//
// The watch script (evolver/scripts/bedrock-alias-watch.sh) reads this
// file via the MESSAGES_ROUTE_FILE env var and uses it as the canonical
// table to diff against the AWS doc fixture (dev-fixtures/aws.html).
//
// Edit this file in real time during a `make watch` session to add or
// remove entries, then watch the watch script alert you when the diff
// flips.
//
// The key format is `family/major/minor` and the value is the full
// Bedrock InvokeModel alias. The keys are bare (no dated suffix); the
// watch script detects dated revisions like `-20251201-v1:0` separately
// and reports them in the Slack payload's "dated revision" section.
const KNOWN_BEDROCK_ALIASES = Object.freeze({
  'opus/4/7': 'global.anthropic.claude-opus-4-7',
  'haiku/4/5': 'global.anthropic.claude-haiku-4-5-20251001-v1:0',
  'sonnet/4/6': 'global.anthropic.claude-sonnet-4-6',
});
