// test-plugin-manifest.mjs — static validation of the UE plugin's manifest +
// build file, with NO engine build.
//
// Why this exists: UE 5.6 can't run on hosted CI, so the plugin's real
// compile/link is out of reach there (a self-hosted UE runner — deferred,
// see D164). This file gives the plugin a *structural* gate that runs in the
// hosted rotation on every push/PR: it catches a malformed UEMCP.uplugin,
// missing/mistyped required fields, manifest.json<->.uplugin version-lockstep
// drift (the convention in CLAUDE.md §Onboarding), and gross UEMCP.Build.cs
// breakage. The anonymous-namespace duplicate-symbol class is covered
// separately by test-anon-namespace-audit.mjs.
//
// No env needed — resolves repo paths from this file's own location, so it
// runs identically locally and in CI.
//
// Run: cd server && node test-plugin-manifest.mjs

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { TestRunner } from './test-helpers.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const UPLUGIN = join(REPO_ROOT, 'plugin', 'UEMCP', 'UEMCP.uplugin');
const MANIFEST = join(REPO_ROOT, 'manifest.json');
const BUILD_CS = join(REPO_ROOT, 'plugin', 'UEMCP', 'Source', 'UEMCP', 'UEMCP.Build.cs');

const runner = new TestRunner('plugin manifest + build-file static validation');

// ── 1. .uplugin parses + required fields present and correctly typed ──
// Returns the parsed object (or null if it didn't parse) for the lockstep check.
function validateUplugin(t) {
  t.assert(existsSync(UPLUGIN), 'UEMCP.uplugin exists');
  let data;
  try {
    data = JSON.parse(readFileSync(UPLUGIN, 'utf-8'));
    t.assert(true, 'UEMCP.uplugin is valid JSON');
  } catch (e) {
    t.assert(false, 'UEMCP.uplugin is valid JSON', e.message);
    return null;
  }

  t.assert(typeof data.FileVersion === 'number', 'uplugin.FileVersion is a number', `got ${typeof data.FileVersion}`);
  t.assert(typeof data.Version === 'number', 'uplugin.Version is a number', `got ${typeof data.Version}`);
  t.assert(typeof data.VersionName === 'string' && data.VersionName.length > 0, 'uplugin.VersionName is a non-empty string');
  t.assert(typeof data.FriendlyName === 'string' && data.FriendlyName.length > 0, 'uplugin.FriendlyName is a non-empty string');
  t.assert(Array.isArray(data.Modules) && data.Modules.length > 0, 'uplugin.Modules is a non-empty array');

  for (const [i, m] of (Array.isArray(data.Modules) ? data.Modules : []).entries()) {
    t.assert(typeof m.Name === 'string' && m.Name.length > 0, `uplugin.Modules[${i}].Name present`);
    t.assert(typeof m.Type === 'string' && m.Type.length > 0, `uplugin.Modules[${i}].Type present`);
    t.assert(typeof m.LoadingPhase === 'string' && m.LoadingPhase.length > 0, `uplugin.Modules[${i}].LoadingPhase present`);
  }
  return data;
}

// ── 2. Version lockstep — manifest.json.version === uplugin.VersionName ──
// CLAUDE.md §Onboarding: a manifest.json version bump must bump UEMCP.uplugin
// VersionName (string) in lockstep. This catches the drift the convention warns
// about, which is otherwise enforced only by operator discipline.
function validateVersionLockstep(t, uplugin) {
  if (!uplugin) {
    t.assert(false, 'version lockstep — skipped (uplugin did not parse)');
    return;
  }
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(MANIFEST, 'utf-8'));
  } catch (e) {
    t.assert(false, 'manifest.json is valid JSON', e.message);
    return;
  }
  t.assert(
    manifest.version === uplugin.VersionName,
    'manifest.json version === UEMCP.uplugin VersionName (lockstep convention)',
    `manifest=${manifest.version} uplugin.VersionName=${uplugin.VersionName}`
  );
}

// ── 3. .Build.cs gross-structure sanity (no compile — heuristic text checks) ──
function validateBuildCs(t) {
  t.assert(existsSync(BUILD_CS), 'UEMCP.Build.cs exists');
  if (!existsSync(BUILD_CS)) return;
  const src = readFileSync(BUILD_CS, 'utf-8');
  t.assert(/class\s+\w+\s*:\s*ModuleRules/.test(src), 'Build.cs declares a ModuleRules subclass');
  t.assert(/(Public|Private)DependencyModuleNames\.AddRange/.test(src), 'Build.cs declares ≥1 dependency-module array');
}

const uplugin = validateUplugin(runner);
validateVersionLockstep(runner, uplugin);
validateBuildCs(runner);

process.exit(runner.summary());
