// content-mounts.mjs — UE content mount-point resolution.
//
// UE addresses content by MOUNT POINT, not by directory. `/Game/`, `/Engine/`
// and one root per plugin (`/Niagara/`, `/ChaosNiagara/`) are siblings in a
// virtual namespace, and the mount name deliberately hides where the plugin
// sits on disk: `/Niagara/` lives at `Engine/Plugins/FX/Niagara/Content`, and
// `FX/` is not derivable from `Niagara`.
//
// That is the whole reason this module exists. Plugin paths cannot be resolved
// by string manipulation — the plugins have to be discovered.

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// Plugins nest a few levels under Plugins/ (FX/Niagara, Experimental/Chaos…),
// but never deeply. Bounding the walk keeps discovery cheap and stops it
// wandering into content trees.
const MAX_PLUGIN_SEARCH_DEPTH = 4;

// Directories that never contain a .uplugin and can be large.
const SKIPPED_PLUGIN_DIRS = new Set([
  'Content', 'Binaries', 'Intermediate', 'Source', 'Saved', 'Config', 'Resources', 'Shaders',
]);

function defaultListEntries(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return null; // missing or unreadable — indistinguishable and both mean "no mounts here"
  }
}

function defaultExists(path) {
  return existsSync(path);
}

/**
 * Discover every plugin under `root` and add its content mount.
 *
 * Later calls overwrite earlier ones, which is how project plugins are made to
 * shadow engine plugins of the same name — callers pass the engine root first.
 */
function collectPluginMounts(mounts, root, { listEntries, exists }) {
  const walk = (dir, depth) => {
    if (depth > MAX_PLUGIN_SEARCH_DEPTH) return;
    const entries = listEntries(dir);
    if (!entries) return;

    const pluginFile = entries.find(e => !e.isDirectory() && e.name.endsWith('.uplugin'));
    if (pluginFile) {
      // A plugin with no Content/ mounts nothing. Code-only plugins are common,
      // and a mount pointing at a missing directory would resolve to paths that
      // never exist.
      const contentDir = join(dir, 'Content');
      if (exists(contentDir)) {
        mounts.set(pluginFile.name.slice(0, -'.uplugin'.length), contentDir);
      }
      return; // plugins do not nest inside plugins
    }

    for (const entry of entries) {
      if (!entry.isDirectory() || SKIPPED_PLUGIN_DIRS.has(entry.name)) continue;
      walk(join(dir, entry.name), depth + 1);
    }
  };
  walk(root, 0);
}

/**
 * Build the mount-point → content-directory table for an engine + project pair.
 *
 * Either root may be absent; the mounts that depend on it are simply missing.
 *
 * @returns {Map<string,string>} keyed by mount name WITHOUT slashes ('Engine', 'Game', 'Niagara')
 */
export function buildMountTable({
  engineRoot,
  projectRoot,
  listEntries = defaultListEntries,
  exists = defaultExists,
} = {}) {
  const mounts = new Map();

  if (typeof engineRoot === 'string' && engineRoot) {
    mounts.set('Engine', join(engineRoot, 'Engine', 'Content'));
    collectPluginMounts(mounts, join(engineRoot, 'Engine', 'Plugins'), { listEntries, exists });
  }
  if (typeof projectRoot === 'string' && projectRoot) {
    mounts.set('Game', join(projectRoot, 'Content'));
    // Second, so a project plugin shadows an engine plugin of the same name —
    // UE's own precedence. Reversing this would silently read engine bytes for
    // a project's fork of a plugin.
    collectPluginMounts(mounts, join(projectRoot, 'Plugins'), { listEntries, exists });
  }
  return mounts;
}

/**
 * Resolve a mounted asset path (`/Niagara/Modules/X`) to a file on disk.
 *
 * Returns null for an unmounted path rather than guessing, so an unknown mount
 * surfaces as asset_not_found instead of a confidently wrong read.
 */
export function resolveMountedAssetPath(mounts, assetPath) {
  if (!mounts || typeof assetPath !== 'string' || !assetPath.startsWith('/')) return null;
  const slash = assetPath.indexOf('/', 1);
  if (slash < 0) return null;

  const mountName = assetPath.slice(1, slash);
  const contentDir = mounts.get(mountName);
  if (!contentDir) return null;

  const rel = assetPath.slice(slash + 1);
  if (!rel) return null;

  // An explicit extension is authoritative — levels are .umap, not .uasset.
  const hasExtension = rel.endsWith('.uasset') || rel.endsWith('.umap');
  return join(contentDir, hasExtension ? rel : `${rel}.uasset`);
}

// Discovery walks the plugin trees, so it is cached per root pair — a per-asset
// rebuild would put a filesystem walk in front of every offline read.
const mountTableCache = new Map();

/**
 * Cached buildMountTable. Same contract, one walk per (engineRoot, projectRoot).
 */
export function getMountTable({ engineRoot, projectRoot } = {}) {
  const key = `${engineRoot ?? ''}\u0000${projectRoot ?? ''}`;
  let table = mountTableCache.get(key);
  if (!table) {
    table = buildMountTable({ engineRoot, projectRoot });
    mountTableCache.set(key, table);
  }
  return table;
}

/** Drop cached mount tables — for tests and for a re-attach to a new project. */
export function clearMountTableCache() {
  mountTableCache.clear();
}
