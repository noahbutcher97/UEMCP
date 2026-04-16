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
// References (verified 2026-04-16 against ProjectA fixtures + CUE4Parse master):
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
    ['Rotator',           handleFRotator],
    ['Quat',              handleFQuat],
    ['Transform',         handleFTransform],
    ['LinearColor',       handleFLinearColor],
    ['Color',             handleFColor],
    ['Guid',              handleFGuid],
    ['GameplayTag',       handleFGameplayTag],
    ['GameplayTagContainer', handleFGameplayTagContainer],
    ['SoftObjectPath',    handleFSoftObjectPath],
    ['SoftClassPath',     handleFSoftObjectPath],
  ]);
}
