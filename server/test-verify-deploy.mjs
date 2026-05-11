// test-verify-deploy.mjs — unit tests for verify-deploy.mjs pure helpers.
// Run: node test-verify-deploy.mjs
//
// Covers the comparison + classification logic that drives the deploy-state
// verdict. Pure functions, no fs/network. Intentionally light — the bat
// wrappers + Node entry point are exercised via live-fire (§6 of handoff).

import {
  parseTargetsFile,
  classifyDeployState,
  formatAge,
  formatMarkerSyncTime,
  normalizePath,
  extractUprojectFromCommandLine,
  parseEditorProcessLines,
  applyMarkerVerdictOverlay,
} from './verify-deploy.mjs';

let passed = 0, failed = 0;
const eq = (actual, expected, label) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { passed++; }
  else { failed++; console.error(`FAIL [${label}]: expected ${e}, got ${a}`); }
};

// ─── parseTargetsFile ───────────────────────────────────────────────
eq(parseTargetsFile(''), [], 'empty file');
eq(parseTargetsFile('# comment only\n'), [], 'comment-only');
eq(parseTargetsFile('  \n\n# c\n  \n'), [], 'whitespace + comments');
eq(
  parseTargetsFile('D:/A/A.uproject\nD:/B/B.uproject\n'),
  ['D:/A/A.uproject', 'D:/B/B.uproject'],
  'two targets',
);
eq(
  parseTargetsFile('# header\nD:/A/A.uproject  # inline comment\n\nD:/B/B.uproject\n'),
  ['D:/A/A.uproject', 'D:/B/B.uproject'],
  'inline comments stripped',
);
eq(
  parseTargetsFile('D:/A/A.uproject\r\nD:/B/B.uproject\r\n'),
  ['D:/A/A.uproject', 'D:/B/B.uproject'],
  'CRLF line endings',
);

// ─── classifyDeployState ────────────────────────────────────────────
const repoSrc = 1000000;
const newer = repoSrc + 100, older = repoSrc - 100;

eq(
  classifyDeployState({ pluginDirExists: false, deployedSrcMtime: 0, deployedSrcFileCount: 0, dllExists: false, dllMtime: 0, repoSrcMtime: repoSrc }).verdict,
  'MISSING',
  'plugin dir absent',
);
eq(
  classifyDeployState({ pluginDirExists: true, deployedSrcMtime: 0, deployedSrcFileCount: 0, dllExists: false, dllMtime: 0, repoSrcMtime: repoSrc }).verdict,
  'MISSING-PARTIAL',
  'plugin dir empty source',
);
eq(
  classifyDeployState({ pluginDirExists: true, deployedSrcMtime: newer, deployedSrcFileCount: 5, dllExists: false, dllMtime: 0, repoSrcMtime: repoSrc }).verdict,
  'NEEDS-BUILD',
  'source synced, DLL missing',
);
eq(
  classifyDeployState({ pluginDirExists: true, deployedSrcMtime: older, deployedSrcFileCount: 5, dllExists: false, dllMtime: 0, repoSrcMtime: repoSrc }).verdict,
  'NEEDS-DEPLOY',
  'source stale + DLL missing',
);
eq(
  classifyDeployState({ pluginDirExists: true, deployedSrcMtime: older, deployedSrcFileCount: 5, dllExists: true, dllMtime: older, repoSrcMtime: repoSrc }).verdict,
  'NEEDS-DEPLOY',
  'both stale (D135 failure mode)',
);
eq(
  classifyDeployState({ pluginDirExists: true, deployedSrcMtime: older, deployedSrcFileCount: 5, dllExists: true, dllMtime: newer, repoSrcMtime: repoSrc }).verdict,
  'NEEDS-SYNC',
  'source stale, DLL fresh (rare; user built without sync)',
);
eq(
  classifyDeployState({ pluginDirExists: true, deployedSrcMtime: newer, deployedSrcFileCount: 5, dllExists: true, dllMtime: older, repoSrcMtime: repoSrc }).verdict,
  'NEEDS-BUILD',
  'source synced but DLL behind source — Build needed (sync ran, build did not)',
);
eq(
  classifyDeployState({ pluginDirExists: true, deployedSrcMtime: newer, deployedSrcFileCount: 5, dllExists: true, dllMtime: newer, repoSrcMtime: repoSrc }).verdict,
  'SYNC',
  'all fresh',
);
// Slop tolerance: deployedSrc 4 sec older than repoSrc should still be SYNC (within MTIME_SLOP_SEC=5)
eq(
  classifyDeployState({ pluginDirExists: true, deployedSrcMtime: repoSrc - 4, deployedSrcFileCount: 5, dllExists: true, dllMtime: repoSrc - 4, repoSrcMtime: repoSrc }).verdict,
  'SYNC',
  'within mtime slop tolerance',
);

