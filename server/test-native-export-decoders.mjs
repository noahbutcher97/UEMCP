import { TestRunner } from './test-helpers.mjs';
import { nativeExportDecoders } from './native-export-decoders.mjs';
import { readExportProperties, makePackageIndexResolver } from './uasset-parser.mjs';

const t = new TestRunner('Bounded native RigVM links');
const imports = [
  { className: 'Package', classPackage: '/Script/CoreUObject', objectName: '/Script/RigVMDeveloper', outerIndex: 0 },
  { className: 'Class', classPackage: '/Script/CoreUObject', objectName: 'RigVMLink', outerIndex: -1 },
];
const summary = { fileVersionUE5: 1018, customVersions: [{ key: '9b9549dce74dc05388ea5691395d7c5e', version: 25 }] };
const opts = { imports, nativeExportDecoders, resolve: makePackageIndexResolver([], imports), summary };
function fstring(text) {
  const bytes = Buffer.from(text + '\0', 'utf16le');
  const size = Buffer.alloc(4);
  size.writeInt32LE(-bytes.length / 2);
  return Buffer.concat([size, bytes]);
}
function read(from, to, change = {}, options = opts) {
  const payload = Buffer.concat([fstring(from), fstring(to)]);
  const file = Buffer.concat([Buffer.alloc(8), payload, fstring('Neighbor')]);
  const entry = { classIndex: -2, serialOffset: 8, serialSize: payload.length, ...change };
  return readExportProperties(file, entry, [], options);
}
const ordered = read('Up.Ω', 'Down.B');
t.assert(ordered.terminated && ordered.properties.SourcePinPath === 'Up.Ω' && ordered.properties.TargetPinPath === 'Down.B', 'reads directed Unicode endpoints');
t.assert(read('', '').properties.SourcePinPath === '', 'empty endpoint is faithfully represented');
t.assert(!read('A', 'B', { serialSize: 13 }).terminated, 'a truncated export cannot borrow adjacent bytes');
t.assert(!read('A', 'B', { serialOffset: -1 }).terminated, 'rejects negative span');
t.assert(!read('A', 'B', { serialSize: 17 }).terminated, 'rejects extra serialized bytes');
t.assert(!read('A', 'B', {}, { ...opts, maxBytes: 1 }).terminated, 'respects generic byte budget');
t.assert(!read('A', 'B', {}, { ...opts, summary: { ...summary, fileVersionUE5: 9999 } }).terminated, 'unknown package layout refuses decoding');
t.assert(!read('A', 'B', {}, { ...opts, summary: { ...summary, customVersions: [] } }).terminated, 'missing RigVM version refuses decoding');
t.assert(!read('A', 'B', {}, { ...opts, summary: { ...summary,
  customVersions: [{ key: summary.customVersions[0].key, version: 99 }] } }).terminated,
  'a new RigVM custom version requires qualification even when the package version matches');
t.assert(!read('A', 'B', {}, { ...opts, summary: { ...summary, packageFlags: 0x200 } }).terminated, 'cooked package refuses editor graph interpretation');
t.assert(!read('A', 'B', {}, { ...opts, resolve: () => ({ packagePath: '/Script/Other.RigVMLink' }) }).properties.SourcePinPath, 'equal short class names remain independent');
process.exitCode = t.summary() === 0 ? 0 : 1;
