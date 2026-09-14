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
  buildJsonReport,
  buildJsonErrorReport,
  selectionErrorMessage,
  exitCodeForResults,
} from './verify-deploy.mjs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

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

// ─── Assertion helpers shared by the reason, JSON and CLI checks ─────
const includesStr = (str, substr, label) => {
  if (typeof str === 'string' && str.includes(substr)) { passed++; }
  else { failed++; console.error(`FAIL [${label}]: expected to contain "${substr}", got ${JSON.stringify(str)}`); }
};
const assertOk = (cond, label) => {
  if (cond) { passed++; }
  else { failed++; console.error(`FAIL [${label}]: expected truthy`); }
};

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

// ─── Content-based verdicts (EN-27) ─────────────────────────────────
// The whole point: a deployment whose bytes match the repo is not stale, no
// matter what a merge or checkout did to the repo's file mtimes.
const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const secToMs = (s) => s * 1000;
const built = (over) => ({
  pluginDirExists: true,
  deployedSrcFileCount: 5,
  dllExists: true,
  deployedSrcMtime: repoSrc,
  dllMtime: repoSrc,
  repoSrcMtime: repoSrc,
  repoSourceHash: HASH_A,
  deployedSourceHash: HASH_A,
  ...over,
});

const c1 = classifyDeployState(built({ markerSyncedAtMs: secToMs(older), dllMtime: newer }));
eq(c1.verdict, 'SYNC', 'content identical + DLL after last sync → SYNC');
includesStr(c1.reason, 'content-identical', 'content-identical SYNC reason says so');
eq(c1.contentIdentical, true, 'content-identical SYNC carries contentIdentical true');

const c2 = classifyDeployState(built({ markerSyncedAtMs: secToMs(newer), dllMtime: older }));
eq(c2.verdict, 'NEEDS-BUILD', 'content identical + DLL before last sync → NEEDS-BUILD');
includesStr(c2.reason, 'predates the last sync', 'content-identical NEEDS-BUILD reason says so');

eq(
  classifyDeployState(built({ markerSyncedAtMs: null, deployedSrcMtime: older, dllMtime: newer })).verdict,
  'SYNC',
  'no marker time → deployed source mtime is the sync reference (DLL newer → SYNC)',
);
eq(
  classifyDeployState(built({ markerSyncedAtMs: null, deployedSrcMtime: newer, dllMtime: older })).verdict,
  'NEEDS-BUILD',
  'no marker time → deployed source mtime is the sync reference (DLL older → NEEDS-BUILD)',
);

// The EN-27 shape itself: a merge rewrote repo source, so repoSrcMtime jumped
// ahead of both the deployed source and the DLL, but nothing actually changed.
const en27 = {
  pluginDirExists: true, deployedSrcFileCount: 5, dllExists: true,
  deployedSrcMtime: older, dllMtime: older + 10, repoSrcMtime: repoSrc + 5000,
  markerSyncedAtMs: secToMs(older),
};
eq(
  classifyDeployState({ ...en27, repoSourceHash: HASH_A, deployedSourceHash: HASH_A }).verdict,
  'SYNC',
  'EN-27: touched repo source with identical content still reads SYNC',
);
eq(
  classifyDeployState(en27).verdict,
  'NEEDS-DEPLOY',
  'EN-27: the same inputs without hashes still read NEEDS-DEPLOY (the mtime fallback)',
);

// A marker whose recorded hash no longer matches the disk describes a
// different sync, so its timestamp must not be trusted.
eq(
  classifyDeployState(built({
    markerSyncedAtMs: secToMs(older - 100), markerSourceHash: HASH_A,
    deployedSrcMtime: newer, dllMtime: older,
  })).verdict,
  'SYNC',
  'marker hash matches the disk → the marker time is used',
);
eq(
  classifyDeployState(built({
    markerSyncedAtMs: secToMs(older - 100), markerSourceHash: HASH_B,
    deployedSrcMtime: newer, dllMtime: older,
  })).verdict,
  'NEEDS-BUILD',
  'marker hash does not match the disk → the marker time is ignored',
);

// Never-built targets keep the pre-content rules (design §3.3): content
// identity cannot make a missing DLL fresh.
eq(
  classifyDeployState(built({ dllExists: false, dllMtime: 0, deployedSrcMtime: older })).verdict,
  'NEEDS-DEPLOY',
  'content identical + no DLL + stale deployed mtime → never-built rules unchanged',
);
eq(
  classifyDeployState(built({ dllExists: false, dllMtime: 0, deployedSrcMtime: newer })).verdict,
  'NEEDS-BUILD',
  'content identical + no DLL + fresh deployed mtime → never-built rules unchanged',
);

