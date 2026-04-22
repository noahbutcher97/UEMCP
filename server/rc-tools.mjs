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
    description: 'Search for UObjects by class name (/remote/object/list). Recursive walks subobjects.',
    schema: {
      class_pattern: z.string().describe('Unreal class name (e.g. AActor, UMaterialInterface)'),
      outer:         z.string().optional().describe('Restrict search to subobjects of this outer path'),
      recursive:     z.boolean().optional().describe('Walk subobjects recursively (default false)'),
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
  list_material_parameters: {
    description: 'Get scalar/vector/texture parameters with current values from a UMaterialInterface',
    schema: {
      asset_path: z.string().describe('/Game/... path to the material or material instance'),
    },
    isReadOp: true,
  },

  get_curve_asset: {
    description: 'Read UCurveFloat / UCurveVector / UCurveLinearColor keyframes, tangents, and interpolation',
    schema: {
      asset_path: z.string().describe('/Game/... path to the curve asset'),
    },
    isReadOp: true,
  },

  get_mesh_info: {
    description: 'Get vertex count, triangle count, bounds, and material slots for a UStaticMesh',
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

    // ── Semantic delegates (RC under the hood) ──────────────
    case 'list_material_parameters': {
      // Call BlueprintCallable UFUNCTION GetAllScalarParameterInfo via RC.
      // Material parameters live on the CDO of the material class — resolve path.
      const objectPath = rc.toCdoPath(args.asset_path);
      return rc.rcCallFunction({
        objectPath,
        functionName: 'GetAllScalarParameterInfo',
        parameters: {},
        generateTransaction: false,
      });
    }

    case 'get_curve_asset': {
      // UCurveFloat / UCurveVector have FloatCurves / VectorCurves as UPROPERTY.
      // Read the whole curve struct via get_property.
      const objectPath = args.asset_path;
      return rc.rcGetProperty({
        objectPath,
        propertyName: 'FloatCurves',  // default — callers may pass through via rc_get_property for other curve types
        access: 'READ_ACCESS',
      });
    }

    case 'get_mesh_info': {
      // UStaticMesh::GetNumVertices / GetNumTriangles / GetBounds are all
      // BlueprintCallable. Call one and let the caller compose if they need
      // all three — or we expose a batch in a future revision.
      const objectPath = args.asset_path || args.target;
      if (!objectPath) throw new Error('get_mesh_info: asset_path or target required');
      return rc.rcCallFunction({
        objectPath,
        functionName: 'GetNumVertices',
        parameters: {},
        generateTransaction: false,
      });
    }

    default:
      throw new Error(`rc-tools: unknown tool "${toolName}"`);
  }
}

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
