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
  readUInt16() { this.ensure(2); const v = this.buf.readUInt16LE(this.pos); this.pos += 2; return v; }
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
    const serialSize = cur.readInt64AsNumber();
    const serialOffset = cur.readInt64AsNumber();
    const bForcedExport = cur.readInt32();
    const bNotForClient = cur.readInt32();
    const bNotForServer = cur.readInt32();
    const packageFlags = cur.readUInt32();
    const bNotAlwaysLoadedForEditorGame = cur.readInt32();
    const bIsAsset = cur.readInt32();
    const publicExportHash = cur.readInt64AsNumber();
    const firstExportDependency = cur.readInt32();
    const serBeforeSerDeps = cur.readInt32();
    const createBeforeSerDeps = cur.readInt32();
    const serBeforeCreateDeps = cur.readInt32();
    const createBeforeCreateDeps = cur.readInt32();
    const scriptSerializationStartOffset = cur.readInt64AsNumber();
    const scriptSerializationEndOffset = cur.readInt64AsNumber();
    exports[i] = {
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
