'use strict';

// Node --test port of the bash test harness for evolver/scripts/bedrock-alias-watch.sh.
//
// Each test case spawns the bash script as a subprocess with a controlled
// environment, points it at a tmp-dir state file + a file://-URL mock
// AWS doc, and captures the result via a local Slack receiver (an
// http.createServer instance bound to 127.0.0.1).
//
// Same coverage as the bash version — 11 it() blocks across 9 conceptual
// runs (3b and 8b are idempotency re-runs of runs 3 and 8).
//
// Cleanup pattern: every test uses
//   let result;
//   try { result = await runWatch({...}); /* assertions */ }
//   finally { if (result) await result.cleanup(); }
// so a throw from runWatch() (port-in-use, disk full, bash not on PATH)
// doesn't NPE on `result.cleanup()` in the finally block.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { mkdtemp, writeFile, readFile, rm, mkdir } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const http = require('node:http');

const SCRIPT_PATH = join(__dirname, '..', 'scripts', 'bedrock-alias-watch.sh');

// Standard 3-key mock for KNOWN_BEDROCK_ALIASES — shared across all runs.
const MOCK_JS = `const KNOWN_BEDROCK_ALIASES = Object.freeze({
  'opus/4/7': 'global.anthropic.claude-opus-4-7',
  'haiku/4/5': 'global.anthropic.claude-haiku-4-5-20251001-v1:0',
  'sonnet/4/6': 'global.anthropic.claude-sonnet-4-6',
});
`;

