// Offline profile, CLI and injected native-process controls. Never starts Unreal.
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { TestRunner, createCanonicalScratchRoot, cleanupCanonicalScratchRoot } from './test-helpers.mjs';
import { loadTestProfile, collectSourceState, collectFixtureIdentity, validateExecution, REPOSITORY_ROOT, sha256 } from './execution-manifest.mjs';
import { parseAutomationReport, reportExitCode } from './native-test-report.mjs';
import { main, parseRunnerArgs } from './run-native-tests.mjs';

const t = new TestRunner('native core profile (offline)');
const names = [
  'UEMCP.MCPResponseBuilder.BuildError',
  'UEMCP.TransformParser.Valid',
  'UEMCP.TransformParser.Invalid',
  'UEMCP.ActorLookupHelper.Guards',
  'UEMCP.PropertyHandlerRegistry.Scalars',
  'UEMCP.PropertyHandlerRegistry.Invalid',
  'UEMCP.MCPCommandRegistry.Dispatch',
  'UEMCP.MCPCommandRegistry.CustomRegister',
];
const profile = loadTestProfile('native-core');
t.assert(profile.runner === 'native' && JSON.stringify(profile.suites) === JSON.stringify([{ name: 'native', cases: names }]), 'core requires exactly the eight reviewed native names');
t.assert(JSON.stringify(profile.capabilities) === '["engine","nullrhi"]' && profile.fixturePaths.length === 0, 'core declares engine and NullRHI without saved fixtures');
const source = readFileSync(new URL('../plugin/UEMCP/Source/UEMCP/Private/Tests/UEMCPTests.cpp', import.meta.url), 'utf8');
const registrations = [...source.matchAll(/IMPLEMENT_SIMPLE_AUTOMATION_TEST\s*\(\s*\w+\s*,\s*"([^"]+)"/g)].map(match => match[1]);
for (const name of names) t.assert(registrations.filter(value => value === name).length === 1, `core source registers ${name} exactly once`);
t.assert(!names.includes('UEMCP.MCPResponseBuilder.BuildSuccess') && loadTestProfile('native-smoke').suites[0].cases.includes('UEMCP.MCPResponseBuilder.BuildSuccess'), 'core leaves BuildSuccess in the existing smoke profile');
t.assert(loadTestProfile('native-transport').suites[0].cases.length === 7 && loadTestProfile('native-blueprint').suites[0].cases.length === 14, 'existing transport and blueprint profiles remain separately loadable');
const parsedArgs = parseRunnerArgs(['--test-profile', 'native-core', '--profile', 'target-profile', '--timeout-ms', '900000']);
t.assert(parsedArgs.testProfile === 'native-core' && parsedArgs.profile === 'target-profile' && parsedArgs.timeoutMs === 900000, 'core CLI keeps target selection separate and accepts the 900s budget');

const tests = names.map(fullTestPath => ({ fullTestPath, state: 'Success' }));
for (const name of names) {
  const incomplete = parseAutomationReport({ tests: tests.filter(test => test.fullTestPath !== name) });
  t.assert(reportExitCode(incomplete, { expectedNames: names }) === 1, `core rejects omission of ${name} despite seven successes`);
}
const sourceState = collectSourceState(REPOSITORY_ROOT);
const evidence = {
  schemaVersion: 1, profile: profile.name, manifestDigest: profile.manifestDigest,
  sourceState, fixtureIdentity: collectFixtureIdentity(REPOSITORY_ROOT, profile.fixturePaths),
  suites: [{ name: 'native', state: 'passed', cases: names.map(name => ({ name, state: 'passed' })) }],
};
t.assert(validateExecution(evidence, profile, sourceState).length === 0, 'core exact evidence binds the source and empty fixture inventory');
const wrongSource = structuredClone(evidence);
wrongSource.sourceState.head = '0'.repeat(40);
const { digest: ignoredDigest, ...rawSource } = wrongSource.sourceState;
wrongSource.sourceState.digest = sha256(JSON.stringify(rawSource));
t.assert(validateExecution(wrongSource, profile, sourceState).includes('Wrong source state'), 'core rejects self-consistent evidence for another source revision');

const scratch = createCanonicalScratchRoot('uemcp-core-');
try {
  const project = join(scratch, 'Fake.uproject');
  writeFileSync(project, JSON.stringify({ EngineAssociation: '5.6' }));
  const binaries = join(scratch, 'Plugins/UEMCP/Binaries/Win64');
  mkdirSync(binaries, { recursive: true });
  writeFileSync(join(binaries, 'UnrealEditor-UEMCP.dll'), 'offline preflight marker, not a library');
  const cleared = { ...process.env };
  for (const key of Object.keys(cleared)) {
    if (['UNREAL_PROJECT_ROOT', 'UEMCP_PROJECT_ATTACH_MODE', 'UE_ENGINE_ROOT'].includes(key.toUpperCase())) delete cleared[key];
  }
  const invalid = { ...cleared, UNREAL_PROJECT_ROOT: join(scratch, 'absent-project'), UEMCP_PROJECT_ATTACH_MODE: 'env', UE_ENGINE_ROOT: join(scratch, 'absent-engine') };
  for (const [context, env] of [['cleared', cleared], ['invalid', invalid]]) {
    const dryReport = join(scratch, `dry-${context}`);
    const cliArgs = ['--uproject', project, '--engine-root', scratch, '--test-profile', 'native-core', '--timeout-ms', '900000', '--report-dir', dryReport];
    const dryRun = spawnSync(process.execPath, [join(REPOSITORY_ROOT, 'server/run-native-tests.mjs'), ...cliArgs, '--dry-run'], { env, encoding: 'utf8', timeout: 30000, windowsHide: true });
    t.assert(dryRun.status === 0 && dryRun.stdout.includes(`Automation RunTests ${names.join('+')};Quit`) && dryRun.stdout.includes(project), `core CLI dry-run uses explicit project and all eight names with ${context} ambient context`, dryRun.stderr);
    const missingProject = spawnSync(process.execPath, [join(REPOSITORY_ROOT, 'server/run-native-tests.mjs'), ...cliArgs, '--uproject', join(scratch, 'missing.uproject')], { env, encoding: 'utf8', timeout: 30000, windowsHide: true });
    t.assert(missingProject.status === 2 && missingProject.stderr.includes('uproject not found'), `core CLI missing explicit project fails before launch with ${context} ambient context`);
    for (const [label, records, status, editorExit, expected, problem] of [
      ['complete', tests, 'exited', 0, 0, null],
      ['missing', tests.slice(1), 'exited', 0, 1, 'missing required test:'],
      ['duplicate', [...tests, tests[0]], 'exited', 0, 1, 'duplicate test:'],
      ['unexpected', [...tests, { fullTestPath: 'UEMCP.Unreviewed', state: 'Success' }], 'exited', 0, 1, 'unexpected test:'],
      ['display-only', tests.map(({ fullTestPath, ...test }) => ({ ...test, testDisplayName: fullTestPath })), 'exited', 0, 1, 'missing fullTestPath:'],
      ['not-run', [{ ...tests[0], state: 'NotRun' }, ...tests.slice(1)], 'exited', 0, 1, ': NotRun'],
      ['skip', [{ ...tests[0], entries: [{ event: { type: 'Info', message: 'skipped: unavailable' } }] }, ...tests.slice(1)], 'exited', 0, 1, ': labelled skip'],
      ['error', [{ ...tests[0], entries: [{ event: { type: 'Error', message: 'assertion failed' } }] }, ...tests.slice(1)], 'exited', 0, 1, ': Error events'],
      ['nonzero', tests, 'exited', 19, 1, 'editor did not exit successfully'],
      ['timeout', tests, 'timed_out', null, 3, 'editor timed out'],
      ['spawn-failure', tests, 'spawn_failed', null, 2, 'editor spawn failed'],
      ['empty', [], 'exited', 0, 4, 'missing required test:'],
      ['stale', tests, 'exited', 0, 4, 'REPORT_STALE'],
      ['missing-report', null, 'exited', 0, 4, 'REPORT_MISSING'],
      ['malformed', null, 'exited', 0, 4, 'REPORT_UNREADABLE'],
    ]) {
      const reportDir = join(scratch, `${context}-${label}`);
      mkdirSync(reportDir);
      let command;
      const code = await main(['--uproject', project, '--engine-root', scratch, '--test-profile', 'native-core', '--timeout-ms', '900000', '--report-dir', reportDir], {
        env, listEditors: () => [], portAvailable: async () => true,
        runner: { run: async (file, args, options) => {
          command = { file, args, options };
          const path = join(reportDir, 'index.json');
          if (records) writeFileSync(path, JSON.stringify({ tests: records }));
          if (label === 'malformed') writeFileSync(path, '{bad');
          if (label === 'stale') { const old = new Date(Date.now() - 60000); utimesSync(path, old, old); }
          return { status, exitCode: editorExit, stderr: '' };
        } },
      });
      const retained = JSON.parse(readFileSync(join(reportDir, 'execution-evidence.json'), 'utf8'));
      t.assert(code === expected && retained.exitCode === expected && retained.profile === 'native-core' && retained.sourceState.digest === sourceState.digest && (problem ? retained.problems.some(value => value.includes(problem)) : retained.problems.length === 0), `core mock ${context}/${label} retains source-bound outcome`, JSON.stringify({ code, problems: retained.problems }));
      if (label === 'complete') {
        t.assert(command.file === `${scratch}/Engine/Binaries/Win64/UnrealEditor-Cmd.exe` && command.args[0] === project && command.args.includes(`-ExecCmds=Automation RunTests ${names.join('+')};Quit`) && command.args.includes('-nullrhi') && command.options.timeoutMs === 900000 && command.options.cwd === scratch, `core mock ${context} selects exact command, project, NullRHI and 900s budget`);
        t.assert(retained.fixtureIdentity.files.length === 0 && retained.suites[0].state === 'passed' && JSON.stringify(retained.suites[0].cases) === JSON.stringify(evidence.suites[0].cases), `core mock ${context} retains all eight successful full names without saved assets`);
      }
    }
    for (const [label, editors, available] of [['same-project', [{ uprojectPath: project }], true], ['unknown-editor', [{}], true], ['port-conflict', [], false]]) {
      let launched = false;
      const code = await main([...cliArgs, '--report-dir', join(scratch, `${context}-${label}`)], {
        env, listEditors: () => editors, portAvailable: async () => available,
        runner: { run: async () => { launched = true; throw new Error('must not launch'); } },
      });
      t.assert(code === 2 && !launched, `core ${context}/${label} blocks process launch`);
    }
  }
} finally {
  cleanupCanonicalScratchRoot(scratch, 'uemcp-core-');
}
process.exit(t.summary() === 0 ? 0 : 1);
