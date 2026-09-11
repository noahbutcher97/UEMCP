// offline-core.mjs — shared leaf for the offline toolset: path resolution,
// the parsed-header cache, header and property-read parsing, and the
// asset-existence guard. Imported by offline-project-tools, offline-asset-tools
// and offline-blueprint-tools; imports none of them.

import { getMountTable, resolveMountedAssetPath } from './content-mounts.mjs';
import { readFile, stat } from 'node:fs/promises';
import { join, resolve as pathResolve } from 'node:path';

import {
  Cursor,
  parseSummary,
  readNameTable,
  readImportTable,
  readExportTable,
  readAssetRegistryData,
  makePackageIndexResolver,
  propertyTagLayoutForPackage,
} from './uasset-parser.mjs';
import {
  buildStructHandlers,
  buildContainerHandlers,
} from './uasset-structs.mjs';
import { REQUIRED_CONTAINER_PROPERTY_TYPES } from './property-read-contract.mjs';

export function buildPropertyReadHandlers() {
  const structHandlers = buildStructHandlers();
  const containerHandlers = buildContainerHandlers();
  const missingContainerHandlers = REQUIRED_CONTAINER_PROPERTY_TYPES
    .filter(type => typeof containerHandlers.get(type) !== 'function');
  if (missingContainerHandlers.length > 0) {
    throw new Error(`Missing read_asset_properties container handlers: ${missingContainerHandlers.join(', ')}`);
  }
  return { structHandlers, containerHandlers };
}

// ── Asset Header Cache (Option D: Hybrid TTL + mtime + write-suspicion) ─────
//
// The asset index is an in-memory map of parsed FAssetRegistryData blocks
// extracted from .uasset headers. Bulk queries (find_blueprints_implementing_interface,
// search_assets, get_asset_references) serve from this cache.
//
// Invalidation strategy (per D33, revised 2026-04-13):
//   - TTL backstop: bulk queries trust cache if younger than BULK_TTL_MS
//   - mtime diff: on TTL expiry, readdir + stat, re-parse only files where
//     fs mtime > cached mtime
//   - Write-suspicion flag: TCP write-ops (Phase 3) set indexDirty = true,
//     forcing next bulk query to re-validate regardless of TTL
//   - Pointed queries (inspect_blueprint /Game/Foo) always stat + re-parse if
//     mtime newer — no TTL, no flag
//
// Why not fs.watch: Windows recursive watch is unreliable; UE atomic-renames
// during save generate event storms. Stat-based diffing is O(changed-dirs),
// runs in <1s even on 10k-asset projects.

const BULK_TTL_MS = 60_000;

/** @typedef {{ path: string, mtimeMs: number, sizeBytes: number, data: object }} AssetCacheEntry */

export const assetCache = {
  /** @type {Map<string, AssetCacheEntry>} */
  entries: new Map(),
  /** Timestamp of last full bulk validation. */
  lastBulkCheckMs: 0,
  /** Set by TCP write-ops to force re-validation on next bulk query. */
  indexDirty: false,
};

export function resetOfflineAssetCache() {
  assetCache.entries.clear();
  assetCache.lastBulkCheckMs = 0;
  assetCache.indexDirty = false;
}

/**
 * Decide whether a specific cached entry needs to be re-parsed.
 *
 * Research-backed decisions (2026-04-13):
 *
 *   (a) EQUAL MTIMES ARE NOT SAFE CACHE HITS. Node's stat() on Windows
 *       rounds mtimeMs to 1-2 second resolution even though NTFS stores
 *       100ns precision. Two UE saves within the same second can produce
 *       identical mtimeMs values. Fix: compare file size as a secondary
 *       signal. UE's SavePackage writes name/export table offsets that
 *       shift on virtually every save — size equality is a strong hint
 *       the file content is genuinely unchanged. stat() already returns
 *       size, so this costs nothing.
 *
 *   (b) indexDirty APPLIES TO BOTH POINTED AND BULK QUERIES. Pointed
 *       queries stat+diff, but under coarse Windows mtime resolution
 *       stat-diff alone can miss same-second writes. indexDirty is the
 *       only signal for those cases. Honoring it on pointed queries
 *       costs one re-parse per flagged call — acceptable.
 *
 *   (c) EBUSY IS NOT shouldRescan's PROBLEM. UE's atomic MoveFileW
 *       rename means we never observe half-written headers. The
 *       microsecond race window during rename can surface EBUSY on
 *       readFile, but shouldRescan only decides yes/no on re-parse —
 *       the caller handles read-time errors (retry once, then fail).
 *
 *   (d) EQUAL MTIME + EQUAL SIZE IS TRUSTED AS A HIT. The alternative
 *       (content hash) would cost a full file read every check, defeating
 *       the point of caching. Size collision with real content change is
 *       vanishingly rare for .uasset files and will self-heal on the next
 *       mtime tick or indexDirty flip.
 *
 * @param {AssetCacheEntry | undefined} cacheEntry
 * @param {number} fsMtimeMs - current filesystem mtime from stat()
 * @param {number} fsSizeBytes - current filesystem size from stat()
 * @param {{ indexDirty: boolean }} context
 * @returns {boolean} true = re-parse from disk, false = serve cached
 */
