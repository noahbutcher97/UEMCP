// Registry Truthfulness Gate
// Run: cd D:\DevTools\UEMCP\server && node test-tool-registry-truth.mjs
//
// Verifies that active tools.yaml entries correspond to callable Node server
// definition maps. This is intentionally non-editor and does not import
// server.mjs, because server.mjs starts the MCP stdio server at module load.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { load } from 'js-yaml';
import { TestRunner } from './test-helpers.mjs';
import { getActorsToolDefs } from './actors-tcp-tools.mjs';
import { getBlueprintsWriteToolDefs } from './blueprints-write-tcp-tools.mjs';
import { getWidgetsToolDefs } from './widgets-tcp-tools.mjs';
import { getMenhanceToolDefs } from './menhance-tcp-tools.mjs';
import { getRcToolDefs } from './rc-tools.mjs';
import { getM5AnimationToolDefs } from './m5-animation-tools.mjs';
import { getM5MaterialsToolDefs } from './m5-materials-tools.mjs';
import { getM5InputPieToolDefs } from './m5-input-pie-tools.mjs';
import { getM5GeometryToolDefs } from './m5-geometry-tools.mjs';
import { getM5EditorUtilityToolDefs } from './m5-editor-utility-tools.mjs';

const MANAGEMENT_TOOLS = new Set([
  'connection_info',
  'detect_project',
  'find_tools',
  'list_toolsets',
  'enable_toolset',
  'disable_toolset',
  'list_project_targets',
  'attach_project',
  'detach_project',
  'refresh_project_context',
]);

const LIVE_DEFINITION_GROUPS = [
  ['actors', getActorsToolDefs()],
  ['blueprints-write', getBlueprintsWriteToolDefs()],
  ['widgets', getWidgetsToolDefs()],
  ['m-enhance', getMenhanceToolDefs()],
  ['remote-control', getRcToolDefs()],
  ['m5-animation', getM5AnimationToolDefs()],
  ['m5-materials', getM5MaterialsToolDefs()],
  ['m5-input-and-pie', getM5InputPieToolDefs()],
  ['m5-geometry', getM5GeometryToolDefs()],
  ['m5-editor-utility', getM5EditorUtilityToolDefs()],
];

function isPlannedOrExcluded(def) {
  return def?.status === 'planned' || def?.discoverable === false;
}

function buildCallableToolMap(groups) {
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

function collectYamlTools(toolsData) {
  const management = [];
  const offline = [];
  const implementedLive = [];
  const exempted = [];
  const missingActiveLive = [];

  const { map: callableLiveTools, duplicates } = buildCallableToolMap(LIVE_DEFINITION_GROUPS);

  for (const [toolName, def] of Object.entries(toolsData.management?.tools || {})) {
    management.push({
      name: `management.${toolName}`,
      toolset: 'management',
      toolName,
      def,
      implemented: MANAGEMENT_TOOLS.has(toolName),
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

function names(records) {
  return records.map(r => r.name).sort();
}

function printRegistryReport(classification) {
  console.log('\nRegistry truthfulness classification:');
  console.log(`  management tools:            ${classification.management.length}`);
  console.log(`  offline tools:               ${classification.offline.length}`);
  console.log(`  implemented live tools:      ${classification.implementedLive.length}`);
  console.log(`  planned/excluded exemptions: ${classification.exempted.length}`);
  console.log(`  missing active live tools:   ${classification.missingActiveLive.length}`);

  if (classification.exempted.length > 0) {
    console.log('\nPlanned/excluded tools:');
    for (const n of names(classification.exempted)) console.log(`  - ${n}`);
  }

  if (classification.missingActiveLive.length > 0) {
    console.log('\nMissing active live tools:');
    for (const n of names(classification.missingActiveLive)) console.log(`  - ${n}`);
  }
}

const runner = new TestRunner('Registry Truthfulness Gate');
const toolsYaml = await readFile(join('..', 'tools.yaml'), 'utf-8');
const toolsData = load(toolsYaml);
const classification = collectYamlTools(toolsData);

printRegistryReport(classification);

runner.assert(
  classification.duplicateCallableNames.length === 0,
  'callable live definition maps do not duplicate tool names',
  classification.duplicateCallableNames.join(', '),
);

const unregisteredManagement = classification.management
  .filter(t => !t.implemented)
  .map(t => t.name)
  .sort();
runner.assert(
  unregisteredManagement.length === 0,
  'management YAML tools match directly registered management tools',
  unregisteredManagement.join(', '),
);

runner.assert(
  classification.offline.length === Object.keys(toolsData.toolsets.offline.tools).length,
  'offline tools are classified separately',
);

const missingNames = names(classification.missingActiveLive);
runner.assert(
  missingNames.length === 0,
  'active live YAML tools all have callable Node definition maps',
  missingNames.join(', '),
);

process.exit(runner.summary());
