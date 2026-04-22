// .uasset / .umap package header parser for UE 5.6
//
// Parses FPackageFileSummary and related structures from the package header.
// Scope: read enough to support offline asset-registry / blueprint / level
// introspection tools. Does NOT parse exports bodies, imports bodies, or any
// cooked-only content.
//
// Format references (UE 5.6 source, read 2026-04-15):
//   Engine/Source/Runtime/CoreUObject/Private/UObject/PackageFileSummary.cpp
//     → operator<<(FStructuredArchive::FSlot, FPackageFileSummary&)
//   Engine/Source/Runtime/Core/Public/UObject/ObjectVersion.h
//     → EUnrealEngineObjectUE5Version
//   Also cross-referenced: uasset-reader-js (MIT, trumank/uasset-reader-js)
//     for serialization conventions we don't want to re-derive.
//
// Key conventions:
//   - All multi-byte ints are little-endian.
//   - FString: int32 length. Positive = ANSI (len bytes incl. trailing null).
//     Negative = UTF-16 LE (|len| chars incl. trailing null → |len|*2 bytes).
//     Length 0 = empty string.
//   - FIoHash = 20 bytes (SHA-1). FGuid = 16 bytes (4 × uint32).
//   - Arrays (TArray<T>): int32 count then count × T.
//
// UE 5.6 PackageFileSummary layout (LegacyFileVersion=-9, UE5 ver ≥ 1016):
//   See parseSummary() for the authoritative field order with offsets.
//
// Cache integration: consumers pass file mtime+size; the assetCache /
// shouldRescan helpers in offline-tools.mjs decide re-parse vs hit.

import { open } from 'node:fs/promises';

// ── Constants ────────────────────────────────────────────────

export const PACKAGE_FILE_TAG = 0x9E2A83C1;
export const PACKAGE_FILE_TAG_SWAPPED = 0xC1832A9E;

// EUnrealEngineObjectUE5Version values we branch on.
// Derived from Engine/Source/Runtime/Core/Public/UObject/ObjectVersion.h.
export const UE5_INITIAL_VERSION = 1000;
export const UE5_NAMES_REFERENCED_FROM_EXPORT_DATA = 1001;
export const UE5_PAYLOAD_TOC = 1002;
export const UE5_ADD_SOFTOBJECTPATH_LIST = 1008;
export const UE5_DATA_RESOURCES = 1009;
export const UE5_METADATA_SERIALIZATION_OFFSET = 1014;
export const UE5_VERSE_CELLS = 1015;
export const UE5_PACKAGE_SAVED_HASH = 1016;

// Minimum LegacyFileVersion we support. UE5.6 writes -9.
// -8 is also valid (no SavedHash block), but we treat anything newer than -9
// as an early-exit "too new to parse" case, matching engine behavior.
export const SUPPORTED_LEGACY_FILE_VERSION_MIN = -9;

// VER_UE4_OLDEST_LOADABLE_PACKAGE (engine refuses older).
export const UE4_MIN_VERSION = 214;

// ── Cursor ───────────────────────────────────────────────────

/** Little-endian byte reader with an advancing position. */
class Cursor {
  /** @param {Buffer} buf */
  constructor(buf) {
    this.buf = buf;
    this.pos = 0;
  }
  remaining() { return this.buf.length - this.pos; }
  ensure(n) {
    if (this.pos + n > this.buf.length) {
      throw new Error(`truncated read: need ${n} bytes at offset ${this.pos}, only ${this.remaining()} remain`);
    }
  }
  readInt32() { this.ensure(4); const v = this.buf.readInt32LE(this.pos); this.pos += 4; return v; }
  readUInt32() { this.ensure(4); const v = this.buf.readUInt32LE(this.pos); this.pos += 4; return v; }
  readInt64AsNumber() {
    this.ensure(8);
    const v = this.buf.readBigInt64LE(this.pos);
    this.pos += 8;
    // Package offsets never exceed 2^53 in practice; throw if we're wrong.
    if (v > Number.MAX_SAFE_INTEGER || v < -Number.MAX_SAFE_INTEGER) {
      throw new Error(`int64 value ${v} overflows JS safe integer at offset ${this.pos - 8}`);
    }
    return Number(v);
  }
  /**
   * Lenient int64 read: returns null on overflow instead of throwing. The
   * 8 bytes are consumed either way so cursor stride stays aligned. Callers
   * record the overflow and substitute a sentinel (typically -1).
   * Used by `readExportTable` to salvage large VFX meshes whose export rows
   * carry `serialSize`/`serialOffset` > 2^53.
   * @returns {number|null}
   */
  readInt64AsNumberOrNull() {
    this.ensure(8);
    const v = this.buf.readBigInt64LE(this.pos);
    this.pos += 8;
    if (v > Number.MAX_SAFE_INTEGER || v < -Number.MAX_SAFE_INTEGER) {
      return null;
    }
    return Number(v);
  }
  readUInt16() { this.ensure(2); const v = this.buf.readUInt16LE(this.pos); this.pos += 2; return v; }
  readUInt8() { this.ensure(1); const v = this.buf.readUInt8(this.pos); this.pos += 1; return v; }
  readInt8() { this.ensure(1); const v = this.buf.readInt8(this.pos); this.pos += 1; return v; }
  readFloat() { this.ensure(4); const v = this.buf.readFloatLE(this.pos); this.pos += 4; return v; }
  readDouble() { this.ensure(8); const v = this.buf.readDoubleLE(this.pos); this.pos += 8; return v; }
  readBytes(n) { this.ensure(n); const v = this.buf.subarray(this.pos, this.pos + n); this.pos += n; return v; }
  skip(n) { this.ensure(n); this.pos += n; }
  seek(n) {
    if (n < 0 || n > this.buf.length) throw new Error(`seek out of range: ${n}`);
    this.pos = n;
  }
  tell() { return this.pos; }

  /** @returns {string} */
  readFString() {
    const len = this.readInt32();
    if (len === 0) return '';
    if (len > 0) {
      const bytes = this.readBytes(len);
      // Strip trailing null byte.
      const end = bytes[len - 1] === 0 ? len - 1 : len;
      return bytes.toString('latin1', 0, end);
    }
    // Negative → UTF-16 LE. |len| = char count including trailing null.
    const charCount = -len;
    const bytes = this.readBytes(charCount * 2);
    const endChars = charCount > 0 && bytes.readUInt16LE((charCount - 1) * 2) === 0
      ? charCount - 1 : charCount;
    return bytes.toString('utf16le', 0, endChars * 2);
  }

  /** FIoHash = 20 raw bytes. */
  readIoHash() {
    const bytes = this.readBytes(20);
    return bytes.toString('hex');
  }

  /** FGuid = 16 bytes (4 × uint32). */
  readGuid() {
    const bytes = this.readBytes(16);
    return bytes.toString('hex');
  }

  /** Skip a TArray<T> where T has a known fixed size in bytes. */
  skipFixedArray(elemSize) {
    const count = this.readInt32();
    this.skip(count * elemSize);
    return count;
  }

  /** Skip a TArray<FString>. */
  skipStringArray() {
    const count = this.readInt32();
    for (let i = 0; i < count; i++) this.readFString();
    return count;
  }
}

// ── Parse entry point ────────────────────────────────────────

/**
 * Parse a .uasset or .umap file header.
 *
 * @param {string} filePath
 * @param {object} [opts]
 * @param {number} [opts.maxHeaderBytes=1_048_576] cap on bytes read; most
 *        headers are <10KB but we pad for safety.
 * @returns {Promise<ParsedPackage>}
 */
