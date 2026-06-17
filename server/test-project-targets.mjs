// Project target-file parsing and alias tests.
//
// Run: cd server && node test-project-targets.mjs

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import { TestRunner } from './test-helpers.mjs';
import {
  buildTargetAliases,
  parseTargetProfilesFile,
  parseTargetsFile,
  registerProjectTargetProfile,
  readProjectTargets,
} from './project-targets.mjs';

const t = new TestRunner('Project Targets Tests');

function makeTempRoot() {
  return mkdtempSync(join(tmpdir(), 'uemcp-project-targets-'));
}

function cleanup(dir) {
  const norm = dir.replace(/\\/g, '/');
  const tmp = tmpdir().replace(/\\/g, '/').replace(/\/+$/, '');
  if (!norm.startsWith(`${tmp}/uemcp-project-targets-`)) {
    throw new Error(`refusing to clean unexpected temp path: ${dir}`);
  }
  rmSync(dir, { recursive: true, force: true });
}

function writeProject(root, name, extraDirs = ['Content']) {
  mkdirSync(root, { recursive: true });
  for (const dir of extraDirs) mkdirSync(join(root, dir), { recursive: true });
  const uprojectPath = join(root, `${name}.uproject`);
  writeFileSync(uprojectPath, '{"FileVersion":3}\n', 'utf8');
  return uprojectPath;
}

function writeTargetsJson(repoRoot, data) {
  writeFileSync(join(repoRoot, '.uemcp-targets.json'), `${JSON.stringify(data, null, 2)}\n`, 'utf8');
}

// Parser strips comments and blank lines.
{
  const parsed = parseTargetsFile(`
    # leading comment
    D:/One/One.uproject

    D:/Two/Two.uproject # trailing comment
  `);
  t.assert(parsed.length === 2, `parser returns two entries (got ${parsed.length})`);
  t.assert(parsed[0] === 'D:/One/One.uproject', 'parser keeps first path');
  t.assert(parsed[1] === 'D:/Two/Two.uproject', 'parser strips trailing comment');
}

// Structured target profiles parse explicit profiles and target maps.
{
  const parsed = parseTargetProfilesFile(JSON.stringify({
    version: 1,
    profiles: {
      default: ['project-a'],
      'release-gate': ['project-a', 'project-b'],
    },
    targets: {
      'project-a': { uproject: 'D:/A/A.uproject' },
      'project-b': { uproject: 'D:/B/B.uproject' },
    },
  }));
  t.assert(parsed.version === 1, `profiles version is 1 (got ${parsed.version})`);
  t.assert(parsed.profiles.default.length === 1, 'default profile has one alias');
  t.assert(parsed.targets['project-b'].uproject === 'D:/B/B.uproject', 'target map preserves uproject path');
}

// Missing and empty target files report distinct statuses.
{
  const repoRoot = makeTempRoot();
  try {
    const absent = readProjectTargets({ repoRoot });
    t.assert(absent.status === 'absent', `missing targets file status is absent (got ${absent.status})`);
    t.assert(absent.candidates.length === 0, 'missing targets file has no candidates');

    writeFileSync(join(repoRoot, '.uemcp-targets.txt'), '\n# only comments\n\n', 'utf8');
    const empty = readProjectTargets({ repoRoot });
    t.assert(empty.status === 'empty', `empty targets file status is empty (got ${empty.status})`);
    t.assert(empty.invalidEntries.length === 0, 'empty targets file has no invalid entries');
  } finally {
    cleanup(repoRoot);
  }
}

