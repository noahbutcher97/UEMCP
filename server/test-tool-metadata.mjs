// Tool metadata schema validation
// Run: cd D:\DevTools\UEMCP\server && node test-tool-metadata.mjs
//
// Guards the first per-tool metadata pass that splits user-facing toolset
// grouping from availability, transport, editor/PIE, mutation, persistence,
// compile, and offline fallback semantics.

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { load } from 'js-yaml';
import * as UemcpServerModule from './create-uemcp-server.mjs';
import { getActorsToolDefs } from './actors-tcp-tools.mjs';
import { getBlueprintsWriteToolDefs } from './blueprints-write-tcp-tools.mjs';
import { FakeMcpTransport } from './test-mcp-fake-transport.mjs';
import { getM5AnimationToolDefs } from './m5-animation-tools.mjs';
import { getM5EditorUtilityToolDefs } from './m5-editor-utility-tools.mjs';
import { getM5GeometryToolDefs } from './m5-geometry-tools.mjs';
import { getM5InputPieToolDefs } from './m5-input-pie-tools.mjs';
import { getM5MaterialsToolDefs } from './m5-materials-tools.mjs';
import { getMenhanceToolDefs } from './menhance-tcp-tools.mjs';
import { buildPropertyReadHandlers } from './offline-tools.mjs';
import {
  CONFIGURED_PROPERTY_READ_REASON_CODES,
  GENERIC_CONTAINER_FALLBACK_REASON,
  PROPERTY_READ_REASON_GROUPS,
  REQUIRED_CONTAINER_PROPERTY_TYPES,
} from './property-read-contract.mjs';
import { getRcToolDefs } from './rc-tools.mjs';
import { REPO_ROOT, TestRunner } from './test-helpers.mjs';
import { getToolAnnotations } from './tool-annotations.mjs';
import { getToolRequirement } from './tool-requirements.mjs';
import { getWidgetsToolDefs } from './widgets-tcp-tools.mjs';
import {
  SERVER_INSTRUCTIONS,
  SERVER_INSTRUCTION_LIMIT_BYTES,
  SERVER_PREFIX_LIMIT_BYTES,
  TOOL_DESCRIPTION_LIMIT_BYTES,
  TOOLSET_TIPS,
  utf8Bytes,
} from './server-guidance.mjs';

const ALLOWED_STATUS = new Set(['shipped', 'planned', 'deprecated', 'hidden']);
const ALLOWED_LAYERS = new Set(['offline', 'tcp-55558', 'http-30010']);
const REQUIRED_FIELDS = [
  'status',
  'availability_layer',
  'transport_layer',
  'requires_editor',
  'requires_pie',
  'mutates_asset',
  'mutates_level',
  'saves_asset',
  'compiles_asset',
  'offline_fallback',
];
const BOOLEAN_FIELDS = [
  'requires_editor',
  'requires_pie',
  'mutates_asset',
  'mutates_level',
  'saves_asset',
  'compiles_asset',
];
const __dirname = dirname(fileURLToPath(import.meta.url));

const MANAGEMENT_SESSION_STATE_NAMES = Object.freeze([
  'connection_info',
  'detect_project',
  'find_tools',
  'enable_toolset',
  'disable_toolset',
  'attach_project',
  'detach_project',
  'refresh_project_context',
  'wait_for_editor',
]);
const MANAGEMENT_INSPECTION_NAMES = Object.freeze([
  'list_toolsets',
  'list_project_targets',
]);
const SESSION_STATE_ANNOTATIONS = Object.freeze({ readOnlyHint: false, destructiveHint: false });
const INSPECTION_ANNOTATIONS = Object.freeze({ readOnlyHint: true });
const SUPPORTED_CLIENT_BRANDS = Object.freeze([
  'Claude',
  'Codex',
  'Gemini',
  'ChatGPT',
  'Visual Studio Code',
  'VS Code',
]);
const NATIVE_TOOL_TOKENS = Object.freeze(['`Read`', '`Grep`', '`Glob`']);

const REQUIRED_ANNOTATED_TOOLS = new Set([
  // RC-backed semantic delegates.
  'set_material_parameter',
  'list_material_parameters',
  'get_curve_asset',
  'get_mesh_info',

  // Representative high-risk categories.
  'create_blueprint',
  'add_component',
  'create_widget',
  'add_text_block',
  'add_button',
  'bind_widget_event',
  'start_pie',
  'add_widget_to_viewport',
  'run_python_command',
  'delete_asset_safe',
  'get_asset_preview_render',
  'take_screenshot',

  // Source-backed shipped live authoring tools.
  'create_material',
  'create_material_instance',
  'create_input_action',
  'create_mapping_context',
  'add_mapping',
  'create_montage',
  'add_montage_section',
  'add_montage_notify',
]);

