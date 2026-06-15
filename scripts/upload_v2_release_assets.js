#!/usr/bin/env node
'use strict';

/*
 * Upload Evolver v2 standalone binaries to the public EvoMap/evolver release.
 *
 * The v2 binaries are built in the private v2 repo and copied here only as
 * release artifacts. This script deliberately does not use shell globs: it
 * verifies the exact expected filenames and SHA256 sidecars before invoking
 * `gh release upload`.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const PUBLIC_REPO = 'EvoMap/evolver';
const DEFAULT_ASSET_DIR = 'dist-binaries';

const V2_BINARIES = [
  'evolver-v2-darwin-arm64',
  'evolver-v2-darwin-x64',
  'evolver-v2-linux-x64',
  'evolver-v2-linux-arm64',
  'evolver-v2-windows-x64.exe',
];

const V2_MANIFEST = 'SHA256SUMS-v2.txt';
const TAG_RE = /^v\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
const SHA256_LINE_RE = /^([a-f0-9]{64})  ([^/\\\s]+)$/;

function usage() {
  return [
    'Usage:',
    '  node scripts/upload_v2_release_assets.js --tag=v1.89.11 --asset-dir=/path/to/v2/dist-binaries',
    '  node scripts/upload_v2_release_assets.js --tag=v1.89.11 --asset-dir=/path/to/v2/dist-binaries --yes',
    '',
    'Default mode validates and prints the gh command without uploading.',
    'Use --yes to upload to EvoMap/evolver GitHub Release assets.',
    '',
    'Options:',
    '  --tag=<tag>          GitHub release tag, for example v1.89.11',
    `  --asset-dir=<dir>    Directory containing v2 assets (default: ${DEFAULT_ASSET_DIR})`,
    '  --yes                Actually run gh release upload after validation',
    '  --dry-run            Validate and print the gh command without uploading',
    '  --clobber            Replace existing release assets if GitHub allows it',
    '  --help, -h           Show this help',
  ].join('\n');
}

function parseArgs(argv) {
  const opts = {
    assetDir: DEFAULT_ASSET_DIR,
    tag: null,
    yes: false,
    clobber: false,
    help: false,
  };

  for (const arg of argv) {
    if (arg === '--yes') opts.yes = true;
    else if (arg === '--dry-run') opts.yes = false;
    else if (arg === '--clobber') opts.clobber = true;
    else if (arg === '--help' || arg === '-h') opts.help = true;
    else if (arg.startsWith('--tag=')) opts.tag = arg.slice('--tag='.length);
    else if (arg.startsWith('--asset-dir=')) opts.assetDir = arg.slice('--asset-dir='.length);
    else throw new Error(`unknown argument: ${arg}`);
  }

  return opts;
}

function normalizeTag(tag) {
  if (!tag || !TAG_RE.test(tag)) {
    throw new Error(`invalid --tag value: ${JSON.stringify(tag)}; expected vX.Y.Z`);
  }
  return tag;
}

function resolveAssetDir(assetDir, cwd = process.cwd()) {
  const resolved = path.resolve(cwd, assetDir);
  const linkStat = fs.lstatSync(resolved);
  if (linkStat.isSymbolicLink()) {
    throw new Error(`asset dir must not be a symlink: ${resolved}`);
  }
  const stat = fs.statSync(resolved);
  if (!stat.isDirectory()) {
    throw new Error(`asset dir is not a directory: ${resolved}`);
  }
  return resolved;
}

function assertPlainFile(filePath, label) {
  const stat = fs.lstatSync(filePath);
  if (stat.isSymbolicLink()) {
    throw new Error(`${label} must not be a symlink: ${filePath}`);
  }
  if (!stat.isFile()) {
    throw new Error(`${label} is not a regular file: ${filePath}`);
  }
}

function sha256File(filePath) {
  const content = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(content).digest('hex');
}

function parseSha256Line(text, expectedName, label) {
  const lines = text.trim().split(/\r?\n/).filter(Boolean);
  if (lines.length !== 1) {
    throw new Error(`${label} must contain exactly one checksum line`);
  }
  const match = SHA256_LINE_RE.exec(lines[0]);
  if (!match) {
    throw new Error(`${label} must use '<sha256>  <filename>' format`);
  }
  const [, hash, fileName] = match;
  if (fileName !== expectedName) {
    throw new Error(`${label} references ${fileName}, expected ${expectedName}`);
  }
  return hash;
}

function parseManifest(text) {
  const entries = new Map();
  const lines = text.trim().split(/\r?\n/).filter(Boolean);

  for (const line of lines) {
    const match = SHA256_LINE_RE.exec(line);
    if (!match) {
      throw new Error(`${V2_MANIFEST} contains an invalid checksum line`);
    }
    const [, hash, fileName] = match;
    if (entries.has(fileName)) {
      throw new Error(`${V2_MANIFEST} contains duplicate entry for ${fileName}`);
    }
    entries.set(fileName, hash);
  }

  return entries;
}

function validateV2Assets(assetDir) {
  const dir = resolveAssetDir(assetDir);
  const expectedSet = new Set(V2_BINARIES);
  const manifestPath = path.join(dir, V2_MANIFEST);
  const uploadFiles = [];
  const hashes = new Map();

  for (const fileName of V2_BINARIES) {
    const filePath = path.join(dir, fileName);
    const sidecarPath = path.join(dir, `${fileName}.sha256`);

    assertPlainFile(filePath, fileName);
    assertPlainFile(sidecarPath, `${fileName}.sha256`);

    const actualHash = sha256File(filePath);
    const sidecarHash = parseSha256Line(
      fs.readFileSync(sidecarPath, 'utf8'),
      fileName,
      `${fileName}.sha256`,
    );
    if (actualHash !== sidecarHash) {
      throw new Error(`${fileName}.sha256 mismatch: expected ${actualHash}, got ${sidecarHash}`);
    }

    hashes.set(fileName, actualHash);
    uploadFiles.push(filePath, sidecarPath);
  }

  assertPlainFile(manifestPath, V2_MANIFEST);
  const manifest = parseManifest(fs.readFileSync(manifestPath, 'utf8'));
  if (manifest.size !== V2_BINARIES.length) {
    throw new Error(`${V2_MANIFEST} must contain exactly ${V2_BINARIES.length} entries`);
  }
  for (const fileName of V2_BINARIES) {
    if (!manifest.has(fileName)) {
      throw new Error(`${V2_MANIFEST} is missing ${fileName}`);
    }
    if (manifest.get(fileName) !== hashes.get(fileName)) {
      throw new Error(`${V2_MANIFEST} checksum mismatch for ${fileName}`);
    }
  }
  for (const fileName of manifest.keys()) {
    if (!expectedSet.has(fileName)) {
      throw new Error(`${V2_MANIFEST} contains unexpected asset ${fileName}`);
    }
  }

  uploadFiles.push(manifestPath);
  return { dir, hashes, uploadFiles };
}

function buildGhReleaseUploadArgs(tag, files, opts = {}) {
  const args = ['release', 'upload', tag, ...files, '--repo', PUBLIC_REPO];
  if (opts.clobber) args.push('--clobber');
  return args;
}

function quoteArg(arg) {
  if (/^[A-Za-z0-9_./:=@+-]+$/.test(arg)) return arg;
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

function runGh(args) {
  const result = spawnSync('gh', args, { stdio: 'inherit' });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`gh ${args.slice(0, 2).join(' ')} failed with exit ${result.status}`);
  }
}

function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  if (opts.help) {
    console.log(usage());
    return 0;
  }

  const tag = normalizeTag(opts.tag);
  const validation = validateV2Assets(opts.assetDir);
  const uploadArgs = buildGhReleaseUploadArgs(tag, validation.uploadFiles, opts);

  console.log(`[upload-v2-release-assets] validated ${V2_BINARIES.length} binaries in ${validation.dir}`);
  for (const fileName of V2_BINARIES) {
    console.log(`  ${fileName}: ${validation.hashes.get(fileName)}`);
  }
  console.log(`\n  gh ${uploadArgs.map(quoteArg).join(' ')}`);

  if (!opts.yes) {
    console.log('\n[upload-v2-release-assets] dry run only; add --yes to upload');
    return 0;
  }

  runGh(['release', 'view', tag, '--repo', PUBLIC_REPO]);
  runGh(uploadArgs);
  return 0;
}

if (require.main === module) {
  try {
    process.exit(main());
  } catch (error) {
    console.error(`[upload-v2-release-assets] ERROR: ${error.message}`);
    process.exit(1);
  }
}

module.exports = {
  PUBLIC_REPO,
  V2_BINARIES,
  V2_MANIFEST,
  buildGhReleaseUploadArgs,
  main,
  normalizeTag,
  parseArgs,
  parseManifest,
  parseSha256Line,
  sha256File,
  validateV2Assets,
};
