[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [ValidatePattern('^[a-z0-9][a-z0-9-]{0,31}$', Options = 'None')]
    [string]$Task,
    [switch]$ExternalFixture
)

$ErrorActionPreference = 'Stop'
$paths = & (Join-Path $PSScriptRoot 'get-task-root-paths.ps1') -Checkout $PSScriptRoot
if ($ExternalFixture) {
    $projectScratch = $paths.CheckoutExternal
} else {
    $projectScratch = $paths.PrimaryRuns
}
foreach ($parent in @([IO.Path]::GetDirectoryName($projectScratch), $projectScratch)) {
    $directory = [IO.Directory]::CreateDirectory($parent)
    if ($directory.Attributes -band [IO.FileAttributes]::ReparsePoint) {
        throw "Scratch parent is a reparse point: $parent"
    }
}

$run = Join-Path $projectScratch ("{0}-{1}" -f (Get-Date -Format 'yyMMdd'), $Task)
$id = [guid]::NewGuid()
$staging = Join-Path $projectScratch ('.allocating-' + $id.ToString('N'))
$marker = [ordered]@{
    schema = 1
    runId = $id.ToString()
    path = $run
    task = $Task
} | ConvertTo-Json
$notes = @"
# $Task

Created $(Get-Date -Format o) from $PSScriptRoot.

Coordinator:
Worktree and revision:
Owned processes:

| Output | Owner / purpose | Cleanup trigger |
| --- | --- | --- |

## Closeout

Record live paths, sizes, receipts, removals and the next use of each retained output.
"@
# Publish both records together. A same-volume directory move refuses an
# existing destination, including one just published by another coordinator.
New-Item -ItemType Directory -Path $staging -ErrorAction Stop | Out-Null
try {
    Set-Content -LiteralPath (Join-Path $staging '.uemcp-run.json') -Value $marker -Encoding utf8
    Set-Content -LiteralPath (Join-Path $staging 'RUN.md') -Value $notes -Encoding utf8
    [IO.Directory]::Move($staging, $run)
} catch {
    [IO.File]::Delete((Join-Path $staging '.uemcp-run.json'))
    [IO.File]::Delete((Join-Path $staging 'RUN.md'))
    [IO.Directory]::Delete($staging, $false)
    $cause = $_.Exception.GetBaseException()
    if ($cause -is [IO.IOException] -and ($cause.HResult -band 0xffff) -in 80,183) {
        throw [IO.IOException]::new("Task path already exists: $run. Inspect it before resuming, or choose another task name.", $cause)
    }
    throw
}
$run
