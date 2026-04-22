// RC URL-Scheme Translator
//
// Converts M-enhance tool params → Remote Control HTTP {method, path, body}.
// The WebRemoteControl plugin (Engine/Plugins/VirtualProduction/RemoteControl)
// exposes a fixed set of endpoints; this module encodes the per-operation
// shapes in one place so tool handlers stay declarative.
//
// Reference: UE 5.6 WebRemoteControl docs + RemoteControlRoute enumeration.
// Spec tracker: docs/research/fa-epsilon-tcp-vs-rc-2026-04-21.md §Q2.
//
// Object paths come in two flavors:
//   CDO read:     /Game/Blueprints/Character/BP_OSPlayerR.BP_OSPlayerR_C:Default__BP_OSPlayerR_C
//   Live actor:   /Game/Maps/Main.Main:PersistentLevel.BP_OSPlayerR_2
//   World setting: /Engine/Transient.Engine:Settings
// The caller is responsible for supplying a resolved objectPath — we do not
// guess at :Default__ prefixes here; guessing inside the translator hides
// resolution bugs in the handler layer.

/**
 * Get-property read.
 * @param {object} p
 * @param {string} p.objectPath   fully-qualified UObject path
 * @param {string} p.propertyName
 * @param {string} [p.access]     "READ_ACCESS" (default) | others per RC spec
 * @returns {{method: string, path: string, body: object}}
 */
export function rcGetProperty({ objectPath, propertyName, access = 'READ_ACCESS' }) {
  if (!objectPath) throw new Error('rcGetProperty: objectPath required');
  if (!propertyName) throw new Error('rcGetProperty: propertyName required');
  return {
    method: 'PUT',
    path: '/remote/object/property',
    body: { objectPath, propertyName, access },
  };
}

/**
 * Set-property write.
 * @param {object} p
 * @param {string} p.objectPath
 * @param {string} p.propertyName
 * @param {any}    p.propertyValue  scalar or nested object — RC does its own coercion
 * @param {boolean} [p.generateTransaction]  true → wraps in editor Undo scope
 * @param {string} [p.access]        "WRITE_TRANSACTION_ACCESS" (default) | others
 */
export function rcSetProperty({ objectPath, propertyName, propertyValue, generateTransaction = true, access = 'WRITE_TRANSACTION_ACCESS' }) {
  if (!objectPath) throw new Error('rcSetProperty: objectPath required');
  if (!propertyName) throw new Error('rcSetProperty: propertyName required');
  return {
    method: 'PUT',
    path: '/remote/object/property',
    body: {
      objectPath,
      propertyName,
      propertyValue: { [propertyName]: propertyValue },
      generateTransaction,
      access,
    },
  };
}

/**
 * Call a BlueprintCallable / Exec UFUNCTION via reflection.
 * RC's /remote/object/call endpoint invokes an exposed UFUNCTION by name.
 * Return value comes back as {<paramName>: value} or ReturnValue on call.
 */
export function rcCallFunction({ objectPath, functionName, parameters = {}, generateTransaction = false }) {
  if (!objectPath) throw new Error('rcCallFunction: objectPath required');
  if (!functionName) throw new Error('rcCallFunction: functionName required');
  return {
    method: 'PUT',
    path: '/remote/object/call',
    body: { objectPath, functionName, parameters, generateTransaction },
  };
}

/**
 * Describe an object — returns exposed properties + functions + metadata subset.
 * NOTE: WebRemoteControl SanitizeMetadata allowlist caps the Metadata field to
 * {UIMin, UIMax, ClampMin, ClampMax, ToolTip} — D66 / FA-ε §Q2. If you need
 * Category/Replicated/EditAnywhere etc., use the plugin's reflection walker.
 */
export function rcDescribeObject({ objectPath }) {
  if (!objectPath) throw new Error('rcDescribeObject: objectPath required');
  return {
    method: 'PUT',
    path: '/remote/object/describe',
    body: { objectPath },
  };
}

/**
 * List preset inventory.
 * GET /remote/presets — returns {Presets: [{Name, Path}, ...]}.
 */
export function rcGetPresets() {
  return { method: 'GET', path: '/remote/presets', body: null };
}

/**
 * Get a single preset's exposed properties/functions by name or id.
 * @param {object} p
 * @param {string} p.preset  name or id
 */
export function rcGetPreset({ preset }) {
  if (!preset) throw new Error('rcGetPreset: preset required');
  return {
    method: 'GET',
    path: `/remote/preset/${encodeURIComponent(preset)}`,
    body: null,
  };
}

/**
 * Batch multiple RC ops into one HTTP request.
 * RC's /remote/batch runs each sub-request in order and returns an array of
 * {ResponseCode, ResponseBody} entries — same order as input.
 *
 * @param {Array<{method: string, path: string, body?: object}>} ops
 */
export function rcBatch(ops) {
  if (!Array.isArray(ops) || ops.length === 0) {
    throw new Error('rcBatch: ops must be non-empty array');
  }
  const Requests = ops.map((op, i) => ({
    RequestId: i,
    URL: op.path,
    Verb: op.method,
    Body: op.body || {},
  }));
  return {
    method: 'PUT',
    path: '/remote/batch',
    body: { Requests },
  };
}

/**
 * Raw passthrough — lets advanced callers hit any RC endpoint directly when
 * the structured helpers above don't cover a shape. Minimal validation.
 */
export function rcPassthrough({ method, path, body = null }) {
  if (!method || !path) throw new Error('rcPassthrough: method + path required');
  if (!path.startsWith('/remote/')) {
    throw new Error(`rcPassthrough: path must begin with /remote/ (got ${path})`);
  }
  return { method, path, body };
}

/**
 * List objects by class name via the discovery endpoint.
 * RC exposes /remote/object/list which takes {Class, Outer?, Recursive?} and
 * returns an array of object paths. Useful for inventory without knowing
 * specific paths up-front.
 */
export function rcListObjects({ className, outer = null, recursive = false }) {
  if (!className) throw new Error('rcListObjects: className required');
  const body = { Class: className, Recursive: !!recursive };
  if (outer) body.Outer = outer;
  return { method: 'PUT', path: '/remote/object/list', body };
}

/**
 * Resolve a CDO objectPath for a UClass asset path.
 * `/Game/Blueprints/X.BP_X_C` → `/Game/Blueprints/X.BP_X_C:Default__BP_X_C`
 *
 * Helper used by tool handlers that want CDO property reads without the
 * caller having to remember the `:Default__<ClassName>` suffix convention.
 *
 * @param {string} classPath  e.g. "/Game/Blueprints/Character/BP_OSPlayerR.BP_OSPlayerR_C"
 */
export function toCdoPath(classPath) {
  if (!classPath) return classPath;
  // Already resolved (has subobject marker).
  if (classPath.includes(':Default__')) return classPath;
  // Extract class name after the last '.' — e.g. "BP_OSPlayerR_C".
  const dot = classPath.lastIndexOf('.');
  if (dot < 0) return classPath;
  const className = classPath.slice(dot + 1);
  return `${classPath}:Default__${className}`;
}
