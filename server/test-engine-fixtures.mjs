// test-engine-fixtures.mjs — resolving /Engine/ differential fixtures.
//
// T-1c: the pin-block differential's fixtures were coupled to a live private
// project, so they drifted every time that project changed (three events on one
// asset). Engine content is immutable for a given engine version, so a fixture
// sourced from /Engine/ cannot drift — it can only fail to be present.
//
// Design: docs/superpowers/specs/2026-08-25-oracle-decoupling-plan.md

import { engineAssetDiskPath, engineVersionMatches, readEngineBuildVersion, resolveEngineRoot } from './engine-fixtures.mjs';
import { resolveAssetDiskPath } from './offline-tools.mjs';
import { TestRunner } from './test-helpers.mjs';

const t = new TestRunner('engine fixtures');

// An /Engine/ asset path maps to the install's Content tree by a fixed rule,
// so unlike a project asset it needs no filename search to locate.
{
  const disk = engineAssetDiskPath('C:/Program Files/Epic Games/UE_5.6', '/Engine/EngineSky/BP_Sky_Sphere');
  const expected = 'C:/Program Files/Epic Games/UE_5.6/Engine/Content/EngineSky/BP_Sky_Sphere.uasset';
  t.assert(disk?.split(/[\\/]/).join('/') === expected,
    'an /Engine/ path resolves into the install Content tree',
    `got ${disk}`);
}

// An explicit UE_ENGINE_ROOT must win over any probed install, so a contributor
// with several engine versions can point the fixtures at a specific one.
{
  const root = resolveEngineRoot({
    env: { UE_ENGINE_ROOT: 'D:/Custom/UE' },
    candidates: ['C:/Program Files/Epic Games/UE_5.6'],
    existsImpl: () => true,
  });
  t.assert(root === 'D:/Custom/UE', `UE_ENGINE_ROOT wins over probed installs (got ${root})`);
}

// With no env override, fall back to probing known install locations, so the
// common case (one standard Epic install) needs no configuration at all.
{
  const seen = [];
  const root = resolveEngineRoot({
    env: {},
    candidates: ['D:/Missing/UE_5.6', 'C:/Program Files/Epic Games/UE_5.6'],
    existsImpl: p => { seen.push(p); return p.startsWith('C:/'); },
  });
  t.assert(root === 'C:/Program Files/Epic Games/UE_5.6',
    `probes candidates in order and takes the first present (got ${root})`);
  t.assert(seen[0] === 'D:/Missing/UE_5.6', 'probe order is candidate order, not reversed');
}

// Nothing configured and nothing installed is an ordinary outcome on a CI
// runner, not an error — callers turn it into a labeled skip.
{
  const root = resolveEngineRoot({ env: {}, candidates: ['D:/Missing/UE'], existsImpl: () => false });
  t.assert(root === null, `no engine anywhere returns null rather than throwing (got ${root})`);
}

// An oracle is only meaningful against the engine build it was dumped from —
// engine content can change between point releases — so the fixture has to be
// able to tell "same engine" from "some engine".
{
  const build = { MajorVersion: 5, MinorVersion: 6, PatchVersion: 1, Changelist: 44394996 };
  t.assert(engineVersionMatches(build, '5.6.1-44394996+++UE5+Release-5.6') === true,
    'a Build.version matching the oracle branch string is recognised');
  t.assert(engineVersionMatches(build, '5.6.2-50000000+++UE5+Release-5.6') === false,
    'a different patch/changelist is not treated as the same engine');
  t.assert(engineVersionMatches(build, '5.8.0-99999999+++UE5+Release-5.8') === false,
    'a different minor version is not treated as the same engine');
  t.assert(engineVersionMatches(null, '5.6.1-44394996') === false,
    'an unreadable Build.version never claims a match');
}