function collectTools(toolsData) {
  const records = new Map();

  for (const [name, def] of Object.entries(toolsData.management?.tools || {})) {
    records.set(name, { name, toolsetName: 'management', toolsetLayer: null, def });
  }

  for (const [toolsetName, toolset] of Object.entries(toolsData.toolsets || {})) {
    for (const [name, def] of Object.entries(toolset.tools || {})) {
      records.set(name, { name, toolsetName, toolsetLayer: toolset.layer, def });
    }
  }

  return records;
}

function validateToolMetadata(record) {
  const errors = [];
  const { name, def } = record;

  for (const field of REQUIRED_FIELDS) {
    if (!(field in def)) errors.push(`${name}: missing ${field}`);
  }

  if ('status' in def && !ALLOWED_STATUS.has(def.status)) {
    errors.push(`${name}: invalid status ${JSON.stringify(def.status)}`);
  }

  for (const field of ['availability_layer', 'transport_layer']) {
    if (field in def && !ALLOWED_LAYERS.has(def[field])) {
      errors.push(`${name}: invalid ${field} ${JSON.stringify(def[field])}`);
    }
  }

  for (const field of BOOLEAN_FIELDS) {
    if (field in def && typeof def[field] !== 'boolean') {
      errors.push(`${name}: ${field} must be boolean`);
    }
  }

  if ('offline_fallback' in def) {
    const fallback = def.offline_fallback;
    const ok = fallback === false || (typeof fallback === 'string' && fallback.length > 0);
    if (!ok) errors.push(`${name}: offline_fallback must be false or non-empty string`);
  }

  return errors;
}

function metadataFieldCount(def) {
  return REQUIRED_FIELDS.filter(field => field in def).length;
}

function hasCapabilityMetadata(def) {
  return 'availability_layer' in def || 'transport_layer' in def;
}

function collectStringSurfaces(value, surface, name = surface, strings = []) {
  if (typeof value === 'string') {
    strings.push({ surface, name, value });
  } else if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      collectStringSurfaces(item, surface, `${name}[${index}]`, strings);
    }
  } else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      collectStringSurfaces(item, surface, `${name}.${key}`, strings);
    }
  }
  return strings;
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function findProviderSpecificTokens(surfaces) {
  const matches = [];
  for (const { surface, name, value } of surfaces) {
    if (typeof value !== 'string') continue;
    for (const token of SUPPORTED_CLIENT_BRANDS) {
      const wordToken = new RegExp(`(?:^|[^a-z0-9])${escapeRegex(token)}(?=$|[^a-z0-9])`, 'i');
      if (wordToken.test(value)) matches.push(`${surface}/${name}/${token}`);
    }
    for (const token of NATIVE_TOOL_TOKENS) {
      if (value.toLocaleLowerCase().includes(token.toLocaleLowerCase())) {
        matches.push(`${surface}/${name}/${token}`);
      }
    }
  }
  return matches;
}

function extractMarkdownSection(source, heading) {
  const start = source.indexOf(heading);
  const end = source.indexOf('\n### ', start + heading.length);
  return start === -1 ? '' : source.slice(start, end === -1 ? source.length : end);
}

function extractReasonCodeTaxonomy(source) {
  const section = extractMarkdownSection(source, '### Reason-Code Taxonomy');
  return new Set([...section.matchAll(/`([a-z0-9_]+)`/g)].map(match => match[1]));
}

