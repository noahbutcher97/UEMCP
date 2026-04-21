// Offline toolset — 10 tools that work without Unreal Editor
//
// All tools read from the project directory on disk.
// They parse .uproject, .ini, .uasset headers, .h/.cpp source, etc.
// No TCP or HTTP connections needed.

import { readFile, readdir, stat, access } from 'node:fs/promises';
import { join, extname, basename, relative, resolve as pathResolve } from 'node:path';

import {
  Cursor,
  parseSummary,
  readNameTable,
  readImportTable,
  readExportTable,
  resolvePackageIndex,
  readAssetRegistryData,
  readExportProperties,
  makePackageIndexResolver,
} from './uasset-parser.mjs';
import {
  buildStructHandlers,
  buildContainerHandlers,
} from './uasset-structs.mjs';

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

// ── Helpers ─────────────────────────────────────────────────

/**
 * Resolve a project-relative path to an absolute path.
 * @param {string} projectRoot
 * @param {string} relPath
 * @returns {string}
 */
function resolve(projectRoot, relPath) {
  // path.join handles platform-appropriate separators
  return join(projectRoot, ...relPath.split(/[\\/]/));
}

/**
 * Read and parse a .uproject JSON file.
 * @param {string} projectRoot
 * @returns {Promise<object>}
 */
async function readUProject(projectRoot) {
  const files = await readdir(projectRoot);
  const uprojectFile = files.find(f => f.endsWith('.uproject'));
  if (!uprojectFile) throw new Error('No .uproject file found in project root');
  const raw = await readFile(join(projectRoot, uprojectFile), 'utf-8');
  // UE .uproject files allow trailing commas — strip them before parsing
  const cleaned = raw.replace(/,\s*([\]}])/g, '$1');
  return { fileName: uprojectFile, ...JSON.parse(cleaned) };
}

/**
 * Parse a UE .ini config file into sections.
 * @param {string} filePath
 * @returns {Promise<Record<string, Record<string, string[]>>>}
 */
async function parseIniFile(filePath) {
  const raw = await readFile(filePath, 'utf-8');
  const sections = {};
  let currentSection = '__global__';
  sections[currentSection] = {};

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith(';')) continue;

    const sectionMatch = trimmed.match(/^\[(.+)\]$/);
    if (sectionMatch) {
      currentSection = sectionMatch[1];
      if (!sections[currentSection]) sections[currentSection] = {};
      continue;
    }

    // Key=Value or +Key=Value
    const kvMatch = trimmed.match(/^([+\-!]?)([^=]+)=(.*)$/);
    if (kvMatch) {
      const [, prefix, key, value] = kvMatch;
      const fullKey = prefix + key.trim();
      if (!sections[currentSection][fullKey]) {
        sections[currentSection][fullKey] = [];
      }
      sections[currentSection][fullKey].push(value.trim());
    }
  }

  return sections;
}

/**
 * Recursively list directory contents.
 * @param {string} dir
 * @param {string} baseDir — for computing relative paths
 * @param {number} maxDepth
 * @param {number} currentDepth
 * @returns {Promise<{path: string, type: 'file'|'dir', ext?: string}[]>}
 */
async function listDirRecursive(dir, baseDir, maxDepth = 3, currentDepth = 0) {
  if (currentDepth >= maxDepth) return [];
  const entries = [];
  try {
    const items = await readdir(dir, { withFileTypes: true });
    for (const item of items) {
      const fullPath = join(dir, item.name);
      const relPath = relative(baseDir, fullPath).replace(/\\/g, '/');
      if (item.isDirectory()) {
        entries.push({ path: relPath, type: 'dir' });
        const children = await listDirRecursive(fullPath, baseDir, maxDepth, currentDepth + 1);
        entries.push(...children);
      } else {
        entries.push({ path: relPath, type: 'file', ext: extname(item.name) });
      }
    }
  } catch { /* directory not accessible */ }
  return entries;
}

// ── Tool implementations ────────────────────────────────────

/**
 * project_info — Read .uproject, list plugins, engine version, build config
 */
async function projectInfo(projectRoot) {
  const data = await readUProject(projectRoot);
  return {
    projectName: data.fileName.replace('.uproject', ''),
    engineAssociation: data.EngineAssociation || 'unknown',
    category: data.Category || '',
    description: data.Description || '',
    modules: (data.Modules || []).map(m => ({
      name: m.Name,
      type: m.Type,
      loadingPhase: m.LoadingPhase,
    })),
    plugins: (data.Plugins || []).map(p => ({
      name: p.Name,
      enabled: p.Enabled !== false,
    })),
    targetPlatforms: data.TargetPlatforms || [],
  };
}

/**
 * list_gameplay_tags — Parse DefaultGameplayTags.ini, return full tag hierarchy
 */
async function listGameplayTags(projectRoot) {
  const iniPath = join(projectRoot, 'Config', 'DefaultGameplayTags.ini');
  let sections;
  try {
    sections = await parseIniFile(iniPath);
  } catch (err) {
    throw new Error(`Cannot read gameplay tags: ${iniPath} not found. Ensure Config/DefaultGameplayTags.ini exists in the project.`);
  }

  const tags = [];
  const tagSection = sections['/Script/GameplayTags.GameplayTagsSettings'] || {};

  // Tags are stored as +GameplayTagList=(Tag="...",DevComment="...")
  const tagEntries = tagSection['+GameplayTagList'] || [];

  for (const entry of tagEntries) {
    const tagMatch = entry.match(/Tag="([^"]+)"/);
    const commentMatch = entry.match(/DevComment="([^"]*)"/);
    if (tagMatch) {
      tags.push({
        tag: tagMatch[1],
        comment: commentMatch ? commentMatch[1] : '',
      });
    }
  }

  // Build hierarchy
  const hierarchy = {};
  for (const { tag, comment } of tags) {
    const parts = tag.split('.');
    let node = hierarchy;
    for (const part of parts) {
      if (!node[part]) node[part] = { _children: {} };
      node = node[part]._children;
    }
    // Attach comment to the leaf
    let commentNode = hierarchy;
    for (let i = 0; i < parts.length; i++) {
      if (i === parts.length - 1) {
        commentNode[parts[i]]._comment = comment;
      } else {
        commentNode = commentNode[parts[i]]._children;
      }
    }
  }

  return { totalTags: tags.length, tags, hierarchy };
}

/**
 * Direct glob matcher for gameplay tags. Avoids dynamic RegExp construction.
 *
 * Semantics (matches UE tag conventions):
 *   literal chars — case-insensitive exact match
 *   .            — literal separator between tag components
 *   *            — matches 0+ chars excluding `.` (single component)
 *   **           — matches 0+ chars including `.` (crosses components)
 *
 * Complexity: O(m*n) with memoization on (patternPos, textPos). No backtracking
 * risk; no `new RegExp()` call → no ReDoS attack surface and no semgrep finding.
 *
 * @param {string} pattern
 * @param {string} text
 * @returns {boolean}
 */
export function matchTagGlob(pattern, text) {
  const p = pattern.toLowerCase();
  const t = text.toLowerCase();
  const m = p.length;
  const n = t.length;
  const memo = new Map();

  function f(i, j) {
    const key = i * (n + 1) + j;
    const cached = memo.get(key);
    if (cached !== undefined) return cached;
    let result;
    if (i === m) {
      result = j === n;
    } else if (p[i] === '*') {
      const isDouble = p[i + 1] === '*';
      if (isDouble) {
        result = f(i + 2, j) || (j < n && f(i, j + 1));
      } else {
        result = f(i + 1, j) || (j < n && t[j] !== '.' && f(i, j + 1));
      }
    } else {
      result = j < n && p[i] === t[j] && f(i + 1, j + 1);
    }
    memo.set(key, result);
    return result;
  }
  return f(0, 0);
}

/**
 * search_gameplay_tags — Search tags by pattern (glob-style, see matchTagGlob).
 */
async function searchGameplayTags(projectRoot, pattern) {
  const { tags } = await listGameplayTags(projectRoot);
  const matches = tags.filter(t => matchTagGlob(pattern, t.tag));
  return { pattern, matches, matchCount: matches.length };
}

/**
 * list_config_values — Read any .ini config file, search for keys/sections
 */
async function listConfigValues(projectRoot, configFile, section, key) {
  const configDir = join(projectRoot, 'Config');

  if (!configFile) {
    // List available config files
    const files = await readdir(configDir);
    return {
      configFiles: files.filter(f => f.endsWith('.ini')),
    };
  }

  const filePath = join(configDir, configFile);
  const sections = await parseIniFile(filePath);

  if (section && key) {
    // Return specific key
    const sectionData = sections[section] || {};
    return { section, key, values: sectionData[key] || sectionData['+' + key] || [] };
  }
  if (section) {
    // Return all keys in section
    return { section, keys: sections[section] || {} };
  }
  // Return all sections with key counts
  const summary = {};
  for (const [s, keys] of Object.entries(sections)) {
    summary[s] = Object.keys(keys).length;
  }
  return { sections: summary };
}

/**
 * Resolve an asset path (/Game/..., or a fs-relative path) to an absolute
 * disk path. Appends .uasset if neither .uasset nor .umap is present.
 * @param {string} projectRoot
 * @param {string} assetPath
 * @returns {string}
 */
