// verify-deploy structured target profile CLI tests.
//
// Run: cd server && node test-verify-deploy-profiles.mjs

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { TestRunner } from './test-helpers.mjs';

const t = new TestRunner('Verify Deploy Profile CLI Tests');
const SERVER_DIR = dirname(fileURLToPath(import.meta.url));

function makeTempRoot() {
  return mkdtempSync(join(tmpdir(), 'uemcp-verify-profile-'));
}

function cleanup(dir) {
  const norm = dir.replace(/\\/g, '/');
  const tmp = tmpdir().replace(/\\/g, '/').replace(/\/+$/, '');
  if (!norm.startsWith(`${tmp}/uemcp-verify-profile-`)) {
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

function runVerifyDeploy(args) {
  return spawnSync(process.execPath, ['verify-deploy.mjs', '--no-color', ...args], {
    cwd: SERVER_DIR,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
}

{
  const root = makeTempRoot();
  try {
    const projectA = writeProject(join(root, 'ProjectA'), 'ProjectA');
    const projectB = writeProject(join(root, 'ProjectB'), 'ProjectB');
    const targetsJson = join(root, 'targets.json');
    writeFileSync(targetsJson, `${JSON.stringify({
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
    }, null, 2)}\n`, 'utf8');

    const result = runVerifyDeploy(['--targets', targetsJson, '--profile', 'smoke', '--quiet']);
    const output = `${result.stdout}\n${result.stderr}`;
    const projectANormalized = projectA.replace(/\\/g, '/');
    const projectBNormalized = projectB.replace(/\\/g, '/');
    t.assert(result.status === 1, `profile smoke resolves and reaches deploy verdict phase (got exit ${result.status})`);
    t.assert(/Targets source\s+: .*targets\.json/.test(output), 'output names structured targets file');
    t.assert(/Profile\s+: smoke/.test(output), 'output names selected profile');
    t.assert(output.includes(projectBNormalized), 'smoke profile output includes selected project-b');
    t.assert(!output.includes(projectANormalized), 'smoke profile output excludes project-a');
  } finally {
    cleanup(root);
  }
}

{
  const root = makeTempRoot();
  try {
    const projectA = writeProject(join(root, 'ProjectA'), 'ProjectA');
    const targetsJson = join(root, 'targets.json');
    writeFileSync(targetsJson, `${JSON.stringify({
      version: 1,
      profiles: {
        default: ['project-a'],
      },
      targets: {
        'project-a': { uproject: projectA },
      },
    }, null, 2)}\n`, 'utf8');

    const result = runVerifyDeploy(['--targets', targetsJson, '--profile', 'release-gate']);
    const output = `${result.stdout}\n${result.stderr}`;
    t.assert(result.status === 2, `unknown profile is config error (got exit ${result.status})`);
    t.assert(/Profile not found: release-gate/.test(output), 'unknown profile error names missing profile');
  } finally {
    cleanup(root);
  }
}

process.exit(t.summary());
