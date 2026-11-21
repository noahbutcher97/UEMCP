// Test overwrite ordering and module rule deployment through both Windows copy commands.
//
// Run: cd server && node test-sync-plugin-bat-safety.mjs

import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { TestRunner } from './test-helpers.mjs';

const t = new TestRunner('sync-plugin.bat Safety Tests');

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const scriptText = readFileSync(join(repoRoot, 'sync-plugin.bat'), 'utf8');

const writeProbeIdx = scriptText.indexOf('set "WRITE_PROBE=');
const deleteSourceIdx = scriptText.indexOf('rmdir /s /q "!PLUGIN_DEST!\\Source"');
const deleteUpluginIdx = scriptText.indexOf('del /q "!PLUGIN_DEST!\\UEMCP.uplugin"');
// Match the stable command prefix, not the exclude-file path: the path moved
// to a relative name so xcopy would tolerate a space in %TEMP%, and this
// assertion is about ORDERING relative to the delete steps, not the argument.
const xcopyIdx = scriptText.indexOf('xcopy /E /I /Y /Q /EXCLUDE:');

t.assert(writeProbeIdx !== -1, 'script preflights target write access');
t.assert(deleteSourceIdx !== -1, 'script still has explicit Source delete step');
t.assert(deleteUpluginIdx !== -1, 'script still has explicit uplugin delete step');
t.assert(xcopyIdx !== -1, 'script still has xcopy copy step');

if (writeProbeIdx !== -1 && deleteSourceIdx !== -1 && deleteUpluginIdx !== -1) {
  t.assert(writeProbeIdx < deleteSourceIdx, 'write preflight occurs before deleting Source');
  t.assert(writeProbeIdx < deleteUpluginIdx, 'write preflight occurs before deleting UEMCP.uplugin');
}

if (deleteSourceIdx !== -1 && xcopyIdx !== -1) {
  t.assert(deleteSourceIdx < xcopyIdx, 'existing deployed source is removed only immediately before copy');
}

if (process.platform === 'win32') {
  // Exercise actual xcopy with an older incoming checkout and a newer target.
  const fixture = mkdtempSync(join(tmpdir(), 'uemcp-rule-sync-'));
  try {
    const source = join(fixture, 'plugin', 'UEMCP');
    const target = join(fixture, 'project', 'Plugins', 'UEMCP');
    const rule = join('Source', 'UEMCP', 'UEMCP.Build.cs');
    const cacheTime = new Date('2024-01-01T00:00:00Z');
    const older = new Date('2023-01-01T00:00:00Z');
    for (const dir of [source, target]) mkdirSync(join(dir, dirname(rule)), { recursive: true });
    mkdirSync(join(fixture, 'server'));
    mkdirSync(join(fixture, 'project', 'Content'));
    mkdirSync(join(fixture, 'temp'));
    writeFileSync(join(fixture, 'project', 'Fixture.uproject'), '{}');
    writeFileSync(join(source, 'UEMCP.uplugin'), '{}');
    writeFileSync(join(source, rule), 'changed module rules');
    utimesSync(join(source, rule), older, older);
    writeFileSync(join(target, rule), 'previous module rules');
    utimesSync(join(target, rule), cacheTime, cacheTime);
    writeFileSync(join(source, dirname(rule), 'Witness.cpp'), 'unchanged source bytes');
    copyFileSync(join(repoRoot, 'sync-plugin.bat'), join(fixture, 'sync-plugin.bat'));
    const stampScript = 'sync-module-rules.ps1';
    copyFileSync(join(repoRoot, 'server', stampScript), join(fixture, 'server', stampScript));
    const system32 = join(process.env.SystemRoot, 'System32');
    const invocation = (flags = '--no-marker') => spawnSync(process.env.ComSpec, ['/d', '/c', 'sync-plugin.bat project\\Fixture.uproject -y ' + flags], {
      cwd: fixture, windowsHide: true, timeout: 60000, encoding: 'utf8',
      env: { ...process.env, Path: [system32, join(system32, 'WindowsPowerShell', 'v1.0')].join(';'), TEMP: join(fixture, 'temp') },
    });
    const upgraded = invocation();
    t.assert(upgraded.status === 0, 'real script upgrades an existing owned fixture without Node', upgraded.stdout + upgraded.stderr);
    const stamp = statSync(join(target, rule)).mtimeMs;
    t.assert(readFileSync(join(target, rule), 'utf8') === 'changed module rules' && stamp > cacheTime.getTime(),
      'changed module rules are newer than a cached build despite the older checkout');
    t.assert(readFileSync(join(target, dirname(rule), 'Witness.cpp'), 'utf8') === 'unchanged source bytes', 'ordinary source bytes are still copied');
    const repeated = invocation();
    t.assert(repeated.status === 0 && statSync(join(target, rule)).mtimeMs === stamp,
      'an immediate repeat preserves the timestamp needed by the pending build', repeated.stdout + repeated.stderr);
    utimesSync(join(target, rule), older, older);
    const repair = invocation('--force-clean');
    t.assert(repair.status === 0 && statSync(join(target, rule)).mtimeMs > cacheTime.getTime(),
      '--force-clean repairs a previously installed identical rule with an obsolete timestamp', repair.stdout + repair.stderr);
    rmSync(join(target, rule));
    const fresh = invocation();
    t.assert(fresh.status === 0 && statSync(join(target, rule)).mtimeMs > cacheTime.getTime(), 'a new module-rule file is installed with a current timestamp');

    // Setup takes a different path: it removes the entire old plugin after
    // configuring the project's ports and MCP client. Run that ordinary path
    // in the same disposable project, with local Node and no network install.
    for (const file of ['setup-uemcp.bat', '.mcp.json.example']) {
      copyFileSync(join(repoRoot, file), join(fixture, file));
    }
    for (const file of readdirSync(join(repoRoot, 'server')).filter(file => file.endsWith('.mjs') && !file.startsWith('test-'))) {
      copyFileSync(join(repoRoot, 'server', file), join(fixture, 'server', file));
    }
    mkdirSync(join(fixture, 'server', 'node_modules'));
    writeFileSync(join(target, rule), 'previous module rules');
    utimesSync(join(target, rule), cacheTime, cacheTime);
    const setup = spawnSync(process.env.ComSpec, ['/d', '/c', 'setup-uemcp.bat project\\Fixture.uproject'], {
      cwd: fixture, windowsHide: true, input: 'y\r\n', timeout: 60000, encoding: 'utf8',
      env: { ...process.env, Path: [dirname(process.execPath), system32, join(system32, 'WindowsPowerShell', 'v1.0')].join(';'), TEMP: join(fixture, 'temp'), SETUP_AUTO_YES: '1' },
    });
    t.assert(setup.status === 0 && statSync(join(target, rule)).mtimeMs > cacheTime.getTime() &&
      readFileSync(join(target, rule), 'utf8') === 'changed module rules', 'setup overwrites old rules and invalidates a cached build', setup.stdout + setup.stderr);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
}

process.exit(t.summary());