function extractLabeledCodeSet(source, label) {
  const line = source.split(/\r?\n/)
    .find(candidate => candidate.trimStart().startsWith(label));
  return new Set([...(line ?? '').matchAll(/`([^`]+)`/g)].map(match => match[1]));
}

function compareSets(expected, actual) {
  return {
    missing: [...expected].filter(value => !actual.has(value)).sort(),
    extra: [...actual].filter(value => !expected.has(value)).sort(),
  };
}

function annotationsMatch(actual, expected) {
  if (!actual || typeof actual !== 'object') return false;
  const actualKeys = Object.keys(actual).sort();
  const expectedKeys = Object.keys(expected).sort();
  return actualKeys.length === expectedKeys.length &&
    actualKeys.every((key, index) => key === expectedKeys[index] && actual[key] === expected[key]);
}

function literalManagementAnnotations() {
  return new Map([
    ...MANAGEMENT_SESSION_STATE_NAMES.map(name => [name, SESSION_STATE_ANNOTATIONS]),
    ...MANAGEMENT_INSPECTION_NAMES.map(name => [name, INSPECTION_ANNOTATIONS]),
  ]);
}

function captureError(fn) {
  try {
    fn();
    return null;
  } catch (error) {
    return error;
  }
}

const t = new TestRunner('Tool Metadata Schema');
const toolsYaml = await readFile(join(REPO_ROOT, 'tools.yaml'), 'utf-8');
const toolsData = load(toolsYaml);
const tools = collectTools(toolsData);
const toolSurfaceDoc = await readFile(join(REPO_ROOT, 'docs', 'specs', 'tool-surface.md'), 'utf-8');

console.log('\n── Provider-neutral guidance budgets ──');
t.assert(SERVER_PREFIX_LIMIT_BYTES === 512, 'server prefix budget is 512 UTF-8 bytes');
t.assert(SERVER_INSTRUCTION_LIMIT_BYTES === 2048, 'server instruction budget is 2 KiB');
t.assert(TOOL_DESCRIPTION_LIMIT_BYTES === 1800, 'tool description budget is 1,800 UTF-8 bytes');
t.assert(Object.isFrozen(TOOLSET_TIPS), 'toolset guidance metadata is immutable');
t.assert(utf8Bytes(SERVER_INSTRUCTIONS) < SERVER_INSTRUCTION_LIMIT_BYTES,
  'server instructions are below 2 KiB', `got ${utf8Bytes(SERVER_INSTRUCTIONS)} bytes`);
t.assert(
  SERVER_INSTRUCTIONS.slice(0, 512).includes('connection_info') &&
    SERVER_INSTRUCTIONS.slice(0, 512).includes('find_tools(query)'),
  'first 512 characters contain the discovery workflow',
);

const serverPrefix = Buffer.from(SERVER_INSTRUCTIONS, 'utf8')
  .subarray(0, SERVER_PREFIX_LIMIT_BYTES)
  .toString('utf8');
t.assert(
  serverPrefix.includes('Unreal Engine') &&
    serverPrefix.includes('Use it for') &&
    serverPrefix.includes('connection_info') &&
    serverPrefix.includes('find_tools(query)'),
  'first 512 UTF-8 bytes are self-contained discovery guidance',
  `got ${JSON.stringify(serverPrefix)}`,
);

const guidanceSurfaces = [
  { surface: 'runtime-guidance', name: 'SERVER_INSTRUCTIONS', value: SERVER_INSTRUCTIONS },
  ...collectStringSurfaces(TOOLSET_TIPS, 'runtime-guidance', 'TOOLSET_TIPS'),
];
const yamlDescriptionSurfaces = [...tools.values()].map(record => ({
  surface: 'tools.yaml ToolIndex description',
  name: record.name,
  value: record.def.description,
}));
const staticProviderSpecificMatches = findProviderSpecificTokens([
  ...guidanceSurfaces,
  ...yamlDescriptionSurfaces,
]);
t.assert(staticProviderSpecificMatches.length === 0,
  'runtime guidance and every structured tools.yaml description, including planned rows, avoid supported-client brands and exact native-tool tokens',
  staticProviderSpecificMatches.join('\n'));

console.log('\n── read_asset_properties reason-code taxonomy ──');
t.assert(
  Object.isFrozen(PROPERTY_READ_REASON_GROUPS) &&
    Object.values(PROPERTY_READ_REASON_GROUPS).every(group => Object.isFrozen(group)) &&
    Object.isFrozen(CONFIGURED_PROPERTY_READ_REASON_CODES) &&
    Object.isFrozen(REQUIRED_CONTAINER_PROPERTY_TYPES),
  'read_asset_properties reason and container contracts are immutable',
);

const {
  structHandlers: configuredStructHandlers,
  containerHandlers: configuredContainerHandlers,
} = buildPropertyReadHandlers();
const missingConfiguredContainerHandlers = REQUIRED_CONTAINER_PROPERTY_TYPES
  .filter(type => typeof configuredContainerHandlers.get(type) !== 'function');
t.assert(
  missingConfiguredContainerHandlers.length === 0,
  'read_asset_properties runtime handler factory configures every contracted container type',
  `missing handlers: ${missingConfiguredContainerHandlers.join(', ')}`,
);

const documentedReasonCodes = extractReasonCodeTaxonomy(toolSurfaceDoc);
t.assert(
  typeof GENERIC_CONTAINER_FALLBACK_REASON === 'string' &&
    !documentedReasonCodes.has(GENERIC_CONTAINER_FALLBACK_REASON),
  'Reason-Code Taxonomy excludes the configured-call-path-unreachable generic container fallback',
  `generic-only reason=${JSON.stringify(GENERIC_CONTAINER_FALLBACK_REASON)}; documented=${documentedReasonCodes.has(GENERIC_CONTAINER_FALLBACK_REASON)}`,
);
const contractedReasonCodes = new Set(CONFIGURED_PROPERTY_READ_REASON_CODES);
const undocumentedCurrentReasonCodes = [...contractedReasonCodes]
  .filter(code => !documentedReasonCodes.has(code))
  .sort();
const nonCurrentDocumentedReasonCodes = [...documentedReasonCodes]
  .filter(code => !contractedReasonCodes.has(code))
  .sort();
t.assert(
  undocumentedCurrentReasonCodes.length === 0 && nonCurrentDocumentedReasonCodes.length === 0,
  'Reason-Code Taxonomy exactly matches current read_asset_properties parser and bounded subobject emissions',
  `undocumented current: ${undocumentedCurrentReasonCodes.join(', ')}; cross-tool or historical: ${nonCurrentDocumentedReasonCodes.join(', ')}`,
);

const supportedValuesSection = extractMarkdownSection(toolSurfaceDoc, '### Supported Values And Boundaries');
const expectedMapKeyCapabilities = new Set(['scalar']);
const expectedMapValueCapabilities = new Set([
  'scalar',
  'StructProperty',
  'SoftObjectProperty',
  'SoftClassProperty',
]);
const documentedMapKeyCapabilities = extractLabeledCodeSet(supportedValuesSection, '- Map keys:');
const documentedMapValueCapabilities = extractLabeledCodeSet(supportedValuesSection, '- Map values:');
const mapKeyDelta = compareSets(expectedMapKeyCapabilities, documentedMapKeyCapabilities);
const mapValueDelta = compareSets(expectedMapValueCapabilities, documentedMapValueCapabilities);
t.assert(
  mapKeyDelta.missing.length === 0 && mapKeyDelta.extra.length === 0 &&
    mapValueDelta.missing.length === 0 && mapValueDelta.extra.length === 0 &&
    supportedValuesSection.includes('`map_value_type_unsupported`'),
  'durable map capability sets exactly match contracted key/value categories',
  `key missing: ${mapKeyDelta.missing.join(', ')}; key extra: ${mapKeyDelta.extra.join(', ')}; ` +
    `value missing: ${mapValueDelta.missing.join(', ')}; value extra: ${mapValueDelta.extra.join(', ')}`,
);
const configuredStructs = new Set([...configuredStructHandlers.keys()].map(structName =>
  structName.startsWith('F') ? structName : `F${structName}`));
const documentedStructs = extractLabeledCodeSet(supportedValuesSection, '- Engine structs:');
const structDelta = compareSets(configuredStructs, documentedStructs);
t.assert(
  structDelta.missing.length === 0 && structDelta.extra.length === 0,
  'durable engine-struct set exactly matches configured handlers',
  `missing: ${structDelta.missing.join(', ')}; extra: ${structDelta.extra.join(', ')}`,
);

const exportSelectionSection = extractMarkdownSection(toolSurfaceDoc, '### Export And Property Selection');
const documentedExportSelectionReasons = [
  'blueprint_cdo',
  'package_root_name_match',
  'root_asset_export',
  'first_asset_export',
  'first_export_fallback',
  'explicit_export_name',
  'explicit_export_index',
];
const documentedRequestedPropertyStatuses = [
  'serialized',
  'unsupported',
  'not_serialized_default',
  'unknown_due_to_truncation',
];
t.assert(
  exportSelectionSection.includes('`export_selection_reason`') &&
    documentedExportSelectionReasons.every(reason => exportSelectionSection.includes(`\`${reason}\``)),
  'durable export-selection contract names the response field and every emitted reason',
  `section: ${JSON.stringify(exportSelectionSection)}`,
);
t.assert(
  exportSelectionSection.includes('`requested_properties`') &&
    documentedRequestedPropertyStatuses.every(status => exportSelectionSection.includes(`\`${status}\``)),
  'durable requested-property contract names the response field and every row status',
  `section: ${JSON.stringify(exportSelectionSection)}`,
);
t.assert(
  !exportSelectionSection.includes('`no_cdo_export_found`') &&
    !exportSelectionSection.includes('`root_component_parse_failed`'),
  'read_asset_properties contract excludes reason codes emitted only by sibling tools',
);

