#!/usr/bin/env node
// verify-deploy.mjs — Pre-dispatch deployment verification CLI.
//
// Reads .uemcp-targets.json profiles by default, falling back to legacy
// .uemcp-targets.txt when no structured file exists. For each selected target,
// reports whether the deployed UEMCP plugin is in sync with the repo source:
// SYNC / NEEDS-SYNC / NEEDS-BUILD / NEEDS-DEPLOY / MISSING. Surfaces
// editor-lock state (UnrealEditor.exe running with the target's .uproject in
// its CommandLine) so users don't invoke Build.bat against a locked DLL and
// silently no-op.
//
// Closes the D113 wasted-worker-session class structurally (per
// `feedback_predispatch_deploy_state_check.md` memory) and the D135
// re-smoke editor-lock failure mode (per §2.6 of the Q3 handoff).
//
// Invoked from verify-deploy.bat (repo root). Exit codes: 0 all SYNC,
// 1 any non-SYNC target, 2 config error (missing targets file etc.).
//
// Flags:
//   --auto-sync                run sync-plugin.bat on stale targets
//   --regenerate-mcp-json N    rewrite .mcp.json for target N (1-based)
//   --quiet                    only print verdicts, suppress details
//   --no-color                 disable ANSI colors
//   --targets <path>           override .uemcp-targets.json/.txt path
//   --profile <name>           select a structured profile (default/all/smoke/etc.)
//   --watch                    long-running file-watcher mode (Q3-C). Watches
//                              plugin/UEMCP/Source/ recursively; on change,
//                              debounces 500ms then runs sync-plugin.bat -y
//                              for each target. Run from setup-watcher.bat.
//   --json                     print one JSON verdict document to stdout and
//                              nothing else. Implies --no-color; ignores
//                              --quiet; not combinable with --auto-sync or
//                              --regenerate-mcp-json; ignored in --watch
//                              mode. Consumed by .githooks/pre-push.
//   --help                     show usage
//
// Pure functions for verdict classification, plus buildJsonReport /
// buildJsonErrorReport / selectionErrorMessage / exitCodeForResults for the
// --json document, are exported for testing (test-verify-deploy.mjs).

import { readFileSync, statSync, readdirSync, existsSync, writeFileSync, watch as fsWatch } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  parseTargetsFile as parseTargetsFileShared,
  readProjectTargets,
} from './project-targets.mjs';
import {
  extractUprojectFromCommandLine as extractUprojectFromCommandLineShared,
  normalizePath as normalizePathShared,
} from './project-identity.mjs';
import {
  parseEditorProcessLines as parseEditorProcessLinesShared,
  listEditorProcesses as listEditorProcessesShared,
} from './editor-processes.mjs';
// W-L marker integration (D138-FIX3): consult <dest>/.uemcp-deploy-marker.json
// to detect uplugin/manifest version-mismatch — closes the gap where
// verify-deploy could report SYNC for a target whose Source/ matches but
// whose UEMCP.uplugin Version is stale (e.g., post-W-L Version 1 vs repo
// Version 2). Reuses sync-plugin-helper's pure-function helpers so the
// comparison contract stays identical between sync-plugin.bat (which
// triggers nuke) and verify-deploy.bat (which triggers NEEDS-SYNC).
import {
  readDeployMarker,
  compareDeployMarker,
  computeIncomingState,
  markerSyncedAtMs,
} from './sync-plugin-helper.mjs';
import { hashPluginTree } from './plugin-content-hash.mjs';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(__filename), '..');
const PLUGIN_SRC_DIR = join(REPO_ROOT, 'plugin', 'UEMCP', 'Source');
const REPO_PLUGIN_DIR = join(REPO_ROOT, 'plugin', 'UEMCP');
const MTIME_SLOP_SEC = 5;  // tolerance for filesystem mtime jitter on copy

// ─── ANSI colors (no dependency) ────────────────────────────────────
let useColor = process.stdout.isTTY;
const C = (code) => (s) => useColor ? `\x1b[${code}m${s}\x1b[0m` : s;
const red = C('31'), green = C('32'), yellow = C('33'), cyan = C('36'), bold = C('1'), dim = C('2');

// ─── Pure helpers (exported for tests) ──────────────────────────────

/** Parse .uemcp-targets.txt: strip comments, blank lines; return array of trimmed paths. */
export const parseTargetsFile = parseTargetsFileShared;

/** Recursively walk a directory and return the maximum mtime in seconds (Unix epoch). */
export function newestMtimeSec(dir) {
  let newest = 0;
  let count = 0;
  const walk = (d) => {
    let entries;
    try { entries = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) {
        try {
          const m = Math.floor(statSync(p).mtimeMs / 1000);
          if (m > newest) newest = m;
          count++;
        } catch { /* unreadable */ }
      }
    }
  };
  walk(dir);
  return { mtimeSec: newest, fileCount: count };
}

/**
 * Content identity between the deployed tree and the repo tree. null means
 * "unknown" — one of the hashes could not be computed — and must never be
 * read as "differs".
 */
function compareSourceHashes(repoSourceHash, deployedSourceHash) {
  if (!repoSourceHash || !deployedSourceHash) return null;
  return repoSourceHash === deployedSourceHash;
}

/**
 * When the deployed content was last put in place, in epoch seconds. The
 * marker's own time is only usable when the marker describes the content that
 * is actually on disk; a marker recording a different hash was written for a
 * different tree, so fall back to the deployed files' mtime.
 */
function lastSyncRefSec({ markerSyncedAtMs: syncedMs, markerSourceHash, deployedSourceHash, deployedSrcMtime }) {
  const markerDescribesDisk = !markerSourceHash || markerSourceHash === deployedSourceHash;
  if (syncedMs && markerDescribesDisk) return Math.floor(syncedMs / 1000);
  return deployedSrcMtime;
}

