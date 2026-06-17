// Canonical Unreal project identity and workspace auto-resolution helpers.

import {
  existsSync,
  readdirSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { fileURLToPath } from 'node:url';
import { basename, dirname, extname, join, resolve } from 'node:path';

import { PROJECT_ERROR_CODES, ProjectContextError } from './project-errors.mjs';

const DEFAULT_FS = {
  existsSync,
  readdirSync,
  realpathSync,
  statSync,
};

function displayPath(pathValue) {
  return String(pathValue || '').replace(/\\/g, '/').replace(/\/+$/, '');
}

function isUprojectPath(pathValue) {
  return extname(String(pathValue || '')).toLowerCase() === '.uproject';
}

export function decodeFileUriToLocalPath(uri) {
  const parsed = new URL(uri);
  if (parsed.protocol !== 'file:') {
    throw new ProjectContextError(
      PROJECT_ERROR_CODES.PROJECT_PATH_UNSUPPORTED,
      `Unsupported URI protocol for project root: ${parsed.protocol}`,
      { uri },
    );
  }
  if (parsed.host && parsed.host.toLowerCase() !== 'localhost') {
    throw new ProjectContextError(
      PROJECT_ERROR_CODES.PROJECT_PATH_UNSUPPORTED,
      `Non-local file URI authorities are not accepted for MCP roots: ${parsed.host}`,
      { uri, authority: parsed.host },
    );
  }
  return displayPath(fileURLToPath(parsed));
}

export function normalizeComparisonPath(pathValue) {
  if (!pathValue) return '';
  return displayPath(resolve(pathValue)).toLowerCase();
}

export function normalizePath(pathValue) {
  return normalizeComparisonPath(pathValue);
}

export function extractUprojectFromCommandLine(commandLine) {
  if (!commandLine) return null;
  const match = String(commandLine).match(/"([^"]+\.uproject)"/i) ||
    String(commandLine).match(/(\S+\.uproject)/i);
  return match ? match[1] : null;
}

export function canonicalizePath(pathValue, fsImpl = DEFAULT_FS) {
  const resolved = resolve(pathValue);
  try {
    const native = fsImpl.realpathSync?.native || realpathSync.native;
    return normalizeComparisonPath(native(resolved));
  } catch {
    return normalizeComparisonPath(resolved);
  }
}

export function isInsidePath(child, parent) {
  const childNorm = normalizeComparisonPath(child);
  const parentNorm = normalizeComparisonPath(parent);
  if (!childNorm || !parentNorm) return false;
  return childNorm === parentNorm || childNorm.startsWith(`${parentNorm}/`);
}

