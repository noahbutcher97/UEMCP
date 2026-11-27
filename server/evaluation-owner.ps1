# Win64 worker lifetime. Only this process owns the non-inheritable job handle.
# Closing the supervisor (including abrupt termination) kills all descendants.
param([Parameter(Mandatory)][string]$Node, [Parameter(Mandatory)][string]$Project, [string]$EngineRoot, [switch]$Launch)
$ErrorActionPreference = 'Stop'
if ($Launch) {
    # A stdio client can terminate its entire process tree on disconnect.
    # Ask the local Windows process provider to own this fixed job supervisor.
    $shell = Join-Path $PSHOME 'powershell.exe'
    $argsLine = '"' + $shell + '" -NoProfile -NonInteractive -File "' + $PSCommandPath + '" -Node "' + $Node + '" -Project "' + $Project + '"'
    if ($EngineRoot) { $argsLine += ' -EngineRoot "' + $EngineRoot.TrimEnd('\','/') + '"' }
    $startup = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ShowWindow=[uint16]0}
    $created = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
        CommandLine=$argsLine; CurrentDirectory=(Split-Path -Parent $Project); ProcessStartupInformation=$startup
    }
    if ($created.ReturnValue -ne 0) { throw "Windows evaluation supervisor creation failed ($($created.ReturnValue))." }
    exit 0
}
if ($EngineRoot) { $env:UE_ENGINE_ROOT = $EngineRoot }
Add-Type -TypeDefinition @"
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class EvaluationProcessGroup {
    [StructLayout(LayoutKind.Sequential)]
    struct BasicLimits {
        public long PerProcessTime, PerJobTime;
        public uint Flags;
        public UIntPtr MinimumWorkingSet, MaximumWorkingSet;
        public uint ActiveProcesses;
        public UIntPtr Affinity;
        public uint Priority, Scheduling;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct ExtendedLimits {
        public BasicLimits Basic;
        public ulong ReadOperations, WriteOperations, OtherOperations, ReadBytes, WriteBytes, OtherBytes;
        public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
    }
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern IntPtr CreateJobObject(IntPtr security, string name);
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern bool SetInformationJobObject(IntPtr job, int info, ref ExtendedLimits limits, uint size);
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll")]
    static extern IntPtr GetCurrentProcess();
    static IntPtr job;
    public static void Bind() {
        job = CreateJobObject(IntPtr.Zero, null);
        if (job == IntPtr.Zero) throw new Win32Exception();
        var limits = new ExtendedLimits();
        limits.Basic.Flags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        if (!SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(typeof(ExtendedLimits))) ||
            !AssignProcessToJobObject(job, GetCurrentProcess())) throw new Win32Exception();
    }
}
"@
[EvaluationProcessGroup]::Bind()
$start = New-Object System.Diagnostics.ProcessStartInfo
$start.FileName = $Node
$start.UseShellExecute = $false
$start.CreateNoWindow = $true
# Windows filenames cannot contain a double quote. Both arguments name files,
# so neither quoted path can end with a backslash.
$worker = Join-Path $PSScriptRoot 'evaluation-jobs.mjs'
$start.Arguments = '"' + $worker + '" --drain "' + $Project + '"'
$child = [System.Diagnostics.Process]::Start($start)
try {
    $child.WaitForExit()
    $code = $child.ExitCode
} finally {
    $child.Dispose()
}
exit $code
