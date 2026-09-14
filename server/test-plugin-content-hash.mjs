// test-plugin-content-hash.mjs — unit tests for the plugin content digest.
//
// The digest is what makes a deploy verdict survive a merge or a checkout, so
// these tests pin the two properties that matter: the digest depends on every
// source byte and path, and on nothing else — not on readdir order, and not on
// any timestamp (the fake fs exposes no stat call at all).
//
// Run: cd server && node test-plugin-content-hash.mjs

import { collectPluginContentFiles, hashPluginTree } from './plugin-content-hash.mjs';
import { TestRunner } from './test-helpers.mjs';

const t = new TestRunner('plugin content hash Tests');

const ROOT = 'X:/fake/Plugins/UEMCP';
const norm = (p) => String(p).replace(/\\/g, '/').replace(/\/+$/, '');

/**
 * In-memory fs standing in for node:fs. `files` maps absolute forward-slash
 * paths to their text content; directories are inferred from the keys.
 * `entryOrder: 'desc'` reverses each readdir result so the digest's
 * order-independence is observable.
 */
function createFakeFs(files, { unreadable = [], readdirFails = [], entryOrder = 'asc' } = {}) {
  const map = new Map(Object.entries(files).map(([k, v]) => [norm(k), v]));
  const unreadableSet = new Set(unreadable.map(norm));
  const readdirFailSet = new Set(readdirFails.map(norm));
  return {
    readdirSync(dir) {
      const d = norm(dir);
      if (readdirFailSet.has(d)) throw new Error(`EACCES: ${d}`);
      const names = new Map();
      for (const p of map.keys()) {
        if (!p.startsWith(`${d}/`)) continue;
        const rest = p.slice(d.length + 1);
        const slash = rest.indexOf('/');
        if (slash === -1) names.set(rest, false);
        else names.set(rest.slice(0, slash), true);
      }
      if (names.size === 0) throw new Error(`ENOENT: ${d}`);
      const out = [...names].map(([name, isDir]) => ({
        name,
        isDirectory: () => isDir,
        isFile: () => !isDir,
      }));
      return entryOrder === 'desc' ? out.reverse() : out;
    },
    readFileSync(path) {
      const p = norm(path);
      if (unreadableSet.has(p)) throw new Error(`EBUSY: ${p}`);
      if (!map.has(p)) throw new Error(`ENOENT: ${p}`);
      return Buffer.from(map.get(p), 'utf8');
    },
  };
}

const BASE_FILES = {
  [`${ROOT}/UEMCP.uplugin`]: '{"Version":2}',
  [`${ROOT}/Source/UEMCP/UEMCP.Build.cs`]: 'public class UEMCP {}',
  [`${ROOT}/Source/UEMCP/Private/ActorHandlers.cpp`]: 'void Spawn() {}',
  [`${ROOT}/Source/UEMCP/Public/HandlerCommon.h`]: '#pragma once',
};
const withFiles = (extra) => ({ ...BASE_FILES, ...extra });

const baseHash = hashPluginTree(ROOT, createFakeFs(BASE_FILES));

// 1-3: the digest is a digest, it is stable, and readdir order cannot move it.
t.assert(/^[0-9a-f]{64}$/.test(String(baseHash)), 'digest is 64 lowercase hex characters');
t.assert(hashPluginTree(ROOT, createFakeFs(BASE_FILES)) === baseHash, 'digest is deterministic across calls');
t.assert(
  hashPluginTree(ROOT, createFakeFs(BASE_FILES, { entryOrder: 'desc' })) === baseHash,
  'digest is independent of readdir entry order',
);

// 4: the file list is the sorted, forward-slash relative surface.
t.assert(
  JSON.stringify(collectPluginContentFiles(ROOT, createFakeFs(BASE_FILES))) === JSON.stringify([
    'Source/UEMCP/Private/ActorHandlers.cpp',
    'Source/UEMCP/Public/HandlerCommon.h',
    'Source/UEMCP/UEMCP.Build.cs',
    'UEMCP.uplugin',
  ]),
  'collectPluginContentFiles returns sorted forward-slash relative paths',
);

