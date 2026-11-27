// Explicit, engine-free readback of a previously exported editor inspection.
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, realpath, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';

const kinds = new Map([['rigvm', 'get_rigvm_graph'], ['chooser', 'get_chooser_table']]);
const maxSourceBytes = 64 * 1024 * 1024;
const maxSnapshotBytes = 8 * 1024 * 1024;
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

async function plainDirectory(parent, part, create) {
  const dir = join(parent, part);
  if (create) {
    try { await mkdir(dir); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  const entry = await lstat(dir);
  if (entry.isSymbolicLink() || !entry.isDirectory()) throw new Error('Inspection requires ordinary project directories');
  return dir;
}

async function locations(projectRoot, { asset_path: assetPath, kind }, create = false) {
  if (!projectRoot || !kinds.has(kind)) throw new Error('Attach a project and choose inspection kind rigvm or chooser');
  if (typeof assetPath !== 'string' || assetPath.length > 512 || !/^\/Game\/(?:[\p{L}\p{N}_-]+\/)*[\p{L}\p{N}_-]+$/u.test(assetPath)) {
    throw new Error('Supply the exact /Game package name without an extension or object suffix');
  }
  const parts = assetPath.slice(6).split('/');
  const root = await realpath(projectRoot);
  const name = parts.pop();
  let content = await plainDirectory(root, 'Content', false);
  for (const part of parts) content = await plainDirectory(content, part, false);
  const source = join(content, name + '.uasset');
  let directory = root;
  for (const part of ['Saved', 'UEMCP', 'Inspections']) directory = await plainDirectory(directory, part, create);
  return { source, snapshot: join(directory, sha256(kind + '\n' + assetPath) + '.json') };
}

async function readBounded(path, maxBytes) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes) throw new Error('Inspection requires a bounded ordinary file');
  const handle = await open(path, 'r');
  try {
    const current = await handle.stat();
    if (stat.ino !== current.ino || stat.dev !== current.dev || stat.size !== current.size) throw new Error('Inspection file changed while opening');
    const bytes = Buffer.alloc(current.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) throw new Error('Inspection file changed while reading');
      offset += bytesRead;
    }
    const after = await handle.stat();
    if (after.size !== current.size || after.mtimeMs !== current.mtimeMs) throw new Error('Inspection file changed while reading');
    return bytes;
  } finally { await handle.close(); }
}

function validPayload(data, args) {
  return data?.schema_version === 1 && data.asset_path === args.asset_path && data.dirty === false &&
    data.saved_source_verified === true && typeof data.engine_version === 'string' &&
    typeof data.complete === 'boolean' && Array.isArray(data.issues) &&
    (args.kind === 'rigvm' ? Array.isArray(data.graphs) : Array.isArray(data.columns) && Array.isArray(data.rows) && Object.hasOwn(data, 'fallback'));
}

export async function exportInspection(projectRoot, args, inspect, checkAttachment) {
  const { source, snapshot } = await locations(projectRoot, args, true);
  const original = sha256(await readBounded(source, maxSourceBytes));
  const reply = await inspect(kinds.get(args.kind), { asset_path: args.asset_path, verify_saved_source: true });
  const data = reply?.result;
  if (data?.dirty) throw new Error('The asset has unsaved edits. Save explicitly before exporting its inspection.');
  if (!validPayload(data, args)) throw new Error(reply?.message || 'The live inspection could not verify the loaded package against the saved bytes and supported schema. Reopen the saved asset or check its format.');
  const receipt = { schema_version: 1, kind: args.kind, source_sha256: original, payload_sha256: sha256(JSON.stringify(data)), inspection: data };
  const bytes = JSON.stringify(receipt);
  if (Buffer.byteLength(bytes) > maxSnapshotBytes) throw new Error('Inspection exceeds the snapshot size limit');
  const tmp = snapshot + '.' + randomUUID() + '.tmp';
  const handle = await open(tmp, 'wx');
  try {
    try { await handle.writeFile(bytes); } finally { await handle.close(); }
    if (original !== sha256(await readBounded(source, maxSourceBytes))) throw new Error('Source package changed during export');
    checkAttachment();
    await rename(tmp, snapshot);
  } catch (error) { await unlink(tmp).catch(cleanup => { error.cleanupError = cleanup; }); throw error; }
  return { asset_path: args.asset_path, kind: args.kind, schema_version: 1, origin: 'saved_editor_snapshot', source_sha256: original, complete: data.complete };
}

export async function readSavedInspection(projectRoot, args) {
  let files, raw;
  try {
    files = await locations(projectRoot, args);
    raw = await readBounded(files.snapshot, maxSnapshotBytes);
  } catch (error) {
    if (error.code === 'ENOENT') throw new Error('No saved inspection exists at the requested project path. Use export_asset_inspection in the attached editor.');
    throw error;
  }
  const saved = JSON.parse(raw.toString('utf8'));
  if (saved.schema_version !== 1 || saved.kind !== args.kind || !validPayload(saved.inspection, args) ||
      sha256(JSON.stringify(saved.inspection)) !== saved.payload_sha256) throw new Error('Invalid or unsupported inspection snapshot. Export again.');
  if (sha256(await readBounded(files.source, maxSourceBytes)) !== saved.source_sha256) {
    throw new Error('Stale inspection snapshot. The source package changed. Export again.');
  }
  return { ...saved.inspection, origin: 'saved_editor_snapshot', source_sha256: saved.source_sha256 };
}
