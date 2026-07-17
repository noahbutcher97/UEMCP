import * as defaultFs from 'node:fs/promises';
import { isAbsolute, join, posix, relative, resolve, sep, win32 } from 'node:path';

import { sha256Bytes, sha256Canonical } from './canonical-json.mjs';
import { readFileWithinLimit } from './bounded-config-file.mjs';

export class FingerprintError extends Error {
  constructor(message, code = 'FINGERPRINT_FAILED', details = {}) {
    super(message);
    this.name = 'FingerprintError';
    this.code = code;
    this.details = details;
  }
}

function isMissing(error) {
  return error?.code === 'ENOENT' || error?.code === 'ENOTDIR';
}

function pathKey(value) {
  const normalized = resolve(value);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function isContained(root, candidate) {
  const rel = relative(pathKey(root), pathKey(candidate));
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

async function realPathForMissing(absolutePath, fsImpl) {
  const tail = [];
  let current = absolutePath;
  while (true) {
    try {
      const realAncestor = await fsImpl.realpath(current);
      return resolve(realAncestor, ...tail.reverse());
    } catch (error) {
      if (!isMissing(error)) throw error;
      const parent = resolve(current, '..');
      if (parent === current) throw error;
      tail.push(current.slice(parent.length).replace(/^[/\\]+/, ''));
      current = parent;
    }
  }
}

async function canonicalAllowedRoots(allowedRoots, fsImpl) {
  if (!Array.isArray(allowedRoots) || allowedRoots.length === 0) {
    throw new FingerprintError('allowedRoots must contain at least one root', 'INVALID_ALLOWED_ROOT');
  }
  const roots = [];
  for (const root of allowedRoots) {
    if (typeof root !== 'string' || !(isAbsolute(root) || win32.isAbsolute(root) || posix.isAbsolute(root))) {
      throw new FingerprintError('allowed root must be absolute', 'INVALID_ALLOWED_ROOT');
    }
    const absolute = resolve(root);
    let real;
    try {
      real = await fsImpl.realpath(absolute);
    } catch (error) {
      if (!isMissing(error)) throw error;
      real = await realPathForMissing(absolute, fsImpl);
    }
    roots.push(resolve(real));
  }
  return roots;
}

async function assertAllowed(candidate, allowedRoots, fsImpl) {
  const roots = await canonicalAllowedRoots(allowedRoots, fsImpl);
  if (!roots.some(root => isContained(root, candidate))) {
    throw new FingerprintError('path resolves outside the allowed roots', 'PATH_OUTSIDE_ALLOWED_ROOT', {
      path: resolve(candidate),
    });
  }
}

function kindFor(stat) {
  if (stat.isFile()) return 'file';
  if (stat.isDirectory()) return 'directory';
  return 'other';
}

export async function fingerprintPath(requestedPath, { allowedRoots, fsImpl = defaultFs, maxBytes = null } = {}) {
  if (typeof requestedPath !== 'string' || requestedPath.trim() === '') {
    throw new FingerprintError('path must be a non-empty string', 'INVALID_PATH');
  }
  if (maxBytes !== null && (!Number.isSafeInteger(maxBytes) || maxBytes < 0)) {
    throw new FingerprintError('file fingerprint byte limit is invalid', 'INVALID_FINGERPRINT_LIMIT');
  }
  const canonicalPath = resolve(requestedPath);
  let lstat;
  try {
    lstat = await fsImpl.lstat(canonicalPath);
  } catch (error) {
    if (!isMissing(error)) throw error;
    const expectedReal = await realPathForMissing(canonicalPath, fsImpl);
    await assertAllowed(expectedReal, allowedRoots, fsImpl);
    return {
      requested_path: requestedPath,
      canonical_path: canonicalPath,
      real_path: expectedReal,
      exists: false,
      kind: 'missing',
      link_kind: 'none',
      link_count: 0,
      size: 0,
      sha256: null,
    };
  }

  const realPath = resolve(await fsImpl.realpath(canonicalPath));
  await assertAllowed(realPath, allowedRoots, fsImpl);
  const linkKind = lstat.isSymbolicLink() ? 'symbolic_link' : 'none';
  const stat = lstat.isSymbolicLink() ? await fsImpl.stat(canonicalPath) : lstat;
  const kind = kindFor(stat);
  let observedSize = Number(stat.size);
  let sha256 = null;
  if (kind === 'file') {
    if (maxBytes !== null && Number(stat.size) > maxBytes) {
      throw new FingerprintError('file exceeds its fingerprint byte limit', 'FINGERPRINT_BYTE_LIMIT', {
        maximum_bytes: maxBytes,
        observed_bytes: Number(stat.size),
      });
    }
    let bytes;
    try {
      bytes = maxBytes === null
        ? await fsImpl.readFile(canonicalPath)
        : await readFileWithinLimit(canonicalPath, { fsImpl, maxBytes, scope: 'fingerprint' });
    } catch (error) {
      if (error?.code === 'INSPECTION_LIMIT_EXCEEDED') {
        throw new FingerprintError('file exceeds its fingerprint byte limit', 'FINGERPRINT_BYTE_LIMIT', error.details);
      }
      throw error;
    }
    sha256 = sha256Bytes(bytes);
    if (maxBytes !== null) observedSize = bytes.length;
  }
  return {
    requested_path: requestedPath,
    canonical_path: canonicalPath,
    real_path: realPath,
    exists: true,
    kind,
    link_kind: linkKind,
    link_count: Number(stat.nlink),
    size: observedSize,
    sha256,
  };
}

function slashRelative(root, value) {
  return relative(root, value).split(sep).join('/');
}

function matchesRule(path, rule) {
  if (typeof rule === 'function') return rule(path);
  if (typeof rule !== 'string') return false;
  const normalized = rule.replace(/\\/g, '/').replace(/^\.\//, '');
  if (normalized.endsWith('/**')) {
    const prefix = normalized.slice(0, -3).replace(/\/$/, '');
    return path === prefix || path.startsWith(`${prefix}/`);
  }
  return path === normalized;
}

function selected(path, include, exclude) {
  const included = include === undefined || (Array.isArray(include) ? include.some(rule => matchesRule(path, rule)) : matchesRule(path, include));
  const excluded = exclude !== undefined && (Array.isArray(exclude) ? exclude.some(rule => matchesRule(path, rule)) : matchesRule(path, exclude));
  return included && !excluded;
}

export async function fingerprintDirectory(root, {
  include,
  exclude,
  allowedRoots = [root],
  fsImpl = defaultFs,
  maxEntries = null,
  maxFiles = null,
  maxBytes = null,
} = {}) {
  for (const [label, value] of [['entry', maxEntries], ['file', maxFiles], ['byte', maxBytes]]) {
    if (value !== null && (!Number.isSafeInteger(value) || value < 0)) {
      throw new FingerprintError(`directory manifest ${label} limit is invalid`, 'INVALID_FINGERPRINT_LIMIT');
    }
  }
  const absoluteRoot = resolve(root);
  const rootFingerprint = await fingerprintPath(absoluteRoot, { allowedRoots, fsImpl });
  if (!rootFingerprint.exists || rootFingerprint.kind !== 'directory' || rootFingerprint.link_kind !== 'none') {
    throw new FingerprintError('directory manifest root must be an existing non-linked directory', 'INVALID_DIRECTORY_ROOT');
  }
  const entries = [];
  let visitedEntries = 0;
  let selectedFiles = 0;
  let selectedBytes = 0;

  async function visit(directory) {
    const children = await fsImpl.readdir(directory, { withFileTypes: true });
    children.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    for (const child of children) {
      visitedEntries += 1;
      if (maxEntries !== null && visitedEntries > maxEntries) {
        throw new FingerprintError('directory manifest exceeds its traversal entry limit', 'FINGERPRINT_ENTRY_LIMIT', {
          maximum_entries: maxEntries,
          observed_entries: visitedEntries,
        });
      }
      const childPath = join(directory, child.name);
      const rel = slashRelative(absoluteRoot, childPath);
      const childLstat = await fsImpl.lstat(childPath);
      if (childLstat.isSymbolicLink()) {
        throw new FingerprintError('directory manifest contains a link', 'UNSAFE_LINK_TYPE', { path: rel });
      }
      if (childLstat.isDirectory()) {
        await visit(childPath);
      } else if (childLstat.isFile() && selected(rel, include, exclude)) {
        if (childLstat.nlink !== 1) {
          throw new FingerprintError('directory manifest contains a multiply linked file', 'UNSAFE_LINK_TYPE', { path: rel });
        }
        selectedFiles += 1;
        if (maxFiles !== null && selectedFiles > maxFiles) {
          throw new FingerprintError('directory manifest exceeds its file limit', 'FINGERPRINT_FILE_LIMIT', {
            maximum_files: maxFiles,
            observed_files: selectedFiles,
          });
        }
        const remaining = maxBytes === null ? null : maxBytes - selectedBytes;
        if (remaining !== null && Number(childLstat.size) > remaining) {
          throw new FingerprintError('directory manifest exceeds its aggregate byte limit', 'FINGERPRINT_BYTE_LIMIT', {
            maximum_bytes: maxBytes,
            observed_bytes: selectedBytes + Number(childLstat.size),
          });
        }
        let bytes;
        try {
          bytes = remaining === null
            ? await fsImpl.readFile(childPath)
            : await readFileWithinLimit(childPath, { fsImpl, maxBytes: remaining, scope: 'directory manifest' });
        } catch (error) {
          if (error?.code === 'INSPECTION_LIMIT_EXCEEDED') {
            throw new FingerprintError('directory manifest exceeds its aggregate byte limit', 'FINGERPRINT_BYTE_LIMIT', error.details);
          }
          throw error;
        }
        const after = await fsImpl.lstat(childPath);
        if (!after.isFile()
          || after.isSymbolicLink()
          || after.nlink !== 1
          || after.dev !== childLstat.dev
          || after.ino !== childLstat.ino
          || Number(after.size) !== bytes.byteLength
          || Number(after.mtimeMs) !== Number(childLstat.mtimeMs)) {
          throw new FingerprintError('directory manifest file changed while hashing', 'FINGERPRINT_CHANGED_DURING_READ', { path: rel });
        }
        selectedBytes += bytes.byteLength;
        entries.push({ path: rel, size: bytes.byteLength, sha256: sha256Bytes(bytes) });
      } else if (childLstat.isFile()) {
        if (childLstat.nlink !== 1) {
          throw new FingerprintError('directory manifest contains a multiply linked file', 'UNSAFE_LINK_TYPE', { path: rel });
        }
      } else {
        throw new FingerprintError('directory manifest contains an unsupported path type', 'UNSAFE_PATH_TYPE', { path: rel });
      }
    }
  }

  await visit(absoluteRoot);
  entries.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return {
    root: absoluteRoot,
    entries,
    entry_count: visitedEntries,
    file_count: selectedFiles,
    total_bytes: selectedBytes,
    manifest_sha256: sha256Canonical(entries),
  };
}
