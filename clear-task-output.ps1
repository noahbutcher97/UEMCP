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
        $item = Get-Item -LiteralPath $part -Force -ErrorAction Stop
        if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
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

function Get-Entry([IO.FileSystemInfo]$Item) {
    $protected = [IO.FileAttributes]'ReparsePoint,ReadOnly,Hidden,System'
    if ($Item.Attributes -band $protected) {
        throw "Linked or protected entry requires owner review: $($Item.FullName) ($($Item.Attributes))"
    }
    $size = 0L
    $digest = 'directory'
    $extra = @(Get-Item -LiteralPath $Item.FullName -Stream * -ErrorAction Stop |
        Where-Object Stream -ne ':$DATA')
    if ($extra.Count) { throw "Named stream requires owner review: $($Item.FullName)" }
    if (!$Item.PSIsContainer) {
        $size = $Item.Length
        $stream = [IO.File]::Open($Item.FullName, 'Open', 'Read', 'None')
        try {
            $digest = (Get-FileHash -InputStream $stream -Algorithm SHA256).Hash
        } finally { $stream.Dispose() }
    }
    [pscustomobject][ordered]@{path=$Item.FullName; created=$Item.CreationTimeUtc.Ticks; bytes=$size; digest=$digest}
}

function Get-Inventory {
    $pending = [Collections.Generic.Stack[string]]::new()
    $pending.Push($target)
    while ($pending.Count) {
        $item = Get-Item -LiteralPath $pending.Pop() -Force
        Assert-PlainPath $item.FullName
        Get-Entry $item
        if ($item.PSIsContainer) {
            foreach ($child in Get-ChildItem -LiteralPath $item.FullName -Force) {
                $pending.Push($child.FullName)
            }
        }
    }
}

$run = [IO.Path]::GetFullPath($RunRoot).TrimEnd('\','/')
$worktrees = @(git -C $PSScriptRoot worktree list --porcelain)
if ($LASTEXITCODE -or !$worktrees.Count -or !$worktrees[0].StartsWith('worktree ')) {
    throw 'Cannot locate primary checkout'
}
$primary = [IO.Path]::GetFullPath($worktrees[0].Substring(9))
$roots = @((Join-Path $primary '.scratch\runs'), (Join-Path ([IO.Path]::GetPathRoot($primary)) 'Scratch\UEMCP'))
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
foreach ($entry in $entries | Where-Object digest -ne 'directory') {
    Assert-PlainPath $entry.path
    $current = Get-Entry (Get-Item -LiteralPath $entry.path -Force)
    if ($current.created -ne $entry.created -or $current.digest -ne $entry.digest) {
        throw "File changed during removal: $($entry.path)"
    }
    Remove-Item -LiteralPath $entry.path -ErrorAction Stop
}
# Nonrecursive directory removal preserves entries created after the preflight.
foreach ($entry in $entries | Where-Object digest -eq 'directory' | Sort-Object { $_.path.Length } -Descending) {
    Assert-PlainPath $entry.path
    $current = Get-Entry (Get-Item -LiteralPath $entry.path -Force)
    if ($current.created -ne $entry.created -or $current.digest -ne 'directory') {
        throw "Directory changed during removal: $($entry.path)"
    }
    [IO.Directory]::Delete($entry.path, $false)
}
if (Test-Path -LiteralPath $target) { throw "Output still present: $target" }
$result.State = 'Removed'
[pscustomobject]$result
