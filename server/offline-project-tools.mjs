// offline-project-tools.mjs — offline tools that read the project itself:
// .uproject, Config/*.ini, plugins, build targets, CSV data sources, and the
// gameplay-tag hierarchy. No .uasset parsing here.

import { readFile, readdir, stat } from 'node:fs/promises';
import { join, extname, basename, relative } from 'node:path';

import { resolveSafePath } from './offline-core.mjs';

// ── Helpers ─────────────────────────────────────────────────

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
export async function projectInfo(projectRoot) {
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
export async function listGameplayTags(projectRoot) {
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
export async function searchGameplayTags(projectRoot, pattern) {
  const { tags } = await listGameplayTags(projectRoot);
  const matches = tags.filter(t => matchTagGlob(pattern, t.tag));
  return { pattern, matches, matchCount: matches.length };
}

/**
 * list_config_values — Read any .ini config file, search for keys/sections
 */
export async function listConfigValues(projectRoot, configFile, section, key) {
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
export async function listDataSources(projectRoot) {
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
export async function readDatatableSource(projectRoot, filePath, rowStructHeader) {
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
export async function readStringTableSource(projectRoot, filePath) {
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
export async function listPlugins(projectRoot) {
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
export async function getBuildConfig(projectRoot) {
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
