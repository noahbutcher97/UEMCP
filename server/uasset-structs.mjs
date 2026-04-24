// Level 2 struct handlers for UE 5.6 serialized .uasset/.umap property values.
//
// Each handler reads the value bytes of a StructProperty<StructName> according
// to the named struct's known layout. Two serialization paths are possible:
//
//   Tagged sub-stream (outer flag bit 0x08 = 0):
//     The struct's value is itself a stream of FPropertyTag entries
//     terminated by "None". We recurse into readTaggedPropertyStream.
//
//   Native binary (outer flag bit 0x08 = 1 — HasBinaryOrNativeSerialize):
//     The struct uses a per-type binary format (FVector: 3 doubles;
//     FGameplayTagContainer: int32 count + N × FName; etc.).
//
// A handler may support either or both; unsupported flag combinations return
// a `{__unsupported__, reason}` marker so the top-level reader emits a
// {unsupported, reason} entry for the property without crashing.
//
// References (verified 2026-04-16 against a production UE 5.6 project corpus + CUE4Parse master):
//   - FVector/FRotator/FQuat: 3/3/4 × double (UE5 switched from float to double)
//   - FTransform: FQuat(32) + FVector(24) Translation + FVector(24) Scale3D = 80
//   - FLinearColor: 4 × float32 = 16
//   - FColor: 4 × uint8 in BGRA order = 4
//   - FGuid: 4 × uint32 = 16
//   - FGameplayTag: FName (UE 5.6+) or FString (<5.6) — we only target 5.6+
//   - FGameplayTagContainer: int32 count + N × FName (native binary, flag 0x08)
//   - FSoftObjectPath: FName (UE 5.1+ asset path) + FString (sub-path)

import { readFNameAtCursor, readTaggedPropertyStream } from './uasset-parser.mjs';

const HAS_BINARY_NATIVE = 0x08;

// ── Level 2.5 — simple-element containers (D46) ───────────────────────
//
// TArray / TSet of a single simple element type. Layout varies by inner type:
//
//   SCALAR inner (IntProperty, FloatProperty, ObjectProperty, ...):
//     int32 Count followed by Count × raw value bytes inline.
//
//   STRUCT inner with outer flag 0x08 (HasBinaryOrNativeSerialize):
//     int32 Count followed by Count × struct-native-binary bytes
//     (e.g., FVector = 24B, FLinearColor = 16B, FTransform = 80B).
//
//   STRUCT inner with outer flag 0x00 (tagged sub-stream):
//     int32 Count followed by Count × tagged property sub-streams, each
//     terminated by "None". Handled via readTaggedPropertyStream.
//
//   TSet additionally writes an int32 NumRemovedItems (typically 0) before
//   the array-shape body.
//
// Element types not covered by this module (arrays of custom UserDefinedStruct,
// TMap<K,V>, TArray<FMyCustomStruct> when the struct isn't a Level 2 engine
// struct) emit {unsupported, reason: "complex_element_container"} markers.

const INT_MAX_ELEMENTS = 65_536;

/** Readers for inner types that serialize inline raw bytes per element. */
const SCALAR_ELEMENT_READERS = new Map([
  ['IntProperty',        (cur) => cur.readInt32()],
  ['Int8Property',       (cur) => cur.readInt8()],
  ['Int16Property',      (cur) => cur.readInt32()], // matches top-level int16 slot
  ['Int64Property',      (cur) => cur.readInt64AsNumber()],
  ['UInt16Property',     (cur) => cur.readUInt16()],
  ['UInt32Property',     (cur) => cur.readUInt32()],
  ['UInt64Property',     (cur) => cur.readInt64AsNumber()],
  ['FloatProperty',      (cur) => cur.readFloat()],
  ['DoubleProperty',     (cur) => cur.readDouble()],
  ['BoolProperty',       (cur) => cur.readUInt8() !== 0],
  ['ByteProperty',       (cur) => cur.readUInt8()],
  ['NameProperty',       (cur, names) => readFNameAtCursor(cur, names)],
  ['StrProperty',        (cur) => cur.readFString()],
  ['EnumProperty',       (cur, names) => readFNameAtCursor(cur, names)],
  ['ObjectProperty',     (cur, _names, opts) => {
    const idx = cur.readInt32();
    return opts?.resolve ? opts.resolve(idx) : { packageIndex: idx };
  }],
  ['ClassProperty',      (cur, _names, opts) => {
    const idx = cur.readInt32();
    return opts?.resolve ? opts.resolve(idx) : { packageIndex: idx };
  }],
  ['InterfaceProperty',  (cur, _names, opts) => {
    const idx = cur.readInt32();
    return opts?.resolve ? opts.resolve(idx) : { packageIndex: idx };
  }],
]);

