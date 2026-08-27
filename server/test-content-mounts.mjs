// test-content-mounts.mjs — UE content mount-point resolution.
//
// UE addresses content by MOUNT POINT, not by directory: /Game/, /Engine/, and
// one root per plugin (/Niagara/, /ChaosNiagara/) are siblings in a virtual
// namespace. The intermediate directory is deliberately hidden by the mount name
// — /Niagara/ lives at Engine/Plugins/FX/Niagara/Content — so plugin paths can
// only be resolved by DISCOVERING plugins, never by string manipulation.
//
// Before this, /Game/ and /Engine/ were the only mounts the offline tools knew,
// which made every plugin-mounted asset unreachable.

import { existsSync } from 'node:fs';

import { buildMountTable, resolveMountedAssetPath } from './content-mounts.mjs';
import { resolveEngineRoot } from './engine-fixtures.mjs';
import { TestRunner } from './test-helpers.mjs';

const t = new TestRunner('content mounts');

// A fake engine/project tree. listEntries returns dirent-likes; anything not
// listed is unreadable, which is how a real missing directory behaves.
function fakeFs(tree) {
  return {
    listEntries: dir => {
      const key = dir.split(/[\\/]/).join('/');
      const entry = tree[key];
      return entry === undefined ? null : entry;
    },
    exists: p => {
      const key = p.split(/[\\/]/).join('/');
      return tree[key] !== undefined || Object.keys(tree).some(k => k === key);
    },
  };
}

const dir = name => ({ name, isDirectory: () => true });
const file = name => ({ name, isDirectory: () => false });

// ── The two built-in mounts ──────────────────────────────────────────
{
  const fs = fakeFs({ 'C:/UE/Engine/Plugins': [] });
  const mounts = buildMountTable({ engineRoot: 'C:/UE', projectRoot: 'D:/Proj', ...fs });
  t.assert(mounts.get('Engine')?.split(/[\\/]/).join('/') === 'C:/UE/Engine/Content',
    `/Engine/ maps to the engine content tree (got ${mounts.get('Engine')})`);
  t.assert(mounts.get('Game')?.split(/[\\/]/).join('/') === 'D:/Proj/Content',
    `/Game/ maps to the project content tree (got ${mounts.get('Game')})`);
}

// ── Plugin discovery ─────────────────────────────────────────────────
// The mount name is the .uplugin stem, and the directory it sits under is not
// derivable from it — that is exactly why discovery is required.
{
  const fs = fakeFs({
    'C:/UE/Engine/Plugins': [dir('FX'), dir('Experimental')],
    'C:/UE/Engine/Plugins/FX': [dir('Niagara')],
    'C:/UE/Engine/Plugins/FX/Niagara': [file('Niagara.uplugin'), dir('Content'), dir('Source')],
    'C:/UE/Engine/Plugins/FX/Niagara/Content': [],
    'C:/UE/Engine/Plugins/Experimental': [dir('ChaosNiagara')],
    'C:/UE/Engine/Plugins/Experimental/ChaosNiagara': [file('ChaosNiagara.uplugin'), dir('Content')],
    'C:/UE/Engine/Plugins/Experimental/ChaosNiagara/Content': [],
  });
  const mounts = buildMountTable({ engineRoot: 'C:/UE', projectRoot: 'D:/Proj', ...fs });
  t.assert(mounts.get('Niagara')?.split(/[\\/]/).join('/') === 'C:/UE/Engine/Plugins/FX/Niagara/Content',
    `a nested plugin mounts under its own name, not its directory (got ${mounts.get('Niagara')})`);
  t.assert(mounts.get('ChaosNiagara')?.split(/[\\/]/).join('/') === 'C:/UE/Engine/Plugins/Experimental/ChaosNiagara/Content',
    `a second plugin at a different depth is found too (got ${mounts.get('ChaosNiagara')})`);
}

// A plugin with no Content directory creates no mount — code-only plugins are
// the common case and must not produce a mount that resolves to nothing.
{
  const fs = fakeFs({
    'C:/UE/Engine/Plugins': [dir('CodeOnly')],
    'C:/UE/Engine/Plugins/CodeOnly': [file('CodeOnly.uplugin'), dir('Source')],
  });
  const mounts = buildMountTable({ engineRoot: 'C:/UE', projectRoot: 'D:/Proj', ...fs });
  t.assert(mounts.has('CodeOnly') === false, 'a plugin without Content/ does not mount');
}

