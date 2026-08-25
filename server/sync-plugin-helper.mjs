#!/usr/bin/env node
// sync-plugin-helper.mjs — Node helper module for sync-plugin.bat.
//
// Two responsibilities both invoked from sync-plugin.bat as CLI subcommands:
//
//   1. **Deploy-marker write/read/compare** (closes the upgrade-cache stale risk
//      surfaced post-D137 manifest 1.0.0 → 1.0.1 transition). After each
//      successful sync, writes <dest>/Plugins/UEMCP/.uemcp-deploy-marker.json
//      capturing manifest version + uplugin Version + commit SHAs. On the next
//      sync, compares incoming manifest/uplugin versions against the marker:
//      mismatch → recommend nuking <dest>/Binaries + <dest>/Intermediate
//      before xcopy so UBT does a clean rebuild against the structural change.
//      D61's procedural nuke-rebuild hint becomes a structural auto-bust.
//
//   2. **Per-workspace editor-lock detection** (replaces sync-plugin.bat's
//      coarse "any UnrealEditor.exe → abort" check from D136 follow-on (b)).
//      Reuses verify-deploy.mjs's listEditorProcesses + extractUprojectFromCommandLine
//      so a sync against workspace B is not blocked by an editor running
//      against workspace A. Mirrors the same full-path normalization that
//      makes [EDITOR-LOCKED] work in verify-deploy.bat.
//
// Pure functions are exported for testing (test-sync-plugin-helper.mjs).
//
// Subcommands:
//   node sync-plugin-helper.mjs check <destDir> <repoRoot>
//     Compare prior marker (if any) against incoming repo state.
//     Stdout: "NUKE <reason>\n  prior:    manifest=<v> uplugin=<n>\n  incoming: ..."
//             OR "OK <reason>"
//     Exit:   0 = no nuke needed (preserve existing Binaries/Intermediate)
//             10 = NUKE recommended (caller deletes Binaries+Intermediate before xcopy)
//             1  = error (bad args, fs error, etc.)
//
//   node sync-plugin-helper.mjs write <destDir> <repoRoot>
//     Write <destDir>/Plugins/UEMCP/.uemcp-deploy-marker.json post-sync.
//     Atomic write (.uemcp-tmp + rename) so a partial-write failure can't
//     corrupt the marker.
//     Exit: 0 = success, 1 = error
//
//   node sync-plugin-helper.mjs lock-check <targetUproject>
//     Per-workspace UnrealEditor lock detection.
//     Stdout: "CLEAR" / "LOCKED <pid> <uprojectPath>" / "WARN <pid> <uprojectPath>"
//     Exit:   0 = no editor matches this workspace (clear to sync)
//             1 = editor matches AND DLL exists at <target>/Plugins/UEMCP/Binaries/Win64/
//                 (DLL would be locked; abort sync)
//             2 = editor matches BUT no DLL at target (warn but proceed; sync source
//                 still safe because there's no DLL to lock)
//
// Why a Node helper (vs embedded `node -e` in sync-plugin.bat): the embedded-JS
// pattern requires DisableDelayedExpansion gymnastics for `!` and `^` chars
// (see sync-plugin.bat:113); a dedicated helper avoids that quagmire entirely.
// Pattern matches verify-deploy.bat → server/verify-deploy.mjs (D136).

import { readFileSync, writeFileSync, existsSync, renameSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve, basename } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  listEditorProcesses,
  normalizePath,
  extractUprojectFromCommandLine,
} from './verify-deploy.mjs';

const __filename = fileURLToPath(import.meta.url);

// Marker filename — leading dot keeps it out of UE's content scanner; .json
// extension makes it human-inspectable. Lives at <dest>/Plugins/UEMCP/<name>.
export const MARKER_FILENAME = '.uemcp-deploy-marker.json';
export const MARKER_SCHEMA_VERSION = '1.0';

// ─── Marker helpers (pure-ish, exported for tests) ───────────────────

/**
 * Read the deploy marker from <pluginDestDir>/.uemcp-deploy-marker.json.
 * pluginDestDir is the actual UEMCP plugin dir (e.g., <project>/Plugins/UEMCP),
 * NOT the project root. Returns parsed object on success, null on missing file
 * OR malformed JSON (treat both the same — caller's contract is "no usable
 * marker means first-sync semantics").
 */