export async function parsePackage(filePath, opts = {}) {
  const maxBytes = opts.maxHeaderBytes ?? 1_048_576;
  const fh = await open(filePath, 'r');
  try {
    const stat = await fh.stat();
    const toRead = Math.min(stat.size, maxBytes);
    const buf = Buffer.alloc(toRead);
    const { bytesRead } = await fh.read(buf, 0, toRead, 0);
    const view = bytesRead === buf.length ? buf : buf.subarray(0, bytesRead);
    return parseBuffer(view);
  } finally {
    await fh.close();
  }
}

/**
 * Parse from an in-memory buffer (useful for testing with fixtures).
 * @param {Buffer} buf
 * @returns {ParsedPackage}
 */
export function parseBuffer(buf) {
  const cur = new Cursor(buf);
  const summary = parseSummary(cur);
  return { summary };
}

// ── FPackageFileSummary ──────────────────────────────────────

/**
 * @typedef {object} PackageSummary
 * @property {number} tag
 * @property {number} legacyFileVersion
 * @property {number} legacyUE3Version
 * @property {number} fileVersionUE4
 * @property {number} fileVersionUE5
 * @property {number} fileVersionLicenseeUE
 * @property {string} savedHash - hex-encoded 20-byte FIoHash
 * @property {number} totalHeaderSize
 * @property {Array<{ key: string, version: number }>} customVersions
 * @property {string} packageName
 * @property {number} packageFlags
 * @property {number} nameCount
 * @property {number} nameOffset
 * @property {number} softObjectPathsCount
 * @property {number} softObjectPathsOffset
 * @property {string} localizationId
 * @property {number} gatherableTextDataCount
 * @property {number} gatherableTextDataOffset
 * @property {number} exportCount
 * @property {number} exportOffset
 * @property {number} importCount
 * @property {number} importOffset
 * @property {number} cellExportCount
 * @property {number} cellExportOffset
 * @property {number} cellImportCount
 * @property {number} cellImportOffset
 * @property {number} metaDataOffset
 * @property {number} dependsOffset
 * @property {number} softPackageReferencesCount
 * @property {number} softPackageReferencesOffset
 * @property {number} searchableNamesOffset
 * @property {number} thumbnailTableOffset
 * @property {string} persistentGuid
 * @property {number} assetRegistryDataOffset
 * @property {number} bulkDataStartOffset
 * @property {number} preloadDependencyCount
 * @property {number} preloadDependencyOffset
 * @property {number} namesReferencedFromExportDataCount
 * @property {number} payloadTocOffset
 * @property {number} dataResourceOffset
 */

/**
 * @typedef {object} ParsedPackage
 * @property {PackageSummary} summary
 */

/**
 * Read FPackageFileSummary from cursor. Advances cursor to end of summary.
 * Mirrors operator<<(FStructuredArchive::FSlot, FPackageFileSummary&).
 * @param {Cursor} cur
 * @returns {PackageSummary}
 */
export function parseSummary(cur) {
  const tag = cur.readUInt32();
  if (tag !== PACKAGE_FILE_TAG) {
    throw new Error(`bad magic 0x${tag.toString(16).padStart(8, '0')}; expected 0x9E2A83C1`);
  }

  const legacyFileVersion = cur.readInt32();
  if (legacyFileVersion >= 0) {
    throw new Error(`positive LegacyFileVersion ${legacyFileVersion} — ancient UE3 file, unsupported`);
  }
  if (legacyFileVersion < SUPPORTED_LEGACY_FILE_VERSION_MIN) {
    throw new Error(`LegacyFileVersion ${legacyFileVersion} is newer than supported min ${SUPPORTED_LEGACY_FILE_VERSION_MIN}`);
  }

  // LegacyUE3Version present unless legacyFileVersion == -4.
  const legacyUE3Version = (legacyFileVersion !== -4) ? cur.readInt32() : 0;

  const fileVersionUE4 = cur.readInt32();

  // FileVersionUE5 present only when LegacyFileVersion ≤ -8.
  const fileVersionUE5 = (legacyFileVersion <= -8) ? cur.readInt32() : 0;

  const fileVersionLicenseeUE = cur.readInt32();

  // SavedHash + TotalHeaderSize moved here in PACKAGE_SAVED_HASH (1016).
  // For older files the legacy FGuid + TotalHeaderSize appear later.
  let savedHash = '';
  let totalHeaderSize = 0;
  const hasSavedHash = fileVersionUE5 >= UE5_PACKAGE_SAVED_HASH;
  if (hasSavedHash) {
    savedHash = cur.readIoHash();
    totalHeaderSize = cur.readInt32();
  }

  // CustomVersionContainer. For LegacyFileVersion < -5 the format is Optimized:
  // int32 count; then count × (FGuid + int32 version).
  const customVersions = readCustomVersions(cur, legacyFileVersion);

  // TotalHeaderSize for pre-PACKAGE_SAVED_HASH files comes after CustomVersions.
  if (!hasSavedHash) {
    totalHeaderSize = cur.readInt32();
  }

  const packageName = cur.readFString();
  const packageFlags = cur.readUInt32();

  const nameCount = cur.readInt32();
  const nameOffset = cur.readInt32();

  let softObjectPathsCount = 0;
  let softObjectPathsOffset = 0;
  if (fileVersionUE5 >= UE5_ADD_SOFTOBJECTPATH_LIST) {
    softObjectPathsCount = cur.readInt32();
    softObjectPathsOffset = cur.readInt32();
  }

  // LocalizationId (editor-only; cooked packages skip it).
  const localizationId = cur.readFString();

  // GatherableTextData.
  const gatherableTextDataCount = cur.readInt32();
  const gatherableTextDataOffset = cur.readInt32();

  const exportCount = cur.readInt32();
  const exportOffset = cur.readInt32();
  const importCount = cur.readInt32();
  const importOffset = cur.readInt32();

  let cellExportCount = 0, cellExportOffset = 0, cellImportCount = 0, cellImportOffset = 0;
  if (fileVersionUE5 >= UE5_VERSE_CELLS) {
    cellExportCount = cur.readInt32();
    cellExportOffset = cur.readInt32();
    cellImportCount = cur.readInt32();
    cellImportOffset = cur.readInt32();
  }

  let metaDataOffset = -1;
  if (fileVersionUE5 >= UE5_METADATA_SERIALIZATION_OFFSET) {
    metaDataOffset = cur.readInt32();
  }

  const dependsOffset = cur.readInt32();

  const softPackageReferencesCount = cur.readInt32();
  const softPackageReferencesOffset = cur.readInt32();

  const searchableNamesOffset = cur.readInt32();
  const thumbnailTableOffset = cur.readInt32();

  // Pre-PACKAGE_SAVED_HASH files write an FGuid here.
  if (!hasSavedHash) {
    cur.skip(16);
  }

  const persistentGuid = cur.readGuid();

  // Generations: int32 count then count × { int32 ExportCount, int32 NameCount }.
  const generationCount = cur.readInt32();
  cur.skip(generationCount * 8);

  skipEngineVersion(cur);
  skipEngineVersion(cur);

  const compressionFlags = cur.readUInt32();

  const compressedChunkCount = cur.readInt32();
  if (compressedChunkCount !== 0) {
    throw new Error(`package has ${compressedChunkCount} compressed chunks — engine refuses these`);
  }

  const packageSource = cur.readUInt32();

  // AdditionalPackagesToCook.
  cur.skipStringArray();

  if (legacyFileVersion > -7) {
    cur.readInt32(); // NumTextureAllocations
  }

  const assetRegistryDataOffset = cur.readInt32();
  const bulkDataStartOffset = cur.readInt64AsNumber();

  const worldTileInfoDataOffset = cur.readInt32();

  // ChunkIDs: TArray<int32>.
  cur.skipFixedArray(4);

  const preloadDependencyCount = cur.readInt32();
  const preloadDependencyOffset = cur.readInt32();

  let namesReferencedFromExportDataCount = nameCount;
  if (fileVersionUE5 >= UE5_NAMES_REFERENCED_FROM_EXPORT_DATA) {
    namesReferencedFromExportDataCount = cur.readInt32();
  }

  let payloadTocOffset = -1;
  if (fileVersionUE5 >= UE5_PAYLOAD_TOC) {
    payloadTocOffset = cur.readInt64AsNumber();
  }

  let dataResourceOffset = -1;
  if (fileVersionUE5 >= UE5_DATA_RESOURCES) {
    dataResourceOffset = cur.readInt32();
  }

  return {
    tag, legacyFileVersion, legacyUE3Version, fileVersionUE4, fileVersionUE5,
    fileVersionLicenseeUE, savedHash, totalHeaderSize, customVersions,
    packageName, packageFlags, nameCount, nameOffset,
    softObjectPathsCount, softObjectPathsOffset, localizationId,
    gatherableTextDataCount, gatherableTextDataOffset,
    exportCount, exportOffset, importCount, importOffset,
    cellExportCount, cellExportOffset, cellImportCount, cellImportOffset,
    metaDataOffset, dependsOffset,
    softPackageReferencesCount, softPackageReferencesOffset,
    searchableNamesOffset, thumbnailTableOffset, persistentGuid,
    compressionFlags, packageSource,
    assetRegistryDataOffset, bulkDataStartOffset, worldTileInfoDataOffset,
    preloadDependencyCount, preloadDependencyOffset,
    namesReferencedFromExportDataCount, payloadTocOffset, dataResourceOffset,
  };
}

