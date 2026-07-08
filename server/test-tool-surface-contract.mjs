// Tool surface contract gate.
// Run: cd D:\DevTools\UEMCP\.worktrees\tool-surface-contract-hardening\server && node test-tool-surface-contract.mjs

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
import {
  collectCoveredWireCommands,
  collectNodeToolsMissingYaml,
  collectPluginRegisteredCommands,
  collectUncoveredPluginCommands,
  collectYamlTools,
  hasStructuredExemption,
  names,
} from './test-tool-surface-helpers.mjs';

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

const INTERNAL_WIRE_COMMANDS = new Map();

const t = new TestRunner('Tool Surface Contract Gate');
const toolsData = load(await readFile(join('..', 'tools.yaml'), 'utf-8'));
const classification = collectYamlTools(toolsData, {
  groups: LIVE_DEFINITION_GROUPS,
  managementTools: MANAGEMENT_TOOLS,
});

const missingYamlForNodeDefs = collectNodeToolsMissingYaml(toolsData, LIVE_DEFINITION_GROUPS);
t.assert(
  missingYamlForNodeDefs.length === 0,
  'Node definition-map tools all have tools.yaml rows',
  missingYamlForNodeDefs.join(', '),
);

const malformedExemptions = classification.exempted
  .filter(record => !hasStructuredExemption(record.def))
  .map(record => record.name)
  .sort();
t.assert(
  malformedExemptions.length === 0,
  'planned/hidden YAML rows have structured exemption metadata',
  malformedExemptions.join(', '),
);

const registeredCommands = await collectPluginRegisteredCommands({
  privateDir: join('..', 'plugin', 'UEMCP', 'Source', 'UEMCP', 'Private'),
});
const coveredCommands = collectCoveredWireCommands(toolsData, LIVE_DEFINITION_GROUPS);
const uncoveredCommands = collectUncoveredPluginCommands(registeredCommands, coveredCommands, {
  allowInternal: INTERNAL_WIRE_COMMANDS,
});
t.assert(
  uncoveredCommands.length === 0,
  'plugin TCP commands are public-wrapper covered or explicitly internal-owned',
  uncoveredCommands.join(', '),
);

const activeMissing = names(classification.missingActiveLive);
t.assert(
  activeMissing.length === 0,
  'active live YAML rows have callable Node definition maps',
  activeMissing.join(', '),
);

process.exit(t.summary());