// A project plugin shadows an engine plugin of the same name, matching UE's
// own precedence — otherwise a project's fork silently reads engine bytes.
{
  const fs = fakeFs({
    'C:/UE/Engine/Plugins': [dir('Shared')],
    'C:/UE/Engine/Plugins/Shared': [file('Shared.uplugin'), dir('Content')],
    'C:/UE/Engine/Plugins/Shared/Content': [],
    'D:/Proj/Plugins': [dir('Shared')],
    'D:/Proj/Plugins/Shared': [file('Shared.uplugin'), dir('Content')],
    'D:/Proj/Plugins/Shared/Content': [],
  });
  const mounts = buildMountTable({ engineRoot: 'C:/UE', projectRoot: 'D:/Proj', ...fs });
  t.assert(mounts.get('Shared')?.split(/[\\/]/).join('/') === 'D:/Proj/Plugins/Shared/Content',
    `project plugin wins over the engine plugin of the same name (got ${mounts.get('Shared')})`);
}

// ── Path resolution against the table ────────────────────────────────
{
  const mounts = new Map([
    ['Engine', 'C:/UE/Engine/Content'],
    ['Game', 'D:/Proj/Content'],
    ['Niagara', 'C:/UE/Engine/Plugins/FX/Niagara/Content'],
  ]);
  const n = resolveMountedAssetPath(mounts, '/Niagara/Modules/Spawn/InitializeParticle');
  t.assert(n?.split(/[\\/]/).join('/') === 'C:/UE/Engine/Plugins/FX/Niagara/Content/Modules/Spawn/InitializeParticle.uasset',
    `a plugin-mounted path resolves through the table (got ${n})`);

  const e = resolveMountedAssetPath(mounts, '/Engine/EngineSky/BP_Sky_Sphere');
  t.assert(e?.split(/[\\/]/).join('/') === 'C:/UE/Engine/Content/EngineSky/BP_Sky_Sphere.uasset',
    `/Engine/ still resolves (got ${e})`);

  const g = resolveMountedAssetPath(mounts, '/Game/Actors/BP_Thing');
  t.assert(g?.split(/[\\/]/).join('/') === 'D:/Proj/Content/Actors/BP_Thing.uasset',
    `/Game/ still resolves (got ${g})`);

  t.assert(resolveMountedAssetPath(mounts, '/NotAPlugin/Foo') === null,
    'an unknown mount resolves to null rather than a guessed path');

  // An explicit extension is authoritative — levels are .umap, not .uasset.
  const m = resolveMountedAssetPath(mounts, '/Game/Maps/Level.umap');
  t.assert(m?.split(/[\\/]/).join('/') === 'D:/Proj/Content/Maps/Level.umap',
    `an explicit .umap extension is preserved (got ${m})`);

  t.assert(resolveMountedAssetPath(mounts, 'Content/Relative/Path') === null,
    'a non-mounted (relative) path is not claimed by the resolver');
}

// ── Against a real install ───────────────────────────────────────────
// The unit tests above run on a fake tree, and a fake that encodes the wrong
// rule passes happily — which is precisely how "/Engine/ is the only mount"
// survived review. This checks the rule against an actual engine when one is
// present, and is a labeled skip when none is.
{
  const engineRoot = resolveEngineRoot({ preferVersion: '5.6' });
  if (!engineRoot) {
    console.log('  ⊘ SKIP real-install mount check: no UE 5.6 install (set UE_ENGINE_ROOT)');
  } else {
    const mounts = buildMountTable({ engineRoot });
    t.assert(mounts.size > 50, `a real engine yields many mounts, not just Engine (got ${mounts.size})`);
    t.assert(mounts.has('Engine'), 'real install has the Engine mount');

    // Niagara is the case that motivated this: its content is at
    // Engine/Plugins/FX/Niagara/Content, and "FX" appears nowhere in the mount
    // name — unreachable by any string rule.
    const niagara = mounts.get('Niagara');
    t.assert(typeof niagara === 'string' && /Plugins[\\/]FX[\\/]Niagara[\\/]Content$/.test(niagara),
      `Niagara resolves through a directory its mount name does not contain (got ${niagara})`);

    const resolved = resolveMountedAssetPath(mounts, '/Niagara/Modules/Spawn/Initialization/V2/InitializeParticle');
    t.assert(resolved !== null && existsSync(resolved),
      `a plugin-mounted asset path resolves to a file that exists (got ${resolved})`);
  }
}

process.exit(t.summary());