// Structured .uemcp-targets.json wins over legacy .txt and resolves named profiles.
{
  const repoRoot = makeTempRoot();
  try {
    const projectA = writeProject(join(repoRoot, 'ProjectA'), 'ProjectA');
    const projectB = writeProject(join(repoRoot, 'ProjectB'), 'ProjectB');
    writeFileSync(join(repoRoot, '.uemcp-targets.txt'), `${projectB}\n`, 'utf8');
    writeTargetsJson(repoRoot, {
      version: 1,
      profiles: {
        default: ['project-a'],
        smoke: ['project-b'],
        'release-gate': ['project-a', 'project-b'],
      },
      targets: {
        'project-a': { uproject: projectA },
        'project-b': { uproject: projectB },
      },
    });

    const defaultResult = readProjectTargets({ repoRoot, clientRoots: [repoRoot] });
    t.assert(defaultResult.sourceType === 'json', `structured source wins over txt (got ${defaultResult.sourceType})`);
    t.assert(defaultResult.profile.name === 'default', `default profile selected (got ${defaultResult.profile?.name})`);
    t.assert(defaultResult.candidates.length === 1, `default profile selects one target (got ${defaultResult.candidates.length})`);
    t.assert(defaultResult.candidates[0].projectName === 'ProjectA', 'default profile selects project-a');

    const smoke = readProjectTargets({ repoRoot, profile: 'smoke', clientRoots: [repoRoot] });
    t.assert(smoke.profile.name === 'smoke', `smoke profile selected (got ${smoke.profile?.name})`);
    t.assert(smoke.candidates.length === 1, `smoke profile selects one target (got ${smoke.candidates.length})`);
    t.assert(smoke.candidates[0].projectName === 'ProjectB', 'smoke profile selects project-b');

    const release = readProjectTargets({ repoRoot, profile: 'release-gate', clientRoots: [repoRoot] });
    t.assert(release.candidates.length === 2, `release-gate selects two targets (got ${release.candidates.length})`);
    t.assert(release.profile.selectedTargets.join(',') === 'project-a,project-b', `profile reports selected aliases (${release.profile.selectedTargets.join(',')})`);
  } finally {
    cleanup(repoRoot);
  }
}

// Built-in all profile selects every structured target without needing a config entry.
{
  const repoRoot = makeTempRoot();
  try {
    const projectA = writeProject(join(repoRoot, 'ProjectA'), 'ProjectA');
    const projectB = writeProject(join(repoRoot, 'ProjectB'), 'ProjectB');
    writeTargetsJson(repoRoot, {
      version: 1,
      profiles: {
        default: ['project-a'],
      },
      targets: {
        'project-a': { uproject: projectA },
        'project-b': { uproject: projectB },
      },
    });

    const result = readProjectTargets({ repoRoot, profile: 'all', clientRoots: [repoRoot] });
    t.assert(result.profile.name === 'all', `built-in all profile selected (got ${result.profile?.name})`);
    t.assert(result.candidates.length === 2, `built-in all selects every target (got ${result.candidates.length})`);
    t.assert(result.profile.selectedTargets.join(',') === 'project-a,project-b', `all profile reports aliases (${result.profile.selectedTargets.join(',')})`);
  } finally {
    cleanup(repoRoot);
  }
}

// Unknown or invalid structured profiles fail loud instead of silently widening.
{
  const repoRoot = makeTempRoot();
  try {
    const projectA = writeProject(join(repoRoot, 'ProjectA'), 'ProjectA');
    writeTargetsJson(repoRoot, {
      version: 1,
      profiles: {
        default: ['missing-target'],
      },
      targets: {
        'project-a': { uproject: projectA },
      },
    });

    const unknown = readProjectTargets({ repoRoot, profile: 'release-gate', clientRoots: [repoRoot] });
    t.assert(unknown.status === 'profile_not_found', `unknown profile fails loud (got ${unknown.status})`);
    t.assert(unknown.profile.name === 'release-gate', `unknown profile name reported (got ${unknown.profile?.name})`);
    t.assert(unknown.candidates.length === 0, 'unknown profile does not verify all targets');

    const invalid = readProjectTargets({ repoRoot, clientRoots: [repoRoot] });
    t.assert(invalid.status === 'invalid_profile', `missing alias in default profile is invalid_profile (got ${invalid.status})`);
    t.assert(invalid.invalidEntries.some(entry => entry.reason === 'TARGET_ALIAS_NOT_FOUND'), 'invalid profile reports missing target alias');
    t.assert(invalid.candidates.length === 0, 'invalid profile does not verify partial ambiguous set');
  } finally {
    cleanup(repoRoot);
  }
}