/**
 * Read CustomVersionContainer (Optimized format, LegacyFileVersion <= -2).
 */
function readCustomVersions(cur, legacyFileVersion) {
  if (legacyFileVersion > -2) return [];
  const count = cur.readInt32();
  const out = new Array(count);
  for (let i = 0; i < count; i++) {
    const key = cur.readGuid();
    const version = cur.readInt32();
    out[i] = { key, version };
  }
  return out;
}

/**
 * Skip FEngineVersion: uint16 Major + uint16 Minor + uint16 Patch + uint32 Changelist + FString Branch.
 */
function skipEngineVersion(cur) {
  cur.skip(2 + 2 + 2 + 4);
  cur.readFString();
}

export { Cursor };

/**
 * Walk the name table at summary.nameOffset.
 * FNameEntrySerialized layout (UE 5.6 uncooked):
 *   FString Name
 *   uint16  NonCasePreservingHash
 *   uint16  CasePreservingHash
 * @param {Cursor} cur  cursor positioned anywhere (we seek internally)
 * @param {{ nameOffset: number, nameCount: number }} summary
 * @returns {string[]}
 */
export function readNameTable(cur, summary) {
  const { nameOffset, nameCount } = summary;
  if (!nameCount) return [];
  cur.seek(nameOffset);
  const names = new Array(nameCount);
  for (let i = 0; i < nameCount; i++) {
    const name = cur.readFString();
    cur.skip(4); // two uint16 hashes
    names[i] = name;
  }
  return names;
}

/**
 * Walk the import table at summary.importOffset.
 * FObjectImport layout for UE 5.6 (40 bytes, since OPTIONAL_RESOURCES bump):
 *   FName ClassPackage  (int32 idx + int32 number)    [8]
 *   FName ClassName     (int32 idx + int32 number)    [8]
 *   int32 OuterIndex    (FPackageIndex)               [4]
 *   FName ObjectName    (int32 idx + int32 number)    [8]
 *   FName PackageName   (int32 idx + int32 number)    [8]   — UE 5.0+
 *   int32 bImportOptional                              [4]
 * @param {Cursor} cur
 * @param {{ importOffset: number, importCount: number }} summary
 * @param {string[]} [names]
 */
export function readImportTable(cur, summary, names) {
  const { importOffset, importCount } = summary;
  if (!importCount) return [];
  cur.seek(importOffset);
  const imports = new Array(importCount);
  for (let i = 0; i < importCount; i++) {
    const classPackageIdx = cur.readInt32(); cur.skip(4);
    const classNameIdx = cur.readInt32(); cur.skip(4);
    const outerIndex = cur.readInt32();
    const objectNameIdx = cur.readInt32(); cur.skip(4);
    const packageNameIdx = cur.readInt32(); cur.skip(4);
    const bImportOptional = cur.readInt32();
    imports[i] = {
      classPackage: names?.[classPackageIdx] ?? `[name ${classPackageIdx}]`,
      className: names?.[classNameIdx] ?? `[name ${classNameIdx}]`,
      outerIndex,
      objectName: names?.[objectNameIdx] ?? `[name ${objectNameIdx}]`,
      packageName: names?.[packageNameIdx] ?? null,
      bImportOptional: !!bImportOptional,
    };
  }
  return imports;
}

/**
 * Resolve an FPackageIndex (int32) against the export and import tables.
 * Positive N → exports[N-1]. Negative N → imports[-N-1]. Zero → null.
 * Returns the resolved entry's objectName or className (best effort).
 * @param {number} idx
 * @param {object[]} exports
 * @param {object[]} imports
 * @param {'objectName'|'className'} field
 */
export function resolvePackageIndex(idx, exports, imports, field = 'objectName') {
  if (idx === 0) return null;
  if (idx > 0) return exports[idx - 1]?.[field] ?? null;
  return imports[-idx - 1]?.[field] ?? null;
}

/**
 * Walk the export table at summary.exportOffset.
 * FObjectExport layout for UE 5.6 uncooked packages (112 bytes each):
 *   int32 ClassIndex, SuperIndex, TemplateIndex, OuterIndex (FPackageIndex each)
 *   int32 ObjectName.ComparisonIndex, int32 ObjectName.Number  (FName)
 *   uint32 ObjectFlags
 *   int64 SerialSize, int64 SerialOffset
 *   int32 bForcedExport, bNotForClient, bNotForServer
 *   uint32 PackageFlags
 *   int32 bNotAlwaysLoadedForEditorGame, bIsAsset, bGeneratePublicHash
 *   int32 FirstExportDependency
 *   int32 SerializationBeforeSerializationDependencies
 *   int32 CreateBeforeSerializationDependencies
 *   int32 SerializationBeforeCreateDependencies
 *   int32 CreateBeforeCreateDependencies
 *   int64 ScriptSerializationStartOffset, int64 ScriptSerializationEndOffset
 * Verified byte-for-byte against AN_OSAnimNotify_Footstep.uasset on 2026-04-15.
 * @param {Cursor} cur
 * @param {{ exportOffset: number, exportCount: number }} summary
 * @param {string[]} [names]  optional resolved name table for ObjectName resolution
 */