// 5-8: build output and deploy bookkeeping are not content.
t.assert(
  hashPluginTree(ROOT, createFakeFs(withFiles({
    [`${ROOT}/Binaries/Win64/UnrealEditor-UEMCP.dll`]: 'MZbinary',
  }))) === baseHash,
  'a root Binaries/ file does not change the digest',
);
t.assert(
  hashPluginTree(ROOT, createFakeFs(withFiles({
    [`${ROOT}/Source/UEMCP/Intermediate/Build.obj`]: 'objbytes',
  }))) === baseHash,
  'a nested Intermediate/ directory does not change the digest',
);
t.assert(
  hashPluginTree(ROOT, createFakeFs(withFiles({
    [`${ROOT}/.uemcp-deploy-marker.json`]: '{"schemaVersion":"1.0"}',
  }))) === baseHash,
  'the root deploy marker does not change the digest',
);
t.assert(
  hashPluginTree(ROOT, createFakeFs(withFiles({
    [`${ROOT}/Source/.uemcp-deploy-marker.json.uemcp-tmp`]: 'staging',
  }))) === baseHash,
  'a nested .uemcp- staging file does not change the digest',
);

// 9-12: every source byte and every path is in the digest.
t.assert(
  hashPluginTree(ROOT, createFakeFs(withFiles({
    [`${ROOT}/Source/UEMCP/Private/ActorHandlers.cpp`]: 'void Spawn() {};',
  }))) !== baseHash,
  'a one-byte change in a Source file changes the digest',
);
t.assert(
  hashPluginTree(ROOT, createFakeFs(withFiles({
    [`${ROOT}/UEMCP.uplugin`]: '{"Version":3}',
  }))) !== baseHash,
  'a change to UEMCP.uplugin changes the digest',
);
const renamed = { ...BASE_FILES };
delete renamed[`${ROOT}/Source/UEMCP/Private/ActorHandlers.cpp`];
renamed[`${ROOT}/Source/UEMCP/Private/ActorHandlers2.cpp`] = 'void Spawn() {}';
t.assert(
  hashPluginTree(ROOT, createFakeFs(renamed)) !== baseHash,
  'renaming a file with identical bytes changes the digest',
);
t.assert(
  hashPluginTree(ROOT, createFakeFs(withFiles({
    [`${ROOT}/Source/UEMCP/Private/NewHandlers.cpp`]: '',
  }))) !== baseHash,
  'adding a Source file changes the digest',
);

// 13-16: an unanswerable question returns null, never a partial digest.
t.assert(
  hashPluginTree(ROOT, createFakeFs(BASE_FILES, {
    unreadable: [`${ROOT}/Source/UEMCP/Private/ActorHandlers.cpp`],
  })) === null,
  'a file that cannot be read yields null, not a partial digest',
);
t.assert(
  collectPluginContentFiles(ROOT, createFakeFs(BASE_FILES, { readdirFails: [`${ROOT}/Source`] })) === null,
  'an unreadable Source/ makes collectPluginContentFiles return null',
);
t.assert(
  hashPluginTree(ROOT, createFakeFs(BASE_FILES, { readdirFails: [`${ROOT}/Source`] })) === null,
  'an unreadable Source/ makes hashPluginTree return null',
);
t.assert(
  hashPluginTree(ROOT, createFakeFs({ [`${ROOT}/UEMCP.uplugin`]: '{}' })) === null,
  'a plugin root with no Source/ yields null',
);

// 17: the fake exposes no stat call, so no timestamp can have entered the digest.
const strictFs = createFakeFs(BASE_FILES);
t.assert(
  Object.keys(strictFs).sort().join(',') === 'readFileSync,readdirSync' && baseHash !== null,
  'the digest is produced from an fsImpl with no stat call — mtimes cannot enter it',
);

// 18-19: line-ending normalisation is exactly CRLF → LF, nothing broader.
const CRLF_TARGET = `${ROOT}/Source/UEMCP/Private/ActorHandlers.cpp`;
const lfFiles = withFiles({ [CRLF_TARGET]: 'void Spawn() {}\n// comment\n' });
const crlfFiles = withFiles({ [CRLF_TARGET]: 'void Spawn() {}\r\n// comment\r\n' });
const loneCrFiles = withFiles({ [CRLF_TARGET]: 'void Spawn() {}\r// comment\r' });
t.assert(
  hashPluginTree(ROOT, createFakeFs(crlfFiles)) === hashPluginTree(ROOT, createFakeFs(lfFiles)),
  'a tree with CRLF files hashes identically to the same tree with LF files',
);
t.assert(
  hashPluginTree(ROOT, createFakeFs(loneCrFiles)) !== hashPluginTree(ROOT, createFakeFs(lfFiles)),
  'a lone CR not followed by LF hashes differently — normalisation is exactly CRLF',
);

process.exit(t.summary());
