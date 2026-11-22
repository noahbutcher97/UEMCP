#Requires -Version 7.2
[CmdletBinding()]
param([Parameter(Mandatory)][string]$RunRoot)

$ErrorActionPreference = 'Stop'
$clean = Join-Path $PSScriptRoot 'clear-task-output.ps1'
$name = 'allocator-test-' + [guid]::NewGuid().ToString('N')
if ((& $clean $RunRoot $name).State -ne 'Absent') { throw 'Fixture already exists' }
$checkout = Join-Path $RunRoot "$name\checkout"
git -c init.templateDir= init --bare --quiet $checkout
if ($LASTEXITCODE -ne 0) { throw 'Could not initialize fixture repository' }
foreach ($script in 'new-task-root.ps1','get-task-root-paths.ps1') {
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot $script) -Destination $checkout
}
$allocator = Join-Path $checkout 'new-task-root.ps1'
$barrier = [Threading.Barrier]::new(8)
try {
    $results = @(1..8 | ForEach-Object -Parallel {
        $gate = $using:barrier
        $allocate = $using:allocator
        if (!$gate.SignalAndWait(30000)) { throw 'Timed out starting racing callers' }
        try {
            $path = & $allocate -Task 'shared'
        } catch {
            $cause = $_.Exception.GetBaseException()
            if ($cause -isnot [IO.IOException] -or ($cause.HResult -band 0xffff) -notin 80,183) { throw }
            return [pscustomobject]@{ won = $false }
        }
        $marker = Get-Content -Raw -LiteralPath (Join-Path $path '.uemcp-run.json') | ConvertFrom-Json
        $notes = Get-Content -Raw -LiteralPath (Join-Path $path 'RUN.md')
        if ($marker.path -ne $path -or $marker.task -ne 'shared' -or $notes -notmatch '^# shared') {
            throw 'Allocator returned before publishing both records'
        }
        [pscustomobject]@{ won = $true; path = $path; id = $marker.runId }
    } -ThrottleLimit 8)
} finally {
    $barrier.Dispose()
}
$winners = @($results | Where-Object won)
if ($results.Count -ne 8 -or $winners.Count -ne 1) { throw "Expected one winner and seven collisions. Winners: $($winners.Count)" }
$run = $winners[0].path
$runs = Split-Path $run
$entries = @(Get-ChildItem -LiteralPath $runs -Force)
if ($runs -ne (Join-Path $checkout '.scratch\runs') -or $entries.Count -ne 1) { throw 'Unexpected published or staged directories' }
$markerPath = Join-Path $run '.uemcp-run.json'
if ((Get-Content -Raw -LiteralPath $markerPath | ConvertFrom-Json).runId -ne $winners[0].id) { throw 'Winning run ID changed' }

function Assert-Collision([string]$TaskName) {
    try { & $allocator -Task $TaskName | Out-Null } catch {
        $cause = $_.Exception.GetBaseException()
        if ($cause -is [IO.IOException] -and ($cause.HResult -band 0xffff) -in 80,183 -and
            $_.Exception.Message.Contains((Join-Path $runs "$prefix-$TaskName"))) { return }
        throw
    }
    throw "Unexpectedly claimed an existing path for $TaskName"
}

$notesPath = Join-Path $run 'RUN.md'
$markerHash = (Get-FileHash -LiteralPath $markerPath).Hash
Set-Content -LiteralPath $notesPath 'coordinator notes to preserve'
$notesHash = (Get-FileHash -LiteralPath $notesPath).Hash
$prefix = (Split-Path $run -Leaf).Substring(0,6)
Assert-Collision 'shared'
if ((Get-FileHash -LiteralPath $markerPath).Hash -ne $markerHash -or (Get-FileHash -LiteralPath $notesPath).Hash -ne $notesHash) {
    throw 'An allocation retry changed the existing records'
}
$existing = [IO.Directory]::CreateDirectory((Join-Path $runs "$prefix-existing")).FullName
Assert-Collision 'existing'
if (@(Get-ChildItem -LiteralPath $existing -Force).Count) { throw 'Claimed a pre-existing empty directory' }
$sentinel = Join-Path $existing 'original.txt'
Set-Content -LiteralPath $sentinel 'unmarked existing data'
$sentinelHash = (Get-FileHash -LiteralPath $sentinel).Hash
Assert-Collision 'existing'
if (@(Get-ChildItem -LiteralPath $existing -Force).Count -ne 1 -or (Get-FileHash -LiteralPath $sentinel).Hash -ne $sentinelHash) {
    throw 'Changed an unmarked populated directory'
}
if (@(Get-ChildItem -LiteralPath $runs -Force).Count -ne 2) { throw 'Left an unpublished staging directory' }
$preview = & $clean $RunRoot $name
$closed = & $clean $RunRoot $name -Apply $preview.PreviewId
if (Test-Path -LiteralPath (Join-Path $RunRoot $name)) { throw 'Fixture cleanup incomplete' }
"PASS: one of eight callers published both records; seven received collisions. Existing notes, identity, empty directory and unmarked data survived. Fixture cleanup: $($closed.State)."
