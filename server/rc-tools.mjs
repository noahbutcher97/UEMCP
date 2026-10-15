// Remote Control toolset handlers — M-enhance CP2 (D66 HYBRID).
//
// 11 FULL-RC tools per FA-ε §Q1:
//   8 rc_* primitives (toolset: remote-control, layer: http-30010)
//     rc_get_property, rc_set_property, rc_call_function, rc_list_objects,
//     rc_describe_object, rc_batch, rc_get_presets, rc_passthrough
//   3 semantic delegates that ride RC internally (D66 TCP-external-signature
//   / RC-internal-substrate per FA-ε §Q6 — the agent-facing toolset still
//   reports layer: tcp-55558 so enable_toolset tips stay coherent, but the
//   handler dispatches via connectionManager.sendHttp):
//     list_material_parameters  (toolset: materials)
//     get_curve_asset           (toolset: data-assets)
//     get_mesh_info             (toolset: geometry)
//
// All dispatch flows through rc-url-translator.mjs — keeps endpoint shapes
// in one place.
//
// `isReadOp` convention (mirrors tcp-tools.mjs):
//   - true  → result cached by ConnectionManager
//   - false → skipCache:true (writes, transactional calls, untrusted passthrough)

import { z } from 'zod';
import * as rc from './rc-url-translator.mjs';

const MATERIAL_EDITING_LIBRARY = '/Script/MaterialEditor.Default__MaterialEditingLibrary';

// ── Zod schemas ───────────────────────────────────────────────

