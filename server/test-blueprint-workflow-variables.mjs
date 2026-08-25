// Focused tests for W-BP-Variables assignment workflow.
//
// Run: cd /d D:\DevTools\UEMCP\server && node test-blueprint-workflow-variables.mjs

import { join } from 'node:path';
import { ConnectionManager } from './connection-manager.mjs';
import { REPO_ROOT, FakeTcpResponder, TestRunner, createTestConfig } from './test-helpers.mjs';
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
  const toolsYaml = load(readFileSync(join(REPO_ROOT, 'tools.yaml'), 'utf-8'));
  const yamlDef = toolsYaml.toolsets?.['blueprints-write']?.tools?.add_variable_assignment;
  const defaultYamlDef = toolsYaml.toolsets?.['blueprints-write']?.tools?.set_variable_default;

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
  t.assert(defaultYamlDef !== undefined,
    'set_variable_default is published in tools.yaml blueprints-write');
  t.assert(defaultYamlDef?.wire_type === 'set_blueprint_variable_default',
    'set_variable_default YAML maps to set_blueprint_variable_default wire type');
  t.assert(defs.set_variable_default !== undefined,
    'set_variable_default tool is defined internally');
  if (defs.set_variable_default) {
    t.assert(defs.set_variable_default.isReadOp === false,
      'set_variable_default is a write op');
    t.assert(/default/i.test(defs.set_variable_default.description),
      'set_variable_default description documents defaults');
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

console.log('\n── Group 4: Variable default routing and response shape ──');

{
  const fake = new FakeTcpResponder();
  fake.on('ping', { status: 'success' });
  fake.on('set_blueprint_variable_default', {
    status: 'success',
    result: {
      variable_name: 'Speed',
      default_value: 350,
      dirty: true,
      requires_compile: true,
    },
  });

  const { config } = createTestConfig('D:/FakeProject', fake);
  const cm = new ConnectionManager(config);

  const response = await executeBlueprintsWriteTool('set_variable_default', {
    blueprint_name: '/Game/UEMCP/BP_TimerMover',
    variable_name: 'Speed',
    value: 350,
  }, cm);

  const call = fake.lastCall('set_blueprint_variable_default');
  t.assert(response.result.variable_name === 'Speed',
    'set_variable_default returns variable name');
  t.assert(response.result.default_value === 350,
    'set_variable_default returns default value');
  t.assert(response.result.dirty === true,
    'set_variable_default reports dirty:true');
  t.assert(response.result.requires_compile === true,
    'set_variable_default reports requires_compile:true');
  t.assert(call !== undefined,
    'set_variable_default reaches wire as set_blueprint_variable_default');
  t.assert(call.port === 55558,
    'set_variable_default routes to TCP:55558');
  t.assert(call.params.blueprint_name === '/Game/UEMCP/BP_TimerMover',
    'set_variable_default forwards blueprint_name');
  t.assert(call.params.variable_name === 'Speed',
    'set_variable_default forwards variable_name');
  t.assert(call.params.value === 350,
    'set_variable_default forwards scalar value');
  t.assert(call.params.compile === false,
    'set_variable_default defaults compile to false');
}

{
  const fake = new FakeTcpResponder();
  fake.on('ping', { status: 'success' });
  fake.on('set_blueprint_variable_default', {
    status: 'success',
    result: {
      variable_name: 'Speed',
      default_value: 350,
      dirty: true,
      requires_compile: false,
      compiled_ok: true,
      compile: { compiled_ok: true, num_errors: 0 },
    },
  });

  const { config } = createTestConfig('D:/FakeProject', fake);
  const cm = new ConnectionManager(config);

  const response = await executeBlueprintsWriteTool('set_variable_default', {
    blueprint_name: '/Game/UEMCP/BP_TimerMover',
    variable_name: 'Speed',
    value: 350,
    compile: true,
  }, cm);

  const call = fake.lastCall('set_blueprint_variable_default');
  t.assert(call.params.compile === true,
    'set_variable_default forwards compile:true');
  t.assert(response.result.compiled_ok === true,
    'set_variable_default can report compile success when compile:true');
  t.assert(response.result.requires_compile === false,
    'set_variable_default can clear requires_compile after successful compile');
}

{
  const fake = new FakeTcpResponder();
  fake.on('ping', { status: 'success' });
  fake.on('set_blueprint_variable_default', {
    status: 'error',
    code: 'COMPILE_FAILED',
    error: 'Blueprint compile failed after setting variable default: Speed',
    detail: {
      variable_name: 'Speed',
      default_value: 350,
      dirty: true,
      requires_compile: true,
      compiled_ok: false,
      compile: { compiled_ok: false, num_errors: 1 },
    },
  });

  const { config } = createTestConfig('D:/FakeProject', fake);
  const cm = new ConnectionManager(config);

  await t.assertRejects(
    () => executeBlueprintsWriteTool('set_variable_default', {
      blueprint_name: '/Game/UEMCP/BP_TimerMover',
      variable_name: 'Speed',
      value: 350,
      compile: true,
    }, cm),
    /compile failed/i,
    'set_variable_default propagates COMPILE_FAILED when compile:true fails',
  );
}

console.log('\n── Group 5: Variable default supported shapes ──');

{
  const fake = new FakeTcpResponder();
  fake.on('ping', { status: 'success' });
  fake.on('set_blueprint_variable_default', {
    status: 'success',
    result: {
      variable_name: 'Any',
      default_value: true,
      dirty: true,
      requires_compile: true,
    },
  });

  const { config } = createTestConfig('D:/FakeProject', fake);
  const cm = new ConnectionManager(config);

  for (const [variable_name, value] of [
    ['bEnabled', true],
    ['Count', 3],
    ['Speed', 350.5],
    ['Label', 'Mover'],
    ['Axis', [1, 0, 0]],
  ]) {
    await executeBlueprintsWriteTool('set_variable_default', {
      blueprint_name: '/Game/UEMCP/BP_TimerMover',
      variable_name,
      value,
    }, cm);
  }

  t.assert(fake.callsFor('set_blueprint_variable_default').length === 5,
    'set_variable_default accepts scalar and vector defaults');
  const vectorCall = fake.callsFor('set_blueprint_variable_default')[4];
  t.assert(Array.isArray(vectorCall.params.value) && vectorCall.params.value[0] === 1,
    'set_variable_default forwards vector [x,y,z] value');
}

console.log('\n── Group 6: Variable default pre-wire validation ──');

{
  const fake = new FakeTcpResponder();
  fake.on('ping', { status: 'success' });
  fake.on('set_blueprint_variable_default', { status: 'success', result: {} });
  const { config } = createTestConfig('D:/FakeProject', fake);
  const cm = new ConnectionManager(config);

  await t.assertRejects(
    () => executeBlueprintsWriteTool('set_variable_default', {
      blueprint_name: 'BP',
      variable_name: 'Axis',
      value: [1, 0],
    }, cm),
    /Array must contain exactly 3 element|too_small|too_big/i,
    'set_variable_default rejects malformed vector defaults before wire',
  );
  t.assert(fake.lastCall('set_blueprint_variable_default') === undefined,
    'invalid variable default does not reach wire');
}

console.log('\n── Group 7: Pre-wire validation ──');

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