export function readDeployMarker(pluginDestDir) {
  const path = join(pluginDestDir, MARKER_FILENAME);
  if (!existsSync(path)) return null;
  try {
    const txt = readFileSync(path, 'utf8');
    const obj = JSON.parse(txt);
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) return obj;
    return null;
  } catch {
    // Malformed JSON OR fs read error — treat as no-marker so the next sync
    // overwrites cleanly. Avoids a corrupt marker bricking future syncs.
    return null;
  }
}

/**
 * Write a deploy marker atomically: stage to <name>.uemcp-tmp, then rename.
 * Mirrors setup-uemcp.bat's .uproject write pattern (PowerShell .uemcp-tmp +
 * Move-Item -Force) — same partial-write-can't-corrupt invariant.
 *
 * Required fields per design: schemaVersion, syncTime, manifestVersion,
 * upluginVersion, upluginVersionName, sourceCommitSha, headPluginCommitSha,
 * syncedBy. Caller passes them in `fields`; this helper layers in defaults
 * (schemaVersion + syncTime if absent) so the marker shape stays canonical.
 */
export function writeDeployMarker(pluginDestDir, fields) {
  if (!existsSync(pluginDestDir)) {
    mkdirSync(pluginDestDir, { recursive: true });
  }
  const marker = {
    schemaVersion: MARKER_SCHEMA_VERSION,
    syncTime: new Date().toISOString(),
    syncedBy: 'sync-plugin.bat',
    ...fields,
  };
  const finalPath = join(pluginDestDir, MARKER_FILENAME);
  const tmpPath = finalPath + '.uemcp-tmp';
  writeFileSync(tmpPath, JSON.stringify(marker, null, 2) + '\n', 'utf8');
  renameSync(tmpPath, finalPath);
  return marker;
}

/**
 * Compare a prior marker against an incoming repo state. Pure function.
 *
 * Returns one of:
 *   { nukeRecommended: false, reason: 'no-prior-marker' }
 *     → first sync after W-L ships, OR fresh install. Don't surprise-nuke
 *       any hand-built incremental cache the user may have.
 *
 *   { nukeRecommended: true, reason: 'version-changed', detail: { prior, incoming } }
 *     → manifest version OR uplugin Version changed. Cache may be stale due
 *       to new .h/.cpp files or Build.cs dep changes UBT can under-detect.
 *
 *   { nukeRecommended: false, reason: 'version-match' }
 *     → both versions match. Body-only changes are safe with UBT's BuildId.
 */
export function compareDeployMarker(prior, incoming) {
  if (prior === null || prior === undefined) {
    return { nukeRecommended: false, reason: 'no-prior-marker' };
  }
  // Defensive: schemaVersion mismatch on the marker itself triggers a nuke
  // because the comparison contract may have changed in a backward-incompatible
  // way. Future-proofs the helper if we ever add new fields the caller relies on.
  if (prior.schemaVersion !== MARKER_SCHEMA_VERSION) {
    return {
      nukeRecommended: true,
      reason: 'schema-version-changed',
      detail: { prior, incoming },
    };
  }
  const manifestChanged = prior.manifestVersion !== incoming.manifestVersion;
  const upluginChanged = prior.upluginVersion !== incoming.upluginVersion;
  if (manifestChanged || upluginChanged) {
    return {
      nukeRecommended: true,
      reason: 'version-changed',
      detail: { prior, incoming },
    };
  }
  return { nukeRecommended: false, reason: 'version-match' };
}

/**
 * Read manifest.json + UEMCP.uplugin from a repo root, plus git SHAs.
 * Returns { manifestVersion, upluginVersion, upluginVersionName, sourceCommitSha,
 * headPluginCommitSha }. Throws on missing manifest or missing uplugin (callers
 * should treat that as a fatal repo-state error, not a marker miss).
 *
 * sourceCommitSha = repo HEAD short SHA (whole repo).
 * headPluginCommitSha = last commit touching plugin/UEMCP/ specifically (matches
 * verify-deploy.mjs's getHeadPluginCommitInfo so the two stay aligned in
 * diagnostics output). Both fall back to '(git unavailable)' on git error.
 */
