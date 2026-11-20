import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { classifyEditorEnsures } from './editor-diagnostics.mjs';

const version = { MajorVersion: 5, MinorVersion: 3, PatchVersion: 2, Changelist: 29314046,
  IsLicenseeVersion: 0, IsPromotedBuild: 1, BranchName: '++UE5+Release-5.3' };
const pre = 'Log file open, fixture\n';
const pair = '[2026.11.19-21.10.41:201][  0]LogOutputDevice: Error: === Handled ensure: ===\n' +
  '[2026.11.19-21.10.41:201][  0]LogOutputDevice: Error: \n' +
  '[2026.11.19-21.10.41:201][  0]LogOutputDevice: Error: Ensure condition failed: SwapChain4.GetReference()  ' +
  '[File:D:\\build\\++UE5\\Sync\\Engine\\Source\\Runtime\\D3D12RHI\\Private\\Windows\\WindowsD3D12Viewport.cpp] [Line: 473] \n';
const init = '[time][  0]LogLoad: (Engine Initialization) Total time: 7.14 seconds\n';
const end = '[time][  1]LogExit: Exiting.\n[time][  1]Log file closed, fixture\n';
const classify = (log) => classifyEditorEnsures(log, version);
assert.equal(classify(pre + pair + init + end).passed, true);
assert.equal(classify(pre + init + end).passed, true);
for (const [label, log] of Object.entries({
  absent: '', truncated: pre + pair + init, missingOpen: pair + init + end,
  missingInit: pre + pair + end, missingExit: pre + pair + init + 'Log file closed, fixture',
  late: pre + init + pair + end, nonzeroFrame: pre + pair.replaceAll('[  0]', '[  1]') + init + end,
  duplicate: pre + pair + pair + init + end,
  unpaired: pre + pair.split('\n').slice(1).join('\n') + init + end,
  distant: pre + pair.replace('Error: \n', 'Error: \nnoise\nnoise\nnoise\n') + init + end,
  mismatchedTimestamp: pre + pair.replace('201][  0]LogOutputDevice: Error: ===', '202][  0]LogOutputDevice: Error: ===') + init + end,
  unknown: pre + pair.replace('SwapChain4.GetReference()', 'UnexpectedFailure()') + init + end,
  orphan: pre + pair.split('\n')[0] + '\n' + init + end,
})) assert.equal(classify(log).passed, false, label);
const repeated = classify(pre + pair + pair + init + end);
assert.equal(repeated.conditionCount, 2);
assert.equal(repeated.handledEnsureBanners, 2);
assert.equal(repeated.knownCount, 1);
assert.equal(repeated.unexpectedCount, 1);
assert.equal(repeated.unmatchedBannerCount, 0);
assert.equal(classifyEditorEnsures(pre + pair + init + end, { ...version, Changelist: 1 }).passed, false);
let checked = 0;
for (const root of process.argv.slice(2)) {
  for (const name of readdirSync(root).filter((n) => /^(final|qualified)(53|56|58)(_reload)?-editor\.log$/.test(n))) {
    const engine = name.includes('53') ? version : { MajorVersion: 5, MinorVersion: name.includes('56') ? 6 : 8 };
    const result = classifyEditorEnsures(readFileSync(root + '/' + name, 'utf8'), engine);
    assert.equal(result.passed, true, name);
    assert.equal(result.knownCount, name.includes('53') ? 1 : 0, name);
    assert.equal(result.conditionCount, result.knownCount, name);
    console.error(name + ': known=' + result.knownCount + ' unexpected=' + result.unexpectedCount);
    checked++;
  }
}
console.error('PASS synthetic boundary/pair/startup/repetition controls; replayed ' + checked + ' primary logs');
