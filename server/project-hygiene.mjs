import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const SKIP_LITERALS = new Set([
  'engine', 'ue5', 'unrealprojects', 'unrealengine', 'plugins', 'source',
  'content', 'config', 'saved', 'game', 'unrealeditor', 'intermediate',
  'binaries', 'deriveddatacache', 'programs', 'restricted', 'platforms',
  'editor', 'build', 'target', 'public', 'private', 'default', 'local',
  'staged', 'cooked', 'tools', 'batchfiles',
]);

const VERSION_PATTERN = /^\d+(\.\d+)*$/;

export function registerProjectCodenames({
  projectRoot,
  repoRoot,
  stderr = process.stderr,
} = {}) {
  const result = { registered: [], skipped: [], warnings: [] };
  const root = projectRoot || '';
  if (!root || !repoRoot) return result;

  const norm = root.replace(/[\\\/]+$/, '');
  const parts = norm.split(/[\\\/]/).filter(Boolean);
  const candidates = [];
  if (parts.length >= 1) candidates.push(parts[parts.length - 1]);
  if (parts.length >= 2) candidates.push(parts[parts.length - 2]);

  const targetsPath = join(repoRoot, '.git', 'info', 'known-test-targets.txt');
  const existing = new Set();
  if (existsSync(targetsPath)) {
    try {
      for (const line of readFileSync(targetsPath, 'utf8').split(/\r?\n/)) {
        const t = line.trim();
        if (!t || t.startsWith('#')) continue;
        existing.add(t.toLowerCase());
      }
    } catch (err) {
      const warning = `known-test-targets read failed: ${err.message}`;
      result.warnings.push(warning);
      stderr.write(`[uemcp] WARN: ${warning}\n`);
    }
  }

  const toAdd = [];
  for (const c of candidates) {
    if (!c) continue;
    if (VERSION_PATTERN.test(c) || SKIP_LITERALS.has(c.toLowerCase())) {
      result.skipped.push(c);
      continue;
    }
    if (existing.has(c.toLowerCase())) continue;
    existing.add(c.toLowerCase());
    toAdd.push(c);
  }
  if (toAdd.length === 0) return result;

  try {
    mkdirSync(dirname(targetsPath), { recursive: true });
    let prefix = '';
    if (!existsSync(targetsPath)) {
      prefix =
        '# .git/info/known-test-targets.txt\n' +
        '# Codenames captured by UEMCP project attachment.\n' +
        '# Auto-merged into .git/info/forbidden-tokens by .githooks/pre-commit.\n' +
        '# Per-checkout, untracked. Safe to delete.\n\n';
    }
    appendFileSync(targetsPath, prefix + toAdd.join('\n') + '\n', 'utf8');
    result.registered.push(...toAdd);
    for (const c of toAdd) stderr.write(`[uemcp] Registered project codename ${c} to known-test-targets\n`);
  } catch (err) {
    const warning = `known-test-targets write failed: ${err.message}`;
    result.warnings.push(warning);
    stderr.write(`[uemcp] WARN: ${warning}\n`);
  }

  return result;
}