// ─── formatAge ──────────────────────────────────────────────────────
eq(formatAge(0), '0s', 'zero seconds');
eq(formatAge(45), '45s', 'sub-minute');
eq(formatAge(125), '2m 5s', 'minutes');
eq(formatAge(3700), '1h 1m', 'hours');
eq(formatAge(90000), '1d 1h', 'days');
eq(formatAge(-30), '(30s ahead)', 'negative (DLL ahead of source)');

// ─── normalizePath (case-insensitive Windows path equality) ────────
eq(
  normalizePath('D:\\Foo\\Bar.uproject'),
  normalizePath('d:/foo/bar.uproject'),
  'backslash + case + slash equivalence',
);
eq(
  normalizePath('D:/Foo/Bar/'),
  normalizePath('D:/Foo/Bar'),
  'trailing slash stripped',
);

// ─── extractUprojectFromCommandLine ─────────────────────────────────
eq(
  extractUprojectFromCommandLine('"C:\\Program Files\\Epic Games\\UE_5.6\\Engine\\Binaries\\Win64\\UnrealEditor.exe" "D:\\Projects\\Foo\\Foo.uproject"'),
  'D:\\Projects\\Foo\\Foo.uproject',
  'quoted CommandLine',
);
eq(
  extractUprojectFromCommandLine('UnrealEditor.exe D:\\Projects\\Foo\\Foo.uproject -skipcompile'),
  'D:\\Projects\\Foo\\Foo.uproject',
  'unquoted CommandLine',
);
eq(
  extractUprojectFromCommandLine('UnrealEditor.exe -nothing-here'),
  null,
  'no .uproject token',
);
eq(extractUprojectFromCommandLine(null), null, 'null input');
eq(extractUprojectFromCommandLine(''), null, 'empty input');

// ─── parseEditorProcessLines ────────────────────────────────────────
eq(
  parseEditorProcessLines('1234|UnrealEditor.exe D:\\Projects\\Foo\\Foo.uproject -skipcompile\n'),
  [{
    pid: 1234,
    cmdLine: 'UnrealEditor.exe D:\\Projects\\Foo\\Foo.uproject -skipcompile',
    commandLineAvailable: true,
    uprojectPath: 'D:\\Projects\\Foo\\Foo.uproject',
  }],
  'parseEditorProcessLines: pid + command line',
);
eq(
  parseEditorProcessLines('5678|\n'),
  [{
    pid: 5678,
    cmdLine: '',
    commandLineAvailable: false,
    uprojectPath: null,
  }],
  'parseEditorProcessLines: fallback pid without command line',
);
eq(
  parseEditorProcessLines('not-a-pid|\n'),
  [],
  'parseEditorProcessLines: malformed pid ignored',
);

// ─── formatMarkerSyncTime ───────────────────────────────────────────
const epoch1 = formatMarkerSyncTime('2026-05-05T20:34:11.000Z');
// Locale-dependent output, but should not be the literal ISO string nor '(unknown)'.
if (epoch1 !== '(unknown)' && epoch1 !== '2026-05-05T20:34:11.000Z' && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(epoch1)) {
  passed++;
} else {
  failed++;
  console.error(`FAIL [formatMarkerSyncTime ISO]: got ${epoch1}`);
}
eq(formatMarkerSyncTime(null), '(unknown)', 'formatMarkerSyncTime null');
eq(formatMarkerSyncTime(''), '(unknown)', 'formatMarkerSyncTime empty');
eq(formatMarkerSyncTime('not-a-date'), 'not-a-date', 'formatMarkerSyncTime invalid → echo back');

