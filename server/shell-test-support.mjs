import { existsSync } from 'node:fs';
import { win32 } from 'node:path';
import { spawnSync } from 'node:child_process';

// Git hooks run in Git Bash on Windows. PATH's bash.exe may instead be the
// Windows WSL launcher, which cannot syntax-check a Windows checkout path.
export function resolveTestBash({ platform = process.platform, env = process.env,
  exists = existsSync, run = spawnSync } = {}) {
  if (platform !== 'win32') return 'bash';
  const found = run('where.exe', ['git.exe'], { encoding: 'utf8', windowsHide: true });
  const candidates = [];
  for (const executable of (found.stdout || '').trim().split(/\r?\n/).filter(Boolean)) {
    let directory = win32.dirname(executable);
    for (let depth = 0; depth < 3; depth += 1) {
      candidates.push(win32.join(directory, 'bin', 'bash.exe'), win32.join(directory, 'usr', 'bin', 'bash.exe'));
      directory = win32.dirname(directory);
    }
  }
  for (const root of [env.ProgramFiles && win32.join(env.ProgramFiles, 'Git'),
    env.LOCALAPPDATA && win32.join(env.LOCALAPPDATA, 'Programs', 'Git')].filter(Boolean)) {
    candidates.push(win32.join(root, 'bin', 'bash.exe'));
  }
  return candidates.find(exists) ?? null;
}
