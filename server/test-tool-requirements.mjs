// Tool requirement classification tests.
//
// Run: cd server && node test-tool-requirements.mjs

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { load } from 'js-yaml';

import { TestRunner } from './test-helpers.mjs';
import {
  collectRequirementMetadataMismatches,
  isMutationRequirementKind,
} from './test-tool-surface-helpers.mjs';
import {
  MANAGEMENT_SESSION_STATE_TOOLS,
  getToolAnnotations,
} from './tool-annotations.mjs';
import { TOOL_REQUIREMENT_KINDS, getToolRequirement } from './tool-requirements.mjs';

const t = new TestRunner('Tool Requirement Tests');
const toolsData = load(await readFile(join('..', 'tools.yaml'), 'utf8'));

function toolDef(toolsetName, toolName) {
  if (toolsetName === 'management') return toolsData.management.tools[toolName];
  return toolsData.toolsets[toolsetName].tools[toolName];
}

function assertRequirement(toolsetName, toolName, expected) {
  const def = toolDef(toolsetName, toolName);
  t.assert(def !== undefined, `${toolsetName}.${toolName} exists in tools.yaml`);
  if (def === undefined) {
    return;
  }
  const actual = getToolRequirement(toolName, toolsetName, def);
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
assertRequirement('animation', 'get_anim_graph', TOOL_REQUIREMENT_KINDS.LIVE_READ);

const animGraphDef = toolDef('animation', 'get_anim_graph');
t.assert(
  animGraphDef.offline_fallback === 'bp_list_graphs' &&
    animGraphDef.offline_fallback_scope === 'partial' &&
    /pin topology/i.test(animGraphDef.offline_fallback_note || '') &&
    /linked_to/i.test(animGraphDef.offline_fallback_note || ''),
  'get_anim_graph marks bp_list_graphs as a partial offline fallback',
);

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

console.log('\n── Aggregate metadata agreement ──');

const metadataMismatches = collectRequirementMetadataMismatches(toolsData, getToolRequirement);
t.assert(
  metadataMismatches.length === 0,
  'YAML mutation metadata agrees with derived requirement kinds',
  metadataMismatches.join('; '),
);

t.assert(
  isMutationRequirementKind(TOOL_REQUIREMENT_KINDS.LIVE_MUTATION) &&
    isMutationRequirementKind(TOOL_REQUIREMENT_KINDS.RC_MUTATION) &&
    isMutationRequirementKind(TOOL_REQUIREMENT_KINDS.PYTHON_EXEC) &&
    !isMutationRequirementKind(TOOL_REQUIREMENT_KINDS.LIVE_READ),
  'mutation requirement helper recognizes live, RC, and Python mutation-risk kinds',
);

console.log('\n── Tool annotations ──');

const annotationCases = [
  ['project_info', TOOL_REQUIREMENT_KINDS.OFFLINE_READ, { readOnlyHint: true }],
  ['get_editor_state', TOOL_REQUIREMENT_KINDS.LIVE_READ, { readOnlyHint: true }],
  ['rc_get_property', TOOL_REQUIREMENT_KINDS.RC_READ, { readOnlyHint: true }],
  ['create_blueprint', TOOL_REQUIREMENT_KINDS.LIVE_MUTATION, { readOnlyHint: false, destructiveHint: true }],
  ['rc_set_property', TOOL_REQUIREMENT_KINDS.RC_MUTATION, { readOnlyHint: false, destructiveHint: true }],
  ['run_python_command', TOOL_REQUIREMENT_KINDS.PYTHON_EXEC, { readOnlyHint: false, destructiveHint: true }],
  ['list_toolsets', TOOL_REQUIREMENT_KINDS.MANAGEMENT, { readOnlyHint: true }],
  ['list_project_targets', TOOL_REQUIREMENT_KINDS.MANAGEMENT, { readOnlyHint: true }],
  ['connection_info', TOOL_REQUIREMENT_KINDS.MANAGEMENT, { readOnlyHint: false, destructiveHint: false }],
  ['detect_project', TOOL_REQUIREMENT_KINDS.MANAGEMENT, { readOnlyHint: false, destructiveHint: false }],
  ['find_tools', TOOL_REQUIREMENT_KINDS.MANAGEMENT, { readOnlyHint: false, destructiveHint: false }],
  ['enable_toolset', TOOL_REQUIREMENT_KINDS.MANAGEMENT, { readOnlyHint: false, destructiveHint: false }],
  ['disable_toolset', TOOL_REQUIREMENT_KINDS.MANAGEMENT, { readOnlyHint: false, destructiveHint: false }],
  ['attach_project', TOOL_REQUIREMENT_KINDS.MANAGEMENT, { readOnlyHint: false, destructiveHint: false }],
  ['detach_project', TOOL_REQUIREMENT_KINDS.MANAGEMENT, { readOnlyHint: false, destructiveHint: false }],
  ['refresh_project_context', TOOL_REQUIREMENT_KINDS.MANAGEMENT, { readOnlyHint: false, destructiveHint: false }],
];

const annotationResults = annotationCases.map(([toolName, requirement, expected]) => {
  const annotations = getToolAnnotations(toolName, requirement);
  t.assert(
    JSON.stringify(annotations) === JSON.stringify(expected),
    `${toolName} annotations match requirement policy`,
    `got ${JSON.stringify(annotations)}`,
  );
  t.assert(Object.isFrozen(annotations), `${toolName} annotations are frozen`);
  t.assert(!('idempotentHint' in annotations), `${toolName} annotations omit idempotentHint`);
  t.assert(!('openWorldHint' in annotations), `${toolName} annotations omit openWorldHint`);
  return annotations;
});

t.assert(
  new Set(annotationResults).size === annotationResults.length,
  'tool annotations return a new object for every call',
);

const expectedManagementSessionStateTools = [
  'connection_info',
  'detect_project',
  'find_tools',
  'enable_toolset',
  'disable_toolset',
  'attach_project',
  'detach_project',
  'refresh_project_context',
];
t.assert(MANAGEMENT_SESSION_STATE_TOOLS instanceof Set, 'management session-state policy remains a Set');
t.assert(
  Object.prototype.toString.call(MANAGEMENT_SESSION_STATE_TOOLS) === '[object Set]',
  'management session-state policy retains the Set type tag',
);
t.assert(
  MANAGEMENT_SESSION_STATE_TOOLS.size === expectedManagementSessionStateTools.length,
  'management session-state policy exposes Set size',
);
t.assert(
  MANAGEMENT_SESSION_STATE_TOOLS.has('connection_info') &&
    !MANAGEMENT_SESSION_STATE_TOOLS.has('list_toolsets'),
  'management session-state policy supports membership checks',
);
t.assert(
  JSON.stringify([...MANAGEMENT_SESSION_STATE_TOOLS]) === JSON.stringify(expectedManagementSessionStateTools),
  'management session-state policy supports iteration',
);
t.assert(
  typeof MANAGEMENT_SESSION_STATE_TOOLS.keys === 'function' &&
    JSON.stringify([...MANAGEMENT_SESSION_STATE_TOOLS.keys()]) === JSON.stringify(expectedManagementSessionStateTools),
  'management session-state policy supports keys()',
);
t.assert(
  typeof MANAGEMENT_SESSION_STATE_TOOLS.values === 'function' &&
    JSON.stringify([...MANAGEMENT_SESSION_STATE_TOOLS.values()]) === JSON.stringify(expectedManagementSessionStateTools),
  'management session-state policy supports values()',
);
t.assert(
  typeof MANAGEMENT_SESSION_STATE_TOOLS.entries === 'function' &&
    JSON.stringify([...MANAGEMENT_SESSION_STATE_TOOLS.entries()]) ===
      JSON.stringify(expectedManagementSessionStateTools.map((toolName) => [toolName, toolName])),
  'management session-state policy supports entries()',
);
t.assert(Object.isFrozen(MANAGEMENT_SESSION_STATE_TOOLS), 'management session-state policy facade is frozen');

for (const mutator of ['add', 'delete', 'clear']) {
  t.assert(!(mutator in MANAGEMENT_SESSION_STATE_TOOLS), `management session-state policy exposes no ${mutator} route`);
}

const policyMutationCases = [
  ['add', 'list_toolsets', 'list_toolsets'],
  ['delete', 'connection_info', 'connection_info'],
  ['clear', undefined, 'detect_project'],
];
for (const [mutator, argument, probeTool] of policyMutationCases) {
  const before = getToolAnnotations(probeTool, TOOL_REQUIREMENT_KINDS.MANAGEMENT);
  try {
    MANAGEMENT_SESSION_STATE_TOOLS[mutator](argument);
  } catch {
    // A read-only facade has no mutator to invoke.
  }
  const after = getToolAnnotations(probeTool, TOOL_REQUIREMENT_KINDS.MANAGEMENT);
  t.assert(
    JSON.stringify(after) === JSON.stringify(before),
    `${mutator} mutation attempt cannot change management annotations`,
    `before ${JSON.stringify(before)}, after ${JSON.stringify(after)}`,
  );
}

const nativePolicyMutationCases = [
  ['add', Set.prototype.add, 'list_toolsets', 'list_toolsets'],
  ['delete', Set.prototype.delete, 'connection_info', 'connection_info'],
  ['clear', Set.prototype.clear, undefined, 'detect_project'],
];
for (const [mutator, nativeMutator, argument, probeTool] of nativePolicyMutationCases) {
  const before = getToolAnnotations(probeTool, TOOL_REQUIREMENT_KINDS.MANAGEMENT);
  let mutationError;
  try {
    nativeMutator.call(MANAGEMENT_SESSION_STATE_TOOLS, argument);
  } catch (error) {
    mutationError = error;
  }
  const after = getToolAnnotations(probeTool, TOOL_REQUIREMENT_KINDS.MANAGEMENT);
  t.assert(mutationError instanceof TypeError, `native Set.prototype.${mutator} rejects the protected policy`);
  t.assert(
    JSON.stringify(after) === JSON.stringify(before),
    `native ${mutator} mutation attempt cannot change management annotations`,
    `before ${JSON.stringify(before)}, after ${JSON.stringify(after)}`,
  );
}

const forEachPairs = [];
const forEachSets = [];
let forEachMutationAttempted = false;
let forEachError;
const beforeForEachMutation = getToolAnnotations('list_toolsets', TOOL_REQUIREMENT_KINDS.MANAGEMENT);
try {
  MANAGEMENT_SESSION_STATE_TOOLS.forEach((value, key, policy) => {
    forEachPairs.push([value, key]);
    forEachSets.push(policy);
    if (!forEachMutationAttempted) {
      forEachMutationAttempted = true;
      try {
        policy.add('list_toolsets');
      } catch {
        // The callback receives the protected export, not the private Set.
      }
    }
  });
} catch (error) {
  forEachError = error;
}
const afterForEachMutation = getToolAnnotations('list_toolsets', TOOL_REQUIREMENT_KINDS.MANAGEMENT);
t.assert(
  forEachError === undefined &&
    JSON.stringify(forEachPairs) ===
      JSON.stringify(expectedManagementSessionStateTools.map((toolName) => [toolName, toolName])),
  'management session-state policy supports forEach()',
  forEachError?.message,
);
t.assert(
  forEachSets.length === expectedManagementSessionStateTools.length &&
    forEachSets.every((policy) => policy === MANAGEMENT_SESSION_STATE_TOOLS),
  'forEach() exposes only the protected policy as its third argument',
);
t.assert(
  forEachMutationAttempted && JSON.stringify(afterForEachMutation) === JSON.stringify(beforeForEachMutation),
  'forEach() callback cannot mutate management annotations through its policy argument',
  `before ${JSON.stringify(beforeForEachMutation)}, after ${JSON.stringify(afterForEachMutation)}`,
);

const inheritedReceiverProbe = Symbol('management-session-state-receiver');
const beforeInheritedReceiverEntries = [...MANAGEMENT_SESSION_STATE_TOOLS];
const beforeInheritedReceiverAnnotations = getToolAnnotations('list_toolsets', TOOL_REQUIREMENT_KINDS.MANAGEMENT);
let inheritedReceiver;
let inheritedReceiverEntries;
let inheritedReceiverAnnotations;
let inheritedReceiverMutationAttempted = false;
let inheritedReceiverError;
try {
  Object.defineProperty(Set.prototype, inheritedReceiverProbe, {
    configurable: true,
    get() {
      return this;
    },
  });
  inheritedReceiver = MANAGEMENT_SESSION_STATE_TOOLS[inheritedReceiverProbe];
  inheritedReceiverMutationAttempted = true;
  try {
    inheritedReceiver.add('list_toolsets');
  } catch {
    // An inherited accessor receives the protected export, which has no mutator route.
  }
  inheritedReceiverEntries = [...MANAGEMENT_SESSION_STATE_TOOLS];
  inheritedReceiverAnnotations = getToolAnnotations('list_toolsets', TOOL_REQUIREMENT_KINDS.MANAGEMENT);
} catch (error) {
  inheritedReceiverError = error;
} finally {
  if (inheritedReceiver instanceof Set && inheritedReceiver !== MANAGEMENT_SESSION_STATE_TOOLS) {
    Set.prototype.delete.call(inheritedReceiver, 'list_toolsets');
  }
  delete Set.prototype[inheritedReceiverProbe];
}
t.assert(
  inheritedReceiverError === undefined && inheritedReceiver === MANAGEMENT_SESSION_STATE_TOOLS,
  'inherited Set accessors receive only the protected policy export',
  inheritedReceiverError?.message,
);
t.assert(
  inheritedReceiverMutationAttempted &&
    JSON.stringify(inheritedReceiverEntries) === JSON.stringify(beforeInheritedReceiverEntries),
  'inherited-accessor mutation cannot change policy entries',
  `before ${JSON.stringify(beforeInheritedReceiverEntries)}, after ${JSON.stringify(inheritedReceiverEntries)}`,
);
t.assert(
  JSON.stringify(inheritedReceiverAnnotations) === JSON.stringify(beforeInheritedReceiverAnnotations),
  'inherited-accessor mutation cannot change management annotations',
  `before ${JSON.stringify(beforeInheritedReceiverAnnotations)}, after ${JSON.stringify(inheritedReceiverAnnotations)}`,
);
t.assert(
  !(inheritedReceiverProbe in Set.prototype),
  'inherited receiver probe is removed from Set.prototype',
);

let unknownRequirementError;
try {
  getToolAnnotations('synthetic_tool', 'future_requirement');
} catch (error) {
  unknownRequirementError = error;
}
t.assert(
  unknownRequirementError instanceof Error &&
    unknownRequirementError.message === 'Unknown tool requirement kind: future_requirement',
  'unknown requirement kind fails closed with the exact error message',
  `got ${unknownRequirementError?.message ?? 'no error'}`,
);

process.exit(t.summary());