// Legacy .uemcp-targets.txt remains compatible but reports an explicit warning.
{
  const repoRoot = makeTempRoot();
  try {
    const projectA = writeProject(join(repoRoot, 'ProjectA'), 'ProjectA');
    writeFileSync(join(repoRoot, '.uemcp-targets.txt'), `${projectA}\n`, 'utf8');

    const result = readProjectTargets({ repoRoot, clientRoots: [repoRoot] });
    t.assert(result.sourceType === 'txt', `legacy source type is txt (got ${result.sourceType})`);
    t.assert(result.profile.name === 'legacy', `legacy profile name reported (got ${result.profile?.name})`);
    t.assert(result.warnings.some(w => w.code === 'LEGACY_TARGETS_TXT'), 'legacy txt warning is reported');
    t.assert(
      result.warnings.some(w => /migrate-targets\.bat/.test(w.migrationHint || '') && /setup-uemcp\.bat/.test(w.migrationHint || '')),
      'legacy txt warning includes structured profile migration hint',
    );
    t.assert(result.candidates.length === 1, `legacy txt still resolves one target (got ${result.candidates.length})`);
  } finally {
    cleanup(repoRoot);
  }
}

// Setup helper creates and idempotently updates structured local target profiles.
{
  const repoRoot = makeTempRoot();
  try {
    const projectA = writeProject(join(repoRoot, 'ProjectA'), 'ProjectA');
    const configPath = join(repoRoot, '.uemcp-targets.json');

    const first = registerProjectTargetProfile({ configPath, uprojectPath: projectA });
    t.assert(first.status === 'added', `first profile registration adds target (got ${first.status})`);
    t.assert(first.alias === 'projecta', `default alias is normalized project stem (got ${first.alias})`);

    const parsed = parseTargetProfilesFile(readFileSync(configPath, 'utf8'));
    t.assert(parsed.targets.projecta.uproject === projectA, 'registered target stores uproject path');
    t.assert(parsed.profiles.default.includes('projecta'), 'registered target joins default profile');
    t.assert(parsed.profiles.smoke.includes('projecta'), 'registered target joins smoke profile');
    t.assert(parsed.profiles['release-gate'].includes('projecta'), 'registered target joins release-gate profile');

    const second = registerProjectTargetProfile({ configPath, uprojectPath: projectA });
    const reparsed = parseTargetProfilesFile(readFileSync(configPath, 'utf8'));
    t.assert(second.status === 'unchanged', `second profile registration is idempotent (got ${second.status})`);
    t.assert(reparsed.profiles.default.filter(alias => alias === 'projecta').length === 1, 'idempotent registration does not duplicate default alias');
  } finally {
    cleanup(repoRoot);
  }
}

