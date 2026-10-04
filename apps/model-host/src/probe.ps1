# What is running on this machine, for game mode. One JSON line per look:
#   {"notificationState": <SHQueryUserNotificationState>, "processes": [{"name","path"}]}
# or, when the programs are the same as at the last look,
#   {"notificationState": <state>, "unchanged": true}
# notificationState 2 means a full-screen app has the screen, 3 a Direct3D
# full-screen one.
#
# It runs while someone may be playing, so a look is one call into C# compiled
# once at start. Measured on a desktop with 700 processes: the PowerShell
# pipeline cost 0.9 s of CPU per 10 s, Process.GetProcesses() 55 ms per call
# and Get-Process -Id 98 ms (both read performance counters for every
# process), Process.MainModule 14 s per pass. A Toolhelp snapshot gives the PID
# and executable name for a fraction of that, and paths are read once per
# process with QueryFullProcessImageName. The script runs below normal priority.
#
# It exits on its own when the host's process is gone, so a host killed hard
# does not leave it looping.

param(
  [int] $IntervalMs = 2000,
  [int] $ParentPid = 0,
  [switch] $Once
)

$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class HiDockModelHostProbe {
  [DllImport("shell32.dll")]
  static extern int SHQueryUserNotificationState(out int state);

  [DllImport("kernel32.dll", SetLastError = true)]
  static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);

  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct PROCESSENTRY32W {
    public uint dwSize;
    public uint cntUsage;
    public uint th32ProcessID;
    public IntPtr th32DefaultHeapID;
    public uint th32ModuleID;
    public uint cntThreads;
    public uint th32ParentProcessID;
    public int pcPriClassBase;
    public uint dwFlags;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)]
    public string szExeFile;
  }

  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern bool Process32FirstW(IntPtr snapshot, ref PROCESSENTRY32W entry);

  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern bool Process32NextW(IntPtr snapshot, ref PROCESSENTRY32W entry);

  [DllImport("kernel32.dll", SetLastError = true)]
  static extern IntPtr OpenProcess(int access, bool inherit, int pid);

  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern bool QueryFullProcessImageName(IntPtr process, int flags, StringBuilder name, ref int size);

  [DllImport("kernel32.dll")]
  static extern bool CloseHandle(IntPtr handle);

  static readonly IntPtr Invalid = new IntPtr(-1);
  static readonly Dictionary<string, string> Paths = new Dictionary<string, string>();
  static string lastKeys = "";

  static string PathOf(uint pid) {
    IntPtr handle = OpenProcess(0x1000, false, (int)pid);
    if (handle == IntPtr.Zero) return "";
    try {
      var name = new StringBuilder(1024);
      int size = name.Capacity;
      return QueryFullProcessImageName(handle, 0, name, ref size) ? name.ToString(0, size) : "";
    } finally {
      CloseHandle(handle);
    }
  }

  static void Str(StringBuilder sb, string value) {
    sb.Append('"');
    foreach (char c in value) {
      if (c == '"' || c == '\\') { sb.Append('\\').Append(c); }
      // Everything outside printable ASCII is escaped, so a path such as
      // C:\Users\Sebastián reaches Node intact whatever the console code page.
      else if (c < ' ' || c > '~') { sb.Append("\\u").Append(((int)c).ToString("x4")); }
      else { sb.Append(c); }
    }
    sb.Append('"');
  }

  /// <summary>One look, as a JSON line; null when the parent process is gone.</summary>
  public static string Look(int parentPid) {
    int state = 0;
    try { SHQueryUserNotificationState(out state); } catch { state = 0; }

    var entries = new List<KeyValuePair<uint, string>>();
    IntPtr snapshot = CreateToolhelp32Snapshot(0x2, 0);
    if (snapshot == Invalid) return "{\"notificationState\":" + state + ",\"unchanged\":true}";
    try {
      var entry = new PROCESSENTRY32W();
      entry.dwSize = (uint)Marshal.SizeOf(typeof(PROCESSENTRY32W));
      if (Process32FirstW(snapshot, ref entry)) {
        do { entries.Add(new KeyValuePair<uint, string>(entry.th32ProcessID, entry.szExeFile)); }
        while (Process32NextW(snapshot, ref entry));
      }
    } finally {
      CloseHandle(snapshot);
    }

    var keys = new List<string>(entries.Count);
    bool parentAlive = parentPid <= 0;
    foreach (var e in entries) {
      keys.Add(e.Key + ":" + e.Value);
      if (e.Key == (uint)parentPid) parentAlive = true;
    }
    if (!parentAlive) return null;
    keys.Sort(StringComparer.Ordinal);
    string joined = String.Join("|", keys);
    if (joined == lastKeys) {
      return "{\"notificationState\":" + state + ",\"unchanged\":true}";
    }
    lastKeys = joined;

    var seen = new HashSet<string>();
    var sb = new StringBuilder("{\"notificationState\":").Append(state).Append(",\"processes\":[");
    bool first = true;
    foreach (var e in entries) {
      string key = e.Key + ":" + e.Value;
      seen.Add(key);
      string path;
      // Protected processes refuse; their name is still reported.
      if (!Paths.TryGetValue(key, out path)) { path = PathOf(e.Key); Paths[key] = path; }
      if (!first) sb.Append(',');
      first = false;
      sb.Append("{\"name\":");
      Str(sb, e.Value);
      sb.Append(",\"path\":");
      Str(sb, path);
      sb.Append('}');
    }
    sb.Append("]}");
    foreach (string key in new List<string>(Paths.Keys)) { if (!seen.Contains(key)) Paths.Remove(key); }
    return sb.ToString();
  }
}
'@

try { [System.Diagnostics.Process]::GetCurrentProcess().PriorityClass = 'BelowNormal' } catch { }

while ($true) {
  $line = [HiDockModelHostProbe]::Look($ParentPid)
  if ($null -eq $line) { exit 0 }
  [Console]::Out.WriteLine($line)
  [Console]::Out.Flush()
  if ($Once) { break }
  Start-Sleep -Milliseconds $IntervalMs
}
