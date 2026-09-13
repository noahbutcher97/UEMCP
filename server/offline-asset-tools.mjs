// offline-asset-tools.mjs — offline tools over .uasset/.umap files: registry
// scan and query, asset info, export listing, tagged-property reads with
// subobject budgets, and level-actor extraction. Blueprint graph verbs live in
// offline-blueprint-tools.mjs.

import { readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';

import {
  resolvePackageIndex,
  readExportProperties,
} from './uasset-parser.mjs';
import { PROPERTY_READ_REASON_GROUPS } from './property-read-contract.mjs';
import {
  parseAssetHeader,
  resolveSafePath,
  stripPackageIndex,
  parseAssetForPropertyRead,
} from './offline-core.mjs';

const BOUNDED_SUBOBJECT_REASONS = PROPERTY_READ_REASON_GROUPS.boundedSubobject;

// ── Tool implementations ────────────────────────────────────

/**
 * get_asset_info — Read .uasset header metadata
 *
 * Returns parsed registry metadata (class, objectPath, tags, counts) plus
 * size/mtime. Uses the shared asset cache — repeat queries on the same
 * unchanged file skip re-parse.
 *
 * Closes D36: reframes the stat-only placeholder into a registry query.
 */
export async function getAssetInfo(projectRoot, assetPath, params = {}) {
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
export async function queryAssetRegistry(projectRoot, params = {}) {
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
    if (pathPrefix !== '/Game' && !pathPrefix.startsWith('/Game/')) {
      throw new Error(`path_prefix must be /Game or start with /Game/ (got: ${pathPrefix})`);
    }
    // W-H (D144 — Gauntlet finding 9.4): single-occurrence replace below
    // would accept `/Game/../../etc/passwd` → `../../etc/passwd`, which
    // join() resolves outside Content/. resolveSafePath enforces the
    // post-resolve full path stays inside contentRoot. Throws on
    // traversal; bounded today by walkAssetFiles file-type filter, but
    // the defense-in-depth fold-in costs ~3 lines.
    const contentRoot = join(projectRoot, 'Content');
    const relPrefix = pathPrefix === '/Game' || pathPrefix === '/Game/' ? '' : pathPrefix.slice('/Game/'.length);
    scanRoot = relPrefix ? resolveSafePath(contentRoot, relPrefix) : contentRoot;
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

// ── Export handler map ──────────────────────────────────────

/**
 * Execute an offline tool by name.
 * @param {string} toolName
 * @param {object} params
 * @param {string} projectRoot
 * @returns {Promise<object>}
 */

/**
 * Classes that identify an asset as a Blueprint subclass whose CDO name
 * follows the `Default__<AssetName>_C` convention. Includes GAS as a
 * defensive add (Agent 9 §4 Q4) even though our target project compiles GAS
 * as plain BlueprintGeneratedClass today.
 */
const BP_GENERATED_CLASSES = new Set([
  'BlueprintGeneratedClass',
  'WidgetBlueprintGeneratedClass',
  'AnimBlueprintGeneratedClass',
  'GameplayAbilityBlueprintGeneratedClass',
]);

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

function buildRequestedPropertyRows(requestedNames, parsed) {
  const unsupportedByName = new Map();
  for (const marker of parsed.unsupported || []) {
    if (!marker || !marker.name || marker.name === '__stream__') continue;
    if (!unsupportedByName.has(marker.name)) {
      unsupportedByName.set(marker.name, marker);
    }
  }

  return requestedNames.map(name => {
    if (Object.prototype.hasOwnProperty.call(parsed.properties, name)) {
      const value = parsed.properties[name];
      if (value && typeof value === 'object' && value.unsupported === true) {
        const { unsupported: _unsupported, ...marker } = value;
        return { name, status: 'unsupported', ...stripPackageIndex(marker) };
      }
      return { name, status: 'serialized', value: stripPackageIndex(value) };
    }

    const marker = unsupportedByName.get(name);
    if (marker) {
      const { name: _name, unsupported: _unsupported, ...rest } = marker;
      return { name, status: 'unsupported', ...stripPackageIndex(rest) };
    }

    return {
      name,
      status: parsed.truncated ? 'unknown_due_to_truncation' : 'not_serialized_default',
    };
  });
}

function readPropertyExport(ctx, exportEntry, maxBytes) {
  return readExportProperties(ctx.buf, exportEntry, ctx.names, {
    resolve: ctx.resolve,
    structHandlers: ctx.structHandlers,
    containerHandlers: ctx.containerHandlers,
    maxBytes,
  });
}

function assetPathLeaf(assetPath) {
  const normalized = String(assetPath || '').replace(/\\/g, '/').replace(/\/+$/, '');
  const leaf = normalized.split('/').pop() || '';
  return leaf.replace(/\.(uasset|umap)$/i, '');
}

function canonicalExportName(entry) {
  const number = Number.isInteger(entry.objectNameNumber) ? entry.objectNameNumber : 0;
  return number > 0 ? `${entry.objectName}_${number - 1}` : entry.objectName;
}

function formatExportRow(entry, index, exports, imports) {
  const outerExport = entry.outerIndex > 0 ? exports[entry.outerIndex - 1] : null;
  return {
    export_index: index + 1,
    object_name: entry.objectName,
    object_name_number: Number.isInteger(entry.objectNameNumber) ? entry.objectNameNumber : 0,
    canonical_name: canonicalExportName(entry),
    class_name: resolvePackageIndex(entry.classIndex, exports, imports, 'objectName'),
    super_name: resolvePackageIndex(entry.superIndex, exports, imports, 'objectName'),
    outer_index: entry.outerIndex,
    outer_name: resolvePackageIndex(entry.outerIndex, exports, imports, 'objectName'),
    outer_class_name: outerExport
      ? resolvePackageIndex(outerExport.classIndex, exports, imports, 'objectName')
      : null,
    b_is_asset: entry.bIsAsset,
    serial_size: entry.serialSize,
  };
}

function selectAssetExport(exports, imports, assetPath) {
  const generatedIndex = exports.findIndex(e => {
    const cls = resolvePackageIndex(e.classIndex, exports, imports, 'objectName');
    return cls && BP_GENERATED_CLASSES.has(cls);
  });
  if (generatedIndex >= 0) {
    const cdoName = `Default__${exports[generatedIndex].objectName}`;
    const cdoIndex = exports.findIndex(e => e.objectName === cdoName);
    if (cdoIndex >= 0) {
      return { index: cdoIndex, entry: exports[cdoIndex], reason: 'blueprint_cdo' };
    }
  }

  const packageLeaf = assetPathLeaf(assetPath);
  const rootNameIndex = exports.findIndex(e => e.outerIndex === 0 && e.objectName === packageLeaf);
  if (rootNameIndex >= 0) {
    return { index: rootNameIndex, entry: exports[rootNameIndex], reason: 'package_root_name_match' };
  }

  const rootAssetIndex = exports.findIndex(e => e.outerIndex === 0 && e.bIsAsset);
  if (rootAssetIndex >= 0) {
    return { index: rootAssetIndex, entry: exports[rootAssetIndex], reason: 'root_asset_export' };
  }

  const assetIndex = exports.findIndex(e => e.bIsAsset);
  if (assetIndex >= 0) {
    return { index: assetIndex, entry: exports[assetIndex], reason: 'first_asset_export' };
  }

  if (exports.length > 0) {
    return { index: 0, entry: exports[0], reason: 'first_export_fallback' };
  }

  return null;
}

function normalizeIntegerParam(value, name, { defaultValue, min, cap = null }) {
  const resolved = value ?? defaultValue;
  const n = Number(resolved);
  if (!Number.isInteger(n)) {
    throw new Error(`${name} must be an integer`);
  }
  if (n < min) {
    throw new Error(`${name} must be >= ${min}`);
  }
  return cap === null ? n : Math.min(n, cap);
}

function summarizeSelectedExport(selection, exports, imports) {
  if (!selection) return null;
  const row = formatExportRow(selection.entry, selection.index, exports, imports);
  return {
    export_name: row.object_name,
    export_index: row.export_index,
    canonical_name: row.canonical_name,
    class_name: row.class_name,
    selection_reason: selection.reason,
  };
}

const SUBOBJECT_EXCLUDED_CLASS_PATTERNS = [
  /^Blueprint$/,
  /^AnimBlueprint$/,
  /^WidgetBlueprint$/,
  /BlueprintGeneratedClass$/,
  /^Function$/,
  /^EdGraph$/,
  /^AnimationGraph$/,
  /^K2Node_/,
  /^AnimGraphNode_/,
  /^EdGraphNode_/,
];

function isSubobjectCandidate(entry, className) {
  if (!entry || !className) return false;
  if (entry.bIsAsset) return false;
  if (SUBOBJECT_EXCLUDED_CLASS_PATTERNS.some(pattern => pattern.test(className))) {
    return false;
  }
  if (className.includes('Component')) return true;
  if (className === 'SimpleConstructionScript' || className === 'SCS_Node') return true;
  if (className.includes('GameplayEffect')) return true;
  return false;
}

function collectExportRefs(value, out = new Set()) {
  if (value === null || typeof value !== 'object') return out;
  if (Array.isArray(value)) {
    for (const item of value) collectExportRefs(item, out);
    return out;
  }
  if (value.kind === 'export' && Number.isInteger(value.packageIndex) && value.packageIndex > 0) {
    out.add(value.packageIndex - 1);
  }
  for (const child of Object.values(value)) {
    collectExportRefs(child, out);
  }
  return out;
}

function normalizeReasonList(value) {
  return Array.isArray(value) ? value : [value];
}

/**
 * Collect same-package subobject exports reachable from a selected export.
 *
 * rootExportIndex is zero-based. Returned rows expose one-based export_index
 * for caller-facing parity with list_asset_exports/read_asset_properties.
 */
export function collectSubobjectExportIndexes({
  exports,
  imports,
  rootExportIndex,
  rootProperties = {},
  propertiesForExportIndex = null,
  maxDepth = 1,
  limit = 50,
}) {
  const rows = [];
  const queued = [];
  const seen = new Map();
  const rootEntry = exports[rootExportIndex];

  const pushCandidate = (idx, depth, reason) => {
    if (!Number.isInteger(idx) || idx < 0 || idx >= exports.length) return;
    if (idx === rootExportIndex || depth < 1 || depth > maxDepth) return;
    const entry = exports[idx];
    const className = resolvePackageIndex(entry.classIndex, exports, imports, 'objectName');
    if (!isSubobjectCandidate(entry, className)) return;

    const existing = seen.get(idx);
    if (existing) {
      for (const r of normalizeReasonList(reason)) {
        if (!existing.discoveredBy.includes(r)) existing.discoveredBy.push(r);
      }
      return;
    }
    const rec = { idx, depth, discoveredBy: normalizeReasonList(reason) };
    seen.set(idx, rec);
    queued.push(rec);
  };

  const pushChildren = (parentIdx, depth, reason) => {
    const parentPackageIndex = parentIdx + 1;
    for (let i = 0; i < exports.length; i++) {
      if (exports[i].outerIndex === parentPackageIndex) {
        pushCandidate(i, depth, reason);
      }
    }
  };

  pushChildren(rootExportIndex, 1, 'outer_child');
  for (const idx of collectExportRefs(rootProperties)) {
    pushCandidate(idx, 1, 'property_ref');
  }

  if (rootEntry?.objectName?.startsWith('Default__')) {
    const generatedName = rootEntry.objectName.slice('Default__'.length);
    const generatedIdx = exports.findIndex(e => e.objectName === generatedName);
    if (generatedIdx >= 0) {
      pushChildren(generatedIdx, 1, 'generated_class_child');
    }
  }

  let truncated = false;
  for (let cursor = 0; cursor < queued.length; cursor++) {
    if (rows.length >= limit) {
      truncated = true;
      break;
    }
    const rec = queued[cursor];
    const entry = exports[rec.idx];
    const className = resolvePackageIndex(entry.classIndex, exports, imports, 'objectName');
    rows.push({
      export_index: rec.idx + 1,
      export_name: entry.objectName,
      canonical_name: canonicalExportName(entry),
      class_name: className,
      outer_index: entry.outerIndex,
      outer_name: resolvePackageIndex(entry.outerIndex, exports, imports, 'objectName'),
      depth: rec.depth,
      discovered_by: [...rec.discoveredBy],
    });

    if (rec.depth < maxDepth) {
      pushChildren(rec.idx, rec.depth + 1, 'outer_child');
      if (typeof propertiesForExportIndex === 'function') {
        let nestedProperties = {};
        try {
          nestedProperties = propertiesForExportIndex(rec.idx) || {};
        } catch {
          nestedProperties = {};
        }
        for (const idx of collectExportRefs(nestedProperties)) {
          pushCandidate(idx, rec.depth + 1, 'property_ref');
        }
      }
    }
  }
  rows.truncated = truncated || queued.length > rows.length;
  return rows;
}

function asPlainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function normalizeNameLike(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'object') {
    return value.Name ?? value.name ?? value.value ?? value.objectName ?? value.tagName ?? null;
  }
  return null;
}

function normalizeResponseMap(value) {
  if (!value || typeof value !== 'object') return null;
  if (value.unsupported === true) return null;
  if (Array.isArray(value)) {
    const out = {};
    for (const entry of value) {
      if (!entry || typeof entry !== 'object') continue;
      const key = normalizeNameLike(entry.key ?? entry.channel ?? entry.name ?? entry.Channel);
      const response = normalizeNameLike(entry.value ?? entry.response ?? entry.Response);
      if (key !== null && response !== null) out[key] = response;
    }
    return Object.keys(out).length ? out : null;
  }
  if (Array.isArray(value.ResponseArray)) {
    return normalizeResponseMap(value.ResponseArray);
  }
  const out = {};
  for (const [key, response] of Object.entries(value)) {
    if (response && typeof response === 'object' && 'unsupported' in response) continue;
    out[key] = normalizeNameLike(response) ?? response;
  }
  return Object.keys(out).length ? out : null;
}

export function summarizeCollisionProperties(properties = {}) {
  const body = asPlainObject(properties.BodyInstance);
  const bodyUnsupported = body?.unsupported === true ? body : null;
  const bodyProps = bodyUnsupported ? null : body;
  const out = {};

  const profile = normalizeNameLike(
    properties.CollisionProfileName ??
    bodyProps?.CollisionProfileName ??
    bodyProps?.ProfileName
  );
  if (profile !== null) out.profile_name = profile;

  const enabled = normalizeNameLike(
    properties.CollisionEnabled ??
    bodyProps?.CollisionEnabled
  );
  if (enabled !== null) out.collision_enabled = enabled;

  const objectType = normalizeNameLike(
    properties.CollisionObjectType ??
    bodyProps?.ObjectType ??
    bodyProps?.CollisionObjectType
  );
  if (objectType !== null) out.object_type = objectType;

  const overlap = properties.bGenerateOverlapEvents ?? bodyProps?.bGenerateOverlapEvents;
  if (overlap !== undefined) out.generate_overlap_events = overlap;

  if (bodyProps) {
    const bodyOut = {};
    for (const [sourceKey, targetKey] of [
      ['CollisionEnabled', 'collision_enabled'],
      ['ObjectType', 'object_type'],
      ['bUseCCD', 'use_ccd'],
      ['bNotifyRigidBodyCollision', 'notify_rigid_body_collision'],
      ['LinearDamping', 'linear_damping'],
      ['AngularDamping', 'angular_damping'],
    ]) {
      if (bodyProps[sourceKey] !== undefined) {
        bodyOut[targetKey] = normalizeNameLike(bodyProps[sourceKey]) ?? bodyProps[sourceKey];
      }
    }

    const responses = normalizeResponseMap(
      bodyProps.ResponseToChannels ??
      bodyProps.CollisionResponses?.ResponseToChannels ??
      bodyProps.CollisionResponses
    );
    if (responses) bodyOut.response_to_channels = responses;
    if (Object.keys(bodyOut).length) out.body_instance = bodyOut;
  } else if (bodyUnsupported) {
    out.body_instance_status = bodyUnsupported.reason ?? 'unsupported';
  }

  const directResponses = normalizeResponseMap(
    properties.ResponseToChannels ??
    properties.CollisionResponses?.ResponseToChannels ??
    properties.CollisionResponses
  );
  if (directResponses) {
    out.response_to_channels = directResponses;
  }

  return Object.keys(out).length ? out : null;
}

function filterParsedProperties(parsed, filterNames) {
  if (!filterNames) {
    return {
      properties: parsed.properties,
      propertyCountReturned: parsed.propertyCount,
      unsupported: parsed.unsupported,
    };
  }
  const properties = {};
  for (const name of Object.keys(parsed.properties)) {
    if (filterNames.has(name)) properties[name] = parsed.properties[name];
  }
  return {
    properties,
    propertyCountReturned: Object.keys(properties).length,
    unsupported: parsed.unsupported.filter(m =>
      filterNames.has(m.name) || m.name === '__stream__'
    ),
  };
}

function propertyDecodeStatus(parsed) {
  if (parsed.propertyCount > 0 || Object.keys(parsed.properties || {}).length > 0) {
    return 'serialized';
  }
  if ((parsed.unsupported || []).some(m => m.name === '__stream__')) {
    return 'present_but_undecoded';
  }
  return 'empty_or_default';
}

function estimateJsonBytes(value) {
  try {
    return Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8');
  } catch {
    return Infinity;
  }
}

function budgetExhaustedRow(row, parsed, unsupported) {
  return {
    ...row,
    decode_status: 'present_but_undecoded',
    properties: {},
    unsupported: dedupeUnsupported([
      ...unsupported,
      { name: '__stream__', reason: BOUNDED_SUBOBJECT_REASONS.subobjectBudgetExhausted },
    ]),
    property_count_returned: 0,
    property_count_total: parsed.propertyCount ?? 0,
    truncated: true,
  };
}

export function buildSubobjectResponseRow(row, parsed, opts = {}) {
  const {
    filterNames = null,
    requestedPropertyNames = null,
    remainingBytes = Infinity,
  } = opts;
  const filtered = filterParsedProperties(parsed, filterNames);
  const unsupported = dedupeUnsupported(filtered.unsupported);

  if (remainingBytes <= 0) {
    return {
      row: budgetExhaustedRow(row, parsed, unsupported),
      bytesUsed: 0,
      budgetExhausted: true,
    };
  }

  const out = {
    ...row,
    decode_status: propertyDecodeStatus(parsed),
    properties: filtered.properties,
    unsupported,
    property_count_returned: filtered.propertyCountReturned,
    property_count_total: parsed.propertyCount,
    truncated: parsed.truncated,
  };
  if (requestedPropertyNames && requestedPropertyNames.length > 0) {
    out.requested_properties = buildRequestedPropertyRows(requestedPropertyNames, parsed);
  }
  const collision = summarizeCollisionProperties(parsed.properties);
  if (collision) out.collision = collision;

  const payloadBytes = estimateJsonBytes({
    properties: out.properties,
    unsupported: out.unsupported,
    requested_properties: out.requested_properties,
    collision: out.collision,
  });
  if (payloadBytes > remainingBytes) {
    return {
      row: budgetExhaustedRow(row, parsed, unsupported),
      bytesUsed: 0,
      budgetExhausted: true,
    };
  }

  return {
    row: out,
    bytesUsed: payloadBytes,
    budgetExhausted: false,
  };
}

export async function listAssetExports(projectRoot, params) {
  const assetPath = params.asset_path;
  const limit = normalizeIntegerParam(params.limit, 'limit', {
    defaultValue: 200,
    min: 1,
    cap: 2000,
  });
  const offset = normalizeIntegerParam(params.offset, 'offset', {
    defaultValue: 0,
    min: 0,
  });

  const ctx = await parseAssetForPropertyRead(projectRoot, assetPath);
  const { diskPath, exports, imports } = ctx;
  const allRows = exports.map((entry, index) => formatExportRow(entry, index, exports, imports));
  const defaultSelection = selectAssetExport(exports, imports, assetPath);

  return stripPackageIndex({
    path: assetPath,
    diskPath: diskPath.replace(/\\/g, '/'),
    total_exports: exports.length,
    offset,
    limit,
    truncated: offset + limit < exports.length,
    default_export: summarizeSelectedExport(defaultSelection, exports, imports),
    exports: allRows.slice(offset, offset + limit),
  });
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
export async function inspectBlueprint(projectRoot, params) {
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
export async function listLevelActors(projectRoot, params) {
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
 *   - Otherwise, prefer the package-root export whose object name matches
 *     the asset path leaf, then fall back through the shared export selector.
 *
 * property_names filter runs AFTER full-stream parse — the stream has to
 * be walked sequentially (FPropertyTag sizes are declared inline), so
 * the filter trims output without changing parse cost.
 */
export async function readAssetProperties(projectRoot, params) {
  const assetPath = params.asset_path;
  const requestedExportName = params.export_name || null;
  const requestedPropertyNames = Array.isArray(params.property_names)
    ? params.property_names : null;
  const filterNames = requestedPropertyNames && requestedPropertyNames.length
    ? new Set(requestedPropertyNames) : null;
  const maxBytes = params.max_bytes ?? 65_536;
  const includeSubobjects = params.include_subobjects === true;
  const subobjectDepth = normalizeIntegerParam(params.subobject_depth, 'subobject_depth', {
    defaultValue: 1,
    min: 1,
    cap: 3,
  });
  const subobjectLimit = normalizeIntegerParam(params.subobject_limit, 'subobject_limit', {
    defaultValue: 50,
    min: 1,
    cap: 200,
  });

  const ctx = await parseAssetForPropertyRead(projectRoot, assetPath);
  const { diskPath, exports, imports } = ctx;

  // Pick the target export.
  let target = null;
  let exportIndex = -1;
  let exportSelectionReason = null;
  const hasExportIndex = params.export_index !== undefined && params.export_index !== null;
  if (requestedExportName && hasExportIndex) {
    throw new Error('Provide only one of export_name or export_index');
  }

  if (hasExportIndex) {
    const n = Number(params.export_index);
    if (!Number.isInteger(n)) {
      throw new Error('export_index must be an integer');
    }
    if (n < 1 || n > exports.length) {
      throw new Error(`export_index out of range: ${n} (valid 1..${exports.length})`);
    }
    exportIndex = n - 1;
    target = exports[exportIndex];
    exportSelectionReason = 'explicit_export_index';
  } else if (requestedExportName) {
    exportIndex = exports.findIndex(e => e.objectName === requestedExportName);
    if (exportIndex < 0) {
      throw new Error(`Export not found: ${requestedExportName}`);
    }
    target = exports[exportIndex];
    exportSelectionReason = 'explicit_export_name';
  } else {
    const selected = selectAssetExport(exports, imports, assetPath);
    if (selected) {
      exportIndex = selected.index;
      target = selected.entry;
      exportSelectionReason = selected.reason;
    }
  }

  if (!target) throw new Error('No exports found in asset');

  const structType = resolvePackageIndex(target.classIndex, exports, imports, 'objectName');
  const parsed = readPropertyExport(ctx, target, maxBytes);

  const filtered = filterParsedProperties(parsed, filterNames);

  const result = {
    path: assetPath,
    diskPath: diskPath.replace(/\\/g, '/'),
    export_name: target.objectName,
    export_index: exportIndex + 1,
    export_selection_reason: exportSelectionReason,
    struct_type: structType,
    properties: filtered.properties,
    unsupported: dedupeUnsupported(filtered.unsupported),
    property_count_returned: filtered.propertyCountReturned,
    property_count_total: parsed.propertyCount,
    truncated: parsed.truncated,
  };

  if (requestedPropertyNames && requestedPropertyNames.length > 0) {
    result.requested_properties = buildRequestedPropertyRows(requestedPropertyNames, parsed);
  }

  if (includeSubobjects) {
    const parsedSubobjects = new Map();
    const parseSubobjectExport = (zeroBasedIndex) => {
      if (!parsedSubobjects.has(zeroBasedIndex)) {
        parsedSubobjects.set(
          zeroBasedIndex,
          readPropertyExport(ctx, exports[zeroBasedIndex], maxBytes),
        );
      }
      return parsedSubobjects.get(zeroBasedIndex);
    };
    const subobjectRows = collectSubobjectExportIndexes({
      exports,
      imports,
      rootExportIndex: exportIndex,
      rootProperties: parsed.properties,
      propertiesForExportIndex: (zeroBasedIndex) => parseSubobjectExport(zeroBasedIndex).properties,
      maxDepth: subobjectDepth,
      limit: subobjectLimit,
    });
    result.subobject_depth = subobjectDepth;
    result.subobject_limit = subobjectLimit;
    result.subobjects_truncated = Boolean(subobjectRows.truncated);
    result.subobject_count_returned = subobjectRows.length;
    result.subobject_payload_max_bytes = maxBytes;
    let remainingSubobjectBytes = maxBytes;
    result.subobjects = [];
    for (const row of subobjectRows) {
      const subParsed = remainingSubobjectBytes > 0
        ? parseSubobjectExport(row.export_index - 1)
        : { properties: {}, unsupported: [], propertyCount: 0, truncated: true };
      const built = buildSubobjectResponseRow(row, subParsed, {
        filterNames,
        requestedPropertyNames,
        remainingBytes: remainingSubobjectBytes,
      });
      remainingSubobjectBytes -= built.bytesUsed;
      if (built.budgetExhausted) {
        result.subobjects_truncated = true;
      }
      result.subobjects.push(built.row);
    }
    result.subobject_payload_bytes_remaining = Math.max(0, remainingSubobjectBytes);
  }

  // P7: deterministic top-level key ordering (path info → target → payload →
  // counts → truncation). P4: dedupe unsupported[] by {name, reason}.
  return stripPackageIndex(result);
}
