[CmdletBinding()]
param(
    [string]$VersionsCsv = '5.3,5.6,5.7',
    [string]$EpicGamesRoot = 'C:\Program Files\Epic Games',
    [string]$Plugin = '',
    [string]$OutputRoot = (Join-Path ([IO.Path]::GetTempPath()) ("UEMCP-BuildPlugin-Matrix-{0}" -f (Get-Date -Format 'yyyyMMdd-HHmmss'))),
    [switch]$Json
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Get-Sha256Hex([string]$Path) {
    $stream = [IO.File]::OpenRead($Path)
    try {
        $hasher = [Security.Cryptography.SHA256]::Create()
        try {
            return (($hasher.ComputeHash($stream) | ForEach-Object { '{0:X2}' -f $_ }) -join '')
        }
        finally {
            $hasher.Dispose()
        }
    }
    finally {
        $stream.Dispose()
    }
}

function Copy-PluginSource([string]$SourceRoot, [string]$DestinationRoot) {
    New-Item -ItemType Directory -Path $DestinationRoot | Out-Null
    foreach ($entry in Get-ChildItem -LiteralPath $SourceRoot -Force) {
        if (@('Binaries', 'Intermediate') -contains $entry.Name) {
            continue
        }
        Copy-Item -LiteralPath $entry.FullName -Destination $DestinationRoot -Recurse -Force
    }
}

$versions = @($VersionsCsv.Split(',') | ForEach-Object { $_.Trim() } | Where-Object { $_ })
if ($versions.Count -eq 0) {
    throw 'VersionsCsv must name at least one Unreal Engine version.'
}

$seenVersions = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
foreach ($version in $versions) {
    if ($version -notmatch '^5\.\d+$') {
        throw "Unsupported Unreal Engine version token: '$version'."
    }
    if (-not $seenVersions.Add($version)) {
        throw "Duplicate Unreal Engine version token: '$version'."
    }
}

if ([string]::IsNullOrWhiteSpace($Plugin)) {
    $Plugin = Join-Path $PSScriptRoot 'plugin\UEMCP\UEMCP.uplugin'
}
$pluginPath = [IO.Path]::GetFullPath($Plugin)
if (-not (Test-Path -LiteralPath $pluginPath -PathType Leaf)) {
    throw "Plugin descriptor not found: $pluginPath"
}
$pluginRoot = Split-Path -Parent $pluginPath
$pluginDescriptorName = Split-Path -Leaf $pluginPath

$epicRootPath = [IO.Path]::GetFullPath($EpicGamesRoot)
$outputRootPath = [IO.Path]::GetFullPath($OutputRoot)
$pathSeparators = [char[]]@([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
$pluginRootPrefix = $pluginRoot.TrimEnd($pathSeparators) + [IO.Path]::DirectorySeparatorChar
if ($outputRootPath.StartsWith($pluginRootPrefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw "OutputRoot cannot be inside the plugin source directory: $outputRootPath"
}
if (Test-Path -LiteralPath $outputRootPath) {
    throw "OutputRoot already exists; refusing to let BuildPlugin clear it: $outputRootPath"
}
New-Item -ItemType Directory -Path $outputRootPath | Out-Null

$results = [Collections.Generic.List[object]]::new()

foreach ($version in $versions) {
    $uatPath = Join-Path $epicRootPath "UE_$version\Engine\Build\BatchFiles\RunUAT.bat"
    if (-not (Test-Path -LiteralPath $uatPath -PathType Leaf)) {
        throw "RunUAT not found for UE ${version}: $uatPath"
    }

    $packagePath = Join-Path $outputRootPath "UE-$version"
    if (Test-Path -LiteralPath $packagePath) {
        throw "Package path unexpectedly exists: $packagePath"
    }

    $stagedPluginRoot = Join-Path $outputRootPath ".plugin-source-UE-$version"
    $stagedPluginPath = Join-Path $stagedPluginRoot $pluginDescriptorName

    try {
        Copy-PluginSource $pluginRoot $stagedPluginRoot
        if ($Json) {
            $savedErrorActionPreference = $ErrorActionPreference
            try {
                $ErrorActionPreference = 'Continue'
                & $uatPath BuildPlugin "-Plugin=$stagedPluginPath" "-Package=$packagePath" '-TargetPlatforms=Win64' '-Rocket' 2>&1 |
                    ForEach-Object { [Console]::Error.WriteLine($_) }
                $exitCode = $LASTEXITCODE
            }
            finally {
                $ErrorActionPreference = $savedErrorActionPreference
            }
        }
        else {
            & $uatPath BuildPlugin "-Plugin=$stagedPluginPath" "-Package=$packagePath" '-TargetPlatforms=Win64' '-Rocket'
            $exitCode = $LASTEXITCODE
        }
        if ($exitCode -ne 0) {
            throw "UE $version BuildPlugin failed with exit code $exitCode."
        }

        $fixturePath = Join-Path $packagePath 'Resources\Tests\tcp-transport-cases.json'
        if (-not (Test-Path -LiteralPath $fixturePath -PathType Leaf)) {
            throw "UE $version package omitted TCP transport fixtures: $fixturePath"
        }

        $results.Add([pscustomobject]@{
            version = $version
            exit_code = $exitCode
            package = $packagePath
            fixture = $fixturePath
            fixture_sha256 = Get-Sha256Hex $fixturePath
        })
    }
    finally {
        if (Test-Path -LiteralPath $stagedPluginRoot -PathType Container) {
            Remove-Item -LiteralPath $stagedPluginRoot -Recurse -Force
        }
    }
}

$resultArray = @($results | ForEach-Object { $_ })
if ($Json) {
    ConvertTo-Json -InputObject $resultArray -Depth 3
}
else {
    $resultArray | Format-Table version, exit_code, package, fixture_sha256 -AutoSize
}
