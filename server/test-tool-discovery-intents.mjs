// Tool discovery intent tests.
// Run from server/: node test-tool-discovery-intents.mjs

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { load } from 'js-yaml';

import { REPO_ROOT, TestRunner } from './test-helpers.mjs';
import {
  buildToolIndex,
  topToolNames,
} from './test-tool-surface-helpers.mjs';

const t = new TestRunner('Tool Discovery Intent Tests');
const toolsData = load(await readFile(join(REPO_ROOT, 'tools.yaml'), 'utf-8'));
const index = buildToolIndex(toolsData);

function assertTopIncludes(query, expected, maxResults = 5) {
  const names = topToolNames(index, query, maxResults);
  t.assert(
    names.includes(expected),
    `find_tools intent "${query}" includes ${expected} in top ${maxResults}`,
    `got ${names.join(', ')}`,
  );
}

function assertTopIncludesAny(query, expectedAny, maxResults = 5) {
  const names = topToolNames(index, query, maxResults);
  const matched = expectedAny.some(name => names.includes(name));
  t.assert(
    matched,
    `find_tools intent "${query}" includes one of ${expectedAny.join(', ')} in top ${maxResults}`,
    `got ${names.join(', ')}`,
  );
}

assertTopIncludes('Control Rig pins and links', 'get_rigvm_graph');
assertTopIncludes('offline RigVM graph', 'read_saved_asset_inspection');
assertTopIncludes('export RigVM graph', 'export_asset_inspection');
assertTopIncludes('create data asset from subclass', 'create_data_asset');
assertTopIncludes('edit nested numeric data asset property', 'set_data_asset_property');
assertTopIncludes('read unsaved data asset property', 'get_data_asset_property');
assertTopIncludes('inspect chooser table rows fallback animation', 'get_chooser_table');
assertTopIncludes('open saved editor map', 'open_map');
assertTopIncludes('blueprint graph pins saved function inspect', 'inspect_blueprint_inputs');
assertTopIncludes('blueprint node pins function call arguments', 'inspect_blueprint_inputs');
assertTopIncludes('who references this asset', 'get_asset_references');
assertTopIncludesAny('PIE actor runtime state', ['get_pie_actor_state', 'sample_pie_actor_state']);
assertTopIncludes('Python command', 'run_python_command');
assertTopIncludes('list exports choose export', 'list_asset_exports');
const enhancedQuery = 'bind Enhanced Input action to pawn';
assertTopIncludes(enhancedQuery, 'find_graph_actions', 3);
const inputRanking = topToolNames(index, enhancedQuery, 30);
t.assert(inputRanking.indexOf('find_graph_actions') < inputRanking.indexOf('add_input_action_node'),
  'Enhanced Input discovery precedes the legacy writer', inputRanking.join(', '));
assertTopIncludes('play animation sequence in AnimGraph', 'find_graph_actions', 3);
assertTopIncludes('add legacy named input mapping event', 'add_input_action_node', 3);
assertTopIncludes('hold trigger Started Completed Canceled early release', 'place_graph_action', 3);

const animGraphNames = topToolNames(index, 'AnimGraph state machine slot layered blend', 8);
t.assert(
  animGraphNames.includes('get_anim_graph'),
  'AnimGraph semantic readback routes to get_anim_graph',
  `got ${animGraphNames.join(', ')}`,
);

const animGraphPinNames = topToolNames(index, 'full pin level AnimGraph visual edge wiring', 8);
t.assert(
  animGraphPinNames.includes('get_anim_graph'),
  'AnimGraph pin-level wiring intent routes to get_anim_graph',
  `got ${animGraphPinNames.join(', ')}`,
);

process.exit(t.summary());
