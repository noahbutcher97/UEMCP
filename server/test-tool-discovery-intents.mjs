// Tool discovery intent tests.
// Run from server/: node test-tool-discovery-intents.mjs

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { load } from 'js-yaml';

import { TestRunner } from './test-helpers.mjs';
import {
  buildToolIndex,
  topToolNames,
} from './test-tool-surface-helpers.mjs';

const t = new TestRunner('Tool Discovery Intent Tests');
const toolsData = load(await readFile(join('..', 'tools.yaml'), 'utf-8'));
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

assertTopIncludes('who references this asset', 'get_asset_references');
assertTopIncludesAny('PIE actor runtime state', ['get_pie_actor_state', 'sample_pie_actor_state']);
assertTopIncludes('Python command', 'run_python_command');
assertTopIncludes('list exports choose export', 'list_asset_exports');

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