/** Classify a target's deploy state given gathered metrics. Pure function. */
export function classifyDeployState(input) {
  const contentIdentical = compareSourceHashes(
    input.repoSourceHash ?? null,
    input.deployedSourceHash ?? null,
  );
  return { ...classifyVerdict(input, contentIdentical), contentIdentical };
}

function classifyVerdict(input, contentIdentical) {
  const { pluginDirExists, deployedSrcMtime, deployedSrcFileCount, dllExists, dllMtime, repoSrcMtime } = input;
  if (!pluginDirExists) return { verdict: 'MISSING', reason: 'No Plugins\\UEMCP at target' };
  if (deployedSrcFileCount === 0) return { verdict: 'MISSING-PARTIAL', reason: 'Plugin dir exists but Source/ is empty' };
  if (!dllExists) {
    // Never built here. Content identity cannot make a missing DLL fresh, so
    // the pre-content rules stand unchanged (design §3.3).
    if (deployedSrcMtime + MTIME_SLOP_SEC < repoSrcMtime) {
      return { verdict: 'NEEDS-DEPLOY', reason: 'Source stale AND DLL missing — full sync + Build needed' };
    }
    return { verdict: 'NEEDS-BUILD', reason: 'Source synced but DLL not built' };
  }
  if (contentIdentical === true) {
    // Byte-identical deployment: a merge or checkout cannot make it stale. The
    // only question left is whether the DLL predates the sync that placed it.
    if (dllMtime + MTIME_SLOP_SEC < lastSyncRefSec(input)) {
      return { verdict: 'NEEDS-BUILD', reason: 'content-identical to repo; DLL predates the last sync' };
    }
    return { verdict: 'SYNC', reason: 'content-identical to repo; DLL built after the last sync' };
  }
  // Content differs or is unknown — the timestamp rules are still right.
  const sourceStale = deployedSrcMtime + MTIME_SLOP_SEC < repoSrcMtime;
  const dllStale = dllMtime + MTIME_SLOP_SEC < repoSrcMtime;
  if (sourceStale && dllStale) {
    return { verdict: 'NEEDS-DEPLOY', reason: 'DLL predates HEAD source — full sync + Build needed' };
  }
  if (sourceStale) {
    return { verdict: 'NEEDS-SYNC', reason: 'Deployed source older than repo source' };
  }
  if (dllMtime + MTIME_SLOP_SEC < deployedSrcMtime) {
    return { verdict: 'NEEDS-BUILD', reason: 'Deployed source synced but DLL older than source — Build needed' };
  }
  return { verdict: 'SYNC', reason: 'DLL ≥ deployed source ≥ repo source' };
}

/** Format seconds delta as "Xh Ym" / "Xd Yh" / "Xm Ys". Negative input returns "(-)". */
export function formatAge(deltaSec) {
  if (deltaSec < 0) return `(${Math.abs(deltaSec)}s ahead)`;
  if (deltaSec < 60) return `${deltaSec}s`;
  if (deltaSec < 3600) return `${Math.floor(deltaSec / 60)}m ${deltaSec % 60}s`;
  if (deltaSec < 86400) return `${Math.floor(deltaSec / 3600)}h ${Math.floor((deltaSec % 3600) / 60)}m`;
  return `${Math.floor(deltaSec / 86400)}d ${Math.floor((deltaSec % 86400) / 3600)}h`;
}