export function shouldRescan(cacheEntry, fsMtimeMs, fsSizeBytes, context) {
  // Never seen — must parse.
  if (!cacheEntry) return true;

  // Write-op flagged the index dirty. Covers the coarse-mtime blind spot.
  if (context.indexDirty) return true;

  // Disk mtime advanced past cache — file is newer.
  if (fsMtimeMs > cacheEntry.mtimeMs) return true;

  // Equal mtime is not trusted alone (Windows/Node rounds to 1-2s).
  // Size mismatch under equal mtime ⇒ same-second second-save happened.
  if (fsMtimeMs === cacheEntry.mtimeMs && fsSizeBytes !== cacheEntry.sizeBytes) {
    return true;
  }

  // Cache wins.
  return false;
}

/**
 * Resolve a project-relative path to an absolute path.
 * @param {string} projectRoot
 * @param {string} relPath
 * @returns {string}
 */
export function resolve(projectRoot, relPath) {
  // path.join handles platform-appropriate separators
  return join(projectRoot, ...relPath.split(/[\\/]/));
}

/**
 * Resolve an asset path (/Game/..., or a fs-relative path) to an absolute
 * disk path. Appends .uasset if neither .uasset nor .umap is present.
 * @param {string} projectRoot
 * @param {string} assetPath
 * @returns {string}
 */
export function resolveAssetDiskPath(projectRoot, assetPath, { engineRoot, env = process.env } = {}) {
  let diskPath = assetPath;
  if (assetPath.startsWith('/Game/')) {
    diskPath = join(projectRoot, 'Content', assetPath.replace('/Game/', ''));
    if (!diskPath.endsWith('.uasset') && !diskPath.endsWith('.umap')) {
      diskPath += '.uasset';
    }
  } else if (assetPath.startsWith('/')) {
    // Any other leading-slash path is a MOUNT POINT, not a project-relative
    // path: /Engine/, and one root per plugin (/Niagara/, /ChaosNiagara/).
    // Resolving those against projectRoot would silently point at the project's
    // drive root. The mount name hides where a plugin lives on disk — /Niagara/
    // is at Engine/Plugins/FX/Niagara/Content — so the table is discovered,
    // never computed.
    //
    // The engine must be named explicitly, never guessed. Several engine
    // versions are typically installed side by side and they ship DIFFERENT
    // bytes at the same path, so picking "the newest installed" reads the wrong
    // asset and reports success. Declining surfaces as asset_not_found via the
    // caller's existence check, which is recoverable; silently correct-looking
    // wrong data is not.
    const root = engineRoot === undefined ? (env.UE_ENGINE_ROOT || null) : engineRoot;
    const mounted = resolveMountedAssetPath(getMountTable({ engineRoot: root, projectRoot }), assetPath);
    if (mounted) {
      diskPath = mounted;
    } else if (assetPath.startsWith('/Engine/')) {
      diskPath = null; // engine mount requested with no engine named
    } else {
      // Not a mount we know. Preserve the legacy relative interpretation rather
      // than failing a path shape that used to work.
      diskPath = resolve(projectRoot, assetPath);
    }
  } else {
    diskPath = resolve(projectRoot, assetPath);
  }
  return diskPath;
}

/**
 * Parse a .uasset/.umap header (summary + names + asset-registry tag block)
 * with caching. Serves cached entry when fs mtime/size match and the index
 * is not flagged dirty; otherwise re-parses and updates the cache.
 *
 * Pointed-query path — no TTL, stat+diff every call (cheap), honors
 * indexDirty to cover Windows same-second-write blind spots.
 *
 * @param {string} projectRoot
 * @param {string} assetPath  either /Game/... or a fs-relative path
 * @returns {Promise<{ diskPath: string, sizeBytes: number, mtimeMs: number,
 *                    modified: string,
 *                    data: { summary: object, names: string[],
 *                            assetRegistry: { dependencyDataOffset: number,
 *                                             objects: object[] } } }>}
 */
