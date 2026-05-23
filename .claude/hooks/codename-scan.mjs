#!/usr/bin/env node
// PreToolUse hook (Edit|Write): primary NDA-codename write-time gate.
//
// Mirrors .githooks/pre-commit tokenization so the Claude-write layer and the
// git-commit layer agree on what counts as a codename. Blocks the write BEFORE
// a codename can land in tracked content; .githooks/pre-commit remains the net.
// See CLAUDE.md §Public-Repo Hygiene + memory feedback_pre_commit_codename_scrub
// ("grep BEFORE commit; push-gate is the safety net not the primary defense").
//
// Fail-safe posture: any ambiguity resolves toward ALLOW for absence-of-gate
// (no token file → no policy) but toward SCAN for tool errors (git missing).
// Codenames in this hook's *output* are fine — output is ephemeral (terminal +
// model context), the two-channel pattern permits codenames in that channel.

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..'); // .claude/hooks → repo root
const TOKENS = join(REPO_ROOT, '.git', 'info', 'forbidden-tokens');
const KNOWN_TARGETS = join(REPO_ROOT, '.git', 'info', 'known-test-targets.txt');

function readStdin() {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

// Emit nothing and exit 0 → the write proceeds.
function allow() {
  process.exit(0);
}

// Emit a PreToolUse deny decision → the write is blocked, reason shown to model.
function deny(reason) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: reason,
      },
    })
  );
  process.exit(0);
}

let payload;
try {
  payload = JSON.parse(readStdin() || '{}');
} catch {
  allow();
}

const toolInput = payload.tool_input || {};
const filePath = toolInput.file_path || '';
if (!filePath) allow();

// Only files INSIDE the repo can become tracked content destined for github.
// Edits outside it (local auto-memory, /tmp, other projects) are out of the
// NDA gate's scope — codenames there are harmless and must not be blocked.
const absPath = resolve(filePath);
if (!absPath.toLowerCase().startsWith(REPO_ROOT.toLowerCase())) allow();

// Content about to be written: Write→content, Edit→new_string.
const content = [toolInput.content, toolInput.new_string]
  .filter((s) => typeof s === 'string')
  .join('\n');
if (!content) allow();

// Gitignored content never reaches github, so it is out of scope for the gate.
function isGitIgnored(p) {
  try {
    execFileSync('git', ['-C', REPO_ROOT, 'check-ignore', '-q', p], { stdio: 'ignore' });
    return true; // exit 0 = path IS ignored
  } catch (e) {
    if (e && e.status === 1) return false; // exit 1 = NOT ignored
    return false; // git unavailable / other → fail toward scanning
  }
}
if (isGitIgnored(filePath)) allow();

if (!existsSync(TOKENS)) allow();

const literals = [];
const regexes = [];
for (const line of readFileSync(TOKENS, 'utf8').split(/\r?\n/)) {
  const t = line.trim();
  if (!t || t.startsWith('#')) continue;
  if (t.startsWith('regex:')) regexes.push(t.slice('regex:'.length));
  else literals.push(t);
}
// pre-commit auto-merges captured test-target codenames; mirror that coverage.
if (existsSync(KNOWN_TARGETS)) {
  for (const line of readFileSync(KNOWN_TARGETS, 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (t && !t.startsWith('#')) literals.push(t);
  }
}
if (!literals.length && !regexes.length) allow();

// Case-insensitive scan, mirroring grep -F -i (literals) / grep -E -i (regexes).
const hay = content.toLowerCase();
const hits = [];
for (const lit of literals) {
  if (lit && hay.includes(lit.toLowerCase())) hits.push(lit);
}
for (const rx of regexes) {
  try {
    if (new RegExp(rx, 'i').test(content)) hits.push(`regex:${rx}`);
  } catch {
    /* malformed regex in token file — skip, pre-commit will surface it */
  }
}

if (hits.length) {
  const uniq = [...new Set(hits)];
  deny(
    `NDA codename detected in content for ${filePath}: ${uniq.join(', ')}. ` +
      `Replace with placeholder vocabulary (Project A / Project B, <UNREAL_PROJECT_NAME>, ` +
      `path/to/YourProject) per CLAUDE.md §Public-Repo Hygiene before writing. ` +
      `This is the primary write-time gate; .githooks/pre-commit is the net.`
  );
}
allow();
