import * as defaultFs from 'node:fs/promises';
import { isAbsolute, join, posix, relative, resolve, sep, win32 } from 'node:path';

import { sha256Bytes, sha256Canonical } from './canonical-json.mjs';

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

function sameStableFile(left, right) {
  return left.isFile()
    && right.isFile()
    && Number(left.dev) === Number(right.dev)
    && Number(left.ino) === Number(right.ino)
    && Number(left.birthtimeMs) === Number(right.birthtimeMs)
    && Number(left.nlink) === Number(right.nlink)
    && Number(left.size) === Number(right.size)
    && Number(left.mtimeMs) === Number(right.mtimeMs)
    && Number(left.ctimeMs) === Number(right.ctimeMs);
}

function sameStableLink(left, right) {
  return left.isSymbolicLink()
    && right.isSymbolicLink()
    && Number(left.dev) === Number(right.dev)
    && Number(left.ino) === Number(right.ino)
    && Number(left.birthtimeMs) === Number(right.birthtimeMs)
    && Number(left.size) === Number(right.size)
    && Number(left.mtimeMs) === Number(right.mtimeMs)
    && Number(left.ctimeMs) === Number(right.ctimeMs);
}

function byteLimitError(maxBytes, observedBytes) {
  return new FingerprintError('file exceeds its fingerprint byte limit', 'FINGERPRINT_BYTE_LIMIT', {
    maximum_bytes: maxBytes,
    observed_bytes: observedBytes,
  });
}

async function readHandleWithinLimit(handle, maxBytes) {
  if (maxBytes === null) return handle.readFile();
  const chunks = [];
  let total = 0;
  while (total <= maxBytes) {
    const remaining = maxBytes + 1 - total;
    const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, remaining));
    const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
    if (bytesRead === 0) break;
    chunks.push(chunk.subarray(0, bytesRead));
    total += bytesRead;
  }
  if (total > maxBytes) throw byteLimitError(maxBytes, total);
  return Buffer.concat(chunks, total);
}

async function readStableFingerprintFile(path, {
  fsImpl,
  initialStat,
  initialLink = null,
  maxBytes,
  evidencePath = resolve(path),
}) {
  if (maxBytes !== null && Number(initialStat.size) > maxBytes) {
    throw byteLimitError(maxBytes, Number(initialStat.size));
  }
  let handle;
  try {
    handle = await fsImpl.open(path, 'r');
    const handleBefore = await handle.stat();
    if (maxBytes !== null && Number(handleBefore.size) > maxBytes) {
      throw byteLimitError(maxBytes, Number(handleBefore.size));
    }
    if (!sameStableFile(initialStat, handleBefore)) {
      throw new FingerprintError('file changed before its fingerprint read handle was secured', 'FINGERPRINT_CHANGED_DURING_READ', { path: evidencePath });
    }
    const bytes = await readHandleWithinLimit(handle, maxBytes);
    const handleAfter = await handle.stat();
    const pathAfter = initialLink === null ? await fsImpl.lstat(path) : await fsImpl.stat(path);
    const linkAfter = initialLink === null ? null : await fsImpl.lstat(path);
    if (!sameStableFile(handleBefore, handleAfter)
      || !sameStableFile(handleAfter, pathAfter)
      || (initialLink !== null && !sameStableLink(initialLink, linkAfter))
      || bytes.byteLength !== Number(handleAfter.size)) {
      throw new FingerprintError('file changed while hashing', 'FINGERPRINT_CHANGED_DURING_READ', { path: evidencePath });
    }
    return bytes;
  } finally {
    await handle?.close().catch(() => {});
  }
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
    const bytes = await readStableFingerprintFile(canonicalPath, {
      fsImpl,
      initialStat: stat,
      initialLink: lstat.isSymbolicLink() ? lstat : null,
      maxBytes,
    });
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
        const bytes = await readStableFingerprintFile(childPath, {
          fsImpl,
          initialStat: childLstat,
          maxBytes: remaining,
          evidencePath: rel,
        });
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
