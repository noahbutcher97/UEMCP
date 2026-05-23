#!/usr/bin/env node
// PostToolUse hook (Edit|Write): syntax tripwire for .mjs files.
//
// The project ships no linter/formatter (no eslint/prettier in server/), so a
// malformed .mjs would otherwise surface only when the test rotation runs.
// `node --check` parses without executing — a cheap, side-effect-free gate that
// catches the error at write-time and feeds it back so it can be fixed in-loop.

import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

function readStdin() {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

let payload;
try {
  payload = JSON.parse(readStdin() || '{}');
} catch {
  process.exit(0);
}

const filePath =
  (payload.tool_input && payload.tool_input.file_path) ||
  (payload.tool_response && payload.tool_response.filePath) ||
  '';

// Only .mjs files; existsSync guards against a deleted/renamed target.
if (!filePath.endsWith('.mjs') || !existsSync(filePath)) process.exit(0);

try {
  execFileSync('node', ['--check', filePath], { stdio: ['ignore', 'ignore', 'pipe'] });
  process.exit(0); // valid syntax → silent success
} catch (e) {
  const detail = (e.stderr ? e.stderr.toString() : '') || e.message || 'syntax error';
  // PostToolUse decision:"block" feeds reason back to the model and continues.
  process.stdout.write(
    JSON.stringify({
      decision: 'block',
      reason: `node --check failed for ${filePath}:\n${detail.trim()}`,
    })
  );
  process.exit(0);
}
