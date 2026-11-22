#Requires -Version 7.2
# Preview one retired output in an allocator-created UEMCP run. Supply the
# returned PreviewId to -Apply to remove that same, unchanged output.
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$RunRoot,
    [Parameter(Mandatory)][string]$Output,
    [ValidatePattern('^[0-9a-fA-F]{64}$')][string]$Apply,
    [int[]]$OwnerProcessId = @()
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

function Assert-PlainPath([string]$Path) {
    for ($part = $Path; $part; $part = [IO.Path]::GetDirectoryName($part)) {
        if ([IO.File]::GetAttributes($part) -band [IO.FileAttributes]::ReparsePoint) {
            throw "Linked path requires owner review: $part"
        }
    }
}

function Assert-Inactive {
    foreach ($ownerId in $OwnerProcessId) {
        if (Get-Process -Id $ownerId -ErrorAction SilentlyContinue) {
            throw "Owned process $ownerId is still running: $target"
        }
    }
    $reference = [regex]::Escape($target) + '(?=$|[\s"''\\,;])'
    $processes = Get-CimInstance Win32_Process -Property ProcessId,CommandLine,ExecutablePath
    foreach ($process in $processes) {
        if ($process.ProcessId -eq $PID) { continue }
        foreach ($value in @($process.CommandLine, $process.ExecutablePath)) {
            if ($value -and $value.Replace('/','\') -imatch $reference) {
                throw "Process $($process.ProcessId) references $target"
            }
        }
    }
}

function Assert-NoNamedStream([string]$Path) {
    $extra = @(Get-Item -LiteralPath $Path -Stream * -ErrorAction Stop |
        Where-Object Stream -ne ':$DATA')
    if ($extra.Count) { throw "Named stream requires owner review: $Path" }
}

function Get-Entry([IO.FileSystemInfo]$Item, [IO.FileStream]$LockedStream) {
    $protected = [IO.FileAttributes]'ReparsePoint,ReadOnly,Hidden,System'
    if ($Item.Attributes -band $protected) {
        throw "Linked or protected entry requires owner review: $($Item.FullName) ($($Item.Attributes))"
    }
    $size = 0L
    $digest = 'directory'
    if ($Item -is [IO.FileInfo]) {
        $size = $Item.Length
        $stream = $LockedStream
        if (!$stream) { $stream = [IO.File]::Open($Item.FullName, 'Open', 'Read', 'None') }
        $sha = [Security.Cryptography.SHA256]::Create()
        try {
            $digest = [Convert]::ToHexString($sha.ComputeHash($stream))
        } finally {
            $sha.Dispose()
            if (!$LockedStream) { $stream.Dispose() }
        }
    }
    [pscustomobject][ordered]@{path=$Item.FullName; created=$Item.CreationTimeUtc.Ticks; bytes=$size; digest=$digest}
}

function Get-Inventory {
    $pending = [Collections.Generic.Stack[IO.FileSystemInfo]]::new()
    $pending.Push((Get-Item -LiteralPath $target -Force))
    while ($pending.Count) {
        $item = $pending.Pop()
        Assert-PlainPath $item.FullName
        $entry = Get-Entry $item
        Assert-NoNamedStream $item.FullName
        $entry
        if ($item -is [IO.DirectoryInfo]) {
            foreach ($child in $item.EnumerateFileSystemInfos()) {
                $pending.Push($child)
            }
        }
    }
}

$run = [IO.Path]::GetFullPath($RunRoot).TrimEnd('\','/')
$paths = & (Join-Path $PSScriptRoot 'get-task-root-paths.ps1') -Checkout $PSScriptRoot
$roots = @($paths.PrimaryRuns, $paths.PrimaryExternal, $paths.CheckoutExternal)
if ([IO.Path]::GetDirectoryName($run) -notin $roots) { throw "Outside allocator roots: $run" }
$marker = Join-Path $run '.uemcp-run.json'
Assert-PlainPath $marker
$identity = Get-Content -Raw -LiteralPath $marker | ConvertFrom-Json
$runId = [guid]::Empty
if ($identity.schema -ne 1 -or $identity.path -ne $run -or
    $identity.task -cnotmatch '^[a-z0-9][a-z0-9-]{0,31}$' -or
    [IO.Path]::GetFileName($run) -notmatch ('^\d{6}-' + [regex]::Escape($identity.task) + '$') -or
    ![guid]::TryParseExact($identity.runId, 'D', [ref]$runId) -or $runId -eq [guid]::Empty) {
    throw "Invalid run identity: $marker"
}

$parts = @($Output -split '[/\\]')
foreach ($part in $parts) {
    if (!$part -or $part -in '.', '..' -or $part.EndsWith('.') -or $part.EndsWith(' ') -or
        $part.IndexOfAny([IO.Path]::GetInvalidFileNameChars()) -ge 0 -or $part.Contains('~') -or
        $part -match '^(CON|NUL|AUX|PRN|COM[1-9]|LPT[1-9])(?:\.|$)') {
        throw "Expected a literal relative output inside the run: $Output"
    }
}
if ($parts[0] -in '.uemcp-run.json','RUN.md') { throw "Reserved run record: $Output" }
$target = [IO.Path]::GetFullPath((Join-Path $run ($parts -join '\')))
if (!$target.StartsWith($run + '\', [StringComparison]::OrdinalIgnoreCase)) { throw "Outside run: $target" }
# Walk existing components before deciding whether a missing target is retired.
$partPath = $run
foreach ($part in $parts) {
    $partPath = Join-Path $partPath $part
    try { $null = Get-Item -LiteralPath $partPath -Force -ErrorAction Stop }
    catch [System.Management.Automation.ItemNotFoundException] {
        return [pscustomobject]@{State='Absent'; Path=$target; RunId=$identity.runId}
    }
    Assert-PlainPath $partPath
}
Assert-Inactive
$entries = @(Get-Inventory | Sort-Object -Property path -CaseSensitive)
$snapshot = [ordered]@{run=$identity.runId; target=$target; entries=$entries}
$json = ConvertTo-Json -InputObject $snapshot -Depth 4 -Compress
$buffer = [IO.MemoryStream]::new([Text.Encoding]::UTF8.GetBytes($json))
try { $preview = (Get-FileHash -InputStream $buffer -Algorithm SHA256).Hash }
finally { $buffer.Dispose() }
$result = [ordered]@{State='Preview'; Task=$identity.task; RunId=$identity.runId; Path=$target;
    Entries=$entries.Count; Bytes=($entries | Measure-Object -Property bytes -Sum).Sum; PreviewId=$preview}
if (!$Apply) { return [pscustomobject]$result }
if ($Apply -ne $preview) { throw "Output changed or preview belongs to a different target: $target" }
Assert-Inactive
if (!('Uemcp.CleanupHandle' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

namespace Uemcp {
    public static class CleanupHandle {
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true, ExactSpelling = true)]
        private static extern SafeFileHandle CreateFileW(string path, uint access, uint share,
            IntPtr security, uint creation, uint flags, IntPtr template);

        [DllImport("kernel32.dll", SetLastError = true, ExactSpelling = true)]
        private static extern bool SetFileInformationByHandle(SafeFileHandle file, int infoClass,
            ref byte disposition, uint length);

        public static SafeFileHandle Open(string path, bool directory) {
            const uint delete = 0x10000, read = 0x80000000, readAttributes = 0x80;
            const uint openExisting = 3, openReparsePoint = 0x200000, backupSemantics = 0x2000000;
            var handle = CreateFileW(path, delete | (directory ? readAttributes : read), 0,
                IntPtr.Zero, openExisting, openReparsePoint | (directory ? backupSemantics : 0u), IntPtr.Zero);
            if (handle.IsInvalid) {
                var error = new Win32Exception(Marshal.GetLastWin32Error());
                handle.Dispose();
                throw error;
            }
            return handle;
        }

        public static void MarkForDeletion(SafeFileHandle file) {
            const int fileDispositionInfo = 4;
            byte delete = 1;
            if (!SetFileInformationByHandle(file, fileDispositionInfo, ref delete, 1))
                throw new Win32Exception(Marshal.GetLastWin32Error());
        }
    }
}
'@
}

function Remove-ApprovedEntry($entry) {
    Assert-PlainPath $entry.path
    $directory = $entry.digest -eq 'directory'
    $handle = [Uemcp.CleanupHandle]::Open($entry.path, $directory)
    $stream = $null
    try {
        Assert-PlainPath $entry.path
        if (!$directory) { $stream = [IO.FileStream]::new($handle, [IO.FileAccess]::Read) }
        $current = Get-Entry (Get-Item -LiteralPath $entry.path -Force) $stream
        if ($current.created -ne $entry.created -or $current.digest -ne $entry.digest) {
            throw "Entry changed during removal: $($entry.path)"
        }
        Assert-NoNamedStream $entry.path
        # Mark the exact open entry; Windows rejects a directory that gained a child.
        [Uemcp.CleanupHandle]::MarkForDeletion($handle)
    } finally {
        if ($stream) { $stream.Dispose() }
        $handle.Dispose()
    }
}
foreach ($entry in $entries | Where-Object digest -ne 'directory') { Remove-ApprovedEntry $entry }
foreach ($entry in $entries | Where-Object digest -eq 'directory' | Sort-Object { $_.path.Length } -Descending) { Remove-ApprovedEntry $entry }
if (Test-Path -LiteralPath $target) { throw "Output still present: $target" }
$result.State = 'Removed'
[pscustomobject]$result
