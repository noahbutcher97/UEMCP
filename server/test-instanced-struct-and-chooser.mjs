import { readFileSync } from 'node:fs';
import { parsePropertyReadBuffer } from './offline-core.mjs';
import { Cursor, readExportProperties, readPropertyTag } from './uasset-parser.mjs';
import { assembleRawChooser } from './raw-chooser-inspection.mjs';
import { TestRunner } from './test-helpers.mjs';

// Owned UE 5.9 Preview 2 packages, saved by UChooserFixtureLibrary. The engine
// evaluator separately observed Idle, Run and the fallback on the disabled row.
const t = new TestRunner('Saved instanced structs and Chooser rows');
const load = name => readFileSync(new URL('./fixtures/serialization/ue5.9-chooser-v1/Content/ChooserFixture/' + name + '.uasset', import.meta.url));
const da = load('DA_Instances');
const parseAsset = buf => {
  const ctx = parsePropertyReadBuffer(buf);
  return readExportProperties(buf, ctx.exports.find(e => e.bIsAsset), ctx.names, ctx);
};
const parsed = parseAsset(da);
t.assert(parsed.properties.Value.value.FilePath === 'Authoring/Inside.txt', 'standalone FFilePath reads its saved member');
const values = parsed.properties.Values;
t.assert(values[0].value.Path === 'Authoring/Start', 'array decodes a distinct FDirectoryPath');
t.assert(values[1].type === '/Script/UEMCPFixture.UEMCPFixturePayload', 'unknown type reports qualified identity');
t.assert(parsed.unsupported[0]?.field_path === 'Values[1]', 'generic partial points to the exact element');
t.assert(values[2].type === null, 'empty element keeps its slot');
t.assert(values[3].value.FilePath === 'Authoring/After.txt', 'reader resumes at the independently bounded following instance');

const corrupt = Buffer.from(da);
const ctx = parsePropertyReadBuffer(corrupt);
const root = ctx.exports.find(e => e.bIsAsset);
const cur = new Cursor(corrupt);
cur.seek(root.serialOffset + (root.scriptSerializationStartOffset || 0));
cur.readUInt8();
while (cur.remaining()) {
  const tag = readPropertyTag(cur, ctx.names, ctx);
  if (tag.terminator) throw new Error('Missing fixture Values property');
  if (tag.name === 'Values') {
    cur.readInt32(); // element count
    cur.readInt32(); // first type
    cur.skip(cur.readInt32());
    cur.readInt32(); // second type
    corrupt.writeInt32LE(tag.size + 1, cur.tell());
    break;
  }
  cur.skip(tag.size);
}
const broken = parseAsset(corrupt);
t.assert(broken.properties.Values.unsupported === true, 'broken middle size rejects the array');
t.assert(broken.properties.Value.value.FilePath === 'Authoring/Inside.txt', 'neighboring standalone field survives');
const shadow = parsePropertyReadBuffer(da);
const fp = shadow.imports.find(i => i.objectName === 'FilePath');
fp.outerIndex = -1 - shadow.imports.findIndex(i => i.objectName === '/Script/UEMCPFixture');
const other = readExportProperties(da, root, shadow.names, shadow);
t.assert(other.properties.Value.type === '/Script/UEMCPFixture.FilePath', 'same short name keeps its module identity');
t.assert(other.properties.Value.unsupported === true, 'unregistered namesake cannot select the CoreUObject decoder');

const table = parsePropertyReadBuffer(load('CT_Selection'));
const args = { asset_path: '/Game/ChooserFixture/CT_Selection' };
const view = assembleRawChooser(table, args);
t.assert(view.complete === true, 'entire supported row mapping decoded');
t.assert(view.columns[0].property_chain[0] === 'Key', 'nested typed context binding decoded');
t.assert(view.columns[0].on_unresolved_input === 'pass_all_rows', 'unresolved context retains engine policy');
t.assert(view.rows[0].result.asset_path === '/Game/ChooserFixture/Idle.Idle', 'hard result path');
t.assert(view.rows[1].result.asset_path === '/Game/ChooserFixture/Run.Run', 'soft result path via header table');
t.assert(view.rows[2].disabled === true, 'disabled row retains its authored index');
t.assert(view.fallback.asset_path === '/Game/ChooserFixture/Fallback.Fallback', 'fallback resolves independently');
for (const flags of [0x200, 0x2000, 0x80000000]) {
  const stripped = { ...table, summary: { ...table.summary, packageFlags: flags } };
  await t.assertRejects(() => assembleRawChooser(stripped, args), /supported editor package/, 'unsupported package flags ' + flags);
}
for (const key of ['86181d60844f64acded316aad6c7ea0d', 'aa1c1ee25e4247afd46abf89bba8444c']) {
  const customVersions = table.summary.customVersions.map(row => row.key === key ? { ...row, version: row.version + 1 } : row);
  const future = { ...table, summary: { ...table.summary, customVersions } };
  await t.assertRejects(() => assembleRawChooser(future, args), /supported editor package/, 'unknown future custom version ' + key);
}
process.exit(t.summary() === 0 ? 0 : 1);
