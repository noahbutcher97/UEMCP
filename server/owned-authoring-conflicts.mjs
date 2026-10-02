import { lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { extractUprojectFromCommandLine } from './project-identity.mjs';

const normalized = path => path.replace(/\\/g, '/').toLowerCase().replace(/\/$/, '');
const contains = (parent, child) => child === parent || child.startsWith(parent + '/');
function canonical(path) {
  const absolute = resolve(path);
  try { lstatSync(absolute); }
  catch (error) {
    if (error.code !== 'ENOENT' || dirname(absolute) === absolute) throw error;
    return join(canonical(dirname(absolute)), absolute.slice(dirname(absolute).length + 1));
  }
  return realpathSync(absolute);
}

// Inspect names, directory identities and descriptors, never asset contents.
// An exhausted budget or unreadable identity is uncertainty, not permission.
export function assertNoOwnedAuthoringConflicts(editors, { outputRoot, repoRoot }) {
  const diagnostics = { unique: 0, repeatedAlias: 0, reparse: 0, externalTarget: 0, category: 'identity', reason: 'clear' };
  const externalTargets = new Set();
  function reject(message, reason) {
    const error = new Error(message);
    error.conflictReason = reason;
    throw error;
  }
  try {
    if (!Array.isArray(editors)) reject('Uncertain editor inspection result', 'unknown-identity');
    const protectedRoots = [outputRoot, repoRoot].map(path => normalized(canonical(path)));
    const assertSeparate = path => {
      const actual = normalized(canonical(path));
      if (protectedRoots.some(root => contains(root, actual) || contains(actual, root))) reject('Editor project or writable paths overlap owned authoring stage/source', 'overlap');
      return actual;
    };
    for (const editor of editors) {
      diagnostics.category = 'identity';
      if (!editor || !Number.isSafeInteger(editor.pid) || editor.pid <= 0 || editor.commandLineAvailable !== true || typeof editor.cmdLine !== 'string' || !editor.cmdLine.trim() || typeof editor.uprojectPath !== 'string' || !isAbsolute(editor.uprojectPath)) reject('Cannot exclude editor conflict: unknown project identity', 'unknown-identity');
      const project = realpathSync(editor.uprojectPath);
      const tokens = editor.cmdLine.match(/(?:[^\s"]+|"[^"]*")+/g) ?? [];
      const executable = tokens[0]?.replace(/"/g, '').replace(/\\/g, '/').split('/').at(-1);
      const commandProject = extractUprojectFromCommandLine(editor.cmdLine);
      if (!/^UnrealEditor(?:-Cmd)?(?:\.exe)?$/i.test(executable ?? '') || !commandProject || !isAbsolute(commandProject) || normalized(realpathSync(commandProject)) !== normalized(project)) reject('Ambiguous editor command line/project identity', 'unknown-identity');
      if (!project.toLowerCase().endsWith('.uproject') || !lstatSync(project).isFile()) reject('Invalid project descriptor', 'unknown-identity');
      const root = dirname(project);
      assertSeparate(root);
      const descriptor = JSON.parse(readFileSync(project, 'utf8').replace(/^\uFEFF/, ''));
      if (!descriptor || typeof descriptor !== 'object' || Array.isArray(descriptor)) reject('Invalid project descriptor', 'unknown-identity');
      const additional = descriptor.AdditionalPluginDirectories ?? [];
      if (!Array.isArray(additional) || additional.some(path => typeof path !== 'string' || !path)) reject('Unknown plugin paths', 'unknown-identity');
      // Resolve explicit redirects before potentially expensive directory work.
      // The first token is the installed editor executable, shared read-only.
      diagnostics.category = 'redirect';
      for (const raw of tokens.slice(1)) {
        const token = raw.replace(/"/g, '');
        if (/^-ini[:=]/i.test(token)) reject('Cannot exclude paths in editor configuration override', 'unknown-identity');
        const equal = token.indexOf('=');
        const value = equal < 0 ? token : token.slice(equal + 1);
        if (isAbsolute(value)) assertSeparate(value);
        else if (/^-(?:UserDir|ShaderWorkingDir|Out|ReportExportPath|Log|AbsLog|Project|Basedir|DDC)/i.test(token)) reject('Cannot exclude relative runtime path redirect', 'unknown-identity');
      }
      const visited = new Set();
      const rootIdentity = normalized(root);
      const categories = { Content: 'content', Source: 'source', Plugins: 'plugins', Binaries: 'binaries', Intermediate: 'intermediate', Saved: 'saved', DerivedDataCache: 'derived-data-cache', '.git': 'repository-metadata' };
      function recordExternal(path) {
        const target = normalized(canonical(path));
        if (!contains(rootIdentity, target)) externalTargets.add(target);
        diagnostics.externalTarget = externalTargets.size;
      }
      function inspect(path, category) {
        diagnostics.category = category;
        const identity = assertSeparate(path);
        if (visited.has(identity)) { diagnostics.repeatedAlias++; return; }
        if (visited.size >= 10000) reject('Editor path inspection budget exceeded', 'budget-exceeded');
        visited.add(identity);
        diagnostics.unique++;
        for (const entry of readdirSync(path, { withFileTypes: true })) {
          const child = join(path, entry.name);
          const childCategory = identity === rootIdentity ? (Object.hasOwn(categories, entry.name) ? categories[entry.name] : 'other') : category;
          diagnostics.category = childCategory;
          if (entry.isSymbolicLink()) {
            diagnostics.reparse++;
            const target = realpathSync(child);
            assertSeparate(target);
            recordExternal(target);
            if (lstatSync(target).isDirectory()) inspect(target, childCategory);
          } else if (entry.isDirectory()) inspect(child, childCategory);
        }
      }
      inspect(root, 'project-root');
      for (const path of additional) {
        diagnostics.category = 'additional-plugin';
        const target = resolve(root, path);
        recordExternal(target);
        inspect(target, 'additional-plugin');
      }
    }
    return { ...diagnostics };
  } catch (error) {
    diagnostics.reason = error.conflictReason ?? 'inspection-error';
    const failure = new Error(`Cannot exclude editor project/path conflict: ${error.conflictReason ? error.message : 'unreadable or malformed project/path identity'}`);
    failure.diagnostics = { ...diagnostics };
    throw failure;
  }
}