export const RC_SCHEMAS = {
  // ── 8 rc_* primitives ───────────────────────────────────────
  rc_get_property: {
    description: 'Get any UPROPERTY by object path + property name via Remote Control HTTP',
    schema: {
      object_path:   z.string().describe('Fully-qualified UObject path (/Game/... or :Default__<Class>)'),
      property_name: z.string().describe('UProperty name on the target object'),
      access:        z.string().optional().describe('RC access mode — defaults to READ_ACCESS'),
    },
    isReadOp: true,
  },

  rc_set_property: {
    description: 'Set any UPROPERTY by object path + property name + value (transactional by default)',
    schema: {
      object_path:           z.string().describe('Fully-qualified UObject path'),
      property_name:         z.string().describe('UProperty name on the target object'),
      value:                 z.any().describe('Value to set — RC handles type coercion'),
      generate_transaction:  z.boolean().optional().describe('Default true — records in editor Undo stack'),
      access:                z.string().optional().describe('RC access mode — defaults to WRITE_TRANSACTION_ACCESS'),
    },
    isReadOp: false,
  },

  rc_call_function: {
    description: 'Call any BlueprintCallable UFUNCTION on any UObject',
    schema: {
      object_path:          z.string().describe('Fully-qualified UObject path'),
      function_name:        z.string().describe('UFUNCTION name (must be BlueprintCallable or Exec)'),
      args:                 z.record(z.any()).optional().describe('Parameters keyed by pin name'),
      generate_transaction: z.boolean().optional().describe('Default false — set true for writes that should undo-stack'),
    },
    isReadOp: false,
  },

  rc_list_objects: {
    description: 'Search for assets on disk by class name via the AssetRegistry (PUT /remote/search/assets in UE 5.6 — replaces the removed /remote/object/list). Returns asset paths matching ClassNames; live-object inspection requires rc_describe_object on a known path.',
    schema: {
      class_pattern: z.string().describe('Unreal class name (e.g. AActor, UMaterialInterface, UWorld). U/A prefix is stripped automatically.'),
      outer:         z.string().optional().describe('Restrict search to a package path (e.g. /Game/Maps)'),
      recursive:     z.boolean().optional().describe('Recurse into subclasses + subpackages (default false)'),
    },
    isReadOp: true,
  },

  rc_describe_object: {
    description: 'List all exposed properties and functions on a specific object (SanitizeMetadata allowlist applies per D66)',
    schema: {
      object_path: z.string().describe('Fully-qualified UObject path'),
    },
    isReadOp: true,
  },

  rc_batch: {
    description: 'Execute multiple RC operations in one HTTP round-trip (/remote/batch)',
    schema: {
      operations: z.array(z.object({
        method: z.string().describe('HTTP verb: GET | POST | PUT | DELETE'),
        path:   z.string().describe('RC endpoint starting with /remote/'),
        body:   z.record(z.any()).optional().describe('JSON body for the sub-request'),
      })).describe('Ordered list of sub-requests'),
    },
    // Conservative: batch may contain writes; skip cache for the whole batch.
    isReadOp: false,
  },

  rc_get_presets: {
    description: 'List Remote Control presets (GET /remote/presets). Requires the RemoteControl plugin.',
    schema: {
      preset: z.string().optional().describe('Optional — if set, fetches a single preset by name/id'),
    },
    isReadOp: true,
  },

  rc_passthrough: {
    description: 'Raw HTTP request to any /remote/* endpoint. Advanced escape hatch.',
    schema: {
      method:   z.string().describe('HTTP verb'),
      endpoint: z.string().describe('Path starting with /remote/'),
      // Mirrors zod-builder.mjs's F-1.5 preprocess for `type: object` params.
      // RC tools register their Zod schemas directly with the SDK (server.mjs
      // line ~733), bypassing buildZodSchema — so the auto-parse for stringified
      // object params doesn't apply unless we replicate it here. Some MCP wire
      // wrappers JSON-stringify object literals during transit; preprocess
      // parses the string before z.record validates. Malformed JSON falls
      // through as a string, producing a clean "expected object" Zod error
      // rather than a SyntaxError.
      body: z.preprocess(
        (val) => {
          if (typeof val !== 'string') return val;
          try { return JSON.parse(val); } catch { return val; }
        },
        z.record(z.any())
      ).optional().describe('Optional JSON body — accepts an object (preferred) or a pre-stringified JSON string'),
    },
    // Conservative: we don't know what the caller is doing — skip cache.
    isReadOp: false,
  },

  // ── 4 semantic delegates (RC-internal substrate, TCP-external signature) ──
  // Dispatched via DELEGATE_EXECS in executeRcTool — multi-call orchestrations,
  // not single-shot primitives.
  list_material_parameters: {
    description: 'List scalar/vector/texture parameter identities and effective values, including inherited, layer and blend parameters. Requires UEMCP 1.0.21+ GetParameterDetails permission. Name/Association/Index identifies a parameter; Id is its expression GUID. ValueFound=false reports an unavailable value. include_details=false selects legacy names-only listing.',
    schema: {
      asset_path: z.string().describe('/Game/... path to the material or material instance'),
      include_details: z.boolean().default(true).describe('Include GUID, association, index and effective value; false uses legacy names-only APIs'),
    },
    isReadOp: true,
  },

  // MaterialEditingLibrary exposes reflected wrappers; the underlying
  // Set*ParameterValueEditorOnly C++ methods are not UFUNCTIONs.
  set_material_parameter: {
    description: 'Set scalar/vector/texture parameters on a loaded UMaterialInstanceConstant. All writes require UEMCP 1.0.21+ and record the instance for Undo. association defaults to global; layer/blend requires an explicit index from detailed listing. Validates the exact definition before writing and verifies effective readback plus the matching instance override uncached. Names match case-insensitively. Does not save. RC must allow UEMCPMaterialParameterLibrary, MaterialEditingLibrary and ClassIsChildOf for derived targets.',
    schema: {
      asset_path:     z.string().describe('/Game/... path to the UMaterialInstanceConstant'),
      parameter_name: z.string().describe('Material parameter name (matches the parameter as exposed in the parent material)'),
      value:          z.any().describe('Scalar (number), Vector (4-element array or {R,G,B,A} object), or Texture (asset path string)'),
      parameter_type: z.string().optional().describe('Optional override: scalar | vector | texture (default: auto-detect from value shape)'),
      association: z.enum(['global', 'layer', 'blend', 'GlobalParameter', 'LayerParameter', 'BlendParameter'])
        .default('global').transform(value => ({ GlobalParameter: 'global', LayerParameter: 'layer', BlendParameter: 'blend' }[value] ?? value))
        .describe('global/layer/blend, or the Association string returned by detailed listing'),
      index: z.number().int().optional().describe('Required nonnegative layer/blend index; global parameters use -1'),
    },
    isReadOp: false,
  },

  get_curve_asset: {
    description: 'Read UCurveFloat / UCurveVector / UCurveLinearColor keyframes, tangents, and interpolation. Probes class via describe, then reads the subclass-specific curve property.',
    schema: {
      asset_path:  z.string().describe('/Game/... path to the curve asset'),
      curve_class: z.string().optional().describe('Optional hint: CurveFloat | CurveVector | CurveLinearColor. Skips the describe probe when supplied.'),
    },
    isReadOp: true,
  },

  get_mesh_info: {
    description: 'Get vertex count, triangle count, LOD count, bounds, and material slots for a UStaticMesh via batched UFUNCTION calls',
    schema: {
      asset_path: z.string().optional().describe('/Game/... path to the UStaticMesh asset'),
      target:     z.string().optional().describe('Actor name (alternative to asset_path — reads from spawned instance)'),
    },
    isReadOp: true,
  },
};

