import * as defaultFs from 'node:fs/promises';
import { dirname, join, parse, resolve } from 'node:path';

import { fingerprintPath } from './fingerprints.mjs';

const AUTHENTICODE_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$module = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\Modules\Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1'
Import-Module -Name $module -Force
$signature = Microsoft.PowerShell.Security\Get-AuthenticodeSignature -LiteralPath $env:UEMCP_AUTHENTICODE_TARGET
$name = $null
$thumbprint = $null
if ($null -ne $signature.SignerCertificate) {
  $name = $signature.SignerCertificate.GetNameInfo([System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName, $false)
  $thumbprint = $signature.SignerCertificate.Thumbprint
}
[ordered]@{ status = [string]$signature.Status; signer_name = $name; thumbprint = $thumbprint } | ConvertTo-Json -Compress
`.trim();

const METADATA_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$target = $env:UEMCP_METADATA_TARGET
$maxStreams = [int]$env:UEMCP_MAX_STREAMS
$maxBytes = [long]$env:UEMCP_MAX_STREAM_BYTES
$item = Get-Item -LiteralPath $target -Force
$acl = Get-Acl -LiteralPath $target
$streams = @(Get-Item -LiteralPath $target -Stream * -ErrorAction Stop | Where-Object { $_.Stream -ne ':$DATA' -and $_.Stream -ne '::$DATA' } | Sort-Object Stream)
if ($streams.Count -gt $maxStreams) { throw 'STREAM_COUNT_LIMIT' }
$streamRows = @()
$streamBytes = [long]0
foreach ($stream in $streams) {
  $bytes = [System.IO.File]::ReadAllBytes($stream.FileName + ':' + $stream.Stream)
  $streamBytes += $bytes.LongLength
  if ($streamBytes -gt $maxBytes) { throw 'STREAM_BYTE_LIMIT' }
  $hash = [Convert]::ToHexString([System.Security.Cryptography.SHA256]::HashData($bytes)).ToLowerInvariant()
  $streamRows += [ordered]@{ name = $stream.Stream; size = $bytes.LongLength; sha256 = $hash }
}
$metadata = [ordered]@{
  owner = $acl.Owner
  sddl = $acl.Sddl
  creation_time_utc_ticks = $item.CreationTimeUtc.Ticks
  attributes = [int64]$item.Attributes
  streams = $streamRows
}
$json = $metadata | ConvertTo-Json -Compress -Depth 8
$hashBytes = [System.Security.Cryptography.SHA256]::HashData([System.Text.Encoding]::UTF8.GetBytes($json))
[ordered]@{
  metadata_sha256 = [Convert]::ToHexString($hashBytes).ToLowerInvariant()
  stream_count = $streams.Count
  stream_bytes = $streamBytes
} | ConvertTo-Json -Compress
`.trim();

const REPLACE_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
try {
  [System.IO.File]::Replace($env:UEMCP_REPLACEMENT_PATH, $env:UEMCP_DESTINATION_PATH, $null, $false)
  [ordered]@{ status = 'replaced' } | ConvertTo-Json -Compress
} catch {
  [ordered]@{ status = 'failed'; error_code = $_.Exception.GetType().FullName } | ConvertTo-Json -Compress
  exit 1
}
`.trim();

export class WindowsNativeError extends Error {
  constructor(message, code = 'WINDOWS_NATIVE_FAILED', details = {}) {
    super(message);
    this.name = 'WindowsNativeError';
    this.code = code;
    this.details = details;
  }
}

function powershellPath(systemRoot) {
  if (typeof systemRoot !== 'string' || systemRoot.trim() === '') {
    throw new WindowsNativeError('SystemRoot is required', 'SYSTEM_ROOT_UNAVAILABLE');
  }
  return resolve(join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'));
}

function powershellArgs() {
  return ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '-'];
}

function minimalEnvironment(systemRoot, extra) {
  return {
    SystemRoot: resolve(systemRoot),
    WINDIR: resolve(systemRoot),
    PSModulePath: join(resolve(systemRoot), 'System32', 'WindowsPowerShell', 'v1.0', 'Modules'),
    ...extra,
  };
}

function parseSingleJson(result, expectedKeys) {
  if (result?.status !== 'exited' || result.exitCode !== 0 || typeof result.stderr !== 'string' || result.stderr.length !== 0) {
    throw new WindowsNativeError('bounded PowerShell helper did not exit cleanly');
  }
  const stdout = typeof result.stdout === 'string' ? result.stdout.trim() : '';
  if (stdout === '' || stdout.includes('\n') || stdout.includes('\r')) {
    throw new WindowsNativeError('PowerShell helper returned malformed or extra output');
  }
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new WindowsNativeError('PowerShell helper returned invalid JSON');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new WindowsNativeError('PowerShell helper returned a non-object');
  }
  const keys = Object.keys(parsed).sort();
  const expected = [...expectedKeys].sort();
  if (JSON.stringify(keys) !== JSON.stringify(expected)) {
    throw new WindowsNativeError('PowerShell helper returned an unexpected schema');
  }
  return parsed;
}

async function assertRegularSinglePath(path, { allowedRoots, fsImpl, allowMultipleLinks = false }) {
  const fingerprint = await fingerprintPath(path, { allowedRoots, fsImpl });
  if (!fingerprint.exists || fingerprint.kind !== 'file' || fingerprint.link_kind !== 'none') {
    throw new WindowsNativeError('Windows-native helper target must be a regular non-linked file', 'UNSAFE_PATH_TYPE');
  }
  if (!allowMultipleLinks && fingerprint.link_count !== 1) {
    throw new WindowsNativeError('Windows-native helper target must have one hard link', 'UNSAFE_LINK_COUNT');
  }
  return fingerprint;
}

export async function inspectAuthenticode(executable, {
  runner,
  systemRoot = process.env.SystemRoot || process.env.WINDIR,
  expectedSignerNames = [],
  allowedRoots = [dirname(resolve(executable))],
  fsImpl = defaultFs,
} = {}) {
  if (!runner?.run) throw new WindowsNativeError('runner is required');
  let fingerprint;
  try {
    fingerprint = await assertRegularSinglePath(executable, { allowedRoots, fsImpl, allowMultipleLinks: true });
    const result = await runner.run(powershellPath(systemRoot), powershellArgs(), {
      env: minimalEnvironment(systemRoot, { UEMCP_AUTHENTICODE_TARGET: fingerprint.canonical_path }),
      stdin: `${AUTHENTICODE_SCRIPT}\n\n`,
      timeoutMs: 15_000,
      outputLimitBytes: 8 * 1024,
    });
    const parsed = parseSingleJson(result, ['status', 'signer_name', 'thumbprint']);
    const signerName = parsed.signer_name === null ? null : String(parsed.signer_name);
    const thumbprint = parsed.thumbprint === null ? null : String(parsed.thumbprint).toUpperCase();
    const signatureValid = String(parsed.status).toLowerCase() === 'valid';
    const signerAllowed = expectedSignerNames.length === 0
      || (signerName !== null && expectedSignerNames.some(name => name.localeCompare(signerName, undefined, { sensitivity: 'accent' }) === 0));
    const thumbprintValid = thumbprint === null || /^[0-9A-F]{2,128}$/.test(thumbprint);
    return {
      status: signatureValid && signerAllowed && thumbprintValid ? 'valid' : 'invalid',
      signer_name: signerName,
      thumbprint: thumbprintValid ? thumbprint : null,
    };
  } catch {
    return { status: 'unavailable', signer_name: null, thumbprint: null };
  }
}

export async function fingerprintWindowsFileMetadata(path, {
  runner,
  systemRoot = process.env.SystemRoot || process.env.WINDIR,
  maxStreams = 64,
  maxStreamBytes = 16 * 1024 * 1024,
  allowedRoots = [dirname(resolve(path))],
  fsImpl = defaultFs,
} = {}) {
  if (!runner?.run) throw new WindowsNativeError('runner is required');
  if (!Number.isSafeInteger(maxStreams) || maxStreams < 0) throw new WindowsNativeError('maxStreams is invalid');
  if (!Number.isSafeInteger(maxStreamBytes) || maxStreamBytes < 0) throw new WindowsNativeError('maxStreamBytes is invalid');
  const fingerprint = await assertRegularSinglePath(path, { allowedRoots, fsImpl, allowMultipleLinks: false });
  const result = await runner.run(powershellPath(systemRoot), powershellArgs(), {
    env: minimalEnvironment(systemRoot, {
      UEMCP_METADATA_TARGET: fingerprint.canonical_path,
      UEMCP_MAX_STREAMS: String(maxStreams),
      UEMCP_MAX_STREAM_BYTES: String(maxStreamBytes),
    }),
    stdin: `${METADATA_SCRIPT}\n\n`,
    timeoutMs: 30_000,
    outputLimitBytes: 8 * 1024,
  });
  const parsed = parseSingleJson(result, ['metadata_sha256', 'stream_count', 'stream_bytes']);
  if (!/^[0-9a-f]{64}$/.test(parsed.metadata_sha256)
    || !Number.isSafeInteger(parsed.stream_count)
    || !Number.isSafeInteger(parsed.stream_bytes)
    || parsed.stream_count < 0
    || parsed.stream_bytes < 0
    || parsed.stream_count > maxStreams
    || parsed.stream_bytes > maxStreamBytes) {
    throw new WindowsNativeError('metadata helper returned invalid aggregate evidence');
  }
  return {
    metadata_sha256: parsed.metadata_sha256,
    stream_count: parsed.stream_count,
    stream_bytes: parsed.stream_bytes,
  };
}

export async function replaceFilePreservingMetadata({
  replacementPath,
  destinationPath,
  runner,
  systemRoot = process.env.SystemRoot || process.env.WINDIR,
  fsImpl = defaultFs,
}) {
  if (!runner?.run) throw new WindowsNativeError('runner is required');
  const replacement = resolve(replacementPath);
  const destination = resolve(destinationPath);
  if (dirname(replacement).toLowerCase() !== dirname(destination).toLowerCase()
    || parse(replacement).root.toLowerCase() !== parse(destination).root.toLowerCase()) {
    throw new WindowsNativeError('replacement and destination must share one directory and volume', 'REPLACEMENT_BOUNDARY_VIOLATION');
  }
  await assertRegularSinglePath(replacement, { allowedRoots: [dirname(destination)], fsImpl });
  await assertRegularSinglePath(destination, { allowedRoots: [dirname(destination)], fsImpl });
  const result = await runner.run(powershellPath(systemRoot), powershellArgs(), {
    env: minimalEnvironment(systemRoot, {
      UEMCP_REPLACEMENT_PATH: replacement,
      UEMCP_DESTINATION_PATH: destination,
    }),
    stdin: `${REPLACE_SCRIPT}\n\n`,
    timeoutMs: 30_000,
    outputLimitBytes: 8 * 1024,
  });
  const parsed = parseSingleJson(result, ['status']);
  if (parsed.status !== 'replaced') throw new WindowsNativeError('metadata-preserving replacement failed');
  return { status: 'replaced' };
}

export const WINDOWS_NATIVE_SCRIPTS = Object.freeze({
  authenticode: AUTHENTICODE_SCRIPT,
  metadata: METADATA_SCRIPT,
  replace: REPLACE_SCRIPT,
});