export function findDirectUprojects(root, fsImpl = DEFAULT_FS) {
  let entries;
  try {
    entries = fsImpl.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter(entry => entry.isFile() && entry.name.toLowerCase().endsWith('.uproject'))
    .map(entry => join(root, entry.name))
    .sort((a, b) => a.localeCompare(b));
}

function validateUprojectPath(uprojectPath, fsImpl = DEFAULT_FS) {
  if (!isUprojectPath(uprojectPath)) {
    throw new ProjectContextError(
      PROJECT_ERROR_CODES.PROJECT_PATH_INVALID,
      `Project path must point to a .uproject file: ${uprojectPath}`,
      { path: uprojectPath },
    );
  }
  if (!fsImpl.existsSync(uprojectPath)) {
    throw new ProjectContextError(
      PROJECT_ERROR_CODES.PROJECT_PATH_INVALID,
      `Project file does not exist: ${uprojectPath}`,
      { path: uprojectPath },
    );
  }
  let stat;
  try {
    stat = fsImpl.statSync(uprojectPath);
  } catch (err) {
    throw new ProjectContextError(
      PROJECT_ERROR_CODES.PROJECT_PATH_INVALID,
      `Project file cannot be inspected: ${uprojectPath}`,
      { path: uprojectPath, reason: err.message },
    );
  }
  if (!stat.isFile()) {
    throw new ProjectContextError(
      PROJECT_ERROR_CODES.PROJECT_PATH_INVALID,
      `Project path is not a file: ${uprojectPath}`,
      { path: uprojectPath },
    );
  }
}

function resolveClientRoots(clientRoots = []) {
  return clientRoots.map(root => {
    const text = String(root || '');
    return text.startsWith('file://') ? decodeFileUriToLocalPath(text) : text;
  }).filter(Boolean);
}

export function createProjectIdentity({
  projectRoot,
  uprojectPath,
  source = 'explicit',
  fsImpl = DEFAULT_FS,
  clientRoots = [],
} = {}) {
  let finalUprojectPath = uprojectPath;
  let finalProjectRoot = projectRoot;

  if (finalProjectRoot && !finalUprojectPath) {
    const direct = findDirectUprojects(finalProjectRoot, fsImpl);
    if (direct.length !== 1) {
      throw new ProjectContextError(
        direct.length > 1 ? PROJECT_ERROR_CODES.PROJECT_AMBIGUOUS : PROJECT_ERROR_CODES.PROJECT_PATH_INVALID,
        `Project root must contain exactly one direct .uproject file: ${finalProjectRoot}`,
        { path: finalProjectRoot, directUprojects: direct.map(displayPath) },
      );
    }
    finalUprojectPath = direct[0];
  }

  if (!finalUprojectPath) {
    throw new ProjectContextError(
      PROJECT_ERROR_CODES.PROJECT_PATH_INVALID,
      'A project root or .uproject path is required.',
    );
  }

  validateUprojectPath(finalUprojectPath, fsImpl);
  finalProjectRoot = finalProjectRoot || dirname(finalUprojectPath);

  const canonicalProjectRoot = canonicalizePath(finalProjectRoot, fsImpl);
  const canonicalUprojectPath = canonicalizePath(finalUprojectPath, fsImpl);
  const roots = resolveClientRoots(clientRoots);
  const insideClientRoot = roots.length > 0
    ? roots.some(root => isInsidePath(finalProjectRoot, root))
    : false;

  return {
    projectRoot: displayPath(finalProjectRoot),
    canonicalProjectRoot,
    uprojectPath: displayPath(finalUprojectPath),
    canonicalUprojectPath,
    projectName: basename(finalUprojectPath, extname(finalUprojectPath)),
    source,
    insideClientRoot,
    outsideClientRoot: roots.length > 0 && !insideClientRoot,
    warnings: [],
  };
}

function isUemcpRepoRoot(root, fsImpl = DEFAULT_FS) {
  return fsImpl.existsSync(join(root, 'tools.yaml')) &&
    fsImpl.existsSync(join(root, 'server', 'server.mjs')) &&
    fsImpl.existsSync(join(root, 'plugin', 'UEMCP', 'UEMCP.uplugin'));
}

function childProjectCandidates(root, options) {
  const fsImpl = options.fsImpl || DEFAULT_FS;
  let entries;
  try {
    entries = fsImpl.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const candidates = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const childRoot = join(root, entry.name);
    const direct = findDirectUprojects(childRoot, fsImpl);
    if (direct.length === 1) {
      candidates.push(createProjectIdentity({
        uprojectPath: direct[0],
        source: 'workspace-child',
        fsImpl,
        clientRoots: options.clientRoots || [root],
      }));
    }
  }
  return candidates;
}

export function scanWorkspaceRoot(root, options = {}) {
  const fsImpl = options.fsImpl || DEFAULT_FS;
  const rootDisplay = displayPath(root);

  if (isUemcpRepoRoot(root, fsImpl)) {
    return {
      root: rootDisplay,
      status: 'unresolved',
      reason: 'UEMCP_REPO_GUARD',
      candidates: [],
      warnings: ['UEMCP repository roots do not auto-attach fixture projects.'],
    };
  }

  const direct = findDirectUprojects(root, fsImpl);
  if (direct.length === 1) {
    return {
      root: rootDisplay,
      status: 'resolved',
      reason: 'ONE_DIRECT_UPROJECT',
      candidates: [createProjectIdentity({
        uprojectPath: direct[0],
        source: 'workspace-direct',
        fsImpl,
        clientRoots: options.clientRoots || [root],
      })],
      warnings: [],
    };
  }
  if (direct.length > 1) {
    return {
      root: rootDisplay,
      status: 'ambiguous',
      reason: 'MULTIPLE_DIRECT_UPROJECTS',
      candidates: direct.map(uprojectPath => createProjectIdentity({
        uprojectPath,
        source: 'workspace-direct',
        fsImpl,
        clientRoots: options.clientRoots || [root],
      })),
      warnings: [],
    };
  }

  const candidates = childProjectCandidates(root, { ...options, fsImpl });
  if (candidates.length === 1) {
    return {
      root: rootDisplay,
      status: 'resolved',
      reason: 'ONE_CHILD_PROJECT',
      candidates,
      warnings: [],
    };
  }
  if (candidates.length > 1) {
    return {
      root: rootDisplay,
      status: 'ambiguous',
      reason: 'MULTIPLE_CHILD_PROJECTS',
      candidates,
      warnings: [],
    };
  }

  return {
    root: rootDisplay,
    status: 'unresolved',
    reason: 'NO_PROJECT_CANDIDATES',
    candidates: [],
    warnings: [],
  };
}

export function normalizeProjectInput(input, options = {}) {
  if (typeof input === 'string' && input.startsWith('file://')) {
    return createProjectIdentity({
      uprojectPath: decodeFileUriToLocalPath(input),
      ...options,
    });
  }
  if (isUprojectPath(input)) {
    return createProjectIdentity({ uprojectPath: input, ...options });
  }
  return createProjectIdentity({ projectRoot: input, ...options });
}
