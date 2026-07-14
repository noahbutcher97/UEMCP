import { spawnSync } from 'node:child_process';
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
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

let scriptSource = '';
try {
  scriptSource = await readFile(scriptPath, 'utf8');
} catch {
  // The first TDD run intentionally reaches this path.
}

t.assert(scriptSource.length > 0, 'matrix helper exists');

if (scriptSource.length > 0) {
  const testRoot = await mkdtemp(join(tmpdir(), 'uemcp-build-matrix-test-'));
  try {
    const epicRoot = join(testRoot, 'Epic Games');
    const pluginPath = join(testRoot, 'Plugin Source', 'UEMCP.uplugin');
    const sourceFixture = join(testRoot, 'tcp-transport-cases.json');
    const invocationLog = join(testRoot, 'invocations.txt');
    const versions = ['5.3', '5.6', '5.7'];
    const fakeBatch = `@echo off
setlocal EnableExtensions EnableDelayedExpansion
set "PACKAGE="
set "PLUGIN="
for %%A in (%*) do (
  set "ARG=%%~A"
  if /I "!ARG:~0,9!"=="-Package=" set "PACKAGE=!ARG:~9!"
  if /I "!ARG:~0,8!"=="-Plugin=" set "PLUGIN=!ARG:~8!"
)
for %%D in ("%~dp0..\\..\\..") do set "ENGINE_DIR=%%~nxD"
set "VERSION=!ENGINE_DIR:UE_=!"
echo !VERSION!>>"%UEMCP_FAKE_MATRIX_LOG%"
for %%D in ("!PLUGIN!") do set "PLUGIN_DIR=%%~dpD"
if /I "%UEMCP_FAKE_WRITE_FILTER%"=="1" (
  if not exist "!PLUGIN_DIR!Config" mkdir "!PLUGIN_DIR!Config"
  if not exist "!PLUGIN_DIR!Config\\FilterPlugin.ini" (
    >"!PLUGIN_DIR!Config\\FilterPlugin.ini" echo [FilterPlugin]
    >>"!PLUGIN_DIR!Config\\FilterPlugin.ini" echo ; This section lists additional files which will be packaged along with your plugin.
  )
)
if /I "%UEMCP_FAKE_FAIL_VERSION%"=="!VERSION!" exit /b 7
if not exist "!PACKAGE!\\Resources\\Tests" mkdir "!PACKAGE!\\Resources\\Tests"
copy /Y "%UEMCP_FAKE_FIXTURE%" "!PACKAGE!\\Resources\\Tests\\tcp-transport-cases.json" >nul
exit /b 0
`.replace(/\n/g, '\r\n');

    await mkdir(dirname(pluginPath), { recursive: true });
    await writeFile(pluginPath, '{"FileVersion":3}', 'utf8');
    await writeFile(sourceFixture, '{"schema_version":1,"cases":[]}', 'utf8');
    for (const version of versions) {
      const batchPath = join(epicRoot, `UE_${version}`, 'Engine', 'Build', 'BatchFiles', 'RunUAT.bat');
      await mkdir(dirname(batchPath), { recursive: true });
      await writeFile(batchPath, fakeBatch, 'utf8');
    }

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
      UEMCP_FAKE_FIXTURE: sourceFixture,
      UEMCP_FAKE_MATRIX_LOG: invocationLog,
      UEMCP_FAKE_FAIL_VERSION: '',
      UEMCP_FAKE_WRITE_FILTER: '1',
    };

    const successOutput = join(testRoot, 'success output');
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
    let results = [];
    try {
      results = JSON.parse(success.stdout);
    } catch {
      // The assertion below reports the malformed output.
    }
    t.assert(Array.isArray(results) && results.length === versions.length,
      'matrix helper emits one JSON result per engine', success.stdout);
    t.assert(results.every((result, index) => result.version === versions[index]
      && result.exit_code === 0
      && result.fixture_sha256?.length === 64),
    'matrix results preserve version, exit status, and packaged fixture hash');
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
      'matrix helper removes BuildPlugin-generated FilterPlugin.ini when source had none');

    await writeFile(invocationLog, '', 'utf8');
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
    generatedFilterExists = true;
    try {
      await access(join(dirname(pluginPath), 'Config', 'FilterPlugin.ini'));
    } catch {
      generatedFilterExists = false;
    }
    t.assert(!generatedFilterExists,
      'matrix helper cleans generated filter state on failure');

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

    const configDirectory = join(dirname(pluginPath), 'Config');
    const ownedFilter = join(configDirectory, 'FilterPlugin.ini');
    await mkdir(configDirectory, { recursive: true });
    await writeFile(ownedFilter, 'owned-filter', 'utf8');
    const ownedFilterOutput = join(testRoot, 'owned filter output');
    const ownedFilterRun = spawnSync(
      'powershell.exe',
      [...baseArgs, '-OutputRoot', ownedFilterOutput],
      { encoding: 'utf8', env: baseEnv, timeout: 120_000 }
    );
    t.assert(ownedFilterRun.status === 0,
      'matrix helper succeeds when source already owns FilterPlugin.ini',
      `${ownedFilterRun.status}: ${ownedFilterRun.stderr || ownedFilterRun.stdout}`);
    t.assert(await readFile(ownedFilter, 'utf8') === 'owned-filter',
      'matrix helper preserves a pre-existing source FilterPlugin.ini');
  } finally {
    await rm(testRoot, { recursive: true, force: true });
  }
}

process.exit(t.summary());
