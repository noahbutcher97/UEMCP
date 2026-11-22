[CmdletBinding()]
param([Parameter(Mandatory)][string]$Checkout)

$ErrorActionPreference = 'Stop'
$checkoutPath = [IO.Path]::GetFullPath($Checkout)
$worktrees = @(git -C $checkoutPath worktree list --porcelain)
if ($LASTEXITCODE -ne 0 -or !$worktrees.Count -or !$worktrees[0].StartsWith('worktree ')) {
    throw 'Cannot locate the primary checkout'
}
$primary = [IO.Path]::GetFullPath($worktrees[0].Substring(9))
function Get-ExternalRoot([string]$Path) {
    Join-Path ([IO.Path]::GetPathRoot($Path)) 'Scratch\UEMCP'
}
[pscustomobject]@{
    PrimaryRuns = Join-Path $primary '.scratch\runs'
    PrimaryExternal = Get-ExternalRoot $primary
    CheckoutExternal = Get-ExternalRoot $checkoutPath
}
