// migrate-targets helper and CLI tests.
//
// Run: cd server && node test-migrate-targets.mjs

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { TestRunner } from './test-helpers.mjs';
import {
  migrateLegacyTargetsToProfiles,
  parseTargetProfilesFile,
} from './project-targets.mjs';

const t = new TestRunner('Migrate Targets Tests');
const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = dirname(SERVER_DIR);

function makeTempRoot() {
  return mkdtempSync(join(tmpdir(), 'uemcp-migrate-targets-'));
}

function cleanup(dir) {
  const norm = dir.replace(/\\/g, '/');
  const tmp = tmpdir().replace(/\\/g, '/').replace(/\/+$/, '');
  if (!norm.startsWith(`${tmp}/uemcp-migrate-targets-`)) {
    throw new Error(`refusing to clean unexpected temp path: ${dir}`);
  }
  rmSync(dir, { recursive: true, force: true });
}

function writeProject(root, name) {
  mkdirSync(root, { recursive: true });
  mkdirSync(join(root, 'Content'), { recursive: true });
  const uprojectPath = join(root, `${name}.uproject`);
  writeFileSync(uprojectPath, '{"FileVersion":3}\n', 'utf8');
  return uprojectPath;
}

function runMigrate(args) {
  return spawnSync(process.execPath, ['migrate-targets.mjs', '--no-color', ...args], {
    cwd: SERVER_DIR,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
}

{
  const root = makeTempRoot();
  try {
    const legacyPath = join(root, '.uemcp-targets.txt');
    const configPath = join(root, '.uemcp-targets.json');
    const result = migrateLegacyTargetsToProfiles({ legacyTargetsPath: legacyPath, configPath });

    t.assert(result.status === 'missing', `missing legacy file reports missing (got ${result.status})`);
    t.assert(!existsSync(configPath), 'missing legacy file does not create json config');
  } finally {
    cleanup(root);
  }
}

{
  const root = makeTempRoot();
  try {
    const projectA = writeProject(join(root, 'ProjectA'), 'ProjectA');
    const projectB = writeProject(join(root, 'ProjectB'), 'ProjectB');
    const legacyPath = join(root, '.uemcp-targets.txt');
    const configPath = join(root, '.uemcp-targets.json');
    writeFileSync(legacyPath, [
      '# comment only line',
      projectA,
      '',
      `${projectB} # trailing comment`,
      '',
    ].join('\n'), 'utf8');

    const first = migrateLegacyTargetsToProfiles({ legacyTargetsPath: legacyPath, configPath });
    const parsed = parseTargetProfilesFile(readFileSync(configPath, 'utf8'));
    t.assert(first.status === 'migrated', `first migration reports migrated (got ${first.status})`);
    t.assert(first.migrated.length === 2, `two targets migrated (got ${first.migrated.length})`);
    t.assert(Object.keys(parsed.targets).length === 2, `json contains two target aliases (got ${Object.keys(parsed.targets).length})`);
    for (const profile of ['default', 'smoke', 'release-gate']) {
      t.assert(parsed.profiles[profile].length === 2, `${profile} includes both migrated targets`);
    }

    const second = migrateLegacyTargetsToProfiles({ legacyTargetsPath: legacyPath, configPath });
    const reparsed = parseTargetProfilesFile(readFileSync(configPath, 'utf8'));
    t.assert(second.status === 'unchanged', `second migration reports unchanged (got ${second.status})`);
    t.assert(Object.keys(reparsed.targets).length === 2, 'idempotent migration does not duplicate targets');
  } finally {
    cleanup(root);
  }
}

{
  const root = makeTempRoot();
  try {
    const projectA = writeProject(join(root, 'ProjectA'), 'ProjectA');
    const legacyPath = join(root, 'targets.txt');
    const configPath = join(root, 'targets.json');
    writeFileSync(legacyPath, `${projectA}\n`, 'utf8');

    const result = runMigrate(['--from', legacyPath, '--to', configPath, '--json']);
    const payload = JSON.parse(result.stdout);
    const parsed = parseTargetProfilesFile(readFileSync(configPath, 'utf8'));
    t.assert(result.status === 0, `CLI migration exits 0 (got ${result.status})`);
    t.assert(payload.status === 'migrated', `CLI reports migrated (got ${payload.status})`);
    t.assert(parsed.profiles.smoke.length === 1, 'CLI writes smoke profile entry');
  } finally {
    cleanup(root);
  }
}

{
  const scriptText = readFileSync(join(REPO_ROOT, 'migrate-targets.bat'), 'utf8');
  t.assert(scriptText.includes('server\\migrate-targets.mjs'), 'root migrate-targets.bat invokes server helper');
}

process.exit(t.summary());