export function readExportTable(cur, summary, names) {
  const { exportOffset, exportCount } = summary;
  if (!exportCount) return [];
  cur.seek(exportOffset);
  const exports = new Array(exportCount);
  for (let i = 0; i < exportCount; i++) {
    const classIndex = cur.readInt32();
    const superIndex = cur.readInt32();
    const templateIndex = cur.readInt32();
    const outerIndex = cur.readInt32();
    const objectNameIdx = cur.readInt32();
    const objectNameNumber = cur.readInt32();
    const objectFlags = cur.readUInt32();
    // Six int64 fields below can exceed 2^53 on large VFX meshes. Use the
    // lenient reader + per-entry marker so one rogue export doesn't abort
    // the whole table parse.
    const overflowFields = [];
    const readLenient = (fieldName) => {
      const v = cur.readInt64AsNumberOrNull();
      if (v === null) { overflowFields.push(fieldName); return -1; }
      return v;
    };
    const serialSize = readLenient('serialSize');
    const serialOffset = readLenient('serialOffset');
    const bForcedExport = cur.readInt32();
    const bNotForClient = cur.readInt32();
    const bNotForServer = cur.readInt32();
    const packageFlags = cur.readUInt32();
    const bNotAlwaysLoadedForEditorGame = cur.readInt32();
    const bIsAsset = cur.readInt32();
    const publicExportHash = readLenient('publicExportHash');
    const firstExportDependency = cur.readInt32();
    const serBeforeSerDeps = cur.readInt32();
    const createBeforeSerDeps = cur.readInt32();
    const serBeforeCreateDeps = cur.readInt32();
    const createBeforeCreateDeps = cur.readInt32();
    const scriptSerializationStartOffset = readLenient('scriptSerializationStartOffset');
    const scriptSerializationEndOffset = readLenient('scriptSerializationEndOffset');
    const entry = {
      classIndex, superIndex, templateIndex, outerIndex,
      objectName: names?.[objectNameIdx] ?? `[name ${objectNameIdx}]`,
      objectNameNumber, objectFlags,
      serialSize, serialOffset,
      bForcedExport: !!bForcedExport,
      bNotForClient: !!bNotForClient,
      bNotForServer: !!bNotForServer,
      packageFlags,
      bNotAlwaysLoadedForEditorGame: !!bNotAlwaysLoadedForEditorGame,
      bIsAsset: !!bIsAsset,
      publicExportHash,
      firstExportDependency, serBeforeSerDeps, createBeforeSerDeps,
      serBeforeCreateDeps, createBeforeCreateDeps,
      scriptSerializationStartOffset, scriptSerializationEndOffset,
    };
    if (overflowFields.length > 0) {
      entry.int64Overflow = true;
      entry.int64OverflowFields = overflowFields;
    }
    exports[i] = entry;
  }
  return exports;
}

// ── FAssetRegistryData tag block ─────────────────────────────

/**
 * @typedef {object} AssetRegistryObject
 * @property {string} objectPath       e.g. "AN_OSAnimNotify_Footstep"
 * @property {string} objectClassName  e.g. "/Script/Engine.Blueprint"
 * @property {Record<string, string>} tags
 */

/**
 * Read the FAssetRegistryData block at summary.assetRegistryDataOffset.
 * Layout (UE 5.6 uncooked):
 *   int64 DependencyDataOffset
 *   int32 ObjectCount
 *   per object: ObjectPath FString, ObjectClassName FString,
 *               int32 TagCount, TagCount × (Key FString, Value FString)
 *
 * The dependency-data region after the tag block is not parsed here (YAGNI).
 *
 * @param {Cursor} cur
 * @param {{ assetRegistryDataOffset: number }} summary
 * @returns {{ dependencyDataOffset: number, objects: AssetRegistryObject[] }}
 */
export function readAssetRegistryData(cur, summary) {
  const { assetRegistryDataOffset } = summary;
  if (!assetRegistryDataOffset) return { dependencyDataOffset: 0, objects: [] };
  cur.seek(assetRegistryDataOffset);
  const dependencyDataOffset = cur.readInt64AsNumber();
  const objectCount = cur.readInt32();
  const objects = new Array(objectCount);
  for (let i = 0; i < objectCount; i++) {
    const objectPath = cur.readFString();
    const objectClassName = cur.readFString();
    const tagCount = cur.readInt32();
    const tags = {};
    for (let j = 0; j < tagCount; j++) {
      const key = cur.readFString();
      const value = cur.readFString();
      tags[key] = value;
    }
    objects[i] = { objectPath, objectClassName, tags };
  }
  return { dependencyDataOffset, objects };
}

// ── FPropertyTag / tagged property stream (UE 5.6) ──────────────
//
// Extends the parser to walk the serialized property tag stream within a
// FObjectExport's body. Supports the UE 5.4+ layout:
//
//   [export body start]
//   uint8 preamble                                 (observed 0x00 on all fixtures)
//   [loop until "None" FName]
//     FName PropertyName                           (8 bytes)
//     FPropertyTypeName TypeName                   (recursive; see readPropertyTypeName)
//     int32 Size                                   (value byte count)
//     uint8 Flags                                  (EPropertyTagFlags)
//     [if flags & HAS_ARRAY_INDEX] int32 ArrayIndex
//     [if flags & HAS_PROPERTY_GUID] FGuid PropertyGuid (16 bytes)
//     [if flags & HAS_PROPERTY_EXTENSIONS] FPropertyTagExtensions (unsupported — emits marker)
//     [value bytes, length Size]
//   FName "None"                                   (terminates stream; 4-byte trailer not consumed)
//
// Empirically verified against ProjectA fixtures BPGA_Block, GA_Sprint,
// BP_OSPlayerR on 2026-04-16 (fileVersionUE5=1017).
//
// References:
//   Engine/Source/Runtime/CoreUObject/Public/UObject/PropertyTag.h (EPropertyTagFlags)
//   CUE4Parse master branch (post-5.4 FPropertyTypeName encoding)

// EPropertyTagFlags bitfield values.
export const PTAG_HAS_ARRAY_INDEX       = 0x01;
export const PTAG_HAS_PROPERTY_GUID     = 0x02;
export const PTAG_HAS_PROPERTY_EXTS     = 0x04;
export const PTAG_BINARY_OR_NATIVE_SER  = 0x08;
export const PTAG_BOOL_TRUE             = 0x10;
export const PTAG_SKIPPED_SERIALIZE     = 0x20;

/**
 * Read an FName (int32 nameIdx + int32 number) from the cursor.
 * @param {Cursor} cur
 * @param {string[]} names
 * @returns {string}  resolved name (with `_N-1` suffix when number > 0)
 */
export function readFNameAtCursor(cur, names) {
  const idx = cur.readInt32();
  const num = cur.readInt32();
  if (idx < 0 || idx >= names.length) return `[bad-fname-idx=${idx}]`;
  const base = names[idx];
  return num > 0 ? `${base}_${num - 1}` : base;
}

/**
 * Read a recursive FPropertyTypeName. Format:
 *   FName Name + int32 ParamCount + ParamCount × FPropertyTypeName
 * @param {Cursor} cur
 * @param {string[]} names
 * @returns {{name: string, params: object[]}}
 */
function readPropertyTypeName(cur, names) {
  const name = readFNameAtCursor(cur, names);
  const paramCount = cur.readInt32();
  // Bound recursion defensively — real UE type trees never exceed ~4 levels.
  if (paramCount < 0 || paramCount > 8) {
    throw new Error(`unreasonable paramCount=${paramCount} at offset ${cur.tell() - 4}`);
  }
  const params = [];
  for (let i = 0; i < paramCount; i++) {
    params.push(readPropertyTypeName(cur, names));
  }
  return { name, params };
}

/**
 * Read one FPropertyTag header from cursor. Consumes the header only —
 * the caller reads or skips the `size`-byte value.
 *
 * @param {Cursor} cur
 * @param {string[]} names
 * @returns {{terminator: true} | {
 *   terminator: false, name: string, type: string, typeParams: object[],
 *   size: number, flags: number, arrayIndex: number, propertyGuid: string | null,
 *   unsupportedExtensions: boolean
 * }}
 */
export function readPropertyTag(cur, names) {
  const name = readFNameAtCursor(cur, names);
  if (name === 'None') return { terminator: true };
  const typeName = readPropertyTypeName(cur, names);
  const size = cur.readInt32();
  const flags = cur.readUInt8();
  let arrayIndex = 0;
  if (flags & PTAG_HAS_ARRAY_INDEX) arrayIndex = cur.readInt32();
  let propertyGuid = null;
  if (flags & PTAG_HAS_PROPERTY_GUID) propertyGuid = cur.readGuid();
  // FPropertyTagExtensions is variable-size and rare; we flag + skip-by-size.
  const unsupportedExtensions = Boolean(flags & PTAG_HAS_PROPERTY_EXTS);
  return {
    terminator: false,
    name,
    type: typeName.name,
    typeParams: typeName.params,
    size,
    flags,
    arrayIndex,
    propertyGuid,
    unsupportedExtensions,
  };
}

