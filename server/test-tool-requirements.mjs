// Tool requirement classification tests.
//
// Run: cd server && node test-tool-requirements.mjs

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { load } from 'js-yaml';

import { TestRunner } from './test-helpers.mjs';
import { TOOL_REQUIREMENT_KINDS, getToolRequirement } from './tool-requirements.mjs';

const t = new TestRunner('Tool Requirement Tests');
const toolsData = load(await readFile(join('..', 'tools.yaml'), 'utf8'));

function toolDef(toolsetName, toolName) {
  if (toolsetName === 'management') return toolsData.management.tools[toolName];
  return toolsData.toolsets[toolsetName].tools[toolName];
}

function assertRequirement(toolsetName, toolName, expected) {
  const actual = getToolRequirement(toolName, toolsetName, toolDef(toolsetName, toolName));
  t.assert(actual === expected, `${toolsetName}.${toolName} -> ${expected}`, `got ${actual}`);
}

assertRequirement('management', 'connection_info', TOOL_REQUIREMENT_KINDS.MANAGEMENT);
assertRequirement('offline', 'project_info', TOOL_REQUIREMENT_KINDS.OFFLINE_READ);
assertRequirement('editor-utility', 'get_editor_state', TOOL_REQUIREMENT_KINDS.LIVE_READ);
assertRequirement('blueprints-write', 'create_blueprint', TOOL_REQUIREMENT_KINDS.LIVE_MUTATION);
assertRequirement('input-and-pie', 'start_pie', TOOL_REQUIREMENT_KINDS.LIVE_MUTATION);
assertRequirement('remote-control', 'rc_get_property', TOOL_REQUIREMENT_KINDS.RC_READ);
assertRequirement('remote-control', 'rc_set_property', TOOL_REQUIREMENT_KINDS.RC_MUTATION);
assertRequirement('editor-utility', 'run_python_command', TOOL_REQUIREMENT_KINDS.PYTHON_EXEC);
assertRequirement('editor-utility', 'delete_asset_safe', TOOL_REQUIREMENT_KINDS.LIVE_MUTATION);

const unknownRead = getToolRequirement('synthetic_read', 'actors', {
  availability_layer: 'tcp-55558',
  transport_layer: 'tcp-55558',
});
t.assert(unknownRead === TOOL_REQUIREMENT_KINDS.LIVE_READ, `tcp default is LIVE_READ (got ${unknownRead})`);

const unknownRc = getToolRequirement('synthetic_rc_read', 'remote-control', {
  availability_layer: 'http-30010',
  transport_layer: 'http-30010',
});
t.assert(unknownRc === TOOL_REQUIREMENT_KINDS.RC_READ, `http default is RC_READ (got ${unknownRc})`);

process.exit(t.summary());