/** Format unix-seconds timestamp as YYYY-MM-DD HH:MM:SS local time. */
export function formatTime(unixSec) {
  if (!unixSec) return '(none)';
  const d = new Date(unixSec * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** Format an ISO-8601 marker timestamp string as YYYY-MM-DD HH:MM:SS local. Falls back to the raw string on parse error. */
export function formatMarkerSyncTime(isoString) {
  if (!isoString || typeof isoString !== 'string') return '(unknown)';
  const ms = Date.parse(isoString);
  if (Number.isNaN(ms)) return isoString;
  return formatTime(Math.floor(ms / 1000));
}

/**
 * Apply marker-based verdict overlay (W-L / D138-FIX3). Pure function.
 *
 * Takes the source/DLL-mtime verdict from classifyDeployState and the
 * marker comparison result; returns the final verdict. Marker-side
 * staleness OVERRIDES source/DLL-side SYNC verdicts because a stale
 * marker means UEMCP.uplugin metadata is out-of-date even when the
 * source files happen to match.
 *
 * Skips overlay for MISSING/MISSING-PARTIAL (those are more fundamental
 * issues — caller hasn't deployed at all). Also a no-op when
 * incomingState is null (helper unavailable / repo state unreadable).
 */
export function applyMarkerVerdictOverlay(baseVerdict, marker, markerVerdict, incomingState, pluginDirExists, deployedSrcFileCount) {
  if (!incomingState) return baseVerdict;
  if (!pluginDirExists) return baseVerdict;
  if (deployedSrcFileCount === 0) return baseVerdict;
  if (!markerVerdict) return baseVerdict;

  if (markerVerdict.reason === 'no-prior-marker') {
    // Plugin dir has content but no marker. Both setup-uemcp.bat and
    // sync-plugin.bat write one now, so this means a pre-W-L deploy or a
    // copy made by neither. Prompt for one sync-plugin.bat run to seed the
    // marker so future version-bump cache-busting can fire.
    return {
      verdict: 'NEEDS-SYNC',
      reason: 'No deploy marker — run sync-plugin.bat once to seed',
      contentIdentical: baseVerdict.contentIdentical ?? null,
    };
  }
  if (markerVerdict.nukeRecommended) {
    // Marker present but version-mismatch (manifest, uplugin, or
    // schema). Source/DLL might be SYNC by mtime but uplugin metadata
    // is stale. Override.
    const detail = markerVerdict.detail || {};
    const p = detail.prior || marker || {};
    const i = detail.incoming || incomingState || {};
    return {
      verdict: 'NEEDS-SYNC',
      reason: `Marker shows manifest=${p.manifestVersion ?? '?'} uplugin=${p.upluginVersion ?? '?'}, repo has manifest=${i.manifestVersion ?? '?'} uplugin=${i.upluginVersion ?? '?'}`,
      contentIdentical: baseVerdict.contentIdentical ?? null,
    };
  }
  // version-match → marker says deploy is up-to-date metadata-wise;
  // base verdict (SYNC / NEEDS-BUILD / NEEDS-SYNC from mtime check)
  // prevails.
  return baseVerdict;
}

/** 0 when every target is SYNC, 1 when any needs attention. Both printers use it. */
export function exitCodeForResults(results) {
  return results.some((r) => r.verdict.verdict !== 'SYNC') ? 1 : 0;
}

/**
 * One-line rendering of a target-selection failure, for the JSON error
 * document. The text printer keeps its multi-line guidance.
 */
export function selectionErrorMessage(selection) {
  const path = selection.targetsPath;
  if (selection.status === 'valid' && selection.candidates.length === 0) {
    return `No targets selected in ${path}`;
  }
  switch (selection.status) {
    case 'profile_not_found': {
      const available = selection.profile?.availableProfiles || [];
      const suffix = available.length > 0 ? ` (available: ${available.join(', ')})` : '';
      return `Profile not found: ${selection.profile?.name || '(none)'}${suffix}`;
    }
    case 'absent': return `Targets file not found: ${path}`;
    case 'empty': return `No targets selected in ${path}`;
    case 'invalid_config': return `Invalid targets config: ${path}`;
    case 'invalid_profile': return `Invalid profile: ${selection.profile?.name || '(none)'}`;
    default: return `Invalid targets: ${path}`;
  }
}

/**
 * The machine-readable verdict document. The pre-push gate's contract is this
 * shape — never the human printer's wording — so a reword cannot disarm it.
 * `warnings` is additive: informational lines (e.g. a marker overlay that
 * could not be computed) that no consumer is required to act on. The gate
 * ignores it; it exists so a human reading the JSON sees what text mode would
 * have printed to stderr.
 */
export function buildJsonReport(targets, { profile = null, exitCode = 0, warnings = [] } = {}) {
  return {
    version: 1,
    profile: profile || null,
    targets: targets.map((t) => ({
      uprojectPath: t.uprojectPath,
      alias: t.alias ?? null,
      verdict: t.verdict.verdict,
      reason: t.verdict.reason,
      contentIdentical: t.verdict.contentIdentical ?? null,
      dllExists: !!t.dllExists,
      editors: (t.matchedEditors || []).map((e) => e.pid),
      mcpPointsHere: !!t.mcpPointsHere,
    })),
    warnings,
    exitCode,
  };
}

/** The document emitted when verify-deploy could not evaluate at all. */
export function buildJsonErrorReport(message) {
  return { version: 1, error: String(message), exitCode: 2 };
}

/** Normalize a Windows path for comparison: lowercase + forward slashes + no trailing slash. */
export const normalizePath = normalizePathShared;

/** Extract .uproject argument from a UnrealEditor CommandLine string. */
export const extractUprojectFromCommandLine = extractUprojectFromCommandLineShared;

// ─── Side-effecting helpers ─────────────────────────────────────────

/**
 * Run `git log -1 --format=%ct -- plugin/UEMCP/Source` to get HEAD plugin
 * **source** commit time.
 *
 * Why scoped to Source/ specifically (not the whole plugin/UEMCP/): the commit
 * time is used as a "freshness fallback" when filesystem mtimes lag behind
 * (e.g., after a checkout that didn't reset file mtimes). But it must only
 * advance when files relevant to the deploy comparison actually change.
 *
 * Pre-D138 the path was `plugin/UEMCP/` (whole tree). D138's W-L commit
 * (0c50eab) bumped UEMCP.uplugin Version: 1 → 2 without touching any C++
 * source — that advanced the whole-tree commit time past the Source/ file
 * mtimes, falsely flagging just-synced targets as NEEDS-DEPLOY (because
 * xcopy preserves source mtimes; deployed Source/ matches repo Source/, but
 * the comparison reference had jumped ahead to the uplugin-bump commit).
 *
 * Source/-scoped means: the commit time advances when any C++ source under
 * plugin/UEMCP/Source/ changes (which IS what drives DLL rebuilds and
 * source-stale verdicts). UEMCP.uplugin metadata changes still propagate
 * via xcopy — they just don't pollute the source-stale comparison.
 *
 * Trade-off: a hypothetical future commit that ONLY edits UEMCP.uplugin
 * Plugins[] without bumping Version + without touching Source/ would not
 * advance this commit time → verify-deploy would not flag the stale uplugin.
 * That's an accepted regression vs. the false-positive class W-L exposed;
 * Plugins[] changes typically come with Version bumps anyway (per the W-L
 * lockstep convention codified in CLAUDE.md), and the W-L deploy-marker
 * (which compares uplugin Version) catches Version-bump cases independently.
 */
function getHeadPluginCommitInfo() {
  try {
    const ct = execFileSync('git', ['-C', REPO_ROOT, 'log', '-1', '--format=%ct', '--', 'plugin/UEMCP/Source'],
      { encoding: 'utf8' }).trim();
    const sha = execFileSync('git', ['-C', REPO_ROOT, 'log', '-1', '--format=%h', '--', 'plugin/UEMCP/Source'],
      { encoding: 'utf8' }).trim();
    const subj = execFileSync('git', ['-C', REPO_ROOT, 'log', '-1', '--format=%s', '--', 'plugin/UEMCP/Source'],
      { encoding: 'utf8' }).trim();
    return { commitTime: parseInt(ct, 10) || 0, sha, subject: subj };
  } catch (e) {
    return { commitTime: 0, sha: '(git unavailable)', subject: '' };
  }
}

/** Parse PowerShell process output lines shaped as "pid|commandLine". */
export const parseEditorProcessLines = parseEditorProcessLinesShared;

/** Enumerate UnrealEditor* processes via PowerShell; return [{ pid, uprojectPath }]. */
export function listEditorProcesses() {
  return listEditorProcessesShared();
}

/** Read repo-root .mcp.json's UNREAL_PROJECT_ROOT env, if present; null if absent. */
function readActiveMcpProjectRoot() {
  const path = join(REPO_ROOT, '.mcp.json');
  if (!existsSync(path)) return null;
  try {
    const j = JSON.parse(readFileSync(path, 'utf8'));
    return j?.mcpServers?.uemcp?.env?.UNREAL_PROJECT_ROOT || null;
  } catch { return null; }
}

/** Spawn sync-plugin.bat -y for a target. Returns exit code. */
function runSyncPlugin(uprojectPath) {
  const bat = join(REPO_ROOT, 'sync-plugin.bat');
  console.log(dim(`  > sync-plugin.bat "${uprojectPath}" -y`));
  const r = spawnSync('cmd.exe', ['/c', bat, uprojectPath, '-y'],
    { stdio: 'inherit', cwd: REPO_ROOT });
  return r.status;
}

/** Regenerate .mcp.json at repo root for the given target's workspace. */
function regenerateMcpJson(uprojectPath) {
  const tmpl = join(REPO_ROOT, '.mcp.json.example');
  if (!existsSync(tmpl)) {
    console.error(red('[ERROR]') + ` Template missing: ${tmpl}`);
    return 1;
  }
  const repoRootFwd = REPO_ROOT.replace(/\\/g, '/');
  const out = readFileSync(tmpl, 'utf8')
    .split('<UEMCP_REPO_PATH>').join(repoRootFwd);
  // Validate JSON before writing.
  try { JSON.parse(out); } catch (e) {
    console.error(red('[ERROR]') + ` Generated .mcp.json invalid: ${e.message}`);
    return 1;
  }
  const dest = join(REPO_ROOT, '.mcp.json');
  writeFileSync(dest, out, 'utf8');
  console.log(green('[OK]') + ` Wrote ${dest}`);
  console.log(`  Project target      = ${uprojectPath}`);
  console.log(`  Attachment          = workspace roots or attach_project (env mode not written by default)`);
  console.log(`  Compatibility env   = set UEMCP_PROJECT_ATTACH_MODE=env manually if required`);
  return 0;
}

// ─── Per-target metrics gathering ───────────────────────────────────

/**
 * Everything known about one target: deployed content, DLL, marker, editors.
 * `target` is { uprojectPath, alias }; `ctx` carries the per-run values that
 * are identical for every target.
 */
function gatherTargetMetrics(target, ctx) {
  const { uprojectPath, alias } = target;
  const { repoSrcMtime, repoSourceHash, editorProcs, activeMcpRoot, incomingState } = ctx;
  const targetDir = dirname(uprojectPath);
  const pluginDir = join(targetDir, 'Plugins', 'UEMCP');
  const deployedSrcDir = join(pluginDir, 'Source');
  const dllPath = join(pluginDir, 'Binaries', 'Win64', 'UnrealEditor-UEMCP.dll');

  const pluginDirExists = existsSync(pluginDir);
  const deployedSrcInfo = pluginDirExists ? newestMtimeSec(deployedSrcDir) : { mtimeSec: 0, fileCount: 0 };
  const dllExists = existsSync(dllPath);
  const dllMtime = dllExists ? Math.floor(statSync(dllPath).mtimeMs / 1000) : 0;
  const marker = pluginDirExists ? readDeployMarker(pluginDir) : null;
  const deployedSourceHash = pluginDirExists ? hashPluginTree(pluginDir) : null;

  const baseVerdict = classifyDeployState({
    pluginDirExists,
    deployedSrcMtime: deployedSrcInfo.mtimeSec,
    deployedSrcFileCount: deployedSrcInfo.fileCount,
    dllExists,
    dllMtime,
    repoSrcMtime,
    repoSourceHash,
    deployedSourceHash,
    markerSourceHash: marker?.sourceHash ?? null,
    markerSyncedAtMs: markerSyncedAtMs(marker),
  });

  // W-L marker overlay: stale or absent uplugin/manifest metadata still calls
  // for a sync even when the source bytes match.
  const markerVerdict = incomingState ? compareDeployMarker(marker, incomingState) : null;
  const verdict = applyMarkerVerdictOverlay(
    baseVerdict, marker, markerVerdict, incomingState,
    pluginDirExists, deployedSrcInfo.fileCount,
  );

  const targetUprojNorm = normalizePath(uprojectPath);
  const matchedEditors = editorProcs.filter((p) =>
    p.uprojectPath && normalizePath(p.uprojectPath) === targetUprojNorm
  );
  const mcpPointsHere = activeMcpRoot && normalizePath(activeMcpRoot) === normalizePath(targetDir);

  return {
    uprojectPath, alias, targetDir, pluginDir,
    deployedSrcMtime: deployedSrcInfo.mtimeSec,
    deployedSrcFileCount: deployedSrcInfo.fileCount,
    dllExists, dllMtime, deployedSourceHash,
    verdict, baseVerdict, marker, markerVerdict,
    matchedEditors, mcpPointsHere, repoSrcMtime,
  };
}

// ─── Output formatting ──────────────────────────────────────────────

function colorVerdict(verdict) {
  switch (verdict) {
    case 'SYNC': return green('SYNC');
    case 'NEEDS-SYNC': return yellow('NEEDS-SYNC');
    case 'NEEDS-BUILD': return yellow('NEEDS-BUILD');
    case 'NEEDS-DEPLOY': return red('NEEDS-DEPLOY');
    case 'MISSING':
    case 'MISSING-PARTIAL': return red(verdict);
    default: return verdict;
  }
}

function printSummaryLine(idx, t) {
  const editorTag = t.matchedEditors.length > 0 ? cyan(' [EDITOR-LOCKED]') : '';
  const mcpTag = t.mcpPointsHere ? cyan(' [MCP]') : '';
  console.log(
    `  [${idx + 1}] ${dim(t.uprojectPath)}\n` +
    `      ${bold('Verdict:')} ${colorVerdict(t.verdict.verdict)} — ${t.verdict.reason}${editorTag}${mcpTag}`
  );
}

function printTargetDetail(idx, t, repoSrcMtime, repoSrcLabel) {
  // Format age-vs-repo with direction-neutral phrasing. formatAge returns
  // "(Ns ahead)" for negative deltas; suffix "vs repo source" works for both
  // ahead and behind. "behind repo source" was misleading when DLL was newer.
  const dllAgeStr = t.dllExists ? formatAge(repoSrcMtime - t.dllMtime) : '(missing)';
  const srcAgeStr = t.deployedSrcMtime > 0 ? formatAge(repoSrcMtime - t.deployedSrcMtime) : '(missing)';
  console.log('');
  console.log(`  [${idx + 1}] ${bold(t.uprojectPath)}`);
  console.log(`      Verdict       : ${colorVerdict(t.verdict.verdict)} — ${t.verdict.reason}`);
  console.log(`      Repo src      : ${formatTime(repoSrcMtime)} ${dim('(' + repoSrcLabel + ')')}`);
  console.log(`      Deployed src  : ${formatTime(t.deployedSrcMtime)}  ${dim(srcAgeStr + ' vs repo source')}  ${dim('(' + t.deployedSrcFileCount + ' files)')}`);
  console.log(`      Deployed DLL  : ${formatTime(t.dllMtime)}  ${dim(dllAgeStr + ' vs repo source')}`);
  if (t.matchedEditors.length > 0) {
    for (const e of t.matchedEditors) {
      console.log(`      Editor active : ${cyan('YES')} — pid ${e.pid} ${dim('(DLL is locked; close before Build.bat)')}`);
    }
  } else {
    console.log(`      Editor active : NO`);
  }
  console.log(`      MCP points to : ${t.mcpPointsHere ? cyan('YES (this is the active workspace)') : 'NO'}`);
  // W-L marker line (D138-FIX3): show what manifest+uplugin version was last
  // synced and when. (absent) means a pre-W-L deploy or a fresh setup-uemcp.bat
  // install — either way the user should run sync-plugin.bat once to seed it.
  if (t.marker) {
    console.log(`      Deploy marker : manifest=${t.marker.manifestVersion} uplugin=${t.marker.upluginVersion} ${dim('(synced ' + formatMarkerSyncTime(t.marker.syncTime) + ')')}`);
  } else if (t.pluginDir && existsSync(t.pluginDir)) {
    console.log(`      Deploy marker : ${dim('(absent — sync-plugin.bat will seed on next run)')}`);
  }
  if (t.verdict.verdict !== 'SYNC') {
    let action;
    switch (t.verdict.verdict) {
      case 'NEEDS-SYNC': action = `sync-plugin.bat "${t.uprojectPath}" -y${needsBuildAfterSync(t) ? '  THEN  Build.bat (close editor first)' : ''}`; break;
      case 'NEEDS-BUILD': action = `Build.bat (close editor first if running)`; break;
      case 'NEEDS-DEPLOY': action = `sync-plugin.bat "${t.uprojectPath}" -y  THEN  Build.bat (close editor first)`; break;
      case 'MISSING':
      case 'MISSING-PARTIAL': action = `setup-uemcp.bat "${t.uprojectPath}"`; break;
      default: action = '(unknown)';
    }
    console.log(`      ${bold('Action')}        : ${action}`);
  }
}

/** True when a NEEDS-SYNC target also has a stale DLL that will need Build.bat after the sync. */
function needsBuildAfterSync(t) {
  if (!t.dllExists) return true;
  if (!t.markerVerdict) return false;
  // Marker mismatch implies sync will nuke + re-xcopy → DLL must be rebuilt.
  if (t.markerVerdict.nukeRecommended) return true;
  // Plain "no marker" case: DLL freshness is governed by base verdict.
  if (t.baseVerdict && (t.baseVerdict.verdict === 'NEEDS-BUILD' || t.baseVerdict.verdict === 'NEEDS-DEPLOY')) return true;
  return false;
}

// ─── Argument parsing ───────────────────────────────────────────────

function parseArgs(argv) {
  const flags = {
    autoSync: false,
    regenIdx: null,
    quiet: false,
    targetsFile: null,
    profile: null,
    watch: false,
    debounceMs: 500,
    help: false,
    json: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--auto-sync') flags.autoSync = true;
    else if (a === '--regenerate-mcp-json') flags.regenIdx = parseInt(argv[++i], 10);
    else if (a === '--quiet') flags.quiet = true;
    else if (a === '--no-color') useColor = false;
    else if (a === '--targets') flags.targetsFile = argv[++i];
    else if (a === '--profile') flags.profile = argv[++i] || '';
    else if (a === '--watch') flags.watch = true;
    else if (a === '--debounce-ms') flags.debounceMs = parseInt(argv[++i], 10);
    else if (a === '--help' || a === '-h') flags.help = true;
    else if (a === '--json') { flags.json = true; useColor = false; }
    else {
      // --json may not have been reached yet; the caller still gets a document.
      if (argv.includes('--json')) {
        console.log(JSON.stringify(buildJsonErrorReport(`Unknown arg: ${a}`), null, 2));
        process.exit(2);
      }
      console.error(red('[ERROR]') + ` Unknown arg: ${a}`);
      process.exit(2);
    }
  }
  return flags;
}

function printHelp() {
  console.log(`verify-deploy.mjs — UEMCP pre-dispatch deployment verification.

Usage: node verify-deploy.mjs [flags]
   or: verify-deploy.bat [flags]
   or: setup-watcher.bat                  (--watch mode wrapper)

Reads .uemcp-targets.json at repo root when present, otherwise falls back to
legacy .uemcp-targets.txt (gitignored, local-machine paths only). For each
selected target, reports SYNC / NEEDS-SYNC / NEEDS-BUILD / NEEDS-DEPLOY /
MISSING. Surfaces UnrealEditor.exe processes locking each DLL.

Flags:
  --auto-sync                run sync-plugin.bat on stale targets (NEEDS-SYNC,
                             NEEDS-DEPLOY). Skips targets with editor lock.
  --regenerate-mcp-json N    rewrite repo-root .mcp.json for target N (1-based)
  --quiet                    only verdict line per target, no detail
  --no-color                 disable ANSI colors
  --targets <path>           use a different .uemcp-targets.json/.txt file
  --profile <name>           select a structured profile. Built-in: all.
                             Legacy .txt supports only legacy/default/all.
  --watch                    long-running mode: watch plugin/UEMCP/Source/ and
                             auto-sync to all targets on change (Q3-C).
                             Skips Binaries/, Intermediate/, *.tmp paths.
                             500ms debounce. Ctrl+C to stop.
  --debounce-ms N            override watch debounce window (default 500)
  --json                     print one JSON verdict document to stdout and
                             nothing else. Implies --no-color; ignores --quiet;
                             not combinable with --auto-sync or
                             --regenerate-mcp-json; ignored in --watch mode.
                             Consumed by .githooks/pre-push.
  --help                     show this message

Exit: 0 all SYNC; 1 any non-SYNC; 2 config error.`);
}

function resolveTargetSelection(flags) {
  return readProjectTargets({
    repoRoot: REPO_ROOT,
    ...(flags.targetsFile ? { targetsPath: flags.targetsFile } : {}),
    profile: flags.profile,
  });
}

function printTargetSelectionHeader(selection) {
  const sourceLabel = selection.sourceType === 'json'
    ? 'structured json'
    : 'legacy txt';
  console.log(`Targets source      : ${selection.targetsPath} ${dim('(' + sourceLabel + ')')}`);
  console.log(`Profile             : ${selection.profile?.name || '(none)'} ${dim('(' + selection.candidates.length + ' selected)')}`);
}

function printTargetSelectionWarnings(selection) {
  for (const w of selection.warnings || []) {
    console.log(yellow('[WARN]') + ` ${w.message}`);
  }
}

function printTargetSelectionError(selection) {
  printTargetSelectionWarnings(selection);
  if (selection.status === 'profile_not_found') {
    console.error(red('[ERROR]') + ` Profile not found: ${selection.profile?.name || '(none)'}`);
    const profiles = selection.profile?.availableProfiles || [];
    if (profiles.length > 0) console.error(`  Available profiles: ${profiles.join(', ')}`);
    return;
  }
  if (selection.status === 'absent') {
    console.error(red('[ERROR]') + ` Targets file not found: ${selection.targetsPath}`);
    console.error('  Create .uemcp-targets.json from .uemcp-targets.json.example, or use legacy .uemcp-targets.txt.');
    return;
  }
  if (selection.status === 'empty') {
    console.error(yellow('[WARN]') + ` No targets selected in ${selection.targetsPath}.`);
    return;
  }
  if (selection.status === 'invalid_config') {
    console.error(red('[ERROR]') + ` Invalid targets config: ${selection.targetsPath}`);
  } else if (selection.status === 'invalid_profile') {
    console.error(red('[ERROR]') + ` Invalid profile: ${selection.profile?.name || '(none)'}`);
  } else {
    console.error(red('[ERROR]') + ` Invalid targets: ${selection.targetsPath}`);
  }
  for (const entry of selection.invalidEntries || []) {
    console.error(`  - ${entry.alias ? `${entry.alias}: ` : ''}${entry.entry} [${entry.reason}] ${entry.message}`);
  }
}

function targetSelectionIsUsable(selection) {
  return selection.candidates.length > 0 && selection.invalidEntries.length === 0 && selection.status === 'valid';
}

// ─── Watch mode (Q3-C) ──────────────────────────────────────────────

/** Long-running file watcher; debounces source changes and runs sync-plugin.bat per target. */
function runWatchMode(flags) {
  const selection = resolveTargetSelection(flags);
  if (!targetSelectionIsUsable(selection)) {
    printTargetSelectionError(selection);
    return 2;
  }
  const targets = selection.candidates.map(candidate => candidate.uprojectPath);
  if (!existsSync(PLUGIN_SRC_DIR)) {
    console.error(red('[ERROR]') + ` Plugin source dir missing: ${PLUGIN_SRC_DIR}`);
    return 2;
  }

  const stamp = () => formatTime(Math.floor(Date.now() / 1000));

  console.log(bold('=== UEMCP setup-watcher (Q3-C auto-deploy) ==='));
  console.log(`Repo            : ${REPO_ROOT}`);
  console.log(`Watching        : ${PLUGIN_SRC_DIR}`);
  console.log(`Targets source  : ${selection.targetsPath}`);
  console.log(`Profile         : ${selection.profile?.name || '(none)'}`);
  console.log(`Targets         : ${targets.length}`);
  for (let i = 0; i < targets.length; i++) console.log(`  [${i + 1}] ${targets[i]}`);
  console.log(`Debounce        : ${flags.debounceMs}ms`);
  console.log(dim('Excludes        : Binaries/, Intermediate/, *.tmp, *.uemcp-tmp'));
  console.log('');
  console.log(green(`[${stamp()}]`) + ' Watching for changes... ' + dim('(Ctrl+C to stop)'));

  // fs.watch with recursive:true is supported on Windows. Filename arrives as
  // a relative path with backslashes; we filter via substring + regex.
  const EXCLUDE_RE = /(^|[\\/])(Binaries|Intermediate)([\\/]|$)|\.tmp$|\.uemcp-tmp$/i;

  let debounceTimer = null;
  let pendingChanges = new Set();
  let syncInProgress = false;
  let queuedSyncAfterCurrent = false;

  const flushAndSync = async () => {
    if (syncInProgress) {
      // Another sync is running; queue another flush after it completes.
      queuedSyncAfterCurrent = true;
      return;
    }
    syncInProgress = true;
    const changeList = [...pendingChanges];
    pendingChanges = new Set();
    const previewList = changeList.slice(0, 3).join(', ') + (changeList.length > 3 ? `, +${changeList.length - 3} more` : '');
    console.log('');
    console.log(yellow(`[${stamp()}]`) + ` Change detected (${changeList.length} file${changeList.length === 1 ? '' : 's'}): ${dim(previewList)}`);
    console.log(yellow(`[${stamp()}]`) + ` Syncing ${targets.length} target(s)...`);
    for (const t of targets) {
      // Editor-lock pre-check: sync-plugin.bat will detect + abort, but we can
      // give the user a clearer per-target [SKIP] message vs raw bat output.
      const editors = listEditorProcesses();
      const targetUprojNorm = normalizePath(t);
      const locked = editors.some((e) =>
        e.uprojectPath && normalizePath(e.uprojectPath) === targetUprojNorm
      );
      if (locked) {
        // Sync-plugin.bat handles the locked-DLL case (aborts before xcopy if
        // DLL exists + editor running). We forward to it so source still gets
        // synced when DLL doesn't exist yet (first launch). Bat will abort if
        // unsafe; we just capture exit.
        // For now: log SKIP-LIKELY and let sync-plugin make the call.
        console.log(yellow(`  [WARN]`) + ` ${t} — editor running; sync-plugin.bat will skip if DLL is locked`);
      }
      const code = runSyncPlugin(t);
      if (code === 0) console.log(green('  [OK]') + ` ${t}`);
      else console.log(red(`  [FAIL]`) + ` exit ${code} — ${t}`);
    }
    console.log(green(`[${stamp()}]`) + ' Sync complete. ' + dim('Watching for changes... (Ctrl+C to stop)'));
    syncInProgress = false;
    if (queuedSyncAfterCurrent) {
      queuedSyncAfterCurrent = false;
      // Re-arm if changes were pending OR new ones arrived.
      if (pendingChanges.size > 0) flushAndSync();
    }
  };

  const onEvent = (eventType, filename) => {
    if (!filename) return;
    if (EXCLUDE_RE.test(filename)) return;
    pendingChanges.add(filename);
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      flushAndSync();
    }, flags.debounceMs);
  };

  const watcher = fsWatch(PLUGIN_SRC_DIR, { recursive: true }, onEvent);
  watcher.on('error', (e) => {
    console.error(red('[ERROR]') + ` Watcher error: ${e.message}`);
  });

  // Keep the process alive on SIGINT to print a clean exit message.
  process.on('SIGINT', () => {
    console.log('');
    console.log(yellow(`[${stamp()}]`) + ' Stopping watcher...');
    watcher.close();
    process.exit(0);
  });

  // Hold the event loop open. fsWatch keeps it open by default but be explicit:
  return new Promise(() => {/* never resolves; stopped via SIGINT */});
}

