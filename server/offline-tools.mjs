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
} from './uasset-parser.mjs';

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
 * search_gameplay_tags — Search tags by pattern (glob-style)
 */
async function searchGameplayTags(projectRoot, pattern) {
  const { tags } = await listGameplayTags(projectRoot);

  // Convert glob pattern to regex (support * and **)
  const regexStr = pattern
    .replace(/\./g, '\\.')
    .replace(/\*\*/g, '___DOUBLESTAR___')
    .replace(/\*/g, '[^.]*')
    .replace(/___DOUBLESTAR___/g, '.*');
  const regex = new RegExp(`^${regexStr}$`, 'i');

  return {
    pattern,
    matches: tags.filter(t => regex.test(t.tag)),
    matchCount: tags.filter(t => regex.test(t.tag)).length,
  };
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
async function getAssetInfo(projectRoot, assetPath) {
  const parsed = await parseAssetHeader(projectRoot, assetPath);
  const { summary, names, assetRegistry } = parsed.data;
  const primary = assetRegistry.objects[0] || null;
  return {
    path: assetPath,
    diskPath: parsed.diskPath.replace(/\\/g, '/'),
    sizeBytes: parsed.sizeBytes,
    sizeKB: Math.round(parsed.sizeBytes / 1024),
    modified: parsed.modified,
    packageName: summary.packageName || null,
    objectPath: primary ? primary.objectPath : null,
    objectClassName: primary ? primary.objectClassName : null,
    tags: primary ? primary.tags : {},
    assetRegistryObjects: assetRegistry.objects.length,
    exportCount: summary.exportCount,
    importCount: summary.importCount,
    nameCount: names.length,
    fileVersionUE5: summary.fileVersionUE5,
  };
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
 *   - class_name: exact match on primary object class (e.g. "Blueprint",
 *     "DataTable", "/Script/Engine.World"). Case-sensitive.
 *   - path_prefix: /Game/... path; narrows the scan root (not a post-filter).
 *   - tag_key / tag_value: asset-registry tag match. If value is omitted,
 *     only tag presence is checked.
 *
 * Caps:
 *   - limit (default 200): max matches returned.
 *   - max_scan (default 5000): hard ceiling on files parsed; guards against
 *     runaway walks in huge Content trees. When hit, `truncated: true` is
 *     set in the response.
 *
 * @param {string} projectRoot
 * @param {object} params
 */
async function queryAssetRegistry(projectRoot, params = {}) {
  const className = params.class_name ?? null;
  const pathPrefix = params.path_prefix ?? null;
  const tagKey = params.tag_key ?? null;
  const tagValue = params.tag_value ?? null;
  const limit = Math.max(1, Math.min(params.limit ?? 200, 2000));
  const maxScan = Math.max(1, Math.min(params.max_scan ?? 5000, 20000));

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
  const truncated = files.length >= maxScan;

  const results = [];
  const errors = [];
  const contentRoot = join(projectRoot, 'Content');

  for (const diskPath of files) {
    if (results.length >= limit) break;

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

    // Class filter: exact match; accept bare name ("Blueprint") or fully
    // qualified ("/Script/Engine.Blueprint").
    if (className && klass !== className) continue;

    // Tag filter.
    if (tagKey) {
      if (!Object.prototype.hasOwnProperty.call(tags, tagKey)) continue;
      if (tagValue !== null && tags[tagKey] !== tagValue) continue;
    }

    results.push({
      path: gamePath + ext,
      objectClassName: klass,
      objectPath: primary ? primary.objectPath : null,
      packageName: parsed.data.summary.packageName || null,
      tags,
      sizeBytes: parsed.sizeBytes,
      exportCount: parsed.data.summary.exportCount,
    });
  }

  return {
    scanRoot: relative(projectRoot, scanRoot).replace(/\\/g, '/') || 'Content',
    filesScanned: files.length,
    matches: results.length,
    truncated,
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
 * inspect_blueprint — Deep introspection of a Blueprint .uasset.
 *
 * Returns full export table with resolved class/super/outer names plus
 * asset-registry tags. Callers use this to identify parent class, CDO,
 * generated class, and component/variable exports without the editor.
 *
 * Works on any .uasset — named for the common case (Blueprint), but UMG
 * widgets, AnimBPs, DataAssets all parse identically.
 */
async function inspectBlueprint(projectRoot, assetPath) {
  const diskPath = resolveAssetDiskPath(projectRoot, assetPath);
  const stats = await stat(diskPath);
  const header = await parseAssetHeader(projectRoot, assetPath);
  const { imports, exports } = await parseAssetTables(diskPath);
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

  // Locate the BlueprintGeneratedClass export — its SuperIndex resolves
  // to the parent class (native or another BP's generated class).
  const genClassNames = new Set([
    'BlueprintGeneratedClass',
    'WidgetBlueprintGeneratedClass',
    'AnimBlueprintGeneratedClass',
  ]);
  const generated = exportRows.find(r => genClassNames.has(r.className));
  const parentClass = generated ? generated.superClass : null;

  return {
    path: assetPath,
    diskPath: diskPath.replace(/\\/g, '/'),
    sizeBytes: stats.size,
    modified: stats.mtime.toISOString(),
    objectClassName: primary ? primary.objectClassName : null,
    objectPath: primary ? primary.objectPath : null,
    parentClass,
    generatedClass: generated ? generated.objectName : null,
    tags: primary ? primary.tags : {},
    exportCount: exports.length,
    importCount: imports.length,
    exports: exportRows,
  };
}

/**
 * list_level_actors — Enumerate actors in a .umap.
 *
 * Returns each export's {objectName, className, outer, bIsAsset}. Per D37
 * YAGNI: class + name only, no transforms, no components tree. Callers
 * that need transforms go through Layer 2/3 TCP tools.
 */
async function listLevelActors(projectRoot, assetPath) {
  // Levels live in .umap, not .uasset. If caller passed a bare /Game/... path
  // without extension, resolve to .umap instead of the resolver default.
  const mapPath = assetPath.endsWith(".umap") || assetPath.endsWith(".uasset")
    ? assetPath
    : assetPath + ".umap";
  const diskPath = resolveAssetDiskPath(projectRoot, mapPath);
  const stats = await stat(diskPath);
  const { imports, exports } = await parseAssetTables(diskPath);

  const actors = exports.map(e => ({
    name: e.objectName,
    className: resolvePackageIndex(e.classIndex, exports, imports, 'objectName'),
    classPackage: e.classIndex < 0
      ? (imports[-e.classIndex - 1]?.classPackage ?? null)
      : null,
    outer: resolvePackageIndex(e.outerIndex, exports, imports, 'objectName'),
    bIsAsset: e.bIsAsset,
  }));

  return {
    path: assetPath,
    diskPath: diskPath.replace(/\\/g, '/'),
    sizeBytes: stats.size,
    modified: stats.mtime.toISOString(),
    exportCount: exports.length,
    importCount: imports.length,
    actors,
  };
}

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
      return await getAssetInfo(projectRoot, params.asset_path);

    case 'query_asset_registry':
      return await queryAssetRegistry(projectRoot, params);

    case 'inspect_blueprint':
      if (!params.asset_path) throw new Error('Missing required parameter: asset_path');
      return await inspectBlueprint(projectRoot, params.asset_path);

    case 'list_level_actors':
      if (!params.asset_path) throw new Error('Missing required parameter: asset_path');
      return await listLevelActors(projectRoot, params.asset_path);

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