/**
 * Read scalar/reference property values. Returns the decoded value or throws
 * if it doesn't know the type. Struct/Array/Set/Map are NOT handled here —
 * they're dispatched by readExportProperties via the structHandlers /
 * container handlers registries (wired in commits 2 + 3).
 *
 * The caller is responsible for ensuring the cursor lands at valueStart+size
 * whether or not this reader consumes exactly `size` bytes.
 */
function readScalarPropertyValue(cur, tag, names, opts) {
  const { type, size, flags } = tag;
  switch (type) {
    case 'IntProperty':    return size === 4 ? cur.readInt32() : null;
    case 'Int8Property':   return cur.readInt8();
    case 'Int16Property':  return cur.readInt32();  // UE serializes int16 as int32-sized slot? safe default
    case 'Int64Property':  return cur.readInt64AsNumber();
    case 'UInt16Property': return cur.readUInt16();
    case 'UInt32Property': return cur.readUInt32();
    case 'UInt64Property': return cur.readInt64AsNumber();
    case 'FloatProperty':  return cur.readFloat();
    case 'DoubleProperty': return cur.readDouble();
    case 'BoolProperty':
      // For BoolProperty, size is typically 0 and value comes from BoolTrue flag bit.
      return Boolean(flags & PTAG_BOOL_TRUE);
    case 'ByteProperty':
      // Size=1 → raw uint8; size=8 → FName (enum value).
      if (size === 1) return cur.readUInt8();
      if (size === 8) return readFNameAtCursor(cur, names);
      return null;
    case 'EnumProperty':
      // Value is an FName (the enum entry name).
      return readFNameAtCursor(cur, names);
    case 'NameProperty':
      return readFNameAtCursor(cur, names);
    case 'StrProperty':
      return cur.readFString();
    case 'ObjectProperty':
    case 'ClassProperty':
    case 'WeakObjectProperty':
    case 'LazyObjectProperty':
    case 'InterfaceProperty': {
      // FPackageIndex: 0 = null ref, positive = export, negative = import.
      // A null ref is a legitimate value (common for optional object defaults);
      // return an explicit marker object so callers don't confuse it with a
      // "type not handled" unsupported marker.
      const idx = cur.readInt32();
      if (idx === 0) return { objectName: null, packageIndex: 0, kind: 'null' };
      if (!opts.resolve) return { packageIndex: idx };
      const resolved = opts.resolve(idx);
      return resolved ?? { packageIndex: idx };
    }
    case 'FieldPathProperty': {
      // FFieldPath serialization (UE 5.x):
      //   int32 PathCount
      //   PathCount × FName                             (8 bytes each)
      //   FPackageIndex ResolvedOwner (int32, 4 bytes)  [post-4.25; always present in UE 5.6]
      // References:
      //   Engine/Source/Runtime/CoreUObject/Private/UObject/FieldPath.cpp
      //     → FArchive& operator<<(FArchive& Ar, FFieldPath& InOutFieldPath)
      //   CUE4Parse master: CUE4Parse/UE4/Objects/UObject/FFieldPath.cs
      // Common occurrence in ProjectA: FGameplayAttribute.Attribute (TFieldPath<FProperty>)
      // encountered inside tagged FOSResource / FAttributeBasedFloat structs.
      const pathCount = cur.readInt32();
      if (pathCount < 0 || pathCount > 64) return null;  // defensive: real paths are 1-3 entries
      const path = [];
      for (let i = 0; i < pathCount; i++) path.push(readFNameAtCursor(cur, names));
      // Bound ResolvedOwner read by declared `size` — files serialized against
      // pre-FFieldPathOwnerSerialization versions omit it. UE 5.6 always has it.
      const consumed = 4 + pathCount * 8;
      let owner = null;
      if (size - consumed >= 4) {
        const ownerIdx = cur.readInt32();
        owner = opts.resolve
          ? (opts.resolve(ownerIdx) ?? { packageIndex: ownerIdx })
          : (ownerIdx === 0 ? null : { packageIndex: ownerIdx });
      }
      return { path, owner };
    }
    default:
      return null; // dispatcher throws → caller emits unsupported marker
  }
}

/**
 * Walk the FPropertyTag stream of an export and return a map of property
 * name → decoded value (or `{unsupported, reason, ...}` marker).
 *
 * Contract: never silently skip. Unknown types, unreadable bytes, or flag
 * bits we don't understand emit a marker entry preserving the property name.
 * Callers can use the marker to decide whether to fall back to TCP / RC.
 *
 * @param {Buffer} buf  full .uasset / .umap buffer
 * @param {object} exportEntry  FObjectExport row (from readExportTable)
 * @param {string[]} names  resolved name table
 * @param {object} [opts]
 * @param {(idx: number) => any} [opts.resolve]  FPackageIndex resolver for Object refs
 * @param {Map<string, (cur, size, names, ctx) => any>} [opts.structHandlers]  struct dispatch (commit 2)
 * @param {Map<string, (cur, size, names, ctx) => any>} [opts.containerHandlers] container dispatch (commit 3)
 * @param {number} [opts.maxBytes]  response budget; truncates property list when exceeded
 * @returns {{
 *   properties: Record<string, any>,
 *   unsupported: Array<{name: string, reason: string, type?: string, size_bytes?: number}>,
 *   propertyCount: number,
 *   truncated: boolean,
 *   bytesConsumed: number
 * }}
 */
export function readExportProperties(buf, exportEntry, names, opts = {}) {
  const cur = new Cursor(buf);
  const start = exportEntry.serialOffset;
  const end = start + exportEntry.serialSize;
  if (end > buf.length || start + 1 > buf.length) {
    return { properties: {}, unsupported: [{ name: '__stream__', reason: 'serial_range_out_of_bounds' }], propertyCount: 0, truncated: false, bytesConsumed: 0 };
  }
  cur.seek(start);
  const preamble = cur.readUInt8();
  // We only tolerate preamble=0x00 empirically. Non-zero → likely a different
  // export format (UClass subclass preamble, etc.) — bail out with a marker.
  if (preamble !== 0x00) {
    return {
      properties: {},
      unsupported: [{ name: '__stream__', reason: 'unexpected_preamble', size_bytes: preamble }],
      propertyCount: 0, truncated: false, bytesConsumed: 1,
    };
  }
  const res = readTaggedPropertyStream(cur, end, names, opts);
  return { ...res, bytesConsumed: cur.tell() - start };
}

/**
 * Core tagged-property loop. Reads from cursor's current position until
 * either the `None` terminator or `endOffset` is reached. No preamble —
 * for exports' top-level stream, the 1-byte preamble is consumed before
 * calling this (see readExportProperties).
 *
 * Exported so struct handlers (uasset-structs.mjs) can parse nested tagged
 * sub-streams using the same dispatch logic.
 */