// ─── Main ───────────────────────────────────────────────────────────

/**
 * Resolve targets and gather every per-target metric. Shared by both printers
 * so text and JSON always report the same verdicts from the same inputs.
 * Returns { error, targetSelection } on a config failure.
 */
function gatherAllTargets(flags) {
  const targetSelection = resolveTargetSelection(flags);
  if (!targetSelectionIsUsable(targetSelection)) {
    return { error: selectionErrorMessage(targetSelection), targetSelection };
  }

  const repoSrcInfo = newestMtimeSec(PLUGIN_SRC_DIR);
  const headInfo = getHeadPluginCommitInfo();
  // Filesystem newest mtime is the comparison reference: xcopy preserves source
  // mtimes, so deployed files carry the repo file's mtime. See D138-FIX2 for
  // why the old Math.max with the commit time produced false staleness.
  const repoSrcMtime = repoSrcInfo.mtimeSec;
  const repoSrcLabel = `${repoSrcInfo.fileCount} files; HEAD plugin/Source commit ${headInfo.sha}`;
  const editorProcs = listEditorProcesses();
  const activeMcpRoot = readActiveMcpProjectRoot();

  let incomingState = null;
  let markerWarning = null;
  try {
    incomingState = computeIncomingState(REPO_ROOT);
  } catch (e) {
    markerWarning = `Marker comparison disabled: ${e.message}`;
  }
  // computeIncomingState already hashed the repo tree for the marker contract;
  // reuse it so a run pays for one walk, and only hash again if that failed.
  const repoSourceHash = incomingState?.sourceHash ?? hashPluginTree(REPO_PLUGIN_DIR);

  const ctx = { repoSrcMtime, repoSourceHash, editorProcs, activeMcpRoot, incomingState };
  const results = targetSelection.candidates.map((candidate) => gatherTargetMetrics(
    { uprojectPath: candidate.uprojectPath, alias: candidate.targetAlias || null },
    ctx,
  ));

  return { targetSelection, results, repoSrcMtime, repoSrcLabel, headInfo, editorProcs, activeMcpRoot, markerWarning };
}