const actorOfflineTip = 'Use the client\'s native source-search capability to find C++ class names under Source/, then use get_actor_properties to inspect level instances.';
const blueprintOfflineTip = 'Use the client\'s native source-search capability to inspect C++ base-class signatures before adding function or event nodes. Confirm event names exactly.';
t.assert(
  TOOLSET_TIPS.actors.workflows.some(workflow => workflow.tip === actorOfflineTip),
  'actors offline workflow uses the provider-neutral source-search tip',
);
t.assert(
  TOOLSET_TIPS['blueprints-write'].workflows.some(workflow => workflow.tip === blueprintOfflineTip),
  'blueprints-write offline workflow uses the provider-neutral source-search tip',
);

const originalActorCore = TOOLSET_TIPS.actors.core;
const originalActorWorkflow = TOOLSET_TIPS.actors.workflows[0].tip;
const originalActorWorkflowCount = TOOLSET_TIPS.actors.workflows.length;
const originalActorRequirementCount = TOOLSET_TIPS.actors.workflows[0].requires.length;
const tipMutationMarker = 'MUTATED TOOLSET TIPS';
t.assert(
  Object.isFrozen(TOOLSET_TIPS.actors) &&
    Object.isFrozen(TOOLSET_TIPS.actors.core) &&
    Object.isFrozen(TOOLSET_TIPS.actors.workflows) &&
    Object.isFrozen(TOOLSET_TIPS.actors.workflows[0]) &&
    Object.isFrozen(TOOLSET_TIPS.actors.workflows[0].requires),
  'representative nested toolset tip nodes are immutable',
);