// Differing or absent hashes leave the mtime rules exactly as they were.
const differ = classifyDeployState(built({ deployedSourceHash: HASH_B, deployedSrcMtime: newer, dllMtime: newer }));
eq(differ.verdict, 'SYNC', 'hashes differ → mtime rules decide (all fresh → SYNC)');
eq(differ.contentIdentical, false, 'hashes differ → contentIdentical false');
const differStale = classifyDeployState(built({ deployedSourceHash: HASH_B, deployedSrcMtime: older, dllMtime: older }));
eq(differStale.verdict, 'NEEDS-DEPLOY', 'hashes differ + both stale → NEEDS-DEPLOY');
includesStr(differStale.reason, 'DLL predates HEAD source', 'the mtime NEEDS-DEPLOY reason is unchanged');
const noHash = classifyDeployState(built({ repoSourceHash: null, deployedSourceHash: null, deployedSrcMtime: newer, dllMtime: newer }));
eq(noHash.contentIdentical, null, 'no hashes → contentIdentical null');
eq(noHash.verdict, 'SYNC', 'no hashes → mtime rules decide, unchanged');

// The structural verdicts still win: content rules never precede them.
const missing = classifyDeployState(built({ pluginDirExists: false }));
eq(missing.verdict, 'MISSING', 'MISSING still wins over the content rule');
eq(
  Object.prototype.hasOwnProperty.call(missing, 'contentIdentical'),
  true,
  'every verdict object carries a contentIdentical key',
);

// The marker overlay replaces the verdict object; it must not drop the field.
const baseIdentical = { verdict: 'SYNC', reason: 'content-identical to repo; DLL built after the last sync', contentIdentical: true };
eq(
  applyMarkerVerdictOverlay(baseIdentical, null, { reason: 'no-prior-marker', nukeRecommended: false }, incoming, true, 5).contentIdentical,
  true,
  'no-marker overlay preserves contentIdentical',
);
eq(
  applyMarkerVerdictOverlay(
    baseIdentical, stalePrior,
    { reason: 'version-changed', nukeRecommended: true, detail: { prior: stalePrior, incoming } },
    incoming, true, 5,
  ).contentIdentical,
  true,
  'version-changed overlay preserves contentIdentical',
);

// ─── The JSON contract the pre-push gate consumes (EN-26) ───────────
const sampleTargets = [
  {
    uprojectPath: 'path/to/YourProject.uproject', alias: 'primary', dllExists: true,
    matchedEditors: [{ pid: 42 }], mcpPointsHere: true,
    verdict: { verdict: 'SYNC', reason: 'content-identical to repo; DLL built after the last sync', contentIdentical: true },
  },
  {
    uprojectPath: 'path/to/SecondProject.uproject', alias: null, dllExists: false,
    matchedEditors: [], mcpPointsHere: false,
    verdict: { verdict: 'NEEDS-BUILD', reason: 'Source synced but DLL not built', contentIdentical: null },
  },
];
const report = buildJsonReport(sampleTargets, { profile: 'smoke', exitCode: 1 });
eq(report.version, 1, 'report carries the schema version');
eq(report.profile, 'smoke', 'report carries the profile name');
eq(report.exitCode, 1, 'report carries the exit code');
eq(report.targets.length, 2, 'report carries one row per target');
eq(
  Object.keys(report.targets[0]),
  ['uprojectPath', 'alias', 'verdict', 'reason', 'contentIdentical', 'dllExists', 'editors', 'mcpPointsHere'],
  'a target row has exactly the contract keys',
);
eq(
  [report.targets[0].verdict, report.targets[0].reason, report.targets[0].contentIdentical],
  ['SYNC', 'content-identical to repo; DLL built after the last sync', true],
  'row 0 verdict, reason and contentIdentical',
);
eq(
  [report.targets[0].dllExists, report.targets[0].editors, report.targets[0].mcpPointsHere],
  [true, [42], true],
  'row 0 dllExists, editor pids and mcpPointsHere',
);
eq(
  [report.targets[1].alias, report.targets[1].dllExists, report.targets[1].editors],
  [null, false, []],
  'row 1 null alias, no DLL, no editors',
);
eq(report.targets[1].contentIdentical, null, 'an unknown content verdict serialises as null');
eq(
  buildJsonReport([], {}),
  { version: 1, profile: null, targets: [], warnings: [], exitCode: 0 },
  'an empty report has a null profile, no warnings and exit 0',
);
assertOk(
  report.targets.every((row) => Object.values(row).every((v) => v !== undefined)),
  'no target row field is undefined — an undefined would vanish from the serialised document',
);
eq(
  [buildJsonReport([], {}).warnings, buildJsonReport([], { warnings: ['primary: Marker comparison disabled: boom'] }).warnings],
  [[], ['primary: Marker comparison disabled: boom']],
  'warnings defaults to an empty array and echoes a supplied warning',
);

