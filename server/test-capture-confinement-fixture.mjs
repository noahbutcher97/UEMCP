// Source guards plus Windows path-arithmetic regressions for the native fixture.
// This does not execute FPaths or prove native capture confinement; the corrected
// OutputPathConfinement automation test remains the required native witness.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, win32 as path } from 'node:path';
import { REPO_ROOT, TestRunner } from './test-helpers.mjs';

const t = new TestRunner('Capture confinement fixture');
function check(name, fn) {
  try { fn(); t.assert(true, name); }
  catch (error) { t.assert(false, name, error.stack); }
}
const native = readFileSync(join(REPO_ROOT,
  'plugin/UEMCP/Source/UEMCP/Private/Tests/UEMCPAssetEditorCaptureTests.cpp'), 'utf8');
const body = native.slice(native.indexOf('bool FUEMCPAssetEditorCaptureOutputPathTest::RunTest'),
  native.indexOf('// AppendInlinePng', native.indexOf('bool FUEMCPAssetEditorCaptureOutputPathTest::RunTest')));
const resolverSource = readFileSync(join(REPO_ROOT,
  'plugin/UEMCP/Source/UEMCP/Private/AssetEditorCapture.cpp'), 'utf8');
const resolver = resolverSource.slice(resolverSource.indexOf('bool ResolveCaptureOutputPath('),
  resolverSource.indexOf('bool CaptureWidgetToPng('));
check('native escape derives from project parent and the actual Saved capture base', () => {
  assert.ok(body.includes('FPaths::GetPath(ProjectRoot) / TEXT("escape.png")'));
  assert.ok(body.includes('FPaths::Combine(FPaths::ProjectSavedDir(), TEXT("UEMCP"), TEXT("Captures"))) + TEXT("/")'));
  assert.ok(body.includes('FPaths::MakePathRelativeTo(EscapingRelative, *CaptureBase)'));
  assert.ok(!body.includes('../../../../escape'));
});
check('native fixture validates relative round trip and outside boundary before dispatch', () => {
  assert.ok(body.includes('FPaths::IsRelative(EscapingRelative)'));
  assert.ok(body.includes('ResolvedEscape, Outside'));
  assert.ok(body.includes('ResolvedEscape.StartsWith(ProjectRoot + TEXT("/"), ESearchCase::IgnoreCase)'));
  assert.ok(body.indexOf('escape fixture is outside the project boundary') < body.indexOf('UEMCP::ResolveCaptureOutputPath(EscapingRelative'));
  assert.ok(body.includes('Capture path fixture: project=%s base=%s relative=%s outside=%s'));
});
check('resolver and all three dispatch checks use the verified relative escape', () => {
  assert.ok(body.includes('UEMCP::ResolveCaptureOutputPath(EscapingRelative, TEXT("Stem"), Abs, Err)'));
  assert.equal((body.match(/SetStringField\(TEXT\("out_png"\), EscapingRelative\)/g) || []).length, 2);
  assert.equal((body.match(/SetStringField\(TEXT\("output_path"\), EscapingRelative\)/g) || []).length, 1);
  assert.equal((body.match(/FString\(TEXT\("CAPTURE_PATH_OUTSIDE_PROJECT"\)\)/g) || []).length, 3);
});
check('native boundaries retain outside absolute rejection and allow normalized inside traversal', () => {
  for (const token of ['ResolveCaptureOutputPath(Outside,', 'ResolveCaptureOutputPath(PrefixSibling,',
    'ResolveCaptureOutputPath(EngineSide,', 'ResolveCaptureOutputPath(Inside,', 'TEXT("review/../shot")',
    'TEXT("/UEMCP/Captures/shot.png")']) assert.ok(body.includes(token), token);
});
check('production resolver still collapses traversal and requires a directory-delimited project prefix', () => {
  assert.ok(resolver.includes('FPaths::CollapseRelativeDirectories(Full)'));
  assert.ok(resolver.includes('ProjectRoot += TEXT("/")'));
  assert.ok(resolver.includes('!Full.StartsWith(ProjectRoot, ESearchCase::IgnoreCase)'));
  assert.ok(resolver.includes('resolves outside the project directory'));
  assert.ok(resolver.indexOf('return false;') < resolver.indexOf('OutAbsolutePath = Full'));
});

const project = 'D:\\Owned\\Host';
// Independent Windows path oracle; never writes to any of these locations.
const inside = (root, candidate) => path.resolve(candidate).toLowerCase().startsWith(path.resolve(root).toLowerCase() + '\\');
for (const [name, saved] of [
  ['ordinary Saved', path.join(project, 'Saved')],
  ['isolated runtime Saved', path.join(project, 'Saved', 'runtime-owned', 'User', 'Saved')],
  ['deeper custom Saved', path.join(project, 'Saved', 'a', 'b', 'c', 'd', 'User', 'Saved')],
]) {
  const base = path.join(saved, 'UEMCP', 'Captures');
  const outside = path.join(path.dirname(project), 'escape.png');
  check(`${name}: computed relative escape reaches the explicit outside target`, () => {
    const request = path.relative(base, outside);
    assert.equal(path.isAbsolute(request), false);
    assert.equal(path.resolve(base, request), outside);
    assert.equal(inside(project, path.resolve(base, request)), false);
  });
  check(`${name}: normalized parent traversal within capture directory is allowed`, () => {
    const resolved = path.resolve(base, 'review/../shot.png');
    assert.equal(resolved, path.join(base, 'shot.png'));
    assert.equal(inside(project, resolved), true);
  });
}
check('regression: four parents escape ordinary Saved but stay inside isolated runtime Saved', () => {
  assert.equal(inside(project, path.resolve(project, 'Saved/UEMCP/Captures', '../../../../escape.png')), false);
  assert.equal(path.resolve(project, 'Saved/runtime-owned/User/Saved/UEMCP/Captures', '../../../../escape.png'),
    path.join(project, 'Saved/runtime-owned/escape.png'));
  assert.equal(inside(project, path.resolve(project, 'Saved/runtime-owned/User/Saved/UEMCP/Captures', '../../../../escape.png')), true);
});
check('directory boundary rejects project-prefix sibling and parent absolute paths', () => {
  const sibling = project + '_Outside\\escape.png';
  assert.equal(sibling.startsWith(project), true, 'plain string prefix would falsely accept');
  assert.equal(inside(project, sibling), false);
  assert.equal(inside(project, path.join(path.dirname(project), 'escape.png')), false);
  assert.equal(inside(project, path.join(project, 'Saved', 'ok.PNG')), true);
});
process.exit(t.summary());
