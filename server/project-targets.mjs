// Repo-local .uemcp-targets.txt parsing and aliasing.

import { createHash } from 'node:crypto';
import {
  existsSync,
  readFileSync,
  statSync,
} from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';

import { PROJECT_ERROR_CODES } from './project-errors.mjs';
import { createProjectIdentity } from './project-identity.mjs';

const DEFAULT_FS = {
  existsSync,
  readFileSync,
  statSync,
};

export function parseTargetsFile(content) {
  return String(content || '')
    .split(/\r?\n/)
    .map(line => line.replace(/#.*$/, '').trim())
    .filter(Boolean);
}

function shortHash(text) {
  return createHash('sha1').update(text).digest('hex').slice(0, 8);
}

function invalidEntry(entry, reason, message) {
  return {
    entry,
    code: PROJECT_ERROR_CODES.TARGET_ENTRY_INVALID,
    reason,
    message,
  };
}

function validateTargetEntry(entry, fsImpl) {
  if (extname(entry).toLowerCase() !== '.uproject') {
    return invalidEntry(entry, 'NOT_UPROJECT', 'Target entry must point to a .uproject file.');
  }
  if (!fsImpl.existsSync(entry)) {
    return invalidEntry(entry, 'PATH_NOT_FOUND', 'Target .uproject file does not exist.');
  }
  let stat;
  try {
    stat = fsImpl.statSync(entry);
  } catch (err) {
    return invalidEntry(entry, 'STAT_FAILED', `Target entry could not be inspected: ${err.message}`);
  }
  if (!stat.isFile()) {
    return invalidEntry(entry, 'NOT_FILE', 'Target entry points to a directory or non-file path.');
  }
  return null;
}

function projectShapeWarnings(identity, fsImpl) {
  const warnings = [];
  if (!fsImpl.existsSync(join(identity.projectRoot, 'Content'))) {
    warnings.push('PROJECT_CONTENT_DIR_MISSING');
  }
  return warnings;
}

export function buildTargetAliases(candidates) {
  const byStem = new Map();
  for (const candidate of candidates) {
    const key = candidate.projectName;
    if (!byStem.has(key)) byStem.set(key, []);
    byStem.get(key).push(candidate);
  }

  const aliases = {};
  const aliasCollisions = [];

  for (const [stem, group] of byStem.entries()) {
    if (group.length === 1) {
      aliases[stem] = group[0].canonicalUprojectPath;
      continue;
    }

    aliasCollisions.push({
      alias: stem,
      candidates: group.map(c => c.canonicalUprojectPath),
    });

    for (const candidate of group) {
      const parentName = basename(dirname(candidate.projectRoot)) || basename(candidate.projectRoot);
      const alias = `${stem}-${parentName}-${shortHash(candidate.canonicalUprojectPath)}`;
      aliases[alias] = candidate.canonicalUprojectPath;
    }
  }

  return { aliases, aliasCollisions };
}

export function readProjectTargets({
  repoRoot,
  targetsPath = join(repoRoot, '.uemcp-targets.txt'),
  fsImpl = DEFAULT_FS,
  clientRoots = [],
} = {}) {
  if (!fsImpl.existsSync(targetsPath)) {
    return {
      targetsPath,
      status: 'absent',
      entries: [],
      candidates: [],
      invalidEntries: [],
      aliases: {},
      aliasCollisions: [],
    };
  }

  const entries = parseTargetsFile(fsImpl.readFileSync(targetsPath, 'utf8'));
  if (entries.length === 0) {
    return {
      targetsPath,
      status: 'empty',
      entries,
      candidates: [],
      invalidEntries: [],
      aliases: {},
      aliasCollisions: [],
    };
  }

  const candidates = [];
  const invalidEntries = [];

  for (const entry of entries) {
    const invalid = validateTargetEntry(entry, fsImpl);
    if (invalid) {
      invalidEntries.push(invalid);
      continue;
    }
    try {
      const identity = createProjectIdentity({
        uprojectPath: entry,
        source: 'targets',
        fsImpl,
        clientRoots,
      });
      identity.warnings.push(...projectShapeWarnings(identity, fsImpl));
      candidates.push(identity);
    } catch (err) {
      invalidEntries.push(invalidEntry(
        entry,
        err.code || 'IDENTITY_FAILED',
        err.message,
      ));
    }
  }

  const { aliases, aliasCollisions } = buildTargetAliases(candidates);
  let status = 'valid';
  if (invalidEntries.length > 0) status = candidates.length > 0 ? 'partially_invalid' : 'invalid';

  return {
    targetsPath,
    status,
    entries,
    candidates,
    invalidEntries,
    aliases,
    aliasCollisions,
  };
}