/**
 * Try to read one struct element from the cursor. Dispatch via the struct
 * registry. Respects the flag propagated from the outer array (0x08 = native
 * binary; 0 = tagged sub-stream).
 *
 * Agent 10.5 tier 2 (D46): when no handler is registered for the struct and
 * the outer element stream is tagged (flag 0x00), fall through to a tagged
 * sub-stream read terminated by "None". This covers TArray<FMyCustomStruct>
 * where FMyCustomStruct is a UserDefinedStruct or an engine struct without a
 * registered handler — the inner tagged stream is self-describing just like
 * the top-level tier-3 fallback in dispatchPropertyValue.
 */
function readStructElement(cur, structName, outerFlags, names, opts) {
  const handler = opts.structHandlers?.get(structName);
  // Native binary requires a known layout. No handler + native = surrender.
  if (outerFlags & HAS_BINARY_NATIVE) {
    if (!handler) return { __unsupported__: true, reason: 'complex_element_container', inner_type: structName };
    const pseudoTag = { flags: outerFlags, size: 0, type: 'StructProperty', typeParams: [{ name: structName, params: [] }] };
    return handler(cur, pseudoTag, names, opts);
  }
  // Tagged path — element is a sub-stream terminated by "None". We can walk
  // it without a handler because each inner FPropertyTag carries its own
  // type + size.
  if (handler) {
    const pseudoTag = { flags: outerFlags, size: 0, type: 'StructProperty', typeParams: [{ name: structName, params: [] }] };
    return handler(cur, pseudoTag, names, opts);
  }
  const virtualEnd = cur.buf.length;
  const sub = readTaggedPropertyStream(cur, virtualEnd, names, opts);
  if (opts.resolvedUnknownStructs && structName) opts.resolvedUnknownStructs.add(structName);
  return extractKnownStructFields(structName, sub.properties);
}

/** Extract known field shapes from a decoded tagged sub-stream. */
function extractKnownStructFields(structName, p) {
  switch (structName) {
    case 'Vector':      return { x: p.X ?? 0, y: p.Y ?? 0, z: p.Z ?? 0 };
    case 'Vector2D':    return { x: p.X ?? 0, y: p.Y ?? 0 };
    case 'Vector4':     return { x: p.X ?? 0, y: p.Y ?? 0, z: p.Z ?? 0, w: p.W ?? 0 };
    case 'Rotator':     return { pitch: p.Pitch ?? 0, yaw: p.Yaw ?? 0, roll: p.Roll ?? 0 };
    case 'Quat':        return { x: p.X ?? 0, y: p.Y ?? 0, z: p.Z ?? 0, w: p.W ?? 0 };
    case 'LinearColor': return { r: p.R ?? 0, g: p.G ?? 0, b: p.B ?? 0, a: p.A ?? 1 };
    case 'Color':       return { r: p.R ?? 0, g: p.G ?? 0, b: p.B ?? 0, a: p.A ?? 255 };
    case 'IntPoint':    return { x: p.X ?? 0, y: p.Y ?? 0 };
    case 'Box':         return { min: p.Min ?? null, max: p.Max ?? null, isValid: p.IsValid ?? false };
    case 'GameplayTag': return { tagName: p.TagName ?? null };
    case 'SoftObjectPath': return { assetPath: p.AssetPath ?? null, subPath: p.SubPathString ?? '' };
    default: return p;
  }
}