export function readTaggedPropertyStream(cur, endOffset, names, opts = {}) {
  const maxBytes = opts.maxBytes ?? Infinity;
  const properties = {};
  const unsupported = [];
  let propertyCount = 0;
  let responseBytes = 0;
  let truncated = false;

  while (cur.tell() < endOffset) {
    let tag;
    try {
      tag = readPropertyTag(cur, names);
    } catch (err) {
      unsupported.push({ name: '__stream__', reason: 'tag_header_read_failed', size_bytes: endOffset - cur.tell() });
      break;
    }
    if (tag.terminator) break;

    const valueStart = cur.tell();
    const valueEnd = valueStart + tag.size;
    if (valueEnd > endOffset) {
      unsupported.push({ name: tag.name, reason: 'value_overruns_serial', type: tag.type, size_bytes: tag.size });
      break;
    }

    if (responseBytes >= maxBytes) {
      truncated = true;
      if (unsupported.filter(u => u.reason === 'size_budget_exceeded').length < 20) {
        unsupported.push({ name: tag.name, reason: 'size_budget_exceeded' });
      }
      cur.seek(valueEnd);
      propertyCount += 1;
      continue;
    }

    let value;
    let isUnsupported = false;
    let unsupportedMarker = null;

    if (tag.unsupportedExtensions) {
      isUnsupported = true;
      unsupportedMarker = { reason: 'property_tag_extensions' };
    } else {
      try {
        value = dispatchPropertyValue(cur, tag, names, opts);
        if (value && value.__unsupported__) {
          isUnsupported = true;
          // Carry forward any detail fields (struct_name, inner_type, detail, etc.)
          const { __unsupported__: _, ...rest } = value;
          unsupportedMarker = rest;
          value = undefined;
        }
      } catch (err) {
        isUnsupported = true;
        unsupportedMarker = { reason: 'value_read_failed' };
      }
    }

    // Always realign cursor to the declared value boundary — defends against
    // handler under- or over-consume bugs.
    cur.seek(valueEnd);

    if (isUnsupported) {
      const entry = {
        unsupported: true,
        reason: unsupportedMarker.reason,
        type: tag.type,
        size_bytes: tag.size,
        ...unsupportedMarker,
      };
      properties[tag.name] = entry;
      unsupported.push({ name: tag.name, ...entry, unsupported: undefined });
    } else {
      properties[tag.name] = tag.arrayIndex > 0 ? { __arrayIndex: tag.arrayIndex, value } : value;
    }
    propertyCount += 1;
    responseBytes += tag.size;
  }

  return { properties, unsupported, propertyCount, truncated };
}

/**
 * Dispatch a property value based on its type. Returns either the decoded
 * value or a sentinel `{__unsupported__: true, reason}` marker. Exceptions
 * bubble to the caller.
 */
function dispatchPropertyValue(cur, tag, names, opts) {
  const { type } = tag;
  if (type === 'StructProperty') {
    const structName = tag.typeParams?.[0]?.name ?? null;
    const handler = structName && opts.structHandlers?.get(structName);
    if (handler) return handler(cur, tag, names, opts);
    // Agent 10.5 tier 3 (D47): unknown struct tagged-fallback.
    // UUserDefinedStruct and engine structs without a registered handler
    // serialize as tagged FPropertyTag sub-streams terminated by "None"
    // when flag 0x08 (HasBinaryOrNativeSerialize) is clear. Walking the
    // sub-stream is self-describing — no UDS asset load required for
    // value-decoding. Bounds set to valueStart+size so a missing terminator
    // can't walk into the next property's bytes.
    if (!(tag.flags & PTAG_BINARY_OR_NATIVE_SER) && tag.size > 0) {
      const endOffset = cur.tell() + tag.size;
      const sub = readTaggedPropertyStream(cur, endOffset, names, opts);
      if (opts.resolvedUnknownStructs && structName) opts.resolvedUnknownStructs.add(structName);
      return sub.properties;
    }
    return { __unsupported__: true, reason: 'unknown_struct', struct_name: structName };
  }
  if (type === 'ArrayProperty' || type === 'SetProperty' || type === 'MapProperty') {
    const handler = opts.containerHandlers?.get(type);
    if (handler) return handler(cur, tag, names, opts);
    return { __unsupported__: true, reason: 'container_deferred' };
  }
  if (type === 'DelegateProperty' || type === 'MulticastDelegateProperty' ||
      type === 'MulticastInlineDelegateProperty' || type === 'MulticastSparseDelegateProperty') {
    return { __unsupported__: true, reason: 'delegate_not_serialized' };
  }
  if (type === 'TextProperty') {
    return { __unsupported__: true, reason: 'localized_text' };
  }
  if (type === 'SoftObjectProperty' || type === 'SoftClassProperty') {
    const handler = opts.structHandlers?.get('SoftObjectPath');
    if (handler) return handler(cur, tag, names, opts);
    return { __unsupported__: true, reason: 'unknown_property_type', detail: type };
  }

  const val = readScalarPropertyValue(cur, tag, names, opts);
  if (val === null || val === undefined) {
    return { __unsupported__: true, reason: 'unknown_property_type', detail: type };
  }
  return val;
}

// ── UEdGraphNode pin-block parser (S-B-base, M-new) ─────────────────────
//
// UEdGraphNode::Serialize() writes:
//   1. Super::Serialize(Ar)  → UObject tagged UPROPERTY block (terminated by
//      FName "None"), handled above by readExportProperties.
//   2. int32 post-tag sentinel = 0. Empirically required on all K2Node /
//      EdGraphNode_Comment exports (verified across 415 nodes in 6 fixtures,
//      2026-04-21). Not documented in EdGraphNode.cpp but observed from
//      UObject::Serialize's SerializeScriptProperties tail.
//   3. UEdGraphPin::SerializeAsOwningNode(Ar, Pins)  → pin trailer:
//        int32 ArrayNum
//        ArrayNum × FEdGraphPin (via SerializePin, ResolveType=OwningNode):
//          int32 bNullPtr (FArchive serializes bool as int32)
//          if bNullPtr == 0:
//            int32 FPackageIndex OwningNode     ← points back at this export
//            FGuid PinId                         (16 bytes)
//            UEdGraphPin::Serialize(Ar):         ← full pin body (CP2+)
//              int32 OwningNode FPackageIndex   (redundant with above)
//              FGuid PinId                      (redundant with above)
//              FName PinName                    (8 bytes)
//              FText PinFriendlyName            (variable; 5 bytes if empty)
//              int32 SourceIndex                (UE 5.0+ custom version gate)
//              FString PinToolTip
//              uint8 Direction                  (EGPD_Input=0, EGPD_Output=1)
//              FEdGraphPinType PinType
//              FString DefaultValue
//              FString AutogeneratedDefaultValue
//              int32 DefaultObject FPackageIndex
//              FText DefaultTextValue
//              SerializePinArray LinkedTo       ← reference-shaped edges
//              SerializePinArray SubPins        ← reference-shaped
//              SerializePin ParentPin            (reference-shaped)
//              SerializePin ReferencePassThroughConnection
//              FGuid PersistentGuid             (16 bytes)
//              uint32 BitField
// References:
//   Engine/Source/Runtime/Engine/Private/EdGraph/EdGraphNode.cpp::Serialize()
//   Engine/Source/Runtime/Engine/Private/EdGraph/EdGraphPin.cpp
//     ::SerializePinArray, ::SerializePin, ::Serialize

/**
 * Class-name predicate for UEdGraphNode exports. Matches all UEdGraphNode
 * subclasses whose bytes carry the pin-block trailer. Uses a broad prefix
 * match rather than a hardcoded K2Node enumeration so uncommon subclasses
 * (K2Node_CallParentFunction, K2Node_AddComponent, K2Node_PromotableOperator
 * etc.) get first-class coverage. Note: UE strips U/A prefixes at
 * serialization (D63), so byte-level class_name is "K2Node_*", never "UK2Node_*".
 * @param {string|null|undefined} className
 * @returns {boolean}
 */
export function isGraphNodeExportClass(className) {
  if (!className) return false;
  return className.startsWith('K2Node_') || className === 'EdGraphNode_Comment';
}

/**
 * Read the UEdGraphNode pin-block: header + per-pin bodies.
 *
 * Layout details documented in the block-comment above isGraphNodeExportClass.
 * Each `pins[]` entry has shape:
 *   {
 *     pin_id: '32-hex' | null,           // null when bNullPtr=true (orphan)
 *     direction: 'EGPD_Input' | 'EGPD_Output' | null,
 *     linked_to_raw: [                   // CP3 input — reference-shaped
 *       { owning_node_package_index: int32, pin_id: '32-hex' }
 *     ],
 *     malformed: bool                    // true → byte stream ran out / unknown FText history
 *   }
 *
 * Caller must have verified the export's class is a graph-node class via
 * isGraphNodeExportClass(). Calling on non-graph-node exports will misread
 * garbage bytes.
 *
 * @param {Buffer} buf              full .uasset / .umap buffer
 * @param {object} exportEntry      FObjectExport row (from readExportTable)
 * @param {string[]} names          resolved name table
 * @param {object} [opts]           passed to readExportProperties
 * @returns {{
 *   postTagOffset: number,
 *   sentinel: number,
 *   pinBlockOffset: number,
 *   arrayCount: number,
 *   pins: Array<object>,
 *   nodeGuid: string | null,
 *   tagBytesConsumed: number,
 *   bytesConsumed: number,
 *   malformed: boolean
 * }}
 */
