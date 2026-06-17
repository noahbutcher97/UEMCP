// ConnectionManager project-context reset tests.
//
// Run: cd server && node test-connection-reset.mjs

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ConnectionManager } from './connection-manager.mjs';
import { assetCache, resetOfflineAssetCache } from './offline-tools.mjs';
import { TestRunner } from './test-helpers.mjs';

const t = new TestRunner('Connection Reset Tests');

function makeTempRoot() {
  return mkdtempSync(join(tmpdir(), 'uemcp-connection-reset-'));
}

function cleanup(dir) {
  const norm = dir.replace(/\\/g, '/');
  const tmp = tmpdir().replace(/\\/g, '/').replace(/\/+$/, '');
  if (!norm.startsWith(`${tmp}/uemcp-connection-reset-`)) {
    throw new Error(`refusing to clean unexpected temp path: ${dir}`);
  }
  rmSync(dir, { recursive: true, force: true });
}

function writeProject(root, name) {
  mkdirSync(root, { recursive: true });
  mkdirSync(join(root, 'Content'), { recursive: true });
  const uprojectPath = join(root, `${name}.uproject`);
  writeFileSync(uprojectPath, '{"FileVersion":3}\n', 'utf8');
  return { projectRoot: root, uprojectPath };
}

// Offline asset cache resets all mutable fields.
assetCache.entries.set('asset', { path: 'asset', mtimeMs: 1, sizeBytes: 1, data: {} });
assetCache.lastBulkCheckMs = 123;
assetCache.indexDirty = true;
resetOfflineAssetCache();
t.assert(assetCache.entries.size === 0, 'offline cache entries cleared');
t.assert(assetCache.lastBulkCheckMs === 0, 'offline cache lastBulkCheckMs reset');
t.assert(assetCache.indexDirty === false, 'offline cache indexDirty reset');

// ConnectionManager reset clears project-scoped state but preserves process-wide counters.
{
  const conn = new ConnectionManager({
    projectRoot: '',
    tcpPortExisting: 55557,
    tcpPortCustom: 55558,
    tcpTimeoutMs: 5000,
    rcPort: 30010,
    rcRateCap: 2,
  });
  conn.setAttachedProject({ projectRoot: 'D:/Example/Project', projectName: 'Project' });
  t.assert(conn.getAttachedProjectRoot() === 'D:/Example/Project', 'attached project root is readable');

  conn._cache.set('ping', {}, { ok: true });
  conn.layers.offline.status = 'available';
  conn.layers.offline.lastCheck = Date.now();
  conn.layers.offline.error = 'old';
  conn._detectedProject = 'OldProject';
  let destroyed = false;
  conn._rcAgent = { destroy: () => { destroyed = true; } };
  conn._rcCallsSinceRecycle = 7;
  conn._rcTokens = 0;
  conn._rcLastRefillTs = 10;
  conn._rcRelaunchHintFired = true;
  conn._rcCallCount = 42;

  conn.resetProjectScopedState({ generation: 2, reason: 'test-reset' });

  t.assert(conn._cache.get('ping', {}) === null, 'result cache cleared on reset');
  t.assert(conn.layers.offline.status === 'unknown', `offline layer reset to unknown (got ${conn.layers.offline.status})`);
  t.assert(conn.layers.offline.lastCheck === 0, 'offline layer lastCheck reset');
  t.assert(conn.layers.offline.error === undefined, 'offline layer error cleared');
  t.assert(conn._detectedProject === null, 'detected editor state cleared');
  t.assert(destroyed === true && conn._rcAgent === null, 'RC keep-alive agent destroyed');
  t.assert(conn._rcCallsSinceRecycle === 0, 'RC calls-since-recycle reset');
  t.assert(conn._rcTokens === 2, `RC token bucket reset to rate (got ${conn._rcTokens})`);
  t.assert(conn._rcRelaunchHintFired === false, 'RC relaunch hint reset');
  t.assert(conn._rcCallCount === 42, 'process-wide RC call count preserved by default');
}

// checkOfflineAvailable accepts an explicit project root and rejects missing roots.
{
  const root = makeTempRoot();
  try {
    const project = writeProject(join(root, 'OfflineProject'), 'OfflineProject');
    const conn = new ConnectionManager({
      projectRoot: '',
      tcpPortExisting: 55557,
      tcpPortCustom: 55558,
      tcpTimeoutMs: 5000,
      rcPort: 30010,
    });

    const missing = await conn.checkOfflineAvailable('');
    t.assert(missing === false, 'missing project root is unavailable');
    t.assert(conn.layers.offline.error === 'PROJECT_NOT_ATTACHED', `missing root uses PROJECT_NOT_ATTACHED (got ${conn.layers.offline.error})`);

    const available = await conn.checkOfflineAvailable(project.projectRoot);
    t.assert(available === true, 'explicit project root is available');
    t.assert(conn.getAttachedProjectRoot() === project.projectRoot, 'explicit offline check updates attached root');
  } finally {
    cleanup(root);
  }
}

process.exit(t.summary());
