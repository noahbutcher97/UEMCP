#!/usr/bin/env node
// verify-deploy.mjs — Pre-dispatch deployment verification CLI.
//
// Reads .uemcp-targets.txt (repo root, gitignored, one .uproject path per
// line). For each target, reports whether the deployed UEMCP plugin is in
// sync with the repo source: SYNC / NEEDS-SYNC / NEEDS-BUILD / NEEDS-DEPLOY
// / MISSING. Surfaces editor-lock state (UnrealEditor.exe running with the
// target's .uproject in its CommandLine) so users don't invoke Build.bat
// against a locked DLL and silently no-op.
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
//   --targets <path>           override .uemcp-targets.txt path
//   --watch                    long-running file-watcher mode (Q3-C). Watches
//                              plugin/UEMCP/Source/ recursively; on change,
//                              debounces 500ms then runs sync-plugin.bat -y
//                              for each target. Run from setup-watcher.bat.
//   --help                     show usage
//
// Pure functions for verdict classification are exported for testing
// (test-verify-deploy.mjs).

import { readFileSync, statSync, readdirSync, existsSync, writeFileSync, watch as fsWatch } from 'node:fs';
import { join, dirname, resolve, sep, basename } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
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
} from './sync-plugin-helper.mjs';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(__filename), '..');
const PLUGIN_SRC_DIR = join(REPO_ROOT, 'plugin', 'UEMCP', 'Source');
const DEFAULT_TARGETS_FILE = join(REPO_ROOT, '.uemcp-targets.txt');
const MTIME_SLOP_SEC = 5;  // tolerance for filesystem mtime jitter on copy

// ─── ANSI colors (no dependency) ────────────────────────────────────
let useColor = process.stdout.isTTY;
const C = (code) => (s) => useColor ? `\x1b[${code}m${s}\x1b[0m` : s;
const red = C('31'), green = C('32'), yellow = C('33'), cyan = C('36'), bold = C('1'), dim = C('2');

// ─── Pure helpers (exported for tests) ──────────────────────────────

/** Parse .uemcp-targets.txt: strip comments, blank lines; return array of trimmed paths. */
export function parseTargetsFile(content) {
  return content.split(/\r?\n/)
    .map((line) => line.replace(/#.*$/, '').trim())
    .filter((line) => line.length > 0);
}

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

/** Classify a target's deploy state given gathered metrics. Pure function. */
export function classifyDeployState({
  pluginDirExists,
  deployedSrcMtime,
  deployedSrcFileCount,
  dllExists,
  dllMtime,
  repoSrcMtime,
}) {
  if (!pluginDirExists) return { verdict: 'MISSING', reason: 'No Plugins\\UEMCP at target' };
  if (deployedSrcFileCount === 0) return { verdict: 'MISSING-PARTIAL', reason: 'Plugin dir exists but Source/ is empty' };
  if (!dllExists) {
    // Source deployed but no DLL — needs Build.bat
    if (deployedSrcMtime + MTIME_SLOP_SEC < repoSrcMtime) {
      return { verdict: 'NEEDS-DEPLOY', reason: 'Source stale AND DLL missing — full sync + Build needed' };
    }
    return { verdict: 'NEEDS-BUILD', reason: 'Source synced but DLL not built' };
  }
  // Both source + DLL present
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
    // Plugin dir has content but no marker — pre-W-L deploy OR
    // setup-uemcp.bat first-install (which doesn't write a marker).
    // Either way, prompt the user to run sync-plugin.bat once to seed
    // the marker so future version-bump cache-busting can fire.
    return {
      verdict: 'NEEDS-SYNC',
      reason: 'No deploy marker — run sync-plugin.bat once to seed',
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
    };
  }
  // version-match → marker says deploy is up-to-date metadata-wise;
  // base verdict (SYNC / NEEDS-BUILD / NEEDS-SYNC from mtime check)
  // prevails.
  return baseVerdict;
}

/** Normalize a Windows path for comparison: lowercase + forward slashes + no trailing slash. */
export function normalizePath(p) {
  return resolve(p).replace(/\\/g, '/').toLowerCase().replace(/\/+$/, '');
}

/** Extract .uproject argument from a UnrealEditor CommandLine string. */
export function extractUprojectFromCommandLine(cmdLine) {
  if (!cmdLine) return null;
  // Quoted form: "...\\Foo.uproject"  OR unquoted form ending with .uproject
  const m = cmdLine.match(/"([^"]+\.uproject)"/i) || cmdLine.match(/(\S+\.uproject)/i);
  return m ? m[1] : null;
}

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
export function parseEditorProcessLines(stdout) {
  return String(stdout || '').split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const idx = line.indexOf('|');
      const pidText = idx >= 0 ? line.slice(0, idx) : line;
      const cmd = idx >= 0 ? line.slice(idx + 1) : '';
      const pid = parseInt(pidText, 10);
      if (!Number.isFinite(pid)) return null;
      return {
        pid,
        cmdLine: cmd,
        commandLineAvailable: cmd.length > 0,
        uprojectPath: extractUprojectFromCommandLine(cmd),
      };
    })
    .filter(Boolean);
}

