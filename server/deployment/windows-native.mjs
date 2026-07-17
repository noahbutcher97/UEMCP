import { spawn as defaultSpawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import * as defaultFs from 'node:fs/promises';
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';

import { fingerprintPath } from './fingerprints.mjs';

const AUTHENTICODE_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$module = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\Modules\Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1'
Import-Module -Name $module -Force
$signature = Microsoft.PowerShell.Security\Get-AuthenticodeSignature -LiteralPath $env:UEMCP_AUTHENTICODE_TARGET
$name = $null
$thumbprint = $null
if ($null -ne $signature.SignerCertificate) {
  $name = $signature.SignerCertificate.GetNameInfo([System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName, $false)
  $thumbprint = $signature.SignerCertificate.Thumbprint
}
[ordered]@{ status = [string]$signature.Status; signer_name = $name; thumbprint = $thumbprint } | ConvertTo-Json -Compress
`.trim();

const METADATA_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
function Get-Sha256Hex([byte[]]$Bytes) {
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try { $hashBytes = $sha.ComputeHash($Bytes) } finally { $sha.Dispose() }
  return [System.BitConverter]::ToString($hashBytes).Replace('-', '').ToLowerInvariant()
}
$target = $env:UEMCP_METADATA_TARGET
$maxStreams = [int]$env:UEMCP_MAX_STREAMS
$maxBytes = [long]$env:UEMCP_MAX_STREAM_BYTES
$item = Get-Item -LiteralPath $target -Force
$acl = Get-Acl -LiteralPath $target
$streams = @(Get-Item -LiteralPath $target -Stream * -ErrorAction Stop | Where-Object { $_.Stream -ne ':$DATA' -and $_.Stream -ne '::$DATA' } | Sort-Object Stream)
if ($streams.Count -gt $maxStreams) { throw 'STREAM_COUNT_LIMIT' }
$streamRows = @()
$streamBytes = [long]0
foreach ($stream in $streams) {
  $content = Get-Content -LiteralPath $stream.FileName -Stream $stream.Stream -Encoding Byte -Raw -ErrorAction Stop
  $bytes = if ($null -eq $content) { [byte[]]@() } else { [byte[]]$content }
  $streamBytes += $bytes.LongLength
  if ($streamBytes -gt $maxBytes) { throw 'STREAM_BYTE_LIMIT' }
  $hash = Get-Sha256Hex $bytes
  $streamRows += [ordered]@{ name = $stream.Stream; size = $bytes.LongLength; sha256 = $hash }
}
$metadata = [ordered]@{
  owner = $acl.Owner
  sddl = $acl.Sddl
  creation_time_utc_ticks = $item.CreationTimeUtc.Ticks
  attributes = [int64]$item.Attributes
  streams = $streamRows
}
$json = $metadata | ConvertTo-Json -Compress -Depth 8
[ordered]@{
  metadata_sha256 = Get-Sha256Hex ([System.Text.Encoding]::UTF8.GetBytes($json))
  stream_count = $streams.Count
  stream_bytes = $streamBytes
} | ConvertTo-Json -Compress
`.trim();

const REPLACE_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class UemcpReplaceFileNative
{
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool ReplaceFile(
        string replacedFileName,
        string replacementFileName,
        string backupFileName,
        uint replaceFlags,
        IntPtr exclude,
        IntPtr reserved);
}
'@
try {
  $replaced = [UemcpReplaceFileNative]::ReplaceFile(
    $env:UEMCP_DESTINATION_PATH,
    $env:UEMCP_REPLACEMENT_PATH,
    $env:UEMCP_BACKUP_PATH,
    0,
    [IntPtr]::Zero,
    [IntPtr]::Zero)
  if (-not $replaced) {
    $errorCode = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
    throw [System.ComponentModel.Win32Exception]::new($errorCode)
  }
  [ordered]@{ status = 'replaced' } | ConvertTo-Json -Compress
} catch {
  [ordered]@{ status = 'failed'; error_code = $_.Exception.GetType().FullName } | ConvertTo-Json -Compress
  exit 1
}
`.trim();

const ANCESTRY_PIN_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

public static class UemcpPinnedAncestryNative
{
    [StructLayout(LayoutKind.Sequential)]
    public struct ByHandleFileInformation
    {
        public uint FileAttributes;
        public System.Runtime.InteropServices.ComTypes.FILETIME CreationTime;
        public System.Runtime.InteropServices.ComTypes.FILETIME LastAccessTime;
        public System.Runtime.InteropServices.ComTypes.FILETIME LastWriteTime;
        public uint VolumeSerialNumber;
        public uint FileSizeHigh;
        public uint FileSizeLow;
        public uint NumberOfLinks;
        public uint FileIndexHigh;
        public uint FileIndexLow;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern SafeFileHandle CreateFileW(
        string fileName,
        uint desiredAccess,
        uint shareMode,
        IntPtr securityAttributes,
        uint creationDisposition,
        uint flagsAndAttributes,
        IntPtr templateFile);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool GetFileInformationByHandle(
        SafeFileHandle file,
        out ByHandleFileInformation information);

}
'@

function Convert-ToExtendedPath([string]$Path) {
  if ($Path.StartsWith('\\')) { return '\\?\UNC\' + $Path.Substring(2) }
  return '\\?\' + $Path
}

$handles = [System.Collections.Generic.List[Microsoft.Win32.SafeHandles.SafeFileHandle]]::new()
try {
  $directories = ConvertFrom-Json -InputObject $env:UEMCP_ANCESTRY_DIRECTORIES
  foreach ($directory in $directories) {
    $handle = [UemcpPinnedAncestryNative]::CreateFileW(
      (Convert-ToExtendedPath ([string]$directory)),
      0x80,
      0x3,
      [IntPtr]::Zero,
      3,
      0x02200000,
      [IntPtr]::Zero)
    if ($handle.IsInvalid) {
      $errorCode = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
      $handle.Dispose()
      throw [System.ComponentModel.Win32Exception]::new($errorCode)
    }
    $handles.Add($handle)
    $information = [UemcpPinnedAncestryNative+ByHandleFileInformation]::new()
    if (-not [UemcpPinnedAncestryNative]::GetFileInformationByHandle($handle, [ref]$information)) {
      $errorCode = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
      throw [System.ComponentModel.Win32Exception]::new($errorCode)
    }
    if (($information.FileAttributes -band 0x400) -ne 0 -or ($information.FileAttributes -band 0x10) -eq 0) {
      throw 'unsafe pinned ancestry entry'
    }
  }

  $sentinelName = '.uemcp-pin-' + [Guid]::NewGuid().ToString('N') + '.tmp'
  $sentinelPath = [System.IO.Path]::Combine([string]$directories[-1], $sentinelName)
  $sentinelHandle = [UemcpPinnedAncestryNative]::CreateFileW(
    (Convert-ToExtendedPath $sentinelPath),
    0x10080,
    0x3,
    [IntPtr]::Zero,
    1,
    0x04200100,
    [IntPtr]::Zero)
  if ($sentinelHandle.IsInvalid) {
    $errorCode = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
    $sentinelHandle.Dispose()
    throw [System.ComponentModel.Win32Exception]::new($errorCode)
  }
  $handles.Add($sentinelHandle)
  $sentinelInformation = [UemcpPinnedAncestryNative+ByHandleFileInformation]::new()
  if (-not [UemcpPinnedAncestryNative]::GetFileInformationByHandle($sentinelHandle, [ref]$sentinelInformation)) {
    $errorCode = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
    throw [System.ComponentModel.Win32Exception]::new($errorCode)
  }
  if (($sentinelInformation.FileAttributes -band 0x400) -ne 0 -or ($sentinelInformation.FileAttributes -band 0x10) -ne 0) {
    throw 'unsafe ancestry sentinel'
  }
  [Console]::Out.WriteLine('READY')
  [Console]::Out.Flush()
  if ([Console]::In.ReadLine() -ne 'RELEASE') { throw 'invalid ancestry release signal' }
} catch {
  [Console]::Error.Write($_.Exception.GetType().FullName)
  exit 74
} finally {
  for ($index = $handles.Count - 1; $index -ge 0; $index--) {
    $handles[$index].Dispose()
  }
}
`.trim();

const DELETE_TREE_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

public static class UemcpDeleteTreeNative
{
    [StructLayout(LayoutKind.Sequential)]
    public struct ByHandleFileInformation
    {
        public uint FileAttributes;
        public System.Runtime.InteropServices.ComTypes.FILETIME CreationTime;
        public System.Runtime.InteropServices.ComTypes.FILETIME LastAccessTime;
        public System.Runtime.InteropServices.ComTypes.FILETIME LastWriteTime;
        public uint VolumeSerialNumber;
        public uint FileSizeHigh;
        public uint FileSizeLow;
        public uint NumberOfLinks;
        public uint FileIndexHigh;
        public uint FileIndexLow;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct FileDispositionInformation
    {
        [MarshalAs(UnmanagedType.Bool)]
        public bool DeleteFile;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern SafeFileHandle CreateFileW(
        string fileName,
        uint desiredAccess,
        uint shareMode,
        IntPtr securityAttributes,
        uint creationDisposition,
        uint flagsAndAttributes,
        IntPtr templateFile);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool GetFileInformationByHandle(
        SafeFileHandle file,
        out ByHandleFileInformation information);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool SetFileInformationByHandle(
        SafeFileHandle file,
        int fileInformationClass,
        ref FileDispositionInformation information,
        uint bufferSize);

    private const uint DeleteAccess = 0x00010000;
    private const uint ReadAttributes = 0x00000080;
    private const uint ShareRead = 0x00000001;
    private const uint ShareWrite = 0x00000002;
    private const uint OpenExisting = 3;
    private const uint BackupSemantics = 0x02000000;
    private const uint OpenReparsePoint = 0x00200000;
    private const uint DirectoryAttribute = 0x00000010;
    private const uint ReparseAttribute = 0x00000400;
    private const int FileDispositionInfo = 4;

    private static int entryCount;

    private static string ExtendedPath(string path)
    {
        if (path.StartsWith(@"\\?\")) return path;
        if (path.StartsWith(@"\\")) return @"\\?\UNC\" + path.Substring(2);
        return @"\\?\" + path;
    }

    private static Exception LastError()
    {
        return new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
    }

    private static ByHandleFileInformation Information(SafeFileHandle handle)
    {
        ByHandleFileInformation information;
        if (!GetFileInformationByHandle(handle, out information)) throw LastError();
        return information;
    }

    public static SafeFileHandle OpenPinnedDirectory(string path)
    {
        SafeFileHandle handle = CreateFileW(
            ExtendedPath(path),
            ReadAttributes,
            ShareRead | ShareWrite,
            IntPtr.Zero,
            OpenExisting,
            BackupSemantics | OpenReparsePoint,
            IntPtr.Zero);
        if (handle.IsInvalid)
        {
            Exception error = LastError();
            handle.Dispose();
            throw error;
        }
        ByHandleFileInformation information = Information(handle);
        if ((information.FileAttributes & ReparseAttribute) != 0
            || (information.FileAttributes & DirectoryAttribute) == 0)
        {
            handle.Dispose();
            throw new InvalidOperationException("unsafe deletion ancestry entry");
        }
        return handle;
    }

    public static int DeleteTree(string path, int maxEntries, int maxDepth)
    {
        entryCount = 0;
        DeleteEntry(ExtendedPath(path), 0, maxEntries, maxDepth);
        return entryCount;
    }

    private static void DeleteEntry(string path, int depth, int maxEntries, int maxDepth)
    {
        if (depth > maxDepth) throw new InvalidOperationException("deletion depth limit");
        entryCount += 1;
        if (entryCount > maxEntries) throw new InvalidOperationException("deletion entry limit");

        SafeFileHandle handle = CreateFileW(
            path,
            DeleteAccess | ReadAttributes,
            ShareRead,
            IntPtr.Zero,
            OpenExisting,
            BackupSemantics | OpenReparsePoint,
            IntPtr.Zero);
        if (handle.IsInvalid)
        {
            Exception error = LastError();
            handle.Dispose();
            throw error;
        }
        try
        {
            ByHandleFileInformation information = Information(handle);
            bool isDirectory = (information.FileAttributes & DirectoryAttribute) != 0;
            bool isReparsePoint = (information.FileAttributes & ReparseAttribute) != 0;
            if (isDirectory && !isReparsePoint)
            {
                foreach (string child in Directory.EnumerateFileSystemEntries(path))
                {
                    DeleteEntry(child, depth + 1, maxEntries, maxDepth);
                }
            }
            FileDispositionInformation disposition = new FileDispositionInformation();
            disposition.DeleteFile = true;
            if (!SetFileInformationByHandle(
                handle,
                FileDispositionInfo,
                ref disposition,
                (uint)Marshal.SizeOf(typeof(FileDispositionInformation))))
            {
                throw LastError();
            }
        }
        finally
        {
            handle.Dispose();
        }
    }
}
'@

$handles = [System.Collections.Generic.List[Microsoft.Win32.SafeHandles.SafeFileHandle]]::new()
try {
  $directories = ConvertFrom-Json -InputObject $env:UEMCP_DELETE_ANCESTRY
  foreach ($directory in $directories) {
    $handles.Add([UemcpDeleteTreeNative]::OpenPinnedDirectory([string]$directory))
  }
  $entries = [UemcpDeleteTreeNative]::DeleteTree(
    $env:UEMCP_DELETE_TARGET,
    [int]$env:UEMCP_DELETE_MAX_ENTRIES,
    [int]$env:UEMCP_DELETE_MAX_DEPTH)
  [ordered]@{ status = 'removed'; entries = $entries } | ConvertTo-Json -Compress
} catch {
  [Console]::Error.Write($_.Exception.GetType().FullName)
  exit 74
} finally {
  for ($index = $handles.Count - 1; $index -ge 0; $index--) {
    $handles[$index].Dispose()
  }
}
`.trim();

const TREE_PIN_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

public static class UemcpPinnedTreeNative
{
    [StructLayout(LayoutKind.Sequential)]
    public struct ByHandleFileInformation
    {
        public uint FileAttributes;
        public System.Runtime.InteropServices.ComTypes.FILETIME CreationTime;
        public System.Runtime.InteropServices.ComTypes.FILETIME LastAccessTime;
        public System.Runtime.InteropServices.ComTypes.FILETIME LastWriteTime;
        public uint VolumeSerialNumber;
        public uint FileSizeHigh;
        public uint FileSizeLow;
        public uint NumberOfLinks;
        public uint FileIndexHigh;
        public uint FileIndexLow;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern SafeFileHandle CreateFileW(
        string fileName,
        uint desiredAccess,
        uint shareMode,
        IntPtr securityAttributes,
        uint creationDisposition,
        uint flagsAndAttributes,
        IntPtr templateFile);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool GetFileInformationByHandle(
        SafeFileHandle file,
        out ByHandleFileInformation information);

    private const uint ReadDataOrListDirectory = 0x00000001;
    private const uint ReadAttributes = 0x00000080;
    private const uint ShareRead = 0x00000001;
    private const uint OpenExisting = 3;
    private const uint BackupSemantics = 0x02000000;
    private const uint OpenReparsePoint = 0x00200000;
    private const uint DirectoryAttribute = 0x00000010;
    private const uint ReparseAttribute = 0x00000400;

    private static int entryCount;
    private static int fileCount;
    private static long totalBytes;
    private static volatile bool treeChanged;

    private static string ExtendedPath(string path)
    {
        if (path.StartsWith(@"\\?\")) return path;
        if (path.StartsWith(@"\\")) return @"\\?\UNC\" + path.Substring(2);
        return @"\\?\" + path;
    }

    private static Exception LastError()
    {
        return new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
    }

    private static ByHandleFileInformation Information(SafeFileHandle handle)
    {
        ByHandleFileInformation information;
        if (!GetFileInformationByHandle(handle, out information)) throw LastError();
        return information;
    }

    private static SafeFileHandle Open(string path, uint shareMode)
    {
        SafeFileHandle handle = CreateFileW(
            ExtendedPath(path),
            ReadDataOrListDirectory | ReadAttributes,
            shareMode,
            IntPtr.Zero,
            OpenExisting,
            BackupSemantics | OpenReparsePoint,
            IntPtr.Zero);
        if (handle.IsInvalid)
        {
            Exception error = LastError();
            handle.Dispose();
            throw error;
        }
        return handle;
    }

    public static SafeFileHandle OpenAncestry(string path)
    {
        SafeFileHandle handle = Open(path, 0x3);
        ByHandleFileInformation information = Information(handle);
        if ((information.FileAttributes & ReparseAttribute) != 0
            || (information.FileAttributes & DirectoryAttribute) == 0)
        {
            handle.Dispose();
            throw new InvalidOperationException("unsafe pinned tree ancestry");
        }
        return handle;
    }

    public static void PinRoots(
        string[] roots,
        List<SafeFileHandle> handles,
        int maxEntries,
        int maxFiles,
        long maxBytes)
    {
        entryCount = 0;
        fileCount = 0;
        totalBytes = 0;
        foreach (string root in roots)
        {
            SafeFileHandle rootHandle = Open(root, ShareRead);
            ByHandleFileInformation rootInformation = Information(rootHandle);
            if ((rootInformation.FileAttributes & ReparseAttribute) != 0
                || (rootInformation.FileAttributes & DirectoryAttribute) == 0)
            {
                rootHandle.Dispose();
                throw new InvalidOperationException("unsafe pinned tree root");
            }
            handles.Add(rootHandle);
            Visit(ExtendedPath(root), handles, maxEntries, maxFiles, maxBytes);
        }
    }

    private static void Visit(
        string directory,
        List<SafeFileHandle> handles,
        int maxEntries,
        int maxFiles,
        long maxBytes)
    {
        foreach (string child in Directory.EnumerateFileSystemEntries(directory))
        {
            entryCount += 1;
            if (entryCount > maxEntries) throw new InvalidOperationException("pinned tree entry limit");
            SafeFileHandle handle = Open(child, ShareRead);
            ByHandleFileInformation information = Information(handle);
            if ((information.FileAttributes & ReparseAttribute) != 0)
            {
                handle.Dispose();
                throw new InvalidOperationException("pinned tree contains a reparse point");
            }
            handles.Add(handle);
            if ((information.FileAttributes & DirectoryAttribute) != 0)
            {
                Visit(child, handles, maxEntries, maxFiles, maxBytes);
                continue;
            }
            if (information.NumberOfLinks != 1)
            {
                throw new InvalidOperationException("pinned tree contains a multiply linked file");
            }
            fileCount += 1;
            if (fileCount > maxFiles) throw new InvalidOperationException("pinned tree file limit");
            long size = ((long)information.FileSizeHigh << 32) | information.FileSizeLow;
            totalBytes += size;
            if (totalBytes > maxBytes) throw new InvalidOperationException("pinned tree byte limit");
        }
    }

    private static void MarkChanged(object sender, FileSystemEventArgs args)
    {
        treeChanged = true;
    }

    private static void MarkRenamed(object sender, RenamedEventArgs args)
    {
        treeChanged = true;
    }

    private static void MarkError(object sender, ErrorEventArgs args)
    {
        treeChanged = true;
    }

    public static List<FileSystemWatcher> StartWatchers(string[] roots)
    {
        treeChanged = false;
        List<FileSystemWatcher> watchers = new List<FileSystemWatcher>();
        foreach (string root in roots)
        {
            FileSystemWatcher watcher = new FileSystemWatcher(root);
            watcher.IncludeSubdirectories = true;
            watcher.InternalBufferSize = 65536;
            watcher.NotifyFilter = NotifyFilters.FileName
                | NotifyFilters.DirectoryName;
            watcher.Changed += MarkChanged;
            watcher.Created += MarkChanged;
            watcher.Deleted += MarkChanged;
            watcher.Renamed += MarkRenamed;
            watcher.Error += MarkError;
            watcher.EnableRaisingEvents = true;
            watchers.Add(watcher);
        }
        return watchers;
    }

    public static bool TreeChanged
    {
        get { return treeChanged; }
    }
}
'@

$handles = [System.Collections.Generic.List[Microsoft.Win32.SafeHandles.SafeFileHandle]]::new()
$watchers = [System.Collections.Generic.List[System.IO.FileSystemWatcher]]::new()
try {
  $request = ConvertFrom-Json -InputObject ([Console]::In.ReadLine())
  $ancestry = @($request.ancestry)
  foreach ($directory in $ancestry) {
    $handles.Add([UemcpPinnedTreeNative]::OpenAncestry([string]$directory))
  }
  [string[]]$roots = @($request.roots)
  $watchers = [UemcpPinnedTreeNative]::StartWatchers($roots)
  [UemcpPinnedTreeNative]::PinRoots(
    $roots,
    $handles,
    [int]$request.max_entries,
    [int]$request.max_files,
    [long]$request.max_bytes)
  [Console]::Out.WriteLine('READY')
  [Console]::Out.Flush()
  if ([Console]::In.ReadLine() -ne 'RELEASE') { throw 'invalid tree pin release signal' }
  [System.Threading.Thread]::Sleep(100)
  if ([UemcpPinnedTreeNative]::TreeChanged) { throw 'pinned tree changed during inspection' }
} catch {
  [Console]::Error.Write($_.Exception.GetType().FullName)
  exit 74
} finally {
  for ($index = $watchers.Count - 1; $index -ge 0; $index--) {
    $watchers[$index].Dispose()
  }
  for ($index = $handles.Count - 1; $index -ge 0; $index--) {
    $handles[$index].Dispose()
  }
}
`.trim();

const FILE_PIN_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

public static class UemcpPinnedFileNative
{
    [StructLayout(LayoutKind.Sequential)]
    public struct ByHandleFileInformation
    {
        public uint FileAttributes;
        public System.Runtime.InteropServices.ComTypes.FILETIME CreationTime;
        public System.Runtime.InteropServices.ComTypes.FILETIME LastAccessTime;
        public System.Runtime.InteropServices.ComTypes.FILETIME LastWriteTime;
        public uint VolumeSerialNumber;
        public uint FileSizeHigh;
        public uint FileSizeLow;
        public uint NumberOfLinks;
        public uint FileIndexHigh;
        public uint FileIndexLow;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern SafeFileHandle CreateFileW(
        string fileName,
        uint desiredAccess,
        uint shareMode,
        IntPtr securityAttributes,
        uint creationDisposition,
        uint flagsAndAttributes,
        IntPtr templateFile);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool GetFileInformationByHandle(
        SafeFileHandle file,
        out ByHandleFileInformation information);

    private const uint ReadDataOrListDirectory = 0x00000001;
    private const uint ReadAttributes = 0x00000080;
    private const uint ShareRead = 0x00000001;
    private const uint OpenExisting = 3;
    private const uint BackupSemantics = 0x02000000;
    private const uint OpenReparsePoint = 0x00200000;
    private const uint DirectoryAttribute = 0x00000010;
    private const uint ReparseAttribute = 0x00000400;

    private static string ExtendedPath(string path)
    {
        if (path.StartsWith(@"\\?\")) return path;
        if (path.StartsWith(@"\\")) return @"\\?\UNC\" + path.Substring(2);
        return @"\\?\" + path;
    }

    private static Exception LastError()
    {
        return new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
    }

    private static ByHandleFileInformation Information(SafeFileHandle handle)
    {
        ByHandleFileInformation information;
        if (!GetFileInformationByHandle(handle, out information)) throw LastError();
        return information;
    }

    private static SafeFileHandle Open(string path, uint shareMode)
    {
        SafeFileHandle handle = CreateFileW(
            ExtendedPath(path),
            ReadDataOrListDirectory | ReadAttributes,
            shareMode,
            IntPtr.Zero,
            OpenExisting,
            BackupSemantics | OpenReparsePoint,
            IntPtr.Zero);
        if (handle.IsInvalid)
        {
            Exception error = LastError();
            handle.Dispose();
            throw error;
        }
        return handle;
    }

    public static SafeFileHandle OpenAncestry(string path)
    {
        SafeFileHandle handle = Open(path, 0x3);
        ByHandleFileInformation information = Information(handle);
        if ((information.FileAttributes & ReparseAttribute) != 0
            || (information.FileAttributes & DirectoryAttribute) == 0)
        {
            handle.Dispose();
            throw new InvalidOperationException("unsafe pinned file ancestry");
        }
        return handle;
    }

    public static SafeFileHandle OpenFile(string path)
    {
        SafeFileHandle handle = Open(path, ShareRead);
        ByHandleFileInformation information = Information(handle);
        if ((information.FileAttributes & ReparseAttribute) != 0
            || (information.FileAttributes & DirectoryAttribute) != 0
            || information.NumberOfLinks != 1)
        {
            handle.Dispose();
            throw new InvalidOperationException("unsafe pinned launch file");
        }
        return handle;
    }
}
'@

$handles = [System.Collections.Generic.List[Microsoft.Win32.SafeHandles.SafeFileHandle]]::new()
try {
  $request = ConvertFrom-Json -InputObject ([Console]::In.ReadLine())
  foreach ($directory in @($request.ancestry)) {
    $handles.Add([UemcpPinnedFileNative]::OpenAncestry([string]$directory))
  }
  foreach ($path in @($request.paths)) {
    $handles.Add([UemcpPinnedFileNative]::OpenFile([string]$path))
  }
  [Console]::Out.WriteLine('READY')
  [Console]::Out.Flush()
  if ([Console]::In.ReadLine() -ne 'RELEASE') { throw 'invalid file pin release signal' }
} catch {
  [Console]::Error.Write($_.Exception.GetType().FullName)
  exit 74
} finally {
  for ($index = $handles.Count - 1; $index -ge 0; $index--) {
    $handles[$index].Dispose()
  }
}
`.trim();

const ANCESTRY_PIN_MAX_DIRECTORIES = 128;
const ANCESTRY_PIN_MAX_INPUT_BYTES = 16 * 1024;
const ANCESTRY_PIN_OUTPUT_LIMIT = 8 * 1024;
const DELETE_TREE_MAX_ENTRIES = 4_096;
const DELETE_TREE_MAX_DEPTH = 64;
const TREE_PIN_MAX_ROOTS = 2_048;
const TREE_PIN_MAX_INPUT_BYTES = 512 * 1024;
const TREE_PIN_OUTPUT_LIMIT = 8 * 1024;
const FILE_PIN_MAX_PATHS = 64;
const FILE_PIN_MAX_INPUT_BYTES = 64 * 1024;

export class WindowsNativeError extends Error {
  constructor(message, code = 'WINDOWS_NATIVE_FAILED', details = {}) {
    super(message);
    this.name = 'WindowsNativeError';
    this.code = code;
    this.details = details;
  }
}

function powershellPath(systemRoot) {
  if (typeof systemRoot !== 'string' || systemRoot.trim() === '') {
    throw new WindowsNativeError('SystemRoot is required', 'SYSTEM_ROOT_UNAVAILABLE');
  }
  return resolve(join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'));
}

function powershellArgs() {
  return ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '-'];
}

function encodedPowerShell(script) {
  return Buffer.from(script, 'utf16le').toString('base64');
}

function minimalEnvironment(systemRoot, extra) {
  return {
    SystemRoot: resolve(systemRoot),
    WINDIR: resolve(systemRoot),
    PSModulePath: join(resolve(systemRoot), 'System32', 'WindowsPowerShell', 'v1.0', 'Modules'),
    ...extra,
  };
}

function parseSingleJson(result, expectedKeys) {
  if (result?.status !== 'exited' || result.exitCode !== 0 || typeof result.stderr !== 'string' || result.stderr.length !== 0) {
    throw new WindowsNativeError('bounded PowerShell helper did not exit cleanly');
  }
  const stdout = typeof result.stdout === 'string' ? result.stdout.trim() : '';
  if (stdout === '' || stdout.includes('\n') || stdout.includes('\r')) {
    throw new WindowsNativeError('PowerShell helper returned malformed or extra output');
  }
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new WindowsNativeError('PowerShell helper returned invalid JSON');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new WindowsNativeError('PowerShell helper returned a non-object');
  }
  const keys = Object.keys(parsed).sort();
  const expected = [...expectedKeys].sort();
  if (JSON.stringify(keys) !== JSON.stringify(expected)) {
    throw new WindowsNativeError('PowerShell helper returned an unexpected schema');
  }
  return parsed;
}

function windowsPathKey(path) {
  return resolve(path).toLowerCase();
}

async function waitForHelperClose(closePromise, timeoutMs) {
  let timer;
  const closed = await Promise.race([
    closePromise.then(() => true),
    new Promise(resolvePromise => {
      timer = setTimeout(() => resolvePromise(false), timeoutMs);
    }),
  ]);
  clearTimeout(timer);
  return closed;
}

function validatePinnedDirectories(directories) {
  if (!Array.isArray(directories)
    || directories.length === 0
    || directories.length > ANCESTRY_PIN_MAX_DIRECTORIES
    || !directories.every(path => typeof path === 'string'
      && isAbsolute(path)
      && !/^(?:\\\\[?.]\\|\\\\GLOBALROOT\\)/i.test(path))) {
    throw new WindowsNativeError('pinned ancestry is invalid', 'INVALID_ANCESTRY_PIN');
  }
  const normalized = directories.map(path => resolve(path));
  if (windowsPathKey(normalized[0]) !== windowsPathKey(parse(normalized[0]).root)) {
    throw new WindowsNativeError('pinned ancestry must start at its volume root', 'INVALID_ANCESTRY_PIN');
  }
  const seen = new Set();
  for (let index = 0; index < normalized.length; index += 1) {
    const key = windowsPathKey(normalized[index]);
    if (seen.has(key)) throw new WindowsNativeError('pinned ancestry contains a duplicate', 'INVALID_ANCESTRY_PIN');
    seen.add(key);
    if (index > 0 && windowsPathKey(dirname(normalized[index])) !== windowsPathKey(normalized[index - 1])) {
      throw new WindowsNativeError('pinned ancestry is not a direct directory chain', 'INVALID_ANCESTRY_PIN');
    }
  }
  const serialized = JSON.stringify(normalized);
  if (Buffer.byteLength(serialized, 'utf8') > ANCESTRY_PIN_MAX_INPUT_BYTES) {
    throw new WindowsNativeError('pinned ancestry exceeds its input limit', 'INVALID_ANCESTRY_PIN');
  }
  return { normalized, serialized };
}

export async function withPinnedWindowsAncestry({
  directories,
  callback,
  platform = process.platform,
  systemRoot = process.env.SystemRoot || process.env.WINDIR,
  spawnImpl = defaultSpawn,
  acquisitionTimeoutMs = 15_000,
  releaseTimeoutMs = 5_000,
} = {}) {
  if (typeof callback !== 'function'
    || typeof spawnImpl !== 'function'
    || !Number.isSafeInteger(acquisitionTimeoutMs)
    || acquisitionTimeoutMs <= 0
    || !Number.isSafeInteger(releaseTimeoutMs)
    || releaseTimeoutMs <= 0) {
    throw new WindowsNativeError('pinned ancestry options are invalid', 'INVALID_ANCESTRY_PIN');
  }
  const { normalized, serialized } = validatePinnedDirectories(directories);
  if (platform !== 'win32') {
    return callback(Object.freeze({ assertPinned() {} }));
  }
  const executable = powershellPath(systemRoot);
  let child;
  try {
    child = spawnImpl(executable, [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-EncodedCommand',
      encodedPowerShell(ANCESTRY_PIN_SCRIPT),
    ], {
      env: minimalEnvironment(systemRoot, { UEMCP_ANCESTRY_DIRECTORIES: serialized }),
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch {
    throw new WindowsNativeError('pinned ancestry helper could not start', 'ANCESTRY_PIN_FAILED');
  }

  let stdout = '';
  let stderr = '';
  let outputBytes = 0;
  let ready = false;
  let closed = false;
  let closeCode = null;
  let closeSignal = null;
  let protocolError = null;
  let settleReady;
  let rejectReady;
  const readyPromise = new Promise((resolvePromise, rejectPromise) => {
    settleReady = resolvePromise;
    rejectReady = rejectPromise;
  });
  const closePromise = new Promise(resolvePromise => {
    child.once('close', (code, signal) => {
      closed = true;
      closeCode = code;
      closeSignal = signal;
      if (!ready) rejectReady(new WindowsNativeError('pinned ancestry helper exited before acquisition', 'ANCESTRY_PIN_FAILED'));
      resolvePromise();
    });
  });
  const stopHelper = message => {
    if (protocolError === null) protocolError = new WindowsNativeError(message, 'ANCESTRY_PIN_FAILED');
    if (!ready) rejectReady(protocolError);
    try {
      child.kill('SIGKILL');
    } catch {
      // The helper may already have exited.
    }
  };
  const capture = (chunk, stream) => {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    outputBytes += bytes.byteLength;
    if (outputBytes > ANCESTRY_PIN_OUTPUT_LIMIT) {
      stopHelper('pinned ancestry helper exceeded its output limit');
      return;
    }
    if (stream === 'stdout') {
      stdout += bytes.toString('utf8');
      const newline = stdout.indexOf('\n');
      if (!ready && newline >= 0) {
        const line = stdout.slice(0, newline).replace(/\r$/, '');
        if (line !== 'READY' || stdout.slice(newline + 1) !== '') {
          stopHelper('pinned ancestry helper returned an invalid handshake');
          return;
        }
        ready = true;
        settleReady();
      } else if (ready && stdout !== 'READY\n' && stdout !== 'READY\r\n') {
        stopHelper('pinned ancestry helper returned extra output');
      }
    } else {
      stderr += bytes.toString('utf8');
      stopHelper('pinned ancestry helper returned an error');
    }
  };
  child.stdout?.on('data', chunk => capture(chunk, 'stdout'));
  child.stderr?.on('data', chunk => capture(chunk, 'stderr'));
  child.stdin?.once('error', () => {});
  child.once('error', () => stopHelper('pinned ancestry helper failed to start'));

  const acquisitionTimer = setTimeout(() => stopHelper('pinned ancestry helper timed out'), acquisitionTimeoutMs);
  acquisitionTimer.unref?.();
  let acquisitionError = null;
  try {
    await readyPromise;
  } catch (error) {
    acquisitionError = error;
  } finally {
    clearTimeout(acquisitionTimer);
  }
  if (acquisitionError !== null) {
    const helperClosed = closed || await waitForHelperClose(closePromise, Math.min(releaseTimeoutMs, 1_000));
    if (helperClosed) await new Promise(resolvePromise => setTimeout(resolvePromise, 50));
    throw acquisitionError;
  }

  const guard = Object.freeze({
    directories: Object.freeze([...normalized]),
    assertPinned() {
      if (!ready || closed || protocolError !== null) {
        throw protocolError ?? new WindowsNativeError('pinned ancestry helper was lost', 'ANCESTRY_PIN_FAILED');
      }
    },
  });
  let value;
  let callbackError = null;
  try {
    guard.assertPinned();
    value = await callback(guard);
    guard.assertPinned();
  } catch (error) {
    callbackError = error;
  }

  if (!closed && child.stdin) child.stdin.end('RELEASE\n');
  if (!closed) {
    let releaseTimer;
    const releaseTimeout = new Promise(resolvePromise => {
      releaseTimer = setTimeout(resolvePromise, releaseTimeoutMs);
      releaseTimer.unref?.();
    });
    await Promise.race([closePromise, releaseTimeout]);
    clearTimeout(releaseTimer);
  }
  if (!closed) {
    stopHelper('pinned ancestry helper did not release in time');
    await Promise.race([closePromise, new Promise(resolvePromise => setTimeout(resolvePromise, 250))]);
  }
  if (protocolError !== null || !closed || closeCode !== 0 || closeSignal !== null || stderr !== '') {
    throw protocolError ?? new WindowsNativeError('pinned ancestry helper did not release cleanly', 'ANCESTRY_PIN_FAILED');
  }
  if (callbackError) throw callbackError;
  return value;
}

function containedPath(root, candidate) {
  const rel = relative(windowsPathKey(root), windowsPathKey(candidate));
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function validatePinnedTreeOptions({ roots, maxEntries, maxFiles, maxBytes }) {
  if (!Array.isArray(roots)
    || roots.length === 0
    || roots.length > TREE_PIN_MAX_ROOTS
    || !Number.isSafeInteger(maxEntries)
    || maxEntries <= 0
    || !Number.isSafeInteger(maxFiles)
    || maxFiles <= 0
    || maxFiles > maxEntries
    || !Number.isSafeInteger(maxBytes)
    || maxBytes < 0) {
    throw new WindowsNativeError('pinned tree options are invalid', 'INVALID_TREE_PIN');
  }
  const normalized = roots.map(root => {
    if (typeof root !== 'string'
      || !isAbsolute(root)
      || /^(?:\\\\[?.]\\|\\\\GLOBALROOT\\)/i.test(root)) {
      throw new WindowsNativeError('pinned tree root is invalid', 'INVALID_TREE_PIN');
    }
    return resolve(root);
  });
  const seen = new Set();
  for (const root of normalized) {
    const key = windowsPathKey(root);
    if (seen.has(key)) throw new WindowsNativeError('pinned tree roots contain a duplicate', 'INVALID_TREE_PIN');
    seen.add(key);
  }
  for (let left = 0; left < normalized.length; left += 1) {
    for (let right = left + 1; right < normalized.length; right += 1) {
      if (containedPath(normalized[left], normalized[right]) || containedPath(normalized[right], normalized[left])) {
        throw new WindowsNativeError('pinned tree roots overlap', 'INVALID_TREE_PIN');
      }
    }
  }

  const ancestryByKey = new Map();
  for (const root of normalized) {
    let current = dirname(root);
    const chain = [];
    while (true) {
      chain.unshift(current);
      const next = dirname(current);
      if (windowsPathKey(next) === windowsPathKey(current)) break;
      current = next;
    }
    validatePinnedDirectories(chain);
    for (const directory of chain) ancestryByKey.set(windowsPathKey(directory), directory);
  }
  const ancestry = [...ancestryByKey.values()].sort((left, right) => {
    const leftDepth = left.split(/[\\/]/).filter(Boolean).length;
    const rightDepth = right.split(/[\\/]/).filter(Boolean).length;
    return leftDepth - rightDepth || left.localeCompare(right);
  });
  const serializedRequest = JSON.stringify({
    roots: normalized,
    ancestry,
    max_entries: maxEntries,
    max_files: maxFiles,
    max_bytes: maxBytes,
  });
  if (Buffer.byteLength(serializedRequest, 'utf8') > TREE_PIN_MAX_INPUT_BYTES) {
    throw new WindowsNativeError('pinned tree roots exceed the input limit', 'INVALID_TREE_PIN');
  }
  return { normalized, serializedRequest };
}

export async function withPinnedWindowsTrees({
  roots,
  callback,
  maxEntries,
  maxFiles,
  maxBytes,
  platform = process.platform,
  systemRoot = process.env.SystemRoot || process.env.WINDIR,
  spawnImpl = defaultSpawn,
  acquisitionTimeoutMs = 30_000,
  releaseTimeoutMs = 5_000,
} = {}) {
  if (typeof callback !== 'function'
    || typeof spawnImpl !== 'function'
    || !Number.isSafeInteger(acquisitionTimeoutMs)
    || acquisitionTimeoutMs <= 0
    || !Number.isSafeInteger(releaseTimeoutMs)
    || releaseTimeoutMs <= 0) {
    throw new WindowsNativeError('pinned tree callback options are invalid', 'INVALID_TREE_PIN');
  }
  const validated = validatePinnedTreeOptions({ roots, maxEntries, maxFiles, maxBytes });
  if (platform !== 'win32') {
    return callback(Object.freeze({ roots: Object.freeze([...validated.normalized]), assertPinned() {} }));
  }

  const executable = powershellPath(systemRoot);
  let child;
  try {
    child = spawnImpl(executable, [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-EncodedCommand',
      encodedPowerShell(TREE_PIN_SCRIPT),
    ], {
      env: minimalEnvironment(systemRoot, {}),
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch {
    throw new WindowsNativeError('pinned tree helper could not start', 'TREE_PIN_FAILED');
  }

  let stdout = '';
  let stderr = '';
  let outputBytes = 0;
  let ready = false;
  let closed = false;
  let closeCode = null;
  let closeSignal = null;
  let protocolError = null;
  let settleReady;
  let rejectReady;
  const readyPromise = new Promise((resolvePromise, rejectPromise) => {
    settleReady = resolvePromise;
    rejectReady = rejectPromise;
  });
  const closePromise = new Promise(resolvePromise => {
    child.once('close', (code, signal) => {
      closed = true;
      closeCode = code;
      closeSignal = signal;
      if (!ready) rejectReady(new WindowsNativeError('pinned tree helper exited before acquisition', 'TREE_PIN_FAILED'));
      resolvePromise();
    });
  });
  const stopHelper = message => {
    if (protocolError === null) protocolError = new WindowsNativeError(message, 'TREE_PIN_FAILED');
    if (!ready) rejectReady(protocolError);
    try {
      child.kill('SIGKILL');
    } catch {
      // The helper may already have exited.
    }
  };
  const capture = (chunk, stream) => {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    outputBytes += bytes.byteLength;
    if (outputBytes > TREE_PIN_OUTPUT_LIMIT) {
      stopHelper('pinned tree helper exceeded its output limit');
      return;
    }
    if (stream === 'stdout') {
      stdout += bytes.toString('utf8');
      const newline = stdout.indexOf('\n');
      if (!ready && newline >= 0) {
        const line = stdout.slice(0, newline).replace(/\r$/, '');
        if (line !== 'READY' || stdout.slice(newline + 1) !== '') {
          stopHelper('pinned tree helper returned an invalid handshake');
          return;
        }
        ready = true;
        settleReady();
      } else if (ready && stdout !== 'READY\n' && stdout !== 'READY\r\n') {
        stopHelper('pinned tree helper returned extra output');
      }
    } else {
      stderr += bytes.toString('utf8');
      stopHelper('pinned tree helper returned an error');
    }
  };
  child.stdout?.on('data', chunk => capture(chunk, 'stdout'));
  child.stderr?.on('data', chunk => capture(chunk, 'stderr'));
  child.stdin?.once('error', () => {});
  child.once('error', () => stopHelper('pinned tree helper failed to start'));
  child.stdin?.write(`${validated.serializedRequest}\n`);

  const acquisitionTimer = setTimeout(() => stopHelper('pinned tree helper timed out'), acquisitionTimeoutMs);
  acquisitionTimer.unref?.();
  let acquisitionError = null;
  try {
    await readyPromise;
  } catch (error) {
    acquisitionError = error;
  } finally {
    clearTimeout(acquisitionTimer);
  }
  if (acquisitionError !== null) {
    const helperClosed = closed || await waitForHelperClose(closePromise, Math.min(releaseTimeoutMs, 1_000));
    if (helperClosed) await new Promise(resolvePromise => setTimeout(resolvePromise, 50));
    throw acquisitionError;
  }

  const guard = Object.freeze({
    roots: Object.freeze([...validated.normalized]),
    assertPinned() {
      if (!ready || closed || protocolError !== null) {
        throw protocolError ?? new WindowsNativeError('pinned tree helper was lost', 'TREE_PIN_FAILED');
      }
    },
  });
  let value;
  let callbackError = null;
  try {
    guard.assertPinned();
    value = await callback(guard);
    guard.assertPinned();
  } catch (error) {
    callbackError = error;
  }

  if (!closed && child.stdin) child.stdin.end('RELEASE\n');
  if (!closed) {
    let releaseTimer;
    const releaseTimeout = new Promise(resolvePromise => {
      releaseTimer = setTimeout(resolvePromise, releaseTimeoutMs);
      releaseTimer.unref?.();
    });
    await Promise.race([closePromise, releaseTimeout]);
    clearTimeout(releaseTimer);
  }
  if (!closed) {
    stopHelper('pinned tree helper did not release in time');
    await Promise.race([closePromise, new Promise(resolvePromise => setTimeout(resolvePromise, 250))]);
  }
  if (protocolError !== null || !closed || closeCode !== 0 || closeSignal !== null || stderr !== '') {
    throw protocolError ?? new WindowsNativeError('pinned tree helper did not release cleanly', 'TREE_PIN_FAILED');
  }
  if (callbackError) throw callbackError;
  return value;
}

function validatePinnedFilePaths(paths) {
  if (!Array.isArray(paths) || paths.length === 0 || paths.length > FILE_PIN_MAX_PATHS) {
    throw new WindowsNativeError('pinned file paths are invalid', 'INVALID_FILE_PIN');
  }
  const normalized = [];
  const seen = new Set();
  for (const path of paths) {
    if (typeof path !== 'string'
      || !isAbsolute(path)
      || /^(?:\\\\[?.]\\|\\\\GLOBALROOT\\)/i.test(path)) {
      throw new WindowsNativeError('pinned file path is invalid', 'INVALID_FILE_PIN');
    }
    const absolute = resolve(path);
    const key = windowsPathKey(absolute);
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(absolute);
  }
  const ancestryByKey = new Map();
  for (const path of normalized) {
    let current = dirname(path);
    const chain = [];
    while (true) {
      chain.unshift(current);
      const next = dirname(current);
      if (windowsPathKey(next) === windowsPathKey(current)) break;
      current = next;
    }
    validatePinnedDirectories(chain);
    for (const directory of chain) ancestryByKey.set(windowsPathKey(directory), directory);
  }
  const ancestry = [...ancestryByKey.values()].sort((left, right) => {
    const leftDepth = left.split(/[\\/]/).filter(Boolean).length;
    const rightDepth = right.split(/[\\/]/).filter(Boolean).length;
    return leftDepth - rightDepth || left.localeCompare(right);
  });
  const serializedRequest = JSON.stringify({ paths: normalized, ancestry });
  if (Buffer.byteLength(serializedRequest, 'utf8') > FILE_PIN_MAX_INPUT_BYTES) {
    throw new WindowsNativeError('pinned file paths exceed the input limit', 'INVALID_FILE_PIN');
  }
  return { normalized, serializedRequest };
}

export async function withPinnedWindowsFiles({
  paths,
  callback,
  platform = process.platform,
  systemRoot = process.env.SystemRoot || process.env.WINDIR,
  spawnImpl = defaultSpawn,
  acquisitionTimeoutMs = 15_000,
  releaseTimeoutMs = 5_000,
} = {}) {
  if (typeof callback !== 'function'
    || typeof spawnImpl !== 'function'
    || !Number.isSafeInteger(acquisitionTimeoutMs)
    || acquisitionTimeoutMs <= 0
    || !Number.isSafeInteger(releaseTimeoutMs)
    || releaseTimeoutMs <= 0) {
    throw new WindowsNativeError('pinned file callback options are invalid', 'INVALID_FILE_PIN');
  }
  const validated = validatePinnedFilePaths(paths);
  if (platform !== 'win32') {
    return callback(Object.freeze({ paths: Object.freeze([...validated.normalized]), assertPinned() {} }));
  }

  const executable = powershellPath(systemRoot);
  let child;
  try {
    child = spawnImpl(executable, [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-EncodedCommand',
      encodedPowerShell(FILE_PIN_SCRIPT),
    ], {
      env: minimalEnvironment(systemRoot, {}),
      shell: false,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch {
    throw new WindowsNativeError('pinned file helper could not start', 'FILE_PIN_FAILED');
  }

  let stdout = '';
  let stderr = '';
  let outputBytes = 0;
  let ready = false;
  let closed = false;
  let closeCode = null;
  let closeSignal = null;
  let protocolError = null;
  let settleReady;
  let rejectReady;
  const readyPromise = new Promise((resolvePromise, rejectPromise) => {
    settleReady = resolvePromise;
    rejectReady = rejectPromise;
  });
  const closePromise = new Promise(resolvePromise => {
    child.once('close', (code, signal) => {
      closed = true;
      closeCode = code;
      closeSignal = signal;
      if (!ready) rejectReady(new WindowsNativeError('pinned file helper exited before acquisition', 'FILE_PIN_FAILED'));
      resolvePromise();
    });
  });
  const stopHelper = message => {
    if (protocolError === null) protocolError = new WindowsNativeError(message, 'FILE_PIN_FAILED');
    if (!ready) rejectReady(protocolError);
    try {
      child.kill('SIGKILL');
    } catch {
      // The helper may already have exited.
    }
  };
  const capture = (chunk, stream) => {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    outputBytes += bytes.byteLength;
    if (outputBytes > TREE_PIN_OUTPUT_LIMIT) {
      stopHelper('pinned file helper exceeded its output limit');
      return;
    }
    if (stream === 'stdout') {
      stdout += bytes.toString('utf8');
      const newline = stdout.indexOf('\n');
      if (!ready && newline >= 0) {
        const line = stdout.slice(0, newline).replace(/\r$/, '');
        if (line !== 'READY' || stdout.slice(newline + 1) !== '') {
          stopHelper('pinned file helper returned an invalid handshake');
          return;
        }
        ready = true;
        settleReady();
      } else if (ready && stdout !== 'READY\n' && stdout !== 'READY\r\n') {
        stopHelper('pinned file helper returned extra output');
      }
    } else {
      stderr += bytes.toString('utf8');
      stopHelper('pinned file helper returned an error');
    }
  };
  child.stdout?.on('data', chunk => capture(chunk, 'stdout'));
  child.stderr?.on('data', chunk => capture(chunk, 'stderr'));
  child.stdin?.once('error', () => {});
  child.once('error', () => stopHelper('pinned file helper failed to start'));
  child.stdin?.write(`${validated.serializedRequest}\n`);

  const acquisitionTimer = setTimeout(() => stopHelper('pinned file helper timed out'), acquisitionTimeoutMs);
  acquisitionTimer.unref?.();
  let acquisitionError = null;
  try {
    await readyPromise;
  } catch (error) {
    acquisitionError = error;
  } finally {
    clearTimeout(acquisitionTimer);
  }
  if (acquisitionError !== null) {
    const helperClosed = closed || await waitForHelperClose(closePromise, Math.min(releaseTimeoutMs, 1_000));
    if (helperClosed) await new Promise(resolvePromise => setTimeout(resolvePromise, 50));
    throw acquisitionError;
  }

  const guard = Object.freeze({
    paths: Object.freeze([...validated.normalized]),
    assertPinned() {
      if (!ready || closed || protocolError !== null) {
        throw protocolError ?? new WindowsNativeError('pinned file helper was lost', 'FILE_PIN_FAILED');
      }
    },
  });
  let value;
  let callbackError = null;
  try {
    guard.assertPinned();
    value = await callback(guard);
    guard.assertPinned();
  } catch (error) {
    callbackError = error;
  }

  if (!closed && child.stdin) child.stdin.end('RELEASE\n');
  if (!closed) {
    let releaseTimer;
    const releaseTimeout = new Promise(resolvePromise => {
      releaseTimer = setTimeout(resolvePromise, releaseTimeoutMs);
      releaseTimer.unref?.();
    });
    await Promise.race([closePromise, releaseTimeout]);
    clearTimeout(releaseTimer);
  }
  if (!closed) {
    stopHelper('pinned file helper did not release in time');
    await Promise.race([closePromise, new Promise(resolvePromise => setTimeout(resolvePromise, 250))]);
  }
  if (protocolError !== null || !closed || closeCode !== 0 || closeSignal !== null || stderr !== '') {
    throw protocolError ?? new WindowsNativeError('pinned file helper did not release cleanly', 'FILE_PIN_FAILED');
  }
  if (callbackError) throw callbackError;
  return value;
}

function deletionAncestry(targetPath, allowedRoot) {
  if (typeof targetPath !== 'string'
    || typeof allowedRoot !== 'string'
    || !isAbsolute(targetPath)
    || !isAbsolute(allowedRoot)
    || /^(?:\\\\[?.]\\|\\\\GLOBALROOT\\)/i.test(targetPath)
    || /^(?:\\\\[?.]\\|\\\\GLOBALROOT\\)/i.test(allowedRoot)) {
    throw new WindowsNativeError('tree deletion paths are invalid', 'INVALID_TREE_DELETE');
  }
  const target = resolve(targetPath);
  const allowed = resolve(allowedRoot);
  if (!containedPath(allowed, target) || windowsPathKey(target) === windowsPathKey(allowed)) {
    throw new WindowsNativeError('tree deletion target is outside its allowed root', 'INVALID_TREE_DELETE');
  }

  const parent = dirname(target);
  const directories = [];
  let current = parent;
  while (true) {
    directories.unshift(current);
    const next = dirname(current);
    if (windowsPathKey(next) === windowsPathKey(current)) break;
    current = next;
  }
  const validated = validatePinnedDirectories(directories);
  return { target, serializedAncestry: validated.serialized };
}

export async function deleteWindowsTreeNoFollow({
  targetPath,
  allowedRoot,
  runner,
  platform = process.platform,
  systemRoot = process.env.SystemRoot || process.env.WINDIR,
  fsImpl = defaultFs,
  maxEntries = DELETE_TREE_MAX_ENTRIES,
  maxDepth = DELETE_TREE_MAX_DEPTH,
} = {}) {
  const { target, serializedAncestry } = deletionAncestry(targetPath, allowedRoot);
  if (platform !== 'win32') {
    throw new WindowsNativeError('no-follow tree deletion requires Windows', 'UNSUPPORTED_PLATFORM');
  }
  if (!runner?.run
    || !Number.isSafeInteger(maxEntries)
    || maxEntries <= 0
    || maxEntries > DELETE_TREE_MAX_ENTRIES
    || !Number.isSafeInteger(maxDepth)
    || maxDepth <= 0
    || maxDepth > DELETE_TREE_MAX_DEPTH) {
    throw new WindowsNativeError('tree deletion options are invalid', 'INVALID_TREE_DELETE');
  }
  try {
    const stat = await fsImpl.lstat(target);
    if (!stat.isDirectory() && !stat.isSymbolicLink() && !stat.isFile()) {
      throw new WindowsNativeError('tree deletion target has an unsupported type', 'UNSAFE_PATH_TYPE');
    }
  } catch (error) {
    if (error?.code === 'ENOENT') return { status: 'absent', entries: 0 };
    throw error;
  }

  const result = await runner.run(powershellPath(systemRoot), powershellArgs(), {
    env: minimalEnvironment(systemRoot, {
      UEMCP_DELETE_TARGET: target,
      UEMCP_DELETE_ANCESTRY: serializedAncestry,
      UEMCP_DELETE_MAX_ENTRIES: String(maxEntries),
      UEMCP_DELETE_MAX_DEPTH: String(maxDepth),
    }),
    stdin: `${DELETE_TREE_SCRIPT}\n\n`,
    timeoutMs: 30_000,
    outputLimitBytes: 8 * 1024,
  });
  const parsed = parseSingleJson(result, ['entries', 'status']);
  if (parsed.status !== 'removed'
    || !Number.isSafeInteger(parsed.entries)
    || parsed.entries <= 0
    || parsed.entries > maxEntries) {
    throw new WindowsNativeError('tree deletion helper returned invalid evidence', 'TREE_DELETE_FAILED');
  }
  return { status: parsed.status, entries: parsed.entries };
}

async function assertRegularSinglePath(path, { allowedRoots, fsImpl, allowMultipleLinks = false }) {
  const fingerprint = await fingerprintPath(path, { allowedRoots, fsImpl });
  if (!fingerprint.exists || fingerprint.kind !== 'file' || fingerprint.link_kind !== 'none') {
    throw new WindowsNativeError('Windows-native helper target must be a regular non-linked file', 'UNSAFE_PATH_TYPE');
  }
  if (!allowMultipleLinks && fingerprint.link_count !== 1) {
    throw new WindowsNativeError('Windows-native helper target must have one hard link', 'UNSAFE_LINK_COUNT');
  }
  return fingerprint;
}

export async function inspectAuthenticode(executable, {
  runner,
  systemRoot = process.env.SystemRoot || process.env.WINDIR,
  expectedSignerNames = [],
  allowedRoots = [dirname(resolve(executable))],
  fsImpl = defaultFs,
} = {}) {
  if (!runner?.run) throw new WindowsNativeError('runner is required');
  let fingerprint;
  try {
    fingerprint = await assertRegularSinglePath(executable, { allowedRoots, fsImpl, allowMultipleLinks: true });
    const result = await runner.run(powershellPath(systemRoot), powershellArgs(), {
      env: minimalEnvironment(systemRoot, { UEMCP_AUTHENTICODE_TARGET: fingerprint.canonical_path }),
      stdin: `${AUTHENTICODE_SCRIPT}\n\n`,
      timeoutMs: 15_000,
      outputLimitBytes: 8 * 1024,
    });
    const parsed = parseSingleJson(result, ['status', 'signer_name', 'thumbprint']);
    const signerName = parsed.signer_name === null ? null : String(parsed.signer_name);
    const thumbprint = parsed.thumbprint === null ? null : String(parsed.thumbprint).toUpperCase();
    const signatureValid = String(parsed.status).toLowerCase() === 'valid';
    const signerAllowed = expectedSignerNames.length === 0
      || (signerName !== null && expectedSignerNames.some(name => name.localeCompare(signerName, undefined, { sensitivity: 'accent' }) === 0));
    const thumbprintValid = thumbprint === null || /^[0-9A-F]{2,128}$/.test(thumbprint);
    return {
      status: signatureValid && signerAllowed && thumbprintValid ? 'valid' : 'invalid',
      signer_name: signerName,
      thumbprint: thumbprintValid ? thumbprint : null,
    };
  } catch {
    return { status: 'unavailable', signer_name: null, thumbprint: null };
  }
}

export async function fingerprintWindowsFileMetadata(path, {
  runner,
  systemRoot = process.env.SystemRoot || process.env.WINDIR,
  maxStreams = 64,
  maxStreamBytes = 16 * 1024 * 1024,
  allowedRoots = [dirname(resolve(path))],
  fsImpl = defaultFs,
} = {}) {
  if (!runner?.run) throw new WindowsNativeError('runner is required');
  if (!Number.isSafeInteger(maxStreams) || maxStreams < 0) throw new WindowsNativeError('maxStreams is invalid');
  if (!Number.isSafeInteger(maxStreamBytes) || maxStreamBytes < 0) throw new WindowsNativeError('maxStreamBytes is invalid');
  const fingerprint = await assertRegularSinglePath(path, { allowedRoots, fsImpl, allowMultipleLinks: false });
  const result = await runner.run(powershellPath(systemRoot), powershellArgs(), {
    env: minimalEnvironment(systemRoot, {
      UEMCP_METADATA_TARGET: fingerprint.canonical_path,
      UEMCP_MAX_STREAMS: String(maxStreams),
      UEMCP_MAX_STREAM_BYTES: String(maxStreamBytes),
    }),
    stdin: `${METADATA_SCRIPT}\n\n`,
    timeoutMs: 30_000,
    outputLimitBytes: 8 * 1024,
  });
  const parsed = parseSingleJson(result, ['metadata_sha256', 'stream_count', 'stream_bytes']);
  if (!/^[0-9a-f]{64}$/.test(parsed.metadata_sha256)
    || !Number.isSafeInteger(parsed.stream_count)
    || !Number.isSafeInteger(parsed.stream_bytes)
    || parsed.stream_count < 0
    || parsed.stream_bytes < 0
    || parsed.stream_count > maxStreams
    || parsed.stream_bytes > maxStreamBytes) {
    throw new WindowsNativeError('metadata helper returned invalid aggregate evidence');
  }
  return {
    metadata_sha256: parsed.metadata_sha256,
    stream_count: parsed.stream_count,
    stream_bytes: parsed.stream_bytes,
  };
}

export async function replaceFilePreservingMetadata({
  replacementPath,
  destinationPath,
  runner,
  systemRoot = process.env.SystemRoot || process.env.WINDIR,
  fsImpl = defaultFs,
}) {
  if (!runner?.run) throw new WindowsNativeError('runner is required');
  const replacement = resolve(replacementPath);
  const destination = resolve(destinationPath);
  if (dirname(replacement).toLowerCase() !== dirname(destination).toLowerCase()
    || parse(replacement).root.toLowerCase() !== parse(destination).root.toLowerCase()) {
    throw new WindowsNativeError('replacement and destination must share one directory and volume', 'REPLACEMENT_BOUNDARY_VIOLATION');
  }
  await assertRegularSinglePath(replacement, { allowedRoots: [dirname(destination)], fsImpl });
  await assertRegularSinglePath(destination, { allowedRoots: [dirname(destination)], fsImpl });
  const backup = join(dirname(destination), `.${randomBytes(16).toString('hex')}.uemcp-backup`);
  let parsed;
  let replaceError = null;
  try {
    const result = await runner.run(powershellPath(systemRoot), powershellArgs(), {
      env: minimalEnvironment(systemRoot, {
        UEMCP_REPLACEMENT_PATH: replacement,
        UEMCP_DESTINATION_PATH: destination,
        UEMCP_BACKUP_PATH: backup,
      }),
      stdin: `${REPLACE_SCRIPT}\n\n`,
      timeoutMs: 30_000,
      outputLimitBytes: 8 * 1024,
    });
    parsed = parseSingleJson(result, ['status']);
  } catch (error) {
    replaceError = error;
  }
  try {
    await fsImpl.rm(backup, { force: true });
  } catch {
    throw new WindowsNativeError('metadata-preserving replacement backup cleanup failed');
  }
  if (replaceError) throw replaceError;
  if (parsed.status !== 'replaced') throw new WindowsNativeError('metadata-preserving replacement failed');
  return { status: 'replaced' };
}

export const WINDOWS_NATIVE_SCRIPTS = Object.freeze({
  ancestry_pin: ANCESTRY_PIN_SCRIPT,
  authenticode: AUTHENTICODE_SCRIPT,
  delete_tree: DELETE_TREE_SCRIPT,
  file_pin: FILE_PIN_SCRIPT,
  metadata: METADATA_SCRIPT,
  replace: REPLACE_SCRIPT,
  tree_pin: TREE_PIN_SCRIPT,
});
