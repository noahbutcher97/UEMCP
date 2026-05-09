// Tool metadata schema validation
// Run: cd D:\DevTools\UEMCP\server && node test-tool-metadata.mjs
//
// Guards the first per-tool metadata pass that splits user-facing toolset
// grouping from availability, transport, editor/PIE, mutation, persistence,
// compile, and offline fallback semantics.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { load } from 'js-yaml';
import { TestRunner } from './test-helpers.mjs';

const ALLOWED_STATUS = new Set(['shipped', 'planned', 'deprecated', 'hidden']);
const ALLOWED_LAYERS = new Set(['offline', 'tcp-55557', 'tcp-55558', 'http-30010']);
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

const t = new TestRunner('Tool Metadata Schema');
const toolsYaml = await readFile(join('..', 'tools.yaml'), 'utf-8');
const toolsData = load(toolsYaml);
const tools = collectTools(toolsData);

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

process.exit(t.summary());
