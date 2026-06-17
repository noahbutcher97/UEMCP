import { spawnSync } from 'node:child_process';

import {
  extractUprojectFromCommandLine,
  normalizeComparisonPath,
} from './project-identity.mjs';

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
export function listEditorProcesses({ spawnSyncImpl = spawnSync } = {}) {
  const ps = spawnSyncImpl('powershell', [
    '-NoProfile',
    '-ExecutionPolicy', 'Bypass',
    '-Command',
    "Get-CimInstance Win32_Process -Filter \"Name LIKE 'UnrealEditor%'\" | " +
    "ForEach-Object { '{0}|{1}' -f $_.ProcessId, $_.CommandLine }",
  ], { encoding: 'utf8' });
  if (ps.status === 0) return parseEditorProcessLines(ps.stdout);

  const fallback = spawnSyncImpl('powershell', [
    '-NoProfile',
    '-ExecutionPolicy', 'Bypass',
    '-Command',
    "Get-Process -Name UnrealEditor* -ErrorAction SilentlyContinue | " +
    "ForEach-Object { '{0}|' -f $_.Id }",
  ], { encoding: 'utf8' });
  if (fallback.status !== 0) return [];
  return parseEditorProcessLines(fallback.stdout);
}

export function canonicalEditorProjectPath(editorProcess) {
  return editorProcess?.uprojectPath
    ? normalizeComparisonPath(editorProcess.uprojectPath)
    : null;
}