export async function parseAssetHeader(projectRoot, assetPath) {
  const diskPath = resolveAssetDiskPath(projectRoot, assetPath);

  let stats;
  try {
    stats = await stat(diskPath);
  } catch (err) {
    throw new Error(`Asset not found: ${assetPath} (${err.message})`);
  }

  const cached = assetCache.entries.get(diskPath);
  if (!shouldRescan(cached, stats.mtimeMs, stats.size, assetCache)) {
    return {
      diskPath,
      sizeBytes: cached.sizeBytes,
      mtimeMs: cached.mtimeMs,
      modified: new Date(cached.mtimeMs).toISOString(),
      data: cached.data,
    };
  }

  // Re-parse. Read once, parse summary / names / AR in sequence.
  const buf = await readFile(diskPath);
  const cur = new Cursor(buf);
  const summary = parseSummary(cur);
  const names = readNameTable(cur, summary);
  // Export table isn't included in the cached payload — callers that need
  // it (inspect_blueprint, list_level_actors) re-parse lazily. Keeping AR
  // as the baseline makes the cache row small and broadly useful.
  const assetRegistry = summary.assetRegistryDataOffset
    ? readAssetRegistryData(cur, summary)
    : { dependencyDataOffset: 0, objects: [] };

  const data = { summary, names, assetRegistry };
  assetCache.entries.set(diskPath, {
    path: diskPath,
    mtimeMs: stats.mtimeMs,
    sizeBytes: stats.size,
    data,
  });

  return {
    diskPath,
    sizeBytes: stats.size,
    mtimeMs: stats.mtimeMs,
    modified: stats.mtime.toISOString(),
    data,
  };
}

/**
 * Resolve and validate a project-relative source path.
 * Rejects traversal outside projectRoot. Returns absolute path.
 * @param {string} projectRoot
 * @param {string} filePath
 * @returns {string}
 */
export function resolveSafePath(projectRoot, filePath) {
  const full = pathResolve(resolve(projectRoot, filePath));
  const normRoot = pathResolve(projectRoot);
  if (!full.toLowerCase().startsWith(normRoot.toLowerCase())) {
    throw new Error('Path traversal not allowed');
  }
  return full;
}

/**
 * Recursively remove `packageIndex` fields from response objects. The raw
 * FPackageIndex integer leaks parser-internal resolution detail that callers
 * don't need — resolved objectName/packagePath/kind are the public surface.
 * Arrays and plain objects only; skips primitives, null, and non-plain
 * objects (Date, Map, etc.) defensively.
 *
 * The configured reader's `unsupported[]` reasons are centralized in
 * PROPERTY_READ_REASON_GROUPS and documented in docs/specs/tool-surface.md.
 */
export function stripPackageIndex(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) value[i] = stripPackageIndex(value[i]);
    return value;
  }
  // Only strip on plain objects — leave class instances alone.
  if (Object.getPrototypeOf(value) !== Object.prototype) return value;
  delete value.packageIndex;
  for (const key of Object.keys(value)) {
    value[key] = stripPackageIndex(value[key]);
  }
  return value;
}

/**
 * Parse an asset's header + tables and return a shared context for property
 * reading. Consumes the file once; all struct/container dispatch reuses
 * the same buffer and name table.
 */
export async function parseAssetForPropertyRead(projectRoot, assetPath) {
  const diskPath = resolveAssetDiskPath(projectRoot, assetPath);
  const stats = await stat(diskPath);
  const buf = await readFile(diskPath);
  const cur = new Cursor(buf);
  const summary = parseSummary(cur);
  const names = readNameTable(cur, summary);
  const imports = readImportTable(cur, summary, names);
  const exports = readExportTable(cur, summary, names);
  const handlers = buildPropertyReadHandlers();
  // The tagged-property layout varies PER PACKAGE, not per engine — a 5.8
  // project can be almost entirely pre-1012 content.
  const tagLayout = propertyTagLayoutForPackage(summary);
  return {
    diskPath, stats, buf, summary, names, imports, exports, ...tagLayout,
    resolve: makePackageIndexResolver(exports, imports),
    ...handlers,
  };
}

/**
 * EN-9: graceful-degradation wrapper for asset-path-taking offline handlers.
 *
 * Catches fs ENOENT at the handler edge and returns a FA-β envelope
 * `{available: false, reason: "asset_not_found", asset_path: "..."}` instead
 * of propagating the raw error through the MCP error channel. Only ENOENT
 * degrades gracefully — genuine parser errors (corrupt bytes, unknown class,
 * missing graph) still throw so callers can distinguish "plugin/asset absent"
 * from "something's structurally wrong".
 *
 * Each M-spatial verb is wrapped below. M-new (Verb-surface) workers should
 * wrap their new verbs the same way — the helper takes any handler with
 * signature `(projectRoot, params) => Promise<object>` and returns a handler
 * with the same signature plus ENOENT-guarding.
 *
 * @template {(projectRoot: string, params: object) => Promise<object>} H
 * @param {H} handler
 * @returns {H}
 */
export function withAssetExistenceCheck(handler) {
  return async function guarded(projectRoot, params) {
    try {
      return await handler(projectRoot, params);
    } catch (err) {
      if (err && err.code === 'ENOENT') {
        return {
          available: false,
          reason: 'asset_not_found',
          asset_path: params?.asset_path ?? null,
        };
      }
      throw err;
    }
  };
}
