import { spawn as defaultSpawn } from 'node:child_process';
import { PassThrough } from 'node:stream';

import { JSONRPCMessageSchema } from '@modelcontextprotocol/sdk/types.js';

export const DEFAULT_STDOUT_LIMIT_BYTES = 8 * 1024 * 1024;
export const DEFAULT_STDERR_LIMIT_BYTES = 64 * 1024;

export class BoundedStdioTransportError extends Error {
  constructor(message, code = 'STDIO_TRANSPORT_FAILED') {
    super(message);
    this.name = 'BoundedStdioTransportError';
    this.code = code;
  }
}

function validateLimit(value, maximum, label) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new BoundedStdioTransportError(`${label} must be a positive integer no larger than ${maximum}`, 'INVALID_STDIO_LIMIT');
  }
  return value;
}

function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise(resolvePromise => {
    const timer = setTimeout(resolvePromise, timeoutMs);
    timer.unref?.();
    child.once('close', () => {
      clearTimeout(timer);
      resolvePromise();
    });
  });
}

export class BoundedStdioClientTransport {
  constructor(server, {
    stdoutLimitBytes = DEFAULT_STDOUT_LIMIT_BYTES,
    stderrLimitBytes = DEFAULT_STDERR_LIMIT_BYTES,
    spawnImpl = defaultSpawn,
    closeGraceMs = 250,
  } = {}) {
    if (!server || typeof server.command !== 'string' || server.command.trim() === '') {
      throw new BoundedStdioTransportError('stdio server command is required', 'INVALID_STDIO_SERVER');
    }
    if (!Array.isArray(server.args ?? []) || !(server.args ?? []).every(arg => typeof arg === 'string')) {
      throw new BoundedStdioTransportError('stdio server args must be strings', 'INVALID_STDIO_SERVER');
    }
    if (typeof spawnImpl !== 'function') throw new BoundedStdioTransportError('spawnImpl must be a function', 'INVALID_STDIO_SERVER');
    if (!Number.isSafeInteger(closeGraceMs) || closeGraceMs <= 0 || closeGraceMs > 5_000) {
      throw new BoundedStdioTransportError('closeGraceMs is invalid', 'INVALID_STDIO_LIMIT');
    }
    this._server = server;
    this._stdoutLimitBytes = validateLimit(stdoutLimitBytes, DEFAULT_STDOUT_LIMIT_BYTES, 'stdoutLimitBytes');
    this._stderrLimitBytes = validateLimit(stderrLimitBytes, DEFAULT_STDERR_LIMIT_BYTES, 'stderrLimitBytes');
    this._spawn = spawnImpl;
    this._closeGraceMs = closeGraceMs;
    this._stderrStream = new PassThrough();
    this._stdoutChunks = [];
    this._pendingStdoutBytes = 0;
    this._stdoutBytes = 0;
    this._stderrBytes = 0;
    this._process = null;
    this._started = false;
    this._failed = false;
    this._closePromise = null;
  }

  get stderr() {
    return this._stderrStream;
  }

  get pid() {
    return this._process?.pid ?? null;
  }

  _fail(error) {
    if (this._failed) return;
    this._failed = true;
    this.onerror?.(error);
    void this.close();
  }

  _parseLine(lineBytes) {
    const end = lineBytes.at(-1) === 0x0d ? lineBytes.length - 1 : lineBytes.length;
    try {
      const message = JSONRPCMessageSchema.parse(JSON.parse(lineBytes.toString('utf8', 0, end)));
      this.onmessage?.(message);
    } catch (error) {
      this._fail(error);
    }
  }