// ── Dispatch helpers ──────────────────────────────────────────

/**
 * Translate toolName + validated args → {method, path, body}.
 * All tools share sendHttp; the translator centralizes endpoint shape.
 *
 * @param {string} toolName
 * @param {object} args    pre-validated by Zod
 * @returns {{method: string, path: string, body: object|null}}
 */
function buildRcRequest(toolName, args) {
  switch (toolName) {
    case 'rc_get_property':
      return rc.rcGetProperty({
        objectPath: args.object_path,
        propertyName: args.property_name,
        access: args.access,
      });

    case 'rc_set_property':
      return rc.rcSetProperty({
        objectPath: args.object_path,
        propertyName: args.property_name,
        propertyValue: args.value,
        generateTransaction: args.generate_transaction ?? true,
        access: args.access,
      });

    case 'rc_call_function':
      return rc.rcCallFunction({
        objectPath: args.object_path,
        functionName: args.function_name,
        parameters: args.args || {},
        generateTransaction: args.generate_transaction ?? false,
      });

    case 'rc_list_objects':
      return rc.rcListObjects({
        className: args.class_pattern,
        outer: args.outer,
        recursive: args.recursive,
      });

    case 'rc_describe_object':
      return rc.rcDescribeObject({ objectPath: args.object_path });

    case 'rc_batch':
      return rc.rcBatch(args.operations);

    case 'rc_get_presets':
      return args.preset
        ? rc.rcGetPreset({ preset: args.preset })
        : rc.rcGetPresets();

    case 'rc_passthrough':
      return rc.rcPassthrough({
        method: args.method,
        path: args.endpoint,
        body: args.body || null,
      });

    default:
      // Semantic delegates (list_material_parameters, get_curve_asset,
      // get_mesh_info) route through DELEGATE_EXECS instead of this single-shot
      // builder — executeRcTool handles that branch.
      throw new Error(`rc-tools: unknown tool "${toolName}"`);
  }
}

// ── Semantic-delegate orchestrators ───────────────────────────
// These ride RC internally per D66 (TCP-external signature / RC-internal
// substrate). Each issues multiple HTTP calls and aggregates results; the
// agent-facing response is a flat structured object matching the yaml
// description's promised surface.

/**
 * Reflected enumeration returns names, including inherited names, but omits
 * FMaterialParameterInfo association/index and expression GUIDs. Do not invent them.
 */
async function describeMaterialObject(objectPath, connectionManager) {
  const req = rc.rcDescribeObject({ objectPath });
  const description = await connectionManager.sendHttp(req.method, req.path, req.body, { skipCache: true });
  if (typeof description.Class !== 'string') throw new Error('Material object description is missing its Class');
  return description;
}

