[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [ValidatePattern('^[a-z0-9][a-z0-9-]{0,31}$')]
    [string]$Task
)

$ErrorActionPreference = 'Stop'
$volume = [IO.Path]::GetPathRoot($PSScriptRoot)
$scratch = Join-Path $volume 'Scratch'
$projectScratch = Join-Path $scratch 'UEMCP'
foreach ($parent in @($scratch, $projectScratch)) {
    $directory = [IO.Directory]::CreateDirectory($parent)
    if ($directory.Attributes -band [IO.FileAttributes]::ReparsePoint) {
        throw "Scratch parent is a reparse point: $parent"
    }
}

$run = Join-Path $projectScratch ("{0}-{1}" -f (Get-Date -Format 'yyMMdd'), $Task)
# New-Item without -Force refuses an existing directory, including a concurrent allocation.
New-Item -Path $run -ItemType Directory -ErrorAction Stop | Out-Null
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