export function parsePinBlock(buf, exportEntry, names, opts = {}) {
  const tagResult = readExportProperties(buf, exportEntry, names, opts);
  const postTagOffset = exportEntry.serialOffset + tagResult.bytesConsumed;
  const nodeGuid = extractNodeGuid(tagResult.properties);

  if (postTagOffset + 8 > buf.length) {
    return {
      postTagOffset, sentinel: null, pinBlockOffset: postTagOffset,
      arrayCount: 0, pins: [], nodeGuid,
      tagBytesConsumed: tagResult.bytesConsumed,
      bytesConsumed: tagResult.bytesConsumed,
      malformed: true,
    };
  }

  const sentinel = buf.readInt32LE(postTagOffset);
  const pinBlockOffset = postTagOffset + 4;
  const arrayCount = buf.readInt32LE(pinBlockOffset);

  if (sentinel !== 0 || arrayCount < 0 || arrayCount > 10_000) {
    return {
      postTagOffset, sentinel, pinBlockOffset, arrayCount, pins: [], nodeGuid,
      tagBytesConsumed: tagResult.bytesConsumed,
      bytesConsumed: pinBlockOffset + 4 - exportEntry.serialOffset,
      malformed: true,
    };
  }

  // Walk pin bodies. Cursor starts AFTER the int32 PinCount.
  const cur = new Cursor(buf);
  cur.seek(pinBlockOffset + 4);
  const exportEnd = exportEntry.serialOffset + exportEntry.serialSize;
  const pins = [];
  let blockMalformed = false;

  for (let i = 0; i < arrayCount; i++) {
    if (cur.tell() >= exportEnd) {
      blockMalformed = true;
      break;
    }
    try {
      pins.push(readPinBody(cur, names, exportEnd));
    } catch (err) {
      blockMalformed = true;
      pins.push({ pin_id: null, direction: null, linked_to_raw: [], malformed: true, error: String(err.message ?? err) });
      break;
    }
  }

  return {
    postTagOffset, sentinel, pinBlockOffset, arrayCount, pins, nodeGuid,
    tagBytesConsumed: tagResult.bytesConsumed,
    bytesConsumed: cur.tell() - exportEntry.serialOffset,
    malformed: blockMalformed,
  };
}

// ── pin-body reader ──────────────────────────────────────────────────
//
// Reads ONE FEdGraphPin from cursor (the SerializePin entry from the owning
// node's Pins array, plus the inner UEdGraphPin::Serialize body when
// bNullPtr=false). Cursor advances exactly to the next pin's bNullPtr.
//
// Returned shape per pins[] entry above. bNullPtr=true entries are kept in
// the returned array (their pin_id/direction are null) so callers can match
// arrayCount; CP3's resolveLinkedToEdges drops them when emitting edges.

/**
 * @param {Cursor} cur
 * @param {string[]} names
 * @param {number} exportEnd  absolute byte offset of last byte in this export
 * @returns {{
 *   pin_id: string | null,
 *   direction: 'EGPD_Input' | 'EGPD_Output' | null,
 *   linked_to_raw: Array<{ owning_node_package_index: number, pin_id: string }>,
 *   malformed?: boolean
 * }}
 */
function readPinBody(cur, names, exportEnd) {
  // Outer SerializePin (ResolveType=OwningNode):
  //   int32 bNullPtr; if !bNullPtr: int32 OwningNode + FGuid PinId + recursive UEdGraphPin::Serialize
  const bNullPtr = cur.readInt32() !== 0;
  if (bNullPtr) {
    return { pin_id: null, direction: null, linked_to_raw: [] };
  }
  // Skip outer OwningNode FPackageIndex (4 bytes).
  cur.skip(4);
  // Outer PinId (16 bytes) — this is the canonical PinId.
  const pinIdHex = cur.readBytes(16);
  const pin_id = guidBytesToOracleHex(pinIdHex);

  // Inner UEdGraphPin::Serialize body. Field order verified against
  // EdGraphPin.cpp::Serialize() (UE 5.6, lines 1670-1791).

  // OwningNode (redundant) + PinId (redundant) — skip 20 bytes.
  cur.skip(20);
  // FName PinName — 8 bytes (int32 idx + int32 number).
  cur.skip(8);
  // FText PinFriendlyName.
  skipFText(cur);
  // int32 SourceIndex (always present in UE 5.6 due to EdGraphPinSourceIndex
  // custom version gate at FUE5MainStreamObjectVersion >= EdGraphPinSourceIndex).
  cur.skip(4);
  // FString PinToolTip.
  skipFString(cur);
  // uint8 Direction.
  const dirByte = cur.readUInt8();
  const direction = dirByte === 0 ? 'EGPD_Input' : dirByte === 1 ? 'EGPD_Output' : null;
  // FEdGraphPinType.
  skipEdGraphPinType(cur);
  // FString DefaultValue.
  skipFString(cur);
  // FString AutogeneratedDefaultValue.
  skipFString(cur);
  // int32 DefaultObject FPackageIndex.
  cur.skip(4);
  // FText DefaultTextValue.
  skipFText(cur);
  // SerializePinArray LinkedTo (resolveType=LinkedTo) — capture for CP3.
  const linked_to_raw = readPinReferenceArray(cur);
  // SerializePinArray SubPins (resolveType=SubPins) — discard per Oracle-A
  // README §Edge cases #3 (SubPins not emitted in oracle).
  consumePinReferenceArray(cur);
  // SerializePin ParentPin (resolveType=ParentPin) — single ref.
  consumePinReferenceSingle(cur);
  // SerializePin ReferencePassThroughConnection — single ref.
  consumePinReferenceSingle(cur);
  // FGuid PersistentGuid (16 bytes) — only when !IsFilterEditorOnly, which is
  // always true for editor uassets. UE5 .uasset always has it.
  cur.skip(16);
  // uint32 BitField. Layout per EdGraphPin.cpp:1734-1741:
  //   bit 0: bHidden, bit 1: bNotConnectable, bit 2: bDefaultValueIsReadOnly,
  //   bit 3: bDefaultValueIsIgnored, bit 4: bAdvancedView, bit 5: bOrphanedPin.
  // bOrphanedPin pins survive in serialization (bSavePinIfOrphaned + SaveAll
  // orphan mode) but are pruned at load by AreOrphanPinsEnabled() so Oracle
  // never sees them. Filter at edge-emission to match Oracle.
  const bitField = cur.readUInt32();
  const bOrphanedPin = (bitField & (1 << 5)) !== 0;

  return { pin_id, direction, linked_to_raw, bOrphanedPin };
}

/**
 * Convert a 16-byte FGuid buffer (LE on disk) to the Oracle-aligned
 * 32-upper-hex string (FGuid::ToString(EGuidFormats::Digits) format).
 * @param {Buffer} bytes
 * @returns {string}
 */
function guidBytesToOracleHex(bytes) {
  // FGuid stores 4 little-endian uint32s. ToString(Digits) prints them as
  // 8-hex BE per uint32. So read each uint32 LE and emit as %08X.
  let out = '';
  for (let g = 0; g < 4; g++) {
    const v = bytes.readUInt32LE(g * 4);
    out += (v >>> 0).toString(16).toUpperCase().padStart(8, '0');
  }
  return out;
}