/** Print exactly one JSON document to stdout and nothing else. */
function runJsonMode(flags) {
  if (flags.autoSync || flags.regenIdx !== null) {
    return emitJsonError('--auto-sync and --regenerate-mcp-json are not available with --json');
  }
  const gathered = gatherAllTargets(flags);
  if (gathered.error) return emitJsonError(gathered.error);
  const exitCode = exitCodeForResults(gathered.results);
  // A marker-overlay failure disables that overlay for every target in this
  // run (computeIncomingState runs once, not per target), so it is reported
  // once per target, named — mirrors the single [WARN] text mode prints, but
  // attributed so a JSON consumer knows which rows it affects.
  const warnings = gathered.markerWarning
    ? gathered.results.map((r) => `${r.alias || r.uprojectPath}: ${gathered.markerWarning}`)
    : [];
  const report = buildJsonReport(gathered.results, {
    profile: gathered.targetSelection.profile?.name || null,
    exitCode,
    warnings,
  });
  console.log(JSON.stringify(report, null, 2));
  return exitCode;
}

function emitJsonError(message) {
  const doc = buildJsonErrorReport(message);
  console.log(JSON.stringify(doc, null, 2));
  return doc.exitCode;
}

function runTextMode(flags) {
  const gathered = gatherAllTargets(flags);
  if (gathered.error) {
    printTargetSelectionError(gathered.targetSelection);
    return 2;
  }
  const { targetSelection, results, repoSrcMtime, repoSrcLabel, headInfo, editorProcs, activeMcpRoot, markerWarning } = gathered;
  if (markerWarning) console.error(yellow('[WARN]') + ` ${markerWarning}`);

  console.log(bold('=== UEMCP verify-deploy ==='));
  console.log(`Repo                : ${REPO_ROOT}`);
  console.log(`Repo plugin source  : ${formatTime(repoSrcMtime)} ${dim('(' + repoSrcLabel + ')')}`);
  console.log(`HEAD plugin/Source  : ${headInfo.sha} ${dim(headInfo.subject)}`);
  printTargetSelectionHeader(targetSelection);
  printTargetSelectionWarnings(targetSelection);
  console.log(`Active .mcp.json    : ${activeMcpRoot ? activeMcpRoot : '(none / not found)'}`);
  console.log(`Editor processes    : ${editorProcs.length}${editorProcs.length > 0 ? dim(' — ' + editorProcs.map((e) => `pid ${e.pid}`).join(', ')) : ''}`);
  const targetUprojNorms = new Set(results.map((r) => normalizePath(r.uprojectPath)));
  const orphanEditors = editorProcs.filter((p) =>
    p.uprojectPath && !targetUprojNorms.has(normalizePath(p.uprojectPath))
  );
  if (orphanEditors.length > 0) {
    console.log(yellow('[WARN]') + ` Editor running against workspace not in targets list:`);
    for (const e of orphanEditors) console.log(`        pid ${e.pid} → ${e.uprojectPath}`);
    console.log(`        Add it to ${targetSelection.targetsPath} to track its deploy state.`);
  }
  console.log('');
  console.log(bold('Targets:'));
  for (let i = 0; i < results.length; i++) printSummaryLine(i, results[i]);

  if (!flags.quiet) {
    const nonSync = results.filter((r) => r.verdict.verdict !== 'SYNC' || r.matchedEditors.length > 0);
    if (nonSync.length > 0 || results.length <= 3) {
      console.log('');
      console.log(bold('Details:'));
      for (let i = 0; i < results.length; i++) {
        if (results[i].verdict.verdict !== 'SYNC' || results.length <= 3) {
          printTargetDetail(i, results[i], repoSrcMtime, repoSrcLabel);
        }
      }
    }
  }

  const actionCode = runTextActions(flags, results);
  if (actionCode !== 0) return actionCode;

  const exitCode = exitCodeForResults(results);
  console.log('');
  if (exitCode !== 0) {
    console.log(red(bold('VERDICT: NOT-SYNC')) + ` — ${results.filter((r) => r.verdict.verdict !== 'SYNC').length} of ${results.length} target(s) need attention.`);
    return 1;
  }
  console.log(green(bold('VERDICT: ALL-SYNC')) + ` — ${results.length} target(s) match repo source.`);
  return 0;
}

