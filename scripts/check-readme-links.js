#!/usr/bin/env node
//
// check-readme-links.js — verify that every internal cross-reference
// link in the repo's README files points at an existing file and (when
// given) an existing heading in that file. Catches deep-link drift
// after future edits — e.g. renaming a section without updating the
// `[link](#anchor)` references that pointed at it.
//
// Scope (configurable via --include / --exclude below):
//   - README.md
//   - README.zh-CN.md
//   - README.ja-JP.md
//   - README.ko-KR.md
//   - SKILL.md             (Proxy mailbox API; referenced from each README)
//   - dev-fixtures/README.md
//
// Rules implemented:
//   1. Code fences (``` fenced blocks) delimit "code" so links/headings
//      inside them aren't picked up as actual references.
//   2. The anchor slugify function approximates GitHub's auto-anchor
//      rule: lowercase, spaces → dashes, drop chars that aren't
//      Unicode letters/numbers/underscore/dash, collapse consecutive
//      dashes. Unicode-property escapes (\p{L}, \p{N}) keep CJK,
//      Hangul, Hiragana, Katakana, and Latin-accented chars intact so
//      heading text from the localized README siblings round-trips
//      through slugify unchanged. GitHub additionally strips emojis
//      and normalizes unicode accents; this approximation covers the
//      current heading corpus and adds the ko-KR scope without
//      regressing the existing zh-CN / ja-JP refs.
//
// Exit codes:
//   0  every link resolves
//   1  one or more links are broken (missing file, missing anchor,
//      dangling self-anchor)
//
// Usage: node scripts/check-readme-links.js
//

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..');

// Default include set — all top-level READMEs + the dev-fixtures one.
// Override via CLI: `node check-readme-links.js --include=README.md,README.zh-CN.md`.
const DEFAULT_INCLUDES = [
  'README.md',
  'README.zh-CN.md',
  'README.ja-JP.md',
  'README.ko-KR.md',
  'SKILL.md',
  'dev-fixtures/README.md',
];

function parseArgs(argv) {
  const opts = { include: null };
  for (const a of argv.slice(2)) {
    if (a.startsWith('--include=')) {
      opts.include = a.slice('--include='.length).split(',').filter(Boolean);
    } else if (a === '--help' || a === '-h') {
      opts.help = true;
    }
  }
  return opts;
}

function printHelp() {
  console.log('Usage: node scripts/check-readme-links.js [--include=FILE,FILE,...]');
  console.log('');
  console.log('Default include set:');
  for (const f of DEFAULT_INCLUDES) console.log('  ' + f);
  console.log('');
  console.log('Exit codes:');
  console.log('  0  every link resolves');
  console.log('  1  one or more links are broken');
}

// --- slugify (GitHub auto-anchor approximation) -----------------------

function slugify(headingText) {
  return headingText
    // GitHub renders anchors by NFD-decomposing + stripping combining
    // marks BEFORE applying the rest of the slugify rules, so accented
    // Latin (caf\u00e9, na\u00efve) collapses onto the unaccented anchor
    // (cafe, naive). Mirror that here so script-derived lookups match
    // GitHub-rendered anchors for any future heading that uses accented
    // Latin. (No current heading does, so this is forward-looking.)
    // \p{M} covers every Unicode combining-mark category, BMP (U+0300-
    // U+036F) and supplementary (U+1AB0-U+1AFF, U+1DC0-U+1DFF,
    // U+20D0-U+20FF, U+FE20-U+FE2F), in one Unicode-property symbol
    // that mirrors what github-slugger effectively strips.
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    // collapse runs of whitespace into one dash
    .replace(/\s+/g, '-')
    // drop everything outside Unicode letters/numbers/underscore/dash.
    // The Unicode property escapes (\p{L}, \p{N}) keep CJK, Hangul,
    // Hiragana, Katakana, and Latin-accented chars intact so localized
    // heading text round-trips through slugify unchanged. Emojis and
    // punctuation that GitHub also drops are likewise filtered out.
    .replace(/[^\p{L}\p{N}_-]/gu, '')
    // collapse consecutive dashes
    .replace(/-+/g, '-')
    // trim leading/trailing dashes
    .replace(/^-+|-+$/g, '');
}

// --- markdown parser (code-fence aware) ------------------------------

/**
 * Iterates the lines of a markdown file, tagging each line as 'text' or
 * 'code' depending on whether we're inside a ``` fenced block. Lets us
 * skip links and headings that appear inside code samples.
 */