  _handleStdout(value) {
    if (this._failed || this._closePromise) return;
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    this._stdoutBytes += chunk.length;
    if (this._stdoutBytes > this._stdoutLimitBytes) {
      this._fail(new BoundedStdioTransportError('stdio stdout limit exceeded', 'STDOUT_LIMIT_EXCEEDED'));
      return;
    }

    let start = 0;
    while (start < chunk.length) {
      const newline = chunk.indexOf(0x0a, start);
      if (newline === -1) break;
      const tail = chunk.subarray(start, newline);
      const line = this._stdoutChunks.length === 0
        ? tail
        : Buffer.concat([...this._stdoutChunks, tail], this._pendingStdoutBytes + tail.length);
      this._stdoutChunks = [];
      this._pendingStdoutBytes = 0;
      this._parseLine(line);
      if (this._failed) return;
      start = newline + 1;
    }
    if (start < chunk.length) {
      const remaining = Buffer.from(chunk.subarray(start));
      this._stdoutChunks.push(remaining);
      this._pendingStdoutBytes += remaining.length;
    }
  }

  _handleStderr(value) {
    if (this._failed || this._closePromise) return;
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    const remaining = Math.max(0, this._stderrLimitBytes - this._stderrBytes);
    if (remaining > 0) this._stderrStream.write(chunk.subarray(0, remaining));
    this._stderrBytes += chunk.length;
    if (this._stderrBytes > this._stderrLimitBytes) {
      this._fail(new BoundedStdioTransportError('stdio stderr limit exceeded', 'STDERR_LIMIT_EXCEEDED'));
    }
  }

  async start() {
    if (this._started) throw new BoundedStdioTransportError('stdio transport already started', 'STDIO_ALREADY_STARTED');
    this._started = true;
    return await new Promise((resolvePromise, rejectPromise) => {
      let spawned = false;
      let child;
      try {
        child = this._spawn(this._server.command, this._server.args ?? [], {
          env: { ...(this._server.env ?? {}) },
          stdio: ['pipe', 'pipe', 'pipe'],
          shell: false,
          windowsHide: process.platform === 'win32',
          ...(this._server.cwd ? { cwd: this._server.cwd } : {}),
        });
      } catch (error) {
        rejectPromise(error);
        return;
      }
      this._process = child;
      child.once('spawn', () => {
        spawned = true;
        resolvePromise();
      });
      child.once('error', error => {
        if (!spawned) rejectPromise(error);
        this._fail(error);
      });
      child.once('close', () => {
        if (this._process === child) this._process = null;
        this._stderrStream.end();
        this.onclose?.();
      });
      child.stdin?.on('error', error => this._fail(error));
      child.stdout?.on('data', chunk => this._handleStdout(chunk));
      child.stdout?.on('error', error => this._fail(error));
      child.stderr?.on('data', chunk => this._handleStderr(chunk));
      child.stderr?.on('error', error => this._fail(error));
    });
  }

  async send(message) {
    const stdin = this._process?.stdin;
    if (!stdin || this._closePromise) throw new BoundedStdioTransportError('stdio transport is not connected', 'STDIO_NOT_CONNECTED');
    const bytes = `${JSON.stringify(message)}\n`;
    await new Promise((resolvePromise, rejectPromise) => {
      stdin.write(bytes, error => {
        if (error) rejectPromise(error);
        else resolvePromise();
      });
    });
  }

  async close() {
    if (this._closePromise) return await this._closePromise;
    this._closePromise = (async () => {
      const child = this._process;
      if (child) {
        try {
          child.stdin?.end();
        } catch {
          // Ignore close races; termination below remains bounded.
        }
        await waitForExit(child, this._closeGraceMs);
        if (child.exitCode === null && child.signalCode === null) {
          try {
            child.kill('SIGTERM');
          } catch {
            // Ignore an already-exited child.
          }
          await waitForExit(child, this._closeGraceMs);
        }
        if (child.exitCode === null && child.signalCode === null) {
          try {
            child.kill('SIGKILL');
          } catch {
            // Ignore an already-exited child.
          }
          await waitForExit(child, this._closeGraceMs);
        }
      }
      this._stdoutChunks = [];
      this._pendingStdoutBytes = 0;
    })();
    return await this._closePromise;
  }
}