/** Read `count` elements of `innerTypeParams` from cur. Returns array or marker. */
function readArrayElements(cur, outerTag, count, innerTypeParams, names, opts) {
  const innerTypeName = innerTypeParams?.[0]?.name ?? null;
  const elements = [];
  const scalarReader = innerTypeName && SCALAR_ELEMENT_READERS.get(innerTypeName);
  if (scalarReader) {
    for (let i = 0; i < count; i++) elements.push(scalarReader(cur, names, opts));
    return elements;
  }
  if (innerTypeName === 'StructProperty') {
    const structName = innerTypeParams[0].params?.[0]?.name ?? null;
    if (!structName) {
      return { __unsupported__: true, reason: 'complex_element_container', inner_type: '<null>' };
    }
    // Tier 2 (D46): tagged-stream elements walk without a handler; only native
    // binary requires a known layout and fails out here.
    const hasHandler = opts.structHandlers?.has(structName);
    if ((outerTag.flags & HAS_BINARY_NATIVE) && !hasHandler) {
      return { __unsupported__: true, reason: 'complex_element_container', inner_type: structName };
    }
    for (let i = 0; i < count; i++) {
      const el = readStructElement(cur, structName, outerTag.flags, names, opts);
      if (el && el.__unsupported__) {
        // Abort on first unsupported element — cursor likely desynced.
        return { __unsupported__: true, reason: el.reason, inner_type: el.inner_type };
      }
      elements.push(el);
    }
    return elements;
  }
  if (innerTypeName === 'SoftObjectProperty' || innerTypeName === 'SoftClassProperty') {
    for (let i = 0; i < count; i++) {
      elements.push({ assetPath: readFNameAtCursor(cur, names), subPath: cur.readFString() });
    }
    return elements;
  }
  return { __unsupported__: true, reason: 'complex_element_container', inner_type: innerTypeName ?? '<null>' };
}

// ── Container handlers (ArrayProperty / SetProperty) ──────────────────

export function handleArrayProperty(cur, tag, names, opts) {
  const count = cur.readInt32();
  if (count < 0 || count > INT_MAX_ELEMENTS) {
    return { __unsupported__: true, reason: 'container_count_unreasonable', inner_type: tag.typeParams?.[0]?.name };
  }
  return readArrayElements(cur, tag, count, tag.typeParams, names, opts);
}

// Agent 10.5 tier 2 (D46): TMap<K, V> handler.
//
// Wire format:
//   int32 NumRemovedKeys  (typically 0 outside save-game deltas)
//   int32 NumElements
//   per element: key_bytes value_bytes (both raw, no per-entry tag header)
//
// Key type dispatch reads tag.typeParams[0]; value type reads tag.typeParams[1].
// Supported keys: scalars through SCALAR_ELEMENT_READERS (int/name/str/enum/etc.).
// Struct keys emit {unsupported, reason:"struct_key_map"} — the wire format
// for struct keys varies with the struct's serialization traits and requires
// a resolver this tier doesn't ship.
export function handleMapProperty(cur, tag, names, opts) {
  const numRemoved = cur.readInt32();
  if (numRemoved < 0 || numRemoved > INT_MAX_ELEMENTS) {
    return { __unsupported__: true, reason: 'container_count_unreasonable' };
  }
  if (numRemoved > 0) {
    // TMap save-game deltas serialize removed keys before new entries.
    return { __unsupported__: true, reason: 'map_with_removed_items' };
  }
  const count = cur.readInt32();
  if (count < 0 || count > INT_MAX_ELEMENTS) {
    return { __unsupported__: true, reason: 'container_count_unreasonable' };
  }
  const keyType = tag.typeParams?.[0]?.name ?? null;
  const valueTypeParams = tag.typeParams?.[1] ?? null;
  const valueType = valueTypeParams?.name ?? null;
  if (!keyType || !valueType) {
    return { __unsupported__: true, reason: 'map_type_params_missing' };
  }
  if (keyType === 'StructProperty') {
    return { __unsupported__: true, reason: 'struct_key_map' };
  }
  const keyReader = SCALAR_ELEMENT_READERS.get(keyType);
  if (!keyReader) {
    return { __unsupported__: true, reason: 'map_key_type_unsupported', detail: keyType };
  }
  const valueScalarReader = SCALAR_ELEMENT_READERS.get(valueType);
  const entries = [];
  for (let i = 0; i < count; i++) {
    const key = keyReader(cur, names, opts);
    let value;
    if (valueScalarReader) {
      value = valueScalarReader(cur, names, opts);
    } else if (valueType === 'StructProperty') {
      const valStructName = valueTypeParams.params?.[0]?.name ?? null;
      if (!valStructName) {
        return { __unsupported__: true, reason: 'map_value_struct_name_missing' };
      }
      const el = readStructElement(cur, valStructName, tag.flags, names, opts);
      if (el && el.__unsupported__) {
        return { __unsupported__: true, reason: el.reason, inner_type: el.inner_type };
      }
      value = el;
    } else if (valueType === 'SoftObjectProperty' || valueType === 'SoftClassProperty') {
      value = { assetPath: readFNameAtCursor(cur, names), subPath: cur.readFString() };
    } else {
      return { __unsupported__: true, reason: 'map_value_type_unsupported', detail: valueType };
    }
    entries.push({ key, value });
  }
  return entries;
}