function resolveAssetDiskPath(projectRoot, assetPath) {
  let diskPath = assetPath;
  if (assetPath.startsWith('/Game/')) {
    diskPath = join(projectRoot, 'Content', assetPath.replace('/Game/', ''));
    if (!diskPath.endsWith('.uasset') && !diskPath.endsWith('.umap')) {
      diskPath += '.uasset';
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
 * get_asset_info — Read .uasset header metadata
 *
 * Returns parsed registry metadata (class, objectPath, tags, counts) plus
 * size/mtime. Uses the shared asset cache — repeat queries on the same
 * unchanged file skip re-parse.
 *
 * Closes D36: reframes the stat-only placeholder into a registry query.
 */
async function getAssetInfo(projectRoot, assetPath, params = {}) {
  const verbose = params.verbose ?? false;
  const parsed = await parseAssetHeader(projectRoot, assetPath);
  const { summary, names, assetRegistry } = parsed.data;
  const primary = assetRegistry.objects[0] || null;

  let tags = primary ? primary.tags : {};
  const heavyTagsOmitted = [];

  if (!verbose) {
    // Strip tags whose decoded value exceeds 1 KB
    const filteredTags = {};
    for (const [key, value] of Object.entries(tags)) {
      const valueStr = String(value);
      if (valueStr.length > 1024) {
        heavyTagsOmitted.push(key);
      } else {
        filteredTags[key] = value;
      }
    }
    tags = filteredTags;
  }

  const result = {
    path: assetPath,
    diskPath: parsed.diskPath.replace(/\\/g, '/'),
    sizeBytes: parsed.sizeBytes,
    sizeKB: Math.round(parsed.sizeBytes / 1024),
    modified: parsed.modified,
    packageName: summary.packageName || null,
    objectPath: primary ? primary.objectPath : null,
    objectClassName: primary ? primary.objectClassName : null,
    tags,
    assetRegistryObjects: assetRegistry.objects.length,
    exportCount: summary.exportCount,
    importCount: summary.importCount,
    nameCount: names.length,
    fileVersionUE5: summary.fileVersionUE5,
  };

  if (!verbose && heavyTagsOmitted.length > 0) {
    result.heavyTagsOmitted = heavyTagsOmitted;
  }

  return result;
}

/**
 * Walk a directory recursively, collecting .uasset/.umap paths. Stops once
 * `maxFiles` are found. Silently skips unreadable subdirs.
 * @param {string} dir
 * @param {string[]} out  populated with absolute paths
 * @param {number} maxFiles
 */
async function walkAssetFiles(dir, out, maxFiles) {
  if (out.length >= maxFiles) return;
  let items;
  try {
    items = await readdir(dir, { withFileTypes: true });
  } catch { return; }
  for (const item of items) {
    if (out.length >= maxFiles) return;
    const full = join(dir, item.name);
    if (item.isDirectory()) {
      await walkAssetFiles(full, out, maxFiles);
    } else if (item.name.endsWith('.uasset') || item.name.endsWith('.umap')) {
      out.push(full);
    }
  }
}

/**
 * query_asset_registry — Bulk scan Content/ and filter by class/path/tag.
 *
 * Walks Content/**\/*.{uasset,umap}, parses each through the shared
 * parseAssetHeader() cache, and returns assets matching the filter. Designed
 * for discovery queries: "find all Blueprints under /Game/Abilities/",
 * "which DataTables have RowStruct=FOSCombatRow", etc.
 *
 * Filters:
 *   - class_name: exact match on primary object class. Accepts short names
 *     (e.g., "DataTable" matches "/Script/Engine.DataTable") or full paths
 *     (e.g., "/Script/Engine.World"). Case-sensitive.
 *   - path_prefix: /Game/... path; narrows the scan root (not a post-filter).
 *   - tag_key / tag_value: asset-registry tag match. If value is omitted,
 *     only tag presence is checked.
 *
 * Caps:
 *   - limit (default 200): max matches returned.
 *   - max_scan (default 5000): hard ceiling on files parsed; guards against
 *     runaway walks in huge Content trees. When hit, `truncated: true` is
 *     set in the response.
 *   - offset (default 0): pagination offset; skip first N matches.
 *
 * Response includes:
 *   - truncated: whether result set was capped by limit
 *   - total_scanned: files walked
 *   - total_matched: files that passed all filters (may be > limit)
 *   - offset: current offset (echoed back for pagination tracking)
 *
 * @param {string} projectRoot
 * @param {object} params
 */
async function queryAssetRegistry(projectRoot, params = {}) {
  const className = params.class_name ?? null;
  const pathPrefix = params.path_prefix ?? null;
  const tagKey = params.tag_key ?? null;
  const tagValue = params.tag_value ?? null;
  const verbose = params.verbose ?? false;
  const limit = Math.max(1, Math.min(params.limit ?? 200, 2000));
  const maxScan = Math.max(1, Math.min(params.max_scan ?? 5000, 20000));
  const offset = Math.max(0, params.offset ?? 0);

  // Narrow the walk root when a path_prefix is supplied — avoids parsing
  // thousands of unrelated files for a targeted query.
  let scanRoot = join(projectRoot, 'Content');
  if (pathPrefix) {
    if (!pathPrefix.startsWith('/Game/')) {
      throw new Error(`path_prefix must start with /Game/ (got: ${pathPrefix})`);
    }
    scanRoot = join(projectRoot, 'Content', pathPrefix.replace('/Game/', ''));
  }

  const files = [];
  await walkAssetFiles(scanRoot, files, maxScan);
  const hitMaxScan = files.length >= maxScan;

  const allMatches = [];
  const errors = [];
  const contentRoot = join(projectRoot, 'Content');

  for (const diskPath of files) {
    // Reconstruct /Game/ path for display & re-use parseAssetHeader's cache.
    const relFromContent = relative(contentRoot, diskPath).replace(/\\/g, '/');
    const ext = diskPath.endsWith('.umap') ? '.umap' : '.uasset';
    const gamePath = '/Game/' + relFromContent.replace(/\.(uasset|umap)$/, '');

    let parsed;
    try {
      // Pass fs-relative path so parseAssetHeader's resolver uses the
      // else-branch (no extension mangling for .umap).
      const relFromProject = relative(projectRoot, diskPath).replace(/\\/g, '/');
      parsed = await parseAssetHeader(projectRoot, relFromProject);
    } catch (err) {
      errors.push({ path: gamePath, error: err.message });
      continue;
    }

    const primary = parsed.data.assetRegistry.objects[0] || null;
    const klass = primary ? primary.objectClassName : null;
    const tags = primary ? primary.tags : {};

    // Class filter: exact match for full paths, suffix match for short names.
    // "DataTable" matches "/Script/Engine.DataTable" (suffix after final dot).
    if (className) {
      let matches = false;
      if (className.startsWith('/')) {
        // Full path — exact match
        matches = klass === className;
      } else {
        // Short name — suffix match after final dot
        const suffix = className;
        const klassSegment = klass ? klass.split('.').pop() : null;
        matches = klassSegment === suffix;
      }
      if (!matches) continue;
    }

    // Tag filter.
    if (tagKey) {
      if (!Object.prototype.hasOwnProperty.call(tags, tagKey)) continue;
      if (tagValue !== null && tags[tagKey] !== tagValue) continue;
    }

    // Build match object with tag filtering
    let fileTags = tags;
    const heavyTagsOmitted = [];

    if (!verbose) {
      const filteredTags = {};
      for (const [key, value] of Object.entries(tags)) {
        const valueStr = String(value);
        if (valueStr.length > 1024) {
          heavyTagsOmitted.push(key);
        } else {
          filteredTags[key] = value;
        }
      }
      fileTags = filteredTags;
    }

    const match = {
      path: gamePath + ext,
      objectClassName: klass,
      objectPath: primary ? primary.objectPath : null,
      packageName: parsed.data.summary.packageName || null,
      tags: fileTags,
      sizeBytes: parsed.sizeBytes,
      exportCount: parsed.data.summary.exportCount,
    };

    if (!verbose && heavyTagsOmitted.length > 0) {
      match.heavyTagsOmitted = heavyTagsOmitted;
    }

    allMatches.push(match);
  }

  // Apply pagination
  const totalMatched = allMatches.length;
  const results = allMatches.slice(offset, offset + limit);
  const truncated = hitMaxScan || (allMatches.length > offset + limit);

  return {
    scanRoot: relative(projectRoot, scanRoot).replace(/\\/g, '/') || 'Content',
    total_scanned: files.length,
    total_matched: totalMatched,
    truncated,
    offset,
    matches: results.length,
    errors: errors.length ? errors : undefined,
    results,
  };
}

// ── CSV-source tools (DataTable / StringTable) ──────────────
//
// Authoring CSVs. The .uasset DataTable/StringTable is a compiled binary
// asset produced by editor import from a .csv. These tools operate on the
// source CSV and encode UE import conventions so callers don't re-derive
// them. No binary parsing — raw CSV text.
//
// DataTable CSV convention:
//   - Header row. First column is the row-name column. UE commonly labels
//     it `---` but any name is accepted; we treat column index 0 as the key.
//   - Subsequent columns map to UPROPERTY fields on the companion RowStruct
//     (a USTRUCT declared in C++). Struct introspection is optional — if
//     row_struct_header is passed, we read that file and extract field
//     declarations so the caller sees column→property→type mapping.
//
// StringTable CSV convention:
//   - Header row. Columns: Key, SourceString (required); Comment (optional).
//     Namespace is typically set at the asset level, not per-row.
//
// CSV parser: minimal RFC-4180-ish — handles quoted fields with embedded
// commas, doubled-quote escape, CRLF/LF line endings. Not a full RFC
// implementation; UE-authored CSVs are well-behaved.

/**
 * Parse CSV text into rows of string arrays.
 * @param {string} text
 * @returns {string[][]}
 */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  const n = text.length;

  while (i < n) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (i + 1 < n && text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += c;
      i += 1;
      continue;
    }
    if (c === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (c === ',') {
      row.push(field);
      field = '';
      i += 1;
      continue;
    }
    if (c === '\r') {
      // CRLF: consume LF too
      if (i + 1 < n && text[i + 1] === '\n') i += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      i += 1;
      continue;
    }
    if (c === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      i += 1;
      continue;
    }
    field += c;
    i += 1;
  }
  // Trailing field / row (no final newline)
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  // Strip trailing empty rows (common with trailing newline)
  while (rows.length > 0 && rows[rows.length - 1].every(c => c === '')) {
    rows.pop();
  }
  return rows;
}

/**
 * Walk a directory recursively and yield .csv files.
 * @param {string} dir
 * @param {string} baseDir
 * @param {string[]} out
 */
async function collectCsvFiles(dir, baseDir, out) {
  let items;
  try {
    items = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const item of items) {
    const full = join(dir, item.name);
    if (item.isDirectory()) {
      if (['Collections', 'Developers', '__ExternalActors__', '__ExternalObjects__'].includes(item.name)) continue;
      await collectCsvFiles(full, baseDir, out);
    } else if (item.name.toLowerCase().endsWith('.csv')) {
      out.push(full);
    }
  }
}

/**
 * Classify a CSV by filename prefix/suffix. UE naming conventions:
 *   DT_*  = DataTable source
 *   ST_*  = StringTable source
 *   otherwise = generic CSV (treated as datatable by default)
 */
function classifyCsv(fileName) {
  const base = basename(fileName);
  if (/^ST[_-]/i.test(base)) return 'stringtable';
  if (/^DT[_-]/i.test(base)) return 'datatable';
  return 'csv';
}

/**
 * list_data_sources — Enumerate .csv authoring files under Content/
 *
 * Returns DataTable/StringTable source CSVs so callers can discover
 * "what data does this project have" without poking at binary .uassets.
 */
async function listDataSources(projectRoot) {
  const contentDir = join(projectRoot, 'Content');
  const found = [];
  await collectCsvFiles(contentDir, contentDir, found);

  const entries = [];
  for (const full of found) {
    let size = 0;
    try {
      const s = await stat(full);
      size = s.size;
    } catch { /* skip */ }
    entries.push({
      path: relative(projectRoot, full).replace(/\\/g, '/'),
      type: classifyCsv(full),
      sizeBytes: size,
    });
  }
  entries.sort((a, b) => a.path.localeCompare(b.path));

  const byType = { datatable: 0, stringtable: 0, csv: 0 };
  for (const e of entries) byType[e.type] += 1;

  return {
    contentDir: 'Content/',
    fileCount: entries.length,
    byType,
    entries,
  };
}

/**
 * Resolve and validate a project-relative source path.
 * Rejects traversal outside projectRoot. Returns absolute path.
 * @param {string} projectRoot
 * @param {string} filePath
 * @returns {string}
 */
function resolveSafePath(projectRoot, filePath) {
  const full = pathResolve(resolve(projectRoot, filePath));
  const normRoot = pathResolve(projectRoot);
  if (!full.toLowerCase().startsWith(normRoot.toLowerCase())) {
    throw new Error('Path traversal not allowed');
  }
  return full;
}

/**
 * Extract UPROPERTY fields from a USTRUCT in a .h file, if present.
 * Pure text parsing — does not invoke any compiler. Best-effort.
 * @param {string} headerPath
 * @returns {Promise<{structName?: string, fields: {name: string, type: string}[], note?: string}>}
 */
async function extractRowStructFields(headerPath) {
  const text = await readFile(headerPath, 'utf-8');
  // Find the first USTRUCT(...) struct declaration block.
  const structMatch = text.match(/USTRUCT\s*\([^)]*\)\s*struct\s+(?:[A-Z_]+_API\s+)?(F\w+)\s*(?::[^{]+)?\{([\s\S]*?)^\};/m);
  if (!structMatch) {
    return { fields: [], note: 'No USTRUCT found in header' };
  }
  const structName = structMatch[1];
  const body = structMatch[2];
  const fields = [];
  // Match UPROPERTY(...) lines followed by `<type> <name>;`. Keep types verbatim.
  const re = /UPROPERTY\s*\([^)]*\)\s*([^;\n]+?)\s+(\w+)\s*(?:=\s*[^;]+)?\s*;/g;
  let m;
  while ((m = re.exec(body)) !== null) {
    fields.push({ name: m[2], type: m[1].trim() });
  }
  return { structName, fields };
}

/**
 * read_datatable_source — Parse a DataTable source CSV.
 *
 * First column is the row-name key (UE convention; column label often `---`).
 * Returns headers, row-keyed rows, and — if row_struct_header is provided —
 * the companion USTRUCT field declarations.
 */
async function readDatatableSource(projectRoot, filePath, rowStructHeader) {
  const full = resolveSafePath(projectRoot, filePath);
  if (!full.toLowerCase().endsWith('.csv')) {
    throw new Error('read_datatable_source requires a .csv file');
  }
  const text = await readFile(full, 'utf-8');
  const parsed = parseCsv(text);
  if (parsed.length === 0) {
    return { path: filePath, headers: [], rowCount: 0, rows: [] };
  }
  const headers = parsed[0];
  const rowKeyHeader = headers[0]; // typically `---` or `Name`
  const columnHeaders = headers.slice(1);

  const rows = [];
  for (let i = 1; i < parsed.length; i++) {
    const r = parsed[i];
    if (r.length === 1 && r[0] === '') continue;
    const rowName = r[0];
    const values = {};
    for (let c = 0; c < columnHeaders.length; c++) {
      values[columnHeaders[c]] = r[c + 1] ?? '';
    }
    rows.push({ rowName, values });
  }

  /** @type {{structName?: string, fields: {name:string,type:string}[], note?: string} | undefined} */
  let rowStruct;
  if (rowStructHeader) {
    try {
      const headerPath = resolveSafePath(projectRoot, rowStructHeader);
      rowStruct = await extractRowStructFields(headerPath);
      rowStruct.headerPath = rowStructHeader;
    } catch (err) {
      rowStruct = { fields: [], note: `Could not read row struct header: ${err.message}` };
    }
  }

  return {
    path: filePath,
    rowKeyHeader,
    headers: columnHeaders,
    rowCount: rows.length,
    rows,
    ...(rowStruct ? { rowStruct } : {}),
  };
}

/**
 * read_string_table_source — Parse a StringTable source CSV.
 *
 * Expected columns: Key, SourceString (required); Comment (optional).
 * Namespace is usually set at the asset level; returned if a Namespace
 * column exists.
 */
async function readStringTableSource(projectRoot, filePath) {
  const full = resolveSafePath(projectRoot, filePath);
  if (!full.toLowerCase().endsWith('.csv')) {
    throw new Error('read_string_table_source requires a .csv file');
  }
  const text = await readFile(full, 'utf-8');
  const parsed = parseCsv(text);
  if (parsed.length === 0) {
    return { path: filePath, entryCount: 0, entries: [] };
  }
  const headers = parsed[0].map(h => h.trim());
  const idx = (name) => headers.findIndex(h => h.toLowerCase() === name.toLowerCase());
  const keyIdx = idx('Key');
  const valueIdx = idx('SourceString');
  const commentIdx = idx('Comment');
  const namespaceIdx = idx('Namespace');

  if (keyIdx === -1 || valueIdx === -1) {
    return {
      path: filePath,
      entryCount: 0,
      entries: [],
      warning: `StringTable CSV missing required columns. Found headers: [${headers.join(', ')}]. Expected: Key, SourceString`,
    };
  }

  const entries = [];
  let namespace;
  for (let i = 1; i < parsed.length; i++) {
    const r = parsed[i];
    if (r.length === 1 && r[0] === '') continue;
    const entry = {
      key: r[keyIdx] ?? '',
      sourceString: r[valueIdx] ?? '',
    };
    if (commentIdx !== -1 && r[commentIdx]) entry.comment = r[commentIdx];
    if (namespaceIdx !== -1 && r[namespaceIdx]) {
      entry.namespace = r[namespaceIdx];
      if (!namespace) namespace = r[namespaceIdx];
    }
    entries.push(entry);
  }

  return {
    path: filePath,
    ...(namespace ? { namespace } : {}),
    entryCount: entries.length,
    entries,
  };
}

/**
 * list_plugins — List installed plugins with enabled/disabled status
 */
async function listPlugins(projectRoot) {
  const data = await readUProject(projectRoot);
  const plugins = (data.Plugins || []).map(p => ({
    name: p.Name,
    enabled: p.Enabled !== false,
    ...(p.MarketplaceURL && { marketplaceURL: p.MarketplaceURL }),
    ...(p.SupportedTargetPlatforms && { platforms: p.SupportedTargetPlatforms }),
  }));

  const pluginsDir = join(projectRoot, 'Plugins');
  let localPlugins = [];
  try {
    const items = await readdir(pluginsDir, { withFileTypes: true });
    for (const item of items) {
      if (item.isDirectory()) {
        try {
          const subItems = await readdir(join(pluginsDir, item.name));
          const uplugin = subItems.find(f => f.endsWith('.uplugin'));
          if (uplugin) {
            const raw = await readFile(join(pluginsDir, item.name, uplugin), 'utf-8');
            const pluginData = JSON.parse(raw.replace(/,\s*([\]}])/g, '$1'));
            localPlugins.push({
              name: item.name,
              friendlyName: pluginData.FriendlyName || item.name,
              version: pluginData.VersionName || pluginData.Version || 'unknown',
              description: pluginData.Description || '',
              category: pluginData.Category || '',
              local: true,
            });
          }
        } catch { /* skip unreadable plugin dirs */ }
      }
    }
  } catch { /* no Plugins directory */ }

  return { projectPlugins: plugins, localPlugins };
}

