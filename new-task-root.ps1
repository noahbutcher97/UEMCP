[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [ValidatePattern('^[a-z0-9][a-z0-9-]{0,31}$')]
    [string]$Task,
    [switch]$ExternalFixture
)

$ErrorActionPreference = 'Stop'
if ($ExternalFixture) {
    $scratch = Join-Path ([IO.Path]::GetPathRoot($PSScriptRoot)) 'Scratch'
    $projectScratch = Join-Path $scratch 'UEMCP'
} else {
    $worktrees = @(git -C $PSScriptRoot worktree list --porcelain)
    if ($LASTEXITCODE -ne 0 -or !$worktrees -or !$worktrees[0].StartsWith('worktree ')) {
        throw 'Cannot locate the primary checkout'
    }
    $scratch = Join-Path $worktrees[0].Substring(9) '.scratch'
    $projectScratch = Join-Path $scratch 'runs'
}
foreach ($parent in @($scratch, $projectScratch)) {
    $directory = [IO.Directory]::CreateDirectory($parent)
    if ($directory.Attributes -band [IO.FileAttributes]::ReparsePoint) {
        throw "Scratch parent is a reparse point: $parent"
    }
}

$run = Join-Path $projectScratch ("{0}-{1}" -f (Get-Date -Format 'yyMMdd'), $Task)
# New-Item without -Force refuses an existing directory, including a concurrent allocation.
New-Item -Path $run -ItemType Directory -ErrorAction Stop | Out-Null
[ordered]@{
    schema = 1
    runId = [guid]::NewGuid().ToString()
    path = (Get-Item -LiteralPath $run).FullName
    task = $Task
} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $run '.uemcp-run.json') -Encoding utf8
@"
# $Task

Created $(Get-Date -Format o) from $PSScriptRoot.

Coordinator:
Worktree and revision:
Owned processes:

| Output | Owner / purpose | Cleanup trigger |
| --- | --- | --- |

## Closeout

Record live paths, sizes, receipts, removals and the next use of each retained output.
"@ | Set-Content -LiteralPath (Join-Path $run 'RUN.md') -Encoding utf8
$run