/** --auto-sync and --regenerate-mcp-json. Returns a non-zero code only on failure. */
function runTextActions(flags, results) {
  if (flags.autoSync) {
    console.log('');
    console.log(bold('--auto-sync: running sync-plugin.bat for stale targets...'));
    const stale = results.filter((r) => ['NEEDS-SYNC', 'NEEDS-DEPLOY'].includes(r.verdict.verdict));
    if (stale.length === 0) console.log(dim('  (no targets need sync)'));
    for (const t of stale) {
      if (t.matchedEditors.length > 0) {
        console.log(yellow('  [SKIP]') + ` ${t.uprojectPath} — editor locked (close it first)`);
        continue;
      }
      const code = runSyncPlugin(t.uprojectPath);
      if (code === 0) console.log(green('  [OK]') + ` Synced: ${t.uprojectPath}`);
      else console.log(red('  [FAIL]') + ` sync-plugin.bat exited ${code}: ${t.uprojectPath}`);
    }
    console.log(dim('  Note: sync-plugin.bat propagates source only. Run Build.bat next to rebuild the DLL.'));
  }

  if (flags.regenIdx !== null) {
    console.log('');
    console.log(bold(`--regenerate-mcp-json ${flags.regenIdx}:`));
    if (!Number.isInteger(flags.regenIdx) || flags.regenIdx < 1 || flags.regenIdx > results.length) {
      console.error(red('[ERROR]') + ` Index out of range (1..${results.length}): ${flags.regenIdx}`);
      return 2;
    }
    const rc = regenerateMcpJson(results[flags.regenIdx - 1].uprojectPath);
    if (rc !== 0) return rc;
  }
  return 0;
}

function main() {
  const flags = parseArgs(process.argv.slice(2));
  if (flags.help) { printHelp(); return 0; }
  if (flags.watch) return runWatchMode(flags);
  if (flags.json) return runJsonMode(flags);
  return runTextMode(flags);
}

// Entry-point detection: only run main() when executed directly, not when
// imported by tests. main() returns a Promise in --watch mode (never
// resolves; SIGINT terminates), and a number in normal mode.
if (process.argv[1] && resolve(process.argv[1]) === resolve(__filename)) {
  const r = main();
  if (typeof r === 'number') process.exit(r);
  // In watch mode, we hold the event loop open via the FS watcher; nothing
  // to do here. SIGINT handler in runWatchMode calls process.exit(0).
}