async function execListMaterialParameters(args, connectionManager) {
  const objectPath = rc.toCdoPath(args.asset_path);
  // A null Material argument makes the library return an empty array, which
  // would otherwise disguise an unloaded/missing object as a parameterless one.
  await describeMaterialObject(objectPath, connectionManager);
  const batch = args.include_details ? rc.rcBatch(['Scalar', 'Vector', 'Texture'].map(ParameterType => ({
    method: 'PUT', path: '/remote/object/call', body: {
      objectPath: '/Script/UEMCP.Default__UEMCPMaterialParameterLibrary', functionName: 'GetParameterDetails',
      parameters: { Material: objectPath, ParameterType }, generateTransaction: false,
    },
  }))) : rc.rcBatch([
    { method: 'PUT', path: '/remote/object/call',
      body: { objectPath: MATERIAL_EDITING_LIBRARY, functionName: 'GetScalarParameterNames', parameters: { Material: objectPath }, generateTransaction: false } },
    { method: 'PUT', path: '/remote/object/call',
      body: { objectPath: MATERIAL_EDITING_LIBRARY, functionName: 'GetVectorParameterNames', parameters: { Material: objectPath }, generateTransaction: false } },
    { method: 'PUT', path: '/remote/object/call',
      body: { objectPath: MATERIAL_EDITING_LIBRARY, functionName: 'GetTextureParameterNames', parameters: { Material: objectPath }, generateTransaction: false } },
  ]);
  const res = await connectionManager.sendHttp(batch.method, batch.path, batch.body, { skipCache: args.include_details });
  const r = res.Responses;
  if (!Array.isArray(r) || r.length !== 3) {
    throw new Error('list_material_parameters: malformed batch response');
  }
  const out = {
    object_path: objectPath,
    info_fields: args.include_details ? ['Name', 'Id', 'Association', 'Index', 'Value', 'ValueFound'] : ['Name'],
    scalar:  args.include_details ? extractParamDetails(r[0], 'scalar') : extractParamInfo(r[0]),
    vector:  args.include_details ? extractParamDetails(r[1], 'vector') : extractParamInfo(r[1]),
    texture: args.include_details ? extractParamDetails(r[2], 'texture') : extractParamInfo(r[2]),
  };
  // W-G (D144 / Gauntlet Finding 2.4): pre-W-G non-2xx batch sub-responses
  // surfaced as `[]` indistinguishable from "no parameters" — silent-success-
  // on-edge-case. _subErrors[] is non-fatal but lets the caller observe
  // partial-failure conditions (e.g. RC engine race on one of the three calls).
  // Field is OMITTED on the success path so the common-case shape stays
  // unchanged from a client's POV.
  const subErrors = collectSubErrors(r, ['scalar', 'vector', 'texture']);
  if (subErrors.length > 0) out._subErrors = subErrors;
  return out;
}

function extractParamDetails(response, type) {
  if (response?.ResponseCode && (response.ResponseCode < 200 || response.ResponseCode >= 300)) return [];
  const rows = response?.ResponseBody?.ReturnValue;
  if (!Array.isArray(rows)) throw new Error('list_material_parameters: malformed native details response (requires UEMCP 1.0.21+)');
  return rows.map(row => {
    const kinds = ['LayerParameter', 'BlendParameter', 'GlobalParameter'];
    if (typeof row?.Name !== 'string' || typeof row.Id !== 'string' || !kinds.includes(row.Association)
      || !Number.isInteger(row.Index) || (row.Association === 'GlobalParameter' ? row.Index !== -1 : row.Index < 0)
      || typeof row.bValueFound !== 'boolean') throw new Error('list_material_parameters: malformed parameter identity');
    const Value = !row.bValueFound ? null : type === 'scalar' ? row.ScalarValue
      : type === 'vector' ? row.VectorValue : row.TextureValue || null;
    if (row.bValueFound && (type === 'scalar' ? !Number.isFinite(Value)
      : type === 'vector' ? !['R', 'G', 'B', 'A'].every(key => Number.isFinite(Value?.[key]))
        : typeof row.TextureValue !== 'string')) throw new Error('list_material_parameters: malformed parameter value');
    return { Name: row.Name, Id: row.Id || null, Association: row.Association, Index: row.Index, Value, ValueFound: row.bValueFound };
  });
}

function extractParamInfo(response) {
  if (!response) throw new Error('list_material_parameters: malformed ParameterNames response');
  // Treat non-2xx batch sub-responses as empty rather than leaking an error body.
  // The non-2xx case is now ALSO surfaced via collectSubErrors at the call site
  // so partial-failure stops being silent-success-on-edge-case.
  if (response.ResponseCode && (response.ResponseCode < 200 || response.ResponseCode >= 300)) return [];
  const body = response.ResponseBody;
  if (!Array.isArray(body?.ParameterNames) || body.ParameterNames.some(name => typeof name !== 'string')) {
    throw new Error('list_material_parameters: malformed ParameterNames response');
  }
  return body.ParameterNames.map(Name => ({ Name }));
}

/**
 * W-G (D144 / Gauntlet Finding 2.4): inspect a batch `Responses[]` array and
 * return a structured `_subErrors` list — one entry per non-2xx sub-response.
 * Used by aggregating delegates (list_material_parameters, get_mesh_info) to
 * surface partial-failure rather than silently squashing it.
 *
 * @param {Array<{ResponseCode?: number, ResponseBody?: object}>} responses
 * @param {string[]} labels  matching positional labels (`['scalar','vector','texture']`)
 * @returns {Array<{index: number, label: string, code: number, body: any}>}
 */