const tipMutationErrors = [
  () => { TOOLSET_TIPS.actors.core = tipMutationMarker; },
  () => { TOOLSET_TIPS.actors.workflows[0].tip = tipMutationMarker; },
  () => { TOOLSET_TIPS.actors.workflows[0].requires.push('never-enabled'); },
  () => { TOOLSET_TIPS.actors.workflows.push({ requires: [], tip: tipMutationMarker }); },
].map(mutate => captureError(mutate));
t.assert(
  tipMutationErrors.every(error => error instanceof TypeError),
  'nested toolset tip writes are rejected',
  tipMutationErrors.map(error => error?.message || 'mutation succeeded').join('; '),
);
t.assert(
  TOOLSET_TIPS.actors.core === originalActorCore &&
    TOOLSET_TIPS.actors.workflows[0].tip === originalActorWorkflow &&
    TOOLSET_TIPS.actors.workflows.length === originalActorWorkflowCount &&
    TOOLSET_TIPS.actors.workflows[0].requires.length === originalActorRequirementCount,
  'nested writes leave toolset tips unchanged',
);

const oversizedDescriptions = [...tools.values()]
  .filter(record => utf8Bytes(record.def.description || '') > TOOL_DESCRIPTION_LIMIT_BYTES)
  .map(record => `${record.name}: ${utf8Bytes(record.def.description)} bytes`);
t.assert(oversizedDescriptions.length === 0,
  'registered tool descriptions fit the UTF-8 wire budget', oversizedDescriptions.join('; '));

