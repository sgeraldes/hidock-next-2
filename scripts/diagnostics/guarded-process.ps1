param(
  [Parameter(Mandatory)][string]$Executable,
  [string]$Arguments = '',
  [string]$WorkingDirectory = 'G:\Code\hidock-next-2\apps\electron',
  [ValidateRange(0,8192)][int]$MemoryLimitMiB = 0,
  [ValidateRange(5,300)][int]$Seconds = 90,
  [ValidateRange(100,1000)][int]$SampleIntervalMs = 1000,
  [string]$Output = 'C:\Users\Sebastian\.codex\diagnostics\hidock-oct07\guarded-memory.jsonl'
)
$ErrorActionPreference = 'Stop'
# Windows assigns the suspended child before any application code can execute.
# Never allow a launch to proceed if assignment or limits fail.
Add-Type -TypeDefinition @'
using System; using System.Text; using System.Runtime.InteropServices; using System.ComponentModel;
public class HiDockGuard : IDisposable {
 [StructLayout(LayoutKind.Sequential)] struct Basic { public long User,Total; public uint Flags; public UIntPtr Min,Max; public uint Active; public UIntPtr Affinity; public uint Priority,Scheduling; }
 [StructLayout(LayoutKind.Sequential)] struct Io { public ulong ReadOps,WriteOps,OtherOps,ReadBytes,WriteBytes,OtherBytes; }
 [StructLayout(LayoutKind.Sequential)] struct Extended { public Basic Basic; public Io Io; public UIntPtr ProcessLimit,JobLimit,PeakProcess,PeakJob; }
 [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] struct Startup { public uint Size; public string Reserved,Desktop,Title; public uint X,Y,Width,Height,XChars,YChars,Fill,Flags; public ushort Show,ReservedSize; public IntPtr ReservedPtr,Input,Output,Error; }
 [StructLayout(LayoutKind.Sequential)] struct ProcessInfo { public IntPtr Process,Thread; public uint Id,ThreadId; }
 [StructLayout(LayoutKind.Sequential)] public struct Memory { public uint Size; public UIntPtr Commit,Limit,Peak,Physical,Available,Cache,Kernel,Paged,Nonpaged,Page; public uint Handles,Processes,Threads; }
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr a,string n);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetInformationJobObject(IntPtr j,int c,ref Extended e,uint s);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr j,int c,IntPtr p,uint s,IntPtr r);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr j,IntPtr p);
 [DllImport("kernel32.dll",SetLastError=true,CharSet=CharSet.Unicode)] static extern bool CreateProcess(string a,StringBuilder c,IntPtr pa,IntPtr ta,bool inherit,uint flags,IntPtr env,string cwd,ref Startup s,out ProcessInfo p);
 [DllImport("kernel32.dll",SetLastError=true)] static extern uint ResumeThread(IntPtr t);
 [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr p,uint c);
 [DllImport("kernel32.dll")] static extern bool TerminateJobObject(IntPtr p,uint c);
 [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
 [DllImport("psapi.dll",SetLastError=true)] static extern bool GetPerformanceInfo(out Memory m,uint s);
 IntPtr job; public uint RootId;
 static void Check(bool ok){if(!ok)throw new Win32Exception(Marshal.GetLastWin32Error());}
 public static Memory ReadMemory(){Memory m;Check(GetPerformanceInfo(out m,(uint)Marshal.SizeOf(typeof(Memory))));return m;}
 public HiDockGuard(string exe,string args,string cwd,ulong limit) {
   job=CreateJobObject(IntPtr.Zero,null);Check(job!=IntPtr.Zero);
   var e=new Extended(); e.Basic.Flags=0x200|0x2000; e.JobLimit=(UIntPtr)limit;
   if(!SetInformationJobObject(job,9,ref e,(uint)Marshal.SizeOf(typeof(Extended)))){Dispose();Check(false);}
   var s=new Startup();s.Size=(uint)Marshal.SizeOf(typeof(Startup));ProcessInfo p;
   if(!CreateProcess(exe,new StringBuilder("\""+exe+"\" "+args),IntPtr.Zero,IntPtr.Zero,false,4|0x08000000,IntPtr.Zero,cwd,ref s,out p)){Dispose();Check(false);}
   try { if(!AssignProcessToJobObject(job,p.Process)){TerminateProcess(p.Process,1);Check(false);}
     RootId=p.Id;if(ResumeThread(p.Thread)==0xffffffff){TerminateProcess(p.Process,1);Check(false);}
   } catch {Dispose();throw;} finally {CloseHandle(p.Thread);CloseHandle(p.Process);}
 }
 public uint[] Pids(){IntPtr b=Marshal.AllocHGlobal(8192);try {Check(QueryInformationJobObject(job,3,b,8192,IntPtr.Zero));int n=Marshal.ReadInt32(b,4);var ids=new uint[n];for(int i=0;i<n;i++)ids[i]=(uint)Marshal.ReadIntPtr(b,8+i*IntPtr.Size).ToInt64();return ids;}finally{Marshal.FreeHGlobal(b);}}
 public ulong Peak(){return Limits().PeakJob.ToUInt64();}
 public ulong Limit(){return Limits().JobLimit.ToUInt64();}
 Extended Limits(){IntPtr b=Marshal.AllocHGlobal(Marshal.SizeOf(typeof(Extended)));try{Check(QueryInformationJobObject(job,9,b,(uint)Marshal.SizeOf(typeof(Extended)),IntPtr.Zero));return (Extended)Marshal.PtrToStructure(b,typeof(Extended));}finally{Marshal.FreeHGlobal(b);}}
 public void Stop(){if(job!=IntPtr.Zero)TerminateJobObject(job,1);}
 public void Dispose(){if(job!=IntPtr.Zero){CloseHandle(job);job=IntPtr.Zero;}}
}
'@
$taskBefore = [HiDockGuard]::ReadMemory()
$taskAvailable = $taskBefore.Available.ToUInt64()*$taskBefore.Page.ToUInt64()/1MB
$taskPhysical = $taskBefore.Physical.ToUInt64()*$taskBefore.Page.ToUInt64()/1MB
$taskReserve = [math]::Max(1024, $taskPhysical * 0.125)
if ($MemoryLimitMiB -eq 0) {
  $MemoryLimitMiB = [int][math]::Floor([math]::Min(8192,[math]::Min($taskPhysical * 0.125,$taskAvailable * 0.25)))
  if ($MemoryLimitMiB -lt 1024) { throw 'Not enough available RAM for a bounded app test; nothing launched.' }
}
if ($MemoryLimitMiB -gt 1024 -and ($taskAvailable -lt $taskReserve*2 -or $MemoryLimitMiB -gt $taskAvailable*0.5)) {
  throw 'Insufficient free RAM for a controlled app test; nothing launched.'
}
$taskGuard = [HiDockGuard]::new($Executable,$Arguments,$WorkingDirectory,[uint64]$MemoryLimitMiB*1MB)
$taskStarted = Get-Date
try {
  for($taskSample=0;(Get-Date)-$taskStarted -lt [timespan]::FromSeconds($Seconds);$taskSample++) {
    $taskIds = @($taskGuard.Pids())
    $taskMem = [HiDockGuard]::ReadMemory()
    $taskPage = $taskMem.Page.ToUInt64()
    $taskProcesses = @($taskIds | ForEach-Object { Get-Process -Id $_ -ErrorAction SilentlyContinue } | ForEach-Object {
      [pscustomobject]@{pid=$_.Id;name=$_.ProcessName;privateMiB=[math]::Round($_.PrivateMemorySize64/1MB,2);residentMiB=[math]::Round($_.WorkingSet64/1MB,2)}
    })
    $taskReading = [pscustomobject]@{at=(Get-Date -Format o);rootPid=$taskGuard.RootId;limitMiB=$taskGuard.Limit()/1MB;
      jobPeakMiB=[math]::Round($taskGuard.Peak()/1MB,2);availableMiB=[math]::Round($taskMem.Available.ToUInt64()*$taskPage/1MB,2);
      commitMiB=[math]::Round($taskMem.Commit.ToUInt64()*$taskPage/1MB,2);commitLimitMiB=[math]::Round($taskMem.Limit.ToUInt64()*$taskPage/1MB,2);processes=$taskProcesses}
    $taskReading | ConvertTo-Json -Depth 4 -Compress | Add-Content -LiteralPath $Output
    if(!$taskIds.Count){break}
    if($taskReading.availableMiB -lt $taskReserve -or $taskReading.commitMiB/$taskReading.commitLimitMiB -gt 0.85) {
      $taskGuard.Stop(); 'Stopped at system memory safety threshold' | Write-Output; break
    }
    Start-Sleep -Milliseconds $SampleIntervalMs
  }
} finally { $taskGuard.Dispose() }
Write-Output "Bounded run ended; own process family closed. Samples: $Output"
