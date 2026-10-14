param([Parameter(Mandatory=$true)][string]$CommandSpec)
$ErrorActionPreference = 'Stop'
try {
  $spec = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($CommandSpec)) | ConvertFrom-Json
  if (-not ($spec.file -is [string]) -or -not $spec.file) { throw 'Invalid executable' }
  foreach ($arg in $spec.args) { if (-not ($arg -is [string])) { throw 'Invalid argument' } }
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class RelayOwnedProcess {
  [StructLayout(LayoutKind.Sequential)] struct BasicLimits {
    public long ProcessTime, JobTime; public uint Flags;
    public UIntPtr MinWorkingSet, MaxWorkingSet; public uint ActiveProcesses;
    public UIntPtr Affinity; public uint Priority, Scheduling;
  }
  [StructLayout(LayoutKind.Sequential)] struct IoCounters {
    public ulong ReadOperations, WriteOperations, OtherOperations, ReadBytes, WriteBytes, OtherBytes;
  }
  [StructLayout(LayoutKind.Sequential)] struct ExtendedLimits {
    public BasicLimits Basic; public IoCounters Io;
    public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
  }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct StartupInfo {
    public uint Size; public string Reserved, Desktop, Title;
    public uint X, Y, Width, Height, XChars, YChars, Fill, Flags;
    public ushort ShowWindow, ReservedSize; public IntPtr ReservedBytes, Input, Output, Error;
  }
  [StructLayout(LayoutKind.Sequential)] struct ProcessInfo {
    public IntPtr Process, Thread; public uint ProcessId, ThreadId;
  }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateJobObjectW(IntPtr attributes, string name);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref ExtendedLimits limits, uint size);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CreateProcessW(string file, StringBuilder command, IntPtr processAttributes, IntPtr threadAttributes, bool inheritHandles, uint flags, IntPtr environment, string directory, ref StartupInfo startup, out ProcessInfo process);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll", SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateProcess(IntPtr process, uint code);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr GetStdHandle(int id);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);

  static string Quote(string value) {
    var quoted = new StringBuilder("\""); int slashes = 0;
    foreach (char c in value) {
      if (c == '\\') { slashes++; continue; }
      if (c == '"') { quoted.Append('\\', slashes * 2 + 1); quoted.Append(c); }
      else { quoted.Append('\\', slashes); quoted.Append(c); }
      slashes = 0;
    }
    quoted.Append('\\', slashes * 2); quoted.Append('"'); return quoted.ToString();
  }
  public static int Run(string file, string[] args) {
    IntPtr job = IntPtr.Zero; ProcessInfo process = new ProcessInfo();
    try {
      job = CreateJobObjectW(IntPtr.Zero, null);
      if (job == IntPtr.Zero) throw new Exception();
      var limits = new ExtendedLimits(); limits.Basic.Flags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
      if (!SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(typeof(ExtendedLimits)))) throw new Exception();
      var startup = new StartupInfo(); startup.Size = (uint)Marshal.SizeOf(typeof(StartupInfo)); startup.Flags = 0x100;
      startup.Input = GetStdHandle(-10); startup.Output = GetStdHandle(-11); startup.Error = GetStdHandle(-12);
      foreach (IntPtr handle in new [] {startup.Input, startup.Output, startup.Error}) {
        if (handle == IntPtr.Zero || handle == new IntPtr(-1) || !SetHandleInformation(handle, 1, 1)) throw new Exception();
      }
      var command = new StringBuilder(Quote(file)); foreach (string arg in args) command.Append(" ").Append(Quote(arg));
      // Assign while suspended so no tool can escape by starting before the job exists.
      if (!CreateProcessW(file, command, IntPtr.Zero, IntPtr.Zero, true, 4, IntPtr.Zero, null, ref startup, out process)) throw new Exception();
      if (!AssignProcessToJobObject(job, process.Process)) throw new Exception();
      if (ResumeThread(process.Thread) == UInt32.MaxValue) throw new Exception();
      if (WaitForSingleObject(process.Process, UInt32.MaxValue) != 0) throw new Exception();
      uint exitCode; if (!GetExitCodeProcess(process.Process, out exitCode)) throw new Exception();
      return unchecked((int)exitCode);
    } finally {
      if (process.Process != IntPtr.Zero) TerminateProcess(process.Process, 1);
      if (job != IntPtr.Zero) CloseHandle(job);
      if (process.Thread != IntPtr.Zero) CloseHandle(process.Thread);
      if (process.Process != IntPtr.Zero) CloseHandle(process.Process);
    }
  }
}
'@
  exit ([RelayOwnedProcess]::Run($spec.file, [string[]]$spec.args))
} catch {
  [Console]::Error.WriteLine('Relay could not run the protected process. Check PowerShell policy and Windows Job Object support.')
  exit 1
}