/**
 * Skip an FString value (length-prefixed; positive=ANSI, negative=UTF-16).
 * @param {Cursor} cur
 */
function skipFString(cur) {
  const len = cur.readInt32();
  if (len === 0) return;
  cur.skip(len > 0 ? len : (-len) * 2);
}

/**
 * Skip an FText value. Layout (UE 5.6, all custom versions latest):
 *   int32 Flags
 *   int8 HistoryType
 *   if HistoryType == None(-1) or unknown:
 *     int32 bHasCultureInvariantString
 *     if true: FString CultureInvariantString
 *   if HistoryType == Base(0):
 *     FString Namespace + FString Key + FString SourceString
 *   other types: throws (unhandled)
 *
 * Pin FriendlyName + DefaultTextValue overwhelmingly use None or Base.
 * @param {Cursor} cur
 */
function skipFText(cur) {
  cur.skip(4); // Flags
  const historyType = cur.readInt8();
  if (historyType === -1) {
    // None case: bHasCultureInvariantString + optional payload.
    const hasInv = cur.readInt32() !== 0;
    if (hasInv) skipFString(cur);
    return;
  }
  if (historyType === 0) {
    // Base case: Namespace + Key + SourceString.
    skipFString(cur);
    skipFString(cur);
    skipFString(cur);
    return;
  }
  throw new Error(`unsupported FText HistoryType=${historyType} at offset ${cur.tell() - 1}`);
}

/**
 * Skip an FEdGraphPinType (UE 5.6, all custom versions latest).
 * Layout per EdGraphPin.cpp::Serialize():
 *   FName PinCategory                            (8)
 *   FName PinSubCategory                         (8)
 *   FPackageIndex PinSubCategoryObject           (4)
 *   uint8 ContainerType                          (1)
 *   if ContainerType == Map(3):
 *     FEdGraphTerminalType PinValueType          (32)
 *   int32 bIsReference                           (4)
 *   int32 bIsWeakPointer                         (4)
 *   FSimpleMemberReference PinSubCategoryMemberReference:
 *     FPackageIndex MemberParent                 (4)
 *     FName MemberName                           (8)
 *     FGuid MemberGuid                           (16)
 *   int32 bIsConst                               (4)
 *   int32 bIsUObjectWrapper                      (4)
 *   int32 bSerializeAsSinglePrecisionFloat      (4) — UE 5.0+
 * @param {Cursor} cur
 */
function skipEdGraphPinType(cur) {
  cur.skip(8 + 8 + 4); // PinCategory + PinSubCategory + PinSubCategoryObject
  const containerType = cur.readUInt8();
  if (containerType === 3) {
    // Map → nested FEdGraphTerminalType.
    skipEdGraphTerminalType(cur);
  }
  cur.skip(4 + 4); // bIsReference + bIsWeakPointer
  cur.skip(4 + 8 + 16); // FSimpleMemberReference
  cur.skip(4 + 4 + 4); // bIsConst + bIsUObjectWrapper + bSerializeAsSinglePrecisionFloat
}

/**
 * Skip an FEdGraphTerminalType (32 bytes when bools serialized as int32).
 *   FName TerminalCategory                       (8)
 *   FName TerminalSubCategory                    (8)
 *   FPackageIndex TerminalSubCategoryObject      (4)
 *   int32 bTerminalIsConst                       (4)
 *   int32 bTerminalIsWeakPointer                 (4)
 *   int32 bTerminalIsUObjectWrapper              (4)
 * @param {Cursor} cur
 */
function skipEdGraphTerminalType(cur) {
  cur.skip(8 + 8 + 4 + 4 + 4 + 4);
}

/**
 * Read a SerializePinArray with ResolveType ∈ {LinkedTo, SubPins} (i.e.,
 * NOT OwningNode). Each non-null entry is a reference: {OwningNode FPackageIndex,
 * PinId FGuid}. Null entries (bNullPtr=true) are dropped from the result —
 * matches Oracle-A's GetOwningNodeUnchecked() null-check behavior.
 * @param {Cursor} cur
 * @returns {Array<{ owning_node_package_index: number, pin_id: string }>}
 */
function readPinReferenceArray(cur) {
  const count = cur.readInt32();
  const refs = [];
  for (let i = 0; i < count; i++) {
    const bNullPtr = cur.readInt32() !== 0;
    if (bNullPtr) continue; // dangling ref — drop silently per Oracle behavior
    const owning = cur.readInt32();
    const pid = guidBytesToOracleHex(cur.readBytes(16));
    refs.push({ owning_node_package_index: owning, pin_id: pid });
  }
  return refs;
}

/**
 * Consume a SerializePinArray result without storing.
 * @param {Cursor} cur
 */
function consumePinReferenceArray(cur) {
  const count = cur.readInt32();
  for (let i = 0; i < count; i++) {
    const bNullPtr = cur.readInt32() !== 0;
    if (bNullPtr) continue;
    cur.skip(4 + 16);
  }
}

/**
 * Consume a single SerializePin reference (ParentPin /
 * ReferencePassThroughConnection).
 * @param {Cursor} cur
 */
function consumePinReferenceSingle(cur) {
  const bNullPtr = cur.readInt32() !== 0;
  if (bNullPtr) return;
  cur.skip(4 + 16);
}

/**
 * Extract the NodeGuid FGuid from the tagged-property result as an
 * Oracle-A-compatible hex string (32 upper-hex chars, no dashes).
 *
 * The tagged-fallback FGuid handler emits the raw 16 bytes as a little-endian
 * hex string via Buffer.toString('hex'). Oracle-A emits via UE's
 * FGuid::ToString(EGuidFormats::Digits) which prints the 4 uint32 fields
 * A-B-C-D each as big-endian hex. Convert by reversing byte pair order
 * within each 8-hex-char group.
 *
 * @param {Record<string, any>} properties
 * @returns {string | null}  32 upper-hex chars, or null if NodeGuid absent/malformed
 */
function extractNodeGuid(properties) {
  const v = properties?.NodeGuid;
  if (typeof v !== 'string' || v.length !== 32) return null;
  const groups = [];
  for (let g = 0; g < 4; g++) {
    const chunk = v.substr(g * 8, 8);
    const beHex = chunk.match(/../g).reverse().join('');
    groups.push(beHex.toUpperCase());
  }
  return groups.join('');
}

/**
 * Default FPackageIndex resolver — returns a `/Path/Asset.ObjectName` string
 * when resolvable, or `{packageIndex}` when not. Callers can pass their own
 * resolver for richer formats.
 */
export function makePackageIndexResolver(exports, imports) {
  return function resolvePackageIndex(idx) {
    if (idx === 0) return null;
    if (idx > 0) {
      const e = exports[idx - 1];
      return e ? { objectName: e.objectName, packageIndex: idx, kind: 'export' } : { packageIndex: idx };
    }
    const imp = imports[-idx - 1];
    if (!imp) return { packageIndex: idx };
    // Walk the outer chain to build a full /Path.Object qualifier.
    // Imports chain as: package-import (objectName = "/Game/..") ← object-import
    // (outerIndex points back to the package). Bound the walk to 16 hops.
    const chain = [imp.objectName];
    let outerIdx = imp.outerIndex;
    for (let hops = 0; outerIdx < 0 && hops < 16; hops++) {
      const outer = imports[-outerIdx - 1];
      if (!outer) break;
      chain.unshift(outer.objectName);
      outerIdx = outer.outerIndex;
    }
    // Package roots start with '/', so a well-formed path is `/Game/...SomethingName`.
    const pathPrefix = chain.length > 1 && chain[0].startsWith('/') ? chain[0] : null;
    const path = pathPrefix ? `${pathPrefix}.${chain.slice(1).join('.')}` : chain.join('.');
    return {
      objectName: imp.objectName,
      packagePath: path,
      packageIndex: idx,
      kind: 'import',
    };
  };
}