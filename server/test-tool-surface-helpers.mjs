import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TestRunner } from './test-helpers.mjs';
import { ToolIndex } from './tool-index.mjs';

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

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function hasOwnerMetadata(def) {
  return nonEmptyString(def?.owner) ||
    nonEmptyString(def?.owning_team) ||
    nonEmptyString(def?.review_owner) ||
    (Array.isArray(def?.owners) && def.owners.some(nonEmptyString));
}

export function hasStructuredExemption(def) {
  return nonEmptyString(def?.replaced_by) ||
    def?.offline_fallback !== undefined ||
    nonEmptyString(def?.exemption_reason) ||
    nonEmptyString(def?.note) ||
    hasOwnerMetadata(def);
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

export function buildToolIndex(toolsData) {
  const index = new ToolIndex();
  index.build(toolsData);
  return index;
}

export function topToolNames(index, query, maxResults = 5) {
  return index.search(query, maxResults).map(row => row.toolName);
}

export function isMutationRequirementKind(requirement) {
  return requirement === 'live_mutation' ||
    requirement === 'rc_mutation' ||
    requirement === 'python_exec';
}

function yamlRecordEntries(toolsData) {
  const records = [];
  for (const [toolName, def] of Object.entries(toolsData.management?.tools || {})) {
    records.push({ toolsetName: 'management', toolName, def });
  }
  for (const [toolsetName, toolset] of Object.entries(toolsData.toolsets || {})) {
    for (const [toolName, def] of Object.entries(toolset.tools || {})) {
      records.push({ toolsetName, toolName, def });
    }
  }
  return records;
}

function metadataImpliesMutationRisk(def = {}) {
  return def.mutates_asset === true ||
    def.mutates_level === true ||
    def.saves_asset === true ||
    def.compiles_asset === true;
}

export function collectRequirementMetadataMismatches(toolsData, getToolRequirement) {
  const mismatches = [];

  for (const { toolsetName, toolName, def } of yamlRecordEntries(toolsData)) {
    if (toolName === 'run_python_command') {
      const requirement = getToolRequirement(toolName, toolsetName, def);
      if (requirement !== 'python_exec') {
        mismatches.push(`${toolsetName}.${toolName}: expected python_exec, got ${requirement}`);
      }
      continue;
    }

    if (toolsetName === 'offline') {
      const requirement = getToolRequirement(toolName, toolsetName, def);
      if (requirement !== 'offline_read') {
        mismatches.push(`${toolsetName}.${toolName}: expected offline_read, got ${requirement}`);
      }
      continue;
    }

    if (!metadataImpliesMutationRisk(def)) continue;

    const requirement = getToolRequirement(toolName, toolsetName, def);
    if (!isMutationRequirementKind(requirement)) {
      mismatches.push(`${toolsetName}.${toolName}: metadata mutates/saves/compiles but requirement=${requirement}`);
    }
  }

  return mismatches.sort();
}

export function missingSourceNeedles(source, needles) {
  return needles.filter(needle => !source.includes(needle));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const runner = new TestRunner('Tool Surface Helpers');
  process.exit(runner.summary());
}
