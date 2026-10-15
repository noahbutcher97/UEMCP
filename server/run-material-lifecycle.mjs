// Explicit owned-host lifecycle gate. Importing this module never launches UE.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { prepareFixtureHost, validateFixtureHost, prepareOwnedHostRuntime } from './prepare-fixture-host.mjs';
import { createProcessRunner } from './deployment/process-runner.mjs';
import { listEditorProcesses } from './editor-processes.mjs';
import { assertNoOwnedAuthoringConflicts } from './owned-authoring-conflicts.mjs';

export const lifecycleCases = ['Global', 'Shared', 'Blend'].flatMap((prefix, scope) =>
  ['Scalar', 'Vector', 'Texture'].map(type => ({ name: prefix + type,
    association: ['GlobalParameter', 'LayerParameter', 'BlendParameter'][scope], index: [-1, 1, 0][scope] })));
const sha = path => createHash('sha256').update(readFileSync(path)).digest('hex');

export function validateLifecycleReport(report, phase, project) {
  if (report.phase !== phase || resolve(report.project) !== resolve(project) || report.failures !== 0
      || report.saved !== true || !Array.isArray(report.cases) || report.cases.length !== lifecycleCases.length) {
    throw new Error(`Invalid ${phase} lifecycle report`);
  }
  for (const expected of lifecycleCases) {
    const rows = report.cases.filter(row => row.name === expected.name && row.association === expected.association && row.index === expected.index);
    if (rows.length !== 1 || rows[0].passed !== true || (phase === 'author'
        && (rows[0].writeVerified !== true || rows[0].undoAvailable !== true))) throw new Error(`Missing or failed lifecycle case: ${expected.name}`);
  }
}

export async function runMaterialLifecycle(options, {
  runner = createProcessRunner({ defaultOutputLimitBytes: 16 * 1024 * 1024 }),
  listEditors = listEditorProcesses,
} = {}) {
  const { repoRoot, outputRoot, engineRoot, sourceIdentityImpl } = options;
  if (!outputRoot || !engineRoot) throw new Error('Explicit fresh output root and engine root required');
  const stage = await prepareFixtureHost({ repoRoot, outputRoot, engineRoot, sourceIdentityImpl });
  const validation = { repoRoot, outputRoot, sourceIdentityImpl };
  const host = join(outputRoot, 'host');
  const project = stage.uprojectPath;
  const assets = ['M_Parameters', 'MI_Parameters'].map(name => join(host, `Content/MaterialVerification/${name}.uasset`));
  const records = [];
  const checkedRun = async (label, file, args, extra = {}) => {
    const result = await runner.run(file, args, { cwd: host, timeoutMs: 300000, ...extra });
    writeFileSync(join(outputRoot, `${label}-execution.json`), JSON.stringify({ ...result, args }, null, 2));
    if (result.status !== 'exited' || result.exitCode !== 0) throw new Error(`${label} failed: ${result.status}/${result.exitCode}`);
    return result;
  };
  try {
    assertNoOwnedAuthoringConflicts(await listEditors({ strict: true }), { repoRoot: stage.manifest.repoRoot, outputRoot });
    // Use Epic's build entry point so its bundled .NET runtime is selected.
    // Literal PowerShell arguments preserve spaces and quotes without cmd text interpolation.
    const quote = value => `'${value.replace(/'/g, "''")}'`;
    const buildScript = join(outputRoot, 'build.ps1');
    writeFileSync(buildScript, `& ${quote(join(engineRoot, 'Engine/Build/BatchFiles/Build.bat'))} UEMCPFixtureEditor Win64 Development ${quote(`-Project=${project}`)} -WaitMutex -NoHotReloadFromIDE\nexit $LASTEXITCODE\n`);
    await checkedRun('build', join(process.env.SystemRoot ?? 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'),
      ['-NoProfile', '-NonInteractive', '-File', buildScript], { timeoutMs: 900000 });
    await validateFixtureHost(validation);
    for (const phase of ['author', 'verify']) {
      assertNoOwnedAuthoringConflicts(await listEditors({ strict: true }), { repoRoot: stage.manifest.repoRoot, outputRoot });
      await validateFixtureHost({ ...validation, ...(phase === 'verify' ? { materialLifecycleAssets: 'required' } : {}) });
      if (phase === 'author' && assets.some(existsSync)) throw new Error('Refusing preexisting lifecycle assets');
      const before = phase === 'verify' ? assets.map(sha) : null;
      const runtime = prepareOwnedHostRuntime({ outputRoot, engineRoot });
      const result = await checkedRun(phase, join(engineRoot, 'Engine/Binaries/Win64/UnrealEditor-Cmd.exe'),
        [project, '-run=VerifyMaterialLifecycle', `-Phase=${phase}`, '-nullrhi', '-unattended', '-nosplash', '-NoLiveCoding',
          ...runtime.args, `-abslog=${join(outputRoot, `${phase}.log`)}`], { env: runtime.env });
      const report = JSON.parse(readFileSync(join(runtime.runtimeRoot, `User/Saved/MaterialLifecycle/${phase}.json`), 'utf8').replace(/^\uFEFF/, ''));
      validateLifecycleReport(report, phase, project);
      await validateFixtureHost({ ...validation, materialLifecycleAssets: 'required' });
      const hashes = assets.map(sha);
      if (before && JSON.stringify(before) !== JSON.stringify(hashes)) throw new Error('Reload changed saved asset bytes');
      records.push({ phase, exitCode: result.exitCode, report, assetHashes: hashes });
    }
    writeFileSync(join(outputRoot, 'lifecycle-evidence.json'), JSON.stringify({ invocationId: stage.manifest.invocationId, records, passed: true }, null, 2));
    return records;
  } catch (error) {
    writeFileSync(join(outputRoot, 'lifecycle-evidence.json'), JSON.stringify({ records, passed: false, error: error.message }, null, 2));
    throw error;
  }
}
