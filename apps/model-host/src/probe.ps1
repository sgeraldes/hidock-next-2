# What is running on this machine, for game mode. One JSON line per look:
#   {"notificationState": <SHQueryUserNotificationState>, "processes": [{"name","path"}]}
# notificationState 2 means a full-screen app has the screen, 3 a Direct3D
# full-screen one. Paths are read once per process and cached.
#
# It runs for as long as the host does and exits on its own when the host's
# process is gone, so a host killed hard does not leave it looping.

param(
  [int] $IntervalMs = 2000,
  [int] $ParentPid = 0,
  [switch] $Once
)

$ErrorActionPreference = 'Stop'

# QueryFullProcessImageName needs only limited query rights and costs one call
# per process. Process.MainModule enumerates every loaded module and took 14 s
# for one pass over a desktop's processes.
Add-Type -Namespace HiDockModelHost -Name Screen -MemberDefinition @'
[DllImport("shell32.dll")]
public static extern int SHQueryUserNotificationState(out int state);

[DllImport("kernel32.dll", SetLastError = true)]
static extern System.IntPtr OpenProcess(int access, bool inherit, int pid);

[DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
static extern bool QueryFullProcessImageName(System.IntPtr process, int flags, System.Text.StringBuilder name, ref int size);

[DllImport("kernel32.dll")]
static extern bool CloseHandle(System.IntPtr handle);

public static string PathOf(int pid) {
  System.IntPtr handle = OpenProcess(0x1000, false, pid);
  if (handle == System.IntPtr.Zero) return "";
  try {
    var name = new System.Text.StringBuilder(1024);
    int size = name.Capacity;
    return QueryFullProcessImageName(handle, 0, name, ref size) ? name.ToString(0, size) : "";
  } finally {
    CloseHandle(handle);
  }
}
'@

$paths = @{}
while ($true) {
  if ($ParentPid -gt 0 -and -not (Get-Process -Id $ParentPid -ErrorAction SilentlyContinue)) { exit 0 }

  $state = 0
  try { [void][HiDockModelHost.Screen]::SHQueryUserNotificationState([ref]$state) } catch { $state = 0 }

  $seen = @{}
  $list = foreach ($p in [System.Diagnostics.Process]::GetProcesses()) {
    $key = "$($p.Id):$($p.ProcessName)"
    $seen[$key] = $true
    if (-not $paths.ContainsKey($key)) {
      # Protected processes refuse; their name is still reported.
      $paths[$key] = [HiDockModelHost.Screen]::PathOf($p.Id)
    }
    [pscustomobject]@{ name = "$($p.ProcessName).exe"; path = $paths[$key] }
  }
  foreach ($k in @($paths.Keys)) { if (-not $seen.ContainsKey($k)) { $paths.Remove($k) } }

  $line = [pscustomobject]@{ notificationState = $state; processes = @($list) } | ConvertTo-Json -Compress -Depth 3
  [Console]::Out.WriteLine($line)
  [Console]::Out.Flush()
  if ($Once) { break }
  Start-Sleep -Milliseconds $IntervalMs
}