function collectSubErrors(responses, labels) {
  const out = [];
  for (let i = 0; i < responses.length; i++) {
    const r = responses[i];
    if (!r) continue;
    const code = r.ResponseCode;
    if (code && (code < 200 || code >= 300)) {
      out.push({
        index: i,
        label: labels[i] !== undefined ? labels[i] : `response_${i}`,
        code,
        body: r.ResponseBody !== undefined ? r.ResponseBody : null,
      });
    }
  }
  return out;
}

/**
 * get_curve_asset — probe curve subclass via describe, then read the
 * subclass-specific curve property.
 *
 * UCurveFloat exposes the curve as `FloatCurve` (singular, one FRichCurve).
 * UCurveVector / UCurveLinearColor expose `FloatCurves` (array of 3 / 4
 * FRichCurves respectively). Callers can pass `curve_class` to skip the
 * describe probe when they already know the subclass (e.g. from get_asset_info).
 */
async function execGetCurveAsset(args, connectionManager) {
  const objectPath = args.asset_path;
  let className = args.curve_class;
  if (!className) {
    const desc = await connectionManager.sendHttp(
      'PUT', '/remote/object/describe',
      { objectPath },
      { skipCache: false }
    );
    const classPath = desc && desc.Class ? String(desc.Class) : '';
    className = classPath.split('.').pop() || '';
  }

  // UCurveFloat → singular FloatCurve; UCurveVector / UCurveLinearColor → FloatCurves array.
  const propertyName = /^U?CurveFloat$/.test(className) ? 'FloatCurve' : 'FloatCurves';

  const curves = await connectionManager.sendHttp(
    'PUT', '/remote/object/property',
    { objectPath, propertyName, access: 'READ_ACCESS' },
    { skipCache: false }
  );

  return {
    object_path: objectPath,
    class: className,
    property: propertyName,
    curves,
  };
}

/**
 * get_mesh_info — batch-call 5 UStaticMesh UFUNCTIONs in one round-trip
 * and flatten into a structured response.
 *
 * All five are BlueprintCallable on UStaticMesh: GetNumVertices,
 * GetNumTriangles, GetNumLODs, GetBounds, GetStaticMaterials. Per-call
 * responses arrive in `Responses[]` with the originating order preserved.
 */
async function execGetMeshInfo(args, connectionManager) {
  const objectPath = args.asset_path || args.target;
  if (!objectPath) throw new Error('get_mesh_info: asset_path or target required');

  const batch = rc.rcBatch([
    { method: 'PUT', path: '/remote/object/call',
      body: { objectPath, functionName: 'GetNumVertices', parameters: {}, generateTransaction: false } },
    { method: 'PUT', path: '/remote/object/call',
      body: { objectPath, functionName: 'GetNumTriangles', parameters: {}, generateTransaction: false } },
    { method: 'PUT', path: '/remote/object/call',
      body: { objectPath, functionName: 'GetNumLODs', parameters: {}, generateTransaction: false } },
    { method: 'PUT', path: '/remote/object/call',
      body: { objectPath, functionName: 'GetBounds', parameters: {}, generateTransaction: false } },
    { method: 'PUT', path: '/remote/object/call',
      body: { objectPath, functionName: 'GetStaticMaterials', parameters: {}, generateTransaction: false } },
  ]);
  const res = await connectionManager.sendHttp(batch.method, batch.path, batch.body, { skipCache: false });
  const r = res.Responses || [];
  const out = {
    object_path:    objectPath,
    vertices:       pickReturn(r[0]),
    triangles:      pickReturn(r[1]),
    lods:           pickReturn(r[2]),
    bounds:         pickReturn(r[3]),
    material_slots: pickReturn(r[4]),
  };
  // W-G (D144): surface non-2xx batch sub-responses as `_subErrors[]` so
  // partial-failure stops looking like a clean response with null fields.
  const subErrors = collectSubErrors(r, ['vertices', 'triangles', 'lods', 'bounds', 'material_slots']);
  if (subErrors.length > 0) out._subErrors = subErrors;
  return out;
}

function pickReturn(response) {
  if (!response || !response.ResponseBody) return null;
  // Treat non-2xx batch sub-responses as null rather than leaking an error body.
  if (response.ResponseCode && (response.ResponseCode < 200 || response.ResponseCode >= 300)) return null;
  const body = response.ResponseBody;
  return body.ReturnValue !== undefined ? body.ReturnValue : body;
}

