// Offline toolset — 10 tools that work without Unreal Editor
//
// All tools read from the project directory on disk.
// They parse .uproject, .ini, .uasset headers, .h/.cpp source, etc.
// No TCP or HTTP connections needed.

import { readFile, readdir, stat, access } from 'node:fs/promises';
import { join, extname, basename, relative } from 'node:path';

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
  const sections = await parseIniFile(iniPath);

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
 * browse_content — List content directories, filter by asset type
 */
async function browseContent(projectRoot, path, typeFilter) {
  const contentDir = join(projectRoot, 'Content');
  const targetDir = path ? join(contentDir, path) : contentDir;

  const entries = await listDirRecursive(targetDir, targetDir, 2);

  if (typeFilter) {
    const typeExtMap = {
      blueprint: '.uasset',
      material: '.uasset',
      texture: '.uasset',
      map: '.umap',
      level: '.umap',
    };
    const ext = typeExtMap[typeFilter.toLowerCase()];
    if (ext) {
      return {
        path: path || '/',
        filter: typeFilter,
        entries: entries.filter(e => e.ext === ext),
      };
    }
  }

  return { path: path || '/', entries };
}

/**
 * get_asset_info — Read .uasset header metadata
 */
async function getAssetInfo(projectRoot, assetPath) {
  // Resolve /Game/ paths to Content/
  let diskPath = assetPath;
  if (assetPath.startsWith('/Game/')) {
    diskPath = join(projectRoot, 'Content', assetPath.replace('/Game/', ''));
    if (!diskPath.endsWith('.uasset') && !diskPath.endsWith('.umap')) {
      diskPath += '.uasset';
    }
  } else {
    diskPath = resolve(projectRoot, assetPath);
  }

  try {
    const stats = await stat(diskPath);
    return {
      path: assetPath,
      diskPath: diskPath.replace(/\\/g, '/'),
      sizeBytes: stats.size,
      sizeKB: Math.round(stats.size / 1024),
      modified: stats.mtime.toISOString(),
      note: 'Detailed class/reference info requires editor (use get_blueprint_info or search_assets when editor is running)',
    };
  } catch (err) {
    throw new Error(`Asset not found: ${assetPath} (${err.message})`);
  }
}

/**
 * search_source — Grep project Source/ directory for patterns
 */
async function searchSource(projectRoot, pattern, fileFilter) {
  const sourceDir = join(projectRoot, 'Source');
  const results = [];
  const maxResults = 50;

  async function searchDir(dir) {
    if (results.length >= maxResults) return;
    const items = await readdir(dir, { withFileTypes: true });
    for (const item of items) {
      if (results.length >= maxResults) return;
      const fullPath = join(dir, item.name);

      if (item.isDirectory()) {
        if (['Intermediate', 'Binaries', 'ThirdParty'].includes(item.name)) continue;
        await searchDir(fullPath);
      } else {
        const ext = extname(item.name).toLowerCase();
        if (!['.h', '.cpp', '.cs', '.ini'].includes(ext)) continue;
        if (fileFilter && !item.name.toLowerCase().includes(fileFilter.toLowerCase())) continue;

        try {
          const content = await readFile(fullPath, 'utf-8');
          const lines = content.split(/\r?\n/);
          const regex = new RegExp(pattern, 'gi');

          for (let i = 0; i < lines.length; i++) {
            if (regex.test(lines[i])) {
              results.push({
                file: relative(projectRoot, fullPath).replace(/\\/g, '/'),
                line: i + 1,
                text: lines[i].trim(),
              });
              if (results.length >= maxResults) return;
            }
            regex.lastIndex = 0;
          }
        } catch { /* skip unreadable files */ }
      }
    }
  }

  await searchDir(sourceDir);
  return { pattern, fileFilter: fileFilter || null, matches: results, truncated: results.length >= maxResults };
}

/**
 * read_source_file — Read a specific .h or .cpp file
 */
async function readSourceFile(projectRoot, filePath) {
  const allowedExts = ['.h', '.cpp', '.cs', '.ini', '.txt', '.md'];
  const ext = extname(filePath).toLowerCase();
  if (!allowedExts.includes(ext)) {
    throw new Error(`File type not allowed: ${ext}. Allowed: ${allowedExts.join(', ')}`);
  }

  const fullPath = resolve(projectRoot, filePath);
  const normalizedRoot = projectRoot.replace(/\\/g, '/').toLowerCase();
  const normalizedFull = fullPath.replace(/\\/g, '/').toLowerCase();
  if (!normalizedFull.startsWith(normalizedRoot)) {
    throw new Error('Path traversal not allowed');
  }

  const content = await readFile(fullPath, 'utf-8');
  const lines = content.split(/\r?\n/).length;
  return { path: filePath, lines, content };
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

    case 'browse_content':
      return await browseContent(projectRoot, params.path, params.type_filter);

    case 'get_asset_info':
      if (!params.asset_path) throw new Error('Missing required parameter: asset_path');
      return await getAssetInfo(projectRoot, params.asset_path);

    case 'search_source':
      if (!params.pattern) throw new Error('Missing required parameter: pattern');
      return await searchSource(projectRoot, params.pattern, params.file_filter);

    case 'read_source_file':
      if (!params.file_path) throw new Error('Missing required parameter: file_path');
      return await readSourceFile(projectRoot, params.file_path);

    case 'list_plugins':
      return await listPlugins(projectRoot);

    case 'get_build_config':
      return await getBuildConfig(projectRoot);

    default:
      throw new Error(`Unknown offline tool: ${toolName}`);
  }
}
