import Ajv from 'ajv';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { runSpacingEvaluation } from './spacing-evaluation.mjs';
import { trainSpacingPolicy } from './spacing-policy.mjs';
import { runWorkloadCommandlet, savedInput } from './workload-commandlet.mjs';

const createValidators = () => ({
  inputs: new Ajv({ useDefaults: true, strict: true, addUsedSchema: false }),
  results: new Ajv({ strict: true, addUsedSchema: false }),
});
const validators = createValidators();
const packageName = { type: 'string', maxLength: 512, pattern: '^/Game/(?:[A-Za-z0-9_]+/)*[A-Za-z0-9_]+$' };
const integer = (minimum, maximum) => ({ type: 'integer', minimum, maximum });
const object = (properties, required = Object.keys(properties), additionalProperties = false) =>
  ({ type: 'object', properties, required, additionalProperties });
const spacingFields = { config: packageName, map: packageName, seed: integer(0, 2147483647) };
const measurement = object({
  config: packageName, map: packageName, seed: spacingFields.seed, engine_build: { type: 'string' },
  passed: integer(0, 256), starts: { type: 'array', minItems: 2, maxItems: 256,
    items: object({ nearest_metres: { type: 'number', minimum: 0 }, meets_minimum: { type: 'boolean' } }, undefined, true) },
}, undefined, true);
const policy = object({ steps: integer(32, 8192), weights: { type: 'array', minItems: 2, maxItems: 2, items: { type: 'number' } },
  mean_reward: { type: 'number' } }, undefined, true);

export function canonicalJson(value) {
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  if (value !== null && typeof value === 'object') return '{' + Object.keys(value).sort()
    .map(key => JSON.stringify(key) + ':' + canonicalJson(value[key])).join(',') + '}';
  return JSON.stringify(value);
}

const builtins = [
  {
    kind: 'player_start_spacing', version: 1, mode: 'commandlet', description: 'Measure saved player-start clearance in metres.',
    input_schema: object(spacingFields), result_schema: object({ evaluation: measurement }),
    async execute(inputs, context) { return { evaluation: await runSpacingEvaluation({ ...inputs, ...context }) }; },
  },
  {
    kind: 'train_spacing_policy', version: 1, mode: 'commandlet_and_cpu', description: 'Train a clipped PPO policy on saved player-start clearances.',
    input_schema: object({ ...spacingFields, steps: integer(32, 8192) }), result_schema: object({ evaluation: measurement, policy }),
    async execute(inputs, context) {
      const evaluation = await runSpacingEvaluation({ ...inputs, ...context });
      const policy = trainSpacingPolicy(evaluation, inputs.steps, steps => {
        context.checkCancellation();
        if (steps % 512 === 0 || steps === inputs.steps) context.progress({ phase: 'training', steps });
      });
      return { evaluation, policy };
    },
  },
  {
    kind: 'physics_joint_response', version: 1, mode: 'fixed_step_chaos_scene', description: 'Measure the peak twist in degrees of a named PhysicsAsset joint in an isolated zero-gravity physics scene.',
    handler: '/Script/UEMCP.UEMCPJointResponse',
    input_schema: object({ asset: packageName, joint: { type: 'string', minLength: 1, maxLength: 256 }, steps: { ...integer(1, 3600), default: 180 } }, ['asset', 'joint']),
    result_schema: object({ asset: packageName, joint: { type: 'string' }, steps: integer(1, 3600), units: { const: 'degrees' },
      mode: { const: 'fixed_step_chaos_scene' }, initial_degrees: { type: 'number' }, peak_degrees: { type: 'number' },
      final_degrees: { type: 'number' }, step_seconds: { type: 'number', exclusiveMinimum: 0 } }),
    package_inputs: { asset: '.uasset' },
  },
];

const compiledBuiltins = new Map();
function register(map, spec, projectProvided, compilers = validators) {
  const { kind, version, description, mode, input_schema, result_schema, handler, package_inputs = {} } = spec;
  if (!/^[a-z][a-z0-9_]{0,63}$/.test(kind || '') || !Number.isSafeInteger(version) || version < 1 ||
      typeof description !== 'string' || !description.length || typeof mode !== 'string' || !mode.length ||
      input_schema?.type !== 'object' || input_schema.additionalProperties !== false || result_schema?.type !== 'object')
    throw new Error('Invalid workload registration. Supply a kind, positive version, mode, description and object schemas; inputs must reject extra properties.');
  if (map.has(kind)) throw new Error('Duplicate workload registration: ' + kind);
  if (projectProvided || !spec.execute) {
    if (!/^\/Script\/[A-Za-z][A-Za-z0-9_]*\.[A-Za-z][A-Za-z0-9_]*$/.test(handler || '')) throw new Error('Invalid installed native workload handler.');
    for (const [name, ext] of Object.entries(package_inputs)) {
      if (!Object.hasOwn(input_schema.properties ?? {}, name) || !['.uasset','.umap'].includes(ext)) throw new Error('Invalid package input declaration.');
    }
  }
  const metadata = { kind, version, description, mode, input_schema, result_schema, package_inputs, handler: handler ?? 'server_builtin',
    requires: ['built_project', 'win64_engine'], timeout_ms: 180000 };
  const identity = { kind, version, mode, input_schema, result_schema, package_inputs, handler: metadata.handler };
  const fingerprint = createHash('sha256').update(canonicalJson(identity)).digest('hex');
  const checkInput = compilers.inputs.compile(input_schema), checkResult = compilers.results.compile(result_schema);
  const execute = (!projectProvided && spec.execute) || ((inputs, context) => executeNative(metadata, inputs, context));
  map.set(kind, { metadata, fingerprint, checkInput, checkResult, execute });
}
for (const spec of builtins) register(compiledBuiltins, spec, false);

