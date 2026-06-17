// Repo-local .uemcp-targets.json / .uemcp-targets.txt parsing and aliasing.

import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';

import { PROJECT_ERROR_CODES } from './project-errors.mjs';
import { createProjectIdentity, normalizeComparisonPath } from './project-identity.mjs';

const DEFAULT_FS = {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
};

export function parseTargetsFile(content) {
  return String(content || '')
    .split(/\r?\n/)
    .map(line => line.replace(/#.*$/, '').trim())
    .filter(Boolean);
}

export function parseTargetProfilesFile(content) {
  const parsed = JSON.parse(String(content || '{}'));
  const targets = parsed.targets && typeof parsed.targets === 'object' && !Array.isArray(parsed.targets)
    ? parsed.targets
    : {};
  const profiles = parsed.profiles && typeof parsed.profiles === 'object' && !Array.isArray(parsed.profiles)
    ? parsed.profiles
    : {};
  return {
    version: parsed.version ?? 1,
    profiles,
    targets,
  };
}

function shortHash(text) {
  return createHash('sha1').update(text).digest('hex').slice(0, 8);
}

function targetAliasStem(uprojectPath) {
  const stem = basename(uprojectPath, extname(uprojectPath))
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return stem || `target-${shortHash(uprojectPath)}`;
}

function uniqueTargetAlias(baseAlias, targets, uprojectPath) {
  if (!Object.prototype.hasOwnProperty.call(targets, baseAlias)) return baseAlias;
  const existing = targets[baseAlias];
  const existingPath = typeof existing === 'string' ? existing : existing?.uproject;
  if (normalizeComparisonPath(existingPath) === normalizeComparisonPath(uprojectPath)) return baseAlias;
  return `${baseAlias}-${shortHash(uprojectPath)}`;
}

function invalidEntry(entry, reason, message) {
  return {
    entry,
    code: PROJECT_ERROR_CODES.TARGET_ENTRY_INVALID,
    reason,
    message,
  };
}

function warning(code, message, details = {}) {
  return { code, message, ...details };
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

export function registerProjectTargetProfile({
  configPath,
  uprojectPath,
  profiles = ['default', 'smoke', 'release-gate'],
  fsImpl = DEFAULT_FS,
} = {}) {
  if (!configPath) throw new Error('registerProjectTargetProfile requires configPath');
  if (!uprojectPath) throw new Error('registerProjectTargetProfile requires uprojectPath');

  let config = { version: 1, profiles: {}, targets: {} };
  if (fsImpl.existsSync(configPath)) {
    config = parseTargetProfilesFile(fsImpl.readFileSync(configPath, 'utf8'));
  }
  config.version = config.version ?? 1;
  config.profiles = config.profiles || {};
  config.targets = config.targets || {};

  const existingAlias = Object.entries(config.targets).find(([, def]) => {
    const candidatePath = typeof def === 'string' ? def : def?.uproject;
    return normalizeComparisonPath(candidatePath) === normalizeComparisonPath(uprojectPath);
  })?.[0];
  const alias = existingAlias || uniqueTargetAlias(targetAliasStem(uprojectPath), config.targets, uprojectPath);

  let changed = false;
  if (!config.targets[alias]) {
    config.targets[alias] = { uproject: uprojectPath };
    changed = true;
  } else if (typeof config.targets[alias] === 'string') {
    config.targets[alias] = { uproject: config.targets[alias] };
    changed = true;
  }

  for (const profileName of profiles) {
    if (!Array.isArray(config.profiles[profileName])) {
      config.profiles[profileName] = [];
      changed = true;
    }
    if (!config.profiles[profileName].includes(alias)) {
      config.profiles[profileName].push(alias);
      changed = true;
    }
  }

  if (changed) {
    const dir = dirname(configPath);
    if (dir) fsImpl.mkdirSync(dir, { recursive: true });
    fsImpl.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  }

  return {
    status: changed ? 'added' : 'unchanged',
    alias,
    configPath,
  };
}

export function migrateLegacyTargetsToProfiles({
  legacyTargetsPath,
  configPath,
  profiles = ['default', 'smoke', 'release-gate'],
  fsImpl = DEFAULT_FS,
} = {}) {
  if (!legacyTargetsPath) throw new Error('migrateLegacyTargetsToProfiles requires legacyTargetsPath');
  if (!configPath) throw new Error('migrateLegacyTargetsToProfiles requires configPath');

  if (!fsImpl.existsSync(legacyTargetsPath)) {
    return {
      status: 'missing',
      legacyTargetsPath,
      configPath,
      profiles,
      entries: [],
      migrated: [],
    };
  }

  const entries = parseTargetsFile(fsImpl.readFileSync(legacyTargetsPath, 'utf8'));
  if (entries.length === 0) {
    return {
      status: 'empty',
      legacyTargetsPath,
      configPath,
      profiles,
      entries,
      migrated: [],
    };
  }

  const migrated = entries.map(entry => ({
    entry,
    ...registerProjectTargetProfile({
      configPath,
      uprojectPath: entry,
      profiles,
      fsImpl,
    }),
  }));
  const changed = migrated.some(item => item.status === 'added');

  return {
    status: changed ? 'migrated' : 'unchanged',
    legacyTargetsPath,
    configPath,
    profiles,
    entries,
    migrated,
  };
}

export function readProjectTargets({
  repoRoot,
  targetsPath = null,
  targetsJsonPath = join(repoRoot, '.uemcp-targets.json'),
  legacyTargetsPath = join(repoRoot, '.uemcp-targets.txt'),
  profile = null,
  fsImpl = DEFAULT_FS,
  clientRoots = [],
} = {}) {
  const explicitTargetsPath = !!targetsPath;
  const resolvedTargetsPath = targetsPath || (
    fsImpl.existsSync(targetsJsonPath) ? targetsJsonPath : legacyTargetsPath
  );
  const ext = extname(resolvedTargetsPath).toLowerCase();

  if (!fsImpl.existsSync(resolvedTargetsPath)) {
    return {
      targetsPath: resolvedTargetsPath,
      sourceType: ext === '.json' ? 'json' : 'txt',
      status: 'absent',
      entries: [],
      candidates: [],
      invalidEntries: [],
      aliases: {},
      aliasCollisions: [],
      warnings: [],
      profile: {
        name: profile || (ext === '.json' ? 'default' : 'legacy'),
        selectedTargets: [],
        availableProfiles: [],
      },
    };
  }

  if (ext === '.json') {
    return readStructuredProjectTargets({
      targetsPath: resolvedTargetsPath,
      legacyTargetsPath,
      explicitTargetsPath,
      profile,
      fsImpl,
      clientRoots,
    });
  }

  return readLegacyProjectTargets({
    targetsPath: resolvedTargetsPath,
    profile,
    fsImpl,
    clientRoots,
  });
}

function readLegacyProjectTargets({
  targetsPath,
  profile,
  fsImpl,
  clientRoots,
}) {
  const warnings = [
    warning(
      'LEGACY_TARGETS_TXT',
      '.uemcp-targets.txt is compatibility-only; prefer .uemcp-targets.json profiles for production verification.',
      {
        migrationHint: 'Run migrate-targets.bat to convert existing .uemcp-targets.txt entries, or setup-uemcp.bat "<path-to-project.uproject>" to register a new target.',
      },
    ),
  ];
  const profileName = profile || 'legacy';
  if (profile && !['legacy', 'default', 'all'].includes(profile)) {
    return {
      targetsPath,
      sourceType: 'txt',
      status: 'profile_not_found',
      entries: [],
      candidates: [],
      invalidEntries: [],
      aliases: {},
      aliasCollisions: [],
      warnings,
      profile: {
        name: profileName,
        selectedTargets: [],
        availableProfiles: ['legacy', 'all'],
      },
    };
  }

  const entries = parseTargetsFile(fsImpl.readFileSync(targetsPath, 'utf8'));
  if (entries.length === 0) {
    return {
      targetsPath,
      sourceType: 'txt',
      status: 'empty',
      entries,
      candidates: [],
      invalidEntries: [],
      aliases: {},
      aliasCollisions: [],
      warnings,
      profile: {
        name: profileName,
        selectedTargets: [],
        availableProfiles: ['legacy', 'all'],
      },
    };
  }

  return resolveTargetEntries({
    targetsPath,
    sourceType: 'txt',
    entries: entries.map((entry, index) => ({ alias: `legacy-${index + 1}`, uprojectPath: entry })),
    selectedTargets: entries,
    profile: {
      name: profileName,
      selectedTargets: entries,
      availableProfiles: ['legacy', 'all'],
    },
    fsImpl,
    clientRoots,
    warnings,
    includeConfiguredAliases: false,
  });
}

function readStructuredProjectTargets({
  targetsPath,
  legacyTargetsPath,
  explicitTargetsPath,
  profile,
  fsImpl,
  clientRoots,
}) {
  const warnings = [];
  if (!explicitTargetsPath && fsImpl.existsSync(legacyTargetsPath)) {
    warnings.push(warning(
      'LEGACY_TARGETS_TXT_IGNORED',
      '.uemcp-targets.json is present, so .uemcp-targets.txt was ignored.',
      { legacyTargetsPath },
    ));
  }

  let parsed;
  try {
    parsed = parseTargetProfilesFile(fsImpl.readFileSync(targetsPath, 'utf8'));
  } catch (err) {
    return {
      targetsPath,
      sourceType: 'json',
      status: 'invalid_config',
      entries: [],
      candidates: [],
      invalidEntries: [invalidEntry(targetsPath, 'JSON_PARSE_FAILED', err.message)],
      aliases: {},
      aliasCollisions: [],
      warnings,
      profile: {
        name: profile || 'default',
        selectedTargets: [],
        availableProfiles: [],
      },
    };
  }

  const targetNames = Object.keys(parsed.targets);
  const availableProfiles = [...Object.keys(parsed.profiles), 'all']
    .filter((name, index, all) => all.indexOf(name) === index);
  let profileName = profile || (Array.isArray(parsed.profiles.default) ? 'default' : 'all');

  if (profileName !== 'all' && !Array.isArray(parsed.profiles[profileName])) {
    return {
      targetsPath,
      sourceType: 'json',
      status: 'profile_not_found',
      entries: [],
      candidates: [],
      invalidEntries: [],
      aliases: {},
      aliasCollisions: [],
      warnings,
      profile: {
        name: profileName,
        selectedTargets: [],
        availableProfiles,
      },
    };
  }

  const selectedAliases = profileName === 'all' ? targetNames : [...parsed.profiles[profileName]];
  const profileDescriptor = {
    name: profileName,
    selectedTargets: [...selectedAliases],
    availableProfiles,
  };

  const missingAliases = selectedAliases
    .filter(alias => !Object.prototype.hasOwnProperty.call(parsed.targets, alias))
    .map(alias => invalidEntry(alias, 'TARGET_ALIAS_NOT_FOUND', `Profile target alias "${alias}" is not defined in targets.`));
  if (missingAliases.length > 0) {
    return {
      targetsPath,
      sourceType: 'json',
      status: 'invalid_profile',
      entries: [],
      candidates: [],
      invalidEntries: missingAliases,
      aliases: {},
      aliasCollisions: [],
      warnings,
      profile: profileDescriptor,
    };
  }

  const entries = [];
  const invalidEntries = [];
  for (const alias of selectedAliases) {
    const def = parsed.targets[alias] || {};
    const uprojectPath = typeof def === 'string' ? def : def.uproject;
    if (!uprojectPath) {
      invalidEntries.push(invalidEntry(alias, 'TARGET_UPROJECT_MISSING', `Target "${alias}" must define a uproject path.`));
      continue;
    }
    entries.push({ alias, uprojectPath });
  }

  if (invalidEntries.length > 0) {
    return {
      targetsPath,
      sourceType: 'json',
      status: 'invalid_profile',
      entries: [],
      candidates: [],
      invalidEntries,
      aliases: {},
      aliasCollisions: [],
      warnings,
      profile: profileDescriptor,
    };
  }

  return resolveTargetEntries({
    targetsPath,
    sourceType: 'json',
    entries,
    selectedTargets: selectedAliases,
    profile: profileDescriptor,
    fsImpl,
    clientRoots,
    warnings,
    includeConfiguredAliases: true,
  });
}

function resolveTargetEntries({
  targetsPath,
  sourceType,
  entries,
  selectedTargets,
  profile,
  fsImpl,
  clientRoots,
  warnings,
  includeConfiguredAliases,
}) {
  const candidates = [];
  const invalidEntries = [];

  for (const entry of entries) {
    const invalid = validateTargetEntry(entry.uprojectPath, fsImpl);
    if (invalid) {
      invalidEntries.push({ ...invalid, alias: entry.alias });
      continue;
    }
    try {
      const identity = createProjectIdentity({
        uprojectPath: entry.uprojectPath,
        source: 'targets',
        fsImpl,
        clientRoots,
      });
      identity.targetAlias = entry.alias;
      identity.warnings.push(...projectShapeWarnings(identity, fsImpl));
      candidates.push(identity);
    } catch (err) {
      invalidEntries.push({
        ...invalidEntry(
          entry.uprojectPath,
          err.code || 'IDENTITY_FAILED',
          err.message,
        ),
        alias: entry.alias,
      });
    }
  }

  const built = buildTargetAliases(candidates);
  const aliases = { ...built.aliases };
  if (includeConfiguredAliases) {
    for (const candidate of candidates) {
      if (candidate.targetAlias) aliases[candidate.targetAlias] = candidate.canonicalUprojectPath;
    }
  }
  let status = 'valid';
  if (invalidEntries.length > 0) status = candidates.length > 0 ? 'partially_invalid' : 'invalid';

  return {
    targetsPath,
    sourceType,
    status,
    entries: entries.map(entry => entry.uprojectPath),
    candidates,
    invalidEntries,
    aliases,
    aliasCollisions: built.aliasCollisions,
    warnings,
    profile: {
      ...profile,
      selectedTargets: [...selectedTargets],
    },
  };
}