/**
 * get_build_config — Parse .Build.cs, .Target.cs
 */
async function getBuildConfig(projectRoot) {
  const sourceDir = join(projectRoot, 'Source');
  const results = {};

  async function findFiles(dir, pattern) {
    const found = [];
    try {
      const items = await readdir(dir, { withFileTypes: true });
      for (const item of items) {
        if (item.isDirectory()) {
          found.push(...await findFiles(join(dir, item.name), pattern));
        } else if (item.name.match(pattern)) {
          found.push(join(dir, item.name));
        }
      }
    } catch { /* skip */ }
    return found;
  }

  const buildFiles = await findFiles(sourceDir, /\.Build\.cs$/);
  for (const f of buildFiles) {
    const content = await readFile(f, 'utf-8');
    const relPath = relative(projectRoot, f).replace(/\\/g, '/');

    const publicDeps = [];
    const privateDeps = [];
    const depRegex = /(?:Public|Private)DependencyModuleNames\.AddRange\(new string\[\]\s*\{([^}]+)\}/g;
    let match;
    while ((match = depRegex.exec(content)) !== null) {
      const deps = match[1].match(/"([^"]+)"/g)?.map(d => d.replace(/"/g, '')) || [];
      if (match[0].startsWith('Public')) publicDeps.push(...deps);
      else privateDeps.push(...deps);
    }

    results[relPath] = { publicDeps, privateDeps };
  }

  const targetFiles = await findFiles(sourceDir, /\.Target\.cs$/);
  for (const f of targetFiles) {
    const content = await readFile(f, 'utf-8');
    const relPath = relative(projectRoot, f).replace(/\\/g, '/');

    const typeMatch = content.match(/Type\s*=\s*TargetType\.(\w+)/);
    results[relPath] = {
      targetType: typeMatch ? typeMatch[1] : 'unknown',
    };
  }

  return results;
}

// ── Export handler map ──────────────────────────────────────

/**
 * Execute an offline tool by name.
 * @param {string} toolName
 * @param {object} params
 * @param {string} projectRoot
 * @returns {Promise<object>}
 */

// ── Export-table-aware pointed queries (re-parse, not cached) ────────
//
// parseAssetHeader caches summary+names+AR but not the export/import
// tables (D36 decision — they're big and only needed by pointed lookups).
// Both tools below re-read the file and parse the tables fresh. The AR
// portion is served from the cache via parseAssetHeader.

async function parseAssetTables(diskPath) {
  const buf = await readFile(diskPath);
  const cur = new Cursor(buf);
  const summary = parseSummary(cur);
  const names = readNameTable(cur, summary);
  const imports = readImportTable(cur, summary, names);
  const exports = readExportTable(cur, summary, names);
  return { summary, names, imports, exports };
}

/**
 * Classes that identify an asset as a Blueprint subclass whose CDO name
 * follows the `Default__<AssetName>_C` convention. Includes GAS as a
 * defensive add (Agent 9 §4 Q4) even though ProjectA compiles GAS as plain
 * BlueprintGeneratedClass today.
 */
const BP_GENERATED_CLASSES = new Set([
  'BlueprintGeneratedClass',
  'WidgetBlueprintGeneratedClass',
  'AnimBlueprintGeneratedClass',
  'GameplayAbilityBlueprintGeneratedClass',
]);