export function handleSetProperty(cur, tag, names, opts) {
  // TSet: int32 NumRemovedItems (typically 0 outside save-game deltas) + Count + elements.
  const numRemoved = cur.readInt32();
  if (numRemoved < 0 || numRemoved > INT_MAX_ELEMENTS) {
    return { __unsupported__: true, reason: 'container_count_unreasonable' };
  }
  // Skip any RemovedItem entries (rare; emit marker if present so we don't silently eat bytes).
  if (numRemoved > 0) {
    return { __unsupported__: true, reason: 'set_with_removed_items', inner_type: tag.typeParams?.[0]?.name };
  }
  const count = cur.readInt32();
  if (count < 0 || count > INT_MAX_ELEMENTS) {
    return { __unsupported__: true, reason: 'container_count_unreasonable' };
  }
  return readArrayElements(cur, tag, count, tag.typeParams, names, opts);
}

/**
 * Build the container handler registry for opts.containerHandlers.
 * @returns {Map<string, (cur, tag, names, opts) => any>}
 */
export function buildContainerHandlers() {
  return new Map([
    ['ArrayProperty', handleArrayProperty],
    ['SetProperty',   handleSetProperty],
    ['MapProperty',   handleMapProperty],
  ]);
}

// ── Primitive math structs (native binary; size is fixed) ───────────

export function readFVectorBinary(cur) {
  return { x: cur.readDouble(), y: cur.readDouble(), z: cur.readDouble() };
}

export function readFRotatorBinary(cur) {
  // UE stores Rotator as pitch, yaw, roll in the binary layout.
  return { pitch: cur.readDouble(), yaw: cur.readDouble(), roll: cur.readDouble() };
}

export function readFQuatBinary(cur) {
  return { x: cur.readDouble(), y: cur.readDouble(), z: cur.readDouble(), w: cur.readDouble() };
}

export function readFTransformBinary(cur) {
  return {
    rotation: readFQuatBinary(cur),
    translation: readFVectorBinary(cur),
    scale3D: readFVectorBinary(cur),
  };
}

export function readFLinearColorBinary(cur) {
  return { r: cur.readFloat(), g: cur.readFloat(), b: cur.readFloat(), a: cur.readFloat() };
}

export function readFColorBinary(cur) {
  // UE stores FColor in BGRA order on little-endian platforms. Return an RGBA
  // object for readability so callers don't have to remember the wire order.
  const b = cur.readUInt8();
  const g = cur.readUInt8();
  const r = cur.readUInt8();
  const a = cur.readUInt8();
  return { r, g, b, a };
}

export function readFGuidBinary(cur) {
  const bytes = cur.readBytes(16);
  return bytes.toString('hex');
}