export function loadWorkloads(project, requestedKind) {
  const catalog = new Map(compiledBuiltins);
  // A broken project extension cannot strand queued built-in jobs.
  if (!project) return catalog;
  const manifest = realpathSync(project) + '.uemcp-workloads.json';
  let data;
  try {
    const stat = lstatSync(manifest);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536) throw new Error('Invalid project workload manifest.');
    data = JSON.parse(readFileSync(manifest, 'utf8').replace(/^\uFEFF/, ''));
    if (data.schema_version !== 1 || !Array.isArray(data.workloads) || data.workloads.length > 32) throw new Error('Unsupported workload manifest.');
  } catch (error) {
    if (error.code === 'ENOENT' || catalog.has(requestedKind)) return catalog;
    throw error;
  }
  if (catalog.has(requestedKind)) {
    if (data.workloads.some(entry => entry?.kind === requestedKind)) throw new Error('Duplicate workload registration: ' + requestedKind);
    return catalog;
  }
  // Ajv retains compiled schemas. Limit project schemas to this catalog's lifetime.
  const projectValidator = createValidators();
  for (const entry of data.workloads) {
    if (!requestedKind || entry?.kind === requestedKind) register(catalog, entry, true, projectValidator);
  }
  return catalog;
}

export function workloadRequest(args, catalog) {
  const { request_id, kind = 'player_start_spacing', version, inputs, ...legacy } = args;
  if (typeof request_id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(request_id)) throw new Error('Supply a stable request_id of 1–80 letters, digits, underscores or hyphens.');
  const definition = catalog.get(kind);
  if (!definition) throw new Error('Unknown workload kind ' + kind + '. List available workloads for this project.');
  if (version !== undefined && version !== definition.metadata.version) throw new Error('Workload version unavailable: ' + kind + ' version ' + version);
  if (inputs !== undefined && Object.keys(legacy).length) throw new Error('Use inputs or legacy flat arguments, not both.');
  const values = structuredClone(inputs === undefined ? legacy : inputs);
  if (!definition.checkInput(values)) throw new Error('Invalid ' + kind + ' inputs: ' + validators.inputs.errorsText(definition.checkInput.errors));
  const normalized = { request_id, kind, version: definition.metadata.version, inputs: values };
  if (Buffer.byteLength(JSON.stringify(normalized)) > 60 * 1024) throw new Error('Workload request exceeds 60 KiB.');
  return normalized;
}

export async function executeRegistered(definition, inputs, context) {
  context.checkCancellation();
  const result = await definition.execute(inputs, context);
  if (!definition.checkResult(result)) throw new Error('Workload result does not match its registered schema: ' + validators.results.errorsText(definition.checkResult.errors));
  if (Buffer.byteLength(JSON.stringify(result)) > 768 * 1024) throw new Error('Workload result exceeds 768 KiB.');
  return result;
}

async function executeNative(spec, inputs, context) {
  const hashes = async () => {
    const result = {};
    for (const [key, ext] of Object.entries(spec.package_inputs)) {
      const path = inputs[key];
      if (typeof path !== 'string' || path.length > 512 || !new RegExp(packageName.pattern).test(path)) throw new Error('Expected a saved /Game package for ' + key);
      result[key] = await savedInput(dirname(context.project), path, ext);
    }
    return result;
  };
  const before = await hashes();
  const sources = Object.entries(spec.package_inputs).map(([key, extension]) => ({ package: inputs[key], extension, digest: before[key] }));
  const file = join(context.output, 'native-request.json');
  const request = JSON.stringify({ kind: spec.kind, version: spec.version, handler: spec.handler, inputs, sources });
  if (Buffer.byteLength(request) > 65536) throw new Error('Native workload request exceeds 64 KiB');
  writeFileSync(file, request, { flag: 'wx' });
  const { report, duration_ms } = await runWorkloadCommandlet({ ...context, commandlet: 'UEMCPWorkload', parameters: ['-WorkloadInput=' + file] });
  if (report.kind !== spec.kind || report.version !== spec.version || report.handler !== spec.handler)
    throw new Error('Native workload identity differs from the installed registration.');
  if (canonicalJson(before) !== canonicalJson(await hashes())) throw new Error('Saved workload inputs changed during evaluation.');
  context.progress({ phase: 'evaluated', engine_build: report.engine_build, input_sha256: before, duration_ms });
  return report.result;
}