// ─── applyMarkerVerdictOverlay (W-L marker integration / D138-FIX3) ──
const baseSync = { verdict: 'SYNC', reason: 'all fresh' };
const baseNeedsBuild = { verdict: 'NEEDS-BUILD', reason: 'DLL stale' };
const baseMissing = { verdict: 'MISSING', reason: 'no plugin dir' };
const incoming = {
  manifestVersion: '1.0.1',
  upluginVersion: 2,
  upluginVersionName: '1.0.1',
  sourceCommitSha: 'abc1234',
  headPluginCommitSha: 'def5678',
};

// 1. No incomingState → no-op (helper unavailable / repo unreadable).
eq(
  applyMarkerVerdictOverlay(baseSync, null, null, null, true, 5),
  baseSync,
  'overlay no-op when incomingState null',
);

// 2. Plugin dir absent → no-op (MISSING is more fundamental).
eq(
  applyMarkerVerdictOverlay(baseMissing, null, { reason: 'no-prior-marker', nukeRecommended: false }, incoming, false, 0),
  baseMissing,
  'overlay no-op when pluginDirExists=false',
);

// 3. Plugin dir empty → no-op (MISSING-PARTIAL takes precedence).
eq(
  applyMarkerVerdictOverlay(baseSync, null, { reason: 'no-prior-marker', nukeRecommended: false }, incoming, true, 0),
  baseSync,
  'overlay no-op when deployedSrcFileCount=0',
);

// 4. No marker + populated plugin dir → NEEDS-SYNC (seed marker prompt).
const r4 = applyMarkerVerdictOverlay(baseSync, null, { reason: 'no-prior-marker', nukeRecommended: false }, incoming, true, 5);
eq(r4.verdict, 'NEEDS-SYNC', 'no-marker overlay → NEEDS-SYNC verdict');
if (r4.reason && r4.reason.includes('No deploy marker')) passed++;
else { failed++; console.error(`FAIL [no-marker overlay reason]: got ${r4.reason}`); }

// 5. Marker version-match → base verdict prevails (SYNC).
eq(
  applyMarkerVerdictOverlay(baseSync, { manifestVersion: '1.0.1', upluginVersion: 2 }, { reason: 'version-match', nukeRecommended: false }, incoming, true, 5),
  baseSync,
  'version-match overlay → base SYNC prevails',
);

// 6. Marker version-match → NEEDS-BUILD prevails too.
eq(
  applyMarkerVerdictOverlay(baseNeedsBuild, { manifestVersion: '1.0.1', upluginVersion: 2 }, { reason: 'version-match', nukeRecommended: false }, incoming, true, 5),
  baseNeedsBuild,
  'version-match overlay → base NEEDS-BUILD prevails',
);

// 7. Marker version-changed → NEEDS-SYNC overrides SYNC.
const stalePrior = { manifestVersion: '1.0.0', upluginVersion: 1, upluginVersionName: '0.1.0' };
const r7 = applyMarkerVerdictOverlay(
  baseSync,
  stalePrior,
  { reason: 'version-changed', nukeRecommended: true, detail: { prior: stalePrior, incoming } },
  incoming,
  true, 5,
);
eq(r7.verdict, 'NEEDS-SYNC', 'version-changed overlay → NEEDS-SYNC verdict');
if (r7.reason && r7.reason.includes('Marker shows') && r7.reason.includes('1.0.0') && r7.reason.includes('1.0.1')) passed++;
else { failed++; console.error(`FAIL [version-changed overlay reason]: got ${r7.reason}`); }

// 8. Marker schema-version-changed → NEEDS-SYNC override (defense-in-depth).
const oldSchemaPrior = { schemaVersion: '0.9', manifestVersion: '1.0.1', upluginVersion: 2 };
const r8 = applyMarkerVerdictOverlay(
  baseSync,
  oldSchemaPrior,
  { reason: 'schema-version-changed', nukeRecommended: true, detail: { prior: oldSchemaPrior, incoming } },
  incoming,
  true, 5,
);
eq(r8.verdict, 'NEEDS-SYNC', 'schema-version-changed overlay → NEEDS-SYNC verdict');

// run-rotation.mjs primary format — each on its own line so it can be parsed
// from stdout per the regex at run-rotation.mjs:93-95.
console.log('');
console.log(`Passed: ${passed}`);
console.log(`Failed: ${failed}`);
console.log(`Total: ${passed + failed}`);
process.exit(failed === 0 ? 0 : 1);