/** Enumerate UnrealEditor* processes via PowerShell; return [{ pid, uprojectPath }]. */
export function listEditorProcesses() {
  const ps = spawnSync('powershell', [
    '-NoProfile',
    '-ExecutionPolicy', 'Bypass',
    '-Command',
    "Get-CimInstance Win32_Process -Filter \"Name LIKE 'UnrealEditor%'\" | " +
    "ForEach-Object { '{0}|{1}' -f $_.ProcessId, $_.CommandLine }",
  ], { encoding: 'utf8' });
  if (ps.status === 0) return parseEditorProcessLines(ps.stdout);

  // In sandboxed shells, CIM command-line introspection can be denied even
  // though Get-Process can still see UnrealEditor. Fall back so the report
  // does not falsely imply "no editor"; target attribution will be unknown.
  const fallback = spawnSync('powershell', [
    '-NoProfile',
    '-ExecutionPolicy', 'Bypass',
    '-Command',
    "Get-Process -Name UnrealEditor* -ErrorAction SilentlyContinue | " +
    "ForEach-Object { '{0}|' -f $_.Id }",
  ], { encoding: 'utf8' });
  if (fallback.status !== 0) return [];
  return parseEditorProcessLines(fallback.stdout);
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
  const projectName = basename(uprojectPath, '.uproject');
  const projectRoot = dirname(uprojectPath).replace(/\\/g, '/');
  const repoRootFwd = REPO_ROOT.replace(/\\/g, '/');
  const out = readFileSync(tmpl, 'utf8')
    .split('<UEMCP_REPO_PATH>').join(repoRootFwd)
    .split('<UNREAL_PROJECT_ROOT>').join(projectRoot)
    .split('<UNREAL_PROJECT_NAME>').join(projectName);
  // Validate JSON before writing.
  try { JSON.parse(out); } catch (e) {
    console.error(red('[ERROR]') + ` Generated .mcp.json invalid: ${e.message}`);
    return 1;
  }
  const dest = join(REPO_ROOT, '.mcp.json');
  writeFileSync(dest, out, 'utf8');
  console.log(green('[OK]') + ` Wrote ${dest}`);
  console.log(`  UNREAL_PROJECT_ROOT = ${projectRoot}`);
  console.log(`  UNREAL_PROJECT_NAME = ${projectName}`);
  return 0;
}

// ─── Per-target metrics gathering ───────────────────────────────────

