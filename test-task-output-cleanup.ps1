#Requires -Version 7.2
[CmdletBinding()]
param([Parameter(Mandatory)][string]$RunRoot)

$ErrorActionPreference = 'Stop'
$helper = Join-Path $PSScriptRoot 'clear-task-output.ps1'
$name = 'cleanup-test-' + [guid]::NewGuid().ToString('N')
$testDir = Join-Path $RunRoot $name
$leaf = "$name/retry"
$target = Join-Path $RunRoot $leaf
$sibling = Join-Path $testDir 'sibling'
New-Item -ItemType Directory -Path $testDir, $target, $sibling | Out-Null
$sample = Join-Path $target 'example.bin'
$control = Join-Path $sibling 'keep.txt'
Set-Content -LiteralPath $sample 'first'
Set-Content -LiteralPath $control 'unchanged'

function Assert-Refused([scriptblock]$Action, [string]$Expected) {
    try { & $Action | Out-Null }
    catch { if ($_.Exception.Message -match $Expected) { return }; throw }
    throw "Expected refusal matching '$Expected'"
}

$allocator = Join-Path $PSScriptRoot 'new-task-root.ps1'
$uppercaseTask = 'A' + [guid]::NewGuid().ToString('N').Substring(0, 12)
Assert-Refused { & $allocator -Task $uppercaseTask } 'pattern'

$preview = & $helper $RunRoot $leaf
if ($preview.State -ne 'Preview' -or $preview.Entries -ne 2 -or
    $preview.Bytes -ne (Get-Item $sample).Length -or (Get-Content $sample) -ne 'first') {
    throw 'Preview did not preserve and describe its output'
}
Assert-Refused { & $helper $RunRoot '../retained' } 'literal relative'
Assert-Refused { & $helper $RunRoot $sibling } 'literal relative'
Assert-Refused { & $helper $RunRoot 'RUN.md' } 'Reserved'
$hiddenFile = Join-Path $target 'protected'
Set-Content -LiteralPath $hiddenFile 'review'
$attributes = [IO.File]::GetAttributes($hiddenFile)
try {
    [IO.File]::SetAttributes($hiddenFile, $attributes -bor [IO.FileAttributes]::Hidden)
    Assert-Refused { & $helper $RunRoot $leaf -Apply $preview.PreviewId } 'protected entry'
    if (!(Test-Path -LiteralPath $sample)) { throw 'Preflight removed a sibling' }
} finally { [IO.File]::SetAttributes($hiddenFile, $attributes) }
Remove-Item -LiteralPath $hiddenFile
Set-Content -LiteralPath $sample -Stream 'receipt' -Value 'retained'
try { Assert-Refused { & $helper $RunRoot $leaf -Apply $preview.PreviewId } 'Named stream' }
finally { Remove-Item -LiteralPath $sample -Stream 'receipt' }
Set-Content -LiteralPath $target -Stream 'receipt' -Value 'retained'
try { Assert-Refused { & $helper $RunRoot $leaf -Apply $preview.PreviewId } 'Named stream' }
finally { [IO.File]::Delete($target + ':receipt') }
Assert-Refused { & $helper $RunRoot $leaf -Apply $preview.PreviewId -OwnerProcessId $PID } 'still running'
# The worker names an adjacent retry in its arguments without opening either output.
$workerArgs = '-NoProfile -NonInteractive -Command "Start-Sleep -Seconds 90 # ' + $target + '-10"'
$worker = Start-Process (Get-Command pwsh).Source -ArgumentList $workerArgs -PassThru -WindowStyle Hidden
try {
    if ((& $helper $RunRoot $leaf).State -ne 'Preview') { throw 'Sibling process blocked preview' }
} finally {
    if (!$worker.HasExited) { $worker.Kill(); $worker.WaitForExit() }
    $worker.Dispose()
}
$lock = [IO.File]::OpenRead($sample)
try { Assert-Refused { & $helper $RunRoot $leaf -Apply $preview.PreviewId } 'being used|access.*file|another process' }
finally { $lock.Dispose() }
$link = Join-Path $target 'link'
New-Item -ItemType Junction -Path $link -Target $sibling | Out-Null
try { Assert-Refused { & $helper $RunRoot $leaf -Apply $preview.PreviewId } 'Linked' }
finally {
    $junction = Get-Item -LiteralPath $link
    if ($junction.LinkType -ne 'Junction' -or $junction.Target -ne $sibling) { throw 'Test junction changed' }
    [IO.Directory]::Delete($junction.FullName, $false)
}
Set-Content $sample 'other'
Assert-Refused { & $helper $RunRoot $leaf -Apply $preview.PreviewId } 'changed or preview'
if ((Get-Content $sample) -ne 'other') { throw 'Changed file lost' }
$fresh = & $helper $RunRoot $leaf
$mark = (Get-Command $helper).ScriptBlock.Ast.Find({
    param($ast)
    $ast -is [Management.Automation.Language.InvokeMemberExpressionAst] -and $ast.Member.Value -eq 'MarkForDeletion'
}, $true)
$access = @{ checked = $false; sharingViolation = $false }
# Observe the real helper immediately before it marks the file for deletion.
# A competing ordinary writer must still be refused after the digest matches.
$probe = Set-PSBreakpoint -Script $helper -Line $mark.Extent.StartLineNumber -Action {
    if ($entry.path -eq $sample) {
        $access.checked = $true
        try {
            $writer = [IO.File]::Open($sample, 'Open', 'Write', 'None')
            $writer.Dispose()
        } catch [IO.IOException] {
            $access.sharingViolation = ($_.Exception.GetBaseException().HResult -band 0xffff) -eq 32
        }
    }
}
try { $removed = & $helper $RunRoot $leaf -Apply $fresh.PreviewId }
finally { Remove-PSBreakpoint $probe }
if (!$access.checked -or !$access.sharingViolation) { throw 'File was not locked at the deletion boundary' }
if ($removed.State -ne 'Removed' -or
    (Test-Path $target) -or (Get-Content $control) -ne 'unchanged') { throw 'Incorrect removal scope' }
if ((& $helper $RunRoot $leaf -Apply $fresh.PreviewId).State -ne 'Absent') { throw 'Repeat apply failed' }
$rest = & $helper $RunRoot $name
& $helper $RunRoot $name -Apply $rest.PreviewId | Out-Null
'PASS: lowercase allocation, preview, changed file, active owner, open handle, junction, outside path, marker protection, locked deletion, sibling preservation and repeat apply.'
