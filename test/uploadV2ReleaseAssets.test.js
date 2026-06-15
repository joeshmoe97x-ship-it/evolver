'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  PUBLIC_REPO,
  V2_BINARIES,
  V2_MANIFEST,
  buildGhReleaseUploadArgs,
  normalizeTag,
  parseArgs,
  validateV2Assets,
} = require('../scripts/upload_v2_release_assets');

function sha256Text(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function makeAssetDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolver-v2-assets-'));
  const manifest = [];

  for (const fileName of V2_BINARIES) {
    const content = `binary:${fileName}`;
    const hash = sha256Text(content);
    fs.writeFileSync(path.join(dir, fileName), content);
    fs.writeFileSync(path.join(dir, `${fileName}.sha256`), `${hash}  ${fileName}\n`);
    manifest.push(`${hash}  ${fileName}`);
  }

  fs.writeFileSync(path.join(dir, V2_MANIFEST), `${manifest.join('\n')}\n`);
  return dir;
}

test('validateV2Assets accepts the expected v2 binary set and checksum manifest', () => {
  const dir = makeAssetDir();
  try {
    const result = validateV2Assets(dir);
    assert.equal(result.dir, dir);
    assert.equal(result.hashes.size, V2_BINARIES.length);
    assert.equal(result.uploadFiles.length, V2_BINARIES.length * 2 + 1);
    assert.deepEqual(
      result.uploadFiles.map((file) => path.basename(file)),
      V2_BINARIES.flatMap((fileName) => [fileName, `${fileName}.sha256`]).concat(V2_MANIFEST),
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('validateV2Assets rejects a sidecar that references the wrong filename', () => {
  const dir = makeAssetDir();
  try {
    const sidecar = path.join(dir, `${V2_BINARIES[0]}.sha256`);
    const hash = fs.readFileSync(sidecar, 'utf8').slice(0, 64);
    fs.writeFileSync(sidecar, `${hash}  other-file\n`);
    assert.throws(() => validateV2Assets(dir), /references other-file/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('validateV2Assets rejects symlinked release assets', () => {
  const dir = makeAssetDir();
  try {
    const target = path.join(dir, V2_BINARIES[0]);
    fs.unlinkSync(target);
    fs.symlinkSync(path.join(dir, V2_BINARIES[1]), target);
    assert.throws(() => validateV2Assets(dir), /must not be a symlink/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('validateV2Assets rejects a symlinked asset directory', () => {
  const dir = makeAssetDir();
  const link = path.join(os.tmpdir(), `evolver-v2-assets-link-${Date.now()}`);
  try {
    fs.symlinkSync(dir, link);
    assert.throws(() => validateV2Assets(link), /asset dir must not be a symlink/);
  } finally {
    if (fs.existsSync(link)) fs.unlinkSync(link);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('validateV2Assets rejects unexpected manifest entries', () => {
  const dir = makeAssetDir();
  try {
    const manifest = path.join(dir, V2_MANIFEST);
    fs.appendFileSync(manifest, `${sha256Text('x')}  evolver-v2-extra\n`);
    assert.throws(() => validateV2Assets(dir), /must contain exactly/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('buildGhReleaseUploadArgs pins uploads to EvoMap/evolver without shell interpolation', () => {
  const files = ['/tmp/a file', '/tmp/b'];
  const args = buildGhReleaseUploadArgs('v1.89.11', files, { clobber: true });
  assert.deepEqual(args, [
    'release',
    'upload',
    'v1.89.11',
    '/tmp/a file',
    '/tmp/b',
    '--repo',
    PUBLIC_REPO,
    '--clobber',
  ]);
});

test('normalizeTag requires a GitHub release-style semver tag', () => {
  assert.equal(normalizeTag('v1.89.11'), 'v1.89.11');
  assert.equal(normalizeTag('v1.89.11-beta.1'), 'v1.89.11-beta.1');
  assert.throws(() => normalizeTag('1.89.11'), /invalid --tag/);
  assert.throws(() => normalizeTag('v1.89;echo bad'), /invalid --tag/);
});

test('parseArgs treats --dry-run as explicit validate-only mode', () => {
  assert.deepEqual(parseArgs(['--tag=v1.89.11', '--yes', '--dry-run']), {
    assetDir: 'dist-binaries',
    tag: 'v1.89.11',
    yes: false,
    clobber: false,
    help: false,
  });
});