/**
 * Recursively remove `packageIndex` fields from response objects. The raw
 * FPackageIndex integer leaks parser-internal resolution detail that callers
 * don't need — resolved objectName/packagePath/kind are the public surface.
 * Arrays and plain objects only; skips primitives, null, and non-plain
 * objects (Date, Map, etc.) defensively.
 *
 * Reason-code catalog for `unsupported[]` markers surfaced by the Level 1+2+2.5
 * parser pipeline:
 *   - `unknown_struct`            — struct name not in the engine registry
 *                                   (falls back to tagged self-describing decode)
 *   - `complex_element_container` — TArray/TSet of custom struct elements
 *   - `container_deferred`        — TMap with non-scalar key/value types
 *   - `size_budget_exceeded`      — property value skipped to honor max_bytes
 *   - `unknown_property_type`     — FPropertyTag type outside the supported set
 *   - `unexpected_preamble`       — export body begins with a non-zero byte
 *                                   (non-CDO subclass exports, AssetImportData, etc.)
 *   - `serial_range_out_of_bounds`— declared export serial range exceeds buffer
 *   - `delegate_not_serialized`   — FDelegateProperty / FMulticastDelegateProperty
 *                                   (rarely fires: CDOs don't serialize delegate bindings)
 *   - `localized_text`            — FText with localization tables
 *   - `no_cdo_export_found`       — include_defaults=true but CDO export missing
 */