/**
 * set_material_parameter — set a scalar, vector, or texture parameter on a
 * UMaterialInstanceConstant via RC HTTP (D101 (ii) — RC delegate over plugin
 * C++ handler).
 *
 * The native SetParameterValue helper records the instance in its own Undo
 * transaction. Verify the mutation through uncached readback and overrides.
 *
 * Type discrimination:
 *   - `parameter_type` explicit override wins
 *   - else auto-detect: number → scalar, array/object → vector, string → texture
 *
 * Vector value normalization: accepts either {R,G,B,A} object (RC-native
 * FLinearColor shape) or [r,g,b,a] array (caller convenience). Texture value
 * is passed as the asset path string — RC resolves it to UTexture* internally.
 */
async function execSetMaterialParameter(args, connectionManager) {
  const objectPath = args.asset_path;
  const parameterName = args.parameter_name;
  const value = args.value;
  const association = args.association;
  const index = args.index ?? -1;
  if (association === 'global' ? index !== -1 : index < 0) {
    throw new Error('set_material_parameter: global index must be -1; layer/blend requires an explicit nonnegative index');
  }

  let paramType = args.parameter_type;
  if (!paramType) {
    if (typeof value === 'number') {
      paramType = 'scalar';
    } else if (Array.isArray(value) || (value && typeof value === 'object')) {
      paramType = 'vector';
    } else if (typeof value === 'string') {
      paramType = 'texture';
    } else {
      throw new Error(`set_material_parameter: cannot auto-detect parameter_type from value (${typeof value}); pass parameter_type explicitly`);
    }
  }

  let parameters;
  switch (paramType) {
    case 'scalar': {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new Error(`set_material_parameter: scalar requires numeric value (got ${typeof value})`);
      }
      parameters = { Value: value };
      break;
    }
    case 'vector': {
      let r = 0, g = 0, b = 0, a = 1;
      if (Array.isArray(value)) {
        [r = 0, g = 0, b = 0, a = 1] = value;
      } else if (value && typeof value === 'object') {
        // Accept either {R,G,B,A} (RC-native) or {r,g,b,a} (lowercase).
        r = value.R ?? value.r ?? 0;
        g = value.G ?? value.g ?? 0;
        b = value.B ?? value.b ?? 0;
        a = value.A ?? value.a ?? 1;
      } else {
        throw new Error(`set_material_parameter: vector requires array or object value (got ${typeof value})`);
      }
      if (![r, g, b, a].every(component => typeof component === 'number' && Number.isFinite(component))) {
        throw new Error('set_material_parameter: vector components must be finite numbers');
      }
      parameters = { Value: { R: r, G: g, B: b, A: a } };
      break;
    }
    case 'texture': {
      if (typeof value !== 'string') {
        throw new Error(`set_material_parameter: texture requires asset-path string (got ${typeof value})`);
      }
      parameters = { Value: value };
      break;
    }
    default:
      throw new Error(`set_material_parameter: unknown parameter_type '${paramType}' (expected scalar|vector|texture)`);
  }

  const description = await describeMaterialObject(objectPath, connectionManager);
  if (description.Class !== '/Script/Engine.MaterialInstanceConstant') {
    const probe = rc.rcCallFunction({
      objectPath: '/Script/Engine.Default__KismetMathLibrary',
      functionName: 'ClassIsChildOf',
      parameters: { TestClass: description.Class, ParentClass: '/Script/Engine.MaterialInstanceConstant' },
      generateTransaction: false,
    });
    let inheritance;
    try {
      inheritance = await connectionManager.sendHttp(probe.method, probe.path, probe.body, { skipCache: true });
    } catch (error) {
      throw new Error(`set_material_parameter: cannot verify UMaterialInstanceConstant inheritance; allow KismetMathLibrary.ClassIsChildOf in Remote Control (${error.message})`);
    }
    if (inheritance.ReturnValue !== true) throw new Error('set_material_parameter requires a UMaterialInstanceConstant or subclass');
  }
  const typeName = paramType[0].toUpperCase() + paramType.slice(1);
  if (association !== 'global') return execAssociatedMaterialParameter({
    objectPath, parameterName, paramType, typeName, association, index, value: parameters.Value,
  }, connectionManager);
  const callLibrary = async (name, args, generateTransaction = false) => {
    const req = rc.rcCallFunction({ objectPath: MATERIAL_EDITING_LIBRARY, functionName: name, parameters: args, generateTransaction });
    return connectionManager.sendHttp(req.method, req.path, req.body, { skipCache: true });
  };
  const definitionRequest = rc.rcCallFunction({
    objectPath: '/Script/UEMCP.Default__UEMCPMaterialParameterLibrary',
    functionName: 'GetGlobalParameterNames',
    parameters: { Material: objectPath, ParameterType: typeName },
    generateTransaction: false,
  });
  let names;
  try {
    names = await connectionManager.sendHttp(definitionRequest.method, definitionRequest.path, definitionRequest.body, { skipCache: true });
  } catch (error) {
    throw new Error(`set_material_parameter: global definition lookup requires the UEMCP 1.0.20+ plugin and permission for UEMCPMaterialParameterLibrary.GetGlobalParameterNames (${error.message})`);
  }
  if (!Array.isArray(names.ReturnValue) || names.ReturnValue.some(name => typeof name !== 'string')) {
    throw new Error('set_material_parameter: malformed global parameter definition response');
  }
  const sameName = (left, right) => typeof left === 'string' && left.toLowerCase() === right.toLowerCase();
  const canonicalName = names.ReturnValue.find(name => sameName(name, parameterName));
  if (canonicalName === undefined) {
    throw new Error(`set_material_parameter: global ${paramType} definition '${parameterName}' not found (ensure the material instance is loaded)`);
  }
  const target = { Instance: objectPath, ParameterName: canonicalName, Association: 'GlobalParameter' };
  // A transaction on the MaterialEditingLibrary CDO does not capture the MIC.
  // The native helper records Instance->Modify() inside its own transaction.
  const writeRequest = rc.rcCallFunction({
    objectPath: '/Script/UEMCP.Default__UEMCPMaterialParameterLibrary', functionName: 'SetParameterValue',
    parameters: { ...target, ParameterType: typeName, Index: -1,
      ScalarValue: paramType === 'scalar' ? parameters.Value : 0,
      VectorValue: paramType === 'vector' ? parameters.Value : { R: 0, G: 0, B: 0, A: 1 },
      TextureValue: paramType === 'texture' ? parameters.Value : null,
    },
    generateTransaction: false,
  });
  const res = await connectionManager.sendHttp(writeRequest.method, writeRequest.path, writeRequest.body, { skipCache: true });
  if (res.ReturnValue !== true) throw new Error('set_material_parameter: native global write was rejected');
  const readback = await callLibrary(`GetMaterialInstance${typeName}ParameterValue`, target);
  const close = (left, right) => typeof left === 'number' && Number.isFinite(left)
    && Math.abs(left - right) <= 1e-6 * Math.abs(right);
  const texturePath = path => typeof path === 'string' && !path.includes('.')
    ? `${path}.${path.split('/').pop()}` : path;
  const matchesValue = actual => paramType === 'scalar' ? close(actual, parameters.Value)
    : paramType === 'vector' ? ['R', 'G', 'B', 'A'].every(key => close(actual?.[key], parameters.Value[key]))
      : typeof actual === 'string' && texturePath(actual) === texturePath(parameters.Value);
  if (!matchesValue(readback.ReturnValue)) throw new Error(`set_material_parameter: ${paramType} readback did not match the requested value`);
  // Effective getters may return an inherited value or a default even when
  // the write failed (e.g. a layer-only name sent to the global setter).
  // Require the typed override on this instance, not just matching readback.
  const propertyName = `${typeName}ParameterValues`;
  const req = rc.rcGetProperty({ objectPath, propertyName });
  const overrides = await connectionManager.sendHttp(req.method, req.path, req.body, { skipCache: true });
  const override = Array.isArray(overrides[propertyName]) && overrides[propertyName].find(row => {
    const info = row?.ParameterInfo;
    return sameName(info?.Name, canonicalName) && info.Index === -1
      && [2, 'GlobalParameter', 'Global Parameter'].includes(info.Association)
      && matchesValue(row.ParameterValue);
  });
  if (!override) throw new Error(`set_material_parameter: ${paramType} global override was not verified on the instance`);
  return {
    asset_path: objectPath,
    parameter_name: parameterName,
    parameter_type: paramType,
    association,
    index,
    function_called: 'SetParameterValue',
    verified: true,
    response: res,
  };
}