// Valid and partially-invalid target files preserve invalid diagnostics.
{
  const repoRoot = makeTempRoot();
  try {
    const projectA = writeProject(join(repoRoot, 'ProjectA'), 'ProjectA');
    const missing = join(repoRoot, 'Missing', 'Missing.uproject');
    const wrongExt = join(repoRoot, 'ProjectA', 'ProjectA.txt');
    const directoryPath = join(repoRoot, 'DirectoryTarget.uproject');
    mkdirSync(directoryPath, { recursive: true });

    writeFileSync(join(repoRoot, '.uemcp-targets.txt'), [
      projectA,
      missing,
      wrongExt,
      directoryPath,
    ].join('\n') + '\n', 'utf8');

    const result = readProjectTargets({ repoRoot, clientRoots: [repoRoot] });
    t.assert(result.status === 'partially_invalid', `mixed target file is partially_invalid (got ${result.status})`);
    t.assert(result.candidates.length === 1, `one valid candidate returned (got ${result.candidates.length})`);
    t.assert(result.candidates[0].projectName === 'ProjectA', 'valid candidate project name is ProjectA');
    t.assert(result.invalidEntries.length === 3, `three invalid entries returned (got ${result.invalidEntries.length})`);
    t.assert(result.invalidEntries.every(e => e.code === 'TARGET_ENTRY_INVALID'), 'invalid entries use TARGET_ENTRY_INVALID code');
    t.assert(result.invalidEntries.some(e => e.reason === 'PATH_NOT_FOUND'), 'missing target reason is PATH_NOT_FOUND');
    t.assert(result.invalidEntries.some(e => e.reason === 'NOT_UPROJECT'), 'wrong extension reason is NOT_UPROJECT');
    t.assert(result.invalidEntries.some(e => e.reason === 'NOT_FILE'), 'directory target reason is NOT_FILE');
  } finally {
    cleanup(repoRoot);
  }
}

// Valid target file exposes unique aliases.
{
  const repoRoot = makeTempRoot();
  try {
    const projectA = writeProject(join(repoRoot, 'ProjectA'), 'ProjectA');
    const projectB = writeProject(join(repoRoot, 'ProjectB'), 'ProjectB');
    writeFileSync(join(repoRoot, '.uemcp-targets.txt'), `${projectA}\n${projectB}\n`, 'utf8');

    const result = readProjectTargets({ repoRoot, clientRoots: [repoRoot] });
    t.assert(result.status === 'valid', `valid target file status is valid (got ${result.status})`);
    t.assert(result.aliases.ProjectA === result.candidates[0].canonicalUprojectPath, 'unique ProjectA alias maps to canonical path');
    t.assert(result.aliases.ProjectB === result.candidates[1].canonicalUprojectPath, 'unique ProjectB alias maps to canonical path');
    t.assert(result.aliasCollisions.length === 0, 'unique aliases have no collisions');
  } finally {
    cleanup(repoRoot);
  }
}

// Duplicate stems do not make the bare stem authoritative.
{
  const repoRoot = makeTempRoot();
  try {
    const one = writeProject(join(repoRoot, 'Alpha', 'Game'), 'Game');
    const two = writeProject(join(repoRoot, 'Beta', 'Game'), 'Game');
    writeFileSync(join(repoRoot, '.uemcp-targets.txt'), `${one}\n${two}\n`, 'utf8');

    const result = readProjectTargets({ repoRoot, clientRoots: [repoRoot] });
    t.assert(result.status === 'valid', `duplicate-stem target file remains valid (got ${result.status})`);
    t.assert(!Object.prototype.hasOwnProperty.call(result.aliases, 'Game'), 'duplicate bare stem is not an alias');
    t.assert(result.aliasCollisions.length === 1, `one alias collision reported (got ${result.aliasCollisions.length})`);
    t.assert(result.aliasCollisions[0].alias === 'Game', `collision alias is Game (got ${result.aliasCollisions[0].alias})`);

    const aliases = buildTargetAliases(result.candidates);
    const generatedAliasNames = Object.keys(aliases.aliases).sort();
    t.assert(generatedAliasNames.length === 2, `two disambiguated aliases generated (got ${generatedAliasNames.length})`);
    t.assert(generatedAliasNames.every(a => /^Game-[^-]+-[0-9a-f]{8}$/.test(a)), `aliases include parent and hash (${generatedAliasNames.join(', ')})`);
    t.assert(generatedAliasNames.some(a => a.includes(`-${basename(join(repoRoot, 'Alpha'))}-`) || a.includes('-Game-')), 'generated aliases include stable display components');
  } finally {
    cleanup(repoRoot);
  }
}

const failed = t.summary();
process.exit(failed ? 1 : 0);