console.log('\n── MCP registration metadata ──');
const createServerSource = await readFile(join(REPO_ROOT, 'server', 'create-uemcp-server.mjs'), 'utf-8');
t.assert(
  !/\.tool\s*\(/.test(createServerSource),
  'production server uses no deprecated .tool() registrations',
);

const assertManagementAnnotationPolicies = UemcpServerModule.assertManagementAnnotationPolicies;
t.assert(
  typeof assertManagementAnnotationPolicies === 'function',
  'production exports the independent management registration invariant',
);

if (typeof assertManagementAnnotationPolicies === 'function') {
  const expectedManagement = literalManagementAnnotations();
  t.assert(
    captureError(() => assertManagementAnnotationPolicies(expectedManagement)) === null,
    'exact management inventory and literal policies satisfy the startup invariant',
  );

  const unexpectedRegistration = new Map(expectedManagement);
  unexpectedRegistration.set('future_management_tool', INSPECTION_ANNOTATIONS);
  t.assert(
    /unexpected: future_management_tool/.test(
      captureError(() => assertManagementAnnotationPolicies(unexpectedRegistration))?.message || ''
    ),
    'startup invariant rejects a management registration absent from both inventories',
  );

  const staleInventory = new Map(expectedManagement);
  staleInventory.delete('list_project_targets');
  t.assert(
    /missing: list_project_targets/.test(
      captureError(() => assertManagementAnnotationPolicies(staleInventory))?.message || ''
    ),
    'startup invariant rejects a stale management inventory name',
  );

  const wrongSessionStatePolicy = new Map(expectedManagement);
  wrongSessionStatePolicy.set('connection_info', INSPECTION_ANNOTATIONS);
  t.assert(
    /connection_info.*session-state/.test(
      captureError(() => assertManagementAnnotationPolicies(wrongSessionStatePolicy))?.message || ''
    ),
    'startup invariant compares captured session-state annotations to a literal policy',
  );

  const wrongInspectionPolicy = new Map(expectedManagement);
  wrongInspectionPolicy.set('list_toolsets', SESSION_STATE_ANNOTATIONS);
  t.assert(
    /list_toolsets.*pure-inspection/.test(
      captureError(() => assertManagementAnnotationPolicies(wrongInspectionPolicy))?.message || ''
    ),
    'startup invariant compares captured inspection annotations to a literal policy',
  );
}

const committedProjectRoot = join(__dirname, 'fix' + 'tures', 'uemcp-' + 'fix' + 'ture');
const serverApp = await UemcpServerModule.createUemcpServer({
  cwd: process.cwd(),
  workspaceRoots: [committedProjectRoot],
  writeProjectCodenames: false,
  tcpCommandFn: async () => ({ status: 'success' }),
  httpCommandFn: async () => ({ Presets: [] }),
  stderr: { write() {} },
});
const transport = new FakeMcpTransport();
await serverApp.start(transport);
try {
  await transport.sendClientRequest('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'tool-metadata-test', version: '1.0.0' },
  });

  const attachResponse = await transport.sendClientRequest('tools/call', {
    name: 'attach_project',
    arguments: { project_root: committedProjectRoot },
  });
  t.assert(
    attachResponse.result?.structuredContent?.projectContext?.attachmentState === 'attached',
    'wire metadata gate attaches the committed test project',
    `got ${attachResponse.result?.structuredContent?.projectContext?.attachmentState}`,
  );

  const tipsResponse = await transport.sendClientRequest('tools/call', {
    name: 'find_tools',
    arguments: {
      query: 'spawn blueprint actor create blueprint',
      max_results: 10,
    },
  });
  const tipsPayload = tipsResponse.result?.structuredContent || {};
  const actorRuntimeTip = (tipsPayload.tips || []).find(tip => tip.startsWith('[actors]')) || '';
  t.assert(
    tipsPayload.autoEnabled?.includes('actors') && tipsPayload.autoEnabled?.includes('blueprints-write'),
    'runtime tip scenario enables the related toolsets',
  );
  t.assert(
    actorRuntimeTip.includes(originalActorCore) &&
      actorRuntimeTip.includes(originalActorWorkflow) &&
      !actorRuntimeTip.includes(tipMutationMarker),
    'rejected mutations cannot alter a later collectTips runtime response',
    `got ${JSON.stringify(actorRuntimeTip)}`,
  );

  const allToolsetNames = Object.keys(toolsData.toolsets);
  const enableResponse = await transport.sendClientRequest('tools/call', {
    name: 'enable_toolset',
    arguments: { toolsets: allToolsetNames },
  });
  const enableResult = enableResponse.result?.structuredContent || {};
  const enabledOrAlreadyEnabled = new Set([
    ...(enableResult.enabled || []),
    ...(enableResult.alreadyEnabled || []),
  ]);
  const toolsetsNotEnabled = allToolsetNames.filter(name => !enabledOrAlreadyEnabled.has(name));
  t.assert(
    toolsetsNotEnabled.length === 0 &&
      (enableResult.unavailable || []).length === 0 &&
      (enableResult.unknown || []).length === 0,
    'deterministic transport stubs enable every registered toolset shape',
    `not enabled: ${toolsetsNotEnabled.join(', ')}; unavailable: ${(enableResult.unavailable || []).join(', ')}; unknown: ${(enableResult.unknown || []).join(', ')}`,
  );

  const dynamicRegistrationGroups = [
    ['offline', toolsData.toolsets.offline.tools],
    ['actors', getActorsToolDefs()],
    ['blueprints-write', getBlueprintsWriteToolDefs()],
    ['widgets', getWidgetsToolDefs()],
    ['remote-control', getRcToolDefs()],
    ['m-enhance', getMenhanceToolDefs()],
    ['animation', getM5AnimationToolDefs()],
    ['materials', getM5MaterialsToolDefs()],
    ['input-and-pie', getM5InputPieToolDefs()],
    ['geometry', getM5GeometryToolDefs()],
    ['editor-utility', getM5EditorUtilityToolDefs()],
  ];
  const canonicalDynamicDefinitions = new Map();
  const duplicateCanonicalNames = [];
  for (const [toolsetName, toolset] of Object.entries(toolsData.toolsets || {})) {
    for (const [name, def] of Object.entries(toolset.tools || {})) {
      if (canonicalDynamicDefinitions.has(name)) duplicateCanonicalNames.push(name);
      canonicalDynamicDefinitions.set(name, { toolsetName, def });
    }
  }
  t.assert(
    duplicateCanonicalNames.length === 0,
    'canonical tools.yaml dynamic tool names are globally unique',
    duplicateCanonicalNames.join(', '),
  );
  const expectedDynamicAnnotations = new Map();
  const duplicateDynamicNames = [];
  const missingCanonicalDefinitions = [];
  for (const [toolsetName, definitions] of dynamicRegistrationGroups) {
    for (const name of Object.keys(definitions)) {
      if (expectedDynamicAnnotations.has(name)) duplicateDynamicNames.push(name);
      const canonical = canonicalDynamicDefinitions.get(name);
      if (!canonical) {
        missingCanonicalDefinitions.push(`${toolsetName}.${name}`);
        continue;
      }
      const requirement = getToolRequirement(name, canonical.toolsetName, canonical.def);
      expectedDynamicAnnotations.set(name, getToolAnnotations(name, requirement));
    }
  }
  t.assert(
    duplicateDynamicNames.length === 0,
    'independent dynamic registration inventory has no duplicate names',
    duplicateDynamicNames.join(', '),
  );
  t.assert(
    missingCanonicalDefinitions.length === 0,
    'every dynamic registration has canonical tools.yaml metadata',
    missingCanonicalDefinitions.join(', '),
  );

  const toolList = await transport.sendClientRequest('tools/list', {});
  const listedRows = toolList.result?.tools || [];
  const listedByName = new Map(listedRows.map(row => [row.name, row]));
  const expectedManagementAnnotations = literalManagementAnnotations();
  const expectedNames = new Set([
    ...expectedManagementAnnotations.keys(),
    ...expectedDynamicAnnotations.keys(),
  ]);
  const missingNames = [...expectedNames].filter(name => !listedByName.has(name)).sort();
  const unexpectedNames = [...listedByName.keys()].filter(name => !expectedNames.has(name)).sort();
  t.assert(
    listedRows.length === expectedNames.size && missingNames.length === 0 && unexpectedNames.length === 0,
    'tools/list exposes the independently inventoried management and dynamic registrations',
    `listed=${listedRows.length} expected=${expectedNames.size}; missing: ${missingNames.join(', ')}; unexpected: ${unexpectedNames.join(', ')}`,
  );
  t.assert(
    listedRows.length === 144,
    'independent all-enabled tools/list inventory contains 144 registered tools',
    `listed=${listedRows.length}`,
  );

  const wireProviderSpecificMatches = findProviderSpecificTokens(listedRows.map(row => ({
    surface: 'tools/list description',
    name: row.name,
    value: row.description,
  })));
  t.assert(
    wireProviderSpecificMatches.length === 0,
    'every independently inventoried all-enabled tools/list description avoids supported-client brands and exact native-tool tokens',
    wireProviderSpecificMatches.join('\n'),
  );

  const registeredDescriptionSizes = listedRows.map(row => ({
    name: row.name,
    bytes: typeof row.description === 'string' ? utf8Bytes(row.description) : Infinity,
  }));
  const oversizedRegisteredDescriptions = registeredDescriptionSizes
    .filter(row => row.bytes > TOOL_DESCRIPTION_LIMIT_BYTES)
    .map(row => `${row.name}: ${Number.isFinite(row.bytes) ? `${row.bytes} bytes` : 'non-string description'}`);
  const maximumRegisteredDescription = registeredDescriptionSizes.reduce(
    (maximum, row) => row.bytes > maximum.bytes ? row : maximum,
    { name: '(none)', bytes: 0 },
  );
  t.assert(
    oversizedRegisteredDescriptions.length === 0,
    `every registered tools/list description fits the UTF-8 wire budget (maximum ${maximumRegisteredDescription.name}: ${maximumRegisteredDescription.bytes} bytes)`,
    oversizedRegisteredDescriptions.join('; '),
  );

  const managementAnnotationMismatches = [];
  for (const [name, expected] of expectedManagementAnnotations) {
    const actual = listedByName.get(name)?.annotations;
    if (!annotationsMatch(actual, expected)) {
      managementAnnotationMismatches.push(`${name}: ${JSON.stringify(actual)}`);
    }
  }
  t.assert(
    managementAnnotationMismatches.length === 0,
    'every management tools/list row exposes its literal expected annotations',
    managementAnnotationMismatches.join('; '),
  );

  const dynamicAnnotationMismatches = [];
  for (const [name, expected] of expectedDynamicAnnotations) {
    const actual = listedByName.get(name)?.annotations;
    if (!annotationsMatch(actual, expected)) {
      dynamicAnnotationMismatches.push(`${name}: ${JSON.stringify(actual)}`);
    }
  }
  t.assert(
    dynamicAnnotationMismatches.length === 0,
    'every dynamic tools/list row exposes its requirement-derived annotations',
    dynamicAnnotationMismatches.join('; '),
  );

  const canonicalMutationNames = new Set(['rc_batch']);
  for (const toolset of Object.values(toolsData.toolsets || {})) {
    for (const [name, def] of Object.entries(toolset.tools || {})) {
      if (
        def.mutates_asset === true ||
        def.mutates_level === true ||
        def.saves_asset === true ||
        def.compiles_asset === true
      ) {
        canonicalMutationNames.add(name);
      }
    }
  }
  const unsafeMutationAnnotations = [...canonicalMutationNames]
    .filter(name => listedByName.has(name))
    .filter(name => !annotationsMatch(
      listedByName.get(name)?.annotations,
      { readOnlyHint: false, destructiveHint: true },
    ))
    .map(name => `${name}: ${JSON.stringify(listedByName.get(name)?.annotations)}`);
  t.assert(
    unsafeMutationAnnotations.length === 0,
    'canonical metadata mutations and mixed-operation RC batch are never advertised read-only',
    unsafeMutationAnnotations.join('; '),
  );
} finally {
  await serverApp.server.close();
}