async function execAssociatedMaterialParameter(target, connectionManager) {
  const { objectPath, parameterName, paramType, typeName, association, index, value } = target;
  const Association = association === 'layer' ? 'LayerParameter' : 'BlendParameter';
  const call = async (functionName, parameters) => {
    const req = rc.rcCallFunction({ objectPath: '/Script/UEMCP.Default__UEMCPMaterialParameterLibrary',
      functionName, parameters, generateTransaction: false });
    return connectionManager.sendHttp(req.method, req.path, req.body, { skipCache: true });
  };
  const read = async () => extractParamDetails({ ResponseBody: await call('GetParameterDetails', {
    Material: objectPath, ParameterType: typeName,
  }) }, paramType).find(row => row.Name.toLowerCase() === parameterName.toLowerCase()
    && row.Association === Association && row.Index === index);
  const definition = await read();
  if (!definition) throw new Error('set_material_parameter: requested name/association/index definition not found');
  const response = await call('SetParameterValue', { Instance: objectPath, ParameterType: typeName,
    ParameterName: definition.Name, Association, Index: index,
    ScalarValue: paramType === 'scalar' ? value : 0,
    VectorValue: paramType === 'vector' ? value : { R: 0, G: 0, B: 0, A: 1 },
    TextureValue: paramType === 'texture' ? value : null,
  });
  if (response.ReturnValue !== true) throw new Error('set_material_parameter: native associated write was rejected');
  const normalizeTexture = path => typeof path === 'string' && !path.includes('.') ? `${path}.${path.split('/').pop()}` : path;
  const close = (a, b) => Number.isFinite(a) && Math.abs(a - b) <= 1e-6 * Math.abs(b);
  const matches = actual => paramType === 'scalar' ? close(actual, value)
    : paramType === 'vector' ? ['R', 'G', 'B', 'A'].every(key => close(actual?.[key], value[key]))
      : normalizeTexture(actual) === normalizeTexture(value);
  const readback = await read();
  if (!readback?.ValueFound || !matches(readback.Value)) throw new Error('set_material_parameter: associated readback did not match');
  const propertyName = `${typeName}ParameterValues`;
  const req = rc.rcGetProperty({ objectPath, propertyName });
  const overrides = await connectionManager.sendHttp(req.method, req.path, req.body, { skipCache: true });
  const valid = overrides[propertyName]?.some(row => row?.ParameterInfo?.Name?.toLowerCase() === definition.Name.toLowerCase()
    && row.ParameterInfo.Index === index && [Association, association === 'layer' ? 'Layer Parameter' : 'Blend Parameter', association === 'layer' ? 0 : 1].includes(row.ParameterInfo.Association)
    && matches(row.ParameterValue));
  if (!valid) throw new Error('set_material_parameter: exact associated override was not verified');
  return { asset_path: objectPath, parameter_name: definition.Name, parameter_type: paramType,
    association, index, function_called: 'SetParameterValue', verified: true, response };
}