// FVector2D: 2 × double
export function readFVector2DBinary(cur) {
  return { x: cur.readDouble(), y: cur.readDouble() };
}

// FVector4: 4 × double (UE5 LWC — UE4 was 4 × float32).
export function readFVector4Binary(cur) {
  return { x: cur.readDouble(), y: cur.readDouble(), z: cur.readDouble(), w: cur.readDouble() };
}

// FIntPoint: 2 × int32.
export function readFIntPointBinary(cur) {
  return { x: cur.readInt32(), y: cur.readInt32() };
}

// FBox: FVector Min + FVector Max + uint8 bIsValid (49 bytes in UE5).
export function readFBoxBinary(cur) {
  return {
    min: readFVectorBinary(cur),
    max: readFVectorBinary(cur),
    isValid: cur.readUInt8() !== 0,
  };
}

// ── Tagged-stream helper — extract named fields ─────────────────────

function readTaggedStructFields(cur, tag, names, opts) {
  const end = cur.tell() + tag.size;
  return readTaggedPropertyStream(cur, end, names, opts);
}

// Helper: prefer a field from a tagged sub-stream, coercing common conventions.
// UE tagged FVector writes X/Y/Z property names (or FloatProperty X, Y, Z).
function takeXYZ(fields) {
  const p = fields.properties || {};
  return { x: p.X ?? 0, y: p.Y ?? 0, z: p.Z ?? 0 };
}

// ── Struct handlers — dispatch on native-binary flag then fall back ───

function handleFVector(cur, tag, names, opts) {
  if (tag.flags & HAS_BINARY_NATIVE) return readFVectorBinary(cur);
  const fields = readTaggedStructFields(cur, tag, names, opts);
  return takeXYZ(fields);
}

function handleFRotator(cur, tag, names, opts) {
  if (tag.flags & HAS_BINARY_NATIVE) return readFRotatorBinary(cur);
  const f = readTaggedStructFields(cur, tag, names, opts).properties || {};
  return { pitch: f.Pitch ?? 0, yaw: f.Yaw ?? 0, roll: f.Roll ?? 0 };
}

function handleFQuat(cur, tag, names, opts) {
  if (tag.flags & HAS_BINARY_NATIVE) return readFQuatBinary(cur);
  const f = readTaggedStructFields(cur, tag, names, opts).properties || {};
  return { x: f.X ?? 0, y: f.Y ?? 0, z: f.Z ?? 0, w: f.W ?? 0 };
}

function handleFTransform(cur, tag, names, opts) {
  if (tag.flags & HAS_BINARY_NATIVE) return readFTransformBinary(cur);
  const f = readTaggedStructFields(cur, tag, names, opts).properties || {};
  return {
    rotation: f.Rotation ?? null,
    translation: f.Translation ?? null,
    scale3D: f.Scale3D ?? null,
  };
}

function handleFLinearColor(cur, tag, names, opts) {
  if (tag.flags & HAS_BINARY_NATIVE) return readFLinearColorBinary(cur);
  const f = readTaggedStructFields(cur, tag, names, opts).properties || {};
  return { r: f.R ?? 0, g: f.G ?? 0, b: f.B ?? 0, a: f.A ?? 1 };
}

function handleFColor(cur, tag, names, opts) {
  if (tag.flags & HAS_BINARY_NATIVE) return readFColorBinary(cur);
  const f = readTaggedStructFields(cur, tag, names, opts).properties || {};
  return { r: f.R ?? 0, g: f.G ?? 0, b: f.B ?? 0, a: f.A ?? 255 };
}

function handleFGuid(cur, tag, names, opts) {
  if (tag.flags & HAS_BINARY_NATIVE) return readFGuidBinary(cur);
  // Very rare — FGuid is almost always native-serialized. Fall back to
  // tagged stream with A/B/C/D uint32 fields.
  const f = readTaggedStructFields(cur, tag, names, opts).properties || {};
  const a = (f.A ?? 0) >>> 0;
  const b = (f.B ?? 0) >>> 0;
  const c = (f.C ?? 0) >>> 0;
  const d = (f.D ?? 0) >>> 0;
  return [a, b, c, d].map(n => n.toString(16).padStart(8, '0')).join('');
}

