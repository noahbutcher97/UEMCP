// Project target-file parsing and alias tests.
//
// Run: cd server && node test-project-targets.mjs

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import { TestRunner } from './test-helpers.mjs';
import {
  buildTargetAliases,
  parseTargetsFile,
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
