import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TestRunner } from './test-helpers.mjs';

const DEFAULT_IGNORED_PLUGIN_SOURCE_FRAGMENTS = [
  'Tests',
  'PropertyHandlerRegistry.cpp',
];

export function isPlannedOrExcluded(def) {
  return def?.status === 'planned' || def?.discoverable === false;
}

export function buildCallableToolMap(groups) {
  const map = new Map();
  const duplicates = [];

  for (const [groupName, defs] of groups) {
    for (const toolName of Object.keys(defs)) {
      if (map.has(toolName)) {
        duplicates.push(`${toolName} (${map.get(toolName)} + ${groupName})`);
      } else {
        map.set(toolName, groupName);
      }
    }
  }

  return { map, duplicates };
}

export function findYamlToolDef(toolsData, toolName) {
  for (const toolset of Object.values(toolsData.toolsets || {})) {
    const def = toolset.tools?.[toolName];
    if (def) return def;
  }
  return null;
}

export function collectCoveredWireCommands(toolsData, groups) {
  const covered = new Set(['ping']);

  for (const [, defs] of groups) {
    for (const [toolName, def] of Object.entries(defs)) {
      if (def.partialRc?.tcpWireType) {
        covered.add(def.partialRc.tcpWireType);
        continue;
      }

      const yamlDef = findYamlToolDef(toolsData, toolName);
      covered.add(yamlDef?.wire_type || toolName);
    }
  }

  return covered;
}

function ignoredPluginSource(rel, ignoredFragments) {
  if (!rel.endsWith('.cpp')) return true;
  return ignoredFragments.some(fragment => rel.includes(fragment));
}

export async function collectPluginRegisteredCommands({
  privateDir,
  ignoredFragments = DEFAULT_IGNORED_PLUGIN_SOURCE_FRAGMENTS,
} = {}) {
  if (!privateDir) throw new Error('collectPluginRegisteredCommands requires privateDir');
  const files = await readdir(privateDir, { recursive: true });
  const commands = new Set();

  for (const rel of files) {
    if (ignoredPluginSource(rel, ignoredFragments)) continue;

    const source = await readFile(join(privateDir, rel), 'utf-8');
    for (const match of source.matchAll(/Registry\.Register\(TEXT\("([^"]+)"\)/g)) {
      commands.add(match[1]);
    }
    for (const match of source.matchAll(/Handlers\.Add\(TEXT\("([^"]+)"\)/g)) {
      commands.add(match[1]);
    }
  }

  return commands;
}

export function collectYamlTools(toolsData, { groups, managementTools }) {
  const management = [];
  const offline = [];
  const implementedLive = [];
  const exempted = [];
  const missingActiveLive = [];

  const { map: callableLiveTools, duplicates } = buildCallableToolMap(groups);

  for (const [toolName, def] of Object.entries(toolsData.management?.tools || {})) {
    management.push({
      name: `management.${toolName}`,
      toolset: 'management',
      toolName,
      def,
      implemented: managementTools.has(toolName),
    });
  }

  for (const [toolsetName, toolset] of Object.entries(toolsData.toolsets || {})) {
    for (const [toolName, def] of Object.entries(toolset.tools || {})) {
      const record = {
        name: `${toolsetName}.${toolName}`,
        toolset: toolsetName,
        toolName,
        layer: toolset.layer,
        def,
      };

      if (toolsetName === 'offline') {
        offline.push(record);
      } else if (isPlannedOrExcluded(def)) {
        exempted.push(record);
      } else if (callableLiveTools.has(toolName)) {
        implementedLive.push({ ...record, definitionGroup: callableLiveTools.get(toolName) });
      } else {
        missingActiveLive.push(record);
      }
    }
  }

  return {
    management,
    offline,
    implementedLive,
    exempted,
    missingActiveLive,
    duplicateCallableNames: duplicates,
    callableLiveTools,
  };
}

export function names(records) {
  return records.map(r => r.name).sort();
}

export function hasStructuredExemption(def) {
  return def?.status === 'planned' ||
    def?.discoverable === false ||
    typeof def?.replaced_by === 'string' ||
    def?.offline_fallback !== undefined ||
    typeof def?.exemption_reason === 'string';
}

export function collectNodeToolsMissingYaml(toolsData, groups, { allowMissing = new Set() } = {}) {
  const missing = [];
  for (const [groupName, defs] of groups) {
    for (const toolName of Object.keys(defs)) {
      if (allowMissing.has(toolName)) continue;
      if (!findYamlToolDef(toolsData, toolName)) {
        missing.push(`${groupName}.${toolName}`);
      }
    }
  }
  return missing.sort();
}

export function collectUncoveredPluginCommands(
  registeredCommands,
  coveredCommands,
  { allowInternal = new Map() } = {},
) {
  return [...registeredCommands]
    .filter(command => !coveredCommands.has(command) && !allowInternal.has(command))
    .sort();
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const runner = new TestRunner('Tool Surface Helpers');
  process.exit(runner.summary());
}