function gatherTargetMetrics(uprojectPath, repoSrcMtime, editorProcs, activeMcpRoot, incomingState) {
  const targetDir = dirname(uprojectPath);
  const pluginDir = join(targetDir, 'Plugins', 'UEMCP');
  const deployedSrcDir = join(pluginDir, 'Source');
  const dllPath = join(pluginDir, 'Binaries', 'Win64', 'UnrealEditor-UEMCP.dll');

  const pluginDirExists = existsSync(pluginDir);
  const deployedSrcInfo = pluginDirExists ? newestMtimeSec(deployedSrcDir) : { mtimeSec: 0, fileCount: 0 };
  const dllExists = existsSync(dllPath);
  const dllMtime = dllExists ? Math.floor(statSync(dllPath).mtimeMs / 1000) : 0;

  const baseVerdict = classifyDeployState({
    pluginDirExists,
    deployedSrcMtime: deployedSrcInfo.mtimeSec,
    deployedSrcFileCount: deployedSrcInfo.fileCount,
    dllExists,
    dllMtime,
    repoSrcMtime,
  });

  // W-L marker overlay: read the deploy marker (if any), compare against repo
  // state, and downgrade SYNC verdicts to NEEDS-SYNC when the marker shows
  // version-mismatch OR is absent on a populated plugin dir. Catches the
  // class of deploys whose Source/ matches by mtime but whose UEMCP.uplugin
  // metadata is stale (or whose marker was never seeded).
  const marker = pluginDirExists ? readDeployMarker(pluginDir) : null;
  const markerVerdict = incomingState ? compareDeployMarker(marker, incomingState) : null;
  const verdict = applyMarkerVerdictOverlay(
    baseVerdict, marker, markerVerdict, incomingState,
    pluginDirExists, deployedSrcInfo.fileCount,
  );

  // Match running editors against this target by .uproject path (case-insensitive).
  const targetUprojNorm = normalizePath(uprojectPath);
  const matchedEditors = editorProcs.filter((p) =>
    p.uprojectPath && normalizePath(p.uprojectPath) === targetUprojNorm
  );

  // Match active .mcp.json UNREAL_PROJECT_ROOT against this target's parent dir.
  const targetParentNorm = normalizePath(targetDir);
  const mcpPointsHere = activeMcpRoot && normalizePath(activeMcpRoot) === targetParentNorm;

  return {
    uprojectPath,
    targetDir,
    pluginDir,
    deployedSrcMtime: deployedSrcInfo.mtimeSec,
    deployedSrcFileCount: deployedSrcInfo.fileCount,
    dllExists,
    dllMtime,
    verdict,
    baseVerdict,
    marker,
    markerVerdict,
    matchedEditors,
    mcpPointsHere,
    repoSrcMtime,
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

function printSummaryLine(idx, t, repoSrcMtime) {
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
    targetsFile: DEFAULT_TARGETS_FILE,
    watch: false,
    debounceMs: 500,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--auto-sync') flags.autoSync = true;
    else if (a === '--regenerate-mcp-json') flags.regenIdx = parseInt(argv[++i], 10);
    else if (a === '--quiet') flags.quiet = true;
    else if (a === '--no-color') useColor = false;
    else if (a === '--targets') flags.targetsFile = argv[++i];
    else if (a === '--watch') flags.watch = true;
    else if (a === '--debounce-ms') flags.debounceMs = parseInt(argv[++i], 10);
    else if (a === '--help' || a === '-h') flags.help = true;
    else { console.error(red('[ERROR]') + ` Unknown arg: ${a}`); process.exit(2); }
  }
  return flags;
}

function printHelp() {
  console.log(`verify-deploy.mjs — UEMCP pre-dispatch deployment verification.

Usage: node verify-deploy.mjs [flags]
   or: verify-deploy.bat [flags]
   or: setup-watcher.bat                  (--watch mode wrapper)

Reads .uemcp-targets.txt at repo root (one .uproject path per line; gitignored,
codename-safe). For each target, reports SYNC / NEEDS-SYNC / NEEDS-BUILD /
NEEDS-DEPLOY / MISSING. Surfaces UnrealEditor.exe processes locking each DLL.

Flags:
  --auto-sync                run sync-plugin.bat on stale targets (NEEDS-SYNC,
                             NEEDS-DEPLOY). Skips targets with editor lock.
  --regenerate-mcp-json N    rewrite repo-root .mcp.json for target N (1-based)
  --quiet                    only verdict line per target, no detail
  --no-color                 disable ANSI colors
  --targets <path>           use a different targets file
  --watch                    long-running mode: watch plugin/UEMCP/Source/ and
                             auto-sync to all targets on change (Q3-C).
                             Skips Binaries/, Intermediate/, *.tmp paths.
                             500ms debounce. Ctrl+C to stop.
  --debounce-ms N            override watch debounce window (default 500)
  --help                     show this message

Exit: 0 all SYNC; 1 any non-SYNC; 2 config error.`);
}

// ─── Watch mode (Q3-C) ──────────────────────────────────────────────

/** Long-running file watcher; debounces source changes and runs sync-plugin.bat per target. */
function runWatchMode(flags) {
  if (!existsSync(flags.targetsFile)) {
    console.error(red('[ERROR]') + ` Targets file not found: ${flags.targetsFile}`);
    return 2;
  }
  const targets = parseTargetsFile(readFileSync(flags.targetsFile, 'utf8'));
  if (targets.length === 0) {
    console.error(yellow('[WARN]') + ` No targets in ${flags.targetsFile}.`);
    return 2;
  }
  if (!existsSync(PLUGIN_SRC_DIR)) {
    console.error(red('[ERROR]') + ` Plugin source dir missing: ${PLUGIN_SRC_DIR}`);
    return 2;
  }

  const stamp = () => formatTime(Math.floor(Date.now() / 1000));

  console.log(bold('=== UEMCP setup-watcher (Q3-C auto-deploy) ==='));
  console.log(`Repo            : ${REPO_ROOT}`);
  console.log(`Watching        : ${PLUGIN_SRC_DIR}`);
  console.log(`Targets file    : ${flags.targetsFile}`);
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

function main() {
  const flags = parseArgs(process.argv.slice(2));
  if (flags.help) { printHelp(); return 0; }
  if (flags.watch) return runWatchMode(flags);

  // Targets file
  if (!existsSync(flags.targetsFile)) {
    console.error(red('[ERROR]') + ` Targets file not found: ${flags.targetsFile}`);
    console.error('  Create it with one .uproject path per line. Example:');
    console.error('    D:/UnrealProjects/5.6/MyProject/MyProject.uproject');
    return 2;
  }
  const targets = parseTargetsFile(readFileSync(flags.targetsFile, 'utf8'));
  if (targets.length === 0) {
    console.error(yellow('[WARN]') + ` No targets in ${flags.targetsFile}. Add .uproject paths and re-run.`);
    return 2;
  }

  // Repo-side metrics
  const repoSrcInfo = newestMtimeSec(PLUGIN_SRC_DIR);
  const headInfo = getHeadPluginCommitInfo();
  // Use filesystem newest mtime as the comparison reference. xcopy preserves
  // source mtimes (sync produces deployed files with mtime = repo file mtime),
  // so the right "is deployed up-to-date" reference is the actual file mtime.
  //
  // Pre-D138-FIX2 this was Math.max(repoSrcInfo.mtimeSec, headInfo.commitTime)
  // with the rationale "catches recently-pulled commits where mtimes got reset
  // to checkout time." But git pull sets file mtimes to checkout time (fresher
  // than the original commit time), so repoSrcInfo.mtimeSec >= headInfo.commitTime
  // for pulled commits — the max never helped that case. The max ONLY fired for
  // local-author commits (where commit time > file mtime because `git commit`
  // doesn't update file mtimes), and there it produced false-positive STALE
  // verdicts on just-synced targets. Empirically observed against a
  // just-synced target post-W-L: deployed src 14:26:47 == repo src 14:26:47
  // (xcopy preserved), but headInfo.commitTime 14:36:33 (D137 commit) made
  // repoSrcMtime jump forward by 9m 46s, falsely marking deployed as stale.
  // Dropping the max makes verify-deploy reflect what xcopy actually produces.
  const repoSrcMtime = repoSrcInfo.mtimeSec;
  const repoSrcLabel = `${repoSrcInfo.fileCount} files; HEAD plugin/Source commit ${headInfo.sha}`;

  // Process scan + active MCP root
  const editorProcs = listEditorProcesses();
  const activeMcpRoot = readActiveMcpProjectRoot();

  // Compute incoming repo state once for marker comparison (W-L / D138-FIX3).
  // If the helper throws (e.g., manifest.json missing), skip marker checks
  // entirely with a warning — verify-deploy still produces source/DLL verdicts.
  let incomingState = null;
  try {
    incomingState = computeIncomingState(REPO_ROOT);
  } catch (e) {
    console.error(yellow('[WARN]') + ` Marker comparison disabled: ${e.message}`);
  }

  // Gather per-target
  const results = targets.map((t) => gatherTargetMetrics(t, repoSrcMtime, editorProcs, activeMcpRoot, incomingState));

  // Header
  console.log(bold('=== UEMCP verify-deploy ==='));
  console.log(`Repo                : ${REPO_ROOT}`);
  console.log(`Repo plugin source  : ${formatTime(repoSrcMtime)} ${dim('(' + repoSrcLabel + ')')}`);
  console.log(`HEAD plugin/Source  : ${headInfo.sha} ${dim(headInfo.subject)}`);
  console.log(`Active .mcp.json    : ${activeMcpRoot ? activeMcpRoot : '(none / not found)'}`);
  console.log(`Editor processes    : ${editorProcs.length}${editorProcs.length > 0 ? dim(' — ' + editorProcs.map((e) => `pid ${e.pid}`).join(', ')) : ''}`);
  // List unmatched-but-active editors (running editors whose .uproject is not in targets list).
  const targetUprojNorms = new Set(results.map((r) => normalizePath(r.uprojectPath)));
  const orphanEditors = editorProcs.filter((p) =>
    p.uprojectPath && !targetUprojNorms.has(normalizePath(p.uprojectPath))
  );
  if (orphanEditors.length > 0) {
    console.log(yellow('[WARN]') + ` Editor running against workspace not in targets list:`);
    for (const e of orphanEditors) {
      console.log(`        pid ${e.pid} → ${e.uprojectPath}`);
    }
    console.log(`        Add it to ${flags.targetsFile} to track its deploy state.`);
  }
  console.log('');
  console.log(bold('Targets:'));
  for (let i = 0; i < results.length; i++) printSummaryLine(i, results[i], repoSrcMtime);

  // Detail block
  if (!flags.quiet) {
    const nonSync = results.filter((r) => r.verdict.verdict !== 'SYNC' || r.matchedEditors.length > 0);
    if (nonSync.length > 0 || results.length <= 3) {
      console.log('');
      console.log(bold('Details:'));
      for (let i = 0; i < results.length; i++) {
        // Print detail for non-SYNC OR if 3-or-fewer targets total.
        if (results[i].verdict.verdict !== 'SYNC' || results.length <= 3) {
          printTargetDetail(i, results[i], repoSrcMtime, repoSrcLabel);
        }
      }
    }
  }

  // Action: --auto-sync
  if (flags.autoSync) {
    console.log('');
    console.log(bold('--auto-sync: running sync-plugin.bat for stale targets...'));
    const stale = results.filter((r) =>
      ['NEEDS-SYNC', 'NEEDS-DEPLOY'].includes(r.verdict.verdict)
    );
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

  // Action: --regenerate-mcp-json
  if (flags.regenIdx !== null) {
    console.log('');
    console.log(bold(`--regenerate-mcp-json ${flags.regenIdx}:`));
    if (!Number.isInteger(flags.regenIdx) || flags.regenIdx < 1 || flags.regenIdx > results.length) {
      console.error(red('[ERROR]') + ` Index out of range (1..${results.length}): ${flags.regenIdx}`);
      return 2;
    }
    const t = results[flags.regenIdx - 1];
    const rc = regenerateMcpJson(t.uprojectPath);
    if (rc !== 0) return rc;
  }

  // Exit code
  const anyFailed = results.some((r) => r.verdict.verdict !== 'SYNC');
  console.log('');
  if (anyFailed) {
    console.log(red(bold('VERDICT: NOT-SYNC')) + ` — ${results.filter((r) => r.verdict.verdict !== 'SYNC').length} of ${results.length} target(s) need attention.`);
    return 1;
  }
  console.log(green(bold('VERDICT: ALL-SYNC')) + ` — ${results.length} target(s) match repo source.`);
  return 0;
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