// The version lives in Engine/Build/Build.version. Reading it must not throw on
// a missing or corrupt file, because "no usable engine" is a skip, not a crash.
{
  const good = readEngineBuildVersion('C:/UE', {
    readFileImpl: p => {
      t.assert(p.split(/[\\/]/).join('/') === 'C:/UE/Engine/Build/Build.version',
        `reads Build.version from the install (got ${p})`);
      return '{"MajorVersion":5,"MinorVersion":6,"PatchVersion":1,"Changelist":44394996}';
    },
  });
  t.assert(good?.MinorVersion === 6 && good?.Changelist === 44394996,
    'parses the version fields the oracle comparison needs');

  const missing = readEngineBuildVersion('C:/UE', {
    readFileImpl: () => { const e = new Error('nope'); e.code = 'ENOENT'; throw e; },
  });
  t.assert(missing === null, `a missing Build.version yields null, not a throw (got ${missing})`);

  const corrupt = readEngineBuildVersion('C:/UE', { readFileImpl: () => 'not json {' });
  t.assert(corrupt === null, `an unparseable Build.version yields null, not a throw (got ${corrupt})`);
}

// The offline reader resolved /Game/ and treated everything else as a path
// relative to the project, so /Engine/ assets were unreadable — resolve() would
// point them at the project's drive root. Engine content is a real mount and
// addressing it is a legitimate read.
{
  const disk = resolveAssetDiskPath('D:/Proj', '/Engine/EngineSky/BP_Sky_Sphere', { engineRoot: 'C:/UE' });
  t.assert(disk?.split(/[\\/]/).join('/') === 'C:/UE/Engine/Content/EngineSky/BP_Sky_Sphere.uasset',
    `/Engine/ resolves against the engine install, not the project (got ${disk})`);

  const game = resolveAssetDiskPath('D:/Proj', '/Game/Actors/BP_Thing', { engineRoot: 'C:/UE' });
  t.assert(game?.split(/[\\/]/).join('/') === 'D:/Proj/Content/Actors/BP_Thing.uasset',
    `/Game/ still resolves against the project (got ${game})`);

  t.assert(resolveAssetDiskPath('D:/Proj', '/Engine/EngineSky/BP_Sky_Sphere', { engineRoot: null }) === null,
    'with no engine installed, an /Engine/ path resolves to null rather than a bogus project path');
}

// Guessing "newest installed engine" silently read UE_5.8's copy of an asset
// while the caller meant 5.6 — same path, different bytes, no error anywhere.
// A read that cannot identify WHICH engine must decline rather than guess.
{
  const guessed = resolveAssetDiskPath('D:/Proj', '/Engine/EngineSky/BP_Sky_Sphere', { env: {} });
  t.assert(guessed === null,
    `an /Engine/ read with no engine named declines instead of picking one (got ${guessed})`);

  const fromEnv = resolveAssetDiskPath('D:/Proj', '/Engine/EngineSky/BP_Sky_Sphere',
    { env: { UE_ENGINE_ROOT: 'C:/UE_5.6' } });
  t.assert(fromEnv?.split(/[\\/]/).join('/') === 'C:/UE_5.6/Engine/Content/EngineSky/BP_Sky_Sphere.uasset',
    `UE_ENGINE_ROOT names the engine for /Engine/ reads (got ${fromEnv})`);
}

// A fixture must pin to the engine its oracle came from, so version preference
// has to beat install order — this is the bug above, from the other side.
{
  const root = resolveEngineRoot({
    env: {},
    preferVersion: '5.6',
    candidates: ['C:/Epic/UE_5.8', 'C:/Epic/UE_5.6'],
    existsImpl: () => true,
  });
  t.assert(root === 'C:/Epic/UE_5.6',
    `preferVersion outranks candidate order (got ${root})`);

  const absent = resolveEngineRoot({
    env: {},
    preferVersion: '5.3',
    candidates: ['C:/Epic/UE_5.8'],
    existsImpl: p => p.endsWith('5.8'),
  });
  t.assert(absent === null,
    `a preferred version that is not installed does not fall back to another (got ${absent})`);
}

process.exit(t.summary());