const DELEGATE_EXECS = {
  list_material_parameters: execListMaterialParameters,
  get_curve_asset:          execGetCurveAsset,
  get_mesh_info:            execGetMeshInfo,
  set_material_parameter:   execSetMaterialParameter,
};

/**
 * Execute an RC-backed tool.
 *
 * @param {string} toolName                            tools.yaml name
 * @param {object} args                                raw args (validated here)
 * @param {import('./connection-manager.mjs').ConnectionManager} connectionManager
 * @returns {Promise<object>}
 */
export async function executeRcTool(toolName, args, connectionManager) {
  const def = RC_SCHEMAS[toolName];
  if (!def) throw new Error(`rc-tools: unknown tool "${toolName}"`);

  // Defensive Zod parse — tests, internal reuse, and mock harnesses bypass the
  // SDK's tools/call parsing, so we can't assume args are already shaped.
  const validated = z.object(def.schema).parse(args);

  // Semantic delegates orchestrate multiple RC calls + aggregate.
  if (DELEGATE_EXECS[toolName]) {
    return DELEGATE_EXECS[toolName](validated, connectionManager);
  }

  const { method, path, body } = buildRcRequest(toolName, validated);
  return connectionManager.sendHttp(method, path, body, { skipCache: !def.isReadOp });
}

/**
 * Export tool definitions for server.mjs registration.
 * Shape matches tcp-tools.mjs getActorsToolDefs() contract.
 */
export function getRcToolDefs() {
  return RC_SCHEMAS;
}
