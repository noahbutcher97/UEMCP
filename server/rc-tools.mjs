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
      body:     z.record(z.any()).optional().describe('Optional JSON body'),
    },
    // Conservative: we don't know what the caller is doing — skip cache.
    isReadOp: false,
  },

  // ── 3 semantic delegates (RC-internal substrate, TCP-external signature) ──
  // Dispatched via DELEGATE_EXECS in executeRcTool — multi-call orchestrations,
  // not single-shot primitives.
  list_material_parameters: {
    description: 'Get scalar, vector, and texture parameter info from a UMaterialInterface (names and IDs only; values require rc_call_function with GetScalar/Vector/TextureParameterValue per name).',
    schema: {
      asset_path: z.string().describe('/Game/... path to the material or material instance'),
    },
    isReadOp: true,
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
 * list_material_parameters — batch-call the three info UFUNCTIONs
 * (scalar, vector, texture) on a UMaterialInterface and merge results.
 *
 * Returns parameter info only (names + IDs); values require per-parameter
 * GetScalarParameterValue/GetVectorParameterValue/GetTextureParameterValue
 * calls, exposed via rc_call_function. Batching values inline would inflate
 * round-trips proportional to parameter count without a clear ceiling.
 */
async function execListMaterialParameters(args, connectionManager) {
  const objectPath = rc.toCdoPath(args.asset_path);
  const batch = rc.rcBatch([
    { method: 'PUT', path: '/remote/object/call',
      body: { objectPath, functionName: 'GetAllScalarParameterInfo', parameters: {}, generateTransaction: false } },
    { method: 'PUT', path: '/remote/object/call',
      body: { objectPath, functionName: 'GetAllVectorParameterInfo', parameters: {}, generateTransaction: false } },
    { method: 'PUT', path: '/remote/object/call',
      body: { objectPath, functionName: 'GetAllTextureParameterInfo', parameters: {}, generateTransaction: false } },
  ]);
  const res = await connectionManager.sendHttp(batch.method, batch.path, batch.body, { skipCache: false });
  const r = res.Responses || [];
  return {
    object_path: objectPath,
    scalar:  extractParamInfo(r[0]),
    vector:  extractParamInfo(r[1]),
    texture: extractParamInfo(r[2]),
  };
}

function extractParamInfo(response) {
  if (!response || !response.ResponseBody) return [];
  // Treat non-2xx batch sub-responses as empty rather than leaking an error body.
  if (response.ResponseCode && (response.ResponseCode < 200 || response.ResponseCode >= 300)) return [];
  const body = response.ResponseBody;
  return body.OutInfo || body.OutParameterInfo || body.ReturnValue || [];
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
  return {
    object_path:    objectPath,
    vertices:       pickReturn(r[0]),
    triangles:      pickReturn(r[1]),
    lods:           pickReturn(r[2]),
    bounds:         pickReturn(r[3]),
    material_slots: pickReturn(r[4]),
  };
}

function pickReturn(response) {
  if (!response || !response.ResponseBody) return null;
  // Treat non-2xx batch sub-responses as null rather than leaking an error body.
  if (response.ResponseCode && (response.ResponseCode < 200 || response.ResponseCode >= 300)) return null;
  const body = response.ResponseBody;
  return body.ReturnValue !== undefined ? body.ReturnValue : body;
}

const DELEGATE_EXECS = {
  list_material_parameters: execListMaterialParameters,
  get_curve_asset:          execGetCurveAsset,
  get_mesh_info:            execGetMeshInfo,
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
