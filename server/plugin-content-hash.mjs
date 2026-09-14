// plugin-content-hash.mjs — content identity for a UEMCP plugin tree.
//
// Deploy verdicts used to rest on file mtimes alone, so a merge, checkout or
// stash-pop that rewrote plugin source made byte-identical deployments look
// stale and the pre-push gate refused the push (EN-27). This module answers
// "is this deployed tree the same content as the repo's" without consulting a
// single timestamp: the digest covers the source tree and the descriptor, in
// sorted path order, and nothing else.
//
// fsImpl is injectable so the unit tests can run against an in-memory tree.
// Deliberately absent from that contract: any stat call.

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const DEFAULT_FS = { readdirSync, readFileSync };

/** Build outputs: regenerated from content, never part of it. */
const EXCLUDED_DIRS = new Set(['Binaries', 'Intermediate']);

/** Files the deploy tooling writes into the tree; they describe a sync, not the source. */
const EXCLUDED_FILE_PREFIX = '.uemcp-';

/** The two root entries that define plugin content. */
const ROOT_DIRS = ['Source'];
const ROOT_FILES = ['UEMCP.uplugin'];

/** Byte-order comparison; localeCompare would make the digest locale-dependent. */
function byPath(a, b) {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

/**
 * Every content-bearing file under a plugin root, as sorted relative paths with
 * forward slashes. Returns null when any directory could not be listed — a
 * partial list would produce a confident wrong digest, and "unknown" is a
 * verdict the classifier can express.
 */
export function collectPluginContentFiles(pluginRoot, fsImpl = DEFAULT_FS) {
  const files = [];
  let ok = true;

  const walk = (absDir, relPrefix) => {
    let entries;
    try {
      entries = fsImpl.readdirSync(absDir, { withFileTypes: true });
    } catch {
      ok = false;
      return;
    }
    for (const entry of entries) {
      if (!ok) return;
      if (entry.isDirectory()) {
        if (EXCLUDED_DIRS.has(entry.name)) continue;
        walk(join(absDir, entry.name), `${relPrefix}${entry.name}/`);
      } else if (entry.isFile()) {
        if (entry.name.startsWith(EXCLUDED_FILE_PREFIX)) continue;
        files.push(`${relPrefix}${entry.name}`);
      }
    }
  };

  for (const dir of ROOT_DIRS) walk(join(pluginRoot, dir), `${dir}/`);
  if (!ok) return null;
  for (const file of ROOT_FILES) files.push(file);
  return files.sort(byPath);
}

/**
 * SHA-256 over `relativePath + NUL + fileBytes` for every content file, in
 * sorted path order. Equal digests mean byte-identical trees. Returns null when
 * any file could not be read — an editor holding a file open must not be able
 * to turn a stale deployment into a confident match.
 */
export function hashPluginTree(pluginRoot, fsImpl = DEFAULT_FS) {
  const files = collectPluginContentFiles(pluginRoot, fsImpl);
  if (files === null) return null;
  const hash = createHash('sha256');
  for (const rel of files) {
    let bytes;
    try {
      bytes = fsImpl.readFileSync(join(pluginRoot, ...rel.split('/')));
    } catch {
      return null;
    }
    hash.update(`${rel}\0`, 'utf8');
    hash.update(bytes);
  }
  return hash.digest('hex');
}