// Start a Slack receiver on a random localhost port. Each POST body's
// raw bytes are appended to `requests`. Returns a `close()` function
// the caller MUST call to release the port.
function startSlackReceiver() {
  return new Promise((resolve, reject) => {
    const requests = [];
    const server = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        requests.push(Buffer.concat(chunks).toString('utf8'));
        res.writeHead(200);
        res.end('ok');
      });
      req.on('error', () => { /* ignore client-side errors */ });
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        port,
        requests,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

// Spawn the watch script with the given mock HTML, optional pre-seeded
// state, and extra env vars. Returns {code, stdout, stderr, requests,
// finalState, stateFile, cleanup}. The caller MUST await `cleanup()`
// to release the port and remove the tmp dir.
async function runWatch({ mockHtml, preState, extraEnv = {} }) {
  // Accumulate cleanup functors as resources are created. If anything
  // between `mkdtemp` and a successful return throws, we run them all
  // and re-throw — the caller never sees a half-initialized result.
  const cleanups = [];
  const register = (fn) => { cleanups.push(fn); };
  const runCleanups = async () => {
    while (cleanups.length) {
      const fn = cleanups.pop();
      try { await fn(); } catch (_) { /* best-effort */ }
    }
  };

  const testRoot = await mkdtemp(join(tmpdir(), 'bedrock-alias-watch-'));
  register(() => rm(testRoot, { recursive: true, force: true }));
  const stateDir = join(testRoot, 'state');
  await mkdir(stateDir, { recursive: true });
  const stateFile = join(stateDir, 'bedrock-alias-watch.json');
  const jsPath = join(testRoot, 'messages_route.js');
  const htmlPath = join(testRoot, 'aws.html');
  await writeFile(jsPath, MOCK_JS);
  await writeFile(htmlPath, mockHtml);
  if (preState !== undefined) {
    await writeFile(stateFile, JSON.stringify(preState));
  }

  let code, stdout, stderr, slack, finalState = null;
  try {
    slack = await startSlackReceiver();
    register(() => slack.close());

    ({ code, stdout, stderr } = await new Promise((resolve, reject) => {
      const child = spawn('bash', [SCRIPT_PATH], {
        env: {
          ...process.env,
          STATE_DIR: stateDir,
          MESSAGES_ROUTE_FILE: jsPath,
          AWS_BEDROCK_URL: `file://${htmlPath}`,
          SLACK_WEBHOOK_URL: `http://127.0.0.1:${slack.port}/slack`,
          ...extraEnv,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let _stdout = '';
      let _stderr = '';
      child.stdout.on('data', (c) => { _stdout += c; });
      child.stderr.on('data', (c) => { _stderr += c; });
      child.on('error', reject);
      child.on('close', (code) => resolve({ code, stdout: _stdout, stderr: _stderr }));
    }));

    // Read the final state file. Returns null if the script didn't
    // create it (DRY_RUN, AWS fetch fail, etc.).
    try {
      finalState = JSON.parse(await readFile(stateFile, 'utf8'));
    } catch (_) { /* file may not exist */ }
  } catch (err) {
    // Anything between mkdtemp and the successful return failed (EADDRINUSE,
    // bash not on PATH, spawn EACCES, etc.). Clean up everything we
    // created and re-throw so the test's `finally` doesn't have to
    // handle a half-initialized result.
    await runCleanups();
    throw err;
  }

  return {
    code, stdout, stderr,
    requests: slack.requests,
    finalState,
    stateFile,
    cleanup: runCleanups,
  };
}

// Helper: parse the last Slack POST body as JSON. Returns null if no
// posts were made or the last body wasn't valid JSON.
function lastSlackPayload(requests) {
  if (requests.length === 0) return null;
  const raw = requests[requests.length - 1];
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (_) { return null; }
}

describe('bedrock-alias-watch.sh', () => {
  // --- Run 1: first run should detect sonnet-4-7 as new and post to Slack.
  //     us.*-prefixed opus-4-7 is the regional sibling of an existing key,
  //     so it should NOT appear in the alert.
  it('Run 1: first run detects sonnet-4-7 as new, us.* opus-4-7 suppressed', async () => {
    const mockHtml = [
      '<html><body>',
      '<li>global.anthropic.claude-opus-4-7</li>',
      '<li>us.anthropic.claude-opus-4-7-20251001-v1:0</li>',
      '<li>global.anthropic.claude-haiku-4-5-20251001-v1:0</li>',
      '<li>global.anthropic.claude-sonnet-4-6</li>',
      '<li>global.anthropic.claude-sonnet-4-7</li>',
      '<li>meta.llama3-70b-instruct-v1:0</li>',
      '</body></html>',
    ].join('\n');

    let result;
    try {
      result = await runWatch({ mockHtml });
      assert.equal(result.code, 0, `script exited non-zero: ${result.stderr}`);
      const payload = lastSlackPayload(result.requests);
      assert.ok(payload, 'expected at least 1 Slack post');
      assert.match(payload.text, /sonnet\/4\/7/);
      assert.doesNotMatch(payload.text, /opus\/4\/7/);
      assert.match(payload.text, /KNOWN_BEDROCK_ALIASES/);
      // State file: 4 seen_keys (3 known + sonnet-4-7), 0 seen_dated_ids.
      assert.equal(result.finalState.seen_keys.length, 4);
      assert.ok(result.finalState.seen_keys.includes('sonnet/4/7'));
      assert.equal(result.finalState.seen_dated_ids.length, 0);
    } finally { if (result) await result.cleanup(); }
  });

  // --- Run 2: idempotency — same fixture, no new Slack post.
  //     Runs the script twice: first populates state, second uses it
  //     as preState to verify idempotency.
  it('Run 2: re-run with same fixture is idempotent', async () => {
    const mockHtml = [
      '<html><body>',
      '<li>global.anthropic.claude-opus-4-7</li>',
      '<li>us.anthropic.claude-opus-4-7-20251001-v1:0</li>',
      '<li>global.anthropic.claude-haiku-4-5-20251001-v1:0</li>',
      '<li>global.anthropic.claude-sonnet-4-6</li>',
      '<li>global.anthropic.claude-sonnet-4-7</li>',
      '</body></html>',
    ].join('\n');

    let first = null;
    let second = null;
    let preState = null;
    try {
      // First run populates state.
      first = await runWatch({ mockHtml });
      assert.equal(first.code, 0, `first run exited non-zero: ${first.stderr}`);
      assert.equal(first.requests.length, 1, 'first run should post 1 Slack message');
      preState = first.finalState;
      assert.ok(preState, 'first run should create state file');
      assert.ok(preState.seen_keys.includes('sonnet/4/7'));
      // Release the first run's resources before starting the second.
      await first.cleanup();
      first = null;

      // Second run with same fixture + pre-seeded state — no new post.
      second = await runWatch({ mockHtml, preState });
      assert.equal(second.code, 0, `second run exited non-zero: ${second.stderr}`);
      assert.equal(second.requests.length, 0, 'second run should not post to Slack');
    } finally {
      if (first) await first.cleanup();
      if (second) await second.cleanup();
    }
  });

  // --- Run 3: AWS adds a new family (sonnet-4-8) AND a dated revision
  //     (haiku-4-5-20251201). Expect ONE Slack post that mentions both.
  //     preState mirrors what Run 1 produced (3 known keys + sonnet-4-7),
  //     so sonnet-4-8 is the new family and the dated haiku revision
  //     hasn't been seen yet.
  it('Run 3: AWS adds sonnet-4-8 + dated haiku revision, single post mentions both with was/now', async () => {
    const preState = {
      last_run: '2026-07-02T00:00:00Z',
      seen_keys: ['opus/4/7', 'haiku/4/5', 'sonnet/4/6', 'sonnet/4/7'],
      seen_dated_ids: [],
      seen_retired: [],
    };
    const mockHtml = [
      '<html><body>',
      '<li>global.anthropic.claude-opus-4-7</li>',
      '<li>us.anthropic.claude-opus-4-7-20251001-v1:0</li>',
      '<li>global.anthropic.claude-haiku-4-5-20251001-v1:0</li>',
      '<li>global.anthropic.claude-sonnet-4-6</li>',
      '<li>global.anthropic.claude-sonnet-4-7</li>',
      '<li>global.anthropic.claude-sonnet-4-8</li>',
      '<li>global.anthropic.claude-haiku-4-5-20251201-v1:0</li>',
      '<li>meta.llama3-70b-instruct-v1:0</li>',
      '</body></html>',
    ].join('\n');

    let result;
    try {
      result = await runWatch({ mockHtml, preState });
      assert.equal(result.code, 0, `script exited non-zero: ${result.stderr}`);
      assert.equal(result.requests.length, 1, 'expected exactly 1 Slack post');
      const payload = JSON.parse(result.requests[0]);
      assert.match(payload.text, /sonnet\/4\/8/, 'should mention new family');
      assert.match(payload.text, /20251201-v1:0/, 'should mention NEW dated suffix');
      assert.match(payload.text, /20251001-v1:0/, 'should mention OLD dated suffix (was/now)');
      assert.match(payload.text, /haiku\/4\/5/, 'should mention canon (haiku/4/5)');
      assert.match(payload.text, /dated revision/, 'should have "dated revision" header');
      assert.doesNotMatch(payload.text, /sonnet\/4\/7/, 'should NOT re-alert sonnet/4/7');
      // State tracks the new dated ID + the new family.
      assert.ok(result.finalState.seen_dated_ids.includes('global.anthropic.claude-haiku-4-5-20251201-v1:0'));
      assert.ok(result.finalState.seen_keys.includes('sonnet/4/8'));
    } finally { if (result) await result.cleanup(); }
  });

  // --- Run 3b: idempotency for the dated revision — re-run with same
  //     fixture, no new post.
  it('Run 3b: re-run after dated-revision alert is idempotent', async () => {
    const preState = {
      last_run: '2026-07-02T00:00:00Z',
      seen_keys: ['opus/4/7', 'haiku/4/5', 'sonnet/4/6', 'sonnet/4/7', 'sonnet/4/8'],
      seen_dated_ids: ['global.anthropic.claude-haiku-4-5-20251201-v1:0'],
      seen_retired: [],
    };
    const mockHtml = [
      '<html><body>',
      '<li>global.anthropic.claude-opus-4-7</li>',
      '<li>global.anthropic.claude-haiku-4-5-20251001-v1:0</li>',
      '<li>global.anthropic.claude-sonnet-4-6</li>',
      '<li>global.anthropic.claude-sonnet-4-7</li>',
      '<li>global.anthropic.claude-sonnet-4-8</li>',
      '</body></html>',
    ].join('\n');

    let result;
    try {
      result = await runWatch({ mockHtml, preState });
      assert.equal(result.requests.length, 0, 'dated revision should not re-alert');
    } finally { if (result) await result.cleanup(); }
  });

  // --- Run 4: DRY_RUN=1 should print but not post / not update state.
  it('Run 4: DRY_RUN=1 prints to stderr but does not post or persist', async () => {
    const mockHtml = [
      '<html><body>',
      '<li>global.anthropic.claude-opus-4-7</li>',
      '<li>global.anthropic.claude-haiku-4-5-20251001-v1:0</li>',
      '<li>global.anthropic.claude-sonnet-4-6</li>',
      '<li>global.anthropic.claude-sonnet-4-7</li>',
      '<li>global.anthropic.claude-sonnet-4-8</li>',
      '<li>global.anthropic.claude-haiku-4-5-20251201-v1:0</li>',
      '<li>global.anthropic.claude-opus-4-9</li>',
      '</body></html>',
    ].join('\n');

    let result;
    try {
      result = await runWatch({ mockHtml, extraEnv: { DRY_RUN: '1' } });
      assert.equal(result.code, 0);
      assert.equal(result.requests.length, 0, 'DRY_RUN should not post to Slack');
      assert.match(result.stderr, /opus\/4\/9/, 'DRY_RUN should print new key to stderr');
      // State file should NOT be created in DRY_RUN mode (script exits
      // before step 6).
      assert.equal(result.finalState, null, 'DRY_RUN should not create state file');
    } finally { if (result) await result.cleanup(); }
  });

  // --- Run 5: AWS fetch fails → script exits 0 + state NOT updated.
  it('Run 5: AWS fetch fails, exits 0, no post, no state update, logs WARN', async () => {
    let result;
    try {
      result = await runWatch({
        mockHtml: '<html></html>', // not used — fetch fails before reading
        extraEnv: { AWS_BEDROCK_URL: 'file:///nonexistent-path-that-does-not-exist' },
      });
      assert.equal(result.code, 0, 'fetch-failure path should exit 0');
      assert.equal(result.requests.length, 0, 'fetch failure should not post to Slack');
      assert.match(result.stderr, /AWS fetch failed/, 'should log AWS fetch failed');
      assert.equal(result.finalState, null, 'fetch failure should not create state file');
    } finally { if (result) await result.cleanup(); }
  });

  // --- Run 6: SLACK_WEBHOOK_URL unset → new IDs land on stderr, state still updates.
  it('Run 6: SLACK_WEBHOOK_URL unset writes new IDs to stderr + still persists state', async () => {
    const mockHtml = [
      '<html><body>',
      '<li>global.anthropic.claude-opus-4-7</li>',
      '<li>global.anthropic.claude-haiku-4-5-20251001-v1:0</li>',
      '<li>global.anthropic.claude-sonnet-4-6</li>',
      '<li>global.anthropic.claude-sonnet-4-7</li>',
      '<li>global.anthropic.claude-sonnet-4-10</li>',
      '</body></html>',
    ].join('\n');

    let result;
    try {
      result = await runWatch({ mockHtml, extraEnv: { SLACK_WEBHOOK_URL: '' } });
      assert.equal(result.code, 0);
      assert.equal(result.requests.length, 0, 'unset Slack should not post');
      assert.match(result.stderr, /sonnet\/4\/10/, 'should log sonnet/4/10 to stderr');
      assert.match(result.stderr, /SLACK_WEBHOOK_URL unset/, 'should log the unset message');
      // State should still be updated with the new key.
      assert.ok(result.finalState, 'unset Slack should still create state file');
      assert.ok(result.finalState.seen_keys.includes('sonnet/4/10'));
    } finally { if (result) await result.cleanup(); }
  });

  // --- Run 7: backwards-compat — round-1 `seen_ids` state file is loaded
  //     and suppresses alerts for both sonnet-4-7 + opus-4-9 (0 Slack posts).
  it('Run 7: backwards-compat — round-1 `seen_ids` state file suppresses alerts + migrates to `seen_keys`', async () => {
    const preState = {
      last_run: '2026-01-01T00:00:00Z',
      seen_ids: ['sonnet/4/7', 'opus/4/9'],
    };
    const mockHtml = [
      '<html><body>',
      '<li>global.anthropic.claude-opus-4-7</li>',
      '<li>global.anthropic.claude-haiku-4-5-20251001-v1:0</li>',
      '<li>global.anthropic.claude-sonnet-4-6</li>',
      '<li>global.anthropic.claude-sonnet-4-7</li>',
      '<li>global.anthropic.claude-opus-4-9</li>',
      '</body></html>',
    ].join('\n');

    let result;
    try {
      result = await runWatch({ mockHtml, preState });
      assert.equal(result.code, 0);
      assert.equal(result.requests.length, 0, 'backwards-compat should suppress sonnet-4-7 + opus-4-9');
      // State should be rewritten in the new format + old seen_ids migrated.
      assert.ok(result.finalState, 'state file should be rewritten');
      assert.ok(result.finalState.seen_keys.includes('sonnet/4/7'),
        'seen_ids sonnet/4/7 should be migrated to seen_keys');
      assert.ok(result.finalState.seen_keys.includes('opus/4/9'),
        'seen_ids opus/4/9 should be migrated to seen_keys');
      assert.ok('seen_dated_ids' in result.finalState,
        'rewritten state file should have seen_dated_ids field');
    } finally { if (result) await result.cleanup(); }
  });

  // --- Run 8: retirement — KNOWN has sonnet-4-6, AWS no longer lists it.
  //     Expected: 1 Slack post with a "retired" section for sonnet/4/6,
  //     and the state file's seen_retired tracks it.
  it('Run 8: AWS doc removes sonnet-4-6, posts retirement alert with full ID context', async () => {
    const preState = {
      last_run: '2026-07-02T00:00:00Z',
      seen_keys: ['opus/4/7', 'haiku/4/5', 'sonnet/4/6', 'sonnet/4/7', 'sonnet/4/8'],
      seen_dated_ids: ['global.anthropic.claude-haiku-4-5-20251201-v1:0'],
      seen_retired: [],
    };
    const mockHtml = [
      '<html><body>',
      '<li>global.anthropic.claude-opus-4-7</li>',
      '<li>global.anthropic.claude-haiku-4-5-20251001-v1:0</li>',
      '<li>global.anthropic.claude-sonnet-4-7</li>',
      '</body></html>',
    ].join('\n');

    let result;
    try {
      result = await runWatch({ mockHtml, preState });
      assert.equal(result.code, 0);
      assert.equal(result.requests.length, 1, 'expected exactly 1 Slack post');
      const payload = JSON.parse(result.requests[0]);
      assert.match(payload.text, /sonnet\/4\/6/, 'should mention retired canon');
      assert.match(payload.text, /retired/, 'should have "retired" section header');
      assert.match(payload.text, /global\.anthropic\.claude-sonnet-4-6/,
        'should include the operator-context full ID');
      assert.doesNotMatch(payload.text, /sonnet\/4\/7/, 'should NOT re-alert sonnet/4/7');
      // State should track the retirement.
      assert.ok(result.finalState.seen_retired.includes('sonnet/4/6'));
    } finally { if (result) await result.cleanup(); }
  });

  // --- Run 8b: idempotency — re-run with same fixture, no new Slack post.
  it('Run 8b: re-run after retirement alert is idempotent', async () => {
    const preState = {
      last_run: '2026-07-02T00:00:00Z',
      seen_keys: ['opus/4/7', 'haiku/4/5', 'sonnet/4/6', 'sonnet/4/7', 'sonnet/4/8'],
      seen_dated_ids: [],
      seen_retired: ['sonnet/4/6'],
    };
    const mockHtml = [
      '<html><body>',
      '<li>global.anthropic.claude-opus-4-7</li>',
      '<li>global.anthropic.claude-haiku-4-5-20251001-v1:0</li>',
      '<li>global.anthropic.claude-sonnet-4-7</li>',
      '</body></html>',
    ].join('\n');

    let result;
    try {
      result = await runWatch({ mockHtml, preState });
      assert.equal(result.requests.length, 0, 'retirement should not re-alert');
    } finally { if (result) await result.cleanup(); }
  });

  // --- Run 9: came back — state file has sonnet-4-6 in seen_retired,
  //     but AWS now lists it again. Expected: no retirement alert, AND
  //     seen_retired is cleared so a future retirement re-alerts.
  it('Run 9: sonnet-4-6 comes back to AWS, no alert, seen_retired cleared', async () => {
    const preState = {
      last_run: '2026-01-01T00:00:00Z',
      seen_keys: [],
      seen_dated_ids: [],
      seen_retired: ['sonnet/4/6'],
    };
    const mockHtml = [
      '<html><body>',
      '<li>global.anthropic.claude-opus-4-7</li>',
      '<li>global.anthropic.claude-haiku-4-5-20251001-v1:0</li>',
      '<li>global.anthropic.claude-sonnet-4-6</li>',
      '</body></html>',
    ].join('\n');

    let result;
    try {
      result = await runWatch({ mockHtml, preState });
      assert.equal(result.code, 0);
      assert.equal(result.requests.length, 0, 'came back should not trigger retirement alert');
      assert.equal(result.finalState.seen_retired.length, 0,
        'seen_retired should be cleared after came back');
    } finally { if (result) await result.cleanup(); }
  });
});
