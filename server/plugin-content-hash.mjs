// plugin-content-hash.mjs — content identity for a UEMCP plugin tree.
//
// Deploy verdicts used to rest on file mtimes alone, so a merge, checkout or
// stash-pop that rewrote plugin source made byte-identical deployments look
// stale and the pre-push gate refused the push (EN-27). This module answers
// "is this deployed tree the same content as the repo's" without consulting a
// single timestamp: the digest covers the source tree and the descriptor, in
// sorted path order, and nothing else.
//
// The digest covers `Source/**` and `UEMCP.uplugin` (both required — a
// missing one makes the digest null) plus, when present, `Resources/**`
// (icons and other packaged assets, hashed as opaque bytes like anything
// else). `Resources/` is optional: a target deployed before that directory
// existed still compares by content, so its absence contributes nothing
// rather than nulling the digest. Both roots are everything `sync-plugin.bat`
// copies except `Binaries/` and `Intermediate/`, which this module also
// excludes as build output, never source.
//
// fsImpl is injectable so the unit tests can run against an in-memory tree.
// Deliberately absent from that contract: any stat call.
//
// Line endings are normalised (CRLF → LF) before hashing because they vary
// per checkout — git's autocrlf, or a tree restored by `git archive` — and do
// not change what compiles.

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const DEFAULT_FS = { readdirSync, readFileSync };

/** Build outputs: regenerated from content, never part of it. */
const EXCLUDED_DIRS = new Set(['Binaries', 'Intermediate']);

/** Files the deploy tooling writes into the tree; they describe a sync, not the source. */
const EXCLUDED_FILE_PREFIX = '.uemcp-';

/** Required root: missing means the digest is unknown (null). */
const REQUIRED_ROOT_DIRS = ['Source'];
/** Optional root: missing means it simply contributes no files. */
const OPTIONAL_ROOT_DIRS = ['Resources'];
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

  const collectEntries = (entries, absDir, relPrefix) => {
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

  const walk = (absDir, relPrefix) => {
    let entries;
    try {
      entries = fsImpl.readdirSync(absDir, { withFileTypes: true });
    } catch {
      ok = false;
      return;
    }
    collectEntries(entries, absDir, relPrefix);
  };

  for (const dir of REQUIRED_ROOT_DIRS) walk(join(pluginRoot, dir), `${dir}/`);
  if (!ok) return null;

  // Optional roots: only ENOENT/ENOTDIR on the root itself (a target deployed
  // before this directory existed, or a path component that isn't a
  // directory) means "absent, contributes nothing rather than nulling the
  // whole digest". Any other error reading the root — EACCES, for
  // instance — is a real failure, not an absence, and must fail closed to
  // null like a required root; treating it as "absent" would let an
  // inaccessible Resources/ silently drop out of the digest and produce a
  // confident wrong match. A failure reading something *inside* an optional
  // root that does exist is likewise a real error, caught via the shared
  // `ok` flag below.
  for (const dir of OPTIONAL_ROOT_DIRS) {
    const absDir = join(pluginRoot, dir);
    let entries;
    try {
      entries = fsImpl.readdirSync(absDir, { withFileTypes: true });
    } catch (err) {
      if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) continue;
      return null;
    }
    collectEntries(entries, absDir, `${dir}/`);
    if (!ok) return null;
  }

  for (const file of ROOT_FILES) files.push(file);
  return files.sort(byPath);
}

/**
 * SHA-256 over `relativePath + NUL + byteLength + NUL + CRLF-normalised
 * fileBytes` for every content file, in sorted path order. The length is
 * delimited ahead of the bytes so a NUL inside a file name or a file's own
 * content can never make one file's stream indistinguishable from a path
 * boundary between two others (e.g. a single file containing
 * `"Source/b\0x"` would otherwise hash identically to separate `Source/a`
 * (empty) and `Source/b` ("x") files). Equal digests mean content-identical
 * trees modulo line endings. Returns null when any file could not be read —
 * an editor holding a file open must not be able to turn a stale deployment
 * into a confident match.
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
    // latin1 round-trips every byte 0-255 1:1 (unlike utf8), so this replaces
    // only literal CRLF pairs and cannot re-encode or alter any other byte.
    const normalized = Buffer.from(bytes.toString('latin1').replace(/\r\n/g, '\n'), 'latin1');
    hash.update(`${rel}\0${normalized.length}\0`, 'utf8');
    hash.update(normalized);
  }
  return hash.digest('hex');
}