console.log('\n── Required metadata coverage ──');
for (const name of REQUIRED_ANNOTATED_TOOLS) {
  const record = tools.get(name);
  t.assert(record !== undefined, `required tool exists: ${name}`);
  if (!record) continue;
  const errors = validateToolMetadata(record);
  t.assert(errors.length === 0, `${name} has complete valid metadata`, errors.join('; '));
}

console.log('\n── All annotated tools obey the schema ──');
const malformed = [];
for (const record of tools.values()) {
  if ('status' in record.def && !ALLOWED_STATUS.has(record.def.status)) {
    malformed.push(`${record.name}: invalid status ${JSON.stringify(record.def.status)}`);
  }
  if (!hasCapabilityMetadata(record.def)) continue;
  const count = metadataFieldCount(record.def);
  if (count !== REQUIRED_FIELDS.length) {
    malformed.push(`${record.name}: partial metadata (${count}/${REQUIRED_FIELDS.length})`);
    continue;
  }
  malformed.push(...validateToolMetadata(record));
}
t.assert(malformed.length === 0, 'annotated tools have valid enum/boolean/fallback fields', malformed.join('; '));

console.log('\n── Validator rejects malformed metadata ──');
const invalidStatus = validateToolMetadata({
  name: 'invalid_status_fixture',
  def: {
    status: 'maybe',
    availability_layer: 'tcp-55558',
    transport_layer: 'tcp-55558',
    requires_editor: true,
    requires_pie: false,
    mutates_asset: false,
    mutates_level: false,
    saves_asset: false,
    compiles_asset: false,
    offline_fallback: false,
  },
});
t.assert(invalidStatus.some(e => e.includes('invalid status')),
  'validator rejects invalid status enum values',
  invalidStatus.join('; '));

