param(
    [Parameter(Mandatory)][ValidateSet('Capture', 'Install')][string]$Phase,
    [Parameter(Mandatory)][string]$SourceDir,
    [Parameter(Mandatory)][string]$DestinationDir,
    [string]$Snapshot,
    [ValidateSet(0, 1)][int]$ForceClean = 0
)

$ErrorActionPreference = 'Stop'
try {
    $rule = 'Source\UEMCP\UEMCP.Build.cs'
    $sourcePath = [IO.Path]::Combine($SourceDir, $rule)
    $targetPath = [IO.Path]::Combine($DestinationDir, $rule)
    $bytes = [IO.File]::ReadAllBytes($sourcePath)
    $sha = [Security.Cryptography.SHA256]::Create()
    try {
        $hash = [BitConverter]::ToString($sha.ComputeHash($bytes)).Replace('-', '')
        if ($Phase -eq 'Capture') {
            $ticks = 0
            if ([IO.File]::Exists($targetPath)) {
                $previousHash = [BitConverter]::ToString($sha.ComputeHash([IO.File]::ReadAllBytes($targetPath))).Replace('-', '')
                if ($previousHash -eq $hash) {
                    $ticks = [IO.File]::GetLastWriteTimeUtc($targetPath).Ticks
                }
            }
            Write-Output "$ticks/$hash"
            exit 0
        }
    } finally {
        $sha.Dispose()
    }

    if ($Snapshot -notmatch '^(\d+)/([A-F0-9]{64})$' -or $Matches[2] -ne $hash) {
        throw 'Module rules changed during deployment. Run the same command again.'
    }
    $ticks = [long]$Matches[1]
    $stamp = if ($ticks -eq 0 -or $ForceClean) { [DateTime]::UtcNow } else { [DateTime]::new($ticks, [DateTimeKind]::Utc) }
    # Publish bytes and timestamp together so a retry after an interrupted copy
    # cannot mistake an unstamped module rule for a previously deployed one.
    $directory = [IO.Path]::GetDirectoryName($targetPath)
    [void][IO.Directory]::CreateDirectory($directory)
    $temporary = [IO.Path]::Combine($directory, [IO.Path]::GetRandomFileName())
    try {
        [IO.File]::WriteAllBytes($temporary, $bytes)
        [IO.File]::SetLastWriteTimeUtc($temporary, $stamp)
        [IO.File]::Move($temporary, $targetPath)
    } finally {
        [IO.File]::Delete($temporary)
    }
} catch {
    [Console]::Error.WriteLine("UEMCP module rule deployment failed: " + $_.Exception.Message)
    exit 1
}