function* iterLines(content) {
  let inFence = false;
  let fenceMarker = null;
  for (const line of content.split('\n')) {
    // Match an opening/closing fence: 3+ backticks (optionally followed
    // by an info string like ```bash). Match at column 0 only — an
    // indented ``` is just literal text.
    const m = line.match(/^(`{3,})/);
    if (m && (!inFence || m[1].length >= fenceMarker)) {
      inFence = !inFence;
      if (inFence) fenceMarker = m[1].length;
      yield { type: 'fence', line };
      continue;
    }
    yield { type: inFence ? 'code' : 'text', line };
  }
}

function extractLinks(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  const links = [];
  // Match [text](url). Text may contain newlines in real Markdown, but
  // for our READMEs the links are single-line, so this is fine.
  const re = /\[([^\]\n]+)\]\(([^)\n]+)\)/g;
  for (const { type, line } of iterLines(content)) {
    if (type === 'code') continue;
    let m;
    while ((m = re.exec(line)) !== null) {
      links.push({ text: m[1], url: m[2], line: line.trim() });
    }
  }
  return links;
}

function extractHeadings(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  const headings = [];
  const re = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
  for (const { type, line } of iterLines(content)) {
    if (type === 'code') continue;
    const m = line.match(re);
    if (m) headings.push({ level: m[1].length, text: m[2], slug: slugify(m[2]) });
  }
  return headings;
}

// --- core check ------------------------------------------------------

function main() {
  const opts = parseArgs(process.argv);
  if (opts.help) { printHelp(); return 0; }

  const includes = opts.include && opts.include.length > 0 ? opts.include : DEFAULT_INCLUDES;

  // Build { relPath -> Set(slug) } for every included file's headings.
  const headingSlugs = new Map();
  for (const rel of includes) {
    const abs = path.join(REPO_ROOT, rel);
    headingSlugs.set(rel, new Set(extractHeadings(abs).map(h => h.slug)));
  }

  // Walk every link in every included file. A link is interesting only
  // if it points at another *.md file (possibly with a #anchor).
  const failures = [];
  let totalLinks = 0;

  for (const fromRel of includes) {
    const fromAbs = path.join(REPO_ROOT, fromRel);
    const links = extractLinks(fromAbs);
    for (const link of links) {
      // We're only auditing links that target a *.md file. External
      // http(s) URLs and `mailto:` links aren't checked here.
      if (!/\.md(?:$|#|\?)/.test(link.url)) continue;
      totalLinks++;

      // Split path#anchor (anchor is optional).
      const hashIdx = link.url.indexOf('#');
      const pathPart = hashIdx === -1 ? link.url : link.url.slice(0, hashIdx);
      const anchorPart = hashIdx === -1 ? null : link.url.slice(hashIdx + 1);

      // Resolve pathPart relative to the file the link appears in.
      // Empty pathPart means this is a self-only anchor ([text](#foo)
      // in the same file).
      let targetRel;
      if (pathPart === '') {
        targetRel = fromRel;
      } else {
        const targetAbs = path.resolve(path.dirname(fromAbs), pathPart);
        targetRel = path.relative(REPO_ROOT, targetAbs);
      }

      if (!headingSlugs.has(targetRel)) {
        failures.push({
          kind: 'missing-file',
          fromFile: fromRel,
          linkText: link.text,
          linkUrl: link.url,
          msg: `target file '${targetRel}' is not in scope (or doesn't exist)`,
        });
        continue;
      }

      if (anchorPart !== null && !headingSlugs.get(targetRel).has(anchorPart)) {
        // Find an approximate match to give the operator a hint.
        const known = [...headingSlugs.get(targetRel)];
        const close = known.filter(s => s.includes(anchorPart) || anchorPart.includes(s)).slice(0, 5);
        failures.push({
          kind: 'broken-anchor',
          fromFile: fromRel,
          linkText: link.text,
          linkUrl: link.url,
          msg: `anchor '#${anchorPart}' not found in '${targetRel}'` + (close.length ? ` (close: ${close.join(', ')})` : ''),
        });
      }
    }
  }

  if (failures.length > 0) {
    console.error(`FAIL: ${failures.length} broken/missing referent(s) across ${totalLinks} cross-link(s):`);
    for (const f of failures) {
      console.error(`  ${f.fromFile}: [${f.linkText}](${f.linkUrl})`);
      console.error(`    -> ${f.msg}`);
    }
    return 1;
  }
  console.log(`PASS: ${totalLinks} cross-link(s) across ${includes.length} README file(s) resolve correctly.`);
  return 0;
}

process.exit(main());
