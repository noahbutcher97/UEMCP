import { spawnSync } from 'node:child_process';
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { TestRunner } from './test-helpers.mjs';

const t = new TestRunner('Plugin BuildPlugin matrix helper');
const scriptPath = fileURLToPath(new URL('../test-plugin-build-matrix.ps1', import.meta.url));

async function readLinesIfPresent(path) {
  try {
    return (await readFile(path, 'utf8')).trim().split(/\r?\n/).filter(Boolean);
  } catch {
    return [];
  }
}

async function readJsonLinesIfPresent(path) {
  return (await readLinesIfPresent(path)).map((line) => JSON.parse(line));
}

async function allPathsExist(paths) {
  for (const path of paths) {
    try {
      await access(path);
    } catch {
      return false;
    }
  }
  return true;
}

let scriptSource = '';
try {
  scriptSource = await readFile(scriptPath, 'utf8');
} catch {
  // The first TDD run intentionally reaches this path.
}

t.assert(scriptSource.length > 0, 'matrix helper exists');

if (scriptSource.length > 0) {
  const leaseRevalidationIndex = scriptSource.indexOf('$leasedOutputRootPath =');
  const stageCopyIndex = scriptSource.indexOf('Copy-PluginSource $pluginRoot');
  const leaseRevalidationBlock = scriptSource.slice(leaseRevalidationIndex, stageCopyIndex);
  t.assert(leaseRevalidationIndex >= 0
    && stageCopyIndex > leaseRevalidationIndex
    && leaseRevalidationBlock.includes('StartsWith($pluginRootPrefix')
    && leaseRevalidationBlock.includes('$outputRootPath = $leasedOutputRootPath'),
  'matrix helper revalidates and adopts its leased physical output path before staging');

  const testRoot = await mkdtemp(join(tmpdir(), 'uemcp-build-matrix-test-'));
  const testRootAlias = `${testRoot}-alias`;
  try {
    const epicRoot = join(testRoot, 'Epic Games');
    const pluginPath = join(testRoot, 'Plugin Source', 'UEMCP.uplugin');
    const sourceFixture = join(testRoot, 'tcp-transport-cases.json');
    const invocationLog = join(testRoot, 'invocations.txt');
    const argumentLog = join(testRoot, 'arguments.jsonl');
    const versions = ['5.3', '5.6', '5.7'];
    const fakeBatch = `@echo off
setlocal
"%UEMCP_FAKE_NODE%" "%~dp0fake-uat.mjs" %*
exit /b %ERRORLEVEL%
`.replace(/\n/g, '\r\n');
    const fakeUat = `import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const [command, ...args] = process.argv.slice(2);
if (command !== 'BuildPlugin') process.exit(91);

const packageArg = args.find((arg) => arg.startsWith('-Package='));
const pluginArg = args.find((arg) => arg.startsWith('-Plugin='));
if (!packageArg || packageArg.length === '-Package='.length) process.exit(92);
if (!pluginArg || pluginArg.length === '-Plugin='.length) process.exit(93);
if (!args.includes('-TargetPlatforms=Win64')) process.exit(94);
if (!args.includes('-Rocket')) process.exit(95);

const packagePath = packageArg.slice('-Package='.length);
const pluginPath = pluginArg.slice('-Plugin='.length);
const engineRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const version = basename(engineRoot).replace(/^UE_/, '');
let outputLockHeld = null;
if (process.env.UEMCP_FAKE_PROBE_OUTPUT_LOCK === '1' && version === '5.3') {
  const outputRoot = dirname(packagePath);
  const movedRoot = outputRoot + '-rename-probe';
  outputLockHeld = true;
  try {
    renameSync(outputRoot, movedRoot);
    outputLockHeld = false;
    renameSync(movedRoot, outputRoot);
  } catch {
    // The helper's no-delete-share lease must reject the first rename.
  }
  if (!outputLockHeld) process.exit(96);
}
appendFileSync(process.env.UEMCP_FAKE_MATRIX_LOG, version + '\\n');
appendFileSync(process.env.UEMCP_FAKE_ARGUMENT_LOG,
  JSON.stringify({ version, plugin: pluginPath, package: packagePath, args, outputLockHeld }) + '\\n');
console.log('UEMCP_FAKE_STDOUT_CHATTER ' + version);
console.error('UEMCP_FAKE_STDERR_CHATTER ' + version);

if (process.env.UEMCP_FAKE_WRITE_FILTER === '1') {
  const configDirectory = join(dirname(pluginPath), 'Config');
  const filterPath = join(configDirectory, 'FilterPlugin.ini');
  mkdirSync(configDirectory, { recursive: true });
  if (!existsSync(filterPath)) {
    writeFileSync(filterPath,
      '[FilterPlugin]\\r\\n; This section lists additional files which will be packaged along with your plugin.\\r\\n');
  }
}

if (process.env.UEMCP_FAKE_FAIL_VERSION === version) process.exit(7);
if (process.env.UEMCP_FAKE_SKIP_FIXTURE_VERSION === version) process.exit(0);
const fixtureDirectory = join(packagePath, 'Resources', 'Tests');
mkdirSync(fixtureDirectory, { recursive: true });
copyFileSync(process.env.UEMCP_FAKE_FIXTURE,
  join(fixtureDirectory, 'tcp-transport-cases.json'));
`;

    await mkdir(dirname(pluginPath), { recursive: true });
    await writeFile(pluginPath, '{"FileVersion":3}', 'utf8');
    await writeFile(sourceFixture, '{"schema_version":1,"cases":[]}', 'utf8');
    for (const version of versions) {
      const batchPath = join(epicRoot, `UE_${version}`, 'Engine', 'Build', 'BatchFiles', 'RunUAT.bat');
      await mkdir(dirname(batchPath), { recursive: true });
      await writeFile(batchPath, fakeBatch, 'utf8');
      await writeFile(join(dirname(batchPath), 'fake-uat.mjs'), fakeUat, 'utf8');
    }
    await symlink(testRoot, testRootAlias, 'junction');

    const deceptiveTargetArgument = spawnSync(
      process.execPath,
      [
        join(epicRoot, 'UE_5.3', 'Engine', 'Build', 'BatchFiles', 'fake-uat.mjs'),
        'BuildPlugin',
        `-Plugin=${pluginPath}`,
        `-Package=${join(testRoot, 'deceptive package')}`,
        '-Unused=-TargetPlatforms=Win64',
        '-Rocket',
      ],
      { encoding: 'utf8', env: process.env, timeout: 120_000 }
    );
    t.assert(deceptiveTargetArgument.status === 94,
      'fake UAT rejects target-platform text embedded inside another argument',
      `${deceptiveTargetArgument.status}: ${deceptiveTargetArgument.stderr}`);

    const baseArgs = [
      '-NoProfile',
      '-ExecutionPolicy', 'Bypass',
      '-File', scriptPath,
      '-VersionsCsv', versions.join(','),
      '-EpicGamesRoot', epicRoot,
      '-Plugin', pluginPath,
      '-Json',
    ];
    const baseEnv = {
      ...process.env,
      UEMCP_FAKE_NODE: process.execPath,
      UEMCP_FAKE_FIXTURE: sourceFixture,
      UEMCP_FAKE_MATRIX_LOG: invocationLog,
      UEMCP_FAKE_ARGUMENT_LOG: argumentLog,
      UEMCP_FAKE_FAIL_VERSION: '',
      UEMCP_FAKE_PROBE_OUTPUT_LOCK: '1',
      UEMCP_FAKE_SKIP_FIXTURE_VERSION: '',
      UEMCP_FAKE_WRITE_FILTER: '1',
    };

    const successOutput = join(testRootAlias, 'success output');
    const success = spawnSync('powershell.exe', [...baseArgs, '-OutputRoot', successOutput], {
      encoding: 'utf8',
      env: baseEnv,
      timeout: 120_000,
    });
    t.assert(success.status === 0,
      'matrix helper succeeds across every requested fake engine',
      `${success.status}: ${success.stderr || success.stdout}`);
    const successInvocations = await readLinesIfPresent(invocationLog);
    t.assert(JSON.stringify(successInvocations) === JSON.stringify(versions),
      'matrix helper invokes requested engines in declared order',
      JSON.stringify(successInvocations));
    const successArguments = await readJsonLinesIfPresent(argumentLog);
    const physicalSuccessOutput = await realpath(successOutput);
    const physicalStagedPlugins = await Promise.all(
      successArguments.map((record) => realpath(record.plugin)),
    );
    t.assert(successArguments.length === versions.length
      && physicalStagedPlugins.every((plugin) => {
        const stagedRelativePath = relative(physicalSuccessOutput, plugin);
        return stagedRelativePath !== ''
          && stagedRelativePath !== '..'
          && !stagedRelativePath.startsWith(`..${sep}`)
          && !isAbsolute(stagedRelativePath);
      }),
    'matrix helper invokes UAT with per-run plugin sources staged under its output root',
    JSON.stringify({ physicalSuccessOutput, physicalStagedPlugins, successArguments }));
    t.assert(successArguments[0]?.outputLockHeld === true,
      'matrix helper holds a no-delete-share lease on its output root during UAT');
    let results = [];
    try {
      results = JSON.parse(success.stdout);
    } catch {
      // The assertion below reports the malformed output.
    }
    t.assert(Array.isArray(results) && results.length === versions.length,
      'matrix helper emits one JSON result per engine', success.stdout);
    t.assert(success.stderr.includes('UEMCP_FAKE_STDOUT_CHATTER 5.3')
      && success.stderr.includes('UEMCP_FAKE_STDERR_CHATTER 5.7'),
    'matrix helper routes BuildPlugin stdout and stderr chatter away from JSON stdout',
    success.stderr);
    t.assert(results.every((result, index) => result.version === versions[index]
      && result.exit_code === 0
      && result.staged_source === dirname(successArguments[index].plugin)
      && result.fixture_sha256?.length === 64),
    'matrix results preserve version, exit status, staged source, and fixture hash');
    for (const version of versions) {
      await access(join(successOutput, `UE-${version}`, 'Resources', 'Tests', 'tcp-transport-cases.json'));
    }
    t.assert(true, 'matrix helper verifies fixture packaging for every engine');
    let generatedFilterExists = true;
    try {
      await access(join(dirname(pluginPath), 'Config', 'FilterPlugin.ini'));
    } catch {
      generatedFilterExists = false;
    }
    t.assert(!generatedFilterExists,
      'matrix helper isolates BuildPlugin-generated FilterPlugin.ini from source');
    t.assert(await allPathsExist(successArguments.map((record) => dirname(record.plugin))),
      'matrix helper retains staged plugin sources after successful packaging');

    await writeFile(invocationLog, '', 'utf8');
    await writeFile(argumentLog, '', 'utf8');
    const failureOutput = join(testRoot, 'failure output');
    const failure = spawnSync('powershell.exe', [...baseArgs, '-OutputRoot', failureOutput], {
      encoding: 'utf8',
      env: { ...baseEnv, UEMCP_FAKE_FAIL_VERSION: '5.6' },
      timeout: 120_000,
    });
    t.assert(failure.status !== 0,
      'matrix helper propagates a failing BuildPlugin exit');
    const failureInvocations = await readLinesIfPresent(invocationLog);
    t.assert(JSON.stringify(failureInvocations) === JSON.stringify(['5.3', '5.6']),
      'matrix helper stops before later engines after a failure',
      JSON.stringify(failureInvocations));
    const failureArguments = await readJsonLinesIfPresent(argumentLog);
    t.assert(await allPathsExist(failureArguments.map((record) => dirname(record.plugin))),
      'matrix helper retains staged plugin sources after a BuildPlugin failure');
    generatedFilterExists = true;
    try {
      await access(join(dirname(pluginPath), 'Config', 'FilterPlugin.ini'));
    } catch {
      generatedFilterExists = false;
    }
    t.assert(!generatedFilterExists,
      'matrix helper cleans generated filter state on failure');

    await writeFile(invocationLog, '', 'utf8');
    await writeFile(argumentLog, '', 'utf8');
    const missingFixtureOutput = join(testRoot, 'missing fixture output');
    const missingFixture = spawnSync(
      'powershell.exe',
      [...baseArgs, '-OutputRoot', missingFixtureOutput],
      {
        encoding: 'utf8',
        env: { ...baseEnv, UEMCP_FAKE_SKIP_FIXTURE_VERSION: '5.6' },
        timeout: 120_000,
      }
    );
    t.assert(missingFixture.status !== 0,
      'matrix helper rejects a successful BuildPlugin run that omits the fixture');
    const missingFixtureInvocations = await readLinesIfPresent(invocationLog);
    t.assert(JSON.stringify(missingFixtureInvocations) === JSON.stringify(['5.3', '5.6']),
      'matrix helper stops before later engines after a missing fixture',
      JSON.stringify(missingFixtureInvocations));
    t.assert((missingFixture.stderr || missingFixture.stdout).includes('omitted TCP transport fixtures'),
      'matrix helper reports the omitted fixture path',
      missingFixture.stderr || missingFixture.stdout);
    const missingFixtureArguments = await readJsonLinesIfPresent(argumentLog);
    t.assert(await allPathsExist(missingFixtureArguments.map((record) => dirname(record.plugin))),
      'matrix helper retains staged plugin sources after fixture validation fails');

    await writeFile(invocationLog, '', 'utf8');
    const defaultPluginOutput = join(testRoot, 'default plugin output');
    const omittedDefaultArgs = new Set(['-Plugin', '-VersionsCsv']);
    const defaultPluginArgs = baseArgs.filter((value, index) => {
      return !omittedDefaultArgs.has(value) && !omittedDefaultArgs.has(baseArgs[index - 1]);
    });
    const defaultPlugin = spawnSync(
      'powershell.exe',
      [...defaultPluginArgs, '-VersionsCsv', '5.3', '-OutputRoot', defaultPluginOutput],
      {
        encoding: 'utf8',
        env: { ...baseEnv, UEMCP_FAKE_WRITE_FILTER: '0' },
        timeout: 120_000,
      }
    );
    t.assert(defaultPlugin.status === 0,
      'matrix helper resolves its repository plugin default when -Plugin is omitted',
      `${defaultPlugin.status}: ${defaultPlugin.stderr || defaultPlugin.stdout}`);

    const existingOutput = join(testRoot, 'existing output');
    const sentinelPath = join(existingOutput, 'sentinel.txt');
    await mkdir(existingOutput, { recursive: true });
    await writeFile(sentinelPath, 'owned', 'utf8');
    await writeFile(invocationLog, '', 'utf8');
    const existingOutputRun = spawnSync(
      'powershell.exe',
      [...baseArgs, '-OutputRoot', existingOutput],
      { encoding: 'utf8', env: baseEnv, timeout: 120_000 }
    );
    t.assert(existingOutputRun.status !== 0,
      'matrix helper refuses an existing output root');
    t.assert(await readFile(sentinelPath, 'utf8') === 'owned',
      'matrix helper preserves files under a refused output root');
    t.assert((await readLinesIfPresent(invocationLog)).length === 0,
      'matrix helper invokes no engine after refusing an output root');

    const nestedOutput = join(dirname(pluginPath), 'matrix output');
    await writeFile(invocationLog, '', 'utf8');
    const nestedOutputRun = spawnSync(
      'powershell.exe',
      [...baseArgs, '-OutputRoot', nestedOutput],
      { encoding: 'utf8', env: baseEnv, timeout: 120_000 }
    );
    t.assert(nestedOutputRun.status !== 0
      && (nestedOutputRun.stderr || nestedOutputRun.stdout).includes(
        'OutputRoot cannot be inside the plugin source directory'),
    'matrix helper rejects an output root nested under plugin source');
    let nestedOutputExists = true;
    try {
      await access(nestedOutput);
    } catch {
      nestedOutputExists = false;
    }
    t.assert(!nestedOutputExists,
      'matrix helper creates no nested output before rejecting it');
    t.assert((await readLinesIfPresent(invocationLog)).length === 0,
      'matrix helper invokes no engine for a nested output root');

    const pluginAlias = join(testRoot, 'Plugin Source Alias');
    const aliasedOutputName = 'aliased matrix output';
    const aliasedOutput = join(pluginAlias, aliasedOutputName);
    const physicalAliasedOutput = join(dirname(pluginPath), aliasedOutputName);
    await symlink(dirname(pluginPath), pluginAlias, 'junction');
    try {
      await writeFile(invocationLog, '', 'utf8');
      const aliasedOutputRun = spawnSync(
        'powershell.exe',
        [...baseArgs, '-OutputRoot', aliasedOutput],
        { encoding: 'utf8', env: baseEnv, timeout: 120_000 }
      );
      t.assert(aliasedOutputRun.status !== 0
        && (aliasedOutputRun.stderr || aliasedOutputRun.stdout).includes(
          'OutputRoot cannot be inside the plugin source directory'),
      'matrix helper rejects an output root aliased into plugin source');
      let physicalAliasedOutputExists = true;
      try {
        await access(physicalAliasedOutput);
      } catch {
        physicalAliasedOutputExists = false;
      }
      t.assert(!physicalAliasedOutputExists,
        'matrix helper creates no physical output through a plugin-source alias');
      t.assert((await readLinesIfPresent(invocationLog)).length === 0,
        'matrix helper invokes no engine for an aliased output root');
    } finally {
      await rm(pluginAlias, { recursive: true, force: true });
    }

    const missingParent = join(testRoot, 'missing output parent');
    const deepOutput = join(missingParent, 'matrix output');
    await writeFile(invocationLog, '', 'utf8');
    const deepOutputRun = spawnSync(
      'powershell.exe',
      [...baseArgs, '-OutputRoot', deepOutput],
      { encoding: 'utf8', env: baseEnv, timeout: 120_000 }
    );
    t.assert(deepOutputRun.status !== 0
      && (deepOutputRun.stderr || deepOutputRun.stdout).includes(
        'OutputRoot must be a new direct child of an existing directory'),
    'matrix helper rejects an output root with a missing immediate parent');
    let missingParentExists = true;
    try {
      await access(missingParent);
    } catch {
      missingParentExists = false;
    }
    t.assert(!missingParentExists,
      'matrix helper creates no intermediate output directories');
    t.assert((await readLinesIfPresent(invocationLog)).length === 0,
      'matrix helper invokes no engine when the output parent is missing');

    const configDirectory = join(dirname(pluginPath), 'Config');
    const ownedFilter = join(configDirectory, 'FilterPlugin.ini');
    const ownedFilterContent = `[FilterPlugin]\r\n; This section lists additional files which will be packaged along with your plugin.\r\n/Resources/...\r\n`;
    await mkdir(configDirectory, { recursive: true });
    await writeFile(ownedFilter, ownedFilterContent, 'utf8');
    const ownedFilterOutput = join(testRoot, 'owned filter output');
    const ownedFilterRun = spawnSync(
      'powershell.exe',
      [...baseArgs, '-OutputRoot', ownedFilterOutput],
      { encoding: 'utf8', env: baseEnv, timeout: 120_000 }
    );
    t.assert(ownedFilterRun.status === 0,
      'matrix helper succeeds when source already owns FilterPlugin.ini',
      `${ownedFilterRun.status}: ${ownedFilterRun.stderr || ownedFilterRun.stdout}`);
    t.assert(await readFile(ownedFilter, 'utf8') === ownedFilterContent,
      'matrix helper preserves a source filter even when it contains Unreal boilerplate markers');
  } finally {
    await rm(testRootAlias, { recursive: true, force: true });
    await rm(testRoot, { recursive: true, force: true });
  }
}

process.exit(t.summary());
