import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { parsePropertyReadBuffer } from './offline-core.mjs';
import { executeOfflineTool } from './offline-tools.mjs';
import { inspectRawRigVM } from './rigvm-package.mjs';
import { Cursor, readPropertyTag } from './uasset-parser.mjs';
import { TestRunner } from './test-helpers.mjs';

const t = new TestRunner('Raw package RigVM model and generic export inspection');
const fixture = new URL('./fixtures/serialization/ue5.9-rigvm-v1/', import.meta.url);
const bytes = await readFile(new URL('Content/RigChecks/CR_SavedRig.uasset', fixture));
const expected = JSON.parse(await readFile(new URL('oracle.json', fixture), 'utf8'));
const args = { asset_path: '/Game/RigChecks/CR_SavedRig' };
const ctx = parsePropertyReadBuffer(bytes);
const actual = inspectRawRigVM(ctx, args);
const normalized = actual.graphs.map(({path, nodes, links}) => ({
  path, nodes: nodes.map(({name, pins}) => ({name, pins: pins.map(p => ({...p, direction: p.direction.toUpperCase()}))})), links,
}));
t.assert(createHash('sha256').update(bytes).digest('hex') === expected.source_sha256, 'saved fixture matches editor oracle digest');
t.assert(actual.complete && !actual.issues.length, 'raw rig is complete');
t.assert(JSON.stringify(normalized) === JSON.stringify(expected.graphs), 'root, library, nested graph and duplicate local node names match independent Unreal observations');
const nested = ctx.exports.find(e => e.objectName === 'Nested_ContainedGraph');
const nestedIndex = ctx.exports.indexOf(nested) + 1;
const linkIndex = ctx.exports.findIndex(e => e.outerIndex === nestedIndex &&
  ctx.resolve(e.classIndex)?.packagePath === '/Script/RigVMDeveloper.RigVMLink') + 1;
const generic = await executeOfflineTool('read_asset_properties', { ...args, export_index: linkIndex }, fileURLToPath(fixture));
t.assert(generic.properties.SourcePinPath === 'Upstream.Result' && generic.properties.TargetPinPath === 'Inner.A',
  'generic property reader decodes the same nested link from the selected export');

// A link and a node can have the same graph outer. Membership also requires the right class.
const incorrect = Buffer.from(bytes);
const c = new Cursor(incorrect);
c.seek(nested.serialOffset + nested.scriptSerializationStartOffset);
c.readUInt8();
for (;;) {
  const tag = readPropertyTag(c, ctx.names, ctx);
  if (tag.terminator) throw new Error('Fixture is missing Nodes');
  if (tag.name === 'Nodes') {
    if (c.readInt32() <= 0) throw new Error('Fixture has empty Nodes');
    incorrect.writeInt32LE(linkIndex, c.tell());
    break;
  }
  c.skip(tag.size);
}
const bad = inspectRawRigVM(parsePropertyReadBuffer(incorrect), args);
t.assert(!bad.complete && bad.issues.some(issue => issue.includes('unsupported node class /Script/RigVMDeveloper.RigVMLink')),
  'incorrect node member retains a precise partial-result diagnostic');
const unresolved = Buffer.from(bytes);
unresolved[ctx.exports[linkIndex - 1].serialOffset + 4] = 'X'.charCodeAt(0);
const dangling = inspectRawRigVM(parsePropertyReadBuffer(unresolved), args);
t.assert(!dangling.complete && dangling.issues.some(issue => issue.includes('unresolved link')), 'an unresolved endpoint is explicit');
let error;
try { inspectRawRigVM(ctx, { ...args, max_pins: 2 }); } catch (err) { error = err; }
t.assert(error?.code === 'RIGVM_INSPECTION_LIMIT', 'a small pin budget refuses oversize graphs');
process.exitCode = t.summary() === 0 ? 0 : 1;
