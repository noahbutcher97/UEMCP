import { spawn as defaultSpawn } from 'node:child_process';
import { isAbsolute, posix, win32 } from 'node:path';

export class ProcessRunnerError extends Error {
  constructor(message, code = 'PROCESS_RUNNER_ERROR', details = {}) {
    super(message);
    this.name = 'ProcessRunnerError';
    this.code = code;
    this.details = details;
  }
}

function absolutePath(value) {
  return typeof value === 'string' && (isAbsolute(value) || win32.isAbsolute(value) || posix.isAbsolute(value));
}

function elapsed(clock, started) {
  return Math.max(0, Number(clock()) - started);
}

function killDirectChild(child, signal) {
  try {
    child.kill(signal);
  } catch {
    // The child may already have exited.
  }
}

export async function terminateProcessTree(child, {
  spawnImpl = defaultSpawn,
  platform = process.platform,
  systemRoot = process.env.SystemRoot || process.env.WINDIR,
  signal = 'SIGKILL',
  timeoutMs = 5_000,
} = {}) {
  if (!Number.isSafeInteger(child?.pid) || child.pid <= 0) return;
  if (typeof spawnImpl !== 'function' || typeof signal !== 'string'
    || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new ProcessRunnerError('process-tree termination options are invalid', 'INVALID_TERMINATION_OPTIONS');
  }
  if (platform !== 'win32') {
    killDirectChild(child, signal);
    return;
  }
  if (typeof systemRoot !== 'string'
    || !/^[A-Za-z]:[\\/]/.test(systemRoot)) {
    killDirectChild(child, signal);
    return;
  }
  const normalizedRoot = win32.resolve(systemRoot);
  const taskkill = win32.resolve(normalizedRoot, 'System32', 'taskkill.exe');
  await new Promise(resolvePromise => {
    let killer;
    let settled = false;
    let timer;
    const finish = fallback => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (fallback) killDirectChild(child, signal);
      resolvePromise();
    };
    try {
      killer = spawnImpl(taskkill, ['/PID', String(child.pid), '/T', '/F'], {
        env: { SystemRoot: normalizedRoot, WINDIR: normalizedRoot },
        shell: false,
        windowsHide: true,
        stdio: 'ignore',
      });
    } catch {
      finish(true);
      return;
    }
    killer.once('error', () => finish(true));
    killer.once('close', code => finish(code !== 0));
    timer = setTimeout(() => {
      killDirectChild(killer, 'SIGKILL');
      finish(true);
    }, timeoutMs);
    timer.unref?.();
  });
}

function defaultKillTree(child, { spawnImpl = defaultSpawn } = {}) {
  return terminateProcessTree(child, { spawnImpl });
}

export function createProcessRunner({
  spawnImpl = defaultSpawn,
  clock = Date.now,
  killTree,
  defaultTimeoutMs = 30_000,
  defaultOutputLimitBytes = 1024 * 1024,
} = {}) {
  if (typeof spawnImpl !== 'function') throw new ProcessRunnerError('spawnImpl must be a function');
  if (typeof clock !== 'function') throw new ProcessRunnerError('clock must be a function');
  const terminate = killTree ?? (child => defaultKillTree(child, { spawnImpl }));

  return Object.freeze({
    async run(executable, args, {
      cwd,
      env,
      timeoutMs = defaultTimeoutMs,
      outputLimitBytes = defaultOutputLimitBytes,
      stdin = null,
    } = {}) {
      if (!absolutePath(executable)) throw new ProcessRunnerError('executable must be an absolute path', 'INVALID_EXECUTABLE');
      if (!Array.isArray(args) || !args.every(arg => typeof arg === 'string')) {
        throw new ProcessRunnerError('args must be an array of strings', 'INVALID_ARGUMENTS');
      }
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new ProcessRunnerError('timeoutMs must be a positive integer');
      if (!Number.isSafeInteger(outputLimitBytes) || outputLimitBytes <= 0) throw new ProcessRunnerError('outputLimitBytes must be a positive integer');
      if (cwd !== undefined && cwd !== null && !absolutePath(cwd)) throw new ProcessRunnerError('cwd must be absolute when supplied');
      if (env !== undefined && (env === null || typeof env !== 'object' || Array.isArray(env))) {
        throw new ProcessRunnerError('env must be an object when supplied');
      }

      const started = Number(clock());
      return new Promise(resolvePromise => {
        let child;
        let timer;
        let killFallbackTimer;
        let terminalStatus = null;
        let killStarted = false;
        let settled = false;
        const stdoutChunks = [];
        const stderrChunks = [];
        let stdoutBytes = 0;
        let stderrBytes = 0;
        let stdoutDiscardedBytes = 0;
        let stderrDiscardedBytes = 0;

        const result = (status, exitCode = null, signal = null) => ({
          status,
          exitCode,
          signal,
          stdout: Buffer.concat(stdoutChunks).toString('utf8'),
          stderr: Buffer.concat(stderrChunks).toString('utf8'),
          stdoutDiscardedBytes,
          stderrDiscardedBytes,
          durationMs: elapsed(clock, started),
        });

        const settle = (status, exitCode = null, signal = null) => {
          if (settled) return;
          settled = true;
          if (timer) clearTimeout(timer);
          if (killFallbackTimer) clearTimeout(killFallbackTimer);
          resolvePromise(result(status, exitCode, signal));
        };

        const terminateOnce = status => {
          if (terminalStatus === null) terminalStatus = status;
          if (killStarted || !child) return;
          killStarted = true;
          Promise.resolve(terminate(child)).catch(() => {
            try {
              child.kill('SIGKILL');
            } catch {
              // The child may already have exited.
            }
          });
          killFallbackTimer = setTimeout(() => settle(terminalStatus), 5_000);
          killFallbackTimer.unref?.();
        };

        const capture = (chunk, stream) => {
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          const used = stream === 'stdout' ? stdoutBytes : stderrBytes;
          const remaining = Math.max(0, outputLimitBytes - used);
          const kept = bytes.subarray(0, remaining);
          const discarded = bytes.byteLength - kept.byteLength;
          if (stream === 'stdout') {
            if (kept.byteLength) stdoutChunks.push(kept);
            stdoutBytes += kept.byteLength;
            stdoutDiscardedBytes += discarded;
          } else {
            if (kept.byteLength) stderrChunks.push(kept);
            stderrBytes += kept.byteLength;
            stderrDiscardedBytes += discarded;
          }
          if (discarded > 0) terminateOnce('output_limit');
        };

        try {
          child = spawnImpl(executable, args, {
            cwd: cwd ?? undefined,
            env: env ?? process.env,
            shell: false,
            windowsHide: true,
            stdio: ['pipe', 'pipe', 'pipe'],
          });
        } catch {
          settle('spawn_failed');
          return;
        }

        child.stdout?.on('data', chunk => capture(chunk, 'stdout'));
        child.stderr?.on('data', chunk => capture(chunk, 'stderr'));
        child.once('error', () => settle('spawn_failed'));
        child.once('close', (code, signal) => settle(terminalStatus ?? 'exited', code, signal));

        timer = setTimeout(() => terminateOnce('timed_out'), timeoutMs);
        timer.unref?.();

        if (child.stdin) {
          child.stdin.once('error', () => {});
          if (stdin !== null && stdin !== undefined) child.stdin.write(stdin);
          child.stdin.end();
        }
      });
    },
  });
}