function handleFVector2D(cur, tag, names, opts) {
  if (tag.flags & HAS_BINARY_NATIVE) return readFVector2DBinary(cur);
  const f = readTaggedStructFields(cur, tag, names, opts).properties || {};
  return { x: f.X ?? 0, y: f.Y ?? 0 };
}

function handleFVector4(cur, tag, names, opts) {
  if (tag.flags & HAS_BINARY_NATIVE) return readFVector4Binary(cur);
  const f = readTaggedStructFields(cur, tag, names, opts).properties || {};
  return { x: f.X ?? 0, y: f.Y ?? 0, z: f.Z ?? 0, w: f.W ?? 0 };
}

function handleFIntPoint(cur, tag, names, opts) {
  if (tag.flags & HAS_BINARY_NATIVE) return readFIntPointBinary(cur);
  const f = readTaggedStructFields(cur, tag, names, opts).properties || {};
  return { x: f.X ?? 0, y: f.Y ?? 0 };
}

function handleFBox(cur, tag, names, opts) {
  if (tag.flags & HAS_BINARY_NATIVE) return readFBoxBinary(cur);
  const f = readTaggedStructFields(cur, tag, names, opts).properties || {};
  return { min: f.Min ?? null, max: f.Max ?? null, isValid: f.IsValid ?? false };
}

// FExpressionInput — material graph pin connector.
//
// UE 5.6 binary layout (36 bytes, flag 0x08 HAS_BINARY_NATIVE):
//   int32 Expression       FPackageIndex (4)
//   int32 OutputIndex              (4)
//   FName InputName                (8 — 2 × int32 idx+number)
//   int32 Mask                     (4)
//   int32 MaskR, MaskG, MaskB, MaskA (4 × 4)
//
// Verified against UE 5.6 SerializeExpressionInput (MaterialShared.cpp:408).
// Observed 99.8% native / 0.2% tagged in production-corpus bulk validation.
// Cross-referenced CUE4Parse FExpressionInput.cs (master) — matches.
function readFExpressionInputBinary(cur, names, opts) {
  const exprIdx = cur.readInt32();
  const outputIndex = cur.readInt32();
  const inputName = readFNameAtCursor(cur, names);
  const mask = cur.readInt32();
  const maskR = cur.readInt32();
  const maskG = cur.readInt32();
  const maskB = cur.readInt32();
  const maskA = cur.readInt32();
  let expression;
  if (exprIdx === 0) {
    expression = null;
  } else if (opts?.resolve) {
    expression = opts.resolve(exprIdx) ?? { packageIndex: exprIdx };
  } else {
    expression = { packageIndex: exprIdx };
  }
  return { expression, outputIndex, inputName, mask, maskR, maskG, maskB, maskA };
}

function handleFExpressionInput(cur, tag, names, opts) {
  if (tag.flags & HAS_BINARY_NATIVE) {
    return readFExpressionInputBinary(cur, names, opts);
  }
  const f = readTaggedStructFields(cur, tag, names, opts).properties || {};
  return {
    expression: f.Expression ?? null,
    outputIndex: f.OutputIndex ?? 0,
    inputName: f.InputName ?? null,
    expressionName: f.ExpressionName ?? null,
    mask: f.Mask ?? 0,
    maskR: f.MaskR ?? 0,
    maskG: f.MaskG ?? 0,
    maskB: f.MaskB ?? 0,
    maskA: f.MaskA ?? 0,
  };
}