eq(buildJsonErrorReport('boom'), { version: 1, error: 'boom', exitCode: 2 }, 'the error document shape');
eq(buildJsonErrorReport(new Error('bad')).error, 'Error: bad', 'a non-string message is coerced');

eq(exitCodeForResults([{ verdict: { verdict: 'SYNC' } }, { verdict: { verdict: 'SYNC' } }]), 0, 'all SYNC → exit 0');
eq(exitCodeForResults([{ verdict: { verdict: 'SYNC' } }, { verdict: { verdict: 'NEEDS-BUILD' } }]), 1, 'any non-SYNC → exit 1');

includesStr(
  selectionErrorMessage({ status: 'absent', targetsPath: 'path/to/.uemcp-targets.json', candidates: [] }),
  'Targets file not found',
  'selectionErrorMessage: absent targets file',
);
includesStr(
  selectionErrorMessage({ status: 'profile_not_found', targetsPath: 'x', candidates: [], profile: { name: 'nope', availableProfiles: ['default', 'smoke'] } }),
  'nope',
  'selectionErrorMessage: unknown profile names it',
);
includesStr(
  selectionErrorMessage({ status: 'valid', targetsPath: 'x', candidates: [] }),
  'No targets selected',
  'selectionErrorMessage: valid config selecting nothing',
);
includesStr(
  selectionErrorMessage({ status: 'invalid_config', targetsPath: 'x', candidates: [] }),
  'Invalid targets config',
  'selectionErrorMessage: invalid config',
);

// ─── The CLI actually emits those documents ─────────────────────────
// Runs against a targets path that cannot exist, so this is deterministic on
// any machine and never touches .uemcp-targets.json.
const VERIFY_DEPLOY = join(dirname(fileURLToPath(import.meta.url)), 'verify-deploy.mjs');
const MISSING_TARGETS = join(dirname(fileURLToPath(import.meta.url)), 'no-such-targets-file.json');

const jsonRun = spawnSync(process.execPath, [VERIFY_DEPLOY, '--json', '--targets', MISSING_TARGETS], { encoding: 'utf8' });
eq(jsonRun.status, 2, '--json with an absent targets file exits 2');
let jsonDoc = null;
try { jsonDoc = JSON.parse(jsonRun.stdout); } catch { jsonDoc = null; }
assertOk(jsonDoc !== null, '--json stdout parses as JSON');
eq([jsonDoc && jsonDoc.version, jsonDoc && jsonDoc.exitCode, typeof (jsonDoc && jsonDoc.error)], [1, 2, 'string'],
  'the error document carries version, exitCode and a message');
assertOk(jsonRun.stdout.trim().startsWith('{') && jsonRun.stdout.trim().endsWith('}'),
  '--json prints one document to stdout and nothing else');

const badFlagRun = spawnSync(process.execPath, [VERIFY_DEPLOY, '--json', '--not-a-flag'], { encoding: 'utf8' });
eq(badFlagRun.status, 2, '--json with an unknown flag exits 2');
includesStr(badFlagRun.stdout, '"error"', 'an unknown flag under --json still produces the error document');

const textRun = spawnSync(process.execPath, [VERIFY_DEPLOY, '--no-color', '--targets', MISSING_TARGETS], { encoding: 'utf8' });
eq(textRun.status, 2, 'text mode with an absent targets file still exits 2');
includesStr(textRun.stderr, '[ERROR]', 'text mode still reports the failure to a human');

// run-rotation.mjs primary format — each on its own line so it can be parsed
// from stdout per the regex at run-rotation.mjs:93-95.
console.log('');
console.log(`Passed: ${passed}`);
console.log(`Failed: ${failed}`);
console.log(`Total: ${passed + failed}`);
process.exit(failed === 0 ? 0 : 1);
