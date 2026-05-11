// Focused tests for W-BP-Variables assignment workflow.
//
// Run: cd /d D:\DevTools\UEMCP\server && node test-blueprint-workflow-variables.mjs

import { ConnectionManager } from './connection-manager.mjs';
import { FakeTcpResponder, TestRunner, createTestConfig } from './test-helpers.mjs';
import { readFileSync } from 'node:fs';
import { load } from 'js-yaml';
import {
  initBlueprintsWriteTools,
  executeBlueprintsWriteTool,
  getBlueprintsWriteToolDefs,
} from './blueprints-write-tcp-tools.mjs';

const fakeToolsYaml = {
  toolsets: {
    'blueprints-write': {
      tools: {},
    },
  },
};
initBlueprintsWriteTools(fakeToolsYaml);

const t = new TestRunner('W-BP-Variables — Blueprint variable assignment workflow');

console.log('\n── Group 1: Tool definition and schema ──');

{
  const defs = getBlueprintsWriteToolDefs();
  const toolsYaml = load(readFileSync('../tools.yaml', 'utf-8'));
  const yamlDef = toolsYaml.toolsets?.['blueprints-write']?.tools?.add_variable_assignment;

  t.assert(yamlDef !== undefined,
    'add_variable_assignment is published in tools.yaml blueprints-write');
  t.assert(yamlDef?.wire_type === 'add_blueprint_variable_assignment',
    'add_variable_assignment YAML maps to add_blueprint_variable_assignment wire type');
  t.assert(defs.add_variable_assignment !== undefined,
    'add_variable_assignment tool is defined internally');
  if (defs.add_variable_assignment) {
    t.assert(defs.add_variable_assignment.isReadOp === false,
      'add_variable_assignment is a write op');
    t.assert(/literal/i.test(defs.add_variable_assignment.description),
      'description documents literal assignment');
    t.assert(/variable/i.test(defs.add_variable_assignment.description),
      'description documents variable-to-variable assignment');
  }
}

console.log('\n── Group 2: Literal assignment routing and metadata passthrough ──');

{
  const fake = new FakeTcpResponder();
  fake.on('ping', { status: 'success' });
  fake.on('add_blueprint_variable_assignment', {
    status: 'success',
    result: {
      graph_name: 'MoveStep',
      target_variable: 'Direction',
      assignment_kind: 'literal',
      requires_compile: true,
      nodes: [
        { role: 'set', node_id: 'SET-DIR', node_class: 'K2Node_VariableSet' },
      ],
      pins: [
        { role: 'target_value', name: 'Direction', category: 'real', default: '-1.0' },
      ],
      links: [],
    },
  });

  const { config } = createTestConfig('D:/FakeProject', fake);
  const cm = new ConnectionManager(config);

  const response = await executeBlueprintsWriteTool('add_variable_assignment', {
    blueprint_name: '/Game/UEMCP/BP_UEMCP_TimerMover',
    graph_name: 'MoveStep',
    target_variable: 'Direction',
    assignment: { kind: 'literal', value: -1.0 },
    node_position: [700, 200],
    compile: false,
  }, cm);

  const call = fake.lastCall('add_blueprint_variable_assignment');
  t.assert(call !== undefined,
    'add_variable_assignment reaches wire as add_blueprint_variable_assignment');
  t.assert(call.port === 55558,
    'add_variable_assignment routes to TCP:55558');
  t.assert(call.params.graph_name === 'MoveStep',
    'graph_name passes through');
  t.assert(call.params.assignment.kind === 'literal',
    'literal assignment kind passes through');
  t.assert(call.params.assignment.value === -1.0,
    'literal assignment value passes through');
  t.assert(call.params.node_position[0] === 700 && call.params.node_position[1] === 200,
    'node_position passes through');
  t.assert(response.result.requires_compile === true,
    'response can carry requires_compile metadata');
  t.assert(response.result.nodes[0].role === 'set',
    'response can carry node role metadata');
}

console.log('\n── Group 3: Variable-to-variable assignment with exec wiring ──');

{
  const fake = new FakeTcpResponder();
  fake.on('ping', { status: 'success' });
  fake.on('add_blueprint_variable_assignment', {
    status: 'success',
    result: {
      graph_name: 'MoveStep',
      target_variable: 'bMoving',
      assignment_kind: 'variable',
      source_variable: 'bShouldMove',
      requires_compile: true,
      nodes: [
        { role: 'get', node_id: 'GET-SHOULD', node_class: 'K2Node_VariableGet' },
        { role: 'set', node_id: 'SET-MOVING', node_class: 'K2Node_VariableSet' },
      ],
      pins: [
        { role: 'source_value', name: 'bShouldMove', category: 'bool' },
        { role: 'target_value', name: 'bMoving', category: 'bool' },
        { role: 'exec_in', name: 'execute', category: 'exec' },
      ],
      links: [
        { role: 'value', source_node_id: 'GET-SHOULD', target_node_id: 'SET-MOVING' },
        { role: 'exec', source_node_id: 'ENTRY', target_node_id: 'SET-MOVING' },
      ],
    },
  });

  const { config } = createTestConfig('D:/FakeProject', fake);
  const cm = new ConnectionManager(config);

  const response = await executeBlueprintsWriteTool('add_variable_assignment', {
    blueprint_name: '/Game/UEMCP/BP_UEMCP_TimerMover',
    graph_name: 'MoveStep',
    target_variable: 'bMoving',
    assignment: { kind: 'variable', source_variable: 'bShouldMove' },
    exec_from: { node_id: 'ENTRY', pin: 'then' },
    node_position: [500, 120],
  }, cm);

  const call = fake.lastCall('add_blueprint_variable_assignment');
  t.assert(call.params.assignment.kind === 'variable',
    'variable assignment kind passes through');
  t.assert(call.params.assignment.source_variable === 'bShouldMove',
    'source_variable passes through');
  t.assert(call.params.exec_from.node_id === 'ENTRY',
    'exec_from node id passes through');
  t.assert(call.params.exec_from.pin === 'then',
    'exec_from pin passes through');
  t.assert(response.result.links.some(link => link.role === 'value'),
    'response can carry value link metadata');
  t.assert(response.result.links.some(link => link.role === 'exec'),
    'response can carry exec link metadata');
}

console.log('\n── Group 4: Pre-wire validation ──');

{
  const fake = new FakeTcpResponder();
  fake.on('ping', { status: 'success' });
  fake.on('add_blueprint_variable_assignment', { status: 'success', result: {} });
  const { config } = createTestConfig('D:/FakeProject', fake);
  const cm = new ConnectionManager(config);

  await t.assertRejects(
    () => executeBlueprintsWriteTool('add_variable_assignment', {
      blueprint_name: 'BP',
      target_variable: 'Direction',
      assignment: { kind: 'literal' },
    }, cm),
    /value/i,
    'literal assignment requires value',
  );
  t.assert(fake.lastCall('add_blueprint_variable_assignment') === undefined,
    'invalid literal assignment does not reach wire');

  await t.assertRejects(
    () => executeBlueprintsWriteTool('add_variable_assignment', {
      blueprint_name: 'BP',
      target_variable: 'Direction',
      assignment: { kind: 'expression', value: 'Direction * -1' },
    }, cm),
    /Invalid|enum/i,
    'unsupported expression assignment kind is rejected at Zod layer',
  );
}

const exitCode = t.summary();
process.exit(exitCode);
