// engine-fixtures.mjs — locating differential fixtures inside a UE install.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ENGINE_MOUNT = '/Engine/';

// Standard Epic Games Launcher install locations. Ordered oldest-first is
// deliberate at the call site, not here: callers that care which engine they
// get pass their own ordered candidates, because an oracle only matches the
// engine version it was generated against.
const DEFAULT_ENGINE_CANDIDATES = Object.freeze([
  'C:/Program Files/Epic Games/UE_5.8',
  'C:/Program Files/Epic Games/UE_5.7',
  'C:/Program Files/Epic Games/UE_5.6',
  'C:/Program Files/Epic Games/UE_5.3',
]);

function defaultReadFile(path) {
  return readFileSync(path, 'utf8');
}

function defaultExists(path) {
  return existsSync(path);
}

/**
 * Map an /Engine/ asset path to its file on disk.
 *
 * Unlike a project asset — which findContentAsset() has to search for, because
 * project content moves — engine content sits at a fixed location for a given
 * install, so this is a pure path rule with nothing to discover.
 *
 * @param {string} engineRoot — install root, the directory CONTAINING Engine/
 * @param {string} enginePath — e.g. '/Engine/EngineSky/BP_Sky_Sphere'
 * @returns {string|null} null when either argument is unusable or the path is
 *   not under the /Engine/ mount.
 */
export function engineAssetDiskPath(engineRoot, enginePath) {
  if (typeof engineRoot !== 'string' || !engineRoot) return null;
  if (typeof enginePath !== 'string' || !enginePath.startsWith(ENGINE_MOUNT)) return null;
  const rel = enginePath.slice(ENGINE_MOUNT.length);
  if (!rel) return null;
  return join(engineRoot, 'Engine', 'Content', `${rel}.uasset`);
}

/**
 * Locate a UE install to resolve engine fixtures against.
 *
 * Returning null is an ordinary outcome — a CI runner has no engine — so
 * callers turn it into a labeled skip rather than a failure.
 *
 * @returns {string|null} install root (the directory containing Engine/)
 */
export function resolveEngineRoot({
  env = process.env,
  preferVersion,
  candidates = DEFAULT_ENGINE_CANDIDATES,
  existsImpl = defaultExists,
} = {}) {
  const explicit = env?.UE_ENGINE_ROOT;
  if (explicit && existsImpl(explicit)) return explicit;

  // A caller pinned to a version wants that engine or nothing. Falling back to
  // a different one would hand back an asset that looks right and is not: the
  // same /Engine/ path holds different bytes in each engine version.
  if (preferVersion) {
    const match = candidates.find(c => c.endsWith(`UE_${preferVersion}`));
    return match && existsImpl(match) ? match : null;
  }

  for (const candidate of candidates) {
    if (existsImpl(candidate)) return candidate;
  }
  return null;
}

/**
 * Does an install's Build.version describe the engine an oracle was dumped from?
 *
 * Engine content can change between point releases, so an oracle is only
 * comparable against its own build. The oracle records a full branch string
 * ('5.6.1-44394996+++UE5+Release-5.6'); Build.version supplies the numeric
 * prefix, and the trailing '-' in the comparison keeps 5.6.1 from matching
 * 5.6.10.
 *
 * @param {{MajorVersion:number,MinorVersion:number,PatchVersion:number,Changelist:number}|null} build
 * @param {string} oracleVersion — the oracle's `engine_version` field
 */
export function engineVersionMatches(build, oracleVersion) {
  if (!build || typeof oracleVersion !== 'string') return false;
  const { MajorVersion, MinorVersion, PatchVersion, Changelist } = build;
  return oracleVersion.startsWith(`${MajorVersion}.${MinorVersion}.${PatchVersion}-${Changelist}`);
}

/**
 * Read an install's Engine/Build/Build.version.
 *
 * Every failure — absent file, unreadable, malformed JSON — collapses to null,
 * because the only caller turns "no usable engine" into a labeled skip and a
 * throw here would convert a skip into a rotation failure.
 *
 * @returns {{MajorVersion:number,MinorVersion:number,PatchVersion:number,Changelist:number}|null}
 */
export function readEngineBuildVersion(engineRoot, { readFileImpl = defaultReadFile } = {}) {
  if (typeof engineRoot !== 'string' || !engineRoot) return null;
  try {
    const parsed = JSON.parse(readFileImpl(join(engineRoot, 'Engine', 'Build', 'Build.version')));
    return typeof parsed === 'object' && parsed !== null ? parsed : null;
  } catch {
    return null;
  }
}
