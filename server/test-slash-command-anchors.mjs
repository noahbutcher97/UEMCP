// server/test-slash-command-anchors.mjs
// Structural test: every `CLAUDE.md §"…"` reference in a slash-command
// body resolves to a real header or bolded anchor in CLAUDE.md.
//
// Convention: command bodies reference CLAUDE.md sections using the
// literal pattern  CLAUDE.md §"<header-text>"  with double quotes.
// The anchor must match either ^#+\s+<text>$ or ^\*\*<text>\*\*  in CLAUDE.md.

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = join(HERE, '..');
const COMMANDS_DIR = join(REPO_ROOT, '.claude', 'commands');
const CLAUDE_MD = join(REPO_ROOT, 'CLAUDE.md');

const ANCHOR_REF_RE = /CLAUDE\.md §"([^"]+)"/g;

let passed = 0;
let failed = 0;

function assert(cond, msg) {
  if (cond) { passed++; }
  else { failed++; console.error(`FAIL: ${msg}`); }
}

function extractAnchors(claudeMdText) {
  const headers = new Set();
  for (const line of claudeMdText.split(/\r?\n/)) {
    const h = line.match(/^#+\s+(.+?)\s*$/);
    if (h) headers.add(h[1].trim());
    const b = line.match(/^\*\*([^*]+)\*\*/);
    if (b) headers.add(b[1].trim());
  }
  return headers;
}

function extractRefs(commandText) {
  const refs = new Set();
  let m;
  while ((m = ANCHOR_REF_RE.exec(commandText)) !== null) {
    refs.add(m[1]);
  }
  return refs;
}

function runTests() {
  if (!existsSync(CLAUDE_MD)) {
    console.error(`FAIL: CLAUDE.md not found at ${CLAUDE_MD}`);
    failed++;
    return;
  }
  if (!existsSync(COMMANDS_DIR)) {
    console.log('No .claude/commands/ directory yet; nothing to check.');
    return;
  }
  const claudeMd = readFileSync(CLAUDE_MD, 'utf8');
  const anchors = extractAnchors(claudeMd);

  const files = readdirSync(COMMANDS_DIR).filter(f => f.endsWith('.md'));
  if (files.length === 0) {
    console.log('No .claude/commands/*.md files yet; nothing to check.');
    return;
  }

  for (const f of files) {
    const body = readFileSync(join(COMMANDS_DIR, f), 'utf8');
    const refs = extractRefs(body);
    for (const ref of refs) {
      assert(
        anchors.has(ref),
        `${f} references CLAUDE.md §"${ref}" but no matching anchor exists in CLAUDE.md`
      );
    }
  }
}

runTests();
console.log(`\n═══ slash-command anchors ═══`);
console.log(`  Passed: ${passed}`);
console.log(`  Failed: ${failed}`);
console.log(`  Total:  ${passed + failed}`);
if (failed > 0) process.exit(1);