export function computeIncomingState(repoRoot) {
  const manifestPath = join(repoRoot, 'manifest.json');
  if (!existsSync(manifestPath)) {
    throw new Error(`manifest.json not found at ${manifestPath}`);
  }
  const upluginPath = join(repoRoot, 'plugin', 'UEMCP', 'UEMCP.uplugin');
  if (!existsSync(upluginPath)) {
    throw new Error(`UEMCP.uplugin not found at ${upluginPath}`);
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const uplugin = JSON.parse(readFileSync(upluginPath, 'utf8'));

  const sourceCommitSha = safeGitShortSha(repoRoot, []);
  const headPluginCommitSha = safeGitShortSha(repoRoot, ['--', 'plugin/UEMCP']);

  return {
    manifestVersion: String(manifest.version ?? ''),
    upluginVersion: typeof uplugin.Version === 'number' ? uplugin.Version : Number(uplugin.Version ?? 0),
    upluginVersionName: String(uplugin.VersionName ?? ''),
    sourceCommitSha,
    headPluginCommitSha,
  };
}

function safeGitShortSha(repoRoot, pathArgs) {
  try {
    const out = execFileSync(
      'git',
      ['-C', repoRoot, 'log', '-1', '--format=%h', ...pathArgs],
      { encoding: 'utf8' }
    ).trim();
    return out || '(git unavailable)';
  } catch {
    return '(git unavailable)';
  }
}

// ─── Per-workspace lock detection (pure, exported) ───────────────────

/**
 * Check whether any running UnrealEditor*.exe has its CommandLine pointing at
 * <targetUproject>. If yes AND a DLL exists at <target>/Plugins/UEMCP/Binaries/
 * Win64/UnrealEditor-UEMCP.dll, the DLL is locked → abort sync. If yes BUT no
 * DLL, sync source is still safe (there's no DLL to lock) — warn and proceed.
 *
 * Uses verify-deploy.mjs's listEditorProcesses (PowerShell Get-CimInstance
 * Win32_Process) + extractUprojectFromCommandLine + normalizePath. Full-path
 * comparison (not stem) so two checkouts sharing the same .uproject filename
 * in different parent dirs are tracked independently — matches D136's
 * [EDITOR-LOCKED] discrimination logic.
 *
 * Returns { state, pid, uprojectPath, dllPath } where state is one of
 * 'clear', 'locked', 'warn'. CLI shim maps these to exit 0/1/2.
 */
export function checkPerWorkspaceLock(targetUproject) {
  const targetUprojNorm = normalizePath(targetUproject);
  const targetDir = dirname(targetUproject);
  const dllPath = join(targetDir, 'Plugins', 'UEMCP', 'Binaries', 'Win64', 'UnrealEditor-UEMCP.dll');
  const dllExists = existsSync(dllPath);

  const editors = listEditorProcesses();
  const matched = editors.filter((p) =>
    p.uprojectPath && normalizePath(p.uprojectPath) === targetUprojNorm
  );

  if (matched.length === 0) {
    return { state: 'clear', pid: null, uprojectPath: null, dllPath, dllExists };
  }
  // Pick the first match for reporting; multiple editors against the same
  // .uproject is rare but possible (e.g., user opened a duplicate window).
  const m = matched[0];
  if (dllExists) {
    return { state: 'locked', pid: m.pid, uprojectPath: m.uprojectPath, dllPath, dllExists };
  }
  return { state: 'warn', pid: m.pid, uprojectPath: m.uprojectPath, dllPath, dllExists };
}

// ─── CLI shim (subcommands invoked from sync-plugin.bat) ─────────────

function usage() {
  console.error('Usage:');
  console.error('  node sync-plugin-helper.mjs check <pluginDestDir> <repoRoot>');
  console.error('  node sync-plugin-helper.mjs write <pluginDestDir> <repoRoot>');
  console.error('  node sync-plugin-helper.mjs lock-check <targetUproject>');
  process.exit(1);
}

function cliCheck(pluginDestDir, repoRoot) {
  const prior = readDeployMarker(pluginDestDir);
  let incoming;
  try {
    incoming = computeIncomingState(repoRoot);
  } catch (e) {
    console.error(`[ERROR] computeIncomingState: ${e.message}`);
    process.exit(1);
  }
  const verdict = compareDeployMarker(prior, incoming);
  if (verdict.nukeRecommended) {
    console.log(`NUKE ${verdict.reason}`);
    if (verdict.detail) {
      const p = verdict.detail.prior || {};
      const i = verdict.detail.incoming || {};
      console.log(`  prior:    manifest=${p.manifestVersion ?? '(?)'} uplugin=${p.upluginVersion ?? '(?)'} versionName=${p.upluginVersionName ?? '(?)'}`);
      console.log(`  incoming: manifest=${i.manifestVersion ?? '(?)'} uplugin=${i.upluginVersion ?? '(?)'} versionName=${i.upluginVersionName ?? '(?)'}`);
    }
    process.exit(10);
  }
  console.log(`OK ${verdict.reason}`);
  if (verdict.reason === 'no-prior-marker') {
    console.log('  (first sync after W-L; preserving existing Binaries/Intermediate)');
  } else {
    console.log(`  manifest=${incoming.manifestVersion} uplugin=${incoming.upluginVersion} versionName=${incoming.upluginVersionName}`);
  }
  process.exit(0);
}

function cliWrite(pluginDestDir, repoRoot, syncedBy) {
  let incoming;
  try {
    incoming = computeIncomingState(repoRoot);
  } catch (e) {
    console.error(`[ERROR] computeIncomingState: ${e.message}`);
    process.exit(1);
  }
  try {
    const marker = writeDeployMarker(pluginDestDir, syncedBy ? { ...incoming, syncedBy } : incoming);
    console.log(`Wrote ${join(pluginDestDir, MARKER_FILENAME)}`);
    console.log(`  manifest=${marker.manifestVersion} uplugin=${marker.upluginVersion} versionName=${marker.upluginVersionName}`);
    console.log(`  sourceCommitSha=${marker.sourceCommitSha} headPluginCommitSha=${marker.headPluginCommitSha}`);
    process.exit(0);
  } catch (e) {
    console.error(`[ERROR] writeDeployMarker: ${e.message}`);
    process.exit(1);
  }
}

function cliLockCheck(targetUproject) {
  if (!existsSync(targetUproject)) {
    console.error(`[ERROR] .uproject not found: ${targetUproject}`);
    process.exit(1);
  }
  const r = checkPerWorkspaceLock(targetUproject);
  if (r.state === 'clear') {
    console.log('CLEAR');
    process.exit(0);
  }
  if (r.state === 'locked') {
    console.log(`LOCKED pid=${r.pid} uproject=${r.uprojectPath}`);
    console.log(`  DLL locked at: ${r.dllPath}`);
    process.exit(1);
  }
  // warn
  console.log(`WARN pid=${r.pid} uproject=${r.uprojectPath}`);
  console.log('  Editor running but no DLL at target yet; sync source is safe.');
  process.exit(2);
}

function main() {
  const argv = process.argv.slice(2);
  const sub = argv[0];
  if (!sub || sub === '--help' || sub === '-h') usage();

  if (sub === 'check') {
    if (argv.length !== 3) usage();
    cliCheck(resolve(argv[1]), resolve(argv[2]));
  } else if (sub === 'write') {
    // Optional 4th arg: the writer's label for the marker's syncedBy field.
    if (argv.length !== 3 && argv.length !== 4) usage();
    cliWrite(resolve(argv[1]), resolve(argv[2]), argv[3]);
  } else if (sub === 'lock-check') {
    if (argv.length !== 2) usage();
    cliLockCheck(resolve(argv[1]));
  } else {
    console.error(`[ERROR] Unknown subcommand: ${sub}`);
    usage();
  }
}

// Entry-point detection: only run main() when executed directly, not when
// imported by tests. Mirrors verify-deploy.mjs's pattern.
if (process.argv[1] && resolve(process.argv[1]) === resolve(__filename)) {
  main();
}