// ── FMaterialInput<T> native variants ──
//
// SerializeMaterialInput<T>(Ar, Input) = SerializeExpressionInput(Ar, *this)
//   then: Ar << bUseConstantValue  (UE FArchive bool = uint32, 4 bytes)
//         Ar << Input.Constant     (sizeof(T) bytes)
//
// Types per UE 5.6 MaterialExpressionIO.h:
//   FColorMaterialInput       FMaterialInput<FLinearColor>  = 36 + 4 + 16 = 56
//   FScalarMaterialInput      FMaterialInput<float>         = 36 + 4 + 4  = 44
//   FShadingModelMaterialInput FMaterialInput<uint32>       = 36 + 4 + 4  = 44
//   FSubstrateMaterialInput   FMaterialInput<uint32>        = 36 + 4 + 4  = 44
//   FVectorMaterialInput      FMaterialInput<FVector3f>     = 36 + 4 + 12 = 52
//   FVector2MaterialInput     FMaterialInput<FVector2f>     = 36 + 4 + 8  = 48
//
// Note the *float32* element sizes in FVector3f / FVector2f / FLinearColor —
// material inputs keep render-thread precision, unlike UE5 LWC FVector
// (double-precision scene math).

function makeMaterialInputHandler(readConstant, fallbackConstant) {
  return function (cur, tag, names, opts) {
    if (!(tag.flags & HAS_BINARY_NATIVE)) {
      // Tagged fallback — inherit base FExpressionInput fields then accept
      // UseConstant / Constant if present. These structs are effectively never
      // tagged in practice (hand-trace on M_StylizedBasic: 0 / 38 instances).
      const base = handleFExpressionInput(cur, tag, names, opts);
      return { ...base, useConstant: false, constant: fallbackConstant() };
    }
    const base = readFExpressionInputBinary(cur, names, opts);
    const useConstant = cur.readInt32() !== 0;
    const constant = readConstant(cur);
    return { ...base, useConstant, constant };
  };
}

const handleFColorMaterialInput = makeMaterialInputHandler(
  (cur) => ({ r: cur.readFloat(), g: cur.readFloat(), b: cur.readFloat(), a: cur.readFloat() }),
  () => ({ r: 0, g: 0, b: 0, a: 0 }),
);
const handleFScalarMaterialInput = makeMaterialInputHandler(
  (cur) => cur.readFloat(),
  () => 0,
);
const handleFShadingModelMaterialInput = makeMaterialInputHandler(
  (cur) => cur.readUInt32(),
  () => 0,
);
const handleFSubstrateMaterialInput = makeMaterialInputHandler(
  (cur) => cur.readUInt32(),
  () => 0,
);
const handleFVectorMaterialInput = makeMaterialInputHandler(
  (cur) => ({ x: cur.readFloat(), y: cur.readFloat(), z: cur.readFloat() }),
  () => ({ x: 0, y: 0, z: 0 }),
);
const handleFVector2MaterialInput = makeMaterialInputHandler(
  (cur) => ({ x: cur.readFloat(), y: cur.readFloat() }),
  () => ({ x: 0, y: 0 }),
);

// FMaterialAttributesInput — Serialize() delegates to SerializeExpressionInput
// only; the uint64 PropertyConnectedMask member is NOT persisted in the byte
// stream (it's rebuilt at load time from connected pins). So this variant is
// the same 36-byte layout as the base.
function handleFMaterialAttributesInput(cur, tag, names, opts) {
  if (tag.flags & HAS_BINARY_NATIVE) {
    return readFExpressionInputBinary(cur, names, opts);
  }
  return handleFExpressionInput(cur, tag, names, opts);
}

// FBodyInstance — physics body settings. Dozens of UPROPERTYs; return the
// parsed tagged-stream object so callers see every serialized field verbatim.
// When an actor overrides only a subset of FBodyInstance members (the common
// case), only those overrides appear — the rest live at class default.
function handleFBodyInstance(cur, tag, names, opts) {
  if (tag.flags & HAS_BINARY_NATIVE) {
    return { __unsupported__: true, reason: 'body_instance_native_layout_unknown' };
  }
  return readTaggedStructFields(cur, tag, names, opts).properties || {};
}

// ── Gameplay tags ────────────────────────────────────────────────────