function stripPackageIndex(value) {
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
 * Dedupe an `unsupported[]` marker array by `{name, reason}` tuple,
 * order-stable (first occurrence wins). Parser iteration can revisit the
 * same property when array-index siblings serialize alongside the main entry.
 */
function dedupeUnsupported(arr) {
  if (!Array.isArray(arr) || arr.length < 2) return arr;
  const seen = new Set();
  const out = [];
  for (const m of arr) {
    const key = `${m?.name ?? ''}::${m?.reason ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(m);
  }
  return out;
}

/**
 * Parse an asset's header + tables and return a shared context for property
 * reading. Consumes the file once; all struct/container dispatch reuses
 * the same buffer and name table.
 */
async function parseAssetForPropertyRead(projectRoot, assetPath) {
  const diskPath = resolveAssetDiskPath(projectRoot, assetPath);
  const stats = await stat(diskPath);
  const buf = await readFile(diskPath);
  const cur = new Cursor(buf);
  const summary = parseSummary(cur);
  const names = readNameTable(cur, summary);
  const imports = readImportTable(cur, summary, names);
  const exports = readExportTable(cur, summary, names);
  return {
    diskPath, stats, buf, summary, names, imports, exports,
    resolve: makePackageIndexResolver(exports, imports),
    structHandlers: buildStructHandlers(),
    containerHandlers: buildContainerHandlers(),
  };
}

/**
 * inspect_blueprint — Deep introspection of a .uasset (BP, UMG, AnimBP, DataAsset).
 *
 * Returns full export table with resolved class/super/outer names, parent class,
 * and generated class. With include_defaults=true, also returns CDO UPROPERTY
 * values via Level 1+2+2.5 parser dispatch.
 *
 * @param {string} projectRoot
 * @param {object} params - { asset_path: string, include_defaults?: boolean }
 */
async function inspectBlueprint(projectRoot, params) {
  const assetPath = params.asset_path;
  const includeDefaults = params.include_defaults ?? false;
  const ctx = await parseAssetForPropertyRead(projectRoot, assetPath);
  const header = await parseAssetHeader(projectRoot, assetPath);
  const { diskPath, stats, buf, exports, imports, names, resolve, structHandlers, containerHandlers } = ctx;
  const primary = header.data.assetRegistry.objects[0] || null;

  const exportRows = exports.map((e, i) => ({
    index: i + 1, // FPackageIndex (positive = export N-1)
    objectName: e.objectName,
    className: resolvePackageIndex(e.classIndex, exports, imports, 'objectName'),
    classPackage: e.classIndex < 0
      ? (imports[-e.classIndex - 1]?.classPackage ?? null)
      : null,
    superClass: resolvePackageIndex(e.superIndex, exports, imports, 'objectName'),
    outerName: resolvePackageIndex(e.outerIndex, exports, imports, 'objectName'),
    bIsAsset: e.bIsAsset,
    serialSize: e.serialSize,
  }));

  const generated = exportRows.find(r => BP_GENERATED_CLASSES.has(r.className));
  const parentClass = generated ? generated.superClass : null;

  const result = {
    path: assetPath,
    diskPath: diskPath.replace(/\\/g, '/'),
    sizeBytes: stats.size,
    modified: stats.mtime.toISOString(),
    objectClassName: primary ? primary.objectClassName : null,
    objectPath: primary ? primary.objectPath : null,
    parentClass,
    generatedClass: generated ? generated.objectName : null,
    exportCount: exports.length,
    importCount: imports.length,
    exports: exportRows,
  };

  if (includeDefaults) {
    const cdoName = generated ? `Default__${generated.objectName}` : null;
    const cdoExport = cdoName ? exports.find(e => e.objectName === cdoName) : null;
    if (!cdoExport) {
      result.cdo_export_name = null;
      result.variable_defaults = {};
      result.unsupported_defaults = [{ name: '__cdo__', reason: 'no_cdo_export_found' }];
    } else {
      const r = readExportProperties(buf, cdoExport, names, { resolve, structHandlers, containerHandlers });
      result.cdo_export_name = cdoName;
      result.variable_defaults = stripPackageIndex(r.properties);
      result.unsupported_defaults = dedupeUnsupported(r.unsupported);
    }
  }
  return stripPackageIndex(result);
}

/**
 * Determine if an export is a placed actor in the level.
 * Placed actors have outerIndex resolving to PersistentLevel or Level.
 * Also includes WorldSettings (always one per level).
 * Excludes component subobjects, editor metadata, and BP machinery.
 *
 * @param {object} exportEntry - FObjectExport
 * @param {Array} exports - Full export table
 * @param {Array} imports - Full import table
 * @returns {boolean}
 */
function isPlacedActor(exportEntry, exports, imports) {
  const className = resolvePackageIndex(exportEntry.classIndex, exports, imports, 'objectName');
  const outerName = resolvePackageIndex(exportEntry.outerIndex, exports, imports, 'objectName');

  // WorldSettings is always a placed actor
  if (className === 'WorldSettings') return true;

  // Exclude editor-only data, metadata, and BP machinery
  const excludeClasses = [
    'Function', 'K2Node_', 'EdGraph', 'BlueprintGeneratedClass',
    'Texture2D', 'MaterialInstance', 'BodySetup', 'Model', 'Polys',
    'LandscapeTextureHash', 'BookMarks', 'AssetImportData', 'EditorOnlyData'
  ];
  for (const excl of excludeClasses) {
    if (className && className.includes(excl)) return false;
  }

  // Placed actors have outer = PersistentLevel or Level
  return outerName && (outerName.includes('PersistentLevel') || outerName === 'Level');
}

// Component names we preferentially pick as the "root" when an actor has
// multiple children. Order matches UE's default SceneComponent naming for
// common actor subclasses.
const KNOWN_ROOT_COMPONENT_NAMES = new Set([
  'DefaultSceneRoot', 'CollisionCylinder', 'CollisionCapsule', 'CollisionBox',
  'CapsuleComponent', 'StaticMeshComponent0', 'SkeletalMeshComponent0',
  'LightComponent0', 'RootComponent',
]);

// Editor-only auxiliary components we'd rather skip when selecting a root —
// they carry transform overrides only in rare cases, but they're not the
// actor's spatial root.
const AUX_COMPONENT_CLASS_PATTERNS = [
  /^ArrowComponent$/, /^BillboardComponent$/, /^BillBoardComponent$/,
  /^TextRenderComponent$/,
];

/**
 * Given a placed actor export at position `i` (0-based), find its root
 * component export by outerIndex reverse scan. Returns the root component's
 * export row, or null if no children resolve.
 *
 * V9.5 correction #1: only ~10% of placed actors serialize a RootComponent
 * ObjectProperty; the dominant path is outerIndex reverse lookup.
 */
function findRootComponentExport(actorIdx, exports, imports) {
  const actorPackageIndex = actorIdx + 1;  // 1-based FPackageIndex
  const children = exports.filter(c => c.outerIndex === actorPackageIndex);
  if (children.length === 0) return null;
  // Preference 1: known root-component name match.
  const byName = children.find(c => KNOWN_ROOT_COMPONENT_NAMES.has(c.objectName));
  if (byName) return byName;
  // Preference 2: non-auxiliary component (strip ArrowComponent/Billboard/etc).
  const nonAux = children.filter(c => {
    const cls = resolvePackageIndex(c.classIndex, exports, imports, 'objectName');
    if (!cls) return true;
    return !AUX_COMPONENT_CLASS_PATTERNS.some(p => p.test(cls));
  });
  if (nonAux.length === 1) return nonAux[0];
  if (nonAux.length > 1) return nonAux[0];
  // Fall back to the first child.
  return children[0];
}

/**
 * Read RelativeLocation/RelativeRotation/RelativeScale3D from a component
 * export. Returns a transform object or null if all three are at class default.
 */
function readComponentTransform(buf, compExport, names, ctx) {
  const r = readExportProperties(buf, compExport, names, ctx);
  const loc = r.properties.RelativeLocation;
  const rot = r.properties.RelativeRotation;
  const scl = r.properties.RelativeScale3D;
  // When ALL three are missing the actor is at class default — return null per
  // V9.5 correction #3 (sparse transforms are intended behaviour, not errors).
  if (!loc && !rot && !scl) return null;
  return {
    location: loc ? [loc.x, loc.y, loc.z] : null,
    rotation: rot ? [rot.pitch, rot.yaw, rot.roll] : null,
    scale:    scl ? [scl.x, scl.y, scl.z] : null,
  };
}

/**
 * list_level_actors — Enumerate placed actors in a .umap with transforms.
 *
 * Transforms are resolved via outerIndex reverse scan (V9.5 #1): for each
 * placed actor, scan the export table for entries whose outerIndex points
 * back to the actor, pick the root component among those children, and read
 * its RelativeLocation/Rotation/Scale3D properties. Actors at class default
 * (no transform override serialized) return `transform: null` — this is the
 * expected behaviour for ~50-60% of real map actors, not an error.
 *
 * Pagination (limit/offset) keeps dense maps (Bridges2 has 2,519 actors,
 * 346 KB unpaginated) callable within MCP response caps. The
 * summarize_by_class mode returns just `{className: count}` for the cheap
 * orientation case.
 */
async function listLevelActors(projectRoot, params) {
  const assetPath = params.asset_path;
  const summarizeByClass = params.summarize_by_class ?? false;
  const rawLimit = params.limit ?? 100;
  const limit = Math.max(1, Math.min(rawLimit, 500));
  const offset = Math.max(0, params.offset ?? 0);

  // Levels live in .umap — resolve without-extension paths to .umap.
  const mapPath = assetPath.endsWith('.umap') || assetPath.endsWith('.uasset')
    ? assetPath : assetPath + '.umap';
  const ctx = await parseAssetForPropertyRead(projectRoot, mapPath);
  const { diskPath, stats, buf, names, imports, exports, resolve, structHandlers, containerHandlers } = ctx;

  // Collect placed actors with their original export index for outerIndex lookup.
  const placed = [];
  for (let i = 0; i < exports.length; i++) {
    const e = exports[i];
    if (isPlacedActor(e, exports, imports)) placed.push({ index: i, entry: e });
  }

  const summary = {};
  for (const { entry } of placed) {
    const cls = resolvePackageIndex(entry.classIndex, exports, imports, 'objectName') ?? '<unknown>';
    summary[cls] = (summary[cls] || 0) + 1;
  }

  // Base fields common to both modes — P7: deterministic insertion order.
  const baseResponse = {
    path: assetPath,
    diskPath: diskPath.replace(/\\/g, '/'),
    sizeBytes: stats.size,
    modified: stats.mtime.toISOString(),
    exportCount: exports.length,
    importCount: imports.length,
    total_placed_actors: placed.length,
  };

  // Summary mode — P1: pagination fields omitted (they don't apply to a dict).
  if (summarizeByClass) {
    return { ...baseResponse, truncated: false, summary };
  }

  const page = placed.slice(offset, offset + limit);
  const actors = page.map(({ index, entry }) => {
    // P7: fixed key ordering — name, className, classPackage, outer, bIsAsset,
    // transform, (unsupported if present). `transform` is always present with
    // null as the class-default sentinel; `unsupported` only appears on error.
    const row = {
      name: entry.objectName,
      className: resolvePackageIndex(entry.classIndex, exports, imports, 'objectName'),
      classPackage: entry.classIndex < 0
        ? (imports[-entry.classIndex - 1]?.classPackage ?? null)
        : null,
      outer: resolvePackageIndex(entry.outerIndex, exports, imports, 'objectName'),
      bIsAsset: entry.bIsAsset,
      transform: null,
    };
    const root = findRootComponentExport(index, exports, imports);
    if (root) {
      try {
        row.transform = readComponentTransform(buf, root, names,
          { resolve, structHandlers, containerHandlers });
      } catch (err) {
        row.unsupported = [{ name: 'transform', reason: 'root_component_parse_failed' }];
      }
    }
    return row;
  });

  return stripPackageIndex({
    ...baseResponse,
    offset,
    limit,
    truncated: offset + limit < placed.length,
    actors,
  });
}

/**
 * read_asset_properties — Read serialized UPROPERTY values from a specific
 * export in a .uasset/.umap.
 *
 * Default export:
 *   - For assets whose primary class is a BlueprintGeneratedClass
 *     subclass, pick the `Default__<Name>_C` CDO export.
 *   - Otherwise, the first export with bIsAsset=true, falling back to
 *     the main export at index 0.
 *
 * property_names filter runs AFTER full-stream parse — the stream has to
 * be walked sequentially (FPropertyTag sizes are declared inline), so
 * the filter trims output without changing parse cost.
 */
async function readAssetProperties(projectRoot, params) {
  const assetPath = params.asset_path;
  const requestedExportName = params.export_name || null;
  const filterNames = Array.isArray(params.property_names) && params.property_names.length
    ? new Set(params.property_names) : null;
  const maxBytes = params.max_bytes ?? 65_536;

  const ctx = await parseAssetForPropertyRead(projectRoot, assetPath);
  const { diskPath, buf, names, exports, imports, resolve, structHandlers, containerHandlers } = ctx;

  // Pick the target export.
  let target = null;
  let exportIndex = -1;
  if (requestedExportName) {
    exportIndex = exports.findIndex(e => e.objectName === requestedExportName);
    if (exportIndex < 0) {
      throw new Error(`Export not found: ${requestedExportName}`);
    }
    target = exports[exportIndex];
  } else {
    // Auto-default: prefer Default__<generatedClass> for BP-subclass assets.
    const generated = exports.find(e => {
      const cls = resolvePackageIndex(e.classIndex, exports, imports, 'objectName');
      return cls && BP_GENERATED_CLASSES.has(cls);
    });
    if (generated) {
      const cdoName = `Default__${generated.objectName}`;
      exportIndex = exports.findIndex(e => e.objectName === cdoName);
      if (exportIndex >= 0) target = exports[exportIndex];
    }
    if (!target) {
      // Fall back to main bIsAsset export.
      exportIndex = exports.findIndex(e => e.bIsAsset);
      if (exportIndex < 0) { exportIndex = 0; }
      target = exports[exportIndex];
    }
  }

  if (!target) throw new Error('No exports found in asset');

  const structType = resolvePackageIndex(target.classIndex, exports, imports, 'objectName');
  const parsed = readExportProperties(buf, target, names,
    { resolve, structHandlers, containerHandlers, maxBytes });

  let properties = parsed.properties;
  let propertyCountReturned = parsed.propertyCount;
  let unsupported = parsed.unsupported;
  if (filterNames) {
    properties = {};
    for (const name of Object.keys(parsed.properties)) {
      if (filterNames.has(name)) properties[name] = parsed.properties[name];
    }
    propertyCountReturned = Object.keys(properties).length;
    // P2: when a filter is active, scope unsupported[] to the requested names
    // so callers asking about "A, B" don't see markers for unrelated "C, D".
    // __stream__ markers (e.g., unexpected_preamble) pass through since they
    // describe the whole stream, not a specific property.
    unsupported = unsupported.filter(m =>
      filterNames.has(m.name) || m.name === '__stream__'
    );
  }

  // P7: deterministic top-level key ordering (path info → target → payload →
  // counts → truncation). P4: dedupe unsupported[] by {name, reason}.
  return stripPackageIndex({
    path: assetPath,
    diskPath: diskPath.replace(/\\/g, '/'),
    export_name: target.objectName,
    export_index: exportIndex + 1,
    struct_type: structType,
    properties,
    unsupported: dedupeUnsupported(unsupported),
    property_count_returned: propertyCountReturned,
    property_count_total: parsed.propertyCount,
    truncated: parsed.truncated,
  });
}

/**
 * find_blueprint_nodes — Agent 10.5 Tier 4 (D48 S-A skeletal surface).
 *
 * Walk K2Node exports in a Blueprint, extract semantic references from each
 * node's tagged-property stream, and apply class/member/target filters.
 * Covers 19 skeletal K2Node classes (17 non-delegate + 2 delegate-presence).
 * Does NOT trace exec chains — pin edges aren't parseable from offline bytes
 * and live in the 3F sidecar.
 *
 * Semantic field extraction reuses the tier-3 tagged-property fallback —
 * FMemberReference / FGraphReference / FUserPinInfo all decode through
 * readExportProperties without special handler registration.
 */
const SKELETAL_K2NODE_CLASSES = new Set([
  // Entry / event
  'K2Node_Event', 'K2Node_CustomEvent',
  'K2Node_FunctionEntry', 'K2Node_FunctionResult',
  // Variable access
  'K2Node_VariableGet', 'K2Node_VariableSet',
  // Function call
  'K2Node_CallFunction', 'K2Node_CallParentFunction',
  // Control flow
  'K2Node_IfThenElse', 'K2Node_ExecutionSequence',
  'K2Node_SwitchEnum', 'K2Node_SwitchString', 'K2Node_SwitchInteger',
  'K2Node_DynamicCast', 'K2Node_MacroInstance',
  // Literal / passthrough
  'K2Node_Self', 'K2Node_Knot',
  // Delegate — class identity only, no payload
  'K2Node_AddDelegate', 'K2Node_AssignDelegate',
]);

function extractNodeSemantics(nodeClass, props) {
  // Shared helpers — safe-read nested struct fields.
  const mr = (key) => (props?.[key] && typeof props[key] === 'object' && !Array.isArray(props[key]))
    ? props[key] : null;
  const resolveObjectName = (v) => {
    if (!v || typeof v !== 'object') return null;
    return v.packagePath || v.objectName || null;
  };

  const out = {};
  switch (nodeClass) {
    case 'K2Node_Event': {
      const ref = mr('EventReference');
      if (ref) {
        out.member_name = ref.MemberName ?? null;
        out.target_class = resolveObjectName(ref.MemberParent);
      }
      break;
    }
    case 'K2Node_CustomEvent': {
      out.member_name = props?.CustomFunctionName ?? null;
      break;
    }
    case 'K2Node_FunctionEntry':
    case 'K2Node_FunctionResult': {
      const ref = mr('FunctionReference');
      if (ref) out.member_name = ref.MemberName ?? null;
      break;
    }
    case 'K2Node_VariableGet':
    case 'K2Node_VariableSet': {
      const ref = mr('VariableReference');
      if (ref) {
        out.member_name = ref.MemberName ?? null;
        out.target_class = resolveObjectName(ref.MemberParent);
        if (ref.bSelfContext === true) out.extras = { ...(out.extras ?? {}), self_context: true };
      }
      break;
    }
    case 'K2Node_CallFunction':
    case 'K2Node_CallParentFunction': {
      const ref = mr('FunctionReference');
      if (ref) {
        out.member_name = ref.MemberName ?? null;
        out.target_class = resolveObjectName(ref.MemberParent);
        if (ref.bSelfContext === true) out.extras = { ...(out.extras ?? {}), self_context: true };
      }
      break;
    }
    case 'K2Node_SwitchEnum': {
      const enumRef = props?.Enum;
      if (enumRef && typeof enumRef === 'object') {
        out.target_class = resolveObjectName(enumRef);
      }
      break;
    }
    case 'K2Node_DynamicCast': {
      const tt = props?.TargetType;
      if (tt && typeof tt === 'object') {
        out.target_class = resolveObjectName(tt);
      }
      break;
    }
    case 'K2Node_MacroInstance': {
      const ref = mr('MacroGraphReference');
      if (ref) {
        out.macro_path = resolveObjectName(ref.MacroGraph);
        out.graph_name = ref.GraphName ?? null;
      }
      break;
    }
    // K2Node_IfThenElse, ExecutionSequence, SwitchString, SwitchInteger,
    // Self, Knot, AddDelegate, AssignDelegate: class identity only.
    default:
      break;
  }
  return out;
}

async function findBlueprintNodes(projectRoot, params) {
  const assetPath = params.asset_path;
  const filterClass = params.node_class || null;
  const filterMember = params.member_name || null;
  const filterTarget = params.target_class || null;
  const limit = Math.max(1, Math.min(params.limit ?? 100, 1000));
  const offset = Math.max(0, params.offset ?? 0);

  const ctx = await parseAssetForPropertyRead(projectRoot, assetPath);
  const { diskPath, buf, names, exports, imports, resolve, structHandlers, containerHandlers } = ctx;
  const header = await parseAssetHeader(projectRoot, assetPath);
  const primary = header.data.assetRegistry.objects[0] || null;

  const matched = [];
  let totalSkeletal = 0;
  const nonSkeletalCounts = new Map();

  for (let i = 0; i < exports.length; i++) {
    const e = exports[i];
    const cls = resolvePackageIndex(e.classIndex, exports, imports, 'objectName');
    if (!cls) continue;
    if (!cls.startsWith('K2Node_')) continue;
    if (!SKELETAL_K2NODE_CLASSES.has(cls)) {
      nonSkeletalCounts.set(cls, (nonSkeletalCounts.get(cls) ?? 0) + 1);
      continue;
    }
    totalSkeletal += 1;
    if (filterClass && cls !== filterClass) continue;

    // Parse the node's tagged properties to extract FMemberReference / etc.
    let nodeProps;
    try {
      nodeProps = readExportProperties(buf, e, names,
        { resolve, structHandlers, containerHandlers });
    } catch {
      nodeProps = { properties: {} };
    }
    const semantics = extractNodeSemantics(cls, nodeProps.properties);

    if (filterMember && semantics.member_name !== filterMember) continue;
    if (filterTarget) {
      const t = semantics.target_class;
      if (!t || (t !== filterTarget && !t.endsWith(filterTarget))) continue;
    }

    matched.push({
      node_class: cls,
      member_name: semantics.member_name ?? null,
      target_class: semantics.target_class ?? null,
      macro_path: semantics.macro_path ?? null,
      graph_name: semantics.graph_name ?? null,
      export_index: i + 1,
      node_name: e.objectName,
      extras: semantics.extras,
    });
  }

  const totalMatched = matched.length;
  const page = matched.slice(offset, offset + limit);
  const truncated = offset + limit < totalMatched;

  const nodesOutOfSkeletal = [...nonSkeletalCounts.entries()]
    .map(([node_class, count]) => ({ node_class, count }))
    .sort((a, b) => b.count - a.count);

  return {
    path: assetPath,
    diskPath: diskPath.replace(/\\/g, '/'),
    asset_name: primary ? (primary.objectPath || primary.objectClassName) : null,
    total_skeletal: totalSkeletal,
    total_matched: totalMatched,
    offset,
    limit,
    truncated,
    nodes: page,
    nodes_out_of_skeletal: nodesOutOfSkeletal,
  };
}

/**
 * find_blueprint_nodes_bulk — Corpus-wide K2Node scan under a path_prefix.
 *
 * Closes SERVED_PARTIAL Workflow Catalog rows 26/27/28/42/62/63 by folding
 * N-round-trip "which BPs call X / handle Y / access Z" iteration into a
 * single call. Walks queryAssetRegistry for Blueprint assets under the
 * prefix, reuses findBlueprintNodes per result, aggregates match counts.
 *
 * Semantics inherited from findBlueprintNodes:
 *   - node_class / member_name / target_class filter with identical rules
 *     (target_class does suffix match).
 *   - Single-BP total_matched becomes per-BP match_count.
 *
 * Pagination is two-level:
 *   - max_scan  — caps how many .uasset files walked on disk (registry level).
 *   - limit/offset — slice matched-BP results[] after filtering.
 *
 * Per-BP parse errors are swallowed into errors[] (a single corrupt asset
 * shouldn't poison a corpus scan). Only BPs with match_count > 0 enter
 * results[] — the "how many BPs match?" question stays compact.
 */
async function findBlueprintNodesBulk(projectRoot, params) {
  const pathPrefix = params.path_prefix;
  if (!pathPrefix) throw new Error('Missing required parameter: path_prefix');
  if (!pathPrefix.startsWith('/Game/')) {
    throw new Error(`path_prefix must start with /Game/ (got: ${pathPrefix})`);
  }

  const filter = {
    node_class: params.node_class || null,
    member_name: params.member_name || null,
    target_class: params.target_class || null,
  };
  const limit = Math.max(1, Math.min(params.limit ?? 50, 200));
  const offset = Math.max(0, params.offset ?? 0);
  const maxScan = Math.max(1, Math.min(params.max_scan ?? 500, 5000));
  const includeNodes = params.include_nodes ?? false;

  // max_scan is a Blueprint-count cap (the param name's plain reading). We
  // always walk the full prefix subtree at the registry layer — Content/
  // trees commonly contain 10-40x more non-BP assets than BPs, so capping
  // the file-walk would silently truncate to a tiny BP count on large
  // projects. Instead: walk wide, cap narrow at the BP level.
  const registry = await queryAssetRegistry(projectRoot, {
    class_name: 'Blueprint',
    path_prefix: pathPrefix,
    limit: 2000,
    max_scan: 20000,
  });

  const allBpPaths = registry.results.map(r => r.path);
  const bpPaths = allBpPaths.slice(0, maxScan);
  // scan_truncated: the matched-BP set we're about to process is incomplete.
  // Causes: queryAssetRegistry paginated off >2000 BPs, its file-walk hit
  // 20000, or our max_scan BP cap clipped results. Distinct from
  // page_truncated (pagination over the filtered set).
  const scanTruncated = registry.truncated || allBpPaths.length > maxScan;

  const perBp = [];
  const errors = [];

  for (const bpPath of bpPaths) {
    try {
      // Invoke the single-BP handler with a high internal limit so we
      // capture all matches (we aggregate the count, then page at bulk
      // level). 10000 comfortably exceeds any real BP's skeletal count.
      const single = await findBlueprintNodes(projectRoot, {
        asset_path: bpPath,
        node_class: filter.node_class,
        member_name: filter.member_name,
        target_class: filter.target_class,
        limit: 10000,
        offset: 0,
      });
      if (single.total_matched === 0) continue;

      const row = { path: bpPath, match_count: single.total_matched };
      if (includeNodes) row.nodes = single.nodes;
      perBp.push(row);
    } catch (err) {
      errors.push({ path: bpPath, error: err.message });
    }
  }

  const totalBpsMatched = perBp.length;
  const pageResults = perBp.slice(offset, offset + limit);
  const pageTruncated = totalBpsMatched > offset + limit;

  const out = {
    path_prefix: pathPrefix,
    filter,
    total_bps_scanned: bpPaths.length,
    total_bps_matched: totalBpsMatched,
    scan_truncated: scanTruncated,
    page_truncated: pageTruncated,
    offset,
    limit,
    results: pageResults,
  };
  if (errors.length) out.errors = errors;
  return out;
}

// ── M-spatial: BP traversal verbs (offline-primary, no plugin/TCP/sidecar) ──
//
// Five verbs built on the existing L1+L2+L2.5 parser surface. No new binary
// parsing: the tagged-fallback path already decodes spatial UPROPERTYs
// (NodePosX/Y, NodeWidth/Height, NodeComment, EnabledState, CommentColor,
// bCommentBubble*) on K2Node and UEdGraphNode_Comment exports.
//
// FA-β contract: every verb returns {available_fields[], not_available[],
// schema_version, plugin_enhancement_available}. Partial verbs (bp_show_node,
// bp_list_entry_points) enumerate what the offline-only implementation
// cannot deliver — callers route to M-new when pin-aware data is required.
//
// FA-δ invariant: these verbs produce non-empty correct data on real BPs
// with no sidecar/plugin/editor present (proven in test-phase1.mjs).

const M_SPATIAL_SCHEMA_VERSION = 'm-spatial-v1';

const SPATIAL_AVAILABLE_FIELDS = [
  'positions',         // NodePosX/Y
  'node_size',         // NodeWidth/Height when serialized
  'comments',          // NodeComment + UEdGraphNode_Comment CommentColor/FontSize
  'contains',          // spatial rect containment for comment boxes
  'class_identity',    // K2Node/EdGraphNode_Comment class name
  'enabled_state',     // EnabledState enum when serialized
  'node_guid',         // FGuid NodeGuid
  'member_reference',  // FMemberReference — via existing skeletal surface
];

const ENTRY_POINT_CLASSES = new Set([
  'K2Node_Event',
  'K2Node_CustomEvent',
  'K2Node_FunctionEntry',
]);

// Canonical node name uses FName.Number suffix ("_0", "_1", ...) so duplicate
// base names (9 × EdGraphNode_Comment) disambiguate. Matches UE's display.
function canonicalNodeName(exportEntry) {
  if (!exportEntry) return null;
  const n = exportEntry.objectNameNumber;
  return n > 0 ? `${exportEntry.objectName}_${n - 1}` : exportEntry.objectName;
}

/**
 * Classify an EdGraph by its objectName. Heuristic — UE doesn't serialize
 * a type enum on UEdGraph; graph membership on the UBlueprint (UbergraphPages,
 * FunctionGraphs, etc.) is the canonical signal. We rely on naming conventions
 * instead of parsing the UBlueprint's TArray<ObjectProperty> refs to keep the
 * v1 surface simple; `unknown` is the fallback when no heuristic matches.
 */
function classifyGraph(name) {
  if (name === 'EventGraph' || name.startsWith('Ubergraph')) return 'ubergraph';
  if (name === 'UserConstructionScript' || name === 'ConstructionScript') return 'construction_script';
  if (name.endsWith('_DelegateSignature')) return 'delegate_signature';
  if (name.startsWith('Macro_') || name.endsWith('_Macro')) return 'macro';
  if (name === 'Timeline' || name.endsWith('_Timeline')) return 'timeline';
  return 'function';
}

/**
 * Walk the export table and bucket K2Node / EdGraphNode_Comment exports by
 * their containing EdGraph. Returns { graphs, nodesByGraph, commentsByGraph }
 * keyed by the graph's 1-based FPackageIndex. `ubpIndex` is the UBlueprint's
 * export index — graphs whose outerIndex resolves to it are considered
 * belonging to this BP.
 */
function indexBlueprintGraphs(ctx) {
  const { exports, imports } = ctx;

  // Find the UBlueprint export — identified by className === 'Blueprint'.
  const ubpIdx = exports.findIndex(e =>
    resolvePackageIndex(e.classIndex, exports, imports, 'objectName') === 'Blueprint');
  const ubpPackageIndex = ubpIdx >= 0 ? ubpIdx + 1 : null;

  // Build the EdGraph set (exports with className === 'EdGraph').
  const graphByPackageIndex = new Map();
  const graphs = [];
  for (let i = 0; i < exports.length; i++) {
    const e = exports[i];
    const cls = resolvePackageIndex(e.classIndex, exports, imports, 'objectName');
    if (cls !== 'EdGraph') continue;
    if (ubpPackageIndex !== null && e.outerIndex !== ubpPackageIndex) continue;
    const graphPi = i + 1;
    const rec = {
      name: e.objectName,
      graph_type: classifyGraph(e.objectName),
      export_index: graphPi,
      node_count: 0,
      comment_count: 0,
      _nodes: [],
      _comments: [],
    };
    graphByPackageIndex.set(graphPi, rec);
    graphs.push(rec);
  }

  // Bucket K2Node / EdGraphNode_Comment exports under their outer graph.
  for (let i = 0; i < exports.length; i++) {
    const e = exports[i];
    const cls = resolvePackageIndex(e.classIndex, exports, imports, 'objectName');
    if (!cls) continue;
    const isK2Node = cls.startsWith('K2Node_');
    const isComment = cls === 'EdGraphNode_Comment';
    if (!isK2Node && !isComment) continue;
    const rec = graphByPackageIndex.get(e.outerIndex);
    if (!rec) continue;
    const row = { export_index: i + 1, export: e, className: cls };
    if (isComment) {
      rec._comments.push(row);
      rec.comment_count += 1;
    } else {
      rec._nodes.push(row);
      rec.node_count += 1;
    }
  }

  return { graphs, ubpPackageIndex };
}

/**
 * Pick the spatial sub-shape from a parsed node's properties. Missing fields
 * are omitted (not null) so response payloads stay compact for nodes that
 * inherit defaults — NodePosX/Y are usually present; NodeWidth/Height are
 * only serialized on EdGraphNode_Comment and the rare sized K2Node.
 */
function extractSpatial(props) {
  const out = {};
  // Positions default to 0 when not serialized (UE omits class defaults).
  // Callers treat missing positions as "at origin" — always present for
  // consistent downstream containment math.
  out.node_pos_x = typeof props.NodePosX === 'number' ? props.NodePosX : 0;
  out.node_pos_y = typeof props.NodePosY === 'number' ? props.NodePosY : 0;
  if (typeof props.NodeWidth === 'number') out.node_width = props.NodeWidth;
  if (typeof props.NodeHeight === 'number') out.node_height = props.NodeHeight;
  if (typeof props.NodeComment === 'string' && props.NodeComment.length > 0) {
    out.node_comment = props.NodeComment;
  }
  if (props.EnabledState !== undefined) out.enabled_state = props.EnabledState;
  if (typeof props.bCommentBubblePinned === 'boolean') out.comment_bubble_pinned = props.bCommentBubblePinned;
  if (typeof props.bCommentBubbleVisible === 'boolean') out.comment_bubble_visible = props.bCommentBubbleVisible;
  if (typeof props.NodeGuid === 'string') out.node_guid = props.NodeGuid;
  return out;
}

/**
 * Parse comment-specific UPROPERTYs from a UEdGraphNode_Comment node's
 * decoded property map. CommentColor decodes via FLinearColor handler.
 */
function extractCommentExtras(props) {
  const out = {};
  if (props.CommentColor && typeof props.CommentColor === 'object') {
    out.comment_color = props.CommentColor;
  }
  if (typeof props.FontSize === 'number') out.font_size = props.FontSize;
  if (typeof props.bColorCommentBubble === 'boolean') out.color_comment_bubble = props.bColorCommentBubble;
  if (typeof props.bCommentBubbleVisible_InDetailsPanel === 'boolean') {
    out.comment_bubble_visible_in_details_panel = props.bCommentBubbleVisible_InDetailsPanel;
  }
  return out;
}

/**
 * Compute which nodes are contained inside each comment box. Center-point
 * in rectangle — a node at (x,y) with half-extents (w/2,h/2) is contained
 * when its center (x + w/2, y + h/2) is strictly inside the comment's
 * (NodePosX, NodePosY) - (NodePosX + NodeWidth, NodePosY + NodeHeight)
 * rectangle. K2Nodes rarely serialize NodeWidth/Height — they're treated as
 * point nodes (w=h=0) for the containment check. Zero-size comment rects
 * return an empty list. Nested comments are reported pairwise; no hierarchy
 * is inferred.
 *
 * Complexity O(N*M). For BP_OSPlayerR (~184 K2Nodes × ~9 comments) this is
 * ~1700 float compares — microseconds.
 *
 * @param {Array<{node_id, node_pos_x, node_pos_y, node_width?, node_height?}>} nodes
 * @param {Array<{node_id, node_pos_x, node_pos_y, node_width, node_height}>} commentNodes
 * @returns {Map<number, Array<number>>} commentId → contained node_id list
 */
export function computeCommentContainment(nodes, commentNodes) {
  const out = new Map();
  for (const c of commentNodes) {
    const cx1 = c.node_pos_x ?? 0;
    const cy1 = c.node_pos_y ?? 0;
    const cw = c.node_width ?? 0;
    const ch = c.node_height ?? 0;
    if (cw <= 0 || ch <= 0) {
      out.set(c.node_id, []);
      continue;
    }
    const cx2 = cx1 + cw;
    const cy2 = cy1 + ch;
    const contained = [];
    for (const n of nodes) {
      if (n.node_id === c.node_id) continue;
      const nx = (n.node_pos_x ?? 0) + (n.node_width ?? 0) / 2;
      const ny = (n.node_pos_y ?? 0) + (n.node_height ?? 0) / 2;
      if (nx >= cx1 && nx <= cx2 && ny >= cy1 && ny <= cy2) {
        contained.push(n.node_id);
      }
    }
    out.set(c.node_id, contained);
  }
  return out;
}

function faBetaManifest(notAvailable = [], extraAvailable = []) {
  return {
    schema_version: M_SPATIAL_SCHEMA_VERSION,
    available_fields: [...SPATIAL_AVAILABLE_FIELDS, ...extraAvailable],
    not_available: notAvailable,
    plugin_enhancement_available: false,
  };
}

/**
 * bp_list_graphs — enumerate UEdGraph subobjects of a UBlueprint.
 */
async function bpListGraphs(projectRoot, params) {
  const assetPath = params.asset_path;
  const ctx = await parseAssetForPropertyRead(projectRoot, assetPath);
  const { diskPath } = ctx;
  const { graphs } = indexBlueprintGraphs(ctx);

  const graphRows = graphs
    .map(g => {
      // EN-8: per-graph comment_ids[] enumerates UEdGraphNode_Comment node_guids
      // (serialized class name is 'EdGraphNode_Comment' — no U prefix). Callers
      // use these to skip inspect_blueprint when locating comments before
      // bp_subgraph_in_comment. Empty array when the graph has no comments
      // (field is always present for shape stability). Parse cost is bounded:
      // BP_OSPlayerR has ~9 comments total, so this adds microseconds.
      const comment_ids = g._comments
        .map(c => parseNodeShape(ctx, c.export, c.export_index).row.node_guid)
        .filter(guid => typeof guid === 'string');
      return {
        name: g.name,
        graph_type: g.graph_type,
        node_count: g.node_count,
        comment_count: g.comment_count,
        comment_ids,
        export_index: g.export_index,
      };
    })
    .sort((a, b) => {
      // Deterministic ordering: type bucket then name.
      const typeOrder = ['ubergraph', 'construction_script', 'function', 'macro', 'delegate_signature', 'timeline', 'unknown'];
      const ai = typeOrder.indexOf(a.graph_type);
      const bi = typeOrder.indexOf(b.graph_type);
      if (ai !== bi) return ai - bi;
      return a.name.localeCompare(b.name);
    });

  return {
    asset_path: assetPath,
    diskPath: diskPath.replace(/\\/g, '/'),
    graph_count: graphRows.length,
    graphs: graphRows,
    ...faBetaManifest([]),
  };
}

/**
 * Parse a node's properties and assemble its base + spatial shape.
 * Shared by bp_find_in_graph, bp_subgraph_in_comment, bp_show_node,
 * bp_list_entry_points. Returns null if the node's serial range is invalid.
 */
function parseNodeShape(ctx, exportEntry, exportIndex) {
  const { buf, names, resolve, structHandlers, containerHandlers } = ctx;
  let parsed;
  try {
    parsed = readExportProperties(buf, exportEntry, names, { resolve, structHandlers, containerHandlers });
  } catch {
    parsed = { properties: {} };
  }
  const props = parsed.properties;
  const className = resolvePackageIndex(exportEntry.classIndex, ctx.exports, ctx.imports, 'objectName');
  const row = {
    node_id: exportIndex,
    node_name: canonicalNodeName(exportEntry),
    class_name: className,
    ...extractSpatial(props),
  };
  if (className === 'EdGraphNode_Comment') Object.assign(row, extractCommentExtras(props));
  return { row, rawProps: props };
}

/**
 * bp_find_in_graph — filter K2Nodes within a single UEdGraph.
 */
async function bpFindInGraph(projectRoot, params) {
  const assetPath = params.asset_path;
  const graphName = params.graph_name;
  if (!graphName) throw new Error('Missing required parameter: graph_name');
  const filterClass = params.node_class || null;
  const filterMember = params.member_name || null;
  const filterTarget = params.target_class || null;
  const limit = Math.max(1, Math.min(params.limit ?? 100, 1000));
  const offset = Math.max(0, params.offset ?? 0);

  const ctx = await parseAssetForPropertyRead(projectRoot, assetPath);
  const { diskPath } = ctx;
  const { graphs } = indexBlueprintGraphs(ctx);
  const graph = graphs.find(g => g.name === graphName);
  if (!graph) {
    throw new Error(`Graph not found: ${graphName}. Available: ${graphs.map(g => g.name).join(', ')}`);
  }

  const matched = [];
  for (const row of graph._nodes) {
    const cls = row.className;
    if (!SKELETAL_K2NODE_CLASSES.has(cls)) continue;
    if (filterClass && cls !== filterClass) continue;
    const shape = parseNodeShape(ctx, row.export, row.export_index);
    const semantics = extractNodeSemantics(cls, shape.rawProps);
    if (filterMember && semantics.member_name !== filterMember) continue;
    if (filterTarget) {
      const t = semantics.target_class;
      if (!t || (t !== filterTarget && !t.endsWith(filterTarget))) continue;
    }
    matched.push({
      ...shape.row,
      node_class: cls,
      member_name: semantics.member_name ?? null,
      target_class: semantics.target_class ?? null,
      macro_path: semantics.macro_path ?? null,
      graph_name: graph.name,
      extras: semantics.extras,
    });
  }

  const page = matched.slice(offset, offset + limit);
  return stripPackageIndex({
    asset_path: assetPath,
    diskPath: diskPath.replace(/\\/g, '/'),
    graph_name: graph.name,
    graph_type: graph.graph_type,
    total_nodes_in_graph: graph.node_count,
    total_matched: matched.length,
    offset,
    limit,
    truncated: offset + limit < matched.length,
    nodes: page,
    ...faBetaManifest([]),
  });
}

/**
 * bp_subgraph_in_comment — return the comment node + nodes it spatially contains.
 */
async function bpSubgraphInComment(projectRoot, params) {
  const assetPath = params.asset_path;
  const rawId = params.comment_node_id;
  if (rawId === undefined || rawId === null || rawId === '') {
    throw new Error('Missing required parameter: comment_node_id');
  }
  const ctx = await parseAssetForPropertyRead(projectRoot, assetPath);
  const { diskPath, exports, imports } = ctx;

  // Resolve comment_node_id — integer/numeric-string matches export_index;
  // plain string matches canonicalNodeName or objectName.
  // Resolve any node id first (integer export_index OR string objectName),
  // then verify it's a comment. Two-phase lookup gives callers a precise
  // "not a comment" message when they pass a valid non-comment id, vs a
  // generic "not found" when the id is bogus.
  const asNum = Number(rawId);
  let commentExportIndex = null;
  if (Number.isInteger(asNum) && asNum > 0 && asNum <= exports.length) {
    commentExportIndex = asNum;
  } else {
    for (let i = 0; i < exports.length; i++) {
      const e = exports[i];
      if (e.objectName === rawId || canonicalNodeName(e) === rawId) {
        commentExportIndex = i + 1;
        break;
      }
    }
  }
  if (commentExportIndex === null) {
    throw new Error(`Comment node not found: ${rawId}`);
  }
  const commentExport = exports[commentExportIndex - 1];
  const commentClass = resolvePackageIndex(commentExport.classIndex, exports, imports, 'objectName');
  if (commentClass !== 'EdGraphNode_Comment') {
    throw new Error(`Node is not a comment: ${rawId} (className: ${commentClass})`);
  }

  // Build the comment's shape.
  const commentShape = parseNodeShape(ctx, commentExport, commentExportIndex);

  // Collect sibling nodes in the same graph (outerIndex match).
  const graphPi = commentExport.outerIndex;
  const siblings = [];
  for (let i = 0; i < exports.length; i++) {
    const e = exports[i];
    if (e.outerIndex !== graphPi) continue;
    if (i + 1 === commentExportIndex) continue;
    const cls = resolvePackageIndex(e.classIndex, exports, imports, 'objectName');
    if (!cls) continue;
    if (!cls.startsWith('K2Node_') && cls !== 'EdGraphNode_Comment') continue;
    const shape = parseNodeShape(ctx, e, i + 1);
    siblings.push(shape.row);
  }

  const commentRow = commentShape.row;
  const contained = computeCommentContainment(siblings, [commentRow]).get(commentRow.node_id) ?? [];
  const containedNodes = siblings.filter(s => contained.includes(s.node_id));

  return stripPackageIndex({
    asset_path: assetPath,
    diskPath: diskPath.replace(/\\/g, '/'),
    comment: commentRow,
    contained_count: containedNodes.length,
    contained: containedNodes,
    ...faBetaManifest([]),
  });
}

/**
 * bp_list_entry_points — enumerate K2Node_Event/CustomEvent/FunctionEntry nodes.
 *
 * PARTIAL (FA-β): class-identity heuristic; does not tell which entries have
 * outgoing exec connectivity (that needs pin data from M-new S-B). Entries
 * that are not wired to anything still appear here — callers that care about
 * live/dead entries should wait for the pin-aware upgrade.
 */
async function bpListEntryPoints(projectRoot, params) {
  const assetPath = params.asset_path;
  const ctx = await parseAssetForPropertyRead(projectRoot, assetPath);
  const { diskPath, exports, imports } = ctx;
  const { graphs } = indexBlueprintGraphs(ctx);

  // Map graph package-index → graph name for echoing per entry.
  const graphNameByPi = new Map();
  for (const g of graphs) graphNameByPi.set(g.export_index, g.name);

  const entries = [];
  for (let i = 0; i < exports.length; i++) {
    const e = exports[i];
    const cls = resolvePackageIndex(e.classIndex, exports, imports, 'objectName');
    if (!cls || !ENTRY_POINT_CLASSES.has(cls)) continue;
    const shape = parseNodeShape(ctx, e, i + 1);
    const semantics = extractNodeSemantics(cls, shape.rawProps);
    entries.push({
      ...shape.row,
      node_class: cls,
      member_name: semantics.member_name ?? null,
      target_class: semantics.target_class ?? null,
      graph_name: graphNameByPi.get(e.outerIndex) ?? null,
    });
  }

  return stripPackageIndex({
    asset_path: assetPath,
    diskPath: diskPath.replace(/\\/g, '/'),
    entry_point_count: entries.length,
    entry_points: entries,
    ...faBetaManifest(['exec_connectivity']),
  });
}

/**
 * bp_show_node — full export record for a single node by id.
 *
 * PARTIAL (FA-β): pin block (pins[], LinkedTo edges) not populated — that
 * data lives in the 3F sidecar or a pin-aware M-new reader.
 */
async function bpShowNode(projectRoot, params) {
  const assetPath = params.asset_path;
  const rawId = params.node_id;
  if (rawId === undefined || rawId === null || rawId === '') {
    throw new Error('Missing required parameter: node_id');
  }
  const ctx = await parseAssetForPropertyRead(projectRoot, assetPath);
  const { diskPath, exports, imports } = ctx;

  const asNum = Number(rawId);
  let nodeExportIndex = null;
  if (Number.isInteger(asNum) && asNum > 0 && asNum <= exports.length) {
    nodeExportIndex = asNum;
  } else {
    for (let i = 0; i < exports.length; i++) {
      const e = exports[i];
      if (e.objectName === rawId || canonicalNodeName(e) === rawId) {
        nodeExportIndex = i + 1;
        break;
      }
    }
  }
  if (nodeExportIndex === null) {
    throw new Error(`Node not found: ${rawId}`);
  }

  const nodeExport = exports[nodeExportIndex - 1];
  const className = resolvePackageIndex(nodeExport.classIndex, exports, imports, 'objectName');
  const shape = parseNodeShape(ctx, nodeExport, nodeExportIndex);
  const semantics = className?.startsWith('K2Node_')
    ? extractNodeSemantics(className, shape.rawProps) : {};

  // Graph context — which graph does this node live in?
  const { graphs } = indexBlueprintGraphs(ctx);
  const graph = graphs.find(g => g.export_index === nodeExport.outerIndex);

  const node = {
    ...shape.row,
    outer_graph_name: graph?.name ?? null,
    outer_graph_type: graph?.graph_type ?? null,
    member_name: semantics.member_name ?? null,
    target_class: semantics.target_class ?? null,
    macro_path: semantics.macro_path ?? null,
    properties: shape.rawProps,
    pins: [],  // FA-β placeholder; populated by M-new S-B
  };

  return stripPackageIndex({
    asset_path: assetPath,
    diskPath: diskPath.replace(/\\/g, '/'),
    node,
    ...faBetaManifest(['pin_block']),
  });
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

// Guarded M-spatial verbs — ENOENT becomes FA-β graceful-degradation envelope.
// Non-ENOENT errors still throw (D58 contract: distinguish absent from broken).
const bpListGraphsSafe = withAssetExistenceCheck(bpListGraphs);
const bpFindInGraphSafe = withAssetExistenceCheck(bpFindInGraph);
const bpSubgraphInCommentSafe = withAssetExistenceCheck(bpSubgraphInComment);
const bpListEntryPointsSafe = withAssetExistenceCheck(bpListEntryPoints);
const bpShowNodeSafe = withAssetExistenceCheck(bpShowNode);

export async function executeOfflineTool(toolName, params, projectRoot) {
  if (!projectRoot) {
    throw new Error('UNREAL_PROJECT_ROOT not configured — offline tools require a project path');
  }

  switch (toolName) {
    case 'project_info':
      return await projectInfo(projectRoot);

    case 'list_gameplay_tags':
      return await listGameplayTags(projectRoot);

    case 'search_gameplay_tags':
      if (!params.pattern) throw new Error('Missing required parameter: pattern');
      return await searchGameplayTags(projectRoot, params.pattern);

    case 'list_config_values':
      return await listConfigValues(projectRoot, params.config_file, params.section, params.key);

    case 'get_asset_info':
      if (!params.asset_path) throw new Error('Missing required parameter: asset_path');
      return await getAssetInfo(projectRoot, params.asset_path, params);

    case 'query_asset_registry':
      return await queryAssetRegistry(projectRoot, params);

    case 'inspect_blueprint':
      if (!params.asset_path) throw new Error('Missing required parameter: asset_path');
      return await inspectBlueprint(projectRoot, params);

    case 'list_level_actors':
      if (!params.asset_path) throw new Error('Missing required parameter: asset_path');
      return await listLevelActors(projectRoot, params);

    case 'read_asset_properties':
      if (!params.asset_path) throw new Error('Missing required parameter: asset_path');
      return await readAssetProperties(projectRoot, params);

    case 'find_blueprint_nodes':
      if (!params.asset_path) throw new Error('Missing required parameter: asset_path');
      return await findBlueprintNodes(projectRoot, params);

    case 'find_blueprint_nodes_bulk':
      return await findBlueprintNodesBulk(projectRoot, params);

    case 'bp_list_graphs':
      if (!params.asset_path) throw new Error('Missing required parameter: asset_path');
      return await bpListGraphsSafe(projectRoot, params);

    case 'bp_find_in_graph':
      if (!params.asset_path) throw new Error('Missing required parameter: asset_path');
      return await bpFindInGraphSafe(projectRoot, params);

    case 'bp_subgraph_in_comment':
      if (!params.asset_path) throw new Error('Missing required parameter: asset_path');
      return await bpSubgraphInCommentSafe(projectRoot, params);

    case 'bp_list_entry_points':
      if (!params.asset_path) throw new Error('Missing required parameter: asset_path');
      return await bpListEntryPointsSafe(projectRoot, params);

    case 'bp_show_node':
      if (!params.asset_path) throw new Error('Missing required parameter: asset_path');
      return await bpShowNodeSafe(projectRoot, params);

    case 'list_data_sources':
      return await listDataSources(projectRoot);

    case 'read_datatable_source':
      if (!params.file_path) throw new Error('Missing required parameter: file_path');
      return await readDatatableSource(projectRoot, params.file_path, params.row_struct_header);

    case 'read_string_table_source':
      if (!params.file_path) throw new Error('Missing required parameter: file_path');
      return await readStringTableSource(projectRoot, params.file_path);

    case 'list_plugins':
      return await listPlugins(projectRoot);

    case 'get_build_config':
      return await getBuildConfig(projectRoot);

    default:
      throw new Error(`Unknown offline tool: ${toolName}`);
  }
}
