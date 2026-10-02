import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, readdirSync, symlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import * as staging from './prepare-fixture-host.mjs';
import { assertNoOwnedAuthoringConflicts } from './owned-authoring-conflicts.mjs';
import { runOwnedAuthoring } from './run-owned-authoring.mjs';
import { verifyAuthoringHost } from './finalize-owned-serialization.mjs';
import { TestRunner, createCanonicalScratchRoot, cleanupCanonicalScratchRoot } from './test-helpers.mjs';

const t = new TestRunner('Owned authoring launch safety');
const prefix = 'uemcp-as-';
const scratch = createCanonicalScratchRoot(prefix);
const canonicalConfig = readFileSync(new URL('./fixtures/uemcp-fixture/Config/DefaultEngine.ini', import.meta.url), 'utf8');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const put = (path, bytes) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, bytes); };
const asset = 'Content/Serialization/BP_OwnedLink.uasset';
let sequence = 0;
async function fixture(config = canonicalConfig) {
  const root = join(scratch, String(sequence++)); mkdirSync(root);
  const repoRoot = join(root, 'repo'); const engineRoot = join(root, 'engine'); const outputRoot = join(root, 'stage');
  const inputs = {
    'server/fixtures/uemcp-fixture/UEMCPFixture.uproject': '{}',
    'server/fixtures/uemcp-fixture/Config/DefaultEngine.ini': config,
    'plugin/UEMCP/Resources/source.txt': 'original source',
  };
  for (const [path, bytes] of Object.entries(inputs)) put(join(repoRoot, path), bytes);
  execFileSync('git', ['init', '-q', repoRoot]);
  execFileSync('git', ['-C', repoRoot, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-qm', 'fixture']);
  put(join(repoRoot, 'server/fixtures/host-source-files.json'), JSON.stringify({ schemaVersion: 1, files: Object.keys(inputs).sort() }));
  put(join(engineRoot, 'Engine/Build/Build.version'), JSON.stringify({ MajorVersion: 5, MinorVersion: 6, PatchVersion: 1, Changelist: 42 }));
  const source = { head: 'a'.repeat(40), patchSha256: 'b'.repeat(64), dirty: true, files: Object.entries(inputs).map(([path, bytes]) => ({ path, sha256: hash(bytes) })) };
  const opts = { repoRoot, engineRoot, outputRoot, sourceIdentityImpl: () => source, mode: 'author', timeoutMs: 1234 };
  await staging.prepareFixtureHost(opts);
  return { opts, hostRoot: join(outputRoot, 'host'), source };
}
const invoke = runOwnedAuthoring;
const dependencies = run => ({ runner: { run }, listEditors: async () => [], portAvailable: async () => true });
async function check(name, fn) { try { await fn(); t.assert(true, name); } catch (error) { t.assert(false, name, error.stack); } }
try {
  await check('repeated canonical directory aliases consume one crawl identity', async () => {
    const { opts } = await fixture();
    const root = join(dirname(opts.outputRoot), 'other'); const project = join(root, 'Other.uproject');
    put(project, JSON.stringify({ AdditionalPluginDirectories: Array(10001).fill('.') }));
    const diagnostics = assertNoOwnedAuthoringConflicts([{ pid: 123, uprojectPath: project, commandLineAvailable: true, cmdLine: `UnrealEditor.exe "${project}"` }], opts);
    assert.equal(diagnostics.unique, 1); assert.equal(diagnostics.repeatedAlias, 10001); assert.equal(diagnostics.reason, 'clear');
  });
  await check('directory names cannot escape fixed diagnostic categories', async () => {
    const { opts } = await fixture();
    const root = join(dirname(opts.outputRoot), 'other'); const project = join(root, 'Other.uproject'); put(project, '{}');
    mkdirSync(join(root, '__proto__')); mkdirSync(join(root, 'constructor'));
    const diagnostics = assertNoOwnedAuthoringConflicts([{ pid: 123, uprojectPath: project, commandLineAvailable: true, cmdLine: `UnrealEditor.exe "${project}"` }], opts);
    assert.equal(diagnostics.category, 'other'); assert.equal(diagnostics.unique, 3);
  });
  await check('unsafe explicit redirect is rejected before directory crawl', async () => {
    const { opts } = await fixture();
    const project = join(dirname(opts.outputRoot), 'other/Other.uproject');
    put(project, JSON.stringify({ AdditionalPluginDirectories: Array(10001).fill('.') }));
    assert.throws(() => assertNoOwnedAuthoringConflicts([{ pid: 123, uprojectPath: project, commandLineAvailable: true, cmdLine: `UnrealEditor.exe "${project}" -UserDir=relative` }], opts), error => {
      assert.match(error.message, /relative runtime path redirect/); assert.equal(error.diagnostics.unique, 0); assert.equal(error.diagnostics.category, 'redirect'); return true;
    });
  });
  await check('directory junction cycle terminates while nested overlap remains rejected', async () => {
    const { opts, hostRoot } = await fixture();
    const root = join(dirname(opts.outputRoot), 'other'); const project = join(root, 'Other.uproject'); put(project, '{}');
    mkdirSync(join(root, 'nested')); symlinkSync(root, join(root, 'nested/cycle'), 'junction');
    const editors = [{ pid: 123, uprojectPath: project, commandLineAvailable: true, cmdLine: `UnrealEditor.exe "${project}"` }];
    const diagnostics = assertNoOwnedAuthoringConflicts(editors, opts);
    assert.equal(diagnostics.unique, 2); assert.equal(diagnostics.repeatedAlias, 1); assert.equal(diagnostics.reparse, 1);
    mkdirSync(join(root, 'nested/deeper')); symlinkSync(hostRoot, join(root, 'nested/deeper/overlap'), 'junction');
    assert.throws(() => assertNoOwnedAuthoringConflicts(editors, opts), error => {
      assert.match(error.message, /overlap/); assert.equal(error.diagnostics.reason, 'overlap'); return true;
    });
  });
  for (const scenario of ['missing graph', 'engine mismatch']) {
    await check(`shared runtime rejects ${scenario} before process boundary`, async () => {
      const { opts } = await fixture(scenario === 'missing graph' ? '[Engine.Engine]\nbSmoothFrameRate=true\n' : canonicalConfig);
      const requestedEngine = scenario === 'engine mismatch' ? join(dirname(opts.engineRoot), 'other-engine') : opts.engineRoot;
      if (scenario === 'engine mismatch') put(join(requestedEngine, 'Engine/Build/Build.version'), readFileSync(join(opts.engineRoot, 'Engine/Build/Build.version')));
      let starts = 0;
      assert.throws(() => { staging.prepareOwnedHostRuntime({ outputRoot: opts.outputRoot, engineRoot: requestedEngine }); starts++; }, /isolation|DDC|engine|graph/i);
      assert.equal(starts, 0);
    });
  }
  await check('historical provenance alone accepts a stage without owned DDC', async () => {
    const { opts, hostRoot } = await fixture('[Engine.Engine]\nbSmoothFrameRate=true\n');
    put(join(hostRoot, asset), 'synthetic authored bytes');
    assert.ok(verifyAuthoringHost(hostRoot, opts.engineRoot, opts.repoRoot));
  });
  for (const [name, config] of [
    ['Zen auto-launch enabled', canonicalConfig.replace('AutoLaunch=false', 'AutoLaunch=true')],
    ['unsafe default fallback', canonicalConfig.replace('[DerivedDataBackendGraph]\n', '[DerivedDataBackendGraph]\nShared=(Type=FileSystem, Path="outside")\n').replace('[DerivedDataBackendGraph]\r\n', '[DerivedDataBackendGraph]\r\nShared=(Type=FileSystem, Path="outside")\r\n')],
    ['duplicate owned graph override', canonicalConfig + '\n[UEMCPOwnedDDC]\nRoot=(Type=Zen)\n'],
  ]) {
    await check(`rejects ${name} before process`, async () => {
      const { opts } = await fixture(config); let starts = 0;
      await assert.rejects(async () => invoke(opts, dependencies(async () => { starts++; return { status: 'exited', exitCode: 0 }; })), /isolation|DDC|config|graph/i);
      assert.equal(starts, 0);
    });
  }
  await check('rejects generated config override before process', async () => {
    const { opts, hostRoot } = await fixture(); let starts = 0;
    put(join(hostRoot, 'Saved/Config/WindowsEditor/Engine.ini'), '[Zen]\nAutoLaunch=true\n');
    await assert.rejects(async () => invoke(opts, dependencies(async () => { starts++; return { status: 'exited', exitCode: 0 }; })), /config|override|isolation/i);
    assert.equal(starts, 0);
  });
  for (const mode of ['author', 'export']) {
    await check(`${mode} rejects historical missing DDC before any process`, async () => {
      const { opts, hostRoot } = await fixture('[Engine.Engine]\nbSmoothFrameRate=true\n');
      if (mode === 'export') put(join(hostRoot, asset), 'synthetic authored bytes');
      let starts = 0;
      await assert.rejects(async () => invoke({ ...opts, mode }, dependencies(async () => { starts++; return { status: 'exited', exitCode: 0 }; })), /isolation|DDC|graph/i);
      assert.equal(starts, 0);
    });
    await check(`${mode} rejects a different requested engine before any process`, async () => {
      const { opts, hostRoot } = await fixture();
      if (mode === 'export') put(join(hostRoot, asset), 'synthetic authored bytes');
      const otherEngine = join(dirname(opts.engineRoot), 'other-engine');
      put(join(otherEngine, 'Engine/Build/Build.version'), readFileSync(join(opts.engineRoot, 'Engine/Build/Build.version')));
      let starts = 0;
      await assert.rejects(async () => invoke({ ...opts, engineRoot: otherEngine, mode }, dependencies(async () => { starts++; return { status: 'exited', exitCode: 0 }; })), /engine.*(root|identity)|requested.*engine/i);
      assert.equal(starts, 0);
    });
  }
  for (const mode of ['author', 'export']) {
    await check(`${mode} permits an identified unrelated editor project`, async () => {
      const { opts, hostRoot } = await fixture();
      if (mode === 'export') put(join(hostRoot, asset), 'synthetic authored bytes');
      const otherProject = join(dirname(opts.outputRoot), 'unrelated/Other.uproject'); put(otherProject, '{}');
      let starts = 0;
      const deps = dependencies(async () => {
        starts++;
        if (mode === 'author') put(join(hostRoot, asset), 'synthetic authored bytes');
        else put(join(opts.outputRoot, 'oracle.json'), '{}');
        return { status: 'exited', exitCode: 0 };
      });
      deps.listEditors = async () => [{ pid: 123, uprojectPath: otherProject, cmdLine: `UnrealEditor.exe "${otherProject}"`, commandLineAvailable: true }];
      const result = await invoke({ ...opts, mode }, deps);
      assert.equal(result.exitCode, 0); assert.equal(starts, 1);
    });
    await check(`${mode} permits occupied TCP 55558 for fixed commandlet`, async () => {
      const { opts, hostRoot } = await fixture();
      if (mode === 'export') put(join(hostRoot, asset), 'synthetic authored bytes');
      let starts = 0;
      const deps = dependencies(async (_file, args) => {
        starts++; assert.ok(args.some(arg => arg.startsWith('-run='))); assert.ok(args.includes('-NullRHI'));
        if (mode === 'author') put(join(hostRoot, asset), 'synthetic authored bytes');
        else put(join(opts.outputRoot, 'oracle.json'), '{}');
        return { status: 'exited', exitCode: 0 };
      });
      deps.portAvailable = async () => false;
      const result = await invoke({ ...opts, mode }, deps);
      assert.equal(result.exitCode, 0); assert.equal(starts, 1);
    });
  }
  for (const checkpoint of ['listEditors']) {
    await check(`rejects source mutation during async ${checkpoint} before launch`, async () => {
      const { opts, hostRoot } = await fixture(); let starts = 0;
      const deps = dependencies(async () => { starts++; return { status: 'exited', exitCode: 0 }; });
      deps[checkpoint] = async () => {
        put(join(hostRoot, 'Plugins/UEMCP/Resources/source.txt'), 'changed during preflight');
        return checkpoint === 'listEditors' ? [] : true;
      };
      await assert.rejects(async () => invoke(opts, deps), /source|staged|changed/i);
      assert.equal(starts, 0);
    });
  }
  await check('export rejects input mutation during async preflight before launch', async () => {
    const { opts, hostRoot } = await fixture(); put(join(hostRoot, asset), 'synthetic authored bytes'); let starts = 0;
    const deps = dependencies(async () => { starts++; return { status: 'exited', exitCode: 0 }; });
    deps.listEditors = async () => { put(join(hostRoot, asset), 'changed during preflight'); return []; };
    await assert.rejects(async () => invoke({ ...opts, mode: 'export' }, deps), /asset|authored|changed/i);
    assert.equal(starts, 0);
  });
  for (const scenario of ['same project', 'lexical alias', 'junction alias', 'ancestor project', 'source checkout', 'junction into stage', 'redirected runtime output', 'embedded config override', 'unknown identity', 'unavailable command line', 'missing descriptor']) {
    await check(`refuses ${scenario} before process`, async () => {
      const { opts, hostRoot } = await fixture();
      let project = join(hostRoot, 'UEMCPFixture.uproject');
      let commandLineAvailable = true;
      if (scenario === 'lexical alias') project = `${hostRoot}/./UEMCPFixture.uproject`;
      if (scenario === 'junction alias') {
        const alias = join(dirname(opts.outputRoot), 'alias'); symlinkSync(hostRoot, alias, 'junction');
        project = join(alias, 'UEMCPFixture.uproject');
      }
      if (scenario === 'ancestor project') { project = join(dirname(opts.outputRoot), 'Ancestor.uproject'); put(project, '{}'); }
      if (scenario === 'source checkout') { project = join(opts.repoRoot, 'SourceCheckout.uproject'); put(project, '{}'); }
      if (['junction into stage', 'redirected runtime output', 'embedded config override'].includes(scenario)) {
        project = join(dirname(opts.outputRoot), 'other/Other.uproject'); put(project, '{}');
        if (scenario === 'junction into stage') symlinkSync(hostRoot, join(dirname(project), 'LinkedStage'), 'junction');
      }
      if (scenario === 'unknown identity') project = null;
      if (scenario === 'unavailable command line') commandLineAvailable = false;
      if (scenario === 'missing descriptor') project = join(dirname(opts.outputRoot), 'missing/Other.uproject');
      let starts = 0;
      const deps = dependencies(async () => { starts++; return { status: 'exited', exitCode: 7 }; });
      deps.listEditors = async () => [{ pid: 123, uprojectPath: project, commandLineAvailable,
        cmdLine: commandLineAvailable ? `UnrealEditor.exe "${project || ''}"${scenario === 'redirected runtime output' ? ` -UserDir="${join(hostRoot, 'Saved')}"` : scenario === 'embedded config override' ? ` -ini:Engine:[CustomDDC]:Path="${hostRoot}"` : ''}` : '' }];
      await assert.rejects(async () => invoke(opts, deps), /conflict|overlap|identity|unavailable|inspect|editor|project|path/i);
      assert.equal(starts, 0);
    });
  }
  for (const malformed of ['invalid pid', 'missing command line', 'wrong executable', 'inconsistent project']) {
    await check(`refuses unrelated editor with ${malformed}`, async () => {
      const { opts } = await fixture(); let starts = 0;
      const project = join(dirname(opts.outputRoot), 'other/Other.uproject'); put(project, '{}');
      const row = { pid: 123, uprojectPath: project, commandLineAvailable: true, cmdLine: `UnrealEditor.exe "${project}"` };
      if (malformed === 'invalid pid') row.pid = -1;
      if (malformed === 'missing command line') delete row.cmdLine;
      if (malformed === 'wrong executable') row.cmdLine = `NotAnEditor.exe "${project}"`;
      if (malformed === 'inconsistent project') row.cmdLine = `UnrealEditor.exe "${join(opts.outputRoot, 'host/UEMCPFixture.uproject')}"`;
      const deps = dependencies(async () => { starts++; return { status: 'exited', exitCode: 7 }; }); deps.listEditors = async () => [row];
      await assert.rejects(async () => invoke(opts, deps), /identity|conflict|project|editor|command/i); assert.equal(starts, 0);
    });
  }
  await check('uncertain process enumeration remains fail closed', async () => {
    const { opts } = await fixture(); let starts = 0;
    const deps = dependencies(async () => { starts++; return { status: 'exited', exitCode: 7 }; });
    deps.listEditors = async () => { throw new Error('inspection unavailable'); };
    await assert.rejects(async () => invoke(opts, deps), /inspection unavailable/); assert.equal(starts, 0);
  });
  await check('preexisting stage lock is refused and retained without process launch', async () => {
    const { opts } = await fixture(); let starts = 0;
    const lock = join(opts.outputRoot, '.owned-authoring.lock'); mkdirSync(lock);
    put(join(lock, 'owner.json'), 'unverified previous owner');
    await assert.rejects(async () => invoke(opts, dependencies(async () => { starts++; return { status: 'exited', exitCode: 7 }; })), /lock|ownership|active/i);
    assert.equal(starts, 0); assert.equal(readFileSync(join(lock, 'owner.json'), 'utf8'), 'unverified previous owner');
  });
  await check('atomic ownership refuses a concurrent invocation of the same stage', async () => {
    const { opts } = await fixture(); let starts = 0; let release;
    const blocked = new Promise(resolve => { release = resolve; });
    let reachedRunner; const started = new Promise(resolve => { reachedRunner = resolve; });
    const first = invoke(opts, dependencies(async () => { starts++; reachedRunner(); await blocked; return { status: 'exited', exitCode: 7 }; }));
    await started;
    try {
      await assert.rejects(async () => invoke(opts, dependencies(async () => { starts++; return { status: 'exited', exitCode: 7 }; })), /lock|active|ownership|concurrent/i);
      assert.equal(starts, 1);
    } finally { release(); await first; }
    const retry = await invoke(opts, dependencies(async () => ({ status: 'exited', exitCode: 7 })));
    assert.equal(retry.exitCode, 7, 'owned lock released after nonzero exit');
  });
  for (const outcome of ['success', 'nonzero', 'throw', 'timeout']) {
    await check(`post-source validation rejects staged edits after ${outcome}`, async () => {
      const { opts, hostRoot } = await fixture(); let starts = 0;
      await assert.rejects(async () => invoke(opts, dependencies(async () => {
        starts++; put(join(hostRoot, 'Plugins/UEMCP/Resources/source.txt'), 'mutated');
        if (outcome === 'throw') throw new Error('runner exploded');
        if (outcome === 'success') put(join(hostRoot, asset), 'synthetic authored bytes');
        return { status: outcome === 'timeout' ? 'timed_out' : 'exited', exitCode: outcome === 'success' ? 0 : 1 };
      })), /source|staged|post.*valid/i);
      assert.equal(starts, 1);
      const records = readdirSync(opts.outputRoot).filter(name => name.includes('lifecycle') && name.endsWith('.json'));
      assert.equal(records.length, 1, 'retains lifecycle evidence on source failure');
    });
  }
  await check('successful author uses shared runtime arguments and bounded runner', async () => {
    const { opts, hostRoot } = await fixture(); let starts = 0;
    const result = await invoke(opts, dependencies(async (file, args, options) => {
      starts++; assert.ok(file.startsWith(opts.engineRoot));
      for (const arg of staging.ownedHostEngineArgs) assert.ok(args.includes(arg), arg);
      assert.ok(args.includes('-run=AuthorSerializationFixture'));
      assert.equal(options.timeoutMs, 1234); assert.equal(options.cwd, hostRoot);
      assert.ok(options.env.TEMP.startsWith(join(hostRoot, 'Saved'))); assert.equal(options.env.TEMP, options.env.TMP);
      const shader = args.find(arg => arg.startsWith('-ShaderWorkingDir=')); assert.ok(shader?.includes(hostRoot));
      put(join(hostRoot, asset), 'synthetic authored bytes');
      return { status: 'exited', exitCode: 0 };
    }));
    assert.equal(starts, 1); assert.equal(result.exitCode, 0);
  });
  await check('successful export uses shared runtime and preserves authored bytes', async () => {
    const { opts, hostRoot } = await fixture(); put(join(hostRoot, asset), 'synthetic authored bytes');
    const result = await invoke({ ...opts, mode: 'export' }, dependencies(async (file, args, options) => {
      assert.ok(file.startsWith(opts.engineRoot));
      for (const arg of staging.ownedHostEngineArgs) assert.ok(args.includes(arg));
      assert.ok(args.includes('-run=DumpBPGraph')); assert.ok(args.includes(`-Out=${join(opts.outputRoot, 'oracle.json')}`));
      assert.equal(options.timeoutMs, 1234);
      put(join(opts.outputRoot, 'oracle.json'), '{}');
      return { status: 'exited', exitCode: 0 };
    }));
    assert.equal(result.exitCode, 0);
    assert.equal(readFileSync(join(hostRoot, asset), 'utf8'), 'synthetic authored bytes');
  });
  await check('export rejects authored asset mutation even after process failure', async () => {
    const { opts, hostRoot } = await fixture(); put(join(hostRoot, asset), 'synthetic authored bytes');
    await assert.rejects(async () => invoke({ ...opts, mode: 'export' }, dependencies(async () => {
      put(join(hostRoot, asset), 'mutated asset'); return { status: 'exited', exitCode: 9 };
    })), /asset|authored|changed/i);
  });
  await check('export refuses preexisting oracle before process', async () => {
    const { opts, hostRoot } = await fixture(); put(join(hostRoot, asset), 'synthetic authored bytes');
    put(join(opts.outputRoot, 'oracle.json'), '{}'); let starts = 0;
    await assert.rejects(async () => invoke({ ...opts, mode: 'export' }, dependencies(async () => { starts++; return { status: 'exited', exitCode: 0 }; })), /oracle|existing|overwrite/i);
    assert.equal(starts, 0);
  });
  await check('export refuses dangling oracle link before process', async () => {
    const { opts, hostRoot } = await fixture(); put(join(hostRoot, asset), 'synthetic authored bytes');
    symlinkSync(join(dirname(opts.outputRoot), 'missing-target'), join(opts.outputRoot, 'oracle.json'), 'junction');
    let starts = 0;
    await assert.rejects(async () => invoke({ ...opts, mode: 'export' }, dependencies(async () => { starts++; return { status: 'exited', exitCode: 0 }; })), /oracle|existing|overwrite/i);
    assert.equal(starts, 0);
  });
  await check('export success rejects nonregular oracle output', async () => {
    const { opts, hostRoot } = await fixture(); put(join(hostRoot, asset), 'synthetic authored bytes');
    await assert.rejects(async () => invoke({ ...opts, mode: 'export' }, dependencies(async () => {
      mkdirSync(join(opts.outputRoot, 'oracle.json')); return { status: 'exited', exitCode: 0 };
    })), /regular oracle/i);
  });
  await check('export success rejects oracle link to an outside directory', async () => {
    const { opts, hostRoot } = await fixture(); put(join(hostRoot, asset), 'synthetic authored bytes');
    await assert.rejects(async () => invoke({ ...opts, mode: 'export' }, dependencies(async () => {
      const target = join(dirname(opts.outputRoot), 'outside-oracle'); mkdirSync(target);
      symlinkSync(target, join(opts.outputRoot, 'oracle.json'), 'junction'); return { status: 'exited', exitCode: 0 };
    })), /regular oracle/i);
  });
  await check('unchanged stage preserves nonzero process failure', async () => {
    const { opts } = await fixture();
    const result = await invoke(opts, dependencies(async () => ({ status: 'exited', exitCode: 7 })));
    assert.equal(result.exitCode, 7);
  });
  await check('unchanged stage preserves thrown runner failure with lifecycle evidence', async () => {
    const { opts } = await fixture();
    await assert.rejects(async () => invoke(opts, dependencies(async () => { throw new Error('runner exploded'); })), /runner exploded/);
    assert.equal(readdirSync(opts.outputRoot).filter(name => name.includes('lifecycle') && name.endsWith('.json')).length, 1);
  });
} finally { cleanupCanonicalScratchRoot(scratch, prefix); }
process.exit(t.summary());