function handleFGameplayTag(cur, tag, names, opts) {
  // UE 5.6: FGameplayTag most commonly serializes as a tagged sub-stream
  // with a single TagName FName property (flag 0x00 in BPGA_Block CDO
  // fixtures). For native binary (flag 0x08) it would be an 8-byte FName,
  // though we haven't seen this path in fixtures.
  if (tag.flags & HAS_BINARY_NATIVE) {
    return { tagName: readFNameAtCursor(cur, names) };
  }
  const f = readTaggedStructFields(cur, tag, names, opts).properties || {};
  return { tagName: f.TagName ?? null };
}

function handleFGameplayTagContainer(cur, tag, names, opts) {
  // UE 5.6 fixtures show this serialized as native binary (flag 0x08):
  //   int32 count
  //   count × FName (8 bytes each)
  // Tagged-stream fallback walks the sub-stream for a `GameplayTags`
  // ArrayProperty, but that path is rare.
  if (tag.flags & HAS_BINARY_NATIVE) {
    const count = cur.readInt32();
    const tags = [];
    for (let i = 0; i < count; i++) {
      tags.push(readFNameAtCursor(cur, names));
    }
    return { tags };
  }
  const f = readTaggedStructFields(cur, tag, names, opts).properties || {};
  return { tags: Array.isArray(f.GameplayTags?.value) ? f.GameplayTags.value : (f.GameplayTags ?? []) };
}

// ── Soft-object paths ────────────────────────────────────────────────

function handleFSoftObjectPath(cur, tag, names, opts) {
  // UE 5.1+: FName AssetPath + FString SubPathString. The outer property
  // may appear as StructProperty<SoftObjectPath>, or as SoftObjectProperty
  // redirected here from dispatch.
  // Both serialized forms observed as native binary (flag 0x08), but we
  // also accept the tagged fallback.
  if (!(tag.flags & HAS_BINARY_NATIVE) && tag.type === 'StructProperty') {
    const f = readTaggedStructFields(cur, tag, names, opts).properties || {};
    return { assetPath: f.AssetPath ?? null, subPath: f.SubPathString ?? '' };
  }
  const assetPath = readFNameAtCursor(cur, names);
  // SubPath is an FString (int32 length + chars). Guard against empty.
  const subPath = cur.remaining() >= 4 ? cur.readFString() : '';
  return { assetPath, subPath };
}

// ── Registry export ──────────────────────────────────────────────────

/**
 * Build the struct handler registry. Passed to readExportProperties via
 * `opts.structHandlers`.
 *
 * @returns {Map<string, (cur, tag, names, opts) => any>}
 */
export function buildStructHandlers() {
  return new Map([
    ['Vector',            handleFVector],
    ['Vector2D',          handleFVector2D],
    ['Vector4',           handleFVector4],
    ['Rotator',           handleFRotator],
    ['Quat',              handleFQuat],
    ['Transform',         handleFTransform],
    ['LinearColor',       handleFLinearColor],
    ['Color',             handleFColor],
    ['Guid',              handleFGuid],
    ['IntPoint',          handleFIntPoint],
    ['Box',               handleFBox],
    ['GameplayTag',       handleFGameplayTag],
    ['GameplayTagContainer', handleFGameplayTagContainer],
    ['SoftObjectPath',    handleFSoftObjectPath],
    ['SoftClassPath',     handleFSoftObjectPath],
    ['ExpressionInput',        handleFExpressionInput],
    ['ColorMaterialInput',     handleFColorMaterialInput],
    ['ScalarMaterialInput',    handleFScalarMaterialInput],
    ['ShadingModelMaterialInput', handleFShadingModelMaterialInput],
    ['SubstrateMaterialInput', handleFSubstrateMaterialInput],
    ['VectorMaterialInput',    handleFVectorMaterialInput],
    ['Vector2MaterialInput',   handleFVector2MaterialInput],
    ['MaterialAttributesInput', handleFMaterialAttributesInput],
    ['BodyInstance',           handleFBodyInstance],
  ]);
}

export {
  readFExpressionInputBinary,
  handleFExpressionInput,
  handleFColorMaterialInput,
  handleFScalarMaterialInput,
  handleFVectorMaterialInput,
  handleFVector2MaterialInput,
  handleFMaterialAttributesInput,
};
