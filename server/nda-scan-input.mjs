import { execFileSync } from 'node:child_process';
import { canonicalJson, sha256Bytes, sha256Canonical } from './deployment/canonical-json.mjs';

const manifestPath = 'dist/deploy-uemcp.manifest.json';
const manifestHeader = 'diff --git a/' + manifestPath + ' b/' + manifestPath;
const manifestKeys = 'bundle_sha256 bundled_packages entry esbuild_version input_manifest_sha256 node_minimum notices_sha256 package_lock_sha256 schema_version source_inputs';
const gitOptions = { maxBuffer: 128 * 1024 * 1024, windowsHide: true };
const git = (...args) => execFileSync('git', args, gitOptions);
const gitText = (...args) => git(...args).toString('utf8');
const emit = line => process.stdout.write(line + '\n');

function canonicalManifest(line) {
  if (!line) return null;
  try {
    const doc = JSON.parse(line);
    if (doc.schema_version !== '1.0' || doc.entry !== 'dist/deploy-uemcp.mjs'
        || Object.keys(doc).sort().join(' ') !== manifestKeys
        || !Array.isArray(doc.source_inputs) || !doc.source_inputs.every(row => Object.keys(row).sort().join(' ') === 'path sha256')
        || !Array.isArray(doc.bundled_packages) || !doc.bundled_packages.every(row => Object.keys(row).sort().join(' ') === 'license name version')
        || canonicalJson(doc) !== line) return null;
    return doc;
  } catch {
    return null;
  }
}

// Compare public metadata as records. A new or changed digest qualifies for
// omission only if it is reproducible from the exact Git objects being sent.
function manifestRecords(doc, previous, revision) {
  const records = [];
  const paths = new Map([
    ['bundle_sha256', doc.entry], ['notices_sha256', 'dist/THIRD_PARTY_NOTICES.txt'],
    ['package_lock_sha256', 'server/package-lock.json'],
  ]);
  const previousSources = new Map((previous?.source_inputs ?? []).map(row => [row.path, row.sha256]));
  const checkDigest = (digest, prior, path) => {
    if (!/^[0-9a-f]{64}$/.test(digest) || typeof path !== 'string'
        || !/^[A-Za-z0-9_./-]+$/.test(path) || path.split('/').some(p => !p || p === '.' || p === '..')) {
      throw new Error('Unrecognized manifest input');
    }
    if (digest !== prior && sha256Bytes(git('cat-file', 'blob', revision + ':' + path)) !== digest) {
      throw new Error('Manifest digest differs from its Git input');
    }
  };
  for (const [key, value] of Object.entries(doc)) {
    if (key === 'source_inputs') {
      for (const { path, sha256, ...other } of value) {
        checkDigest(sha256, previousSources.get(path), path);
        records.push(canonicalJson({ [key]: { path, ...other } }));
      }
    } else if (key === 'bundled_packages') {
      records.push(...value.map(row => canonicalJson({ [key]: row })));
    } else if (paths.has(key)) {
      checkDigest(value, previous?.[key], paths.get(key));
    } else if (key === 'input_manifest_sha256') {
      const { source_inputs, package_lock_sha256, bundled_packages, notices_sha256 } = doc;
      if (value !== sha256Canonical({ source_inputs, package_lock_sha256, bundled_packages, notices_sha256 })) {
        throw new Error('Manifest aggregate differs from its inputs');
      }
    } else {
      records.push(canonicalJson({ [key]: value }));
    }
  }
  return records;
}

function scanManifest(removed, added, revision) {
  const next = added.length === 1 && canonicalManifest(added[0]);
  const prior = removed.length === 1 && canonicalManifest(removed[0]);
  if (next && (prior || removed.length === 0)) {
    try {
      if (gitText('cat-file', 'blob', revision + ':' + manifestPath) !== added[0] + '\n') {
        throw new Error('Expected a single canonical manifest record');
      }
      // Passing prior as its own baseline requires no historical file reads.
      const known = new Set(prior ? manifestRecords(prior, prior, revision) : []);
      const incoming = manifestRecords(next, prior, revision);
      for (const row of incoming) if (!known.has(row)) emit(row);
      return;
    } catch {
      // A noncanonical or unverifiable input receives ordinary text scanning.
    }
  }
  for (const line of added) emit(line);
}

function scanDiff(revisions, revision) {
  const args = ['-c', 'core.quotePath=false', 'diff', '--no-color', '--no-ext-diff', '--no-textconv',
    '--no-renames', '--ignore-submodules=none', '--src-prefix=a/', '--dst-prefix=b/', ...revisions];
  // With rename detection off, a renamed destination appears among additions.
  for (const path of gitText(...args, '--diff-filter=AT', '--name-only', '-z', '--').split('\0')) {
    if (path) emit(path);
  }
  const patch = gitText(...args, '--unified=0', '--');
  let inHunk = false, manifest = false;
  const removed = [], added = [];
  for (const line of patch.split('\n')) {
    if (line.startsWith('diff --git ')) {
      manifest = line === manifestHeader;
      inHunk = false;
    } else if (line.startsWith('@@ ')) {
      inHunk = true;
    } else if (inHunk && line.startsWith('+')) {
      if (manifest) added.push(line.slice(1));
      else emit(line.slice(1));
    } else if (manifest && inHunk && line.startsWith('-')) {
      removed.push(line.slice(1));
    }
  }
  if (added.length) scanManifest(removed, added, revision);
}

const [mode, ...range] = process.argv.slice(2);
if (mode === 'index') {
  scanDiff(['--cached'], '');
} else if (mode === 'history' && range.length) {
  const commits = gitText('rev-list', '--parents', ...range, '--').trim();
  if (commits) {
    emit(gitText('log', '--format=%B%n%an <%ae>%n%cn <%ce>', ...range, '--'));
    const emptyTree = execFileSync('git', ['hash-object', '-t', 'tree', '--stdin'], { ...gitOptions, input: '' }).toString().trim();
    for (const row of commits.split('\n')) {
      const [commit, parent = emptyTree] = row.split(' ');
      scanDiff([parent, commit], commit);
    }
  }
} else {
  throw new Error('Expected index or history with a Git revision range');
}