const malformedMetadata = validateToolMetadata({
  name: 'malformed_fixture',
  def: {
    status: 'shipped',
    availability_layer: 'tcp-55558',
    transport_layer: 'websocket',
    requires_editor: 'yes',
    requires_pie: false,
    mutates_asset: false,
    mutates_level: false,
    saves_asset: false,
    compiles_asset: false,
    offline_fallback: '',
  },
});
t.assert(malformedMetadata.some(e => e.includes('invalid transport_layer'))
  && malformedMetadata.some(e => e.includes('requires_editor must be boolean'))
  && malformedMetadata.some(e => e.includes('offline_fallback must be false or non-empty string')),
  'validator rejects malformed layer, boolean, and fallback fields',
  malformedMetadata.join('; '));

console.log('\n── RC-backed semantic delegates expose split layers ──');
for (const name of ['set_material_parameter', 'list_material_parameters', 'get_curve_asset', 'get_mesh_info']) {
  const record = tools.get(name);
  t.assert(record.def.availability_layer === 'http-30010',
    `${name} availability_layer reflects RC HTTP dependency`,
    `got ${record.def.availability_layer}`);
  t.assert(record.def.transport_layer === 'http-30010',
    `${name} transport_layer reflects RC HTTP routing`,
    `got ${record.def.transport_layer}`);
  t.assert(record.toolsetLayer !== record.def.transport_layer,
    `${name} documents user-facing toolset layer distinct from transport layer`);
}

console.log('\n── Source-backed live authoring metadata reflects persistence split ──');
for (const name of ['create_material', 'create_material_instance', 'create_montage', 'add_montage_section', 'add_montage_notify']) {
  const record = tools.get(name);
  t.assert(record.def.availability_layer === 'tcp-55558',
    `${name} availability_layer reflects plugin TCP dependency`,
    `got ${record.def.availability_layer}`);
  t.assert(record.def.requires_editor === true && record.def.requires_pie === false,
    `${name} requires editor but not PIE`);
  t.assert(record.def.mutates_asset === true && record.def.saves_asset === false,
    `${name} mutates an asset but does not save it`,
    `mutates_asset=${record.def.mutates_asset}, saves_asset=${record.def.saves_asset}`);
}

for (const name of ['create_input_action', 'create_mapping_context', 'add_mapping']) {
  const record = tools.get(name);
  t.assert(record.def.availability_layer === 'tcp-55558',
    `${name} availability_layer reflects plugin TCP dependency`,
    `got ${record.def.availability_layer}`);
  t.assert(record.def.mutates_asset === true && record.def.saves_asset === true,
    `${name} mutates and saves an Enhanced Input asset`,
    `mutates_asset=${record.def.mutates_asset}, saves_asset=${record.def.saves_asset}`);
  t.assert(record.def.compiles_asset === false && record.def.requires_pie === false,
    `${name} does not compile assets or require PIE`);
}

process.exit(t.summary());
